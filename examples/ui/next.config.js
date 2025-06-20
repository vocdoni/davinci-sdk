/** @type {import('next').NextConfig} */
const nextConfig = {
  output: 'export',
  trailingSlash: true,
  basePath: process.env.NODE_ENV === 'production' ? '/davinci-sdk' : '',
  images: {
    unoptimized: true,
  },
  eslint: {
    // Disable ESLint during builds for deployment
    ignoreDuringBuilds: true,
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
