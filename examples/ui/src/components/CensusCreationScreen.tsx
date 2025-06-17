import { useState } from 'react';
import { useWallets } from '@/context/WalletContext';
import {
  Box,
  Button,
  Typography,
  Card,
  CardContent,
  List,
  ListItem,
  ListItemText,
  IconButton,
  TextField,
  Alert,
  CircularProgress,
  Tooltip,
} from '@mui/material';
import { Wallet } from 'ethers';
import { VocdoniApiService } from '@vocdoni/davinci-sdk';
import DeleteIcon from '@mui/icons-material/Delete';
import AddIcon from '@mui/icons-material/Add';
import RefreshIcon from '@mui/icons-material/Refresh';
import ContentCopyIcon from '@mui/icons-material/ContentCopy';

interface CensusCreationScreenProps {
  onBack: () => void;
  onNext: (censusId: string) => void;
}

export default function CensusCreationScreen({ onBack, onNext }: CensusCreationScreenProps) {
  const [addresses, setAddresses] = useState<string[]>([]);
  const { walletMap, setWalletMap } = useWallets();
  const [newAddress, setNewAddress] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState(false);
  const [censusCreated, setCensusCreated] = useState(false);
  const [progress, setProgress] = useState(0);
  const [censusId, setCensusId] = useState<string | null>(null);

  const generateRandomWallets = () => {
    const newWallets = Array.from({ length: 10 }, () => Wallet.createRandom());
    const newAddresses = newWallets.map(w => w.address);
    setAddresses(newAddresses);
    setWalletMap(Object.fromEntries(newWallets.map(w => [w.address, new Wallet(w.privateKey)])));
  };

  const handleAddAddress = () => {
    if (!newAddress.match(/^0x[a-fA-F0-9]{40}$/)) {
      setError('Invalid Ethereum address format');
      return;
    }
    if (addresses.includes(newAddress)) {
      setError('Address already in the list');
      return;
    }
    setAddresses([...addresses, newAddress]);
    setNewAddress('');
    setError(null);
  };

  const handleRemoveAddress = (address: string) => {
    setAddresses(addresses.filter(w => w !== address));
    const newWalletMap = { ...walletMap };
    delete newWalletMap[address];
    setWalletMap(newWalletMap);
  };

  const handleCopyAddress = (address: string) => {
    navigator.clipboard.writeText(address);
  };

  const handleCreateCensus = async () => {
    if (addresses.length === 0) {
      setError('Add at least one address to create a census');
      return;
    }

    try {
      setIsLoading(true);
      setError(null);
      setProgress(0);

      const api = new VocdoniApiService(process.env.API_URL || '');
      
      // Create census
      setProgress(20);
      const newCensusId = await api.createCensus();
      setCensusId(newCensusId);
      
      // Add voters in batches
      const batchSize = Math.ceil(addresses.length / 4); // Split into 4 parts for progress
      for (let i = 0; i < addresses.length; i += batchSize) {
        const batch = addresses.slice(i, i + batchSize);
        
        // Add participants using addresses
        await api.addParticipants(newCensusId, batch.map(address => ({
          key: address,
          weight: "1" // All voters have equal weight
        })));
        setProgress(40 + Math.floor((i / addresses.length) * 40));
      }

      // Verify participants were stored
      setProgress(80);
      const storedParticipants = await api.getParticipants(newCensusId);
      if (storedParticipants.length !== addresses.length) {
        throw new Error('Not all participants were stored in the census');
      }


      setProgress(100);
      setCensusCreated(true);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to create census');
      console.error('Error creating census:', err);
    } finally {
      setIsLoading(false);
    }
  };

  return (
    <Box sx={{ maxWidth: 800, mx: 'auto', textAlign: 'center' }}>
      <Typography variant="h4" component="h1" gutterBottom>
        Create Census
      </Typography>

      <Typography variant="body1" color="text.secondary" paragraph sx={{ mb: 4 }}>
        Create a census by adding wallet addresses that will be allowed to vote. You can use the randomly generated addresses or add your own.
      </Typography>

      <Card sx={{ mb: 4 }}>
        <CardContent>
          <Box sx={{ mb: 3, display: 'flex', gap: 2, justifyContent: 'center' }}>
            <Button
              variant="contained"
              onClick={generateRandomWallets}
              startIcon={<RefreshIcon />}
              disabled={isLoading}
            >
              Generate 10 Random Wallets
            </Button>
            <Button
              variant="contained"
              onClick={handleCreateCensus}
              disabled={addresses.length === 0 || isLoading || censusCreated}
            >
              Create Census
            </Button>
          </Box>

          <Box sx={{ mb: 3, display: 'flex', gap: 1 }}>
            <TextField
              fullWidth
              label="Add Ethereum Address"
              variant="outlined"
              value={newAddress}
              onChange={(e) => setNewAddress(e.target.value)}
              disabled={isLoading || censusCreated}
              placeholder="0x..."
            />
            <Button
              variant="contained"
              onClick={handleAddAddress}
              disabled={!newAddress || isLoading || censusCreated}
              startIcon={<AddIcon />}
            >
              Add
            </Button>
          </Box>

          {error && (
            <Alert severity="error" sx={{ mb: 2 }}>
              {error}
            </Alert>
          )}

          {isLoading && (
            <Box sx={{ mb: 2, textAlign: 'center' }}>
              <CircularProgress variant="determinate" value={progress} sx={{ mb: 1 }} />
              <Typography variant="body2" color="text.secondary">
                Creating census... {progress}%
              </Typography>
            </Box>
          )}

          {censusCreated && (
            <Alert severity="success" sx={{ mb: 2 }}>
              Census created successfully!
            </Alert>
          )}

          <List>
            {addresses.map((address, index) => (
              <ListItem
                key={address}
                secondaryAction={
                  !censusCreated && (
                    <IconButton 
                      edge="end" 
                      aria-label="delete"
                      onClick={() => handleRemoveAddress(address)}
                    >
                      <DeleteIcon />
                    </IconButton>
                  )
                }
              >
                <ListItemText
                  primary={
                    <Box sx={{ display: 'flex', alignItems: 'center', gap: 1 }}>
                      <Typography variant="body2" sx={{ wordBreak: 'break-all' }}>
                        {`${index + 1}. ${address}`}
                      </Typography>
                      <Tooltip title="Copy address">
                        <IconButton 
                          size="small"
                          onClick={() => handleCopyAddress(address)}
                        >
                          <ContentCopyIcon fontSize="small" />
                        </IconButton>
                      </Tooltip>
                    </Box>
                  }
                />
              </ListItem>
            ))}
          </List>
        </CardContent>
      </Card>

      <Box sx={{ display: 'flex', gap: 2, justifyContent: 'center' }}>
        <Button
          variant="outlined"
          onClick={onBack}
          disabled={isLoading}
        >
          Back
        </Button>
        <Button
          variant="contained"
          onClick={() => censusId && onNext(censusId)}
          disabled={!censusCreated || !censusId}
        >
          Next
        </Button>
      </Box>
    </Box>
  );
}
