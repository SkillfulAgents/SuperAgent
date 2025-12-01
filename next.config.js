/** @type {import('next').NextConfig} */
const nextConfig = {
  // Enable server-side WebSocket support
  experimental: {
    serverComponentsExternalPackages: ['better-sqlite3', 'ws'],
  },
}

module.exports = nextConfig
