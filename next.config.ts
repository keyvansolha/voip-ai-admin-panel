import type { NextConfig } from 'next';

const nextConfig: NextConfig = {
  output: 'standalone',

  // better-sqlite3 is a native addon; it must stay a real require() at runtime
  // instead of being bundled into the server chunks.
  serverExternalPackages: ['better-sqlite3'],

  experimental: {
    // Recordings are posted as multipart bodies to the ingest route. Server
    // Actions have their own (smaller) limit, so this only guards the panel's
    // own form posts.
    serverActions: {
      bodySizeLimit: '2mb',
    },
  },

  // The ingest endpoint is called by the store PC with a shared secret, not a
  // browser, so it needs no CORS. Everything else is same-origin only.
  async headers() {
    return [
      {
        source: '/:path*',
        headers: [
          { key: 'X-Content-Type-Options', value: 'nosniff' },
          { key: 'X-Frame-Options', value: 'DENY' },
          { key: 'Referrer-Policy', value: 'same-origin' },
        ],
      },
    ];
  },
};

export default nextConfig;
