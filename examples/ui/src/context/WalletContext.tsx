'use client';

import { createContext, useContext, useState, ReactNode } from 'react';
import { Wallet } from 'ethers';

interface WalletContextType {
  walletMap: Record<string, Wallet>;
  setWalletMap: (wallets: Record<string, Wallet>) => void;
}

const WalletContext = createContext<WalletContextType | undefined>(undefined);

export function WalletProvider({ children }: { children: ReactNode }) {
  const [walletMap, setWalletMap] = useState<Record<string, Wallet>>({});

  return (
    <WalletContext.Provider value={{ walletMap, setWalletMap }}>
      {children}
    </WalletContext.Provider>
  );
}

export function useWallets() {
  const context = useContext(WalletContext);
  if (context === undefined) {
    throw new Error('useWallets must be used within a WalletProvider');
  }
  return context;
}
