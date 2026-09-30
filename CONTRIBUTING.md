# Contributing to Vocdoni DaVinci SDK

Thank you for your interest in contributing to the Vocdoni DaVinci SDK! We welcome contributions from the community and are grateful for your help in making this project better.

## 📋 Table of Contents

- [Code of Conduct](#code-of-conduct)
- [Getting Started](#getting-started)
- [Development Setup](#development-setup)
- [How to Contribute](#how-to-contribute)
- [Pull Request Process](#pull-request-process)
- [Coding Standards](#coding-standards)
- [Testing Guidelines](#testing-guidelines)
- [Documentation](#documentation)
- [Issue Reporting](#issue-reporting)
- [Community](#community)

## 📜 Code of Conduct

This project and everyone participating in it is governed by our Code of Conduct. By participating, you are expected to uphold this code. Please report unacceptable behavior to [info@vocdoni.io](mailto:info@vocdoni.io).

### Our Standards

- **Be respectful**: Treat everyone with respect and kindness
- **Be inclusive**: Welcome newcomers and help them get started
- **Be collaborative**: Work together towards common goals
- **Be constructive**: Provide helpful feedback and suggestions
- **Be patient**: Remember that everyone has different experience levels

## 🚀 Getting Started

### Prerequisites

Before you begin, ensure you have the following installed:

- **Node.js** (version 18 or higher)
- **Yarn** (recommended) or npm
- **Git**
- A code editor (VS Code recommended)

### First-time Setup

1. **Fork the repository** on GitHub
2. **Clone your fork** locally:
   ```bash
   git clone https://github.com/YOUR_USERNAME/davinci-sdk.git
   cd davinci-sdk
   ```
3. **Add the upstream remote**:
   ```bash
   git remote add upstream https://github.com/vocdoni/davinci-sdk.git
   ```
4. **Install dependencies**:
   ```bash
   yarn install
   ```
5. **Run the tests** to ensure everything works:
   ```bash
   yarn test:unit
   ```

## 🛠 Development Setup

### Project Structure

```
davinci-sdk/
├── src/                    # Source code
│   ├── DavinciSDK.ts      # The facade
│   ├── networks.ts        # Network presets and the RPC failover provider
│   ├── core/              # Orchestration: processes, votes, results, metadata, HTTP base
│   ├── contracts/         # ProcessRegistry and census contract services, vendored ABIs (abi/)
│   ├── sequencer/         # Sequencer node client, wire codecs, routing
│   ├── census/            # Census classes, publishing, CSP signer, witnesses
│   ├── crypto/            # Protocol primitives: ballot, BabyJubJub, ElGamal, Poseidon, lean-IMT, ECDSA, tracker, DKG
│   ├── prover/            # Ballot circuit files and the snarkjs prover
│   └── protocol/          # Limits and release pins mirrored from davinci-zkvm
├── test/                  # Test files
│   ├── <domain>/unit/     # Unit tests
│   ├── anvil/             # The contracts on a local anvil chain
│   ├── e2e/               # The live suite on Gnosis (see test/e2e/README.md)
│   ├── fixtures/          # Test vectors
│   ├── helpers/           # Shared test utilities
│   └── setup/             # Vitest setup files
├── scripts/               # ABI sync, documentation build and checks, live suite runner
├── examples/script/       # Runnable elections on a configured deployment
├── docs/ai/               # Guides: SKILL.md, references/, recipes/
├── llms.txt, llms-full.txt # Documentation index and bundle, built from docs/ai
└── dist/                  # Built files (generated)
```

### Available Scripts

```bash
# Development
yarn dev                   # Watch mode development build
yarn build                 # Production build
yarn clean                 # Clean build artifacts

# Testing
yarn test                  # Unit tests, then the anvil suite
yarn test:unit             # Run unit tests only (offline)
yarn test:anvil            # Run the contracts on a local anvil chain (needs Foundry)
yarn test:e2e              # The live Gnosis suite; skipped unless DAVINCI_SDK_E2E is set
yarn test:contracts        # Run contract unit tests
yarn test:sequencer        # Run sequencer unit tests
yarn test:census           # Run census unit tests
yarn test:core             # Run core unit tests
yarn test:crypto           # Run crypto unit tests

# Code Quality
yarn lint                  # Run ESLint
yarn lint:fix              # Fix ESLint issues
yarn format                # Format code with Prettier
yarn format:check          # Check code formatting

# Documentation and vendored data
yarn docs:build            # Rebuild llms.txt and llms-full.txt from docs/ai
yarn docs:check            # Check they are up to date and type-check every code block of the docs
yarn sync:abis <checkout>  # Vendor the contract ABIs from a davinci-contracts checkout

# Before committing (no hook installs it)
yarn lint-staged           # Format and lint the staged files
```

### Environment Setup

Unit tests need nothing. The anvil suite (`yarn test:anvil`) needs git and
[Foundry](https://getfoundry.sh) 1.8.3 (`forge` and `anvil`). It deploys the
registry with davinci-contracts' `script/DeployAll.s.sol` and an `OwnedCensus`
of davinci-onchain-census-contract, at the commits the vendored ABIs come from
(`src/contracts/abi/source.json`, cloned once into `~/.cache/davinci-sdk-anvil`),
then runs the organizer flows against them with a local stand-in for a
sequencer node. To use checkouts you already have, set their paths in
`test/.env` (see `test/.env.example`):

```env
DAVINCI_CONTRACTS_DIR=../davinci-contracts
DAVINCI_CENSUS_CONTRACT_DIR=../davinci-onchain-census-contract
```

The live suite (`yarn test:e2e`, run through `scripts/e2e-live.sh`) creates
elections on the Gnosis deployment through real sequencer nodes; its phases,
settings and costs are in `test/e2e/README.md`.

A few unit tests prove real ballots with the circuit files. They are skipped
unless `DAVINCI_CIRCUIT_ARTIFACTS` names a directory holding
`ballot_proof.wasm`, `ballot_proof_pkey.zkey` and `ballot_proof_vkey.json` (a
davinci-circom checkout's `artifacts/` at the pinned commit):

```bash
DAVINCI_CIRCUIT_ARTIFACTS=../davinci-circom/artifacts yarn test:unit
```

### Vectors, ABIs and pins

The SDK mirrors the Rust implementation byte for byte, and its tests replay
vectors produced by that implementation. Never edit a vector by hand.

- **Protocol vectors** (`test/fixtures/zkvm/`): verbatim copies from
  davinci-zkvm's `rust-sdk/testdata/`, `rust-sdk/assets/` and
  `rust-sdk/src/{limits,release}.rs`. To refresh, copy the files from a newer
  davinci-zkvm, update the commit and the checksums in the folder's README, and
  run `yarn test:unit`. A change of `limits.rs` or `release.rs` must be followed
  in `src/protocol/`; a new ballot VK hash needs its circuit files in the table
  of `src/prover/artifacts.ts`.
- **Sequencer vectors** (`test/fixtures/sequencer/`): `networks.rs` is a copy
  of davinci-sequencer's `client/src/networks.rs`; `tracker.json`, `wire.json`
  and `census-files.json` are written by the Rust programs next to them
  (`tracker-gen/`, `wire-gen/`, `census-gen/`) against a davinci-sequencer
  checkout. The folder's README says how to run each and records the checksums.
- **Contract ABIs** (`src/contracts/abi/`): `yarn sync:abis <davinci-contracts
  checkout>` copies the ABIs from its forge build and records the commit and
  the file hashes in `source.json`; `--census <checkout>` does the same for
  davinci-onchain-census-contract (`abi/census/`) and the creation code the live
  suite deploys. The script refuses a checkout with uncommitted changes or a
  build of other sources. `test/contracts/unit/abi.test.ts` pins every selector,
  topic, error and struct layout the SDK relies on, so a contract change shows up
  as a failing test; the anvil suite deploys the same commits.

## 🤝 How to Contribute

### Types of Contributions

We welcome various types of contributions:

- **🐛 Bug fixes**: Fix issues and improve stability
- **✨ New features**: Add new functionality to the SDK
- **📚 Documentation**: Improve docs, examples, and guides
- **🧪 Tests**: Add or improve test coverage
- **🔧 Tooling**: Improve development tools and processes
- **🎨 Examples**: Create new usage examples

### Before You Start

1. **Check existing issues** to see if your idea is already being worked on
2. **Create an issue** to discuss new features or major changes
3. **Ask questions** in our [Discord](https://chat.vocdoni.io) if you're unsure

### Making Changes

1. **Create a new branch** from `main`:
   ```bash
   git checkout -b feature/your-feature-name
   # or
   git checkout -b fix/issue-description
   ```

2. **Make your changes** following our coding standards

3. **Write or update tests** for your changes

4. **Update documentation** if needed

5. **Test your changes**:
   ```bash
   yarn test:unit
   yarn lint
   yarn format:check
   yarn docs:check
   yarn test:anvil   # when contracts or organizer flows change (needs Foundry)
   ```

6. **Commit your changes** with a clear message:
   ```bash
   git commit -m "feat: add new voting method validation"
   # or
   git commit -m "fix: resolve census proof generation issue"
   ```

## 🔄 Pull Request Process

### Before Submitting

- [ ] Your code follows the project's coding standards
- [ ] You have added tests for your changes
- [ ] All tests pass locally
- [ ] You have updated documentation if necessary
- [ ] Your commits have clear, descriptive messages
- [ ] You have rebased your branch on the latest `main`

### Submitting a Pull Request

1. **Push your branch** to your fork:
   ```bash
   git push origin feature/your-feature-name
   ```

2. **Create a Pull Request** on GitHub with:
   - **Clear title** describing the change
   - **Detailed description** explaining what and why
   - **Link to related issues** if applicable
   - **Screenshots** for UI changes (if applicable)

3. **Respond to feedback** from reviewers promptly

### Pull Request Template

```markdown
## Description
Brief description of the changes made.

## Type of Change
- [ ] Bug fix (non-breaking change which fixes an issue)
- [ ] New feature (non-breaking change which adds functionality)
- [ ] Breaking change (fix or feature that would cause existing functionality to not work as expected)
- [ ] Documentation update

## Testing
- [ ] Unit tests pass
- [ ] The anvil suite passes (contracts or organizer flows changed)
- [ ] Documentation checks pass (`yarn docs:check`)
- [ ] Manual testing completed

## Checklist
- [ ] My code follows the style guidelines of this project
- [ ] I have performed a self-review of my own code
- [ ] I have commented my code, particularly in hard-to-understand areas
- [ ] I have made corresponding changes to the documentation
- [ ] My changes generate no new warnings
- [ ] I have added tests that prove my fix is effective or that my feature works
```

## 📏 Coding Standards

### TypeScript Guidelines

- **Use TypeScript** for all new code
- **Provide explicit types** for function parameters and return values
- **Use interfaces** for object shapes
- **Prefer `const` assertions** for immutable data
- **Use meaningful variable names**

```typescript
// Good
interface VoteConfig {
  processId: string;
  choices: readonly (number | bigint)[];
  k?: bigint;
}

async function submitVote(config: VoteConfig): Promise<VoteResult> {
  // Implementation
}

// Avoid
function vote(p: string, c: number[], k?: any): Promise<any> {
  // Implementation
}
```

### Code Style

- **Use Prettier** for formatting (configured in `.prettierrc.json`)
- **Follow ESLint rules** (configured in `.eslintrc.json`)
- **Use 2 spaces** for indentation
- **Use semicolons**
- **Use single quotes** for strings
- **Use trailing commas** in multiline structures

### Error Handling

- **Use descriptive error messages**
- **Create custom error classes** when appropriate
- **Handle errors gracefully** in public APIs
- **Provide context** in error messages

```typescript
// Good
if (choices.length !== expectedLength) {
  throw new Error(`Expected ${expectedLength} choices, got ${choices.length}`);
}

// Avoid
if (choices.length !== expectedLength) {
  throw new Error('Invalid choices');
}
```

### Documentation

- **Use JSDoc comments** for every public export
- **Include examples** in documentation
- **Document complex algorithms**
- **Keep comments up to date**

```typescript
/**
 * Submit a vote with simplified configuration
 * 
 * @param config - Vote configuration including process ID and choices
 * @returns Promise resolving to vote submission result
 * 
 * @example
 * ```typescript
 * const result = await sdk.submitVote({
 *   processId: "0x...",
 *   choices: [1, 0]
 * });
 * ```
 */
async submitVote(config: VoteConfig): Promise<VoteResult> {
  // Implementation
}
```

## 🧪 Testing Guidelines

### Test Structure

- **Unit tests** (`test/<domain>/unit/`): individual functions and classes, offline, with the
  chain (`test/helpers/mockChain.ts`) and the nodes mocked. Protocol code is tested against the
  vectors in `test/fixtures/`.
- **The anvil suite** (`test/anvil/`): every organizer flow against the real contracts on a
  local chain, with a stand-in node.
- **The live suite** (`test/e2e/`): whole elections on Gnosis through real nodes, run on demand.
- **Use descriptive test names** that explain what is being tested

### Writing Tests

```typescript
describe('VoteOrchestrationService', () => {
  describe('submitVote', () => {
    it('should submit a vote with valid configuration', async () => {
      // Arrange
      const config = { processId: '0x...', choices: [1] };
      
      // Act
      const result = await service.submitVote(config);
      
      // Assert
      expect(result.voteId).toBeDefined();
      expect(result.status).toBe(VoteStatus.Pending);
    });

    it('should throw error for invalid choices', async () => {
      // Arrange
      const config = { processId: '0x...', choices: [] };
      
      // Act & Assert
      await expect(service.submitVote(config)).rejects.toThrow('Expected 2 choices, got 0');
    });
  });
});
```

### Test Coverage

- **Aim for high test coverage** (>80%)
- **Test error conditions** as well as success cases
- **Mock external dependencies** in unit tests
- **Use the real contracts** in the anvil suite rather than mocks

## 📖 Documentation

### Types of Documentation

- **API Documentation**: JSDoc comments in code
- **Guides**: `docs/ai/SKILL.md`, `docs/ai/references/*.md` and the runnable `docs/ai/recipes/*.ts`
- **Bundles**: `llms.txt` and `llms-full.txt`, built from `docs/ai` by `scripts/build-llms.mjs`
- **Usage Examples**: `examples/script/`
- **README**: High-level overview and quick start
- **CHANGELOG**: every user-visible change, under `[Unreleased]`, with migration notes for breaking ones
- **Contributing Guide**: This document

### Documentation Standards

- **Keep it up to date** with code changes: a change of the public API updates the guides in the same pull request
- **Use clear, simple language**
- **Include practical examples**, with placeholders for node URLs and hosting: never a hosted instance's URL or other data that changes
- **Rebuild the bundles** after editing `docs/ai` (`yarn docs:build`)
- **Test code examples**: `yarn docs:check` type-checks every ```ts block of the README, the guides and this major's CHANGELOG entry, the recipes and `examples/script` against the SDK source. A block that is not code is marked ```ts nocheck

## 🐛 Issue Reporting

### Before Creating an Issue

1. **Search existing issues** to avoid duplicates
2. **Check the documentation** for solutions
3. **Try the latest version** to see if the issue is already fixed

### Creating a Good Issue

Include the following information:

- **Clear title** describing the problem
- **Steps to reproduce** the issue
- **Expected behavior**
- **Actual behavior**
- **Environment details** (Node.js version, OS, etc.)
- **Code samples** demonstrating the issue
- **Error messages** and stack traces

### Issue Templates

#### Bug Report
```markdown
**Describe the bug**
A clear and concise description of what the bug is.

**To Reproduce**
Steps to reproduce the behavior:
1. Initialize SDK with '...'
2. Call method '....'
3. See error

**Expected behavior**
A clear and concise description of what you expected to happen.

**Environment:**
- OS: [e.g. macOS, Windows, Linux]
- Node.js version: [e.g. 18.0.0]
- SDK version: [e.g. 0.2.0]

**Additional context**
Add any other context about the problem here.
```

#### Feature Request
```markdown
**Is your feature request related to a problem?**
A clear and concise description of what the problem is.

**Describe the solution you'd like**
A clear and concise description of what you want to happen.

**Describe alternatives you've considered**
A clear and concise description of any alternative solutions or features you've considered.

**Additional context**
Add any other context or screenshots about the feature request here.
```

## 🌟 Recognition

Contributors will be recognized in the following ways:

- **Contributors list** in the README
- **Release notes** mentioning significant contributions
- **Special thanks** in project announcements
- **Maintainer status** for consistent, high-quality contributions

## 💬 Community

### Getting Help

- **Discord**: [chat.vocdoni.io](https://chat.vocdoni.io) - Real-time chat
- **Telegram**: [t.me/vocdoni_community](https://t.me/vocdoni_community) - Community discussions
- **GitHub Issues**: For bug reports and feature requests
- **Email**: [info@vocdoni.io](mailto:info@vocdoni.io) - Direct contact

### Community Guidelines

- **Be welcoming** to newcomers
- **Help others** when you can
- **Share knowledge** and experiences
- **Provide constructive feedback**
- **Celebrate successes** together

## 📄 License

By contributing to this project, you agree that your contributions will be licensed under the same [AGPL-3.0 License](LICENSE) that covers the project.

---

Thank you for contributing to the Vocdoni DaVinci SDK! Your efforts help make decentralized voting more accessible to everyone. 🗳️✨
