import CensusCreationScreen from '@/components/CensusCreationScreen'
import CheckElectionScreen from '@/components/CheckElectionScreen'
import ConnectWalletScreen from '@/components/ConnectWalletScreen'
import CreateElectionScreen from '@/components/CreateElectionScreen'
import EndProcessScreen from '@/components/EndProcessScreen'
import Layout from '@/components/layout/Layout'
import ShowResultsScreen from '@/components/ShowResultsScreen'
import StepIndicator from '@/components/StepIndicator'
import VotingScreen from '@/components/VotingScreen'
import WelcomeScreen from '@/components/WelcomeScreen'
import { Box, ThemeProvider, createTheme } from '@mui/material'
import { PlainCensus } from '@vocdoni/davinci-sdk'
import { JsonRpcSigner, Wallet } from 'ethers'
import { useCallback, useState } from 'react'

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

const STEPS = [
  'Welcome',
  'Connect Wallet',
  'Create Census',
  'Create Election',
  'Check Election Status',
  'Vote',
  'End Process',
  'Show Results',
]

const Step = {
  Welcome: 0,
  ConnectWallet: 1,
  CreateCensus: 2,
  CreateElection: 3,
  CheckElectionStatus: 4,
  Vote: 5,
  EndProcess: 6,
  ShowResults: 7,
}

export default function Home() {
  const [currentStep, setCurrentStep] = useState<number>(Step.Welcome)
  const [wallet, setWallet] = useState<Wallet | JsonRpcSigner | null>(null)
  const [census, setCensus] = useState<PlainCensus | null>(null)

  const handleWalletConnected = useCallback((connectedWallet: Wallet | JsonRpcSigner) => {
    setWallet(connectedWallet)
  }, [])

  const handleNext = () => {
    setCurrentStep((prev) => prev + 1)
  }

  const handleBack = () => {
    setCurrentStep((prev) => prev - 1)
  }

  const renderStep = () => {
    switch (currentStep) {
      case Step.Welcome:
        return <WelcomeScreen onNext={handleNext} />
      case Step.ConnectWallet:
        return <ConnectWalletScreen onNext={handleNext} onBack={handleBack} onWalletConnected={handleWalletConnected} />
      case Step.CreateCensus:
        return (
          <CensusCreationScreen
            onNext={(createdCensus) => {
              setCensus(createdCensus)
              handleNext()
            }}
            onBack={handleBack}
          />
        )
      case Step.CreateElection:
        return wallet && census ? (
          <CreateElectionScreen onNext={handleNext} onBack={handleBack} wallet={wallet} census={census} />
        ) : (
          <WelcomeScreen onNext={handleNext} />
        )
      case Step.CheckElectionStatus:
        return wallet ? (
          <CheckElectionScreen onNext={handleNext} onBack={handleBack} wallet={wallet} />
        ) : (
          <WelcomeScreen onNext={handleNext} />
        )
      case Step.Vote:
        return <VotingScreen onNext={() => setCurrentStep(Step.EndProcess)} onBack={handleBack} />
      case Step.EndProcess:
        return wallet ? (
          <EndProcessScreen onNext={() => setCurrentStep(Step.ShowResults)} onBack={handleBack} wallet={wallet} />
        ) : (
          <WelcomeScreen onNext={handleNext} />
        )
      case Step.ShowResults:
        return wallet ? (
          <ShowResultsScreen onNext={() => setCurrentStep(Step.Welcome)} onBack={handleBack} wallet={wallet} />
        ) : (
          <WelcomeScreen onNext={handleNext} />
        )
      default:
        return <WelcomeScreen onNext={handleNext} />
    }
  }

  return (
    <ThemeProvider theme={theme}>
      <Layout>
        <Box sx={{ width: '100%', maxWidth: 1200, mx: 'auto', px: 3 }}>
          <StepIndicator activeStep={currentStep} steps={STEPS} />
          {renderStep()}
        </Box>
      </Layout>
    </ThemeProvider>
  )
}
