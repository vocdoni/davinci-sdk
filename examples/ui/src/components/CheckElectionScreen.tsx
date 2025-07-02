import CheckCircleIcon from '@mui/icons-material/CheckCircle'
import PendingIcon from '@mui/icons-material/Pending'
import {
  Alert,
  Box,
  Button,
  Card,
  CardContent,
  CircularProgress,
  List,
  ListItem,
  ListItemIcon,
  ListItemText,
  Typography,
} from '@mui/material'
import { VocdoniApiService } from '@vocdoni/davinci-sdk'
import { useEffect, useState } from 'react'

interface CheckElectionScreenProps {
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
}

export default function CheckElectionScreen({ onBack, onNext }: CheckElectionScreenProps) {
  const [isLoading, setIsLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [electionReady, setElectionReady] = useState(false)
  const [checkStatus, setCheckStatus] = useState({
    detailsLoaded: false,
    processExists: false,
    acceptingVotes: false,
  })
  const [waitTime, setWaitTime] = useState(0)

  useEffect(() => {
    const checkElection = async () => {
      try {
        // Get election details from localStorage
        const detailsStr = localStorage.getItem('electionDetails')
        if (!detailsStr) {
          throw new Error('Election details not found')
        }
        const details: ElectionDetails = JSON.parse(detailsStr)
        setCheckStatus((prev) => ({ ...prev, detailsLoaded: true }))

        const api = new VocdoniApiService(import.meta.env.API_URL)

        // Start polling for process status and update wait time
        const startTime = Date.now()
        const pollInterval = setInterval(async () => {
          setWaitTime(Math.floor((Date.now() - startTime) / 1000))
          try {
            const process = await api.getProcess(details.processId)
            setCheckStatus((prev) => ({ ...prev, processExists: true }))

            if (process.isAcceptingVotes) {
              setCheckStatus((prev) => ({ ...prev, acceptingVotes: true }))
              setElectionReady(true)
              clearInterval(pollInterval)
            }
          } catch (err) {
            console.log('Process not ready yet, retrying...')
          }
        }, 5000) // Poll every 5 seconds

        // Cleanup interval on unmount
        return () => clearInterval(pollInterval)
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Failed to check election status')
        console.error('Error checking election:', err)
      } finally {
        setIsLoading(false)
      }
    }

    checkElection()
  }, [])

  const renderCheckItem = (label: string, checked: boolean, inProgress: boolean) => (
    <ListItem>
      <ListItemIcon>
        {checked ? (
          <CheckCircleIcon color='success' />
        ) : inProgress ? (
          <CircularProgress size={24} />
        ) : (
          <PendingIcon color='action' />
        )}
      </ListItemIcon>
      <ListItemText primary={label} />
    </ListItem>
  )

  return (
    <Box sx={{ maxWidth: 800, mx: 'auto', textAlign: 'center' }}>
      <Typography variant='h4' component='h1' gutterBottom>
        Checking Election Status
      </Typography>

      <Typography variant='body1' color='text.secondary' paragraph sx={{ mb: 4 }}>
        Please wait while we verify that your election is ready for voting.
      </Typography>

      <Card sx={{ mb: 4 }}>
        <CardContent>
          {error ? (
            <Alert severity='error' sx={{ mb: 2 }}>
              {error}
            </Alert>
          ) : (
            <>
              <List>
                {renderCheckItem('Election details loaded', checkStatus.detailsLoaded, false)}
                {renderCheckItem(
                  'Election process created',
                  checkStatus.processExists,
                  !checkStatus.processExists && checkStatus.detailsLoaded
                )}
                {renderCheckItem(
                  'Election ready for voting',
                  checkStatus.acceptingVotes,
                  !checkStatus.acceptingVotes && checkStatus.processExists
                )}
              </List>

              {!electionReady && checkStatus.processExists && (
                <Typography variant='body2' color='text.secondary' sx={{ mt: 2 }}>
                  Waiting for {waitTime} seconds...
                </Typography>
              )}

              {isLoading && (
                <Box sx={{ display: 'flex', justifyContent: 'center', mt: 2 }}>
                  <CircularProgress />
                </Box>
              )}

              {electionReady && (
                <Alert severity='success' sx={{ mt: 2 }}>
                  Election is ready for voting!
                </Alert>
              )}
            </>
          )}
        </CardContent>
      </Card>

      <Box sx={{ display: 'flex', gap: 2, justifyContent: 'center' }}>
        <Button variant='outlined' onClick={onBack} disabled={isLoading}>
          Back
        </Button>
        <Button variant='contained' onClick={onNext} disabled={!electionReady}>
          Start Voting
        </Button>
      </Box>
    </Box>
  )
}
