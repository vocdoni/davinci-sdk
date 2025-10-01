import { useWallets } from '@/context/WalletContext'
import CheckCircleIcon from '@mui/icons-material/CheckCircle'
import ErrorIcon from '@mui/icons-material/Error'
import {
  Alert,
  Box,
  Button,
  Card,
  CardContent,
  CircularProgress,
  FormControl,
  FormControlLabel,
  InputLabel,
  List,
  ListItem,
  ListItemIcon,
  ListItemText,
  MenuItem,
  Radio,
  RadioGroup,
  Select,
  Typography,
} from '@mui/material'
import {
  DavinciSDK,
  VoteStatus,
  type IQuestion,
  type MultiLanguage,
} from '@vocdoni/davinci-sdk'
import { Wallet, JsonRpcProvider } from 'ethers'
import { useEffect, useState } from 'react'


interface VotingScreenProps {
  onBack: () => void
  onNext: () => void
}

interface ElectionDetails {
  processId: string
  encryptionPubKey: [string, string]
  stateRoot: string
  metadataUrl: string
  censusRoot: string
  censusSize: number
  censusId: string
}

interface Question extends IQuestion {
  title: MultiLanguage<string>
  description: MultiLanguage<string>
  choices: Array<{ title: MultiLanguage<string>; value: number }>
}

interface Vote {
  address: string
  voteId: string
  status: VoteStatus
}

export default function VotingScreen({ onBack, onNext }: VotingScreenProps) {
  const [isLoading, setIsLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [addresses, setAddresses] = useState<string[]>([])
  const [selectedAddress, setSelectedAddress] = useState<string>('')
  const [questions, setQuestions] = useState<Question[]>([])
  const [answers, setAnswers] = useState<Record<number, number>>({})
  const [submittedVotes, setSubmittedVotes] = useState<Vote[]>([])
  const { walletMap } = useWallets()

  useEffect(() => {
    const loadElectionData = async () => {
      try {
        // Get election details from localStorage
        const detailsStr = localStorage.getItem('electionDetails')
        if (!detailsStr) {
          throw new Error('Election details not found')
        }
        const details: ElectionDetails = JSON.parse(detailsStr)

        // Check if we have wallets available
        const walletAddresses = Object.keys(walletMap)
        if (walletAddresses.length === 0) {
          throw new Error('No wallets available. Please connect a wallet first.')
        }

        // Use addresses from our stored wallets
        setAddresses(walletAddresses)

        // Initialize SDK with first available wallet for read-only operations
        const firstWallet = Object.values(walletMap)[0]
        if (!firstWallet) {
          throw new Error('No wallets available for SDK initialization')
        }

        // Create provider and connect wallet to it
        const provider = new JsonRpcProvider(import.meta.env.RPC_URL)
        const walletWithProvider = firstWallet.connect(provider)

        const sdk = new DavinciSDK({
          signer: walletWithProvider,
          environment: 'dev',
          sequencerUrl: import.meta.env.SEQUENCER_API_URL,
          censusUrl: import.meta.env.CENSUS_API_URL,
          chain: 'sepolia',
          useSequencerAddresses: true
        })
        await sdk.init()

        // Get process info using SDK
        const processInfo = await sdk.getProcess(details.processId)
        
        if (!processInfo.questions || processInfo.questions.length === 0) {
          throw new Error('No questions found in process metadata')
        }
        
        const fetchedQuestions = processInfo.questions.map((q: any) => ({
          ...q,
          title: typeof q.title === 'string' ? { default: q.title } : (q.title || { default: '' }),
          description: typeof q.description === 'string' ? { default: q.description } : (q.description || { default: '' }),
          choices: q.choices.map((c: any) => ({
            ...c,
            title: typeof c.title === 'string' ? { default: c.title } : (c.title || { default: '' }),
          })),
        }))
        
        setQuestions(fetchedQuestions)

        // Initialize answers with -1 (no selection)
        const initialAnswers: Record<number, number> = {}
        fetchedQuestions.forEach((_: any, index: number) => {
          initialAnswers[index] = -1
        })
        setAnswers(initialAnswers)
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Failed to load election data')
        console.error('Error loading election:', err)
      } finally {
        setIsLoading(false)
      }
    }

    if (Object.keys(walletMap).length > 0) {
      loadElectionData()
    }
  }, [walletMap])

  const handleVote = async () => {
    try {
      setIsLoading(true)
      setError(null)

      const details: ElectionDetails = JSON.parse(localStorage.getItem('electionDetails')!)
      const wallet = walletMap[selectedAddress]
      if (!wallet) {
        throw new Error('Wallet not found for selected address')
      }

      // Create provider and connect wallet to it
      const provider = new JsonRpcProvider(import.meta.env.RPC_URL)
      const walletWithProvider = wallet.connect(provider)

      // Initialize SDK with the connected wallet
      const sdk = new DavinciSDK({
        signer: walletWithProvider,
        environment: 'dev',
        sequencerUrl: import.meta.env.SEQUENCER_API_URL,
        censusUrl: import.meta.env.CENSUS_API_URL,
        chain: 'sepolia',
        useSequencerAddresses: true
      })
      await sdk.init()

      // Prepare vote choices - convert answers to the format expected by SDK
      // Each question needs an array with 1 at selected position, 0s elsewhere
      const voteChoices: number[] = []
      questions.forEach((question, questionIndex) => {
        const selectedChoiceIndex = answers[questionIndex] !== -1 ? answers[questionIndex] : 0
        const questionChoices = Array(question.choices.length).fill(0)
        questionChoices[selectedChoiceIndex] = 1
        voteChoices.push(...questionChoices)
      })

      // Submit vote using simplified SDK
      const voteResult = await sdk.submitVote({
        processId: details.processId,
        choices: voteChoices
      })

      // Add vote to submitted votes list
      const newVote = { 
        address: selectedAddress, 
        voteId: voteResult.voteId, 
        status: VoteStatus.Pending
      }
      setSubmittedVotes((prev) => [...prev, newVote])

      // Reset for next vote
      setSelectedAddress('')
      setAnswers(Object.fromEntries(Object.keys(answers).map((k) => [k, -1])))

      // Start monitoring vote status
      const checkVoteStatus = async () => {
        let isDone = false
        while (!isDone) {
          try {
            const voteStatus = await sdk.getVoteStatus(details.processId, voteResult.voteId)
            setSubmittedVotes((prev) => {
              const updated = prev.map((v) =>
                v.voteId === voteResult.voteId
                  ? {
                      ...v,
                      status: voteStatus.status as Vote['status'],
                    }
                  : v
              )
              return updated
            })

            if (voteStatus.status === VoteStatus.Settled || voteStatus.status === VoteStatus.Error) {
              isDone = true
            } else {
              await new Promise((r) => setTimeout(r, 2000))
            }
          } catch (err) {
            console.error('Error checking vote status:', err)
            isDone = true
          }
        }
      }
      checkVoteStatus().catch(console.error)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to submit vote')
      console.error('Error voting:', err)
    } finally {
      setIsLoading(false)
    }
  }


  const allQuestionsAnswered = Object.values(answers).every((value) => value !== -1)
  const allVotesSettled =
    submittedVotes.length > 0 && submittedVotes.every((v) => v.status === VoteStatus.Settled || v.status === VoteStatus.Error)

  // Get addresses that haven't voted yet
  const availableAddresses = addresses.filter((address) => {
    const hasVoted = submittedVotes.some((vote) => vote.address.toLowerCase() === address.toLowerCase())
    return !hasVoted
  })

  return (
    <Box sx={{ maxWidth: 1200, mx: 'auto', textAlign: 'center' }}>
      <Typography variant='h4' component='h1' gutterBottom>
        Cast Your Vote
      </Typography>

      <Typography variant='body1' color='text.secondary' paragraph sx={{ mb: 4 }}>
        Select your address and answer the questions to cast your vote.
      </Typography>

      <Box sx={{ display: 'flex', gap: 4, mb: 4 }}>
        <Card sx={{ flex: '1 1 60%' }}>
          <CardContent>
            {error ? (
              <Alert severity='error' sx={{ mb: 2 }}>
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
                    <Typography variant='h6' align='left' gutterBottom>
                      {question.title.default}
                    </Typography>
                    <Typography variant='body2' color='text.secondary' align='left' sx={{ mb: 2 }}>
                      {question.description.default}
                    </Typography>
                    <RadioGroup
                      value={answers[questionIndex]}
                      onChange={(e) =>
                        setAnswers((prev) => ({
                          ...prev,
                          [questionIndex]: parseInt(e.target.value),
                        }))
                      }
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

                {isLoading && (
                  <Box sx={{ width: '100%', mb: 4, textAlign: 'center' }}>
                    <CircularProgress sx={{ mb: 1 }} />
                    <Typography variant='body2' color='text.secondary'>
                      Submitting vote...
                    </Typography>
                  </Box>
                )}

                <Button
                  fullWidth
                  variant='contained'
                  color='primary'
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
            <Typography variant='h6' gutterBottom>
              Vote Status
            </Typography>
            {submittedVotes.length === 0 ? (
              <Typography color='text.secondary'>No votes submitted yet</Typography>
            ) : (
              <>
                <List>
                  {submittedVotes.map((vote, index) => (
                    <ListItem key={index}>
                      <ListItemIcon>
                        {vote.status === 'error' ? (
                          <ErrorIcon color='error' />
                        ) : vote.status === 'verified' || vote.status === 'aggregated' || vote.status === 'settled' ? (
                          <CheckCircleIcon color='success' />
                        ) : vote.status === 'processed' ? (
                          <Box sx={{ position: 'relative', display: 'inline-flex' }}>
                            <CheckCircleIcon color='success' />
                            <CircularProgress
                              size={24}
                              sx={{
                                position: 'absolute',
                                left: 0,
                                color: 'rgba(0, 0, 0, 0.3)',
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
                          vote.status === 'processed'
                            ? 'Vote processed successfully'
                            : vote.status === 'error'
                              ? 'Vote processing failed'
                              : vote.status === 'verified'
                                ? 'Vote verified, waiting for aggregation...'
                                : vote.status === 'aggregated'
                                  ? 'Vote aggregated, waiting for processing...'
                                  : vote.status === 'settled'
                                    ? 'Vote settled and finalized'
                                    : 'Vote submitted, waiting for verification...'
                        }
                      />
                    </ListItem>
                  ))}
                </List>

                {submittedVotes.length > 0 && !allVotesSettled && (
                  <Alert severity='info' sx={{ mt: 2 }} icon={<CircularProgress size={20} />}>
                    <Typography>Waiting for all votes to be settled before proceeding...</Typography>
                  </Alert>
                )}
              </>
            )}
          </CardContent>
        </Card>
      </Box>

      <Box sx={{ display: 'flex', gap: 2, justifyContent: 'center' }}>
        <Button variant='outlined' onClick={onBack} disabled={isLoading}>
          Back
        </Button>
        <Button variant='contained' onClick={onNext} disabled={!allVotesSettled}>
          Next
        </Button>
      </Box>
    </Box>
  )
}
