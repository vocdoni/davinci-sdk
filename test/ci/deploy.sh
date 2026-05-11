#!/usr/bin/env bash
set -euo pipefail

CONTRACTS_REPO=${CONTRACTS_REPO:-https://github.com/vocdoni/davinci-contracts.git}
CONTRACTS_REF=${CONTRACTS_REF:-auto}
DAVINCI_NODE_REPO=${DAVINCI_NODE_REPO:-https://github.com/vocdoni/davinci-node.git}
DAVINCI_NODE_REF=${DAVINCI_NODE_REF:-main}
RPC_URL=${RPC_URL:-http://anvil:8545}
PRIVATE_KEY=${PRIVATE_KEY:-0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80}
CHAIN_ID=${CHAIN_ID:-1337}
ACTIVATE_BLOBS=${ACTIVATE_BLOBS:-false}
OUTPUT_JSON=/workspace/addresses.json
OUTPUT_ENV=/workspace/addresses.env

export CHAIN_ID
export ACTIVATE_BLOBS
export CI=${CI:-true}
export TERM=${TERM:-dumb}

fetch_davinci_node_go_mod() {
  local output_file=$1
  local repo_no_git
  local owner
  local repo
  local raw_url
  local tmp_dir

  repo_no_git="${DAVINCI_NODE_REPO%.git}"

  if [[ "${repo_no_git}" =~ ^https://github.com/([^/]+)/([^/]+)$ ]]; then
    owner="${BASH_REMATCH[1]}"
    repo="${BASH_REMATCH[2]}"
    raw_url="https://raw.githubusercontent.com/${owner}/${repo}/${DAVINCI_NODE_REF}/go.mod"
    if curl -fsSL "${raw_url}" -o "${output_file}"; then
      return 0
    fi
    echo "Warning: failed to download go.mod from ${raw_url}, falling back to git clone."
  fi

  tmp_dir=$(mktemp -d)
  if git clone --depth 1 --branch "${DAVINCI_NODE_REF}" "${DAVINCI_NODE_REPO}" "${tmp_dir}" >/dev/null 2>&1; then
    cp "${tmp_dir}/go.mod" "${output_file}"
    rm -rf "${tmp_dir}"
    return 0
  fi
  rm -rf "${tmp_dir}"
  return 1
}

extract_contracts_ref_from_go_mod() {
  local go_mod_file=$1
  local replace_version
  local require_version

  # Prefer explicit replace directives that pin a published version.
  replace_version=$(awk '
    $1=="replace" && $2=="github.com/vocdoni/davinci-contracts" {
      for (i=1; i<=NF; i++) {
        if ($i=="=>") {
          if (i+2<=NF && $(i+1)=="github.com/vocdoni/davinci-contracts") {
            print $(i+2); exit
          }
          if (i+1<=NF && $(i+1) ~ /^v[0-9]/) {
            print $(i+1); exit
          }
        }
      }
    }
  ' "${go_mod_file}")
  if [[ -n "${replace_version}" ]]; then
    echo "${replace_version}"
    return 0
  fi

  require_version=$(awk '
    $1=="require" && $2=="(" { in_require=1; next }
    in_require && $1==")" { in_require=0; next }
    in_require && $1=="github.com/vocdoni/davinci-contracts" { print $2; exit }
    $1=="require" && $2=="github.com/vocdoni/davinci-contracts" { print $3; exit }
  ' "${go_mod_file}")

  if [[ -n "${require_version}" ]]; then
    echo "${require_version}"
    return 0
  fi

  return 1
}

normalize_contracts_ref() {
  local version=$1

  # Go pseudo-version: vX.Y.Z-yyyymmddhhmmss-<commit12>
  if [[ "${version}" =~ ^v[0-9]+\.[0-9]+\.[0-9]+-[0-9]{14}-([0-9a-f]{12})$ ]]; then
    echo "${BASH_REMATCH[1]}"
    return 0
  fi

  echo "${version}"
  return 0
}

resolve_contracts_ref() {
  local go_mod_tmp
  local detected_version
  local normalized_ref

  if [[ "${CONTRACTS_REF}" != "auto" ]]; then
    echo "${CONTRACTS_REF}"
    return 0
  fi

  go_mod_tmp=$(mktemp)
  if ! fetch_davinci_node_go_mod "${go_mod_tmp}"; then
    rm -f "${go_mod_tmp}"
    echo "Failed to fetch davinci-node go.mod from ${DAVINCI_NODE_REPO}@${DAVINCI_NODE_REF}" >&2
    return 1
  fi

  if ! detected_version=$(extract_contracts_ref_from_go_mod "${go_mod_tmp}"); then
    rm -f "${go_mod_tmp}"
    echo "Could not find github.com/vocdoni/davinci-contracts in davinci-node go.mod" >&2
    return 1
  fi
  rm -f "${go_mod_tmp}"

  if [[ "${detected_version}" == ./* || "${detected_version}" == ../* || "${detected_version}" == /* ]]; then
    echo "davinci-node go.mod points davinci-contracts to a local path (${detected_version}). Set CONTRACTS_REF explicitly." >&2
    return 1
  fi

  normalized_ref=$(normalize_contracts_ref "${detected_version}")
  echo "${normalized_ref}"
}

wait_for_rpc() {
  local timeout_s=${1:-180}
  local elapsed=0

  echo "Waiting for Anvil RPC at ${RPC_URL}..."
  while ! curl -fsS -X POST \
    -H "Content-Type: application/json" \
    --data '{"jsonrpc":"2.0","method":"eth_blockNumber","params":[],"id":1}' \
    "${RPC_URL}" >/dev/null; do
    sleep 2
    elapsed=$((elapsed + 2))
    if [[ ${elapsed} -ge ${timeout_s} ]]; then
      echo "Timed out waiting for RPC after ${timeout_s}s"
      return 1
    fi
  done
}

deploy_contracts() {
  local script_ref=$1

  forge script \
    --chain-id "${CHAIN_ID}" \
    "${script_ref}" \
    --rpc-url "${RPC_URL}" \
    --private-key "${PRIVATE_KEY}" \
    --broadcast \
    --non-interactive \
    --slow \
    --optimize \
    --optimizer-runs 200 \
    -vvvv < /dev/null
}

latest_broadcast_json() {
  find broadcast -type f -name run-latest.json -printf '%T@ %p\n' \
    | sort -nr \
    | head -n 1 \
    | cut -d' ' -f2-
}

extract_process_registry_from_broadcast() {
  local broadcast_json
  broadcast_json=$(latest_broadcast_json || true)

  if [[ -z "${broadcast_json}" || ! -f "${broadcast_json}" ]]; then
    return 0
  fi

  jq -r '.transactions[] | select((.contractName // "") | test("^ProcessRegistry$"; "i")) | .contractAddress // empty' \
    "${broadcast_json}" | head -n 1
}

is_process_registry_live() {
  local process_registry
  local onchain_code

  process_registry=$(extract_process_registry_from_broadcast)
  if [[ -z "${process_registry}" ]]; then
    return 1
  fi

  onchain_code=$(cast code --rpc-url "${RPC_URL}" "${process_registry}" 2>/dev/null || true)
  if [[ -z "${onchain_code}" || "${onchain_code}" == "0x" ]]; then
    return 1
  fi

  return 0
}

is_process_registry_initialized() {
  local process_registry
  local st_vkey_hash
  local r_vkey_hash
  local zero_hash

  process_registry=$(extract_process_registry_from_broadcast)
  if [[ -z "${process_registry}" ]]; then
    return 1
  fi

  zero_hash="0x0000000000000000000000000000000000000000000000000000000000000000"
  st_vkey_hash=$(cast call --rpc-url "${RPC_URL}" "${process_registry}" "getSTVerifierVKeyHash()(bytes32)" 2>/dev/null || true)
  r_vkey_hash=$(cast call --rpc-url "${RPC_URL}" "${process_registry}" "getRVerifierVKeyHash()(bytes32)" 2>/dev/null || true)

  if [[ -z "${st_vkey_hash}" || "${st_vkey_hash}" == "${zero_hash}" ]]; then
    return 1
  fi

  if [[ -z "${r_vkey_hash}" || "${r_vkey_hash}" == "${zero_hash}" ]]; then
    return 1
  fi

  return 0
}

run_deploy() {
  local candidates=(
    "script/non-proxy/DeployAll.s.sol:TestDeployAllScript"
    "script/DeployAll.s.sol:TestDeployAllScript"
    "script/DeployAll.s.sol:DeployAllScript"
  )

  for candidate in "${candidates[@]}"; do
    local script_path=${candidate%%:*}
    if [[ ! -f "${script_path}" ]]; then
      continue
    fi

    echo "Trying deploy script: ${candidate}"
    if deploy_contracts "${candidate}" && is_process_registry_live && is_process_registry_initialized; then
      return 0
    fi

    # Some forge builds return non-zero in non-TTY CI despite broadcasting transactions.
    # Accept only if contracts are verifiably live and initialized on-chain.
    if is_process_registry_live && is_process_registry_initialized; then
      echo "Detected usable on-chain deployment despite forge non-zero exit; continuing."
      return 0
    fi

    echo "Candidate did not produce a usable on-chain ProcessRegistry, trying next..."
  done

  return 1
}

extract_address() {
  local regex=$1
  jq -r --arg regex "${regex}" \
    '.transactions[] | select((.contractName // "") | test($regex; "i")) | .contractAddress // empty' \
    "${OUTPUT_JSON}" | head -n 1
}

wait_for_rpc

CONTRACTS_REF=$(resolve_contracts_ref)
echo "Using contracts ref ${CONTRACTS_REF} (resolved from davinci-node ref ${DAVINCI_NODE_REF})"

echo "Cloning contracts from ${CONTRACTS_REPO} (${CONTRACTS_REF})..."
git clone --depth 1 --branch "${CONTRACTS_REF}" "${CONTRACTS_REPO}" /workspace/davinci-contracts
cd /workspace/davinci-contracts

echo "Building contracts..."
forge clean
forge build

echo "Deploying contracts..."
if ! run_deploy; then
  echo "Failed to deploy contracts with all known script entry points"
  exit 1
fi

BROADCAST_JSON=$(latest_broadcast_json || true)

if [[ -z "${BROADCAST_JSON}" || ! -f "${BROADCAST_JSON}" ]]; then
  echo "Could not locate a forge broadcast run-latest.json output file"
  exit 1
fi

cp "${BROADCAST_JSON}" "${OUTPUT_JSON}"

PROCESS_REGISTRY=$(extract_address '^ProcessRegistry$')
ORG_REGISTRY=$(extract_address '(OrgRegistry|OrganizationRegistry)')
RESULTS_REGISTRY=$(extract_address '^ResultsRegistry$')

if [[ -z "${PROCESS_REGISTRY}" ]]; then
  echo "Could not extract ProcessRegistry address from ${OUTPUT_JSON}"
  exit 1
fi

cat > "${OUTPUT_ENV}" <<EOF
PROCESS_REGISTRY=${PROCESS_REGISTRY}
ORG_REGISTRY=${ORG_REGISTRY}
RESULTS_REGISTRY=${RESULTS_REGISTRY}
EOF

echo "Wrote ${OUTPUT_JSON} and ${OUTPUT_ENV}"
cat "${OUTPUT_ENV}"
