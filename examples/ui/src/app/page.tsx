'use client';

import { useState, useCallback } from 'react';
import Layout from '@/components/layout/Layout';
import WelcomeScreen from '@/components/WelcomeScreen';
import ConnectWalletScreen from '@/components/ConnectWalletScreen';
import StepIndicator from '@/components/StepIndicator';
import { ThemeProvider, createTheme, Box } from '@mui/material';
import { Wallet, JsonRpcSigner } from 'ethers';
import CreateOrganizationScreen from '@/components/CreateOrganizationScreen';

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

const STEPS = [
  'Welcome',
  'Connect Wallet',
  'Create Organization',
  'Configure Vote',
  'Review & Deploy'
] as const;

enum Step {
  Welcome,
  ConnectWallet,
  CreateOrganization,
  ConfigureVote,
  ReviewAndDeploy
}

export default function Home() {
  const [currentStep, setCurrentStep] = useState<Step>(Step.Welcome);
  const [wallet, setWallet] = useState<Wallet | JsonRpcSigner | null>(null);

  const handleWalletConnected = useCallback((connectedWallet: Wallet | JsonRpcSigner) => {
    setWallet(connectedWallet);
  }, []);

  const handleNext = () => {
    setCurrentStep(prev => prev + 1);
  };

  const handleBack = () => {
    setCurrentStep(prev => prev - 1);
  };

  const renderStep = () => {
    switch (currentStep) {
      case Step.Welcome:
        return <WelcomeScreen onNext={handleNext} />;
      case Step.ConnectWallet:
        return <ConnectWalletScreen onNext={handleNext} onBack={handleBack} onWalletConnected={handleWalletConnected} />;
      case Step.CreateOrganization:
        return wallet ? (
          <CreateOrganizationScreen onNext={handleNext} onBack={handleBack} wallet={wallet} />
        ) : (
          <WelcomeScreen onNext={handleNext} />
        );
      default:
        return <WelcomeScreen onNext={handleNext} />;
    }
  };

  return (
    <ThemeProvider theme={theme}>
      <Layout>
        <Box sx={{ width: '100%', maxWidth: 1200, mx: 'auto', px: 3 }}>
          <StepIndicator activeStep={currentStep} steps={STEPS} />
          {renderStep()}
        </Box>
      </Layout>
    </ThemeProvider>
  );
}
