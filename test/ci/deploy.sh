#!/usr/bin/env bash
set -euo pipefail

CONTRACTS_REPO=${CONTRACTS_REPO:-https://github.com/vocdoni/davinci-contracts.git}
CONTRACTS_REF=${CONTRACTS_REF:-main}
RPC_URL=${RPC_URL:-http://anvil:8545}
PRIVATE_KEY=${PRIVATE_KEY:-0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80}
OUTPUT_JSON=/workspace/addresses.json
OUTPUT_ENV=/workspace/addresses.env

# Keep compatibility with contracts scripts that read Sepolia-style env names.
export SEPOLIA_RPC_URL=${SEPOLIA_RPC_URL:-${RPC_URL}}
export SEPOLIA_PRIVATE_KEY=${SEPOLIA_PRIVATE_KEY:-${PRIVATE_KEY}}

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
    --chain-id 1337 \
    "${script_ref}" \
    --rpc-url "${RPC_URL}" \
    --private-key "${PRIVATE_KEY}" \
    --broadcast \
    --slow \
    --optimize \
    --optimizer-runs 200 \
    -- \
    --vvvv
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
if ! deploy_contracts "script/non-proxy/DeployAll.s.sol:TestDeployAllScript"; then
  echo "Fallback deploy script: script/DeployAll.s.sol:DeployAllScript"
  deploy_contracts "script/DeployAll.s.sol:DeployAllScript"
fi

cp broadcast/DeployAll.s.sol/1337/run-latest.json "${OUTPUT_JSON}"

PROCESS_REGISTRY=$(extract_address '^ProcessRegistry$')
ORG_REGISTRY=$(extract_address '(OrgRegistry|OrganizationRegistry)')
RESULTS_REGISTRY=$(extract_address '(ResultsVerifier|ResultsRegistry)')
STATE_TRANSITION_VERIFIER=$(extract_address '(StateTransitionVerifier|StateVerifier)')

if [[ -z "${PROCESS_REGISTRY}" ]]; then
  echo "Could not extract ProcessRegistry address from ${OUTPUT_JSON}"
  exit 1
fi

cat > "${OUTPUT_ENV}" <<EOF
PROCESS_REGISTRY=${PROCESS_REGISTRY}
ORG_REGISTRY=${ORG_REGISTRY}
RESULTS_REGISTRY=${RESULTS_REGISTRY}
STATE_TRANSITION_VERIFIER=${STATE_TRANSITION_VERIFIER}
EOF

echo "Wrote ${OUTPUT_JSON} and ${OUTPUT_ENV}"
cat "${OUTPUT_ENV}"
