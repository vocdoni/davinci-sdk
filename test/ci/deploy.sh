#!/usr/bin/env bash
set -euo pipefail

CONTRACTS_REPO=${CONTRACTS_REPO:-https://github.com/vocdoni/davinci-contracts.git}
CONTRACTS_REF=${CONTRACTS_REF:-main}
RPC_URL=${RPC_URL:-http://anvil:8545}
PRIVATE_KEY=${PRIVATE_KEY:-0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80}
CHAIN_ID=${CHAIN_ID:-1337}
ACTIVATE_BLOBS=${ACTIVATE_BLOBS:-false}
OUTPUT_JSON=/workspace/addresses.json
OUTPUT_ENV=/workspace/addresses.env

# Keep compatibility with contracts scripts that read Sepolia-style env names.
export SEPOLIA_RPC_URL=${SEPOLIA_RPC_URL:-${RPC_URL}}
export SEPOLIA_PRIVATE_KEY=${SEPOLIA_PRIVATE_KEY:-${PRIVATE_KEY}}
export CHAIN_ID
export ACTIVATE_BLOBS
export CI=${CI:-true}
export TERM=${TERM:-dumb}

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
RESULTS_VERIFIER=$(extract_address '^(ResultsVerifier|ResultsVerifierGroth16)$')
STATE_TRANSITION_VERIFIER=$(extract_address '^(StateTransitionVerifier|StateTransitionVerifierGroth16|StateVerifier)$')

if [[ -z "${RESULTS_VERIFIER}" && -n "${RESULTS_REGISTRY}" ]]; then
  RESULTS_VERIFIER="${RESULTS_REGISTRY}"
fi

if [[ -z "${PROCESS_REGISTRY}" ]]; then
  echo "Could not extract ProcessRegistry address from ${OUTPUT_JSON}"
  exit 1
fi

cat > "${OUTPUT_ENV}" <<EOF
PROCESS_REGISTRY=${PROCESS_REGISTRY}
ORG_REGISTRY=${ORG_REGISTRY}
RESULTS_REGISTRY=${RESULTS_REGISTRY}
RESULTS_VERIFIER=${RESULTS_VERIFIER}
STATE_TRANSITION_VERIFIER=${STATE_TRANSITION_VERIFIER}
EOF

echo "Wrote ${OUTPUT_JSON} and ${OUTPUT_ENV}"
cat "${OUTPUT_ENV}"
