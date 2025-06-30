'use client';

import { useState, useCallback } from 'react';
import Layout from '@/components/layout/Layout';
import WelcomeScreen from '@/components/WelcomeScreen';
import ConnectWalletScreen from '@/components/ConnectWalletScreen';
import StepIndicator from '@/components/StepIndicator';
import { ThemeProvider, createTheme, Box } from '@mui/material';
import { Wallet, JsonRpcSigner } from 'ethers';
import CensusCreationScreen from '@/components/CensusCreationScreen';
import CreateElectionScreen from '@/components/CreateElectionScreen';
import CheckElectionScreen from '@/components/CheckElectionScreen';
import VotingScreen from '@/components/VotingScreen';
import EndProcessScreen from '@/components/EndProcessScreen';
import ShowResultsScreen from '@/components/ShowResultsScreen';

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
  'Create Census',
  'Create Election',
  'Check Election Status',
  'Vote',
  'End Process',
  'Show Results'
] as const;

enum Step {
  Welcome,
  ConnectWallet,
  CreateCensus,
  CreateElection,
  CheckElectionStatus,
  Vote,
  EndProcess,
  ShowResults
}

export default function Home() {
  const [currentStep, setCurrentStep] = useState<Step>(Step.Welcome);
  const [wallet, setWallet] = useState<Wallet | JsonRpcSigner | null>(null);
  const [censusId, setCensusId] = useState<string | null>(null);

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
      case Step.CreateCensus:
        return <CensusCreationScreen 
          onNext={(id) => {
            setCensusId(id);
            handleNext();
          }} 
          onBack={handleBack} 
        />;
      case Step.CreateElection:
        return wallet && censusId ? (
          <CreateElectionScreen
            onNext={handleNext}
            onBack={handleBack}
            wallet={wallet}
            censusId={censusId}
          />
        ) : (
          <WelcomeScreen onNext={handleNext} />
        );
      case Step.CheckElectionStatus:
        return <CheckElectionScreen onNext={handleNext} onBack={handleBack} />;
      case Step.Vote:
        return <VotingScreen onNext={() => setCurrentStep(Step.EndProcess)} onBack={handleBack} />;
      case Step.EndProcess:
        return wallet ? (
          <EndProcessScreen onNext={() => setCurrentStep(Step.ShowResults)} onBack={handleBack} wallet={wallet} />
        ) : (
          <WelcomeScreen onNext={handleNext} />
        );
      case Step.ShowResults:
        return wallet ? (
          <ShowResultsScreen onNext={() => setCurrentStep(Step.Welcome)} onBack={handleBack} wallet={wallet} />
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
