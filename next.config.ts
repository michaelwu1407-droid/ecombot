import type { NextConfig } from 'next';

const nextConfig: NextConfig = {
  reactStrictMode: true,
  experimental: {
    // Webhook handlers ack fast and finish the agent turn in `after()`.
    serverActions: { bodySizeLimit: '2mb' },
  },
};

export default nextConfig;
