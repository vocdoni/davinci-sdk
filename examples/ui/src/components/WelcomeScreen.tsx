import { useState, useEffect } from 'react';
import {
  Box,
  Button,
  Card,
  CardContent,
  CircularProgress,
  Typography,
  List,
  ListItem,
  ListItemText,
  Alert,
  Link,
} from '@mui/material';
import { VocdoniApiService } from '@vocdoni/davinci-sdk';
import { deployedAddresses } from '@vocdoni/davinci-sdk';

export default function WelcomeScreen() {
  const [isConnected, setIsConnected] = useState<boolean>(false);
  const [isLoading, setIsLoading] = useState<boolean>(true);
  const [error, setError] = useState<string>('');

  useEffect(() => {
    checkConnection();
  }, []);

  const checkConnection = async () => {
    try {
      setIsLoading(true);
      setError('');
      const api = new VocdoniApiService(process.env.API_URL || '');
      await api.ping();
      setIsConnected(true);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to connect to API');
      setIsConnected(false);
    } finally {
      setIsLoading(false);
    }
  };

  return (
    <Box sx={{ maxWidth: 800, mx: 'auto', textAlign: 'center' }}>
      <Typography variant="h4" component="h1" gutterBottom>
        Welcome to DAVINCI Demo
      </Typography>

      <Typography variant="h6" color="primary" gutterBottom sx={{ fontStyle: 'italic' }}>
        Decentralized Autonomous Vote Integrity Network with Cryptographic Inference
      </Typography>
      
      <Typography variant="body1" color="text.secondary" paragraph sx={{ mb: 4 }}>
        DAVINCI is a voting protocol designed for mass adoption, privacy, and security. 
        It enables high-frequency, low-cost elections while ensuring transparency, 
        censorship resistance, anticoercion and integrity.
      </Typography>

      <Card sx={{ mb: 4 }}>
        <CardContent>
          <Typography variant="h6" gutterBottom>
            Connection Status
          </Typography>
          
          {isLoading ? (
            <Box sx={{ display: 'flex', justifyContent: 'center', my: 2 }}>
              <CircularProgress />
            </Box>
          ) : error ? (
            <Alert severity="error" sx={{ mb: 2 }}>
              {error}
            </Alert>
          ) : isConnected ? (
            <Alert severity="success" sx={{ mb: 2 }}>
              Connected to Vocdoni API
            </Alert>
          ) : null}

          <Typography variant="h6" gutterBottom sx={{ mt: 3 }}>
            Network Information
          </Typography>
          
          <List>
            <ListItem>
              <ListItemText 
                primary="Network" 
                secondary="Sepolia Testnet" 
              />
            </ListItem>
            <ListItem>
              <ListItemText 
                primary="Organization Registry Contract" 
                secondary={
                  <Link 
                    href={`https://sepolia.etherscan.io/address/${deployedAddresses.organizationRegistry.sepolia}`}
                    target="_blank"
                    rel="noopener noreferrer"
                    color="primary"
                  >
                    {deployedAddresses.organizationRegistry.sepolia}
                  </Link>
                }
              />
            </ListItem>
            <ListItem>
              <ListItemText 
                primary="Process Registry Contract" 
                secondary={
                  <Link 
                    href={`https://sepolia.etherscan.io/address/${deployedAddresses.processRegistry.sepolia}`}
                    target="_blank"
                    rel="noopener noreferrer"
                    color="primary"
                  >
                    {deployedAddresses.processRegistry.sepolia}
                  </Link>
                }
              />
            </ListItem>
          </List>
        </CardContent>
      </Card>

      <Button
        variant="contained"
        color="primary"
        size="large"
        disabled={!isConnected || isLoading}
        onClick={() => {/* Handle navigation to next step */}}
      >
        Next
      </Button>
    </Box>
  );
}
