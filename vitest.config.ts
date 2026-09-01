import { cloudflareTest, readD1Migrations } from '@cloudflare/vitest-plugin';
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

export default defineConfig(async ({ mode }) => {
  if (mode !== 'workers') {
    return {
      test: {
        environment: 'node',
        environmentMatchGlobs: [['test/**/*.tsx', 'jsdom']],
        include: ['test/**/*.test.ts', 'test/**/*.test.tsx'],
        exclude: ['test/review-schema-contract.test.ts'],
      },
    };
  }

  const migrations = await readD1Migrations('./drizzle');
  return {
    resolve: {
      alias: {
        '@': fileURLToPath(new URL('.', import.meta.url)),
      },
    },
    plugins: [
      cloudflareTest({
        miniflare: {
          d1Databases: ['DB'],
          r2Buckets: ['FILES'],
          bindings: {
            TEST_MIGRATIONS: migrations,
            ANONYMOUS_SOURCE_HASH_KEY: 'test-only-anonymous-source-hash-key',
          },
        },
      }),
    ],
    test: {
      setupFiles: ['./test/apply-migrations.ts'],
    },
  };
});
