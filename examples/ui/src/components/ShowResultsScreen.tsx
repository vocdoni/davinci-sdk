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
import { ProcessRegistryService, VocdoniApiService } from '@vocdoni/davinci-sdk'
import { JsonRpcSigner, Wallet } from 'ethers'
import { useEffect, useState } from 'react'
import { getProcessRegistryAddress, logAddressConfiguration } from '../utils/contractAddresses'

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
        // Log address configuration
        logAddressConfiguration()
        
        const detailsStr = localStorage.getItem('electionDetails')
        if (!detailsStr) throw new Error('Election details not found')
        const details = JSON.parse(detailsStr)

        // Get metadata for question and choice labels
        const api = new VocdoniApiService({
          sequencerURL: import.meta.env.SEQUENCER_API_URL,
          censusURL: import.meta.env.CENSUS_API_URL
        })
        
        // Fetch sequencer info to get contract addresses if needed
        const sequencerInfo = await api.sequencer.getInfo()

        // Get process results
        const registry = new ProcessRegistryService(getProcessRegistryAddress(sequencerInfo.contracts), wallet)
        const electionProcess = await registry.getProcess(details.processId)
        const metadata = await api.sequencer.getMetadata(details.metadataUrl.split('/').pop() || '')

        // Map results to questions and choices
        const questions = metadata.questions.map((question, questionIndex) => {
          const startIndex = questionIndex * question.choices.length
          const endIndex = startIndex + question.choices.length
          const questionResults = electionProcess.result.slice(startIndex, endIndex)

          return {
            title: question.title.default,
            choices: question.choices.map((choice, choiceIndex) => ({
              title: choice.title.default,
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
