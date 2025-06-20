# Vocdoni Davinci SDK - UI Example

A comprehensive demo application showcasing the capabilities of the Vocdoni Davinci SDK. This Next.js application demonstrates how to create organizations, manage censuses, create voting processes, and handle the complete voting lifecycle using the Vocdoni protocol.

## Features

- **Organization Management**: Create and manage organizations on the Vocdoni network
- **Census Creation**: Build voter lists with wallet addresses
- **Election Creation**: Set up voting processes with custom questions and options
- **Voting Interface**: Cast votes using zero-knowledge proofs
- **Results Display**: View election results and statistics
- **Wallet Integration**: Connect with MetaMask and other Ethereum wallets
- **Real-time Updates**: Track transaction status and election progress

## Prerequisites

Before running this application, make sure you have:

- **Node.js** (version 18 or higher)
- **Yarn** package manager
- **MetaMask** or another Ethereum wallet browser extension
- **Sepolia testnet ETH** for transaction fees

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
# Vocdoni API endpoint
API_URL=

# Sepolia RPC endpoint
SEPOLIA_RPC=
```

#### Environment Variables

- **API_URL**: The Vocdoni sequencer API endpoint
  
- **SEPOLIA_RPC**: Ethereum Sepolia testnet RPC endpoint
  - You can use public endpoints or get your own from providers like:
    - [Infura](https://infura.io/)
    - [Alchemy](https://www.alchemy.com/)
    - [QuickNode](https://www.quicknode.com/)

## Running the Application

### Development Mode

Start the development server:

```bash
yarn dev
```

The application will be available at [http://localhost:3000](http://localhost:3000)

### Production Build

Build the application for production:

```bash
yarn build
```

Start the production server:

```bash
yarn start
```

## Usage Guide

### 1. Welcome Screen
- Introduction to the Vocdoni Davinci SDK
- Overview of the demo workflow

### 2. Connect Wallet
- Connect your MetaMask or compatible Ethereum wallet
- Ensure you're connected to the Sepolia testnet
- Make sure you have some Sepolia ETH for transaction fees

### 3. Create Organization
- Create a new organization on the Vocdoni network
- This organization will manage your voting processes
- Transaction will be submitted to Ethereum Sepolia testnet

### 4. Create Census
- Build a list of eligible voters
- Add wallet addresses manually or generate random test wallets
- The census determines who can participate in your elections

### 5. Create Election
- Set up your voting process
- Configure election metadata (title, description)
- Define voting questions and options
- Set election duration and parameters

### 6. Check Election Status
- Monitor your election's status
- View election details and configuration
- Confirm the election is ready for voting

### 7. Vote
- Cast your vote using zero-knowledge proofs
- Select your preferred options
- Submit your encrypted ballot

### 8. End Process
- Close the voting process when ready
- Trigger the final tally and result computation

### 9. Show Results
- View the final election results
- See vote counts and statistics
- Verify the integrity of the voting process

## Project Structure

```
src/
├── app/                    # Next.js app directory
│   ├── layout.tsx         # Root layout component
│   ├── page.tsx           # Main application page
│   └── globals.css        # Global styles
├── components/            # React components
│   ├── layout/           # Layout components
│   ├── *Screen.tsx       # Step-by-step screens
│   └── StepIndicator.tsx # Progress indicator
├── context/              # React context providers
│   └── WalletContext.tsx # Wallet state management
└── types/                # TypeScript type definitions
```

## Key Components

- **WelcomeScreen**: Introduction and overview
- **ConnectWalletScreen**: Wallet connection interface
- **CreateOrganizationScreen**: Organization creation form
- **CensusCreationScreen**: Voter list management
- **CreateElectionScreen**: Election configuration
- **VotingScreen**: Voting interface with zero-knowledge proofs
- **ShowResultsScreen**: Results display and verification

## Troubleshooting

### Common Issues

1. **404 Error on Development Server**
   - Make sure you're accessing `http://localhost:3000` (not `/davinci-sdk`)
   - The basePath is only applied in production builds

2. **Wallet Connection Issues**
   - Ensure MetaMask is installed and unlocked
   - Switch to Sepolia testnet in MetaMask
   - Check that you have Sepolia ETH for transaction fees

3. **Transaction Failures**
   - Verify you have sufficient Sepolia ETH
   - Check that the RPC endpoint is working
   - Ensure you're connected to the correct network

4. **SDK Build Issues**
   - Try removing `node_modules` and `davinci-sdk.tgz`
   - Run `yarn install` again to rebuild the SDK

### Getting Sepolia ETH

You can get free Sepolia ETH from these faucets:
- [Sepolia Faucet](https://sepoliafaucet.com/)
- [Alchemy Sepolia Faucet](https://sepoliafaucet.com/)
- [Infura Sepolia Faucet](https://www.infura.io/faucet/sepolia)

## Development

### Adding New Features

1. Create new components in `src/components/`
2. Add new steps to the main workflow in `page.tsx`
3. Update the step indicator and navigation logic
4. Test with the development server

### Customization

- Modify the theme in `page.tsx` to change colors and styling
- Update component layouts and designs
- Add new voting question types or election configurations
- Integrate additional wallet providers

## Learn More

- [Vocdoni Documentation](https://docs.vocdoni.io/)
- [Davinci SDK Documentation](https://github.com/vocdoni/davinci-sdk)
- [Next.js Documentation](https://nextjs.org/docs)
- [Material-UI Documentation](https://mui.com/)

## Support

For issues and questions:
- Check the [GitHub Issues](https://github.com/vocdoni/davinci-sdk/issues)
- Join the [Vocdoni Discord](https://discord.gg/vocdoni)
- Read the [Vocdoni Documentation](https://docs.vocdoni.io/)
