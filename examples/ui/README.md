# Vocdoni Davinci SDK - UI Example

A comprehensive demo application showcasing the capabilities of the Vocdoni Davinci SDK. This Vite React application demonstrates how to create censuses, set up voting processes, cast votes, and view results using the Vocdoni protocol.

## Features

- **Census Creation**: Generate voter lists with random wallet addresses
- **Election Creation**: Set up voting processes with custom questions and options  
- **Voting Interface**: Cast votes using zero-knowledge proofs with generated wallets
- **Results Display**: View election results and statistics
- **Step-by-Step Workflow**: Guided process from census creation to final results
- **Real-time Updates**: Track vote status and election progress
- **Vote Status Monitoring**: Wait for votes to be settled before proceeding

## Prerequisites

Before running this application, make sure you have:

- **Node.js** (version 18 or higher)
- **Yarn** package manager
- **Sepolia testnet access** via RPC endpoint

## Installation

### 1. Clone the Repository

```bash
git clone <repository-url>
cd davinci-sdk/examples/ui
```

### 2. Install Dependencies

The project uses a local build of the Davinci SDK. The installation process will automatically build and package the SDK:

```bash
yarn install
```

This will:
- Build the Davinci SDK from the root directory
- Package it as a tarball
- Install it along with other dependencies

### 3. Environment Configuration

Copy the example environment file and configure it:

```bash
cp .env.example .env
```

Edit the `.env` file with your configuration:

```env
# Vocdoni Sequencer API endpoint
SEQUENCER_API_URL=

# Vocdoni Census API endpoint  
CENSUS_API_URL=

# Ethereum RPC endpoint (for blockchain interactions)
RPC_URL=

# Explorer URL for viewing addresses, transactions and contracts
EXPLORER_URL=https://sepolia.etherscan.io

# Optional: Custom contract addresses (if not provided, will use default deployed addresses)
ORGANIZATION_REGISTRY_ADDRESS=
PROCESS_REGISTRY_ADDRESS=

# Force using contract addresses from sequencer info endpoint (default: false)
FORCE_SEQUENCER_ADDRESSES=false
```

#### Environment Variables

- **SEQUENCER_API_URL**: The Vocdoni sequencer API endpoint
- **CENSUS_API_URL**: The Vocdoni census API endpoint
- **RPC_URL**: Ethereum RPC endpoint for blockchain interactions
  - You can use public endpoints or get your own from providers like:
    - [Infura](https://infura.io/)
    - [Alchemy](https://www.alchemy.com/)
    - [QuickNode](https://www.quicknode.com/)
- **EXPLORER_URL**: Block explorer URL for viewing transactions
- **ORGANIZATION_REGISTRY_ADDRESS** (Optional): Custom organization registry contract address
- **PROCESS_REGISTRY_ADDRESS** (Optional): Custom process registry contract address
- **FORCE_SEQUENCER_ADDRESSES** (Optional): Use contract addresses from sequencer info endpoint

## Running the Application

### Development Mode

Start the development server:

```bash
yarn dev
```

The application will be available at [http://localhost:5173](http://localhost:5173)

### Production Build

Build the application for production:

```bash
yarn build
```

Preview the production build:

```bash
yarn preview
```

## Usage Guide

The application follows a step-by-step workflow:

### 1. Welcome Screen
- Introduction to the Vocdoni Davinci SDK demo
- Overview of the complete voting workflow

### 2. Connect Wallet  
- Connect your Ethereum wallet (MetaMask or similar)
- Ensure you're connected to Sepolia testnet
- This wallet will be used for creating elections (not for voting)

### 3. Create Census
- Generate a list of voter wallets automatically
- 10 random wallets are created by default
- Add additional random wallets as needed
- Each wallet gets a private key for voting later
- Publish the census to make it ready for elections

### 4. Create Election
- Configure election details (title, description, end date)
- Define voting questions and answer choices
- Set ballot parameters (number of fields, value ranges)
- Create the process on-chain using DavinciSDK

### 5. Check Election Status
- Verify the election was created successfully
- View transaction details on block explorer
- Confirm the process is ready to accept votes

### 6. Voting Interface
- Select from the generated voter wallets
- Answer each question by choosing from available options
- Submit votes using zero-knowledge proofs
- Track vote status in real-time (pending → verified → settled)
- **Important**: Must wait for all votes to reach "settled" status before proceeding

### 7. End Process & Show Results
- View final election results with vote counts
- See percentage breakdown for each choice
- Results are fetched directly from the blockchain

## Key Technical Details

### Vote Choice Format
The application uses a specific format for vote choices that matches the Vocdoni protocol:
- Each question becomes an array filled with 0s
- A 1 is placed at the index of the selected choice
- All question arrays are flattened into a single choices array

Example: For 2 questions with 4 choices each, selecting choice 1 for question 1 and choice 2 for question 2:
```
Question 1: [0, 1, 0, 0]  // Selected choice 1
Question 2: [0, 0, 1, 0]  // Selected choice 2
Final: [0, 1, 0, 0, 0, 0, 1, 0]
```

### Vote Status Flow
- **Pending**: Vote submitted, waiting for verification
- **Verified**: Vote verified by the sequencer
- **Aggregated**: Vote included in batch processing  
- **Settled**: Vote fully processed and finalized ✅

The UI requires ALL votes to reach "settled" status before allowing progression to results.

### Generated Wallets
- The application generates random wallets for voting (not organization management)
- Each wallet gets a private key displayed in the UI
- Wallets are automatically connected to the configured RPC provider
- The organizing wallet (MetaMask) is only used for creating elections

## Project Structure

```
src/
├── main.tsx              # Application entry point
├── router.tsx            # React Router configuration  
├── globals.css           # Global styles
├── components/           # React components
│   ├── layout/          # Layout components (Header, Footer, Layout)
│   ├── WelcomeScreen.tsx
│   ├── ConnectWalletScreen.tsx
│   ├── CensusCreationScreen.tsx
│   ├── CreateElectionScreen.tsx
│   ├── CheckElectionScreen.tsx
│   ├── VotingScreen.tsx
│   ├── EndProcessScreen.tsx
│   ├── ShowResultsScreen.tsx
│   ├── StepIndicator.tsx
│   └── WalletConnect.tsx
├── context/             # React context providers
│   └── WalletContext.tsx
├── pages/               # Page components
├── utils/               # Utility functions
└── window.d.ts          # TypeScript declarations
```

## Architecture

### DavinciSDK Integration
All screens now exclusively use the DavinciSDK for operations:

- **Census Operations**: `sdk.api.census.createCensus()`, `sdk.api.census.addParticipants()`
- **Process Creation**: `sdk.createProcess()`  
- **Voting**: `sdk.submitVote()`, `sdk.getVoteStatus()`
- **Results**: `sdk.getProcess()` (includes results)

### Wallet Provider Handling
The application properly handles different wallet scenarios:
- **MetaMask/Browser Wallets**: Uses existing provider
- **Generated Wallets**: Connects to RPC provider from environment

### State Management
- **WalletContext**: Manages generated voter wallets
- **localStorage**: Persists census and election details between steps
- **React State**: Handles component-level state and loading states

## Troubleshooting

### Common Issues

1. **RPC Connection Issues**
   - Verify RPC_URL is set correctly in `.env`
   - Ensure the RPC endpoint is accessible
   - Check network connectivity

2. **Vote Status Not Updating**  
   - Votes need time to be processed by the sequencer
   - The UI polls every 2 seconds for status updates
   - Wait for "settled" status before proceeding

3. **Transaction Failures**
   - Ensure the organizing wallet has Sepolia ETH
   - Check that contract addresses are correct
   - Verify sequencer APIs are accessible

4. **SDK Build Issues**
   - Remove `node_modules` and `davinci-sdk.tgz`
   - Run `yarn install` to rebuild the SDK
   - Ensure the parent SDK builds successfully

5. **Environment Variable Issues**
   - Double-check all required variables are set
   - Restart the dev server after changing `.env`
   - Verify API endpoints are reachable

### Getting Sepolia ETH

The organizing wallet needs Sepolia ETH for creating elections:
- [Sepolia Faucet](https://sepoliafaucet.com/)
- [Alchemy Sepolia Faucet](https://sepoliafaucet.com/)
- [Infura Sepolia Faucet](https://www.infura.io/faucet/sepolia)

### Vote Status Meanings

- **pending**: Vote submitted to sequencer
- **verified**: Vote cryptographically verified
- **aggregated**: Vote included in processing batch
- **processed**: Vote processed by sequencer  
- **settled**: Vote finalized on blockchain ✅
- **error**: Vote processing failed ❌

## Development

### Technology Stack
- **Vite**: Build tool and dev server
- **React 19**: UI framework
- **TypeScript**: Type safety
- **Material-UI**: Component library
- **React Router**: Client-side routing
- **Ethers.js**: Ethereum interactions (via DavinciSDK)

### Adding New Features

1. Create new components in `src/components/`
2. Update routing in `src/router.tsx`
3. Add new steps to the StepIndicator component
4. Update navigation logic between screens

### Customization

- Modify themes and styling in component files
- Add new question types in CreateElectionScreen
- Customize vote status display in VotingScreen
- Add new result visualizations in ShowResultsScreen

## Learn More

- [Vocdoni Documentation](https://docs.vocdoni.io/)
- [DaVinci SDK Documentation](https://github.com/vocdoni/davinci-sdk)
- [API Documentation](https://github.com/vocdoni/davinci-node/tree/main/api)
- [Protocol Documentation](https://whitepaper.vocdoni.io)
- [Vite Documentation](https://vite.dev/)
- [React Documentation](https://react.dev/)
- [Material-UI Documentation](https://mui.com/)

## Support

For issues and questions:
- Check the [GitHub Issues](https://github.com/vocdoni/davinci-sdk/issues)
- Join the [Vocdoni Discord](https://chat.vocdoni.io)
- Join our [Telegram](https://t.me/vocdoni_community)
- Follow us on [Twitter](https://twitter.com/vocdoni)
- Read the [Vocdoni Documentation](https://docs.vocdoni.io/)
- Visit our [Website](https://vocdoni.io)

For enterprise support and custom integrations, contact us at [info@vocdoni.io](mailto:info@vocdoni.io).
