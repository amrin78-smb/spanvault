/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  async rewrites() {
    return {
      afterFiles: [
        {
          source: '/api/:path*',
          destination: 'http://127.0.0.1:3009/api/:path*',
        },
      ],
    };
  },
};
module.exports = nextConfig;
