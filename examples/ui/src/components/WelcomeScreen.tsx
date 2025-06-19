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
  ListItemIcon,
  Alert,
  Link,
  Tooltip,
} from '@mui/material';
import RefreshIcon from '@mui/icons-material/Refresh';
import CheckCircleIcon from '@mui/icons-material/CheckCircle';
import ErrorIcon from '@mui/icons-material/Error';
import { VocdoniApiService } from '@vocdoni/davinci-sdk';
import { deployedAddresses } from '@vocdoni/davinci-sdk';

interface WelcomeScreenProps {
  onNext: () => void;
}

export default function WelcomeScreen({ onNext }: WelcomeScreenProps) {
  const [isConnected, setIsConnected] = useState<boolean>(false);
  const [isLoading, setIsLoading] = useState<boolean>(true);
  const [error, setError] = useState<string>('');
  const [apiAddresses, setApiAddresses] = useState<{
    process: string;
    organization: string;
  } | null>(null);

  useEffect(() => {
    checkConnection();
  }, []);

  const checkConnection = async () => {
    try {
      setIsLoading(true);
      setError('');
      const api = new VocdoniApiService(process.env.API_URL || '');
      await api.ping();
      const info = await api.getInfo();
      setApiAddresses({
        process: info.contracts.process.toLowerCase(),
        organization: info.contracts.organization.toLowerCase()
      });
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
            <Box>
              <Alert severity="error" sx={{ mb: 2 }}>
                {error}
              </Alert>
              <Button
                variant="outlined"
                color="primary"
                onClick={checkConnection}
                startIcon={<RefreshIcon />}
                disabled={isLoading}
              >
                Retry Connection
              </Button>
            </Box>
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
              <Tooltip title={
                apiAddresses && apiAddresses.organization === deployedAddresses.organizationRegistry.sepolia.toLowerCase() ?
                "Contract address verified" :
                "Contract address mismatch between SDK and API"
              }>
                <ListItemIcon>
                  {apiAddresses ? (
                    apiAddresses.organization === deployedAddresses.organizationRegistry.sepolia.toLowerCase() ? (
                      <CheckCircleIcon color="success" />
                    ) : (
                      <ErrorIcon color="error" />
                    )
                  ) : (
                    <CircularProgress size={24} />
                  )}
                </ListItemIcon>
              </Tooltip>
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
              <Tooltip title={
                apiAddresses && apiAddresses.process === deployedAddresses.processRegistry.sepolia.toLowerCase() ?
                "Contract address verified" :
                "Contract address mismatch between SDK and API"
              }>
                <ListItemIcon>
                  {apiAddresses ? (
                    apiAddresses.process === deployedAddresses.processRegistry.sepolia.toLowerCase() ? (
                      <CheckCircleIcon color="success" />
                    ) : (
                      <ErrorIcon color="error" />
                    )
                  ) : (
                    <CircularProgress size={24} />
                  )}
                </ListItemIcon>
              </Tooltip>
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

      {apiAddresses && (
        apiAddresses.process !== deployedAddresses.processRegistry.sepolia.toLowerCase() ||
        apiAddresses.organization !== deployedAddresses.organizationRegistry.sepolia.toLowerCase()
      ) ? (
        <Alert severity="error" sx={{ mb: 2 }}>
          Contract addresses mismatch between SDK and API. Please check the configuration.
        </Alert>
      ) : null}

      <Button
        variant="contained"
        color="primary"
        size="large"
        disabled={
          !isConnected || 
          isLoading || 
          Boolean(apiAddresses && (
            apiAddresses.process !== deployedAddresses.processRegistry.sepolia.toLowerCase() ||
            apiAddresses.organization !== deployedAddresses.organizationRegistry.sepolia.toLowerCase()
          ))
        }
        onClick={onNext}
        endIcon={isLoading ? <CircularProgress size={20} color="inherit" /> : null}
      >
        {isLoading ? 'Checking Connection...' : 'Next'}
      </Button>
    </Box>
  );
}
