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
} from '@vocdoni/davinci-sdk';
import { Wallet, HDNodeWallet } from 'ethers';
import { useWallets } from '@/context/WalletContext';

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

interface VoteStatus {
  censusProofGenerated: boolean;
  zkInputsGenerated: boolean;
  proofGenerated: boolean;
  voteSubmitted: boolean;
  voteConfirmed: boolean;
}

const VOTE_STEPS = [
  'Generate Census Proof',
  'Generate ZK Inputs',
  'Generate & Verify Proof',
  'Submit Vote',
  'Confirm Vote',
];

export default function VotingScreen({ onBack, onNext }: VotingScreenProps) {
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [addresses, setAddresses] = useState<string[]>([]);
  const [selectedAddress, setSelectedAddress] = useState<string>('');
  const [questions, setQuestions] = useState<Question[]>([]);
  const [answers, setAnswers] = useState<Record<number, number>>({});
  const [voteStatus, setVoteStatus] = useState<VoteStatus>({
    censusProofGenerated: false,
    zkInputsGenerated: false,
    proofGenerated: false,
    voteSubmitted: false,
    voteConfirmed: false,
  });
  const [activeStep, setActiveStep] = useState(-1);
  const [waitTime, setWaitTime] = useState(0);

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

        // Get census participants
        const participants = await api.getParticipants(details.censusId);
        setAddresses(participants.map(p => p.key));

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
  }, []);

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

      // Step 2: Generate zk-SNARK inputs
      const { walletMap } = useWallets();
      const wallet = walletMap[selectedAddress];
      if (!wallet) {
        throw new Error('Wallet not found for selected address');
      }
      const secret = wallet.privateKey.substring(0, 12);
      const kHex = Array.from(crypto.getRandomValues(new Uint8Array(8)))
        .map(b => b.toString(16).padStart(2, '0'))
        .join('');
      const kStr = BigInt("0x" + kHex).toString();

      const sdk = new BallotProof({
        wasmExecUrl: process.env.BALLOT_PROOF_WASM_HELPER_EXEC_JS_URL || '',
        wasmUrl: process.env.BALLOT_PROOF_WASM_HELPER_URL || '',
      });
      await sdk.init();

      // Convert answers to field values array
      // For each question, create an array of 4 positions (1 for selected choice, 0 for others)
      const fieldValues = questions.map((question, questionIndex) => {
        const selectedValue = answers[questionIndex];
        const choices = Array(4).fill("0");
        if (selectedValue !== -1) {
          choices[selectedValue] = "1";
        }
        return choices;
      }).flat(); // Flatten the array of arrays

      const inputs = {
        address: selectedAddress.replace(/^0x/, ""),
        processID: details.processId.replace(/^0x/, ""),
        secret,
        encryptionKey: details.encryptionPubKey,
        k: kStr,
        ballotMode: {
          maxCount: questions.length,
          maxValue: "1",
          minValue: "0",
          forceUniqueness: false,
          costFromWeight: false,
          costExponent: 0,
          maxTotalCost: questions.length.toString(),
          minTotalCost: "0",
        },
        weight: "1",
        fieldValues,
      };

      const out = await sdk.proofInputs(inputs);
      setVoteStatus(prev => ({ ...prev, zkInputsGenerated: true }));
      setActiveStep(2);

      // Step 3: Run fullProve + verify
      const pg = new CircomProof({
        wasmUrl: process.env.CIRCUIT_URL || '',
        zkeyUrl: process.env.PROVING_KEY_URL || '',
        vkeyUrl: process.env.VERIFICATION_KEY_URL || '',
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

      const sigBytes = Uint8Array.from(Buffer.from(out.voteID.replace(/^0x/, ""), "hex"));
      const signature = await wallet.signMessage(sigBytes);

      const voteRequest = {
        processId: details.processId,
        commitment: out.commitment,
        nullifier: out.nullifier,
        censusProof,
        ballot: voteBallot,
        ballotProof: { pi_a: proof.pi_a, pi_b: proof.pi_b, pi_c: proof.pi_c, protocol: proof.protocol },
        ballotInputsHash: out.ballotInputHash,
        address: wallet.address,
        signature,
      };

      const voteId = await api.submitVote(voteRequest);
      setVoteStatus(prev => ({ ...prev, voteSubmitted: true }));
      setActiveStep(4);

      // Step 5: Wait for vote to be processed
      while (true) {
        const status = await api.getVoteStatus(details.processId, voteId);
        if (status.status === "processed") {
          setVoteStatus(prev => ({ ...prev, voteConfirmed: true }));
          clearInterval(timer);
          break;
        }
        await new Promise(r => setTimeout(r, 2000));
      }

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

  return (
    <Box sx={{ maxWidth: 800, mx: 'auto', textAlign: 'center' }}>
      <Typography variant="h4" component="h1" gutterBottom>
        Cast Your Vote
      </Typography>

      <Typography variant="body1" color="text.secondary" paragraph sx={{ mb: 4 }}>
        Select your address and answer the questions to cast your vote.
      </Typography>

      <Card sx={{ mb: 4 }}>
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
                  disabled={isLoading}
                >
                  {addresses.map((address) => (
                    <MenuItem key={address} value={address}>
                      {address}
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

              {voteStatus.voteConfirmed ? (
                <Alert severity="success" sx={{ mt: 2 }}>
                  Vote submitted and confirmed successfully!
                </Alert>
              ) : (
                <Button
                  fullWidth
                  variant="contained"
                  color="primary"
                  onClick={handleVote}
                  disabled={!selectedAddress || !allQuestionsAnswered || isLoading}
                >
                  Cast Vote
                </Button>
              )}
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
          disabled={!voteStatus.voteConfirmed}
        >
          Next
        </Button>
      </Box>
    </Box>
  );
}
