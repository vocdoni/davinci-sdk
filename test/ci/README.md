# SDK integration CI stack

This folder contains the local stack used by GitHub Actions to run SDK integration tests without Sepolia.

It starts:
- Anvil (local chain on `:8545`)
- A sequencer container wired directly to that local chain
- Census3 API container

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
