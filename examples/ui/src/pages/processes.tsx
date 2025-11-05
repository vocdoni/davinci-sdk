import Layout from '@/components/layout/Layout'
import ArrowBackIcon from '@mui/icons-material/ArrowBack'
import RefreshIcon from '@mui/icons-material/Refresh'
import VisibilityIcon from '@mui/icons-material/Visibility'
import {
  Alert,
  Box,
  Button,
  Card,
  CardContent,
  Chip,
  CircularProgress,
  IconButton,
  List,
  ListItem,
  ListItemText,
  Pagination,
  ThemeProvider,
  Tooltip,
  Typography,
  createTheme,
} from '@mui/material'
import { DavinciSDK, type GetProcessResponse } from '@vocdoni/davinci-sdk'
import { Wallet } from 'ethers'
import { useEffect, useState } from 'react'
import { useNavigate } from 'react-router'

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
})

interface ProcessInfo {
  id: string
  title: string
  description: string
  status: number
  voteCount: string
  startTime: number
  isAcceptingVotes: boolean
}

const getStatusText = (status: number) => {
  switch (status) {
    case 0:
      return 'Ready'
    case 1:
      return 'Paused'
    case 2:
      return 'Ended'
    case 3:
      return 'Canceled'
    case 4:
      return 'Results'
    default:
      return 'Unknown'
  }
}

const getStatusColor = (status: number) => {
  switch (status) {
    case 0:
      return 'success'
    case 1:
      return 'warning'
    case 2:
      return 'error'
    case 3:
      return 'error'
    case 4:
      return 'info'
    default:
      return 'default'
  }
}

const PAGE_SIZE = 15

export default function ProcessesPage() {
  const navigate = useNavigate()
  const [processes, setProcesses] = useState<ProcessInfo[]>([])
  const [isLoading, setIsLoading] = useState(true)
  const [isLoadingPage, setIsLoadingPage] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [currentPage, setCurrentPage] = useState(1)
  const [totalProcesses, setTotalProcesses] = useState(0)
  const [allProcessIds, setAllProcessIds] = useState<string[]>([])

  const loadAllProcessIds = async () => {
    try {
      setIsLoading(true)
      setError(null)

      // Create a temporary wallet for SDK init (not used for any operations)
      const tempWallet = Wallet.createRandom()
      const sdk = new DavinciSDK({
        signer: tempWallet,
        sequencerUrl: import.meta.env.SEQUENCER_API_URL
      })
      await sdk.init()

      // Get list of process IDs (lightweight operation)
      const processIds = await sdk.api.sequencer.listProcesses()

      // Reverse the order to get most recent first
      const reversedProcessIds = [...processIds].reverse()

      setAllProcessIds(reversedProcessIds)
      setTotalProcesses(reversedProcessIds.length)

      // Load first page
      await loadPage(1, reversedProcessIds)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load processes')
      console.error('Error loading processes:', err)
      setIsLoading(false)
    }
  }

  const loadPage = async (page: number, processIds?: string[]) => {
    try {
      const idsToUse = processIds || allProcessIds
      if (idsToUse.length === 0) return

      setIsLoadingPage(true)
      setError(null)

      // Create a temporary wallet for SDK init (not used for any operations)
      const tempWallet = Wallet.createRandom()
      const sdk = new DavinciSDK({
        signer: tempWallet,
        sequencerUrl: import.meta.env.SEQUENCER_API_URL
      })
      await sdk.init()

      // Calculate pagination
      const startIndex = (page - 1) * PAGE_SIZE
      const endIndex = startIndex + PAGE_SIZE
      const pageProcessIds = idsToUse.slice(startIndex, endIndex)

      // Load processes in parallel for better performance
      const processPromises = pageProcessIds.map(async (processId) => {
        try {
          const processData: GetProcessResponse = await sdk.api.sequencer.getProcess(processId)

          // Load metadata separately
          let title = 'Untitled Process'
          let description = 'No description available'

          if (processData.metadataURI) {
            try {
              const metadataHash = processData.metadataURI.split('/').pop()
              if (metadataHash) {
                const metadata = await sdk.api.sequencer.getMetadata(metadataHash)
                title = metadata.title?.default || title
                description = metadata.description?.default || description
              }
            } catch (metadataErr) {
              console.warn(`Failed to load metadata for process ${processId}:`, metadataErr)
              // Use fallback from processData.metadata if available
              title = processData.metadata?.title?.default || title
              description = processData.metadata?.description?.default || description
            }
          }

          return {
            id: processData.id,
            title,
            description,
            status: processData.status,
            voteCount: processData.voteCount,
            startTime: processData.startTime,
            isAcceptingVotes: processData.isAcceptingVotes,
          }
        } catch (err) {
          console.warn(`Failed to load process ${processId}:`, err)
          return {
            id: processId,
            title: 'Process ' + processId.slice(0, 8) + '...',
            description: 'Unable to load process details',
            status: -1,
            voteCount: '0',
            startTime: 0,
            isAcceptingVotes: false,
          }
        }
      })

      // Execute all requests in parallel
      const processDetails = await Promise.all(processPromises)

      // Sort by start time (newest first)
      processDetails.sort((a, b) => b.startTime - a.startTime)

      setProcesses(processDetails)
      setCurrentPage(page)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load page')
      console.error('Error loading page:', err)
    } finally {
      setIsLoading(false)
      setIsLoadingPage(false)
    }
  }

  const handlePageChange = (_event: React.ChangeEvent<unknown>, page: number) => {
    loadPage(page)
  }

  const handleRefresh = () => {
    setCurrentPage(1)
    loadAllProcessIds()
  }

  useEffect(() => {
    loadAllProcessIds()
  }, [])

  const formatDate = (timestamp: number | string) => {
    if (!timestamp || timestamp === 0) return 'Not set'
    try {
      // Handle ISO string format like "2025-07-01T07:41:14Z"
      const date = new Date(timestamp)
      if (isNaN(date.getTime())) return 'Invalid date'
      return date.toLocaleString()
    } catch (err) {
      return 'Invalid date'
    }
  }

  return (
    <ThemeProvider theme={theme}>
      <Layout>
        <Box sx={{ width: '100%', maxWidth: 1200, mx: 'auto', px: 3, py: 4 }}>
          {/* Header */}
          <Box sx={{ display: 'flex', alignItems: 'center', mb: 4 }}>
            <IconButton onClick={() => navigate('/')} sx={{ mr: 2 }} aria-label='Go back to home'>
              <ArrowBackIcon />
            </IconButton>
            <Typography variant='h4' component='h1' sx={{ flexGrow: 1 }}>
              Existing Processes
            </Typography>
            <Button variant='outlined' startIcon={<RefreshIcon />} onClick={handleRefresh} disabled={isLoading}>
              Refresh
            </Button>
          </Box>

          <Typography variant='body1' color='text.secondary' paragraph sx={{ mb: 4 }}>
            Browse all existing voting processes on the network. You can view details and check the status of each
            process.
          </Typography>

          {/* Content */}
          {error ? (
            <Alert severity='error' sx={{ mb: 4 }}>
              {error}
            </Alert>
          ) : isLoading ? (
            <Box sx={{ display: 'flex', justifyContent: 'center', py: 8 }}>
              <CircularProgress />
            </Box>
          ) : processes.length === 0 ? (
            <Card>
              <CardContent sx={{ textAlign: 'center', py: 8 }}>
                <Typography variant='h6' color='text.secondary' gutterBottom>
                  No Processes Found
                </Typography>
                <Typography variant='body2' color='text.secondary'>
                  There are no voting processes available on this network yet.
                </Typography>
              </CardContent>
            </Card>
          ) : (
            <>
              {/* Page Info */}
              <Box sx={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', mb: 3 }}>
                <Typography variant='body2' color='text.secondary'>
                  Showing {(currentPage - 1) * PAGE_SIZE + 1}-{Math.min(currentPage * PAGE_SIZE, totalProcesses)} of{' '}
                  {totalProcesses} processes
                </Typography>
                {isLoadingPage && (
                  <Box sx={{ display: 'flex', alignItems: 'center', gap: 1 }}>
                    <CircularProgress size={16} />
                    <Typography variant='body2' color='text.secondary'>
                      Loading...
                    </Typography>
                  </Box>
                )}
              </Box>

              {/* Processes Grid */}
              <Box
                sx={{
                  display: 'grid',
                  gridTemplateColumns: { xs: '1fr', md: 'repeat(2, 1fr)', lg: 'repeat(3, 1fr)' },
                  gap: 3,
                  mb: 4,
                }}
              >
                {processes.map((process) => (
                  <Box key={process.id}>
                    <Card sx={{ height: '100%', display: 'flex', flexDirection: 'column' }}>
                      <CardContent sx={{ flexGrow: 1 }}>
                        <Box sx={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', mb: 2 }}>
                          <Typography variant='h6' component='h2' sx={{ flexGrow: 1, mr: 1 }}>
                            {process.title}
                          </Typography>
                          <Chip
                            label={getStatusText(process.status)}
                            color={getStatusColor(process.status) as any}
                            size='small'
                          />
                        </Box>

                        <Typography variant='body2' color='text.secondary' paragraph>
                          {process.description}
                        </Typography>

                        <List dense>
                          <ListItem disablePadding>
                            <ListItemText
                              primary='Process ID'
                              secondary={`${process.id.slice(0, 8)}...${process.id.slice(-8)}`}
                              primaryTypographyProps={{ variant: 'caption' }}
                              secondaryTypographyProps={{ variant: 'body2', fontFamily: 'monospace' }}
                            />
                          </ListItem>
                          <ListItem disablePadding>
                            <ListItemText
                              primary='Votes'
                              secondary={process.voteCount}
                              primaryTypographyProps={{ variant: 'caption' }}
                              secondaryTypographyProps={{ variant: 'body2' }}
                            />
                          </ListItem>
                          <ListItem disablePadding>
                            <ListItemText
                              primary='Start Time'
                              secondary={formatDate(process.startTime)}
                              primaryTypographyProps={{ variant: 'caption' }}
                              secondaryTypographyProps={{ variant: 'body2' }}
                            />
                          </ListItem>
                          <ListItem disablePadding>
                            <ListItemText
                              primary='Accepting Votes'
                              secondary={process.isAcceptingVotes ? 'Yes' : 'No'}
                              primaryTypographyProps={{ variant: 'caption' }}
                              secondaryTypographyProps={{ variant: 'body2' }}
                            />
                          </ListItem>
                        </List>
                      </CardContent>

                      <Box sx={{ p: 2, pt: 0 }}>
                        <Tooltip title='View process details'>
                          <Box
                            onClick={() => navigate(`/process-detail/${process.id}`)}
                            sx={{
                              border: 1,
                              borderColor: 'divider',
                              borderRadius: 1,
                              display: 'flex',
                              justifyContent: 'center',
                              alignItems: 'center',
                              py: 1,
                              cursor: 'pointer',
                              '&:hover': {
                                backgroundColor: 'action.hover',
                              },
                            }}
                          >
                            <VisibilityIcon fontSize='small' />
                          </Box>
                        </Tooltip>
                      </Box>
                    </Card>
                  </Box>
                ))}
              </Box>

              {/* Pagination Controls */}
              {totalProcesses > PAGE_SIZE && (
                <Box sx={{ display: 'flex', justifyContent: 'center', mt: 4 }}>
                  <Pagination
                    count={Math.ceil(totalProcesses / PAGE_SIZE)}
                    page={currentPage}
                    onChange={handlePageChange}
                    color='primary'
                    size='large'
                    showFirstButton
                    showLastButton
                    disabled={isLoadingPage}
                  />
                </Box>
              )}
            </>
          )}
        </Box>
      </Layout>
    </ThemeProvider>
  )
}
