import tailwindcss from '@tailwindcss/vite'
import react from '@vitejs/plugin-react'
import path from 'path'
import { defineConfig, loadEnv } from 'vite'

// https://vitejs.dev/config/
const viteconfig = defineConfig(({ mode }) => {
  // load env variables from .env files
  process.env = { ...process.env, ...loadEnv(mode, process.cwd(), '') }

  return {
    plugins: [react(), tailwindcss()],
    define: {
      'import.meta.env.API_URL': JSON.stringify(process.env.API_URL || 'https://sequencer1.davinci.vote'),
      'import.meta.env.RPC_URL': JSON.stringify(process.env.RPC_URL || ''),
    },
    resolve: {
      alias: {
        '@': path.resolve(__dirname, './src'),
      },
    },
  }
})

export default viteconfig
