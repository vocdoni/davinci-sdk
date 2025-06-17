import { useState } from 'react';
import {
  Box,
  Button,
  TextField,
  Typography,
  Alert,
  CircularProgress,
  Card,
  CardContent,
  Link,
} from '@mui/material';
import { Wallet, JsonRpcSigner } from 'ethers';
import { OrganizationRegistryService, SmartContractService, deployedAddresses, TxStatus } from '@vocdoni/davinci-sdk';

interface CreateOrganizationScreenProps {
  onBack: () => void;
  onNext: () => void;
  wallet: Wallet | JsonRpcSigner;
}

export default function CreateOrganizationScreen({ onBack, onNext, wallet }: CreateOrganizationScreenProps) {
  const [orgName, setOrgName] = useState('');
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState(false);
  const [orgId, setOrgId] = useState<string | null>(null);
  const [txHash, setTxHash] = useState<string | null>(null);
  const [txStatus, setTxStatus] = useState<string>('');

  const handleCreateOrganization = async () => {
    if (!orgName.trim()) {
      setError('Organization name is required');
      return;
    }

    try {
      setIsLoading(true);
      setError(null);

      const orgService = new OrganizationRegistryService(
        deployedAddresses.organizationRegistry.sepolia,
        wallet
      );

      const newOrgId = Wallet.createRandom().address;
      const orgMeta = `ipfs://org-meta-${Date.now()}`;

      const walletAddress = await wallet.getAddress();

      const txGenerator = orgService.createOrganization(newOrgId, orgName, orgMeta, [walletAddress]);

      for await (const status of txGenerator) {
        if (status.status === TxStatus.Pending) {
          setTxStatus('Transaction pending...');
          setTxHash(status.hash);
        } else if (status.status === TxStatus.Completed) {
          setTxStatus('Transaction confirmed!');
          setSuccess(true);
          setOrgId(newOrgId);
          localStorage.setItem('organizationId', newOrgId);
          break;
        } else if (status.status === TxStatus.Failed) {
          throw new Error('Transaction failed');
        } else if (status.status === TxStatus.Reverted) {
          throw new Error('Transaction reverted');
        }
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to create organization');
      console.error('Error creating organization:', err);
    } finally {
      setIsLoading(false);
    }
  };

  return (
    <Box sx={{ maxWidth: 800, mx: 'auto', textAlign: 'center' }}>
      <Typography variant="h4" component="h1" gutterBottom>
        Create Organization
      </Typography>

      <Typography variant="body1" color="text.secondary" paragraph sx={{ mb: 4 }}>
        Create a new organization on the Vocdoni network. This organization will be used to manage your voting processes.
      </Typography>

      <Card sx={{ mb: 4 }}>
        <CardContent>
          <TextField
            fullWidth
            label="Organization Name"
            variant="outlined"
            value={orgName}
            onChange={(e) => setOrgName(e.target.value)}
            disabled={isLoading || success}
            required
            sx={{ mb: 3 }}
          />

          {error && (
            <Alert severity="error" sx={{ mb: 2 }}>
              {error}
            </Alert>
          )}

          {txHash && !success && (
            <Alert 
              severity="info" 
              sx={{ 
                mb: 2,
                '& .MuiAlert-message': {
                  width: '100%'
                }
              }}
            >
              <Box sx={{ textAlign: 'center' }}>
                <Box sx={{ display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 1 }}>
                  <Typography variant="body2">
                    {txStatus}
                  </Typography>
                  <CircularProgress size={16} />
                </Box>
                <Box sx={{ mt: 1 }}>
                  <Link
                    href={`https://sepolia.etherscan.io/tx/${txHash}`}
                    target="_blank"
                    rel="noopener noreferrer"
                    color="primary"
                    sx={{ display: 'inline-block' }}
                  >
                    View transaction status on Etherscan
                  </Link>
                </Box>
              </Box>
            </Alert>
          )}

          {success && orgId && (
            <Alert 
              severity="success" 
              sx={{ 
                mb: 2,
                '& .MuiAlert-message': {
                  width: '100%'
                }
              }}
            >
              <Box sx={{ textAlign: 'center' }}>
                <Typography variant="body1" sx={{ fontWeight: 'bold', mb: 1 }}>
                  Organization created successfully!
                </Typography>
                <Box sx={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 1 }}>
                  <Typography variant="body2" sx={{ wordBreak: 'break-all' }}>
                    <strong>Organization ID:</strong> {orgId}
                  </Typography>
                  <Link
                    href={`https://sepolia.etherscan.io/tx/${txHash}`}
                    target="_blank"
                    rel="noopener noreferrer"
                    color="primary"
                    sx={{ display: 'inline-block' }}
                  >
                    View transaction details
                  </Link>
                </Box>
              </Box>
            </Alert>
          )}

          {isLoading && !txHash && (
            <Box sx={{ display: 'flex', justifyContent: 'center', my: 2 }}>
              <CircularProgress />
            </Box>
          )}
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
        {!success ? (
          <Button
            variant="contained"
            onClick={handleCreateOrganization}
            disabled={isLoading || !orgName.trim()}
          >
            Create Organization
          </Button>
        ) : (
          <Button
            variant="contained"
            onClick={onNext}
          >
            Next
          </Button>
        )}
      </Box>
    </Box>
  );
}
