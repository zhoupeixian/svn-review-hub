import { spawn } from 'node:child_process';
import {
  createServer,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from 'node:http';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';

const scriptPath = fileURLToPath(
  new URL('../scripts/smoke-production.mjs', import.meta.url),
);
const servers: Server[] = [];

afterEach(async () => {
  await Promise.all(
    servers.splice(0).map(
      (server) => new Promise<void>((resolve) => server.close(() => resolve())),
    ),
  );
});

describe('生产环境冒烟检查命令', () => {
  it('按顺序执行四项只读检查且不发送 Cookie 或认证信息', async () => {
    const requests: Array<{
      path: string;
      method?: string;
      cookie?: string;
      authorization?: string;
    }> = [];
    const baseUrl = await listen((request, response) => {
      requests.push({
        path: request.url ?? '',
        method: request.method,
        cookie: request.headers.cookie,
        authorization: request.headers.authorization,
      });
      respondForSuccessfulSmoke(request, response);
    });

    const result = await runCommand(baseUrl);

    expect(result.code).toBe(0);
    expect(result.stderr).toBe('');
    expect(result.stdout).toContain('[PASS] 首页');
    expect(result.stdout).toContain('生产环境冒烟检查通过（4/4）。');
    expect(requests.map(({ path }) => path)).toEqual([
      '/',
      '/admin',
      '/admin/projects',
      '/api/projects/zherp/reviews?scope=active&limit=1',
    ]);
    expect(requests.every(({ method }) => method === 'GET')).toBe(true);
    expect(requests.every(({ cookie }) => cookie === undefined)).toBe(true);
    expect(requests.every(({ authorization }) => authorization === undefined)).toBe(true);
  });

  it.each([
    ['', '缺少环境变量 REVIEW_PORTAL_URL'],
    ['not-a-url', '不是有效 URL'],
    ['ftp://example.test', '只允许使用 http 或 https'],
    ['https://user:secret@example.test', '不得包含用户名或密码'],
  ])('URL 配置无效时退出 2：%s', async (baseUrl, expectedMessage) => {
    const result = await runCommand(baseUrl);

    expect(result.code).toBe(2);
    expect(result.stderr).toContain(expectedMessage);
  });

  it('旧管理地址没有正确重定向时退出 1 并停止后续检查', async () => {
    const paths: string[] = [];
    const baseUrl = await listen((request, response) => {
      paths.push(request.url ?? '');
      if (request.url === '/') {
        respondHome(response);
        return;
      }
      response.writeHead(200, { 'content-type': 'text/plain' });
      response.end('internal-secret-detail');
    });

    const result = await runCommand(baseUrl);

    expect(result.code).toBe(1);
    expect(result.stderr).toContain('[FAIL] /admin 重定向');
    expect(result.stderr).toContain('实际状态 200');
    expect(result.stderr).not.toContain('internal-secret-detail');
    expect(paths).toEqual(['/', '/admin']);
  });

  it('只读 API 失败时报告检查项和状态且不输出响应正文', async () => {
    const baseUrl = await listen((request, response) => {
      if (request.url === '/api/projects/zherp/reviews?scope=active&limit=1') {
        response.writeHead(500, { 'content-type': 'text/plain' });
        response.end('database-secret-detail');
        return;
      }
      respondForSuccessfulSmoke(request, response);
    });

    const result = await runCommand(baseUrl);

    expect(result.code).toBe(1);
    expect(result.stderr).toContain('[FAIL] 默认项目日志只读 API');
    expect(result.stderr).toContain('实际状态 500');
    expect(result.stderr).not.toContain('database-secret-detail');
  });
});

function respondForSuccessfulSmoke(
  request: IncomingMessage,
  response: ServerResponse<IncomingMessage>,
) {
  switch (request.url) {
    case '/':
      respondHome(response);
      break;
    case '/admin':
      response.writeHead(307, { location: '/projects/zherp/admin' }).end();
      break;
    case '/admin/projects':
      response.writeHead(307, {
        location: '/signin-with-chatgpt?return_to=%2Fadmin%2Fprojects',
      }).end();
      break;
    case '/api/projects/zherp/reviews?scope=active&limit=1':
      response.writeHead(200, { 'content-type': 'application/json; charset=utf-8' });
      response.end(JSON.stringify({ items: [], hasMore: false, nextCursor: null }));
      break;
    default:
      response.writeHead(404).end();
  }
}

function respondHome(response: ServerResponse<IncomingMessage>) {
  response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
  response.end('<h1>选择要查阅的审查项目</h1><a href="/admin/projects">管理入口</a>');
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

async function runCommand(baseUrl: string): Promise<{
  code: number | null;
  stdout: string;
  stderr: string;
}> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [scriptPath], {
      env: {
        ...process.env,
        REVIEW_PORTAL_URL: baseUrl,
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
