import { useState, useEffect } from 'react';
import {
  Box,
  Button,
  Typography,
  Card,
  CardContent,
  Alert,
  CircularProgress,
  List,
  ListItem,
  ListItemIcon,
  ListItemText,
  Link,
} from '@mui/material';
import CheckCircleIcon from '@mui/icons-material/CheckCircle';
import PendingIcon from '@mui/icons-material/Pending';
import { 
  ProcessRegistryService,
  ProcessStatus,
  SmartContractService,
  TxStatus
} from '@vocdoni/davinci-sdk';
import { Wallet, JsonRpcSigner } from 'ethers';
import { getProcessRegistryAddress } from '../utils/contractAddresses';

interface EndProcessScreenProps {
  onBack: () => void;
  onNext: () => void;
  wallet: Wallet | JsonRpcSigner;
}

interface ProcessState {
  processEnded: boolean;
  resultsReady: boolean;
  error: string | null;
  txHash: string | null;
  txStatus: string;
}

export default function EndProcessScreen({ onBack, onNext, wallet }: EndProcessScreenProps) {
  const [processState, setProcessState] = useState<ProcessState>({
    processEnded: false,
    resultsReady: false,
    error: null,
    txHash: null,
    txStatus: ''
  });
  const [isLoading, setIsLoading] = useState(false);

  const handleEndProcess = async () => {
    try {
      setIsLoading(true);
      const detailsStr = localStorage.getItem('electionDetails');
      if (!detailsStr) throw new Error('Election details not found');
      const details = JSON.parse(detailsStr);

      const registry = new ProcessRegistryService(
        getProcessRegistryAddress(),
        wallet
      );

      // End the process
      for await (const status of registry.setProcessStatus(details.processId, ProcessStatus.ENDED)) {
        if (status.status === TxStatus.Pending) {
          setProcessState(prev => ({
            ...prev,
            txStatus: 'Transaction pending...',
            txHash: status.hash
          }));
        } else if (status.status === TxStatus.Completed) {
          setProcessState(prev => ({
            ...prev,
            txStatus: 'Transaction confirmed!',
            processEnded: true
          }));
        } else if (status.status === TxStatus.Failed || status.status === TxStatus.Reverted) {
          throw new Error(`Transaction ${status.status.toLowerCase()}`);
        }
      }

      // Wait for results to be set
      setProcessState(prev => ({
        ...prev,
        txStatus: 'Waiting for process results to be set...'
      }));

      const resultsReady = new Promise<void>((resolve) => {
        registry.onProcessResultsSet((id: string, sender: string, result: bigint[]) => {
          if (id.toLowerCase() === details.processId.toLowerCase()) {
            console.log(`Results set by ${sender} with ${result.length} values`);
            setProcessState(prev => ({
              ...prev,
              txStatus: 'Process results have been set',
              resultsReady: true
            }));
            resolve();
          }
        });
      });
      
      await resultsReady;

    } catch (err) {
      setProcessState(prev => ({
        ...prev,
        error: err instanceof Error ? err.message : 'Failed to end process'
      }));
      console.error('Error ending process:', err);
    } finally {
      setIsLoading(false);
    }
  };

  return (
    <Box sx={{ maxWidth: 800, mx: 'auto', textAlign: 'center' }}>
      <Typography variant="h4" component="h1" gutterBottom>
        End Process & Check Results
      </Typography>

      <Typography variant="body1" color="text.secondary" paragraph sx={{ mb: 4 }}>
        End the voting process and wait for results to be available.
      </Typography>

      <Card sx={{ mb: 4 }}>
        <CardContent>
          {processState.error ? (
            <Alert severity="error" sx={{ mb: 2 }}>
              {processState.error}
            </Alert>
          ) : (
            <>
              <List>
                <ListItem>
                  <ListItemIcon>
                    {processState.processEnded ? (
                      <CheckCircleIcon color="success" />
                    ) : isLoading ? (
                      <CircularProgress size={24} />
                    ) : (
                      <PendingIcon color="action" />
                    )}
                  </ListItemIcon>
                  <ListItemText 
                    primary="End Process"
                    secondary={
                      processState.processEnded 
                        ? "Process ended successfully" 
                        : isLoading 
                        ? processState.txStatus || "Ending process..." 
                        : "Process needs to be ended"
                    }
                  />
                </ListItem>

                <ListItem>
                  <ListItemIcon>
                    {processState.resultsReady ? (
                      <CheckCircleIcon color="success" />
                    ) : processState.processEnded ? (
                      <CircularProgress size={24} />
                    ) : (
                      <PendingIcon color="action" />
                    )}
                  </ListItemIcon>
                  <ListItemText 
                    primary="Results Status"
                    secondary={
                      processState.resultsReady 
                        ? "Results are ready" 
                        : processState.processEnded 
                        ? "Waiting for results..." 
                        : "End process first"
                    }
                  />
                </ListItem>
              </List>

              {processState.txHash && (
                <Box sx={{ mt: 2, mb: 3, textAlign: 'center' }}>
                  <Typography variant="body1" color="text.secondary" gutterBottom>
                    {processState.txStatus}
                  </Typography>
                  <Link
                    href={`https://sepolia.etherscan.io/tx/${processState.txHash}`}
                    target="_blank"
                    rel="noopener noreferrer"
                    color="primary"
                  >
                    View on Etherscan
                  </Link>
                </Box>
              )}

              <Button
                fullWidth
                variant="contained"
                color="primary"
                onClick={handleEndProcess}
                disabled={isLoading || processState.processEnded}
                sx={{ mt: 2 }}
              >
                End Process
              </Button>
            </>
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
        <Button
          variant="contained"
          onClick={onNext}
          disabled={!processState.resultsReady}
        >
          Next
        </Button>
      </Box>
    </Box>
  );
}
