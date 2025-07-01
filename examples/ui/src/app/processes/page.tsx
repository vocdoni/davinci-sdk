'use client';

import { useState, useEffect } from 'react';
import { useRouter } from 'next/navigation';
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
  Tooltip,
  Grid,
} from '@mui/material';
import ArrowBackIcon from '@mui/icons-material/ArrowBack';
import RefreshIcon from '@mui/icons-material/Refresh';
import VisibilityIcon from '@mui/icons-material/Visibility';
import { ThemeProvider, createTheme } from '@mui/material';
import Layout from '@/components/layout/Layout';
import { VocdoniApiService, GetProcessResponse } from '@vocdoni/davinci-sdk';

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

interface ProcessInfo {
  id: string;
  title: string;
  description: string;
  status: number;
  voteCount: string;
  startTime: number;
  isAcceptingVotes: boolean;
}

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

export default function ProcessesPage() {
  const router = useRouter();
  const [processes, setProcesses] = useState<ProcessInfo[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const loadProcesses = async () => {
    try {
      setIsLoading(true);
      setError(null);
      
      const api = new VocdoniApiService(process.env.API_URL || '');
      
      // Get list of process IDs
      const processIds = await api.listProcesses();
      
      // Reverse the order to get most recent first (assuming API returns oldest first)
      const reversedProcessIds = [...processIds].reverse();
      
      // Get detailed information for each process
      const processDetails: ProcessInfo[] = [];
      
      for (const processId of reversedProcessIds) {
        try {
          const processData: GetProcessResponse = await api.getProcess(processId);
          
          // Fetch metadata from metadataURI if available
          let title = 'Untitled Process';
          let description = 'No description available';
          
          if (processData.metadataURI) {
            try {
              // Extract hash from metadata URI
              const metadataHash = processData.metadataURI.split('/').pop();
              if (metadataHash) {
                const metadata = await api.getMetadata(metadataHash);
                title = metadata.title?.default || title;
                description = metadata.description?.default || description;
              }
            } catch (metadataErr) {
              console.warn(`Failed to load metadata for process ${processId}:`, metadataErr);
              // Use fallback from processData.metadata if available
              title = processData.metadata?.title?.default || title;
              description = processData.metadata?.description?.default || description;
            }
          }
          
          processDetails.push({
            id: processData.id,
            title,
            description,
            status: processData.status,
            voteCount: processData.voteCount,
            startTime: processData.startTime,
            isAcceptingVotes: processData.isAcceptingVotes,
          });
        } catch (err) {
          console.warn(`Failed to load process ${processId}:`, err);
          // Add basic info even if we can't get full details
          processDetails.push({
            id: processId,
            title: 'Process ' + processId.slice(0, 8) + '...',
            description: 'Unable to load process details',
            status: -1,
            voteCount: '0',
            startTime: 0,
            isAcceptingVotes: false,
          });
        }
      }
      
      // Sort by start time (newest first)
      processDetails.sort((a, b) => b.startTime - a.startTime);
      
      setProcesses(processDetails);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load processes');
      console.error('Error loading processes:', err);
    } finally {
      setIsLoading(false);
    }
  };

  useEffect(() => {
    loadProcesses();
  }, []);

  const formatDate = (timestamp: number | string) => {
    if (!timestamp || timestamp === 0) return 'Not set';
    try {
      // Handle ISO string format like "2025-07-01T07:41:14Z"
      const date = new Date(timestamp);
      if (isNaN(date.getTime())) return 'Invalid date';
      return date.toLocaleString();
    } catch (err) {
      return 'Invalid date';
    }
  };


  return (
    <ThemeProvider theme={theme}>
      <Layout>
        <Box sx={{ width: '100%', maxWidth: 1200, mx: 'auto', px: 3, py: 4 }}>
          {/* Header */}
          <Box sx={{ display: 'flex', alignItems: 'center', mb: 4 }}>
            <IconButton 
              onClick={() => router.push('/')} 
              sx={{ mr: 2 }}
              aria-label="Go back to home"
            >
              <ArrowBackIcon />
            </IconButton>
            <Typography variant="h4" component="h1" sx={{ flexGrow: 1 }}>
              Existing Processes
            </Typography>
            <Button
              variant="outlined"
              startIcon={<RefreshIcon />}
              onClick={loadProcesses}
              disabled={isLoading}
            >
              Refresh
            </Button>
          </Box>

          <Typography variant="body1" color="text.secondary" paragraph sx={{ mb: 4 }}>
            Browse all existing voting processes on the network. You can view details and check the status of each process.
          </Typography>

          {/* Content */}
          {error ? (
            <Alert severity="error" sx={{ mb: 4 }}>
              {error}
            </Alert>
          ) : isLoading ? (
            <Box sx={{ display: 'flex', justifyContent: 'center', py: 8 }}>
              <CircularProgress />
            </Box>
          ) : processes.length === 0 ? (
            <Card>
              <CardContent sx={{ textAlign: 'center', py: 8 }}>
                <Typography variant="h6" color="text.secondary" gutterBottom>
                  No Processes Found
                </Typography>
                <Typography variant="body2" color="text.secondary">
                  There are no voting processes available on this network yet.
                </Typography>
              </CardContent>
            </Card>
          ) : (
            <Box sx={{ display: 'grid', gridTemplateColumns: { xs: '1fr', md: 'repeat(2, 1fr)', lg: 'repeat(3, 1fr)' }, gap: 3 }}>
              {processes.map((process) => (
                <Box key={process.id}>
                  <Card sx={{ height: '100%', display: 'flex', flexDirection: 'column' }}>
                    <CardContent sx={{ flexGrow: 1 }}>
                      <Box sx={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', mb: 2 }}>
                        <Typography variant="h6" component="h2" sx={{ flexGrow: 1, mr: 1 }}>
                          {process.title}
                        </Typography>
                        <Chip
                          label={getStatusText(process.status)}
                          color={getStatusColor(process.status) as any}
                          size="small"
                        />
                      </Box>

                      <Typography variant="body2" color="text.secondary" paragraph>
                        {process.description}
                      </Typography>

                      <List dense>
                        <ListItem disablePadding>
                          <ListItemText
                            primary="Process ID"
                            secondary={`${process.id.slice(0, 8)}...${process.id.slice(-8)}`}
                            primaryTypographyProps={{ variant: 'caption' }}
                            secondaryTypographyProps={{ variant: 'body2', fontFamily: 'monospace' }}
                          />
                        </ListItem>
                        <ListItem disablePadding>
                          <ListItemText
                            primary="Votes"
                            secondary={process.voteCount}
                            primaryTypographyProps={{ variant: 'caption' }}
                            secondaryTypographyProps={{ variant: 'body2' }}
                          />
                        </ListItem>
                        <ListItem disablePadding>
                          <ListItemText
                            primary="Start Time"
                            secondary={formatDate(process.startTime)}
                            primaryTypographyProps={{ variant: 'caption' }}
                            secondaryTypographyProps={{ variant: 'body2' }}
                          />
                        </ListItem>
                        <ListItem disablePadding>
                          <ListItemText
                            primary="Accepting Votes"
                            secondary={process.isAcceptingVotes ? 'Yes' : 'No'}
                            primaryTypographyProps={{ variant: 'caption' }}
                            secondaryTypographyProps={{ variant: 'body2' }}
                          />
                        </ListItem>
                      </List>
                    </CardContent>

                    <Box sx={{ p: 2, pt: 0 }}>
                      <Tooltip title="View process details">
                        <Box
                          onClick={() => router.push(`/process-detail?id=${process.id}`)}
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
                              backgroundColor: 'action.hover'
                            }
                          }}
                        >
                          <VisibilityIcon fontSize="small" />
                        </Box>
                      </Tooltip>
                    </Box>
                  </Card>
                </Box>
              ))}
            </Box>
          )}
        </Box>
      </Layout>
    </ThemeProvider>
  );
}
