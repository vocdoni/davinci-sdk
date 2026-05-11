# SDK integration CI stack

This folder contains the local stack used by GitHub Actions to run SDK integration tests without Sepolia.

It starts:
- Anvil (local chain on `:8545`)
- A deployer container that deploys `davinci-contracts` and serves `addresses.env`
- A sequencer container wired to that local chain and deployed addresses

By default, the deployer resolves `davinci-contracts` from the `davinci-node` `go.mod` (same node ref),
so contract verifier hashes stay aligned with the sequencer image.
You can still override refs with `CONTRACTS_REF`, `DAVINCI_NODE_REF`, and `DAVINCI_NODE_TAG`.

## Local usage

From the repository root:

```bash
docker compose -f test/ci/docker-compose.yml up -d --build --pull always
bash test/ci/wait-for-stack.sh
bash test/ci/write-test-env.sh
yarn test:integration:e2e:ci
```

Stop everything:

```bash
docker compose -f test/ci/docker-compose.yml down -v --remove-orphans
```
