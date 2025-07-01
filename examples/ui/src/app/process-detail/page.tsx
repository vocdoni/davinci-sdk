import { Suspense } from 'react';
import { CircularProgress, Box } from '@mui/material';
import { ThemeProvider, createTheme } from '@mui/material';
import Layout from '@/components/layout/Layout';
import ProcessDetailClient from './ProcessDetailClient';

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

function ProcessDetailLoading() {
  return (
    <ThemeProvider theme={theme}>
      <Layout>
        <Box sx={{ display: 'flex', justifyContent: 'center', py: 8 }}>
          <CircularProgress />
        </Box>
      </Layout>
    </ThemeProvider>
  );
}

export default function ProcessDetailPage() {
  return (
    <Suspense fallback={<ProcessDetailLoading />}>
      <ProcessDetailClient />
    </Suspense>
  );
}
