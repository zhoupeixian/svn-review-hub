// Writes only to a fresh local test instance. Never point this at production.
import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';
import { createServer } from 'node:net';

const image = process.argv[2];
const root = resolve('outputs', `server-${randomUUID()}`);
mkdirSync(root, { recursive: true });
const reservation = createServer();
await new Promise((resolve, reject) => {
  reservation.once('error', reject);
  reservation.listen(Number(process.env.PORTAL_TEST_PORT || 0), '127.0.0.1', resolve);
});
const port = reservation.address().port;
await new Promise((resolve) => reservation.close(resolve));
const origin = `http://127.0.0.1:${port}`;
const random = () => randomBytes(32).toString('base64url');
const settings = {
  PORTAL_ORIGIN: origin, PORTAL_ADMIN_PASSWORD: random(), PORTAL_SESSION_SECRET: random(),
  ANONYMOUS_SOURCE_HASH_KEY: random(), REVIEW_SYNC_MASTER_KEY: randomBytes(32).toString('base64'),
};
const envFile = resolve(root, '.env.server');
writeFileSync(envFile, Object.entries(settings).map(([key, value]) => `${key}=${value}`).join('\n'), { mode: 0o600 });
const name = `portal-test-${randomUUID()}`;
let activeName = name;
let child;
let started = false;
function run(command, args, env = {}) {
  const result = spawnSync(command, args, { encoding: 'utf8', env: { ...process.env, ...env } });
  assert.equal(result.status, 0, `${command} failed: ${result.stderr}`);
  return result.stdout.trim();
}
async function start(data = resolve(root, 'data')) {
  if (image) {
    run('docker', ['run', '-d', '--name', name, '--env-file', envFile, '--mount', `type=volume,source=${name}-data,target=/data`, '-p', `127.0.0.1:${port}:3000`, image]);
  } else {
    child = spawn(process.execPath, ['scripts/start-server.mjs'], {
      env: { ...process.env, ...settings, PORTAL_DATA_DIR: data, PORT: String(port) }, stdio: ['ignore', 'pipe', 'pipe'],
    });
    child.stdout.on('data', () => {});
    child.stderr.on('data', (chunk) => { writeFileSync(resolve(root, 'server.log'), chunk, { flag: 'a' }); });
  }
  started = true;
  await ready();
}
async function ready() {
  for (let i = 0; i < 60; i++) {
    if (!image && child.exitCode !== null) throw new Error(`Test server exited before readiness; inspect ${root}`);
    try { if ((await fetch(`${origin}/api/health`, { signal: AbortSignal.timeout(1000) })).ok) return; } catch { /* starting */ }
    await delay(500);
  }
  throw new Error(`Server did not become healthy; inspect ${root} or docker logs ${name}`);
}
async function stop() {
  if (!started) return;
  if (image) run('docker', ['stop', activeName]);
  else if (child && child.exitCode === null) { child.kill(); await new Promise((done) => child.once('exit', done)); }
  started = false;
}
async function call(path, options = {}, status = 200) {
  const response = await fetch(origin + path, { ...options, redirect: 'manual', signal: AbortSignal.timeout(15000) });
  assert.equal(response.status, status, `${path}: expected ${status}, got ${response.status}`);
  return response;
}

try {
  await start();
  await call('/');
  await call('/login');
  await call('/api/admin/projects', { headers: { 'oai-authenticated-user-id': 'forged', 'oai-authenticated-user-email': 'forged@test' } }, 401);
  await call('/api/session', { method: 'POST', headers: { origin: 'https://evil.test' }, body: 'password=x' }, 403);
  const login = await call('/api/session', {
    method: 'POST', headers: { origin }, body: new URLSearchParams({ password: settings.PORTAL_ADMIN_PASSWORD }),
  }, 303);
  const cookie = login.headers.get('set-cookie')?.split(';')[0];
  assert.ok(cookie);
  const headers = { cookie, origin, 'content-type': 'application/json' };
  await call('/api/admin/projects', { headers });
  const { project } = await (await call('/api/admin/projects', {
    method: 'POST', headers, body: JSON.stringify({ name: '部署验收', slug: 'deployment-test', description: '', displayOrder: 10 }),
  }, 201)).json();
  const keyResult = await (await call(`/api/admin/projects/${project.id}/sync-key/copy`, { method: 'POST', headers })).json();
  const key = keyResult.syncKey;
  assert.equal(typeof key, 'string');
  const markdown = '# SVN 审查日志\n日期：2026-09-13\n审查范围：共 1 个 revision，实际审查 1 个，跳过 0 个\n\n| Revision | 作者 | 提交说明 | 结果 |\n| --- | --- | --- | --- |\n| r54000 | alice | 部署验证 | 已审查 |\n\n### P2\n\n#### 持久化验证\n相关 revision：54000\n\n重启后应保留此问题。\n';
  const payload = { projectSlug: 'deployment-test', markdown, sourceKey: 'deployment-test.md', sourceName: 'deployment-test.md' };
  const sync = () => call('/api/reviews', { method: 'POST', headers: { 'content-type': 'application/json', 'x-review-sync-key': key }, body: JSON.stringify(payload) }, 201);
  const { review } = await (await sync()).json();
  assert.equal((await (await sync()).json()).review.id, review.id);
  const rawPath = `/api/projects/deployment-test/reviews/${review.id}/raw`;
  assert.equal(await (await call(rawPath)).text(), markdown);
  await call(`/api/projects/zherp/reviews/${review.id}/raw`, {}, 404);
  const backup = resolve(root, 'backup.sqlite');
  if (image) {
    run('docker', ['exec', name, 'node', 'scripts/backup-server.mjs', '/data/backup.sqlite']);
    run('docker', ['cp', `${name}:/data/backup.sqlite`, backup]);
    run('docker', ['restart', name]);
    await ready();
  } else {
    run(process.execPath, ['scripts/backup-server.mjs', backup], { PORTAL_DATA_DIR: resolve(root, 'data') });
    await stop();
    await start();
  }
  assert.equal(await (await call(rawPath)).text(), markdown);
  await stop();
  const restored = resolve(root, 'restored');
  run(process.execPath, ['scripts/restore-server.mjs', backup], { PORTAL_DATA_DIR: restored });
  if (image) {
    activeName = `${name}-restored`;
    run('docker', ['run', '-d', '--name', activeName, '--env-file', envFile,
      '--mount', `type=volume,source=${name}-data,target=/data`, '-e', 'PORTAL_DATA_DIR=/data/restored',
      '-p', `127.0.0.1:${port}:3000`, '--entrypoint', 'sh', image,
      '-c', 'node scripts/restore-server.mjs /data/backup.sqlite && node scripts/start-server.mjs']);
    started = true;
    await ready();
    assert.equal(await (await call(rawPath)).text(), markdown);
    await sync();
  } else {
    await start(restored);
    assert.equal(await (await call(rawPath)).text(), markdown);
    // The restored master key must still decrypt project sync keys.
    await sync();
  }
  console.log(`PASS: health, login, spoofed headers, CSRF, project sync, repeat import, isolation, raw content, restart and backup restore. Artifacts: ${root}`);
} finally { await stop(); }
