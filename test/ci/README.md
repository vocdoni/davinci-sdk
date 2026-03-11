# SDK integration CI stack

This folder contains the local stack used by GitHub Actions to run SDK integration tests without Sepolia.

It starts:
- Anvil (local chain on `:8545`)
- A deployer container that deploys `davinci-contracts` and serves `addresses.env`
- A sequencer container wired to that local chain and deployed addresses

## Local usage

From the repository root:

```bash
docker compose -f test/ci/docker-compose.yml up -d --build
bash test/ci/wait-for-stack.sh
bash test/ci/write-test-env.sh
yarn test:integration
```

Stop everything:

```bash
docker compose -f test/ci/docker-compose.yml down -v --remove-orphans
```
