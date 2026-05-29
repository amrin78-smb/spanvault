/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  async rewrites() {
    // /api/auth/* stays local to NextAuth (filesystem route wins in afterFiles).
    // All other /api/* proxy to the internal Express API on 3009.
    return {
      afterFiles: [
        { source: '/api/:path*', destination: 'http://127.0.0.1:3009/api/:path*' },
      ],
    };
  },
};
module.exports = nextConfig;
