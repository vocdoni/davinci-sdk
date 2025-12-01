# Changelog

All notable changes to the Vocdoni DaVinci SDK will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [0.0.4] - 2025-12-01

### Changed
- **BREAKING**: Removed `maxVotes` field from census data structure in smart contracts
  - Census now only includes: `censusOrigin`, `censusRoot`, and `censusURI` (3 fields instead of 4)
  - Updated `ProcessRegistryService.newProcess()` to remove maxVotes parameter
  - Updated `ProcessRegistryService.setProcessCensus()` to remove maxVotes parameter
  - Updated `ProcessCensusUpdatedCallback` type signature
- **BREAKING**: Census proof `weight` field is now mandatory (required by Go WASM cryptographic operations)
  - Previously optional weight field in census proofs is now required
  - Type guards now validate that weight is present and is a string
- Fixed CSP proof verification to include weight parameter
  - Added `weight` field to `CSPSignOutput` interface
  - Added `weight` parameter to `cspVerify()` method
  - Updated all CSP-related tests to include weight in verification calls

### Added
- Added `isAddressAbleToVote()` method to DavinciSDK
  - Returns participant information including voting weight for an address
  - Useful for verifying voter eligibility before vote submission
  - Enables displaying voting power/weight to users
  - Supports building voter dashboards and analytics
- Added comprehensive test coverage for `isAddressAbleToVote()` functionality
  - 1 test in Sequencer integration tests
  - 4 tests in VoteOrchestration integration tests
- Updated README.md with documentation for new `isAddressAbleToVote()` method

### Fixed
- Fixed `ProcessInfo` interface to include census `size` field
  - Census size is not stored on-chain, so it's set to 0 when fetching process info
  - Ensures compatibility with the `BaseProcess` interface
- Fixed all test files to work with updated census data structure
  - Removed maxVotes assertions from ProcessRegistry tests
  - Removed maxVotes assertions from SimpleProcessCreation tests
  - Updated CensusOrchestrator tests to include missing size field
- All 23 CSP tests now passing with updated verification parameters

### Technical Details
- Census proof weight validation now enforced at compile-time
- CSP signature verification now properly includes weight in cryptographic operations
- Process information retrieval properly handles missing census size from on-chain data

## [0.0.3] - 2025-10-30

### Changed
- **BREAKING**: Removed legacy `environment` parameter from SDK configuration
- **BREAKING**: SDK now requires explicit `sequencerUrl` parameter
- Updated SDK to fetch contract addresses automatically from sequencer `/info` endpoint
- Improved contract integration tests to dynamically fetch addresses from sequencer
- Organized and optimized import statements across the codebase

### Added
- Added proper validation for `censusUrl` requirement when using PlainCensus or WeightedCensus
- Added helpful error messages when census URL is missing for census publication
- Documentation updates reflecting new initialization patterns in README

### Fixed
- Fixed async error handling in Sequencer integration tests
- Fixed census URL validation to properly check axios baseURL configuration
- Fixed test files to use environment variables instead of hardcoded URLs

### Removed
- Removed entire `src/core/config/` module (deprecated legacy configuration system)
- Removed unused `deployedAddresses` export and related configuration code
- Removed hardcoded contract addresses from codebase

## [0.0.2] - 2025-01-16

### Added
- Initial public release preparation
- Complete TypeScript SDK for Vocdoni DaVinci protocol
- Support for both MerkleTree and CSP census types
- Comprehensive examples (script and UI)
- Full test coverage with unit and integration tests

### Changed
- Updated build configuration for better module compatibility
- Improved error handling and type definitions

### Fixed
- Various bug fixes and stability improvements

## [0.0.1] - 2024-12-01

### Added
- **Core SDK Features**
  - Complete DaVinci SDK implementation with TypeScript support
  - Process creation and management capabilities
  - Vote submission with homomorphic encryption
  - Census creation and management (MerkleTree and CSP)
  - Smart contract integration for Ethereum networks
  - Support for Sepolia testnet and Ethereum mainnet

- **API Services**
  - Sequencer API client for vote processing
  - Census API client for participant management
  - Base API service with error handling and retries
  - Comprehensive type definitions

- **Cryptographic Features**
  - Homomorphic encryption for vote privacy
  - zk-SNARK proof generation and verification
  - Circom circuit integration
  - CSP (Census Service Provider) signature support

- **Developer Experience**
  - Complete TypeScript definitions
  - ESM and CommonJS module support
  - Browser and Node.js compatibility
  - Comprehensive JSDoc documentation
  - Multiple bundle formats (UMD, ES modules, CommonJS)

- **Examples and Documentation**
  - Script example with complete voting workflow
  - React UI example with wallet integration
  - Comprehensive README with usage examples
  - API reference documentation
  - Contributing guidelines

- **Testing Infrastructure**
  - Unit tests for all core functionality
  - Integration tests with real network interactions
  - Jest test framework setup
  - Test utilities and helpers

- **Build and Development**
  - Rollup build configuration for multiple formats
  - TypeScript compilation with strict mode
  - ESLint and Prettier configuration
  - Automated formatting and linting
  - Git hooks for code quality

- **Quality Assurance**
  - Comprehensive error handling
  - Input validation and sanitization
  - Network timeout and retry logic
  - Memory-efficient proof generation

### Technical Details
- **Dependencies**
  - ethers.js v6 for Ethereum interactions
  - axios for HTTP requests
  - snarkjs for zk-SNARK operations
  - @vocdoni/davinci-contracts for smart contract ABIs

- **Supported Networks**
  - Ethereum Sepolia testnet
  - Ethereum mainnet
  - Custom network configuration support

- **Supported Environments**
  - Node.js 16+
  - Modern browsers (Chrome, Firefox, Safari, Edge)
  - React applications
  - Vue.js applications
  - Vanilla JavaScript/TypeScript projects

### Known Issues
- None at initial release

---

## Release Notes

### Version 0.0.1 - Initial Release

This is the first public release of the Vocdoni DaVinci SDK, providing a complete TypeScript interface for building decentralized voting applications on the Vocdoni DaVinci protocol.

**Key Features:**
- 🔒 **Privacy-First**: Homomorphic encryption ensures vote privacy
- 🛡️ **Secure**: Built on battle-tested cryptographic primitives  
- ⚡ **Easy Integration**: Simple, intuitive API for developers
- 🌐 **Decentralized**: No central authority controls the voting process
- 📱 **Cross-Platform**: Works in browsers, Node.js, and mobile apps
- 🔧 **TypeScript**: Full type safety and excellent developer experience

**Getting Started:**
```bash
npm install @vocdoni/davinci-sdk ethers
```

See the [README](README.md) for complete usage examples and API documentation.

**Breaking Changes:** N/A (initial release)

**Migration Guide:** N/A (initial release)

---

## Contributing

When contributing to this project, please:

1. Follow the [Contributing Guidelines](CONTRIBUTING.md)
2. Update this CHANGELOG with your changes
3. Use the format described in [Keep a Changelog](https://keepachangelog.com/en/1.0.0/)
4. Group changes by type: Added, Changed, Deprecated, Removed, Fixed, Security

## Links

- [GitHub Repository](https://github.com/vocdoni/davinci-sdk)
- [npm Package](https://www.npmjs.com/package/@vocdoni/davinci-sdk)
- [Documentation](https://docs.vocdoni.io)
- [Issue Tracker](https://github.com/vocdoni/davinci-sdk/issues)
