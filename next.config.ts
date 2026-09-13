import type { NextConfig } from 'next';
import path from 'node:path';

const nextConfig: NextConfig = process.env.PORTAL_BUILD_TARGET === 'node' ? {
  output: 'standalone',
  distDir: '.next-server',
  typescript: { tsconfigPath: 'tsconfig.server.json' },
  webpack(config, { webpack }) {
    config.plugins.push(new webpack.NormalModuleReplacementPlugin(/^@\/lib\/runtime$/, path.resolve('lib/runtime-node.ts')));
    return config;
  },
} : {};

export default nextConfig;
