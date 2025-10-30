# Vocdoni DaVinci SDK

[![npm version](https://badge.fury.io/js/%40vocdoni%2Fdavinci-sdk.svg)](https://badge.fury.io/js/%40vocdoni%2Fdavinci-sdk)
[![License: AGPL-3.0](https://img.shields.io/badge/License-AGPL%203.0-blue.svg)](https://www.gnu.org/licenses/agpl-3.0)
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
import { DavinciSDK, PlainCensus, WeightedCensus } from '@vocdoni/davinci-sdk';
import { Wallet } from 'ethers';

// Initialize the SDK
const wallet = new Wallet('your-private-key');
const sdk = new DavinciSDK({
  signer: wallet,
  sequencerUrl: 'https://sequencer-dev.davinci.vote',
  censusUrl: 'https://c3-dev.davinci.vote'
});

await sdk.init();

// 1. Create a census with eligible voters
const census = new PlainCensus(); // or WeightedCensus for custom voting power
census.add([
  '0x1234567890123456789012345678901234567890',
  '0x2345678901234567890123456789012345678901',
  '0x3456789012345678901234567890123456789012'
]);

// 2. Create a voting process
const process = await sdk.createProcess({
  title: "Community Decision",
  description: "Vote on our next community initiative",
  census: census,
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

// 3. Submit a vote (using one of the census participants)
const voterWallet = new Wallet('voter-private-key'); // Must be one of the census participants
const voterSdk = new DavinciSDK({
  signer: voterWallet,
  sequencerUrl: 'https://sequencer-dev.davinci.vote'
  // No censusUrl needed for voting-only operations
});
await voterSdk.init();

const vote = await voterSdk.submitVote({
  processId: process.processId,
  choices: [1] // Vote for "Tech Workshop"
});

// 4. Wait for vote confirmation
const finalStatus = await voterSdk.waitForVoteStatus(
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

- **🔒 Privacy-First**: Homomorphic encryption ensures vote privacy
- **🛡️ Secure**: Built on battle-tested cryptographic primitives
- **⚡ Easy Integration**: Simple, intuitive API for developers
- **🌐 Decentralized**: No central authority controls the voting process
- **📱 Cross-Platform**: Works in browsers, Node.js, and mobile apps
- **🔧 TypeScript**: Full type safety and excellent developer experience
- **🎯 Flexible**: Support for multiple question types and voting modes

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

## 📋 Census Management

The SDK provides simple-to-use census classes that make voter management easy. Census objects are **automatically published** when creating a process - no manual steps required!

### Census Types

#### PlainCensus - Equal Voting Power

Everyone gets the same voting weight (weight = 1).

```typescript
import { PlainCensus } from '@vocdoni/davinci-sdk';

const census = new PlainCensus();
census.add([
  '0x1234567890123456789012345678901234567890',
  '0xabcdefabcdefabcdefabcdefabcdefabcdefabcd',
  '0x9876543210987654321098765432109876543210'
]);

// Use directly in process creation - SDK auto-publishes!
const process = await sdk.createProcess({
  census: census, // ✨ Auto-published!
  // ... rest of config
});
```

#### WeightedCensus - Custom Voting Power

Assign different voting weights to participants. Supports flexible weight types: **string**, **number**, or **bigint**.

```typescript
import { WeightedCensus } from '@vocdoni/davinci-sdk';

const census = new WeightedCensus();

census.add([
  { key: '0x123...', weight: "1" },    // string
  { key: '0x456...', weight: 5 },      // number
  { key: '0x789...', weight: 100n },   // bigint
]);

// Auto-published when creating process
const process = await sdk.createProcess({
  census: census,
  // ... rest of config
});
```

#### CspCensus - Certificate Service Provider

For external authentication systems.

```typescript
import { CspCensus } from '@vocdoni/davinci-sdk';

const census = new CspCensus(
  "0x1234567890abcdef", // Root hash (public key)
  "https://csp-server.com", // CSP URL
  1000 // Expected number of voters
);

const process = await sdk.createProcess({
  census: census,
  // ... rest of config
});
```

#### PublishedCensus - Use Pre-Published Census

For censuses already published to the network.

```typescript
import { PublishedCensus, CensusType } from '@vocdoni/davinci-sdk';

const census = new PublishedCensus(
  CensusType.WEIGHTED,
  "0xroot...",
  "ipfs://uri...",
  100 // size
);

const process = await sdk.createProcess({
  census: census,
  // ... rest of config
});
```

### Auto-Publishing Feature

The SDK automatically publishes unpublished censuses when creating a process:

```typescript
const census = new PlainCensus();
census.add(['0x123...', '0x456...']);

console.log(census.isPublished); // false

// SDK automatically publishes during process creation
const process = await sdk.createProcess({
  census: census,
  // ... config
});

console.log(census.isPublished); // true ✅
console.log(census.censusRoot);   // Published root hash
console.log(census.censusURI);    // Published URI
```

### Flexible Weight Types

WeightedCensus accepts weights as strings, numbers, or bigints for maximum flexibility:

```typescript
const census = new WeightedCensus();

// String weights (recommended for very large numbers)
census.add({ key: '0x123...', weight: "999999999999" });

// Number weights (easy to use, good for reasonable values)
census.add({ key: '0x456...', weight: 100 });

// BigInt weights (for JavaScript bigint support)
census.add({ key: '0x789...', weight: 1000000n });

// Mix them all!
census.add([
  { key: '0xaaa...', weight: "1" },
  { key: '0xbbb...', weight: 5 },
  { key: '0xccc...', weight: 10n }
]);
```

### Census Operations

```typescript
const census = new WeightedCensus();

// Add single participant
census.add({ key: '0x123...', weight: 5 });

// Add multiple participants
census.add([
  { key: '0x456...', weight: 10 },
  { key: '0x789...', weight: 15 }
]);

// Remove participant
census.remove('0x123...');

// Get participant weight
const weight = census.getWeight('0x456...'); // Returns: "10"

// Get all addresses
const addresses = census.addresses; // ['0x456...', '0x789...']

// Get all participants with weights
const participants = census.participants;
// [{ key: '0x456...', weight: '10' }, { key: '0x789...', weight: '15' }]

// Check if published
if (census.isPublished) {
  console.log('Root:', census.censusRoot);
  console.log('URI:', census.censusURI);
  console.log('Size:', census.size);
}
```

### Manual Census Configuration (Advanced)

For advanced use cases, you can still provide census data manually:

```typescript
const process = await sdk.createProcess({
  census: {
    type: CensusOrigin.CensusOriginMerkleTree,
    root: "0xabc...",
    size: 100,
    uri: "ipfs://..."
  },
  // ... rest of config
});
```

## 📖 API Reference

### SDK Initialization

#### Constructor Options

```typescript
interface DavinciSDKConfig {
  signer: Signer;                    // Ethereum signer (required)
  sequencerUrl: string;              // Sequencer API URL (required)
  censusUrl?: string;                // Census API URL (optional, only needed for census creation)
  addresses?: {                      // Custom contract addresses (optional)
    processRegistry?: string;
    organizationRegistry?: string;
    stateTransitionVerifier?: string;
    resultsVerifier?: string;
    sequencerRegistry?: string;
  };
  censusProviders?: CensusProviders; // Custom census proof providers (optional)
  verifyCircuitFiles?: boolean;      // Verify downloaded circuit files (default: true)
  verifyProof?: boolean;             // Verify generated proof before submission (default: true)
}
```

**Key Points:**

- **`sequencerUrl`** (required): The Vocdoni sequencer API endpoint
  - Dev: `https://sequencer-dev.davinci.vote`
  - Staging: `https://sequencer1.davinci.vote`
  - Production: (check latest docs)

- **`censusUrl`** (optional): Only required if you're creating censuses from scratch. Not needed for voting-only operations.

- **Contract Addresses**: If not provided, the SDK automatically fetches them from the sequencer's `/info` endpoint during initialization. This is the recommended approach.

#### Basic Initialization

```typescript
import { DavinciSDK } from '@vocdoni/davinci-sdk';
import { Wallet } from 'ethers';

// Development environment
const sdk = new DavinciSDK({
  signer: new Wallet('your-private-key'),
  sequencerUrl: 'https://sequencer-dev.davinci.vote',
  censusUrl: 'https://c3-dev.davinci.vote'
});

await sdk.init();
```

**Automatic Contract Address Fetching:**

The SDK automatically fetches contract addresses from the sequencer during `init()`:

```typescript
const sdk = new DavinciSDK({
  signer: wallet,
  sequencerUrl: 'https://sequencer-dev.davinci.vote'
  // Contract addresses will be fetched automatically from sequencer
});

await sdk.init(); // Fetches and stores contract addresses
```

### Process Management

#### Creating a Process (Simple)

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

#### Creating a Process with Real-Time Status (Stream)

For applications that need to show real-time transaction progress to users, use `createProcessStream()`:

```typescript
import { TxStatus } from '@vocdoni/davinci-sdk';

const stream = sdk.createProcessStream({
  title: "Election Title",
  // ... same configuration as above
});

// Monitor transaction status in real-time
for await (const event of stream) {
  switch (event.status) {
    case TxStatus.Pending:
      console.log("📝 Transaction submitted:", event.hash);
      // Update UI to show pending state
      break;
      
    case TxStatus.Completed:
      console.log("✅ Process created:", event.response.processId);
      console.log("   Transaction:", event.response.transactionHash);
      // Update UI to show success
      break;
      
    case TxStatus.Failed:
      console.error("❌ Transaction failed:", event.error);
      // Update UI to show error
      break;
      
    case TxStatus.Reverted:
      console.error("⚠️ Transaction reverted:", event.reason);
      // Update UI to show revert reason
      break;
  }
}
```

**When to use each method:**

- Use `createProcess()` for simple scripts and when you don't need transaction progress updates
- Use `createProcessStream()` for UI applications where users need real-time feedback during transaction processing


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
    sequencerUrl: 'https://sequencer-dev.davinci.vote',
    censusUrl: 'https://c3-dev.davinci.vote'
  });
  await sdk.init();

  // 2. Create census with eligible voters
  const censusId = await sdk.api.census.createCensus();
  
  // Create voter wallets and add them to census
  const voters = [];
  for (let i = 0; i < 5; i++) {
    const voterWallet = Wallet.createRandom();
    voters.push(voterWallet);
  }
  
  const participants = voters.map(voter => ({
    key: voter.address,
    weight: "1"
  }));
  
  await sdk.api.census.addParticipants(censusId, participants);
  
  // Publish the census
  const publishResult = await sdk.api.census.publishCensus(censusId);
  const censusSize = await sdk.api.census.getCensusSize(publishResult.root);

  // 3. Create voting process
  const process = await sdk.createProcess({
    title: "Community Budget Allocation",
    description: "Decide how to allocate our community budget",
    census: {
      type: CensusOrigin.CensusOriginMerkleTree,
      root: publishResult.root,
      size: censusSize,
      uri: publishResult.uri
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

  // 4. Vote using one of the census participants
  const voterWallet = voters[0]; // Use first voter from census
  const voterSdk = new DavinciSDK({
    signer: voterWallet,
    sequencerUrl: 'https://sequencer-dev.davinci.vote'
    // No censusUrl needed for voting-only operations
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
    sequencerUrl: 'https://sequencer.davinci.vote' // Production URL
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
  sequencerUrl: 'https://your-custom-sequencer.com',
  censusUrl: 'https://your-custom-census.com',
  addresses: {
    processRegistry: '0x...',
    organizationRegistry: '0x...',
    stateTransitionVerifier: '0x...',
    resultsVerifier: '0x...'
  }
});
```

### Automatic Contract Address Fetching (Default Behavior)

By default, the SDK automatically fetches contract addresses from the sequencer's `/info` endpoint:

```typescript
const sdk = new DavinciSDK({
  signer: wallet,
  sequencerUrl: 'https://sequencer-dev.davinci.vote'
  // Contract addresses fetched automatically during init()
});

await sdk.init(); // Fetches addresses from sequencer
```

### Custom Vote Randomness

```typescript
const vote = await sdk.submitVote({
  processId: "0x...",
  choices: [1],
  randomness: "your-custom-randomness-hex"
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

This project is licensed under the GNU Affero General Public License v3.0 (AGPL-3.0) - see the [LICENSE](LICENSE) file for details.

The AGPL-3.0 is a copyleft license that requires anyone who distributes your code or a derivative work to make the source available under the same terms. If your application is a web service, users interacting with it remotely must also be able to access the source code.

## 🆘 Support

### Documentation

- [API Documentation](https://github.com/vocdoni/davinci-node/tree/main/api)
- [Protocol Documentation](https://whitepaper.vocdoni.io)
- [Examples Repository](https://github.com/vocdoni/davinci-sdk/tree/main/examples)

### Community

- [Discord](https://chat.vocdoni.io)
- [Telegram](https://t.me/vocdoni_community)
- [Twitter](https://twitter.com/vocdoni)

### Issues and Bugs

Please report issues on our [GitHub Issues](https://github.com/vocdoni/davinci-sdk/issues) page.

### Professional Support

For enterprise support and custom integrations, contact us at [info@vocdoni.io](mailto:info@vocdoni.io).

---

<div align="center">

**Built with ❤️ by the [Vocdoni](https://vocdoni.io) team**

[Website](https://vocdoni.io) • [Documentation](https://docs.vocdoni.io) • [GitHub](https://github.com/vocdoni) • [Twitter](https://twitter.com/vocdoni)

</div>
