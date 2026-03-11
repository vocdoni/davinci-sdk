#!/bin/sh
set -eu

ADDRESSES_URL=${ADDRESSES_URL:-http://deployer:8000/addresses.env}
ADDRESSES_FILE=${ADDRESSES_FILE:-/app/run/addresses.env}
ADDRESSES_FILE_WAIT_TIMEOUT=${ADDRESSES_FILE_WAIT_TIMEOUT:-90}

wait_for_file() {
  path=$1
  timeout=$2
  elapsed=0

  while [ ! -s "$path" ]; do
    if [ "$elapsed" -ge "$timeout" ]; then
      return 1
    fi
    sleep 1
    elapsed=$((elapsed + 1))
  done

  return 0
}

fetch_file() {
  url=$1
  output=$2

  if command -v curl >/dev/null 2>&1; then
    curl -fsS "$url" -o "$output"
    return
  fi

  if command -v wget >/dev/null 2>&1; then
    wget -q -O "$output" "$url"
    return
  fi

  if command -v busybox >/dev/null 2>&1; then
    busybox wget -q -O "$output" "$url"
    return
  fi

  echo "Neither curl nor wget is available; cannot download $url"
  exit 1
}

if wait_for_file "${ADDRESSES_FILE}" "${ADDRESSES_FILE_WAIT_TIMEOUT}"; then
  echo "Using deployed contract addresses from ${ADDRESSES_FILE}..."
  /bin/cp "${ADDRESSES_FILE}" /tmp/addresses.env
else
  echo "Shared addresses file not found after ${ADDRESSES_FILE_WAIT_TIMEOUT}s, fetching from ${ADDRESSES_URL}..."
  fetch_file "${ADDRESSES_URL}" /tmp/addresses.env
fi

if [ ! -s /tmp/addresses.env ]; then
  echo "addresses.env was not downloaded or is empty"
  exit 1
fi

. /tmp/addresses.env

if [ -z "${PROCESS_REGISTRY:-}" ]; then
  echo "PROCESS_REGISTRY is missing in /tmp/addresses.env"
  cat /tmp/addresses.env
  exit 1
fi

export DAVINCI_WEB3_PROCESS="${PROCESS_REGISTRY}"

if [ -n "${RESULTS_REGISTRY:-}" ]; then
  export DAVINCI_WEB3_RESULTS="${RESULTS_REGISTRY}"
fi

if [ -n "${ORG_REGISTRY:-}" ]; then
  export DAVINCI_WEB3_ORGS="${ORG_REGISTRY}"
fi

echo "Starting sequencer with deployed contract addresses..."
if [ -x /app/entrypoint.sh ]; then
  exec /app/entrypoint.sh "$@"
fi

if [ -x /app/davinci-sequencer ]; then
  exec /app/davinci-sequencer "$@"
fi

if command -v davinci-sequencer >/dev/null 2>&1; then
  exec davinci-sequencer "$@"
fi

echo "Could not find sequencer executable (/app/entrypoint.sh, /app/davinci-sequencer, or davinci-sequencer in PATH)."
exit 1
