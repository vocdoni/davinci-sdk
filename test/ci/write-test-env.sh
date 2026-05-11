#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
REPO_ROOT=$(cd "${SCRIPT_DIR}/../.." && pwd)
TARGET_FILE=${1:-"${REPO_ROOT}/test/.env"}
SEQUENCER_API_URL=${SEQUENCER_API_URL:-http://127.0.0.1:9090}
CENSUS_API_URL=${CENSUS_API_URL:-http://127.0.0.1:8080}
RPC_URL=${RPC_URL:-http://127.0.0.1:8545}

cat > "${TARGET_FILE}" <<EOF
SEQUENCER_API_URL=${SEQUENCER_API_URL}
CENSUS_API_URL=${CENSUS_API_URL}
RPC_URL=${RPC_URL}
PRIVATE_KEY=ac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80
TIMEOUT=600000
EOF

echo "Wrote integration env file to ${TARGET_FILE}"
