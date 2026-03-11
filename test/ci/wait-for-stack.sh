#!/usr/bin/env bash
set -euo pipefail

ANVIL_RPC_URL=${ANVIL_RPC_URL:-http://127.0.0.1:8545}
DEPLOYER_URL=${DEPLOYER_URL:-http://127.0.0.1:8000/addresses.env}
SEQUENCER_INFO_URL=${SEQUENCER_INFO_URL:-http://127.0.0.1:9090/info}
TIMEOUT_SECONDS=${TIMEOUT_SECONDS:-900}
COMPOSE_FILE_PATH=${COMPOSE_FILE_PATH:-test/ci/docker-compose.yml}

is_service_exited() {
  local service=$1
  docker compose -f "${COMPOSE_FILE_PATH}" ps --status exited --services 2>/dev/null \
    | grep -Fxq "${service}"
}

print_diagnostics() {
  local service=${1:-}
  echo "---- docker compose ps ----"
  docker compose -f "${COMPOSE_FILE_PATH}" ps || true
  if [[ -n "${service}" ]]; then
    echo "---- ${service} logs (tail 200) ----"
    docker compose -f "${COMPOSE_FILE_PATH}" logs --no-color --tail=200 "${service}" || true
  fi
}

wait_for_rpc() {
  local url=$1
  local timeout_s=$2
  local elapsed=0

  while ! curl -fsS -X POST \
    -H "Content-Type: application/json" \
    --data '{"jsonrpc":"2.0","method":"eth_blockNumber","params":[],"id":1}' \
    "${url}" >/dev/null; do
    sleep 2
    elapsed=$((elapsed + 2))
    if [[ ${elapsed} -ge ${timeout_s} ]]; then
      echo "Timed out waiting for RPC at ${url}"
      return 1
    fi
  done
}

wait_for_http() {
  local url=$1
  local timeout_s=$2
  local service_name=${3:-}
  local elapsed=0

  while ! curl -fsS "${url}" >/dev/null; do
    if [[ -n "${service_name}" ]] && is_service_exited "${service_name}"; then
      echo "Service '${service_name}' exited while waiting for ${url}"
      print_diagnostics "${service_name}"
      return 1
    fi
    sleep 2
    elapsed=$((elapsed + 2))
    if [[ ${elapsed} -ge ${timeout_s} ]]; then
      echo "Timed out waiting for ${url}"
      print_diagnostics "${service_name}"
      return 1
    fi
  done
}

echo "Waiting for Anvil RPC..."
wait_for_rpc "${ANVIL_RPC_URL}" "${TIMEOUT_SECONDS}"

echo "Waiting for deployer addresses..."
wait_for_http "${DEPLOYER_URL}" "${TIMEOUT_SECONDS}" "deployer"

echo "Waiting for sequencer info endpoint..."
wait_for_http "${SEQUENCER_INFO_URL}" "${TIMEOUT_SECONDS}" "sequencer"

echo "Local stack is ready."
