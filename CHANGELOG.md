# Changelog

All notable changes to the Vocdoni DaVinci SDK will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [0.1.1] - 2026-01-26

### Changed
- Updated `@vocdoni/davinci-contracts` dependency from version 0.0.31 to 0.0.35
  - **v0.0.33**: Added `onchainAllowAnyValidRoot: boolean` field to census data
  - **v0.0.34**: Added `contractAddress: AddressLike` field for onchain censuses
- **BREAKING**: `OnchainCensus` constructor now requires `uri` parameter (no longer optional)
  - URI must point to a data source like a subgraph endpoint, not explorers
  - Added validation to reject empty URI strings
  - Example: `new OnchainCensus(tokenAddress, "https://api.studio.thegraph.com/...")`

### Added
- Added `contractAddress?: string` field to `CensusData` interface for onchain census support
- Added `onchainAllowAnyValidRoot?: boolean` field to `CensusData` interface
  - Automatically set to `true` for onchain censuses, `false` for others
- `CensusOrchestrator.getCensusData()` now extracts and returns `contractAddress` from `OnchainCensus` objects
- Enhanced README with comprehensive `OnchainCensus` documentation
  - Added token-based voting examples
  - Documented subgraph integration patterns
  - Provided examples for different subgraph providers (The Graph Studio, custom deployments)

### Fixed
- **CRITICAL**: `OnchainCensus` now sets `censusRoot` to 32-byte zero value (`0x0000...000`)
  - Required when `contractAddress` is set to prevent smart contract validation failures
  - Contract address is now properly passed through `contractAddress` field instead of `censusRoot`
- Fixed `ProcessRegistryService.newProcess()` to include both new census fields with proper defaults
- Fixed `ProcessRegistryService.setProcessCensus()` to include both new census fields with proper defaults
- Fixed `ProcessOrchestrationService.handleCensus()` to properly extract and pass `contractAddress`
- Updated all test files to provide required URI parameter for `OnchainCensus`
  - Fixed 17 tests in `test/census/unit/OnchainCensus.test.ts`
  - Fixed 3 tests in `test/census/unit/CensusOrchestrator.test.ts`
  - Added new test for URI validation

### Technical Details
- `censusRoot` for onchain censuses: `0x0000000000000000000000000000000000000000000000000000000000000000`
- `contractAddress` properly stored and exposed via getter in `OnchainCensus` class
- `onchainAllowAnyValidRoot` automatically managed based on census type
- Census data flow: `OnchainCensus` → `CensusOrchestrator` → `ProcessOrchestrationService` → `ProcessRegistryService` → Smart Contract

### Migration Guide

**Before (v0.1.0):**
```typescript
// URI was optional
const census = new OnchainCensus("0xTokenAddress...");
```

**After (v0.1.1):**
```typescript
// URI is required and should be a subgraph endpoint
const census = new OnchainCensus(
  "0xTokenAddress...",
  "https://api.studio.thegraph.com/query/12345/token-holders/v1.0.0"
);
```

## [0.1.0] - 2026-01-15

### Changed
- **BREAKING**: Complete census class refactor for improved API ergonomics
  - Removed `PlainCensus` and `WeightedCensus` classes
  - Added new named census classes that automatically determine their census origin:
    - `OffchainCensus()` - Static Merkle tree census for OffchainStatic origin
    - `OffchainDynamicCensus()` - Updatable Merkle tree census for OffchainDynamic origin
    - `OnchainCensus(contractAddress, uri?)` - On-chain census for Onchain origin
    - `CspCensus(publicKey, cspURI)` - Certificate Service Provider census for CSP origin
  - New unified `MerkleCensus` base class that supports both plain and weighted participants
    - Single `add()` method intelligently handles plain addresses (weight=1) and weighted participants
    - Flexible weight types: accepts string, number, or bigint values
  - Removed `CensusType` enum (redundant with named census classes)
  - Removed `size` parameter from all census classes (no longer needed)
  - **Smart maxVoters logic**: `maxVoters` is now optional for published MerkleCensus objects (OffchainCensus, OffchainDynamicCensus)
    - SDK automatically calculates `maxVoters` from participant count when using census objects
    - Still required for manual census configs, OnchainCensus, CspCensus, and PublishedCensus
- Updated `PublishedCensus` constructor to accept `CensusOrigin` instead of deprecated `CensusType`
- Updated `CspCensus` constructor to only require (publicKey, cspURI) parameters

### Added
- New `Participant` interface exported from `MerkleCensus` for type safety
- Comprehensive unit tests for all new census classes:
  - `test/census/unit/OffchainCensus.test.ts` - Tests for plain and weighted OffchainCensus
  - `test/census/unit/OffchainDynamicCensus.test.ts` - Tests for dynamic census functionality
  - `test/census/unit/OnchainCensus.test.ts` - Tests for on-chain census
- Updated existing tests:
  - `test/census/unit/PublishedCensus.test.ts` - Updated for new API
  - `test/census/unit/CspCensus.test.ts` - Updated for new constructor
  - `test/census/unit/CensusOrchestrator.test.ts` - Updated for new census classes
- Updated integration tests to use new census classes and maxVoters behavior:
  - `test/core/integration/SimpleProcessCreation.test.ts` - Updated all census usage
  - `test/core/integration/VoteOrchestration.test.ts` - Updated all census configs

### Removed
- Removed `PlainCensus` class (replaced by `OffchainCensus`)
- Removed `WeightedCensus` class (replaced by `OffchainCensus` with weighted participants)
- Removed `CensusType` enum (replaced by `CensusOrigin` usage)
- Removed `size` property from all census classes
- Removed legacy census test files:
  - `test/census/unit/PlainCensus.test.ts`
  - `test/census/unit/WeightedCensus.test.ts`

### Fixed
- Fixed `Participant` type export issue in census classes index file
- Updated example script to showcase new census API and optional maxVoters feature
- Updated README.md documentation to reflect new census class names and usage patterns
- Corrected all manual census configuration examples to exclude deprecated `size` parameter

### Migration Guide

#### Updating Census Classes

**Before (v0.0.7):**
```typescript
import { PlainCensus, WeightedCensus } from '@vocdoni/davinci-sdk';

// Plain census
const plainCensus = new PlainCensus();
plainCensus.add(['0x123...', '0x456...']);

// Weighted census
const weightedCensus = new WeightedCensus();
weightedCensus.add([
  { key: '0x123...', weight: 10 },
  { key: '0x456...', weight: 20 }
]);
```

**After (v0.1.0):**
```typescript
import { OffchainCensus } from '@vocdoni/davinci-sdk';

// Plain addresses (weight defaults to 1)
const census = new OffchainCensus();
census.add(['0x123...', '0x456...']);

// Weighted participants (same class!)
const census = new OffchainCensus();
census.add([
  { key: '0x123...', weight: 10 },
  { key: '0x456...', weight: 20 }
]);
```

#### Updating Process Creation with Census Objects

**Before (v0.0.7):**
```typescript
const census = new PlainCensus();
census.add(['0x123...', '0x456...']);

const process = await sdk.createProcess({
  census: census,
  maxVoters: 100, // Always required
  // ... other config
});
```

**After (v0.1.0):**
```typescript
const census = new OffchainCensus();
census.add(['0x123...', '0x456...']);

const process = await sdk.createProcess({
  census: census,
  // maxVoters is optional - auto-calculated from census!
  // ... other config
});
```

#### Updating Manual Census Configurations

**Before (v0.0.7):**
```typescript
const process = await sdk.createProcess({
  census: {
    type: CensusOrigin.OffchainStatic,
    root: "0x...",
    size: 100, // Had size parameter
    uri: "ipfs://..."
  },
  // ... other config
});
```

**After (v0.1.0):**
```typescript
const process = await sdk.createProcess({
  census: {
    type: CensusOrigin.OffchainStatic,
    root: "0x...",
    uri: "ipfs://..." // No size parameter
  },
  maxVoters: 100, // Now required for manual configs
  // ... other config
});
```

#### Updating CspCensus Usage

**Before (v0.0.7):**
```typescript
const census = new CspCensus(
  CensusOrigin.CSP,
  "0x...",
  "https://csp.example.com",
  1000
);
```

**After (v0.1.0):**
```typescript
const census = new CspCensus(
  "0x...", // publicKey
  "https://csp.example.com" // cspURI
);

// Use with maxVoters in process config
const process = await sdk.createProcess({
  census: census,
  maxVoters: 1000, // Required for CSP
  // ... other config
});
```

### Technical Details
- Census classes now use the class name itself to determine census origin, eliminating the need to pass `CensusOrigin` as a constructor parameter
- The `MerkleCensus` base class provides a unified implementation for both plain and weighted participants
- Automatic maxVoters calculation reduces boilerplate and prevents mismatches between census size and maxVoters
- All census classes properly extend the base `Census` class with appropriate origin types
- Type exports fixed to properly handle both type and value exports

## [0.0.7] - 2026-01-14

### Added
- **Batch Voting Submission**: Enhanced voting capabilities to support batch submission of multiple votes
  - Improved vote orchestration for handling multiple votes efficiently
  - Updated example script to demonstrate batch voting workflows
- **CensusNotUpdatable Error**: New error class for handling census update restrictions
  - Added to `src/contracts/errors.ts` for better error handling when census updates are not allowed

### Changed
- **BREAKING**: Refactored census origin types for better clarity and alignment with smart contracts
  - Changed `CensusOrigin.CensusOriginMerkleTree` to `CensusOrigin.OffchainStatic`
  - Changed `CensusOrigin.CensusOriginCSP` to `CensusOrigin.CSP`
  - Updated all census classes (`Census`, `PlainCensus`, `WeightedCensus`, `CspCensus`, `PublishedCensus`) to use new origin types
  - Updated `ProcessRegistryService` to reflect new census origin types in event callbacks
  - Modified SDK documentation and examples to use new census origin nomenclature
- Enhanced census origin handling across the SDK
  - Improved census type detection and origin assignment
  - Better validation for census update operations
- Updated `@vocdoni/davinci-contracts` dependency to version `0.0.31`
  - Includes latest smart contract improvements and census origin type updates

### Fixed
- Improved test coverage for census update scenarios
- Fixed census origin type consistency across the codebase

### Technical Details
- Census origin refactoring ensures consistency between SDK types and smart contract enums
- New `OffchainStatic` name better represents MerkleTree-based censuses stored off-chain
- All census-related tests updated to use new origin types
- Examples updated to demonstrate best practices with new API

## [0.0.6] - 2025-12-15

### Added
- **Process MaxVoters Management**: New methods to manage the maximum number of voters for a process
  - Added `setProcessMaxVoters(processId, maxVoters)` method to DavinciSDK for updating voter limits
  - Added `setProcessMaxVotersStream(processId, maxVoters)` for real-time transaction status monitoring
  - Added `maxVoters` optional parameter to `ProcessConfig` during process creation (defaults to census size)
  - Added `maxVoters` field to `ProcessInfo` returned by `getProcess()`
  - Available at all architecture layers: SDK, Orchestration, and Contract services
- Added `ProcessMaxVotersChangedCallback` event type for monitoring maxVoters changes
- Added `onProcessMaxVotersChanged()` event listener to ProcessRegistryService
- Contract integration now supports `@vocdoni/davinci-contracts` version 0.0.29 with maxVoters parameter

### Changed
- Updated `ProcessRegistryService.newProcess()` to include `maxVoters` parameter
- Updated `ProcessOrchestrationService` to automatically set maxVoters to census size if not specified
- Process creation now validates and enforces maximum voter limits on-chain

### Technical Details
- All process management methods follow consistent architecture pattern: `DavinciSDK` → `ProcessOrchestrationService` → `ProcessRegistryService` → `Smart Contract`
- MaxVoters updates emit `ProcessMaxVotersChanged` events on-chain for monitoring
- Comprehensive test coverage added at contract, orchestration, and SDK levels
- Both stream-based and promise-based APIs available for maximum flexibility

## [0.0.5] - 2025-12-04

### Changed
- **BREAKING**: `GetProcessResponse` type updated to match actual sequencer API response
  - `startTime` changed from `number` to `string` (ISO date format)
  - `result` changed from `string[]` to `string[] | null` (can be null before process ends)
  - Renamed `voteCount` to `votersCount` 
  - Renamed `voteOverwrittenCount` to `overwrittenVotesCount`
  - Removed `metadata` field (not returned by sequencer)
- **BREAKING**: `isAddressAbleToVote()` now returns `Promise<boolean>` instead of participant info object
  - Returns `true` if address is in census and can vote
  - Returns `false` only when address is not in census (error code 40001)
  - Throws errors for invalid inputs (invalid process ID, invalid address format, etc.)
  - Use new `getAddressWeight()` method to retrieve weight separately if needed
- Optimized MerkleTree voting to use sequencer's participant endpoint
  - Vote submission now calls `getAddressWeight()` instead of fetching full census proof
  - More efficient - only fetches required weight for vote encryption
  - Custom census providers still supported for both MerkleTree and CSP

### Added
- Added `getAddressWeight(processId, address)` method to retrieve voting weight
  - Returns weight as a string
  - Available in both SequencerService and DavinciSDK
  - Throws errors for invalid process ID or address not in census
- Added comprehensive test coverage for new methods
  - Updated `isAddressAbleToVote` tests to expect boolean return
  - Added 4 new tests for `getAddressWeight` functionality
  - Updated vote orchestration tests for new census proof flow

### Fixed
- Fixed sequencer integration tests to use new property names (`votersCount`, `overwrittenVotesCount`)
- Fixed vote orchestration to properly handle census weight retrieval from sequencer
- Improved error handling in `isAddressAbleToVote` to distinguish between "not in census" and other errors

### Technical Details
- `VoteOrchestrationService.getCensusProof()` now uses `getAddressWeight()` for MerkleTree census
- Census proof objects for MerkleTree voting now include minimal data (weight only)
- Full census proof still available through custom census providers if needed
- All type definitions now accurately match sequencer API responses

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
