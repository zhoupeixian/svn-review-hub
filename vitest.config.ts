import { cloudflareTest, readD1Migrations } from '@cloudflare/vitest-plugin';
import { defineConfig } from 'vitest/config';

export default defineConfig(async ({ mode }) => {
  if (mode !== 'workers') {
    return {
      test: {
        environment: 'node',
        environmentMatchGlobs: [['test/**/*.tsx', 'jsdom']],
      },
    };
  }

  const migrations = await readD1Migrations('./drizzle');
  return {
    plugins: [
      cloudflareTest({
        miniflare: {
          d1Databases: ['DB'],
          r2Buckets: ['FILES'],
          bindings: { TEST_MIGRATIONS: migrations },
        },
      }),
    ],
    test: {
      setupFiles: ['./test/apply-migrations.ts'],
    },
  };
});
