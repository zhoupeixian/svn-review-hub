import { readdir, readFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

const defaultLogRoot = 'D:\\SVN\\ZHERP\\automation-output\\svn审查';
const configPath =
  process.env.REVIEW_PORTAL_CONFIG ||
  path.join(os.homedir(), '.codex', 'automations', 'zherp', 'review-portal.env');

await loadConfig();

const requestedDate = readDateArgument(process.argv.slice(2));
const logRoot = process.env.REVIEW_LOG_ROOT || defaultLogRoot;
const portalUrl = process.env.REVIEW_PORTAL_URL;
const syncKey = process.env.REVIEW_PORTAL_SYNC_KEY;
const dispatchToken = process.env.REVIEW_PORTAL_DISPATCH_TOKEN;

if (!portalUrl || !syncKey) {
  console.error('未找到审查站同步配置。请检查 ' + configPath + '。');
  process.exitCode = 2;
} else {
  const files = await findReviewLogs(logRoot, requestedDate);
  if (!files.length) {
    console.log('没有找到可同步的 SVN 审查日志。');
  } else {
    let failed = 0;
    for (const file of files) {
      try {
        await uploadReview(file, logRoot, portalUrl, syncKey, dispatchToken);
        console.log('已同步：' + path.basename(file));
      } catch (error) {
        failed += 1;
        const message = error instanceof Error ? error.message : '未知错误';
        console.error('同步失败：' + path.basename(file) + '，' + message);
      }
    }
    if (failed) process.exitCode = 1;
  }
}

async function loadConfig() {
  if (!configPath) return;
  try {
    const content = await readFile(configPath, 'utf8');
    for (const rawLine of content.split(/\r?\n/)) {
      const line = rawLine.trim();
      if (!line || line.startsWith('#')) continue;
      const separator = line.indexOf('=');
      if (separator <= 0) continue;
      const key = line.slice(0, separator).trim();
      const value = line.slice(separator + 1).trim();
      if (key && value && !process.env[key]) process.env[key] = value;
    }
  } catch (error) {
    if (error && typeof error === 'object' && error.code === 'ENOENT') return;
    throw error;
  }
}

function readDateArgument(args) {
  const dateIndex = args.findIndex((value) => value === '--date');
  const value =
    dateIndex >= 0
      ? args[dateIndex + 1]
      : args.find((argument) => argument.startsWith('--date='))?.slice(7);
  if (!value) return null;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    throw new Error('日期参数必须是 YYYY-MM-DD。');
  }
  return value;
}

async function findReviewLogs(root, date) {
  const scanRoot = date ? path.join(root, date) : root;
  const files = [];

  async function walk(directory) {
    const entries = await readdir(directory, { withFileTypes: true });
    for (const entry of entries) {
      const fullPath = path.join(directory, entry.name);
      if (entry.isDirectory()) {
        await walk(fullPath);
      } else if (
        entry.isFile() &&
        entry.name.startsWith('svn审查日志-') &&
        entry.name.endsWith('.md')
      ) {
        files.push(fullPath);
      }
    }
  }

  await walk(scanRoot);
  return files.sort();
}

async function uploadReview(file, root, baseUrl, key, serviceToken) {
  const markdown = await readFile(file, 'utf8');
  const sourceKey = path.relative(root, file).split(path.sep).join('/');
  const headers = {
    'content-type': 'application/json',
    'x-review-sync-key': key,
  };
  if (serviceToken) {
    headers['OAI-Sites-Authorization'] = 'Bearer ' + serviceToken;
  }
  const response = await fetch(baseUrl.replace(/\/+$/, '') + '/api/reviews', {
    method: 'POST',
    headers,
    body: JSON.stringify({
      markdown,
      sourceKey,
      sourceName: path.basename(file),
    }),
  });

  if (!response.ok) {
    const body = await response.text();
    throw new Error('服务返回 ' + response.status + '：' + body.slice(0, 240));
  }
}
