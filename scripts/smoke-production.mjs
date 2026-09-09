const REQUEST_TIMEOUT_MS = 10_000;
const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);

const baseUrl = readBaseUrl(process.env.REVIEW_PORTAL_URL);

if (!baseUrl.ok) {
  console.error(`[FAIL] 配置：${baseUrl.error}`);
  process.exitCode = 2;
} else {
  process.exitCode = await runChecks(baseUrl.value);
}

function readBaseUrl(value) {
  if (!value?.trim()) {
    return { ok: false, error: '缺少环境变量 REVIEW_PORTAL_URL。' };
  }

  let url;
  try {
    url = new URL(value.trim());
  } catch {
    return { ok: false, error: 'REVIEW_PORTAL_URL 不是有效 URL。' };
  }

  if (!['http:', 'https:'].includes(url.protocol)) {
    return { ok: false, error: 'REVIEW_PORTAL_URL 只允许使用 http 或 https。' };
  }
  if (url.username || url.password) {
    return { ok: false, error: 'REVIEW_PORTAL_URL 不得包含用户名或密码。' };
  }
  if (url.pathname !== '/' || url.search || url.hash) {
    return { ok: false, error: 'REVIEW_PORTAL_URL 必须是站点根地址，不能包含路径、查询参数或片段。' };
  }

  return { ok: true, value: url };
}

async function runChecks(url) {
  const checks = [
    ['首页', () => checkHome(url)],
    ['/admin 重定向', () => checkLegacyAdminRedirect(url)],
    ['项目管理入口认证保护', () => checkProjectAdminEntry(url)],
    ['ZHERP 日志只读 API', () => checkReadOnlyApi(url)],
  ];

  let passed = 0;
  for (const [name, check] of checks) {
    try {
      await check();
      passed += 1;
      console.log(`[PASS] ${name}`);
    } catch (error) {
      console.error(`[FAIL] ${name}：${safeErrorMessage(error)}`);
      return 1;
    }
  }

  console.log(`生产环境冒烟检查通过（${passed}/${checks.length}）。`);
  return 0;
}

async function checkHome(base) {
  const response = await request(base, '/');
  expectStatus(response, 200);
  expectContentType(response, 'text/html');

  const html = await response.text();
  if (!html.includes('选择要查阅的审查项目')) {
    throw new Error('首页缺少项目目录标题。');
  }
  if (!/href=["']\/admin\/projects["']/.test(html)) {
    throw new Error('首页缺少指向 /admin/projects 的管理入口。');
  }
}

async function checkLegacyAdminRedirect(base) {
  const response = await request(base, '/admin', { redirect: 'manual' });
  expectRedirect(response);
  expectRedirectTarget(base, response, '/projects/zherp/admin');
}

async function checkProjectAdminEntry(base) {
  const response = await request(base, '/admin/projects', { redirect: 'manual' });
  expectRedirect(response);
  const target = redirectTarget(base, response);
  if (target.origin !== base.origin || target.pathname !== '/signin-with-chatgpt') {
    throw new Error(`期望跳转到 /signin-with-chatgpt，实际跳转到 ${safeTarget(target, base)}。`);
  }
  if (target.searchParams.get('return_to') !== '/admin/projects') {
    throw new Error('登录跳转缺少 return_to=/admin/projects。');
  }
}

async function checkReadOnlyApi(base) {
  const response = await request(base, '/api/projects/zherp/reviews?scope=active&limit=1');
  expectStatus(response, 200);
  expectContentType(response, 'application/json');

  let body;
  try {
    body = await response.json();
  } catch {
    throw new Error('响应正文不是有效 JSON。');
  }
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    throw new Error('响应正文不是 JSON 对象。');
  }
  if (!Array.isArray(body.items)) {
    throw new Error('响应字段 items 不是数组。');
  }
  if (typeof body.hasMore !== 'boolean') {
    throw new Error('响应字段 hasMore 不是布尔值。');
  }
  if (body.nextCursor !== null && typeof body.nextCursor !== 'string') {
    throw new Error('响应字段 nextCursor 不是字符串或 null。');
  }
}

async function request(base, path, options = {}) {
  try {
    return await fetch(new URL(path, base), {
      method: 'GET',
      redirect: options.redirect ?? 'follow',
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
  } catch (error) {
    if (error instanceof Error && error.name === 'TimeoutError') {
      throw new Error(`请求超过 ${REQUEST_TIMEOUT_MS}ms。`);
    }
    throw new Error('请求失败。');
  }
}

function expectStatus(response, expected) {
  if (response.status !== expected) {
    throw new Error(`期望状态 ${expected}，实际状态 ${response.status}。`);
  }
}

function expectContentType(response, expected) {
  const actual = response.headers.get('content-type') ?? '';
  if (!actual.toLowerCase().includes(expected)) {
    throw new Error(`期望 Content-Type 包含 ${expected}，实际为 ${actual || '未提供'}。`);
  }
}

function expectRedirect(response) {
  if (!REDIRECT_STATUSES.has(response.status)) {
    throw new Error(`期望重定向状态，实际状态 ${response.status}。`);
  }
}

function expectRedirectTarget(base, response, expectedPath) {
  const target = redirectTarget(base, response);
  if (
    target.origin !== base.origin ||
    target.pathname !== expectedPath ||
    target.search ||
    target.hash
  ) {
    throw new Error(`期望跳转到 ${expectedPath}，实际跳转到 ${safeTarget(target, base)}。`);
  }
}

function redirectTarget(base, response) {
  const location = response.headers.get('location');
  if (!location) throw new Error('重定向响应缺少 Location。');
  try {
    return new URL(location, base);
  } catch {
    throw new Error('重定向 Location 不是有效 URL。');
  }
}

function safeTarget(target, base) {
  return target.origin === base.origin
    ? target.pathname
    : '其他站点';
}

function safeErrorMessage(error) {
  return error instanceof Error ? error.message : '未知错误。';
}
