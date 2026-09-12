import { cloudflareTest, readD1Migrations } from '@cloudflare/vitest-plugin';
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

const workerTests = [
  'archive-api',
  'issue-status-api',
  'issues-export',
  'project-admin-api',
  'project-browsing-api',
  'project-deletion',
  'project-issue-collaboration',
  'project-log-admin',
  'project-sync-schema-init',
  'project-sync',
  'review-ingestion',
  'review-repository-query',
  'review-schema-contract',
  'sync-health',
].map((name) => `test/${name}.test.ts`);

const resolve = {
  alias: { '@': fileURLToPath(new URL('.', import.meta.url)) },
};

export default defineConfig(async ({ mode }) => {
  if (mode !== 'workers') {
    return {
      resolve,
      test: {
        environment: 'node',
        include: ['test/**/*.test.ts', 'test/**/*.test.tsx'],
        exclude: workerTests,
      },
    };
  }

  const migrations = await readD1Migrations('./drizzle');
  return {
    resolve,
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
      include: workerTests,
      setupFiles: ['./test/apply-migrations.ts'],
    },
  };
});
