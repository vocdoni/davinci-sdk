'use client';

import Layout from '@/components/layout/Layout';
import WelcomeScreen from '@/components/WelcomeScreen';
import { ThemeProvider, createTheme } from '@mui/material';

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

export default function Home() {
  return (
    <ThemeProvider theme={theme}>
      <Layout>
        <WelcomeScreen />
      </Layout>
    </ThemeProvider>
  );
}
