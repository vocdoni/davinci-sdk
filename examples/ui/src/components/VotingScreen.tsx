import { useState, useEffect } from 'react';
import {
  Box,
  Button,
  Typography,
  Card,
  CardContent,
  Alert,
  CircularProgress,
  FormControl,
  InputLabel,
  Select,
  MenuItem,
  RadioGroup,
  FormControlLabel,
  Radio,
  List,
  ListItem,
  ListItemIcon,
  ListItemText,
  Stepper,
  Step,
  StepLabel,
} from '@mui/material';
import CheckCircleIcon from '@mui/icons-material/CheckCircle';
import PendingIcon from '@mui/icons-material/Pending';
import ErrorIcon from '@mui/icons-material/Error';
import HourglassEmptyIcon from '@mui/icons-material/HourglassEmpty';
import ScheduleIcon from '@mui/icons-material/Schedule';
import CloudUploadIcon from '@mui/icons-material/CloudUpload';
import CloudDoneIcon from '@mui/icons-material/CloudDone';
import { 
  VocdoniApiService, 
  BallotProof, 
  CircomProof, 
  VoteBallot,
  BallotProofOutput,
  Groth16Proof,
  ProofInputs,
  IQuestion,
  MultiLanguage,
  InfoResponse,
} from '@vocdoni/davinci-sdk';
import { Wallet, HDNodeWallet } from 'ethers';
import { useWallets } from '@/context/WalletContext';

const getCircuitUrls = (info: InfoResponse) => {
  const isDev = process.env.NODE_ENV === 'development';
  return {
    ballotProofExec: isDev ? '/wasm_exec.js' : info.ballotProofWasmHelperExecJsUrl,
    ballotProof: isDev ? '/ballotproof.wasm' : info.ballotProofWasmHelperUrl,
    circuit: isDev ? '/ballot_proof.wasm' : info.circuitUrl,
    provingKey: isDev ? '/ballot_proof_pkey.zkey' : info.provingKeyUrl,
    verificationKey: isDev ? '/ballot_proof_vkey.json' : info.verificationKeyUrl,
  };
};

interface VotingScreenProps {
  onBack: () => void;
  onNext: () => void;
}

interface ElectionDetails {
  processId: string;
  encryptionPubKey: [string, string];
  stateRoot: string;
  metadataUrl: string;
  censusRoot: string;
  censusSize: number;
  censusId: string;
}

interface Question extends IQuestion {
  title: MultiLanguage<string>;
  description: MultiLanguage<string>;
  choices: Array<{ title: MultiLanguage<string>; value: number }>;
}

interface Vote {
  address: string;
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

export default function VotingScreen({ onBack, onNext }: VotingScreenProps) {
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [participants, setParticipants] = useState<Array<{ key: string; weight: string | undefined }>>([]);
  const [addresses, setAddresses] = useState<string[]>([]);
  const [selectedAddress, setSelectedAddress] = useState<string>('');
  const [questions, setQuestions] = useState<Question[]>([]);
  const [answers, setAnswers] = useState<Record<number, number>>({});
  const [voteStatus, setVoteStatus] = useState<VoteStatus>({
    censusProofGenerated: false,
    zkInputsGenerated: false,
    proofGenerated: false,
    voteSubmitted: false,
  });
  const [submittedVotes, setSubmittedVotes] = useState<Vote[]>([]);
  const [processingVotes, setProcessingVotes] = useState(false);
  const [activeStep, setActiveStep] = useState(-1);
  const [waitTime, setWaitTime] = useState(0);
  const { walletMap } = useWallets();

  useEffect(() => {
    const loadElectionData = async () => {
      try {
        // Get election details from localStorage
        const detailsStr = localStorage.getItem('electionDetails');
        if (!detailsStr) {
          throw new Error('Election details not found');
        }
        const details: ElectionDetails = JSON.parse(detailsStr);

        const api = new VocdoniApiService(process.env.API_URL || '');

        // Get census participants for their weights
        const censusParticipants = await api.getParticipants(details.censusId);
        setParticipants(censusParticipants.map(p => ({ key: p.key, weight: p.weight })));
        
        // Use addresses from our stored wallets
        setAddresses(Object.keys(walletMap));

        // Get election metadata and map to our Question interface
        // Extract hash from the metadata URL
        const hash = details.metadataUrl.split('/').pop() || '';
        const metadata = await api.getMetadata(hash);
        setQuestions(metadata.questions.map(q => ({
          ...q,
          title: q.title || { default: '' },
          description: q.description || { default: '' },
          choices: q.choices.map(c => ({
            ...c,
            title: c.title || { default: '' }
          }))
        })));

        // Initialize answers with -1 (no selection)
        const initialAnswers: Record<number, number> = {};
        metadata.questions.forEach((_, index) => {
          initialAnswers[index] = -1;
        });
        setAnswers(initialAnswers);

      } catch (err) {
        setError(err instanceof Error ? err.message : 'Failed to load election data');
        console.error('Error loading election:', err);
      } finally {
        setIsLoading(false);
      }
    };

    loadElectionData();
  }, [walletMap]);

  const processVotes = async (processId: string) => {
    while (true) {
      let allProcessed = true;
      const updatedVotes = [...submittedVotes];
      
      for (let i = 0; i < updatedVotes.length; i++) {
        if (updatedVotes[i].status === 'pending') {
          const api = new VocdoniApiService(process.env.API_URL || '');
          const status = await api.getVoteStatus(processId, updatedVotes[i].voteId);
          
          updatedVotes[i].status = status.status as Vote['status'];
          
          if (status.status !== 'processed' && status.status !== 'error') {
            allProcessed = false;
          }
        }
      }
      
      setSubmittedVotes(updatedVotes);
      
      if (allProcessed) {
        setProcessingVotes(false);
        break;
      }
      
      await new Promise(r => setTimeout(r, 2000));
    }
  };

  const handleVote = async () => {
    try {
      setIsLoading(true);
      setError(null);
      setActiveStep(0);

      const startTime = Date.now();
      const updateWaitTime = () => {
        setWaitTime(Math.floor((Date.now() - startTime) / 1000));
      };
      const timer = setInterval(updateWaitTime, 1000);

      const api = new VocdoniApiService(process.env.API_URL || '');
      const details: ElectionDetails = JSON.parse(localStorage.getItem('electionDetails')!);

      // Step 1: Get census proof
      const censusProof = await api.getCensusProof(details.censusRoot, selectedAddress);
      setVoteStatus(prev => ({ ...prev, censusProofGenerated: true }));
      setActiveStep(1);

      // Step 2: Get the wallet from the census
      const wallet = walletMap[selectedAddress];
      if (!wallet) {
        throw new Error('Wallet not found for selected address');
      }
      const secret = wallet.privateKey.substring(0, 12);
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

      const inputs = {
        address: selectedAddress.replace(/^0x/, ""),
        processID: details.processId.replace(/^0x/, ""),
        secret,
        encryptionKey: details.encryptionPubKey,
        k: kStr,
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
        weight: participants.find(p => p.key === selectedAddress)?.weight || "1",
        fieldValues,
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

      const sigBytes = Uint8Array.from(
        out.voteID.replace(/^0x/, "")
          .match(/.{1,2}/g)!
          .map(byte => parseInt(byte, 16))
      );
      const signature = await wallet.signMessage(sigBytes);

      const voteRequest = {
        processId: details.processId,
        commitment: out.commitment,
        nullifier: out.nullifier,
        censusProof,
        ballot: voteBallot,
        ballotProof: { pi_a: proof.pi_a, pi_b: proof.pi_b, pi_c: proof.pi_c, protocol: proof.protocol },
        ballotInputsHash: out.ballotInputHash,
        address: selectedAddress,
        signature,
      };

      const voteId = await api.submitVote(voteRequest);
      setVoteStatus(prev => ({ ...prev, voteSubmitted: true }));
      setActiveStep(4);

      // Add vote to submitted votes list and start processing
      const newVote = { address: selectedAddress, voteId, status: 'pending' as const };
      setSubmittedVotes(prev => [...prev, newVote]);
      
      // Reset for next vote
      setVoteStatus({
        censusProofGenerated: false,
        zkInputsGenerated: false,
        proofGenerated: false,
        voteSubmitted: false,
      });
      setActiveStep(-1);
      setSelectedAddress('');
      setAnswers(Object.fromEntries(Object.keys(answers).map(k => [k, -1])));
      clearInterval(timer);

      // Start processing the new vote
      const checkVoteStatus = async () => {
        let isDone = false;
        while (!isDone) {
          const voteStatus = await api.getVoteStatus(details.processId, voteId);
          setSubmittedVotes(prev => {
            const updated = prev.map(v => 
              v.voteId === voteId ? { 
                ...v, 
                status: voteStatus.status as Vote['status']
              } : v
            );
            return updated;
          });

          if (voteStatus.status === 'processed' || voteStatus.status === 'error') {
            isDone = true;
          } else {
            await new Promise(r => setTimeout(r, 2000));
          }
        }
      };
      checkVoteStatus().catch(console.error);

    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to submit vote');
      console.error('Error voting:', err);
    } finally {
      setIsLoading(false);
    }
  };

  const renderStepIcon = (completed: boolean, active: boolean) => {
    if (completed) return <CheckCircleIcon color="success" />;
    if (active) return <CircularProgress size={24} />;
    return <PendingIcon color="action" />;
  };

  const allQuestionsAnswered = Object.values(answers).every(value => value !== -1);
  const allVotesProcessed = submittedVotes.length > 0 && submittedVotes.every(v => 
    v.status === 'processed' || v.status === 'error'
  );

  // Get addresses that haven't voted yet
  const availableAddresses = addresses.filter(address => {
    const hasVoted = submittedVotes.some(vote => vote.address.toLowerCase() === address.toLowerCase());
    return !hasVoted;
  });

  return (
    <Box sx={{ maxWidth: 1200, mx: 'auto', textAlign: 'center' }}>
      <Typography variant="h4" component="h1" gutterBottom>
        Cast Your Vote
      </Typography>

      <Typography variant="body1" color="text.secondary" paragraph sx={{ mb: 4 }}>
        Select your address and answer the questions to cast your vote.
      </Typography>

      <Box sx={{ display: 'flex', gap: 4, mb: 4 }}>
        <Card sx={{ flex: '1 1 60%' }}>
          <CardContent>
            {error ? (
              <Alert severity="error" sx={{ mb: 2 }}>
                {error}
              </Alert>
            ) : (
              <>
                <FormControl fullWidth sx={{ mb: 4 }}>
                  <InputLabel>Select Your Address</InputLabel>
                  <Select
                    value={selectedAddress}
                    onChange={(e) => setSelectedAddress(e.target.value)}
                    disabled={isLoading || availableAddresses.length === 0}
                  >
                    {availableAddresses.map((address: string) => (
                      <MenuItem key={address} value={address}>
                        {`${address.slice(0, 6)}...${address.slice(-4)}`}
                      </MenuItem>
                    ))}
                  </Select>
                </FormControl>

                {questions.map((question, questionIndex) => (
                  <Box key={questionIndex} sx={{ mb: 4 }}>
                    <Typography variant="h6" align="left" gutterBottom>
                      {question.title.default}
                    </Typography>
                    <Typography variant="body2" color="text.secondary" align="left" sx={{ mb: 2 }}>
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
                          disabled={isLoading}
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

                <Button
                  fullWidth
                  variant="contained"
                  color="primary"
                  onClick={handleVote}
                  disabled={!selectedAddress || !allQuestionsAnswered || isLoading || availableAddresses.length === 0}
                >
                  Cast Vote
                </Button>
              </>
            )}
          </CardContent>
        </Card>

        <Card sx={{ flex: '1 1 40%' }}>
          <CardContent>
            <Typography variant="h6" gutterBottom>
              Vote Status
            </Typography>
            {submittedVotes.length === 0 ? (
              <Typography color="text.secondary">
                No votes submitted yet
              </Typography>
            ) : (
              <>
                <List>
                {submittedVotes.map((vote, index) => (
                  <ListItem key={index}>
                    <ListItemIcon>
                      {vote.status === 'error' ? (
                        <ErrorIcon color="error" />
                      ) : vote.status === 'verified' || vote.status === 'aggregated' || vote.status === 'settled' ? (
                        <CheckCircleIcon color="success" />
                      ) : vote.status === 'processed' ? (
                        <Box sx={{ position: 'relative', display: 'inline-flex' }}>
                          <CheckCircleIcon color="success" />
                          <CircularProgress 
                            size={24} 
                            sx={{ 
                              position: 'absolute',
                              left: 0,
                              color: 'rgba(0, 0, 0, 0.3)'
                            }} 
                          />
                        </Box>
                      ) : (
                        <CircularProgress size={24} />
                      )}
                    </ListItemIcon>
                    <ListItemText
                      primary={`${vote.address.slice(0, 6)}...${vote.address.slice(-4)}`}
                      secondary={
                        vote.status === 'processed' ? 'Vote processed successfully' :
                        vote.status === 'error' ? 'Vote processing failed' :
                        vote.status === 'verified' ? 'Vote verified, waiting for aggregation...' :
                        vote.status === 'aggregated' ? 'Vote aggregated, waiting for processing...' :
                        vote.status === 'settled' ? 'Vote settled and finalized' :
                        'Vote submitted, waiting for verification...'
                      }
                    />
                  </ListItem>
                ))}
              </List>

              {submittedVotes.length > 0 && !allVotesProcessed && (
                <Alert 
                  severity="info" 
                  sx={{ mt: 2 }}
                  icon={<CircularProgress size={20} />}
                >
                  <Typography>
                    Waiting for all votes to be processed before proceeding...
                  </Typography>
                </Alert>
              )}
              </>
            )}
          </CardContent>
        </Card>
      </Box>

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
          disabled={!allVotesProcessed}
        >
          Next
        </Button>
      </Box>
    </Box>
  );
}
