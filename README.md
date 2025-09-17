# Vocdoni DaVinci SDK

[![npm version](https://badge.fury.io/js/%40vocdoni%2Fdavinci-sdk.svg)](https://badge.fury.io/js/%40vocdoni%2Fdavinci-sdk)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)
[![TypeScript](https://img.shields.io/badge/TypeScript-Ready-blue.svg)](https://www.typescriptlang.org/)
[![Build Status](https://img.shields.io/badge/build-passing-brightgreen.svg)](#)

A powerful, easy-to-use TypeScript SDK for building decentralized voting applications on the Vocdoni DaVinci protocol. Create secure, private, and verifiable elections with just a few lines of code.

## 🚀 Quick Start

### Installation

```bash
npm install @vocdoni/davinci-sdk
# or
yarn add @vocdoni/davinci-sdk
```

### Basic Usage

```typescript
import { DavinciSDK, CensusOrigin } from '@vocdoni/davinci-sdk';
import { Wallet } from 'ethers';

// Initialize the SDK
const wallet = new Wallet('your-private-key');
const sdk = new DavinciSDK({
  signer: wallet,
  environment: 'dev' // or 'stg', 'prod'
});

await sdk.init();

// Create a voting process
const process = await sdk.createProcess({
  title: "Community Decision",
  description: "Vote on our next community initiative",
  census: {
    type: CensusOrigin.CensusOriginMerkleTree,
    root: "0x...", // Your census root
    size: 100,
    uri: "ipfs://your-census-uri"
  },
  timing: {
    startDate: new Date("2024-12-01T10:00:00Z"),
    duration: 86400 // 24 hours in seconds
  },
  questions: [{
    title: "Which initiative should we prioritize?",
    choices: [
      { title: "Community Garden", value: 0 },
      { title: "Tech Workshop", value: 1 },
      { title: "Art Exhibition", value: 2 }
    ]
  }]
});

// Submit a vote
const vote = await sdk.submitVote({
  processId: process.processId,
  choices: [1] // Vote for "Tech Workshop"
});

// Wait for vote confirmation
const finalStatus = await sdk.waitForVoteStatus(
  vote.processId,
  vote.voteId,
  VoteStatus.Settled
);

console.log('Vote confirmed!', finalStatus);
```

## 📚 Table of Contents

- [Features](#-features)
- [Installation](#-installation)
- [Core Concepts](#-core-concepts)
- [API Reference](#-api-reference)
  - [SDK Initialization](#sdk-initialization)
  - [Process Management](#process-management)
  - [Voting Operations](#voting-operations)
- [Examples](#-examples)
- [Advanced Configuration](#-advanced-configuration)
- [Error Handling](#-error-handling)
- [Testing](#-testing)
- [Contributing](#-contributing)
- [Support](#-support)

## ✨ Features

- **🔒 Privacy-First**: Zero-knowledge proofs ensure vote privacy
- **🛡️ Secure**: Built on battle-tested cryptographic primitives
- **⚡ Easy Integration**: Simple, intuitive API for developers
- **🌐 Decentralized**: No central authority controls the voting process
- **📱 Cross-Platform**: Works in browsers, Node.js, and mobile apps
- **🔧 TypeScript**: Full type safety and excellent developer experience
- **🎯 Flexible**: Support for multiple question types and voting modes
- **📊 Real-time**: Live vote status tracking and results

## 🛠 Installation

### Prerequisites

- Node.js 16+ or modern browser environment
- An Ethereum wallet/signer (MetaMask, WalletConnect, etc.)

### Package Installation

```bash
# Using npm
npm install @vocdoni/davinci-sdk ethers

# Using yarn
yarn add @vocdoni/davinci-sdk ethers

# Using pnpm
pnpm add @vocdoni/davinci-sdk ethers
```

## 🧠 Core Concepts

### Voting Process Lifecycle

1. **Process Creation**: Define voting parameters, questions, and census
2. **Vote Submission**: Voters submit encrypted, anonymous votes
3. **Vote Processing**: Votes are verified and aggregated using zk-SNARKs
4. **Results**: Final results are computed and made available

### Key Components

- **Census**: List of eligible voters (Merkle tree or CSP-based)
- **Ballot**: Vote structure defining questions and possible answers
- **Process**: Container for all voting parameters and metadata
- **Proof**: Cryptographic evidence that a vote is valid

## 📖 API Reference

### SDK Initialization

#### Constructor Options

```typescript
interface DavinciSDKConfig {
  signer: Signer;                    // Ethereum signer (required)
  environment?: 'dev' | 'stg' | 'prod'; // Environment (default: 'prod')
  sequencerUrl?: string;             // Custom sequencer URL
  censusUrl?: string;                // Custom census API URL
  chain?: 'sepolia' | 'mainnet';    // Blockchain network
  contractAddresses?: {              // Custom contract addresses
    processRegistry?: string;
    organizationRegistry?: string;
    // ... other contracts
  };
  useSequencerAddresses?: boolean;   // Use addresses from sequencer
}
```

#### Basic Initialization

```typescript
import { DavinciSDK } from '@vocdoni/davinci-sdk';
import { Wallet } from 'ethers';

const sdk = new DavinciSDK({
  signer: new Wallet('your-private-key'),
  environment: 'dev'
});

await sdk.init();
```

### Process Management

#### Creating a Process

```typescript
const processResult = await sdk.createProcess({
  title: "Election Title",
  description: "Detailed description of the election",
  
  // Census configuration
  census: {
    type: CensusOrigin.CensusOriginMerkleTree,
    root: "0x...",
    size: 1000,
    uri: "ipfs://..."
  },
  
  // Timing configuration
  timing: {
    startDate: new Date("2024-12-01T10:00:00Z"),
    duration: 86400 // 24 hours
    // Alternative: endDate: new Date("2024-12-02T10:00:00Z")
  },
  
  // Ballot configuration
  ballot: {
    numFields: 1,
    maxValue: "2",
    minValue: "0",
    uniqueValues: false,
    costFromWeight: false,
    costExponent: 1,
    maxValueSum: "2",
    minValueSum: "0"
  },
  
  // Questions
  questions: [{
    title: "What is your preferred option?",
    description: "Choose the option that best represents your view",
    choices: [
      { title: "Option A", value: 0 },
      { title: "Option B", value: 1 },
      { title: "Option C", value: 2 }
    ]
  }]
});

console.log('Process created:', processResult.processId);
```

#### Retrieving Process Information

```typescript
const processInfo = await sdk.getProcess(processId);

console.log('Title:', processInfo.title);
console.log('Status:', processInfo.status);
console.log('Start date:', processInfo.startDate);
console.log('End date:', processInfo.endDate);
console.log('Questions:', processInfo.questions);
```

### Voting Operations

#### Submitting a Vote

```typescript
const voteResult = await sdk.submitVote({
  processId: "0x...",
  choices: [1, 0], // Answers for each question
  randomness: "optional-custom-randomness" // Optional
});

console.log('Vote ID:', voteResult.voteId);
console.log('Status:', voteResult.status);
```

#### Checking Vote Status

```typescript
const status = await sdk.getVoteStatus(processId, voteId);
console.log('Current status:', status.status);
// Possible statuses: pending, verified, aggregated, processed, settled, error
```

#### Waiting for Vote Confirmation

```typescript
import { VoteStatus } from '@vocdoni/davinci-sdk';

const finalStatus = await sdk.waitForVoteStatus(
  processId,
  voteId,
  VoteStatus.Settled, // Target status
  300000, // 5 minute timeout
  5000    // Check every 5 seconds
);
```

#### Checking if Address Has Voted

```typescript
const hasVoted = await sdk.hasAddressVoted(processId, voterAddress);
if (hasVoted) {
  console.log('This address has already voted');
}
```

## 💡 Examples

### Complete Voting Flow

```typescript
import { DavinciSDK, CensusOrigin, VoteStatus } from '@vocdoni/davinci-sdk';
import { Wallet } from 'ethers';

async function completeVotingExample() {
  // 1. Initialize SDK
  const organizerWallet = new Wallet('organizer-private-key');
  const sdk = new DavinciSDK({
    signer: organizerWallet,
    environment: 'dev'
  });
  await sdk.init();

  // 2. Create census (simplified - in practice, use census API)
  const censusRoot = "0x..."; // Your census root
  const censusSize = 100;

  // 3. Create voting process
  const process = await sdk.createProcess({
    title: "Community Budget Allocation",
    description: "Decide how to allocate our community budget",
    census: {
      type: CensusOrigin.CensusOriginMerkleTree,
      root: censusRoot,
      size: censusSize,
      uri: `ipfs://census-metadata`
    },
    timing: {
      startDate: new Date(Date.now() + 60000), // Start in 1 minute
      duration: 3600 // 1 hour
    },
    questions: [{
      title: "Which project should receive funding?",
      choices: [
        { title: "Community Garden", value: 0 },
        { title: "Tech Education Program", value: 1 },
        { title: "Local Art Initiative", value: 2 }
      ]
    }]
  });

  console.log(`Process created: ${process.processId}`);

  // 4. Vote (using a different wallet)
  const voterWallet = new Wallet('voter-private-key');
  const voterSdk = new DavinciSDK({
    signer: voterWallet,
    environment: 'dev'
  });
  await voterSdk.init();

  // Wait for process to start accepting votes
  await new Promise(resolve => setTimeout(resolve, 65000));

  const vote = await voterSdk.submitVote({
    processId: process.processId,
    choices: [1] // Vote for Tech Education Program
  });

  console.log(`Vote submitted: ${vote.voteId}`);

  // 5. Wait for vote confirmation
  const finalStatus = await voterSdk.waitForVoteStatus(
    vote.processId,
    vote.voteId,
    VoteStatus.Settled
  );

  console.log('Vote confirmed with status:', finalStatus.status);
}
```

### Browser Integration with MetaMask

```typescript
import { DavinciSDK } from '@vocdoni/davinci-sdk';
import { BrowserProvider } from 'ethers';

async function browserVotingExample() {
  // Connect to MetaMask
  if (!window.ethereum) {
    throw new Error('MetaMask not found');
  }

  const provider = new BrowserProvider(window.ethereum);
  await provider.send("eth_requestAccounts", []);
  const signer = await provider.getSigner();

  // Initialize SDK
  const sdk = new DavinciSDK({
    signer,
    environment: 'prod'
  });
  await sdk.init();

  // Submit vote
  const vote = await sdk.submitVote({
    processId: "0x...",
    choices: [2]
  });

  console.log('Vote submitted from browser:', vote.voteId);
}
```

## ⚙️ Advanced Configuration

<details>
<summary>Click to expand advanced configuration options</summary>

### Custom Network Configuration

```typescript
const sdk = new DavinciSDK({
  signer: wallet,
  chain: 'sepolia',
  sequencerUrl: 'https://your-custom-sequencer.com',
  censusUrl: 'https://your-custom-census.com',
  contractAddresses: {
    processRegistry: '0x...',
    organizationRegistry: '0x...',
    stateTransitionVerifier: '0x...',
    resultsVerifier: '0x...'
  }
});
```

### Using Sequencer-Provided Addresses

```typescript
const sdk = new DavinciSDK({
  signer: wallet,
  environment: 'dev',
  useSequencerAddresses: true // Fetch contract addresses from sequencer
});
```

### Custom Vote Randomness

```typescript
const vote = await sdk.submitVote({
  processId: "0x...",
  choices: [1],
  randomness: "your-custom-randomness-hex" // For deterministic testing
});
```

### Advanced Process Configuration

```typescript
const process = await sdk.createProcess({
  title: "Advanced Election",
  // ... basic config
  
  ballot: {
    numFields: 3,           // Number of questions
    maxValue: "5",          // Maximum choice value
    minValue: "0",          // Minimum choice value
    uniqueValues: true,     // Require unique choices
    costFromWeight: false,  // Use weight for vote cost
    costExponent: 1,        // Cost calculation exponent
    maxValueSum: "10",      // Maximum sum of all choices
    minValueSum: "3"        // Minimum sum of all choices
  }
});
```

### Direct Service Access

```typescript
// Access underlying services for advanced operations
const processRegistry = sdk.processes;
const organizationRegistry = sdk.organizations;
const apiService = sdk.api;
const crypto = await sdk.getCrypto();

// Direct API calls
const processInfo = await sdk.api.sequencer.getProcess(processId);
const censusProof = await sdk.api.census.getCensusProof(root, address);
```

</details>

## 🚨 Error Handling

The SDK provides detailed error messages for common scenarios:

```typescript
try {
  const vote = await sdk.submitVote({
    processId: "0x...",
    choices: [1, 2, 3]
  });
} catch (error) {
  if (error.message.includes('already voted')) {
    console.log('User has already voted in this process');
  } else if (error.message.includes('not accepting votes')) {
    console.log('Voting period has not started or has ended');
  } else if (error.message.includes('out of range')) {
    console.log('Invalid choice values provided');
  } else {
    console.error('Unexpected error:', error.message);
  }
}
```

### Common Error Types

- **Process Errors**: Process not found, not accepting votes, invalid configuration
- **Vote Errors**: Already voted, invalid choices, proof generation failed
- **Network Errors**: Connection issues, transaction failures
- **Validation Errors**: Invalid parameters, out-of-range values

## 🧪 Testing

### Running Tests

```bash
# Run all tests
npm test

# Run unit tests only
npm run test:unit

# Run integration tests only
npm run test:integration

# Run specific test suites
npm run test:contracts
npm run test:sequencer
npm run test:census
```

### Test Environment Setup

Create a `.env` file in the test directory:

```env
SEPOLIA_RPC=https://sepolia.infura.io/v3/your-key
PRIVATE_KEY=0x...
TIME_OUT=600000
```

## 🤝 Contributing

We welcome contributions! Please see our [Contributing Guide](CONTRIBUTING.md) for details.

### Development Setup

```bash
# Clone the repository
git clone https://github.com/vocdoni/davinci-sdk.git
cd davinci-sdk

# Install dependencies
yarn install

# Run development build
yarn dev

# Run linting
yarn lint

# Format code
yarn format
```

### Code Quality

- **TypeScript**: Full type safety
- **ESLint**: Code linting and style enforcement
- **Prettier**: Code formatting
- **Jest**: Comprehensive testing suite
- **Husky**: Pre-commit hooks

## 📄 License

This project is licensed under the MIT License - see the [LICENSE](LICENSE) file for details.

## 🆘 Support

### Documentation

- [API Documentation](https://docs.vocdoni.io/davinci-sdk)
- [Protocol Documentation](https://docs.vocdoni.io)
- [Examples Repository](https://github.com/vocdoni/davinci-sdk/tree/main/examples)

### Community

- [Discord](https://discord.gg/vocdoni)
- [Telegram](https://t.me/vocdoni)
- [Twitter](https://twitter.com/vocdoni)

### Issues and Bugs

Please report issues on our [GitHub Issues](https://github.com/vocdoni/davinci-sdk/issues) page.

### Professional Support

For enterprise support and custom integrations, contact us at [support@vocdoni.io](mailto:support@vocdoni.io).

---

<div align="center">

**Built with ❤️ by the [Vocdoni](https://vocdoni.io) team**

[Website](https://vocdoni.io) • [Documentation](https://docs.vocdoni.io) • [GitHub](https://github.com/vocdoni) • [Twitter](https://twitter.com/vocdoni)

</div>
