import { readD1Migrations } from '@cloudflare/vitest-plugin';
import { env } from '../lib/runtime-node';

env.TEST_MIGRATIONS = await readD1Migrations('./drizzle');
env.ANONYMOUS_SOURCE_HASH_KEY = 'test-only-anonymous-source-hash-key';
