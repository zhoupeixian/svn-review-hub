import { cpSync } from 'node:fs';
import { spawnSync } from 'node:child_process';

const result = spawnSync(process.execPath, ['node_modules/next/dist/bin/next', 'build', '--webpack'], {
  stdio: 'inherit', env: { ...process.env, PORTAL_BUILD_TARGET: 'node', NEXT_TELEMETRY_DISABLED: '1' },
});
if (result.status !== 0) process.exit(result.status ?? 1);
cpSync('public', '.next-server/standalone/public', { recursive: true });
cpSync('.next-server/static', '.next-server/standalone/.next-server/static', { recursive: true });
