#!/bin/sh
set -eu

ADDRESSES_URL=${ADDRESSES_URL:-http://deployer:8000/addresses.env}

echo "Fetching deployed contract addresses from ${ADDRESSES_URL}..."
curl -fsS "${ADDRESSES_URL}" -o /tmp/addresses.env

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
exec davinci-sequencer "$@"
