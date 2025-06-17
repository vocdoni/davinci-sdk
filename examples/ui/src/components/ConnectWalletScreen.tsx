import { useState } from 'react';
import {
  Box,
  Typography,
  Button,
} from '@mui/material';
import { BrowserProvider, Wallet, JsonRpcSigner } from 'ethers';
import WalletConnect from './WalletConnect';

interface ConnectWalletScreenProps {
  onBack: () => void;
  onNext: () => void;
  onWalletConnected: (wallet: Wallet | JsonRpcSigner) => void;
}

export default function ConnectWalletScreen({ onBack, onNext, onWalletConnected }: ConnectWalletScreenProps) {
  const [wallet, setWallet] = useState<Wallet | JsonRpcSigner | null>(null);

  const handleWalletConnected = async (connectedWallet: Wallet | JsonRpcSigner) => {
    setWallet(connectedWallet);
    onWalletConnected(connectedWallet);
  };

  return (
    <Box sx={{ maxWidth: 800, mx: 'auto', textAlign: 'center' }}>
      <Typography variant="h4" component="h1" gutterBottom>
        Connect Your Wallet
      </Typography>

      <Typography variant="body1" color="text.secondary" paragraph sx={{ mb: 4 }}>
        Connect your wallet to interact with the Vocdoni voting protocol. You can use MetaMask 
        or enter your private key directly. Make sure you have some Sepolia ETH to proceed.
      </Typography>

      <WalletConnect onWalletConnected={handleWalletConnected} />

      <Box sx={{ mt: 4, display: 'flex', gap: 2, justifyContent: 'center' }}>
        <Button
          variant="outlined"
          color="primary"
          onClick={onBack}
        >
          Back
        </Button>
        <Button
          variant="contained"
          color="primary"
          disabled={!wallet}
          onClick={onNext}
        >
          Next
        </Button>
      </Box>
    </Box>
  );
}
