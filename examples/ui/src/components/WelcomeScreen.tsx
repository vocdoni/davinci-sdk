import CheckCircleIcon from '@mui/icons-material/CheckCircle'
import ErrorIcon from '@mui/icons-material/Error'
import ListIcon from '@mui/icons-material/List'
import RefreshIcon from '@mui/icons-material/Refresh'
import {
  Alert,
  Box,
  Button,
  Card,
  CardContent,
  CircularProgress,
  Link,
  List,
  ListItem,
  ListItemIcon,
  ListItemText,
  Tooltip,
  Typography,
} from '@mui/material'
import { VocdoniApiService } from '@vocdoni/davinci-sdk'
import { useEffect, useState } from 'react'
import { useNavigate } from 'react-router'
import { getContractAddresses, logAddressConfiguration } from '../utils/contractAddresses'
import { getAddressUrl } from '../utils/explorerUrl'

interface WelcomeScreenProps {
  onNext: () => void
}

export default function WelcomeScreen({ onNext }: WelcomeScreenProps) {
  const navigate = useNavigate()
  const [isConnected, setIsConnected] = useState<boolean>(false)
  const [isLoading, setIsLoading] = useState<boolean>(true)
  const [error, setError] = useState<string>('')
  const [apiAddresses, setApiAddresses] = useState<{
    process: string
    organization: string
  } | null>(null)
  const [contractAddresses, setContractAddresses] = useState<{
    organizationRegistry: string
    processRegistry: string
  } | null>(null)

  useEffect(() => {
    checkConnection()
  }, [])

  const checkConnection = async () => {
    try {
      setIsLoading(true)
      setError('')
      
      // Log address configuration
      logAddressConfiguration()
      
      const api = new VocdoniApiService({
        sequencerURL: import.meta.env.SEQUENCER_API_URL,
        censusURL: import.meta.env.CENSUS_API_URL
      })
      await api.sequencer.ping()
      const info = await api.sequencer.getInfo()
      
      // Get contract addresses using sequencer info
      const addresses = getContractAddresses(info.contracts)
      setContractAddresses(addresses)
      
      setApiAddresses({
        process: info.contracts.process.toLowerCase(),
        organization: info.contracts.organization.toLowerCase(),
      })
      setIsConnected(true)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to connect to API')
      setIsConnected(false)
    } finally {
      setIsLoading(false)
    }
  }

  return (
    <Box sx={{ maxWidth: 800, mx: 'auto', textAlign: 'center' }}>
      <Typography variant='h4' component='h1' gutterBottom>
        Welcome to DAVINCI Demo
      </Typography>

      <Typography variant='h6' color='primary' gutterBottom sx={{ fontStyle: 'italic' }}>
        Decentralized Autonomous Vote Integrity Network with Cryptographic Inference
      </Typography>

      <Typography variant='body1' color='text.secondary' paragraph sx={{ mb: 4 }}>
        DAVINCI is a voting protocol designed for mass adoption, privacy, and security. It enables high-frequency,
        low-cost elections while ensuring transparency, censorship resistance, anticoercion and integrity.
      </Typography>

      <Card sx={{ mb: 4 }}>
        <CardContent>
          <Typography variant='h6' gutterBottom>
            Connection Status
          </Typography>

          {isLoading ? (
            <Box sx={{ display: 'flex', justifyContent: 'center', my: 2 }}>
              <CircularProgress />
            </Box>
          ) : error ? (
            <Box>
              <Alert severity='error' sx={{ mb: 2 }}>
                {error}
              </Alert>
              <Button
                variant='outlined'
                color='primary'
                onClick={checkConnection}
                startIcon={<RefreshIcon />}
                disabled={isLoading}
              >
                Retry Connection
              </Button>
            </Box>
          ) : isConnected ? (
            <Alert severity='success' sx={{ mb: 2 }}>
              Connected to Vocdoni API
            </Alert>
          ) : null}

          <Typography variant='h6' gutterBottom sx={{ mt: 3 }}>
            Network Information
          </Typography>

          <List>
            <ListItem>
              <ListItemText primary='Network' secondary='Sepolia Testnet' />
            </ListItem>
            {contractAddresses && (
              <>
                <ListItem>
                  <Tooltip
                    title={
                      apiAddresses && contractAddresses && apiAddresses.organization === contractAddresses.organizationRegistry.toLowerCase()
                        ? 'Contract address verified'
                        : 'Contract address mismatch between SDK and API'
                    }
                  >
                    <ListItemIcon>
                      {apiAddresses && contractAddresses ? (
                        apiAddresses.organization === contractAddresses.organizationRegistry.toLowerCase() ? (
                          <CheckCircleIcon color='success' />
                        ) : (
                          <ErrorIcon color='error' />
                        )
                      ) : (
                        <CircularProgress size={24} />
                      )}
                    </ListItemIcon>
                  </Tooltip>
                  <ListItemText
                    primary='Organization Registry Contract'
                    secondary={
                      <Link
                        href={getAddressUrl(contractAddresses.organizationRegistry)}
                        target='_blank'
                        rel='noopener noreferrer'
                        color='primary'
                      >
                        {contractAddresses.organizationRegistry}
                      </Link>
                    }
                  />
                </ListItem>
                <ListItem>
                  <Tooltip
                    title={
                      apiAddresses && contractAddresses && apiAddresses.process === contractAddresses.processRegistry.toLowerCase()
                        ? 'Contract address verified'
                        : 'Contract address mismatch between SDK and API'
                    }
                  >
                    <ListItemIcon>
                      {apiAddresses && contractAddresses ? (
                        apiAddresses.process === contractAddresses.processRegistry.toLowerCase() ? (
                          <CheckCircleIcon color='success' />
                        ) : (
                          <ErrorIcon color='error' />
                        )
                      ) : (
                        <CircularProgress size={24} />
                      )}
                    </ListItemIcon>
                  </Tooltip>
                  <ListItemText
                    primary='Process Registry Contract'
                    secondary={
                      <Link
                        href={getAddressUrl(contractAddresses.processRegistry)}
                        target='_blank'
                        rel='noopener noreferrer'
                        color='primary'
                      >
                        {contractAddresses.processRegistry}
                      </Link>
                    }
                  />
                </ListItem>
              </>
            )}
          </List>
        </CardContent>
      </Card>

      {apiAddresses && contractAddresses &&
      (apiAddresses.process !== contractAddresses.processRegistry.toLowerCase() ||
        apiAddresses.organization !== contractAddresses.organizationRegistry.toLowerCase()) ? (
        <Alert severity='error' sx={{ mb: 2 }}>
          Contract addresses mismatch between SDK and API. Please check the configuration.
        </Alert>
      ) : null}

      <Box sx={{ display: 'flex', gap: 2, justifyContent: 'center', flexWrap: 'wrap' }}>
        <Button
          variant='outlined'
          color='primary'
          size='large'
          startIcon={<ListIcon />}
          disabled={!isConnected || isLoading}
          onClick={() => navigate('/processes')}
          sx={{ minWidth: 200 }}
        >
          View Existing Processes
        </Button>

        <Button
          variant='contained'
          color='primary'
          size='large'
          disabled={
            !isConnected ||
            isLoading ||
            Boolean(
              apiAddresses && contractAddresses &&
                (apiAddresses.process !== contractAddresses.processRegistry.toLowerCase() ||
                  apiAddresses.organization !== contractAddresses.organizationRegistry.toLowerCase())
            )
          }
          onClick={onNext}
          endIcon={isLoading ? <CircularProgress size={20} color='inherit' /> : null}
          sx={{ minWidth: 200 }}
        >
          {isLoading ? 'Checking Connection...' : 'Create New Process'}
        </Button>
      </Box>

      <Typography variant='body2' color='text.secondary' sx={{ mt: 2 }}>
        Browse existing voting processes on the network or start creating a new one
      </Typography>
    </Box>
  )
}
