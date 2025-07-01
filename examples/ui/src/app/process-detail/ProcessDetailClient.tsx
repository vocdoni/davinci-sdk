'use client';

import { useState, useEffect } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import {
  Box,
  Button,
  Typography,
  Card,
  CardContent,
  CircularProgress,
  Alert,
  List,
  ListItem,
  ListItemText,
  Chip,
  IconButton,
  RadioGroup,
  FormControlLabel,
  Radio,
  TextField,
  Tabs,
  Tab,
  Stepper,
  Step,
  StepLabel,
  LinearProgress,
  ListItemIcon,
} from '@mui/material';
import ArrowBackIcon from '@mui/icons-material/ArrowBack';
import AccountBalanceWalletIcon from '@mui/icons-material/AccountBalanceWallet';
import CheckCircleIcon from '@mui/icons-material/CheckCircle';
import PendingIcon from '@mui/icons-material/Pending';
import ErrorIcon from '@mui/icons-material/Error';
import RefreshIcon from '@mui/icons-material/Refresh';
import { ThemeProvider, createTheme } from '@mui/material';
import Layout from '@/components/layout/Layout';
import { 
  VocdoniApiService, 
  GetProcessResponse, 
  BallotProof, 
  CircomProof, 
  VoteBallot,
  BallotProofInputs,
  ProofInputs,
  InfoResponse,
  ProcessRegistryService,
} from '@vocdoni/davinci-sdk';
import { getProcessRegistryAddress } from '@/utils/contractAddresses';
import { JsonRpcProvider, BrowserProvider, Wallet, JsonRpcSigner } from 'ethers';

const theme = createTheme({
  palette: {
    primary: {
      main: '#2B6CB0',
    },
    secondary: {
      main: '#4A5568',
    },
    background: {
      default: '#F7FAFC',
    },
  },
  typography: {
    fontFamily: '"Inter", "Helvetica", "Arial", sans-serif',
  },
  components: {
    MuiButton: {
      styleOverrides: {
        root: {
          textTransform: 'none',
        },
      },
    },
  },
});

interface Question {
  title: { default: string };
  description: { default: string };
  choices: Array<{ title: { default: string }; value: number }>;
}

interface Vote {
  voteId: string;
  status: 'pending' | 'verified' | 'aggregated' | 'processed' | 'settled' | 'error';
}

interface VoteStatus {
  censusProofGenerated: boolean;
  zkInputsGenerated: boolean;
  proofGenerated: boolean;
  voteSubmitted: boolean;
}

const VOTE_STEPS = [
  'Generate Census Proof',
  'Generate ZK Inputs',
  'Generate & Verify Proof',
  'Submit Vote',
];

const getCircuitUrls = (info: InfoResponse) => {
  return {
    ballotProofExec: info.ballotProofWasmHelperExecJsUrl,
    ballotProof: info.ballotProofWasmHelperUrl,
    circuit: info.circuitUrl,
    provingKey: info.provingKeyUrl,
    verificationKey: info.verificationKeyUrl,
  };
};

const getStatusText = (status: number) => {
  switch (status) {
    case 0: return 'Ready';
    case 1: return 'Paused';
    case 2: return 'Ended';
    case 3: return 'Canceled';
    case 4: return 'Results';
    default: return 'Unknown';
  }
};

const getStatusColor = (status: number) => {
  switch (status) {
    case 0: return 'success';
    case 1: return 'warning';
    case 2: return 'error';
    case 3: return 'error';
    case 4: return 'info';
    default: return 'default';
  }
};

const getVoteStatusText = (status: string) => {
  switch (status) {
    case 'pending': return 'Vote submitted, awaiting verification';
    case 'verified': return 'Vote verified, waiting for aggregation';
    case 'aggregated': return 'Vote aggregated, waiting for processing';
    case 'processed': return 'Vote processed successfully';
    case 'settled': return 'Vote settled and finalized';
    case 'error': return 'Vote processing failed';
    default: return 'Unknown status';
  }
};

const getVoteStatusColor = (status: string) => {
  switch (status) {
    case 'settled':
    case 'processed': return 'success';
    case 'verified':
    case 'aggregated': return 'info';
    case 'pending': return 'warning';
    case 'error': return 'error';
    default: return 'default';
  }
};

// Results Section Component
interface ResultsSectionProps {
  processData: GetProcessResponse;
  questions: Question[];
}

function ResultsSection({ processData, questions }: ResultsSectionProps) {
  const [results, setResults] = useState<{
    questions: Array<{
      title: string;
      choices: Array<{
        title: string;
        votes: number;
      }>;
    }>;
    isLoading: boolean;
    error: string | null;
  }>({
    questions: [],
    isLoading: true,
    error: null,
  });

  useEffect(() => {
    const loadResults = async () => {
      try {
        if (!processData.result || processData.result.length === 0) {
          throw new Error('No results available for this process');
        }

        // Map results to questions and choices using the actual process results
        const mappedResults = questions.map((question, questionIndex) => {
          const startIndex = questionIndex * question.choices.length;
          const endIndex = startIndex + question.choices.length;
          const questionResults = processData.result.slice(startIndex, endIndex);

          return {
            title: question.title.default,
            choices: question.choices.map((choice, choiceIndex) => ({
              title: choice.title.default,
              votes: Number(questionResults[choiceIndex] || 0)
            }))
          };
        });

        setResults({
          questions: mappedResults,
          isLoading: false,
          error: null,
        });

      } catch (err) {
        setResults(prev => ({
          ...prev,
          isLoading: false,
          error: err instanceof Error ? err.message : 'Failed to load results'
        }));
        console.error('Error loading results:', err);
      }
    };

    if (questions.length > 0) {
      loadResults();
    }
  }, [questions, processData]);

  if (results.isLoading) {
    return (
      <Card sx={{ mb: 4 }}>
        <CardContent>
          <Box sx={{ display: 'flex', justifyContent: 'center', alignItems: 'center', minHeight: '200px' }}>
            <CircularProgress />
          </Box>
        </CardContent>
      </Card>
    );
  }

  if (results.error) {
    return (
      <Card sx={{ mb: 4 }}>
        <CardContent>
          <Alert severity="error">
            {results.error}
          </Alert>
        </CardContent>
      </Card>
    );
  }

  return (
    <Card sx={{ mb: 4 }}>
      <CardContent>
        <Typography variant="h6" gutterBottom>
          Election Results
        </Typography>

        {results.questions.map((question, questionIndex) => (
          <Box key={questionIndex} sx={{ mb: 4 }}>
            <Box sx={{ mb: 3 }}>
              <Typography variant="h6" align="left" gutterBottom>
                {question.title}
              </Typography>
              <Typography variant="body2" color="text.secondary" align="left">
                Total votes: {question.choices.reduce((acc, curr) => acc + curr.votes, 0)}
              </Typography>
            </Box>
            
            <Box>
              {question.choices.map((choice, choiceIndex) => {
                const totalVotes = question.choices.reduce((acc, curr) => acc + curr.votes, 0);
                const percentage = totalVotes > 0 ? Math.round((choice.votes / totalVotes) * 100) : 0;
                return (
                  <Box key={choiceIndex} sx={{ mb: 2 }}>
                    <Box sx={{ display: 'flex', justifyContent: 'space-between', mb: 0.5 }}>
                      <Typography variant="body1">{choice.title}</Typography>
                      <Typography variant="body2" color="text.secondary">
                        {choice.votes} votes ({percentage}%)
                      </Typography>
                    </Box>
                    <LinearProgress 
                      variant="determinate" 
                      value={percentage}
                      sx={{ 
                        height: 10, 
                        borderRadius: 5,
                        backgroundColor: 'rgba(0, 0, 0, 0.1)',
                        '& .MuiLinearProgress-bar': {
                          borderRadius: 5,
                          backgroundColor: [
                            '#2B6CB0',
                            '#38A169',
                            '#805AD5',
                            '#D53F8C',
                            '#DD6B20',
                            '#718096'
                          ][choiceIndex % 6]
                        }
                      }}
                    />
                  </Box>
                );
              })}
            </Box>

            {questionIndex < results.questions.length - 1 && (
              <Box sx={{ my: 2 }}>
                <Typography variant="body2" color="text.secondary" sx={{ borderBottom: 1, borderColor: 'divider', pb: 1 }}>
                </Typography>
              </Box>
            )}
          </Box>
        ))}
      </CardContent>
    </Card>
  );
}

export default function ProcessDetailClient() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const processId = searchParams.get('id');

  const [processData, setProcessData] = useState<GetProcessResponse | null>(null);
  const [questions, setQuestions] = useState<Question[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  
  // Wallet connection state
  const [wallet, setWallet] = useState<Wallet | JsonRpcSigner | null>(null);
  const [walletAddress, setWalletAddress] = useState<string | null>(null);
  const [walletBalance, setWalletBalance] = useState<string | null>(null);
  const [walletError, setWalletError] = useState<string>('');
  const [walletLoading, setWalletLoading] = useState(false);
  const [activeTab, setActiveTab] = useState(0);
  const [privateKey, setPrivateKey] = useState('');
  
  // Voting state
  const [answers, setAnswers] = useState<Record<number, number>>({});
  const [isVoting, setIsVoting] = useState(false);
  const [voteError, setVoteError] = useState<string | null>(null);
  const [canUserVote, setCanUserVote] = useState<boolean | null>(null);
  const [checkingEligibility, setCheckingEligibility] = useState(false);
  
  // Vote progress tracking
  const [submittedVote, setSubmittedVote] = useState<Vote | null>(null);
  const [trackingVote, setTrackingVote] = useState(false);
  const [voteStatus, setVoteStatus] = useState<VoteStatus>({
    censusProofGenerated: false,
    zkInputsGenerated: false,
    proofGenerated: false,
    voteSubmitted: false,
  });
  const [activeStep, setActiveStep] = useState(-1);
  const [waitTime, setWaitTime] = useState(0);

  useEffect(() => {
    if (processId) {
      loadProcess();
    } else {
      setError('No process ID provided');
      setIsLoading(false);
    }
  }, [processId]);

  // Vote status tracking effect
  useEffect(() => {
    if (submittedVote && trackingVote && processId) {
      const checkVoteStatus = async () => {
        try {
          const api = new VocdoniApiService(process.env.API_URL || '');
          const status = await api.getVoteStatus(processId, submittedVote.voteId);
          
          setSubmittedVote(prev => prev ? {
            ...prev,
            status: status.status as Vote['status']
          } : null);

          if (status.status === 'settled' || status.status === 'error') {
            setTrackingVote(false);
          }
        } catch (err) {
          console.error('Error checking vote status:', err);
        }
      };

      const interval = setInterval(checkVoteStatus, 3000);
      return () => clearInterval(interval);
    }
  }, [submittedVote, trackingVote, processId]);

  const loadProcess = async () => {
    if (!processId) return;

    try {
      setIsLoading(true);
      setError(null);
      
      const api = new VocdoniApiService(process.env.API_URL || '');
      
      // Get process details
      const processResponse = await api.getProcess(processId);
      
      // Load metadata from metadataURI if available
      let processWithMetadata = processResponse;
      if (processResponse.metadataURI) {
        try {
          const metadataHash = processResponse.metadataURI.split('/').pop();
          if (metadataHash) {
            const metadata = await api.getMetadata(metadataHash);
            // Merge metadata into process data (keep original structure)
            processWithMetadata = {
              ...processResponse,
              metadata: metadata as any
            };
            
            const mappedQuestions: Question[] = (metadata.questions || []).map(q => ({
              title: q.title || { default: '' },
              description: q.description || { default: '' },
              choices: q.choices.map(c => ({
                title: c.title || { default: '' },
                value: c.value
              }))
            })) as Question[];
            setQuestions(mappedQuestions);
            
            // Initialize answers
            const initialAnswers: Record<number, number> = {};
            metadata.questions?.forEach((_, index) => {
              initialAnswers[index] = -1;
            });
            setAnswers(initialAnswers);
          }
        } catch (metadataErr) {
          console.warn('Failed to load metadata:', metadataErr);
          // Use fallback from processResponse.metadata if available
          if (processResponse.metadata) {
            const mappedQuestions: Question[] = (processResponse.metadata.questions || []).map(q => ({
              title: q.title || { default: '' },
              description: q.description || { default: '' },
              choices: q.choices.map(c => ({
                title: c.title || { default: '' },
                value: c.value
              }))
            })) as Question[];
            setQuestions(mappedQuestions);
          }
        }
      }
      
      setProcessData(processWithMetadata);
      
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load process');
      console.error('Error loading process:', err);
    } finally {
      setIsLoading(false);
    }
  };

  const formatDate = (timestamp: number | string) => {
    if (!timestamp || timestamp === 0) return 'Not set';
    try {
      const date = new Date(timestamp);
      if (isNaN(date.getTime())) return 'Invalid date';
      return date.toLocaleString();
    } catch (err) {
      return 'Invalid date';
    }
  };

  const formatEther = (balance: bigint): string => {
    return (Number(balance) / 1e18).toFixed(4);
  };

  const checkCensusEligibility = async (address: string) => {
    if (!processData) return;
    
    try {
      setCheckingEligibility(true);
      const api = new VocdoniApiService(process.env.API_URL || '');
      
      // Try to get census proof for this address
      await api.getCensusProof(processData.census.censusRoot, address);
      setCanUserVote(true);
    } catch (err) {
      console.warn('User not eligible to vote:', err);
      setCanUserVote(false);
    } finally {
      setCheckingEligibility(false);
    }
  };

  const resetWallet = () => {
    setWallet(null);
    setWalletAddress(null);
    setWalletBalance(null);
    setCanUserVote(null);
    setWalletError('');
    setPrivateKey('');
  };

  const resetVote = () => {
    setSubmittedVote(null);
    setTrackingVote(false);
    setVoteError(null);
    setVoteStatus({
      censusProofGenerated: false,
      zkInputsGenerated: false,
      proofGenerated: false,
      voteSubmitted: false,
    });
    setActiveStep(-1);
    setWaitTime(0);
    setAnswers(Object.fromEntries(Object.keys(answers).map(k => [k, -1])));
  };

  const handleTabChange = (_event: React.SyntheticEvent, newValue: number) => {
    setActiveTab(newValue);
    setWalletError('');
  };

  const connectWithMetaMask = async () => {
    try {
      setWalletLoading(true);
      setWalletError('');

      if (!window.ethereum) {
        throw new Error('MetaMask is not installed');
      }

      await window.ethereum.request({ method: 'eth_requestAccounts' });
      const provider = new BrowserProvider(window.ethereum);
      const signer = await provider.getSigner();
      const address = await signer.getAddress();
      const balance = await provider.getBalance(address);
      
      setWallet(signer);
      setWalletAddress(address);
      setWalletBalance(formatEther(balance));
      
      // Check census eligibility
      await checkCensusEligibility(address);
    } catch (err) {
      setWalletError(err instanceof Error ? err.message : 'Failed to connect to MetaMask');
    } finally {
      setWalletLoading(false);
    }
  };

  const connectWithPrivateKey = async () => {
    try {
      setWalletLoading(true);
      setWalletError('');

      // Clean private key - remove 0x prefix if present
      const cleanPrivateKey = privateKey.startsWith('0x') ? privateKey.slice(2) : privateKey;
      
      if (!cleanPrivateKey.match(/^[0-9a-fA-F]{64}$/)) {
        throw new Error('Invalid private key format. Must be 64 hex characters (with or without 0x prefix)');
      }

      const provider = new JsonRpcProvider(process.env.RPC_URL);
      const walletInstance = new Wallet(cleanPrivateKey, provider);
      const address = await walletInstance.getAddress();
      const balance = await provider.getBalance(address);

      setWallet(walletInstance);
      setWalletAddress(address);
      setWalletBalance(formatEther(balance));
      
      // Check census eligibility
      await checkCensusEligibility(address);
    } catch (err) {
      setWalletError(err instanceof Error ? err.message : 'Failed to connect with private key');
    } finally {
      setWalletLoading(false);
    }
  };

  // EXACT COPY FROM VotingScreen.tsx handleVote function
  const handleVote = async () => {
    if (!wallet || !processData || !walletAddress) return;

    try {
      setIsVoting(true);
      setError(null);
      setActiveStep(0);

      const startTime = Date.now();
      const updateWaitTime = () => {
        setWaitTime(Math.floor((Date.now() - startTime) / 1000));
      };
      const timer = setInterval(updateWaitTime, 1000);

      const api = new VocdoniApiService(process.env.API_URL || '');

      // Step 1: Get census proof
      const censusProof = await api.getCensusProof(processData.census.censusRoot, walletAddress);
      setVoteStatus(prev => ({ ...prev, censusProofGenerated: true }));
      setActiveStep(1);

      // Step 2: Get the wallet from the census
      const kHex = Array.from(crypto.getRandomValues(new Uint8Array(8)))
        .map(b => b.toString(16).padStart(2, '0'))
        .join('');
      const kStr = BigInt("0x" + kHex).toString();

      // Get WASM URLs from API info
      const info = await api.getInfo();
      const urls = getCircuitUrls(info);
      const sdk = new BallotProof({
        wasmExecUrl: urls.ballotProofExec,
        wasmUrl: urls.ballotProof,
      });
      await sdk.init();

      // Calculate ballot mode values
      const maxValue = (Math.max(...questions.map(q => q.choices.length)) - 1).toString(); // -1 because choices are 0-based
      const maxTotalCost = questions.map(q => q.choices.length - 1).reduce((a, b) => a + b, 0).toString();

      // Create arrays for each question with length equal to their choices
      const questionArrays = questions.map((question, questionIndex) => {
        const choices = Array(question.choices.length).fill("0");
        const selectedValue = answers[questionIndex];
        if (selectedValue !== -1) {
          choices[selectedValue] = "1";
        }
        return choices;
      });
      
      // Flatten all arrays into one, preserving order
      const fieldValues = questionArrays.flat();

      const inputs: BallotProofInputs = {
        address: walletAddress,
        processID: processData.id,
        ballotMode: {
          maxCount: questions.length,
          maxValue,
          minValue: "0",
          forceUniqueness: false,
          costFromWeight: false,
          costExponent: 0,
          maxTotalCost,
          minTotalCost: "0",
        },
        encryptionKey: [processData.encryptionKey.x, processData.encryptionKey.y],
        k: kStr,
        fieldValues,
        weight: "1",
        secret: "0",
      };

      const out = await sdk.proofInputs(inputs);
      setVoteStatus(prev => ({ ...prev, zkInputsGenerated: true }));
      setActiveStep(2);

      // Step 3: Run fullProve + verify
      const pg = new CircomProof({
        wasmUrl: urls.circuit,
        zkeyUrl: urls.provingKey,
        vkeyUrl: urls.verificationKey,
      });

      const { proof, publicSignals } = await pg.generate(out.circomInputs as ProofInputs);
      const ok = await pg.verify(proof, publicSignals);
      if (!ok) throw new Error('Proof verification failed');
      setVoteStatus(prev => ({ ...prev, proofGenerated: true }));
      setActiveStep(3);

      // Step 4: Submit vote
      const voteBallot: VoteBallot = {
        curveType: out.ballot.curveType,
        ciphertexts: out.ballot.ciphertexts,
      };

      const hexStringToUint8Array = (hexString: string): Uint8Array => {
        return Uint8Array.from(Buffer.from(hexString.replace(/^0x/, ""), "hex"));
      };

      const signature = await wallet.signMessage(hexStringToUint8Array(out.voteID));

      const voteRequest = {
        address: walletAddress,
        ballot: voteBallot,
        ballotInputsHash: out.ballotInputHash,
        ballotProof: proof,
        censusProof,
        processId: processData.id,
        signature,
        voteId: out.voteID,
        commitment: out.commitment,
        nullifier: out.nullifier,
      };

      await api.submitVote(voteRequest);
      const voteId = out.voteID;
      setVoteStatus(prev => ({ ...prev, voteSubmitted: true }));
      setActiveStep(4);

      // Add vote to submitted votes list and start processing
      const newVote = { voteId, status: 'pending' as const };
      setSubmittedVote(newVote);
      setTrackingVote(true);
      
      // Reset for next vote
      setVoteStatus({
        censusProofGenerated: false,
        zkInputsGenerated: false,
        proofGenerated: false,
        voteSubmitted: false,
      });
      setActiveStep(-1);
      setAnswers(Object.fromEntries(Object.keys(answers).map(k => [k, -1])));
      clearInterval(timer);

      // Start processing the new vote
      const checkVoteStatus = async () => {
        let isDone = false;
        while (!isDone) {
          const voteStatus = await api.getVoteStatus(processData.id, voteId);
          setSubmittedVote(prev => prev ? {
            ...prev,
            status: voteStatus.status as Vote['status']
          } : null);

          if (voteStatus.status === 'settled' || voteStatus.status === 'error') {
            isDone = true;
            setTrackingVote(false);
          } else {
            await new Promise(r => setTimeout(r, 2000));
          }
        }
      };
      checkVoteStatus().catch(console.error);

    } catch (err) {
      setVoteError(err instanceof Error ? err.message : 'Failed to submit vote');
      console.error('Error voting:', err);
    } finally {
      setIsVoting(false);
    }
  };

  const renderStepIcon = (completed: boolean, active: boolean) => {
    if (completed) return <CheckCircleIcon color="success" />;
    if (active) return <CircularProgress size={24} />;
    return <PendingIcon color="action" />;
  };

  const allQuestionsAnswered = Object.values(answers).every(value => value !== -1);
  const canVote = processData?.status === 0 && processData?.isAcceptingVotes && wallet && allQuestionsAnswered && !submittedVote && canUserVote === true;

  if (isLoading) {
    return (
      <ThemeProvider theme={theme}>
        <Layout>
          <Box sx={{ display: 'flex', justifyContent: 'center', py: 8 }}>
            <CircularProgress />
          </Box>
        </Layout>
      </ThemeProvider>
    );
  }

  if (error || !processData) {
    return (
      <ThemeProvider theme={theme}>
        <Layout>
          <Box sx={{ width: '100%', maxWidth: 800, mx: 'auto', px: 3, py: 4 }}>
            <Alert severity="error">
              {error || 'Process not found'}
            </Alert>
            <Button
              variant="outlined"
              startIcon={<ArrowBackIcon />}
              onClick={() => router.push('/processes')}
              sx={{ mt: 2 }}
            >
              Back to Processes
            </Button>
          </Box>
        </Layout>
      </ThemeProvider>
    );
  }

  return (
    <ThemeProvider theme={theme}>
      <Layout>
        <Box sx={{ width: '100%', maxWidth: 1200, mx: 'auto', px: 3, py: 4 }}>
          {/* Header */}
          <Box sx={{ display: 'flex', alignItems: 'center', mb: 4 }}>
            <IconButton 
              onClick={() => router.push('/processes')} 
              sx={{ mr: 2 }}
              aria-label="Go back to processes"
            >
              <ArrowBackIcon />
            </IconButton>
            <Typography variant="h4" component="h1" sx={{ flexGrow: 1 }}>
              Process Details
            </Typography>
            <Chip
              label={getStatusText(processData.status)}
              color={getStatusColor(processData.status) as any}
              size="medium"
            />
          </Box>

          {/* Process Information */}
          <Card sx={{ mb: 4 }}>
            <CardContent>
              <Typography variant="h5" gutterBottom>
                {processData.metadata?.title?.default || 'Untitled Process'}
              </Typography>
              <Typography variant="body1" color="text.secondary" paragraph>
                {processData.metadata?.description?.default || 'No description available'}
              </Typography>

              <List>
                <ListItem disablePadding>
                  <ListItemText
                    primary="Process ID"
                    secondary={processData.id}
                    primaryTypographyProps={{ variant: 'subtitle2' }}
                    secondaryTypographyProps={{ variant: 'body2', fontFamily: 'monospace' }}
                  />
                </ListItem>
                <ListItem disablePadding>
                  <ListItemText
                    primary="Vote Count"
                    secondary={processData.voteCount}
                    primaryTypographyProps={{ variant: 'subtitle2' }}
                    secondaryTypographyProps={{ variant: 'body2' }}
                  />
                </ListItem>
                <ListItem disablePadding>
                  <ListItemText
                    primary="Start Time"
                    secondary={formatDate(processData.startTime)}
                    primaryTypographyProps={{ variant: 'subtitle2' }}
                    secondaryTypographyProps={{ variant: 'body2' }}
                  />
                </ListItem>
                <ListItem disablePadding>
                  <ListItemText
                    primary="Accepting Votes"
                    secondary={processData.isAcceptingVotes ? 'Yes' : 'No'}
                    primaryTypographyProps={{ variant: 'subtitle2' }}
                    secondaryTypographyProps={{ variant: 'body2' }}
                  />
                </ListItem>
              </List>
            </CardContent>
          </Card>

          {/* Voting Section */}
          {processData.status === 0 && processData.isAcceptingVotes && (
            <Box sx={{ display: 'flex', gap: 4, mb: 4 }}>
              {/* Voting Form */}
              <Card sx={{ flex: '1 1 60%' }}>
                <CardContent>
                  <Typography variant="h6" gutterBottom>
                    Cast Your Vote
                  </Typography>

                  {!wallet || canUserVote === false ? (
                    <>
                      <Typography variant="body2" color="text.secondary" paragraph>
                        Connect your wallet to participate in this voting process.
                      </Typography>

                      {canUserVote === false && (
                        <Alert severity="error" sx={{ mb: 3 }}>
                          <Typography variant="subtitle2">Not Eligible to Vote</Typography>
                          <Typography variant="body2">
                            Your address ({walletAddress}) is not included in the census for this voting process. Try connecting a different wallet.
                          </Typography>
                          <Button
                            variant="outlined"
                            size="small"
                            onClick={resetWallet}
                            sx={{ mt: 1 }}
                          >
                            Try Different Wallet
                          </Button>
                        </Alert>
                      )}

                      <Tabs value={activeTab} onChange={handleTabChange} sx={{ mb: 2 }}>
                        <Tab label="MetaMask" />
                        <Tab label="Private Key" />
                      </Tabs>

                      {activeTab === 0 && (
                        <Box sx={{ textAlign: 'center' }}>
                          <Button
                            variant="contained"
                            color="primary"
                            startIcon={<AccountBalanceWalletIcon />}
                            onClick={connectWithMetaMask}
                            disabled={walletLoading}
                          >
                            {walletLoading ? 'Connecting...' : 'Connect MetaMask'}
                          </Button>
                        </Box>
                      )}

                      {activeTab === 1 && (
                        <Box>
                          <TextField
                            fullWidth
                            label="Private Key"
                            variant="outlined"
                            value={privateKey}
                            onChange={(e) => setPrivateKey(e.target.value)}
                            type="password"
                            disabled={walletLoading}
                            sx={{ mb: 2 }}
                          />
                          <Button
                            fullWidth
                            variant="contained"
                            color="primary"
                            onClick={connectWithPrivateKey}
                            disabled={walletLoading || !privateKey}
                          >
                            {walletLoading ? 'Connecting...' : 'Connect with Private Key'}
                          </Button>
                        </Box>
                      )}

                      {walletError && (
                        <Alert severity="error" sx={{ mt: 2 }}>
                          {walletError}
                        </Alert>
                      )}

                      {walletLoading && (
                        <Box sx={{ display: 'flex', justifyContent: 'center', mt: 2 }}>
                          <CircularProgress />
                        </Box>
                      )}
                    </>
                  ) : (
                    <>
                      <Alert severity="success" sx={{ mb: 3 }}>
                        <Typography variant="subtitle2">Wallet Connected</Typography>
                        <Typography variant="body2">
                          Address: {walletAddress}
                        </Typography>
                      </Alert>

                      {checkingEligibility && (
                        <Alert severity="info" sx={{ mb: 3 }}>
                          <Box sx={{ display: 'flex', alignItems: 'center', gap: 1 }}>
                            <CircularProgress size={16} />
                            <Typography variant="body2">
                              Checking voting eligibility...
                            </Typography>
                          </Box>
                        </Alert>
                      )}

                      {canUserVote === true && (
                        <Alert severity="success" sx={{ mb: 3 }}>
                          <Typography variant="subtitle2">Eligible to Vote</Typography>
                          <Typography variant="body2">
                            Your address is included in the census. You can participate in this vote.
                          </Typography>
                        </Alert>
                      )}

                      {submittedVote ? (
                        <Alert severity="success" sx={{ mb: 3 }}>
                          <Typography variant="subtitle2">Vote Submitted Successfully!</Typography>
                          <Typography variant="body2">
                            Your vote is being processed. You can track its progress in the status panel.
                          </Typography>
                          {(submittedVote.status === 'settled' || submittedVote.status === 'error') && (
                            <Button
                              variant="outlined"
                              size="small"
                              startIcon={<RefreshIcon />}
                              onClick={resetVote}
                              sx={{ mt: 1 }}
                            >
                              Vote Again
                            </Button>
                          )}
                        </Alert>
                      ) : (
                        <>
                          {questions.map((question, questionIndex) => (
                            <Box key={questionIndex} sx={{ mb: 4 }}>
                              <Typography variant="h6" gutterBottom>
                                {question.title.default}
                              </Typography>
                              <Typography variant="body2" color="text.secondary" sx={{ mb: 2 }}>
                                {question.description.default}
                              </Typography>
                              <RadioGroup
                                value={answers[questionIndex]}
                                onChange={(e) => setAnswers(prev => ({
                                  ...prev,
                                  [questionIndex]: parseInt(e.target.value)
                                }))}
                              >
                                {question.choices.map((choice, choiceIndex) => (
                                  <FormControlLabel
                                    key={choiceIndex}
                                    value={choiceIndex}
                                    control={<Radio />}
                                    label={choice.title.default}
                                    disabled={isVoting}
                                  />
                                ))}
                              </RadioGroup>
                            </Box>
                          ))}

                          {activeStep >= 0 && (
                            <Box sx={{ width: '100%', mb: 4 }}>
                              <Stepper activeStep={activeStep}>
                                {VOTE_STEPS.map((label, index) => (
                                  <Step key={label}>
                                    <StepLabel
                                      StepIconComponent={() => renderStepIcon(
                                        index < activeStep,
                                        index === activeStep
                                      )}
                                    >
                                      {label}
                                    </StepLabel>
                                  </Step>
                                ))}
                              </Stepper>
                              {activeStep >= 0 && activeStep < VOTE_STEPS.length && (
                                <Typography variant="body2" color="text.secondary" sx={{ mt: 2 }}>
                                  {VOTE_STEPS[activeStep]}... ({waitTime}s)
                                </Typography>
                              )}
                            </Box>
                          )}

                          {voteError && (
                            <Alert severity="error" sx={{ mb: 2 }}>
                              {voteError}
                            </Alert>
                          )}

                          <Button
                            variant="contained"
                            color="primary"
                            onClick={handleVote}
                            disabled={!canVote || isVoting}
                            fullWidth
                          >
                            {isVoting ? 'Submitting Vote...' : 'Submit Vote'}
                          </Button>
                        </>
                      )}
                    </>
                  )}
                </CardContent>
              </Card>

              {/* Vote Status Panel */}
              <Card sx={{ flex: '1 1 40%' }}>
                <CardContent>
                  <Typography variant="h6" gutterBottom>
                    Vote Status
                  </Typography>
                  
                  {!submittedVote ? (
                    <Typography color="text.secondary">
                      No vote submitted yet
                    </Typography>
                  ) : (
                    <>
                      <Alert 
                        severity={getVoteStatusColor(submittedVote.status) as any}
                        sx={{ mb: 3 }}
                      >
                        <Typography variant="subtitle2">
                          {submittedVote.status.charAt(0).toUpperCase() + submittedVote.status.slice(1)}
                        </Typography>
                        <Typography variant="body2">
                          {getVoteStatusText(submittedVote.status)}
                        </Typography>
                      </Alert>

                      {/* Progress indicator */}
                      <Box sx={{ mb: 3 }}>
                        <Typography variant="body2" color="text.secondary" gutterBottom>
                          Processing Progress
                        </Typography>
                        <LinearProgress 
                          variant="determinate" 
                          value={
                            submittedVote.status === 'pending' ? 20 :
                            submittedVote.status === 'verified' ? 40 :
                            submittedVote.status === 'aggregated' ? 60 :
                            submittedVote.status === 'processed' ? 80 :
                            submittedVote.status === 'settled' ? 100 :
                            0
                          }
                          sx={{ height: 8, borderRadius: 4 }}
                        />
                      </Box>

                      {/* Status steps */}
                      <List dense>
                        {[
                          { status: 'pending', label: 'Submitted' },
                          { status: 'verified', label: 'Verified' },
                          { status: 'aggregated', label: 'Aggregated' },
                          { status: 'processed', label: 'Processed' },
                          { status: 'settled', label: 'Settled' }
                        ].map((step, index) => {
                          const isCompleted = ['pending', 'verified', 'aggregated', 'processed', 'settled'].indexOf(submittedVote.status) >= index;
                          const isCurrent = submittedVote.status === step.status;
                          
                          return (
                            <ListItem key={step.status} disablePadding>
                              <ListItemIcon>
                                {submittedVote.status === 'error' ? (
                                  <ErrorIcon color="error" />
                                ) : isCompleted ? (
                                  <CheckCircleIcon color="success" />
                                ) : isCurrent ? (
                                  <CircularProgress size={20} />
                                ) : (
                                  <PendingIcon color="action" />
                                )}
                              </ListItemIcon>
                              <ListItemText
                                primary={step.label}
                                primaryTypographyProps={{
                                  color: isCompleted || isCurrent ? 'text.primary' : 'text.secondary'
                                }}
                              />
                            </ListItem>
                          );
                        })}
                      </List>

                      {trackingVote && (
                        <Alert severity="info" sx={{ mt: 2 }}>
                          <Typography variant="body2">
                            Tracking vote progress... This may take a few minutes.
                          </Typography>
                        </Alert>
                      )}
                    </>
                  )}
                </CardContent>
              </Card>
            </Box>
          )}

          {/* Results Section */}
          {processData.status === 4 && (
            <ResultsSection processData={processData} questions={questions} />
          )}

          {/* Questions Display (for non-voting processes) */}
          {questions.length > 0 && processData.status !== 4 && (processData.status !== 0 || !processData.isAcceptingVotes) && (
            <Card>
              <CardContent>
                <Typography variant="h6" gutterBottom>
                  Questions
                </Typography>
                {questions.map((question, index) => (
                  <Box key={index} sx={{ mb: 3 }}>
                    <Typography variant="subtitle1" gutterBottom>
                      {index + 1}. {question.title.default}
                    </Typography>
                    <Typography variant="body2" color="text.secondary" sx={{ mb: 1 }}>
                      {question.description.default}
                    </Typography>
                    <List dense>
                      {question.choices.map((choice, choiceIndex) => (
                        <ListItem key={choiceIndex} disablePadding>
                          <ListItemText
                            primary={`${String.fromCharCode(65 + choiceIndex)}. ${choice.title.default}`}
                            primaryTypographyProps={{ variant: 'body2' }}
                          />
                        </ListItem>
                      ))}
                    </List>
                  </Box>
                ))}
              </CardContent>
            </Card>
          )}
        </Box>
      </Layout>
    </ThemeProvider>
  );
}
