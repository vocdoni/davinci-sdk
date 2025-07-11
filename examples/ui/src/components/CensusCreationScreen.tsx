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
import { VocdoniApiService } from '@vocdoni/davinci-sdk'
import { Wallet } from 'ethers'
import { useEffect, useState } from 'react'

interface CensusCreationScreenProps {
  onBack: () => void
  onNext: (censusId: string) => void
}

export default function CensusCreationScreen({ onBack, onNext }: CensusCreationScreenProps) {
  const [addresses, setAddresses] = useState<string[]>([])
  const { walletMap, setWalletMap } = useWallets()
  const [newAddress, setNewAddress] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [isLoading, setIsLoading] = useState(false)
  const [censusCreated, setCensusCreated] = useState(false)
  const [progress, setProgress] = useState(0)
  const [censusId, setCensusId] = useState<string | null>(null)

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

  const handleCreateCensus = async () => {
    if (addresses.length === 0) {
      setError('Add at least one address to create a census')
      return
    }

    try {
      setIsLoading(true)
      setError(null)
      setProgress(0)

      const api = new VocdoniApiService({
        sequencerURL: import.meta.env.SEQUENCER_API_URL,
        censusURL: import.meta.env.CENSUS_API_URL
      })

      // Create census
      setProgress(20)
      const newCensusId = await api.census.createCensus()
      setCensusId(newCensusId)

      // Add voters in batches
      const batchSize = Math.ceil(addresses.length / 4) // Split into 4 parts for progress
      for (let i = 0; i < addresses.length; i += batchSize) {
        const batch = addresses.slice(i, i + batchSize)

        // Add participants using addresses
        await api.census.addParticipants(
          newCensusId,
          batch.map((address) => ({
            key: address,
            weight: '1', // All voters have equal weight
          }))
        )
        setProgress(40 + Math.floor((i / addresses.length) * 40))
      }

      // Publish the census and store root & size locally
      setProgress(90)
      const publishResult = await api.census.publishCensus(newCensusId)
      const censusRoot = publishResult.root
      const censusSize = await api.census.getCensusSize(censusRoot)
      
      // Store census details locally for the next screen
      localStorage.setItem('censusDetails', JSON.stringify({
        censusId: newCensusId,
        censusRoot,
        censusSize
      }))

      setProgress(100)
      setCensusCreated(true)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to create census')
      console.error('Error creating census:', err)
    } finally {
      setIsLoading(false)
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
            <Button variant='contained' onClick={handleAddRandomWallet} startIcon={<AddIcon />} disabled={isLoading}>
              Add Random Wallet
            </Button>
            <Button
              variant='contained'
              onClick={handleCreateCensus}
              disabled={addresses.length === 0 || isLoading || censusCreated}
            >
              Create Census
            </Button>
          </Box>

          {error && (
            <Alert severity='error' sx={{ mb: 2 }}>
              {error}
            </Alert>
          )}

          {isLoading && (
            <Box sx={{ mb: 2, textAlign: 'center' }}>
              <CircularProgress variant='determinate' value={progress} sx={{ mb: 1 }} />
              <Typography variant='body2' color='text.secondary'>
                Creating census... {progress}%
              </Typography>
            </Box>
          )}

          {censusCreated && (
            <Alert severity='success' sx={{ mb: 2 }}>
              Census created successfully!
            </Alert>
          )}

          <List>
            {addresses.map((address, index) => (
              <ListItem
                key={address}
                secondaryAction={
                  !censusCreated && (
                    <IconButton edge='end' aria-label='delete' onClick={() => handleRemoveAddress(address)}>
                      <DeleteIcon />
                    </IconButton>
                  )
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
        <Button variant='outlined' onClick={onBack} disabled={isLoading}>
          Back
        </Button>
        <Button variant='contained' onClick={() => censusId && onNext(censusId)} disabled={!censusCreated || !censusId}>
          Next
        </Button>
      </Box>
    </Box>
  )
}
