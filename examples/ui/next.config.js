/** @type {import('next').NextConfig} */
const nextConfig = {
  // Enable static export for GitHub Pages
  output: 'export',
  
  // Disable image optimization for static export
  images: {
    unoptimized: true,
  },
  
  // Set base path for GitHub Pages (will be set by repository name)
  basePath: process.env.NODE_ENV === 'production' ? '/davinci-sdk' : '',
  
  // Ensure trailing slashes for proper routing
  trailingSlash: true,
  
  // Disable linting during build for deployment
  eslint: {
    ignoreDuringBuilds: true,
  },
  
  // Disable TypeScript errors during build for deployment
  typescript: {
    ignoreBuildErrors: true,
  },
  
  env: {
    API_URL: process.env.API_URL,
    SEPOLIA_RPC: process.env.SEPOLIA_RPC,
    PRIVATE_KEY: process.env.PRIVATE_KEY,
  },
  webpack: (config) => {
    config.resolve.fallback = {
      ...config.resolve.fallback,
      fs: false,
      net: false,
      tls: false,
    };
    return config;
  },
};

module.exports = nextConfig;
