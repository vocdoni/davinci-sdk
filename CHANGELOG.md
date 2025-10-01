# Changelog

All notable changes to the Vocdoni DaVinci SDK will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added
- Initial public release preparation
- Complete TypeScript SDK for Vocdoni DaVinci protocol
- Support for both MerkleTree and CSP census types
- Comprehensive examples (script and UI)
- Full test coverage with unit and integration tests

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
