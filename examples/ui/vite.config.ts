import tailwindcss from '@tailwindcss/vite'
import react from '@vitejs/plugin-react'
import path from 'path'
import { defineConfig, loadEnv } from 'vite'

// https://vitejs.dev/config/
const viteconfig = defineConfig(({ mode }) => {
  // load env variables from .env files
  process.env = { ...process.env, ...loadEnv(mode, process.cwd(), '') }

  return {
    base: process.env.NODE_ENV === 'production' ? '/davinci-sdk/' : '/',
    plugins: [react(), tailwindcss()],
    define: {
      'import.meta.env.SEQUENCER_API_URL': JSON.stringify(process.env.SEQUENCER_API_URL || 'https://sequencer1.davinci.vote'),
      'import.meta.env.CENSUS_API_URL': JSON.stringify(process.env.CENSUS_API_URL || 'https://c3.davinci.vote'),
      'import.meta.env.RPC_URL': JSON.stringify(process.env.RPC_URL || ''),
      'import.meta.env.EXPLORER_URL': JSON.stringify(process.env.EXPLORER_URL || 'https://sepolia.etherscan.io'),
      'import.meta.env.ORGANIZATION_REGISTRY_ADDRESS': JSON.stringify(process.env.ORGANIZATION_REGISTRY_ADDRESS || ''),
      'import.meta.env.PROCESS_REGISTRY_ADDRESS': JSON.stringify(process.env.PROCESS_REGISTRY_ADDRESS || ''),
      'import.meta.env.FORCE_SEQUENCER_ADDRESSES': JSON.stringify(process.env.FORCE_SEQUENCER_ADDRESSES || false),
    },
    resolve: {
      alias: {
        '@': path.resolve(__dirname, './src'),
      },
    },
  }
})

export default viteconfig
