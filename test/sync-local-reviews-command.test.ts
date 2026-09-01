import { spawn } from 'node:child_process';
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import {
  createServer,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from 'node:http';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';

const scriptPath = fileURLToPath(
  new URL('../scripts/sync-local-reviews.mjs', import.meta.url),
);
const servers: Server[] = [];

afterEach(async () => {
  await Promise.all(
    servers.splice(0).map(
      (server) => new Promise<void>((resolve) => server.close(() => resolve())),
    ),
  );
});

describe('本地按项目同步命令', () => {
  it('从单项目配置读取项目、密钥和日志根目录并发送可观察请求', async () => {
    const received: Array<{ headers: IncomingMessage['headers']; body: unknown }> = [];
    const portalUrl = await listen(async (request, response) => {
      const chunks: Buffer[] = [];
      for await (const chunk of request) chunks.push(Buffer.from(chunk));
      received.push({
        headers: request.headers,
        body: JSON.parse(Buffer.concat(chunks).toString('utf8')),
      });
      response.writeHead(201, { 'content-type': 'application/json' });
      response.end(JSON.stringify({
        review: {
          ingestion: {
            createdIssueCount: 1,
            updatedIssueCount: 0,
            parsedIssueCount: 1,
          },
        },
      }));
    });
    const fixture = await createFixture(portalUrl, [
      'REVIEW_PORTAL_PROJECT_SLUG=haihua',
      'REVIEW_PORTAL_SYNC_KEY=haihua-secret',
    ]);

    const result = await runCommand(fixture.configPath);

    expect(result).toMatchObject({ code: 0 });
    expect(result.stdout).toContain('已同步：svn审查日志-2026-08-31.md');
    expect(received).toHaveLength(1);
    expect(received[0].headers['x-review-sync-key']).toBe('haihua-secret');
    expect(received[0].body).toMatchObject({
      projectSlug: 'haihua',
      sourceKey: '2026-08-31/svn审查日志-2026-08-31.md',
      sourceName: 'svn审查日志-2026-08-31.md',
    });
  });

  it('缺少任一必填单项目配置时退出 2 且不发送 HTTP', async () => {
    let requestCount = 0;
    const portalUrl = await listen((_request, response) => {
      requestCount += 1;
      response.writeHead(201).end();
    });
    const fixture = await createFixture(portalUrl, [
      'REVIEW_PORTAL_SYNC_KEY=haihua-secret',
    ]);

    const result = await runCommand(fixture.configPath);

    expect(result.code).toBe(2);
    expect(result.stderr).toContain('REVIEW_PORTAL_PROJECT_SLUG');
    expect(requestCount).toBe(0);
  });

  it('服务端失败时只输出状态码，不回显响应正文或项目密钥', async () => {
    const portalUrl = await listen((_request, response) => {
      response.writeHead(500, { 'content-type': 'text/plain' });
      response.end('internal-secret-detail');
    });
    const fixture = await createFixture(portalUrl, [
      'REVIEW_PORTAL_PROJECT_SLUG=haihua',
      'REVIEW_PORTAL_SYNC_KEY=haihua-secret',
    ]);

    const result = await runCommand(fixture.configPath);

    expect(result.code).toBe(1);
    expect(result.stderr).toContain('服务返回 500');
    expect(result.stderr).not.toContain('internal-secret-detail');
    expect(result.stderr).not.toContain('haihua-secret');
  });
});

async function createFixture(portalUrl: string, extraConfig: string[]) {
  const root = await mkdtemp(path.join(tmpdir(), 'review-sync-command-'));
  const logRoot = path.join(root, 'logs');
  const datedRoot = path.join(logRoot, '2026-08-31');
  await mkdir(datedRoot, { recursive: true });
  await writeFile(
    path.join(datedRoot, 'svn审查日志-2026-08-31.md'),
    '# 日志\n日期：2026-08-31\n审查范围：共 0 个 revision\n',
    'utf8',
  );
  const configPath = path.join(root, 'review-portal.env');
  await writeFile(
    configPath,
    [
      `REVIEW_PORTAL_URL=${portalUrl}`,
      `REVIEW_LOG_ROOT=${logRoot}`,
      ...extraConfig,
    ].join('\n'),
    'utf8',
  );
  return { configPath };
}

async function listen(
  handler: (
    request: IncomingMessage,
    response: ServerResponse<IncomingMessage>,
  ) => void,
): Promise<string> {
  const server = createServer(handler);
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('测试 HTTP 服务未启动。');
  return `http://127.0.0.1:${address.port}`;
}

async function runCommand(configPath: string): Promise<{
  code: number | null;
  stdout: string;
  stderr: string;
}> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [scriptPath, '--date', '2026-08-31'], {
      env: {
        ...process.env,
        REVIEW_PORTAL_CONFIG: configPath,
        REVIEW_PORTAL_PROJECT_SLUG: '',
        REVIEW_PORTAL_URL: '',
        REVIEW_PORTAL_SYNC_KEY: '',
        REVIEW_LOG_ROOT: '',
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8').on('data', (chunk) => { stdout += chunk; });
    child.stderr.setEncoding('utf8').on('data', (chunk) => { stderr += chunk; });
    child.once('error', reject);
    child.once('close', (code) => resolve({ code, stdout, stderr }));
  });
}
