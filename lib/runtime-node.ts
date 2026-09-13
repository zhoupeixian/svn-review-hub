import { resolve } from 'node:path';
import { createNodeStorage } from './node-storage';

type Storage = ReturnType<typeof createNodeStorage>;
const globalRuntime = globalThis as typeof globalThis & { portalStorage?: Storage; portalEnv?: Record<string, unknown> };

function storage() {
  return globalRuntime.portalStorage ??= createNodeStorage(process.env.VITEST ? ':memory:' : resolve(process.env.PORTAL_DATA_DIR || './data', 'portal.sqlite'));
}

// Lazy access avoids creating a database while Next.js analyses routes at build time.
export const env = globalRuntime.portalEnv ??= new Proxy<Record<string, unknown>>({}, {
  get(target, name: string) {
    if (name in target) return target[name];
    if (name === 'DB' || name === 'FILES') return storage()[name];
    if (name === 'PORTAL_RUNTIME') return 'node';
    return process.env[name];
  },
});
