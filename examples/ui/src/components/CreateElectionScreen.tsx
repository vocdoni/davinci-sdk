import AddIcon from '@mui/icons-material/Add'
import DeleteIcon from '@mui/icons-material/Delete'
import EditIcon from '@mui/icons-material/Edit'
import {
  Alert,
  Box,
  Button,
  Card,
  CardContent,
  CircularProgress,
  Divider,
  IconButton,
  Link,
  List,
  ListItem,
  ListItemText,
  Paper,
  TextField,
  Typography,
} from '@mui/material'
import { AdapterDateFns } from '@mui/x-date-pickers/AdapterDateFns'
import { DateTimePicker } from '@mui/x-date-pickers/DateTimePicker'
import { LocalizationProvider } from '@mui/x-date-pickers/LocalizationProvider'
import {
  DavinciSDK,
  PlainCensus,
} from '@vocdoni/davinci-sdk'
import { JsonRpcSigner, Wallet, JsonRpcProvider } from 'ethers'
import { useState } from 'react'
import { getTransactionUrl } from '../utils/explorerUrl'

interface CreateElectionScreenProps {
  onBack: () => void
  onNext: () => void
  wallet: Wallet | JsonRpcSigner
  census: PlainCensus
}

interface Question {
  title: { default: string }
  description: { default: string }
  choices: Array<{ title: { default: string }; value: number }>
}

// Calculate ballot mode based on questions
const calculateBallotMode = (questions: Question[]) => {
  const maxValue = (Math.max(...questions.map((q) => q.choices.length)) - 1).toString() // -1 because choices are 0-based
  const maxValueSum = questions
    .map((q) => q.choices.length - 1)
    .reduce((a, b) => a + b, 0)
    .toString()

  return {
    numFields: questions.length,
    maxValue,
    minValue: '0',
    uniqueValues: false,
    costFromWeight: false,
    costExponent: 0,
    maxValueSum,
    minValueSum: '0',
  }
}

export default function CreateElectionScreen({ onBack, onNext, wallet, census }: CreateElectionScreenProps) {
  const [title, setTitle] = useState('Test Election')
  const [description, setDescription] = useState('This is a test election created via the UI')
  const [questions, setQuestions] = useState<Question[]>([
    {
      title: { default: 'What is your favorite programming language?' },
      description: { default: 'Choose your preferred programming language' },
      choices: [
        { title: { default: 'JavaScript' }, value: 0 },
        { title: { default: 'Python' }, value: 1 },
        { title: { default: 'Java' }, value: 2 },
        { title: { default: 'Go' }, value: 3 },
      ],
    },
  ])
  const [isLoading, setIsLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [electionCreated, setElectionCreated] = useState(false)
  const [txHash, setTxHash] = useState<string | null>(null)
  const [endDate, setEndDate] = useState<Date>(() => {
    const date = new Date()
    date.setMinutes(date.getMinutes() + 40) // Default: 40 minutes from now (above minimum of 30)
    return date
  })

  // Question editing states
  const [editingQuestionIndex, setEditingQuestionIndex] = useState<number | null>(null)
  const [newQuestionTitle, setNewQuestionTitle] = useState('')
  const [newQuestionDescription, setNewQuestionDescription] = useState('')
  const [newChoices, setNewChoices] = useState<Record<number, string>>({})

  const handleAddQuestion = () => {
    setQuestions([
      ...questions,
      {
        title: { default: '' },
        description: { default: '' },
        choices: [],
      },
    ])
    setEditingQuestionIndex(questions.length)
    setNewQuestionTitle('')
    setNewQuestionDescription('')
  }

  const handleRemoveQuestion = (index: number) => {
    // Check if this is the only valid question (has title and at least 2 choices)
    const isValidQuestion = (q: Question) =>
      q.title.default.trim() !== '' && q.choices.length >= 2

    const validQuestions = questions.filter(isValidQuestion)
    if (validQuestions.length === 1 && isValidQuestion(questions[index])) {
      setError('Cannot remove the last valid question')
      return
    }

    setQuestions(questions.filter((_, i) => i !== index))
    if (editingQuestionIndex === index) {
      setEditingQuestionIndex(null)
    }
    setError(null)
  }

  const handleEditQuestion = (index: number) => {
    setEditingQuestionIndex(index)
    setNewQuestionTitle(questions[index].title.default)
    setNewQuestionDescription(questions[index].description.default)
  }

  const handleSaveQuestion = () => {
    if (editingQuestionIndex === null) return

    const updatedQuestions = [...questions]
    updatedQuestions[editingQuestionIndex] = {
      ...updatedQuestions[editingQuestionIndex],
      title: { default: newQuestionTitle },
      description: { default: newQuestionDescription },
    }
    setQuestions(updatedQuestions)
    setEditingQuestionIndex(null)
  }

  const handleAddChoice = (questionIndex: number) => {
    const choiceText = newChoices[questionIndex] || ''
    if (!choiceText.trim()) return

    setQuestions(
      questions.map((question, index) => {
        if (index === questionIndex) {
          return {
            ...question,
            choices: [...question.choices, { title: { default: choiceText }, value: question.choices.length }],
          }
        }
        return question
      })
    )
    setNewChoices((prev) => ({ ...prev, [questionIndex]: '' }))
  }

  const handleRemoveChoice = (questionIndex: number, choiceIndex: number) => {
    setQuestions(
      questions.map((question, index) => {
        if (index === questionIndex) {
          const newChoices = question.choices.filter((_, i) => i !== choiceIndex)
          // Update values to maintain sequential order
          const updatedChoices = newChoices.map((choice, i) => ({
            ...choice,
            value: i,
          }))
          return {
            ...question,
            choices: updatedChoices,
          }
        }
        return question
      })
    )
  }

  const handleCreateElection = async () => {
    try {
      setIsLoading(true)
      setError(null)

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
        sequencerUrl: import.meta.env.SEQUENCER_API_URL,
        censusUrl: import.meta.env.CENSUS_API_URL
      })
      await sdk.init()

      // Create process
      const ballotMode = calculateBallotMode(questions)
      const startTime = new Date(Date.now() + 60 * 1000) // Start in 1 minute
      const duration = Math.floor((endDate.getTime() - startTime.getTime()) / 1000) // Duration in seconds

      const processResult = await sdk.createProcess({
        title,
        description,
        census,
        ballot: ballotMode,
        timing: {
          startDate: startTime,
          duration
        },
        questions: questions.map(q => ({
          title: q.title.default,
          description: q.description.default,
          choices: q.choices.map(c => ({
            title: c.title.default,
            value: c.value
          }))
        }))
      })

      setTxHash(processResult.transactionHash)
      setElectionCreated(true)

      // Get the process info to extract metadata URL
      const processInfo = await sdk.getProcess(processResult.processId)
      
      // Store the process details for the next step
      localStorage.setItem(
        'electionDetails',
        JSON.stringify({
          processId: processResult.processId,
          metadataUrl: processInfo.raw?.metadataURI || `process-${processResult.processId}-metadata`,
        })
      )
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to create election')
      console.error('Error creating election:', err)
    } finally {
      setIsLoading(false)
    }
  }

  return (
    <Box sx={{ maxWidth: 800, mx: 'auto', textAlign: 'center' }}>
      <Typography variant='h4' component='h1' gutterBottom>
        Create Election
      </Typography>

      <Typography variant='body1' color='text.secondary' paragraph>
        Configure your election details and create it on the Vocdoni network.
      </Typography>
      <Typography variant='body2' color='text.secondary' paragraph sx={{ mb: 4 }}>
        Each question must have at least 2 choices. You can add more questions to your election.
      </Typography>

      <Card sx={{ mb: 4 }}>
        <CardContent>
          <TextField
            fullWidth
            label='Election Title'
            variant='outlined'
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            disabled={isLoading || electionCreated}
            required
            sx={{ mb: 3 }}
          />

          <TextField
            fullWidth
            label='Election Description'
            variant='outlined'
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            disabled={isLoading || electionCreated}
            multiline
            rows={3}
            sx={{ mb: 3 }}
          />

          <LocalizationProvider dateAdapter={AdapterDateFns}>
            <DateTimePicker
              label='End Date'
              value={endDate}
              onChange={(newValue) => newValue && setEndDate(newValue)}
              disabled={isLoading || electionCreated}
              minDateTime={(() => {
                const minDate = new Date()
                minDate.setMinutes(minDate.getMinutes() + 30)
                return minDate
              })()}
              sx={{ width: '100%', mb: 3 }}
            />
          </LocalizationProvider>

          <Divider sx={{ my: 3 }} />

          <Box sx={{ mb: 3, display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
            <Typography variant='h6'>Questions</Typography>
            <Button
              variant='outlined'
              startIcon={<AddIcon />}
              onClick={handleAddQuestion}
              disabled={isLoading || electionCreated}
            >
              Add Question
            </Button>
          </Box>

          {questions.map((question, questionIndex) => (
            <Paper key={questionIndex} elevation={1} sx={{ mb: 3, p: 2 }}>
              {editingQuestionIndex === questionIndex ? (
                <Box sx={{ mb: 2 }}>
                  <TextField
                    fullWidth
                    label='Question Title'
                    value={newQuestionTitle}
                    onChange={(e) => setNewQuestionTitle(e.target.value)}
                    sx={{ mb: 2 }}
                  />
                  <TextField
                    fullWidth
                    label='Question Description (optional)'
                    value={newQuestionDescription}
                    onChange={(e) => setNewQuestionDescription(e.target.value)}
                    sx={{ mb: 2 }}
                  />
                  <Button variant='contained' onClick={handleSaveQuestion}>
                    Save Question
                  </Button>
                </Box>
              ) : (
                <Box sx={{ mb: 2 }}>
                  <Box sx={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                    <Typography variant='subtitle1'>{question.title.default}</Typography>
                    <Box>
                      <IconButton
                        onClick={() => handleEditQuestion(questionIndex)}
                        disabled={isLoading || electionCreated}
                      >
                        <EditIcon />
                      </IconButton>
                      <IconButton
                        onClick={() => handleRemoveQuestion(questionIndex)}
                        disabled={isLoading || electionCreated}
                      >
                        <DeleteIcon />
                      </IconButton>
                    </Box>
                  </Box>
                  <Typography variant='body2' color='text.secondary'>
                    {question.description.default}
                  </Typography>
                </Box>
              )}

              <List>
                {question.choices.map((choice, choiceIndex) => (
                  <ListItem
                    key={choiceIndex}
                    secondaryAction={
                      !electionCreated && (
                        <IconButton
                          edge='end'
                          onClick={() => handleRemoveChoice(questionIndex, choiceIndex)}
                          disabled={question.choices.length <= 1}
                        >
                          <DeleteIcon />
                        </IconButton>
                      )
                    }
                  >
                    <ListItemText primary={`${choiceIndex + 1}. ${choice.title.default}`} />
                  </ListItem>
                ))}
              </List>

              <Box sx={{ display: 'flex', gap: 1, mt: 2 }}>
                <TextField
                  fullWidth
                  size='small'
                  label='New Choice'
                  value={newChoices[questionIndex] || ''}
                  onChange={(e) => {
                    setNewChoices((prev) => ({
                      ...prev,
                      [questionIndex]: e.target.value,
                    }))
                    setError(null) // Clear error when user types
                  }}
                  disabled={isLoading || electionCreated}
                />
                <Button
                  variant='contained'
                  onClick={() => handleAddChoice(questionIndex)}
                  disabled={!(newChoices[questionIndex] || '').trim() || isLoading || electionCreated}
                  startIcon={<AddIcon />}
                >
                  Add
                </Button>
              </Box>
            </Paper>
          ))}

          {error && (
            <Alert severity='error' sx={{ mb: 2 }}>
              {error}
            </Alert>
          )}

          {txHash && !electionCreated && (
            <Alert
              severity='info'
              sx={{
                mb: 2,
                '& .MuiAlert-message': {
                  width: '100%',
                },
              }}
            >
              <Box sx={{ textAlign: 'center' }}>
                <Box sx={{ display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 1 }}>
                  <Typography variant='body2'>Processing transaction...</Typography>
                  <CircularProgress size={16} />
                </Box>
                <Box sx={{ mt: 1 }}>
                  <Link
                    href={getTransactionUrl(txHash)}
                    target='_blank'
                    rel='noopener noreferrer'
                    color='primary'
                    sx={{ display: 'inline-block' }}
                  >
                    View transaction status
                  </Link>
                </Box>
              </Box>
            </Alert>
          )}

          {electionCreated && (
            <Alert
              severity='success'
              sx={{
                mb: 2,
                '& .MuiAlert-message': {
                  width: '100%',
                },
              }}
            >
              <Box sx={{ textAlign: 'center' }}>
                <Typography variant='body1' sx={{ fontWeight: 'bold', mb: 1 }}>
                  Election created successfully!
                </Typography>
                <Link
                  href={getTransactionUrl(txHash!)}
                  target='_blank'
                  rel='noopener noreferrer'
                  color='primary'
                  sx={{ display: 'inline-block' }}
                >
                  View transaction details
                </Link>
              </Box>
            </Alert>
          )}

          {isLoading && !txHash && (
            <Box sx={{ mb: 2, textAlign: 'center' }}>
              <CircularProgress sx={{ mb: 1 }} />
              <Typography variant='body2' color='text.secondary'>
                Creating election...
              </Typography>
            </Box>
          )}

          {!electionCreated && (
            <Button
              fullWidth
              variant='contained'
              color='primary'
              onClick={handleCreateElection}
              disabled={
                isLoading ||
                !title.trim() ||
                questions.some((q) => q.choices.length < 2 && q.title.default.trim() !== '') // Each non-empty question must have 2+ choices
              }
            >
              Create Election
            </Button>
          )}
        </CardContent>
      </Card>

      <Box sx={{ display: 'flex', gap: 2, justifyContent: 'center' }}>
        <Button variant='outlined' onClick={onBack} disabled={isLoading}>
          Back
        </Button>
        <Button variant='contained' onClick={onNext} disabled={!electionCreated}>
          Next
        </Button>
      </Box>
    </Box>
  )
}
