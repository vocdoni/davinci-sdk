import { useWallets } from '@/context/WalletContext'
import AddIcon from '@mui/icons-material/Add'
import ContentCopyIcon from '@mui/icons-material/ContentCopy'
import DeleteIcon from '@mui/icons-material/Delete'
import {
  Alert,
  Box,
  Button,
  Card,
  CardContent,
  CircularProgress,
  IconButton,
  List,
  ListItem,
  ListItemText,
  Tooltip,
  Typography,
} from '@mui/material'
import { PlainCensus } from '@vocdoni/davinci-sdk'
import { Wallet, JsonRpcProvider } from 'ethers'
import { useEffect, useState } from 'react'

interface CensusCreationScreenProps {
  onBack: () => void
  onNext: (census: PlainCensus) => void
}

export default function CensusCreationScreen({ onBack, onNext }: CensusCreationScreenProps) {
  const [addresses, setAddresses] = useState<string[]>([])
  const { walletMap, setWalletMap } = useWallets()
  const [newAddress, setNewAddress] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [censusCreated, setCensusCreated] = useState(false)
  const [census, setCensus] = useState<PlainCensus | null>(null)

  useEffect(() => {
    // Generate initial 10 random wallets on component mount
    const initialWallets = Array.from({ length: 10 }, () => Wallet.createRandom())
    const initialAddresses = initialWallets.map((w) => w.address)
    setAddresses(initialAddresses)
    setWalletMap(Object.fromEntries(initialWallets.map((w) => [w.address, new Wallet(w.privateKey)])))
  }, [setWalletMap])

  const handleAddRandomWallet = () => {
    const newWallet = Wallet.createRandom()
    setAddresses((prev) => [...prev, newWallet.address])
    const updatedWalletMap = { ...walletMap, [newWallet.address]: new Wallet(newWallet.privateKey) }
    setWalletMap(updatedWalletMap)
  }

  const handleAddAddress = () => {
    if (!newAddress.match(/^0x[a-fA-F0-9]{40}$/)) {
      setError('Invalid Ethereum address format')
      return
    }
    if (addresses.includes(newAddress)) {
      setError('Address already in the list')
      return
    }
    setAddresses([...addresses, newAddress])
    setNewAddress('')
    setError(null)
  }

  const handleRemoveAddress = (address: string) => {
    setAddresses(addresses.filter((w) => w !== address))
    const newWalletMap = { ...walletMap }
    delete newWalletMap[address]
    setWalletMap(newWalletMap)
  }

  const handleCopyAddress = (address: string) => {
    navigator.clipboard.writeText(address)
  }

  const handleCopyPrivateKey = (address: string) => {
    const wallet = walletMap[address]
    if (wallet) {
      navigator.clipboard.writeText(wallet.privateKey)
    }
  }

  const handleCreateCensus = () => {
    if (addresses.length === 0) {
      setError('Add at least one address to create a census')
      return
    }

    try {
      setError(null)

      // Create a PlainCensus object with all addresses
      const newCensus = new PlainCensus()
      newCensus.add(addresses)

      // Store census object for the next screen
      setCensus(newCensus)
      setCensusCreated(true)
      
      console.log('Census object created with', addresses.length, 'addresses')
      console.log('Census will be automatically published when creating the process')
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to create census')
      console.error('Error creating census:', err)
    }
  }

  return (
    <Box sx={{ maxWidth: 800, mx: 'auto', textAlign: 'center' }}>
      <Typography variant='h4' component='h1' gutterBottom>
        Create Census
      </Typography>

      <Typography variant='body1' color='text.secondary' paragraph sx={{ mb: 4 }}>
        Create a census by adding wallet addresses that will be allowed to vote. You can add more random wallets or your
        own addresses.
      </Typography>

      <Card sx={{ mb: 4 }}>
        <CardContent>
          <Box sx={{ mb: 3, display: 'flex', gap: 2, justifyContent: 'center' }}>
            <Button variant='contained' onClick={handleAddRandomWallet} startIcon={<AddIcon />} disabled={censusCreated}>
              Add Random Wallet
            </Button>
            <Button
              variant='contained'
              onClick={handleCreateCensus}
              disabled={addresses.length === 0 || censusCreated}
            >
              Create Census
            </Button>
          </Box>

          {error && (
            <Alert severity='error' sx={{ mb: 2 }}>
              {error}
            </Alert>
          )}

          {censusCreated && (
            <Alert severity='success' sx={{ mb: 3, py: 2 }}>
              <Typography variant='h6' gutterBottom>
                ✓ Census Created Successfully!
              </Typography>
              <Typography variant='body2' gutterBottom>
                Census ready with {addresses.length} addresses. It will be automatically published when you create the process.
              </Typography>
              <Typography variant='body1' sx={{ mt: 2, fontWeight: 'bold' }}>
                👉 Click "Next" below to continue to the next step
              </Typography>
            </Alert>
          )}

          <List>
            {addresses.map((address, index) => (
              <ListItem
                key={address}
                secondaryAction={
                  !censusCreated ? (
                    <IconButton edge='end' aria-label='delete' onClick={() => handleRemoveAddress(address)}>
                      <DeleteIcon />
                    </IconButton>
                  ) : null
                }
              >
                <ListItemText
                  primary={
                    <Box sx={{ display: 'flex', alignItems: 'center', gap: 1 }}>
                      <Typography variant='body2' sx={{ wordBreak: 'break-all' }}>
                        {`${index + 1}. ${address}`}
                      </Typography>
                      <Tooltip title='Copy address'>
                        <IconButton size='small' onClick={() => handleCopyAddress(address)}>
                          <ContentCopyIcon fontSize='small' />
                        </IconButton>
                      </Tooltip>
                    </Box>
                  }
                  secondary={
                    walletMap[address] && (
                      <>
                        <span style={{ display: 'flex', alignItems: 'center', gap: '4px', marginTop: '2px' }}>
                          <span style={{ wordBreak: 'break-all', fontSize: '0.7rem', color: 'rgba(0, 0, 0, 0.6)' }}>
                            Private Key: {walletMap[address].privateKey}
                          </span>
                          <Tooltip title='Copy private key'>
                            <IconButton size='small' onClick={() => handleCopyPrivateKey(address)}>
                              <ContentCopyIcon fontSize='small' />
                            </IconButton>
                          </Tooltip>
                        </span>
                      </>
                    )
                  }
                />
              </ListItem>
            ))}
          </List>
        </CardContent>
      </Card>

      <Box sx={{ display: 'flex', gap: 2, justifyContent: 'center' }}>
        <Button variant='outlined' onClick={onBack} disabled={censusCreated}>
          Back
        </Button>
        <Button 
          variant='contained' 
          size={censusCreated ? 'large' : 'medium'}
          onClick={() => {
            if (census) {
              onNext(census)
            }
          }} 
          disabled={!censusCreated || !census}
          sx={censusCreated ? {
            fontSize: '1.1rem',
            py: 1.5,
            px: 4,
            animation: 'pulse 2s infinite',
            '@keyframes pulse': {
              '0%': {
                boxShadow: '0 0 0 0 rgba(43, 108, 176, 0.7)',
              },
              '70%': {
                boxShadow: '0 0 0 10px rgba(43, 108, 176, 0)',
              },
              '100%': {
                boxShadow: '0 0 0 0 rgba(43, 108, 176, 0)',
              },
            },
          } : {}}
        >
          {censusCreated ? '→ Next: Create Election' : 'Next'}
        </Button>
      </Box>
    </Box>
  )
}
