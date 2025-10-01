import {
  Alert,
  Box,
  Button,
  Card,
  CardContent,
  CircularProgress,
  Divider,
  LinearProgress,
  Typography,
} from '@mui/material'
import { DavinciSDK } from '@vocdoni/davinci-sdk'
import { JsonRpcSigner, Wallet, JsonRpcProvider } from 'ethers'
import { useEffect, useState } from 'react'

interface ShowResultsScreenProps {
  onBack: () => void
  onNext: () => void
  wallet: Wallet | JsonRpcSigner
}

interface ElectionResults {
  questions: Array<{
    title: string
    choices: Array<{
      title: string
      votes: number
    }>
  }>
  isLoading: boolean
  error: string | null
}

export default function ShowResultsScreen({ onBack, onNext, wallet }: ShowResultsScreenProps) {
  const [results, setResults] = useState<ElectionResults>({
    questions: [],
    isLoading: true,
    error: null,
  })

  useEffect(() => {
    const loadResults = async () => {
      try {
        const detailsStr = localStorage.getItem('electionDetails')
        if (!detailsStr) throw new Error('Election details not found')
        const details = JSON.parse(detailsStr)

        // Check if wallet already has a provider (e.g., MetaMask)
        // If not, connect it to the RPC provider from env
        const walletInstance = wallet as Wallet
        let signerWithProvider = walletInstance
        if (!walletInstance.provider) {
          if (!import.meta.env.RPC_URL) {
            throw new Error('RPC_URL environment variable is required')
          }
          const provider = new JsonRpcProvider(import.meta.env.RPC_URL)
          signerWithProvider = walletInstance.connect(provider)
        }

        // Initialize SDK
        const sdk = new DavinciSDK({
          signer: signerWithProvider,
          environment: 'dev',
          sequencerUrl: import.meta.env.SEQUENCER_API_URL,
          censusUrl: import.meta.env.CENSUS_API_URL,
          chain: 'sepolia',
          useSequencerAddresses: true
        })
        await sdk.init()

        // Get process info using SDK - this includes both metadata and results
        const processInfo = await sdk.getProcess(details.processId)

        // Map results to questions and choices using process info
        const questions = processInfo.questions.map((question, questionIndex) => {
          const startIndex = questionIndex * question.choices.length
          const endIndex = startIndex + question.choices.length
          const questionResults = processInfo.result.slice(startIndex, endIndex)

          return {
            title: typeof question.title === 'string' ? question.title : question.title.default,
            choices: question.choices.map((choice, choiceIndex) => ({
              title: typeof choice.title === 'string' ? choice.title : choice.title.default,
              votes: Number(questionResults[choiceIndex]),
            })),
          }
        })

        setResults({
          questions,
          isLoading: false,
          error: null,
        })
      } catch (err) {
        setResults((prev) => ({
          ...prev,
          isLoading: false,
          error: err instanceof Error ? err.message : 'Failed to load results',
        }))
        console.error('Error loading results:', err)
      }
    }

    loadResults()
  }, [wallet])

  if (results.isLoading) {
    return (
      <Box sx={{ display: 'flex', justifyContent: 'center', alignItems: 'center', minHeight: '50vh' }}>
        <CircularProgress />
      </Box>
    )
  }

  if (results.error) {
    return (
      <Box sx={{ maxWidth: 800, mx: 'auto', textAlign: 'center' }}>
        <Alert severity='error' sx={{ mb: 2 }}>
          {results.error}
        </Alert>
        <Button variant='outlined' onClick={onBack}>
          Back
        </Button>
      </Box>
    )
  }

  return (
    <Box sx={{ maxWidth: 800, mx: 'auto', textAlign: 'center' }}>
      <Typography variant='h4' component='h1' gutterBottom>
        Election Results
      </Typography>

      <Card sx={{ mb: 4 }}>
        <CardContent>
          {results.questions.map((question, questionIndex) => (
            <Box key={questionIndex} sx={{ mb: 4 }}>
              <Box sx={{ mb: 3 }}>
                <Typography variant='h6' align='left' gutterBottom>
                  {question.title}
                </Typography>
                <Typography variant='body2' color='text.secondary' align='left'>
                  Total votes: {question.choices.reduce((acc, curr) => acc + curr.votes, 0)}
                </Typography>
              </Box>

              <Box>
                {question.choices.map((choice, choiceIndex) => {
                  const totalVotes = question.choices.reduce((acc, curr) => acc + curr.votes, 0)
                  return (
                    <Box key={choiceIndex} sx={{ mb: 2 }}>
                      <Box sx={{ display: 'flex', justifyContent: 'space-between', mb: 0.5 }}>
                        <Typography variant='body1'>{choice.title}</Typography>
                        <Typography variant='body2' color='text.secondary'>
                          {choice.votes} votes ({Math.round((choice.votes / totalVotes) * 100)}%)
                        </Typography>
                      </Box>
                      <LinearProgress
                        variant='determinate'
                        value={(choice.votes / totalVotes) * 100}
                        sx={{
                          height: 10,
                          borderRadius: 5,
                          backgroundColor: 'rgba(0, 0, 0, 0.1)',
                          '& .MuiLinearProgress-bar': {
                            borderRadius: 5,
                            backgroundColor: ['#2B6CB0', '#38A169', '#805AD5', '#D53F8C', '#DD6B20', '#718096'][
                              choiceIndex % 6
                            ],
                          },
                        }}
                      />
                    </Box>
                  )
                })}
              </Box>

              {questionIndex < results.questions.length - 1 && <Divider sx={{ my: 2 }} />}
            </Box>
          ))}
        </CardContent>
      </Card>

      <Box sx={{ display: 'flex', gap: 2, justifyContent: 'center' }}>
        <Button variant='outlined' onClick={onBack}>
          Back
        </Button>
        <Button variant='contained' onClick={onNext}>
          Finish
        </Button>
      </Box>
    </Box>
  )
}
