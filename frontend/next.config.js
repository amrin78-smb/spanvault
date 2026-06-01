/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  async rewrites() {
    return {
      afterFiles: [
        {
          source: '/api/((?!auth).*)',
          destination: 'http://127.0.0.1:3009/api/$1',
        },
      ],
    };
  },
};
module.exports = nextConfig;
