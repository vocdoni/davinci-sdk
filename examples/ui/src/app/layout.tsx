import { Inter } from 'next/font/google';
import './globals.css';
import type { Metadata } from 'next';
import { WalletProvider } from '@/context/WalletContext';

const inter = Inter({ subsets: ['latin'] });

export const metadata: Metadata = {
  title: 'Davinci Demo',
  description: 'A demo application showcasing the Vocdoni Davinci SDK capabilities',
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en">
      <body className={inter.className}>
        <WalletProvider>
          {children}
        </WalletProvider>
      </body>
    </html>
  );
}
