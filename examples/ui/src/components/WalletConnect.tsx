import AccountBalanceWalletIcon from '@mui/icons-material/AccountBalanceWallet'
import {
  Alert,
  Box,
  Button,
  Card,
  CardContent,
  CircularProgress,
  Link,
  Tab,
  Tabs,
  TextField,
  Typography,
} from '@mui/material'
import { BrowserProvider, JsonRpcProvider, JsonRpcSigner, Wallet } from 'ethers'
import { useState } from 'react'
import { getAddressUrl } from '../utils/explorerUrl'

interface WalletConnectProps {
  onWalletConnected: (wallet: Wallet | JsonRpcSigner) => void
}

export default function WalletConnect({ onWalletConnected }: WalletConnectProps) {
  const [activeTab, setActiveTab] = useState(0)
  const [privateKey, setPrivateKey] = useState('')
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(false)
  const [balance, setBalance] = useState<string | null>(null)
  const [address, setAddress] = useState<string | null>(null)

  const handleTabChange = (_event: React.SyntheticEvent, newValue: number) => {
    setActiveTab(newValue)
    setError('')
  }

  const connectWithMetaMask = async () => {
    try {
      setLoading(true)
      setError('')

      if (!window.ethereum) {
        throw new Error('MetaMask is not installed')
      }

      await window.ethereum.request({ method: 'eth_requestAccounts' })
      const provider = new BrowserProvider(window.ethereum)
      const signer = await provider.getSigner()
      const address = await signer.getAddress()
      const balance = await provider.getBalance(address)

      setAddress(address)
      setBalance(formatEther(balance))
      onWalletConnected(signer)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to connect to MetaMask')
    } finally {
      setLoading(false)
    }
  }

  const connectWithPrivateKey = async () => {
    try {
      setLoading(true)
      setError('')

      // Clean private key - remove 0x prefix if present
      const cleanPrivateKey = privateKey.startsWith('0x') ? privateKey.slice(2) : privateKey

      if (!cleanPrivateKey.match(/^[0-9a-fA-F]{64}$/)) {
        throw new Error('Invalid private key format. Must be 64 hex characters (with or without 0x prefix)')
      }

      const provider = new JsonRpcProvider(import.meta.env.RPC_URL)
      const wallet = new Wallet(cleanPrivateKey, provider)
      const address = await wallet.getAddress()
      const balance = await provider.getBalance(address)

      setAddress(address)
      setBalance(formatEther(balance))
      onWalletConnected(wallet)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to connect with private key')
    } finally {
      setLoading(false)
    }
  }

  const formatEther = (balance: bigint): string => {
    return (Number(balance) / 1e18).toFixed(4)
  }

  return (
    <Card sx={{ mb: 4 }}>
      <CardContent>
        <Typography variant='h6' gutterBottom>
          Connect Wallet
        </Typography>

        <Tabs value={activeTab} onChange={handleTabChange} sx={{ mb: 2 }}>
          <Tab label='MetaMask' />
          <Tab label='Private Key' />
        </Tabs>

        {activeTab === 0 && (
          <Box sx={{ textAlign: 'center' }}>
            <Button
              variant='contained'
              color='primary'
              startIcon={<AccountBalanceWalletIcon />}
              onClick={connectWithMetaMask}
              disabled={loading}
            >
              {loading ? 'Connecting...' : 'Connect MetaMask'}
            </Button>
          </Box>
        )}

        {activeTab === 1 && (
          <Box>
            <TextField
              fullWidth
              label='Private Key'
              variant='outlined'
              value={privateKey}
              onChange={(e) => setPrivateKey(e.target.value)}
              type='password'
              disabled={loading}
              sx={{ mb: 2 }}
            />
            <Button
              fullWidth
              variant='contained'
              color='primary'
              onClick={connectWithPrivateKey}
              disabled={loading || !privateKey}
            >
              {loading ? 'Connecting...' : 'Connect with Private Key'}
            </Button>
          </Box>
        )}

        {error && (
          <Alert severity='error' sx={{ mt: 2 }}>
            {error}
          </Alert>
        )}

        {loading && (
          <Box sx={{ display: 'flex', justifyContent: 'center', mt: 2 }}>
            <CircularProgress />
          </Box>
        )}

        {address && balance && (
          <Box sx={{ mt: 2 }}>
            <Typography variant='subtitle1' gutterBottom>
              Connected Wallet
            </Typography>
            <Typography variant='body2' sx={{ wordBreak: 'break-all' }}>
              Address:{' '}
              <Link href={getAddressUrl(address)} target='_blank' rel='noopener noreferrer'>
                {address}
              </Link>
            </Typography>
            <Typography variant='body2'>Balance: {balance} ETH</Typography>
            {Number(balance) < 0.01 && (
              <Alert severity='warning' sx={{ mt: 1 }}>
                Your balance is low. You need some Sepolia ETH to continue.
              </Alert>
            )}
          </Box>
        )}
      </CardContent>
    </Card>
  )
}
