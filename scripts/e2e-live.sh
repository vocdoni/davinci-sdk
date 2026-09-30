#!/usr/bin/env bash
# Runs a phase of the live Gnosis suite (test/e2e, see test/e2e/README.md) in
# node:22, with nothing but Docker on the host:
#
#   scripts/e2e-live.sh prepare
#   DAVINCI_SDK_E2E_BASE_URL=https://raw.githubusercontent.com/vocdoni/davinci-sdk/<commit>/test/e2e/fixtures \
#     DAVINCI_E2E_NODES=<node url>,<node url> \
#     DAVINCI_E2E_ORGANIZER_KEY=/path/to/organizer.key \
#     scripts/e2e-live.sh run
#
# The checkout is mounted read-only, except test/e2e/fixtures for prepare.
# The private directory DAVINCI_SDK_E2E_DIR (default ~/.davinci-gnosis/sdk-e2e,
# created mode 0700) is writable for prepare and read-only for run; so is the
# organizer key file, mounted for run only. DAVINCI_SDK_E2E_ARTIFACTS (default
# ~/.cache/davinci-sdk-e2e/artifacts) keeps the circuit files between runs.
# The container's node_modules, yarn cache and home live under
# E2E_DOCKER_CACHE (default ~/.cache/davinci-sdk-e2e/docker). The container
# uses the host network, so nodes on loopback are reachable, and runs as your
# user. The output is also written to E2E_LOG (default
# ~/.cache/davinci-sdk-e2e/<phase>-<time>.log).
set -euo pipefail

phase=${1:-}
case $phase in
    prepare | run) ;;
    *)
        echo "usage: $0 prepare|run" >&2
        exit 1
        ;;
esac

repo=$(cd "$(dirname "$0")/.." && pwd)
private=${DAVINCI_SDK_E2E_DIR:-$HOME/.davinci-gnosis/sdk-e2e}
artifacts=${DAVINCI_SDK_E2E_ARTIFACTS:-$HOME/.cache/davinci-sdk-e2e/artifacts}
cache=${E2E_DOCKER_CACHE:-$HOME/.cache/davinci-sdk-e2e/docker}
image=${E2E_IMAGE:-node:22}
log=${E2E_LOG:-$HOME/.cache/davinci-sdk-e2e/$phase-$(date -u +%Y%m%d-%H%M%S).log}

# Absolute paths: docker takes a relative one for a volume name.
private=$(realpath -m "$private")
case $private in
    "$repo" | "$repo"/*)
        echo "DAVINCI_SDK_E2E_DIR=$private is inside the checkout; keep the keys out of it" >&2
        exit 1
        ;;
esac
mkdir -p "$private" "$artifacts" "$cache/node_modules" "$cache/yarn" "$cache/home" \
    "$repo/node_modules" "$repo/test/e2e/fixtures" "$(dirname "$log")"
chmod 700 "$private"

mounts=(
    -v "$repo:/work:ro"
    -v "$cache/node_modules:/work/node_modules"
    -v "$cache/yarn:/cache/yarn"
    -v "$cache/home:/cache/home"
    -v "$(realpath "$artifacts"):/e2e/artifacts"
)
env_args=(
    -e DAVINCI_SDK_E2E="$phase"
    -e DAVINCI_SDK_E2E_DIR=/e2e/private
    -e DAVINCI_SDK_E2E_ARTIFACTS=/e2e/artifacts
    -e YARN_CACHE_FOLDER=/cache/yarn
    -e HOME=/cache/home
)

if [[ $phase == prepare ]]; then
    mounts+=(
        -v "$repo/test/e2e/fixtures:/work/test/e2e/fixtures"
        -v "$private:/e2e/private"
    )
else
    key=${DAVINCI_E2E_ORGANIZER_KEY:-}
    [[ -f $key ]] || { echo "DAVINCI_E2E_ORGANIZER_KEY: no key file '$key'" >&2; exit 1; }
    [[ -f $private/voters.json ]] || { echo "no voter keys in $private: run prepare first" >&2; exit 1; }
    for v in DAVINCI_SDK_E2E_BASE_URL DAVINCI_E2E_NODES; do
        [[ -n ${!v:-} ]] || { echo "$v is not set" >&2; exit 1; }
    done
    mounts+=(
        -v "$private:/e2e/private:ro"
        -v "$(realpath "$key"):/e2e/organizer.key:ro"
    )
    env_args+=(
        -e DAVINCI_E2E_ORGANIZER_KEY=/e2e/organizer.key
        -e DAVINCI_SDK_E2E_BASE_URL
        -e DAVINCI_E2E_NODES
    )
    [[ -z ${DAVINCI_E2E_RPC:-} ]] || env_args+=(-e DAVINCI_E2E_RPC)
fi

echo "e2e $phase: log in $log"
docker run --rm --init --name "davinci-sdk-e2e-$phase" \
    --network host \
    --user "$(id -u):$(id -g)" \
    -w /work \
    "${mounts[@]}" \
    "${env_args[@]}" \
    "$image" \
    sh -c 'yarn install --frozen-lockfile --non-interactive --prefer-offline --no-progress >/dev/null && yarn --silent test:e2e' \
    2>&1 | tee "$log"
