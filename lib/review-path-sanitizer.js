const REVIEW_FILE_SCHEME = 'review-file:';
const ROOT_TOKEN = '__SVN_REVIEW_PROJECT_ROOT__/';

export function sanitizeReviewMarkdown(markdown, projectRoot) {
  const sanitized = relativizeReviewMarkdown(markdown, projectRoot);
  const remainingAbsolutePath = findAbsoluteLocalPath(sanitized);
  if (remainingAbsolutePath) {
    throw new Error(
      '日志中仍包含项目根目录之外的绝对本地路径：' + remainingAbsolutePath,
    );
  }

  return sanitized;
}

export function relativizeReviewMarkdown(markdown, projectRoot) {
  const root = normalizeConfiguredRoot(projectRoot);
  let sanitized = markdown;
  for (const pattern of projectRootPatterns(root)) {
    sanitized = sanitized.replace(pattern, ROOT_TOKEN);
  }
  sanitized = markReviewFileLinks(sanitized);
  return sanitized.replaceAll(ROOT_TOKEN, '');
}

export function reviewFilePathFromUrl(value) {
  if (!value.startsWith(REVIEW_FILE_SCHEME)) return null;
  const encoded = value.slice(REVIEW_FILE_SCHEME.length);
  if (!encoded) return null;
  try {
    return decodeURIComponent(encoded);
  } catch {
    return null;
  }
}

export function findAbsoluteLocalPath(value) {
  const patterns = [
    /file:\/{2,3}[^\s<>"')\]]+/i,
    /(?:^|[^A-Za-z0-9+.-])([A-Za-z]:[\\/][^\r\n<>"']*)/m,
    /(?:^|[\s("'\`=])((?:\\\\|\/\/)[^\\/\s]+[\\/][^\r\n<>"']*)/m,
    /(?:^|[\s("'\`=])((?:\/(?:home|Users|mnt|Volumes|workspace|workspaces|tmp|opt|srv)\/)[^\r\n<>"']*)/m,
  ];
  for (const pattern of patterns) {
    const match = value.match(pattern);
    if (!match) continue;
    const candidate = (match[1] ?? match[0]).trim();
    return candidate.slice(0, 160);
  }
  return null;
}

function normalizeConfiguredRoot(projectRoot) {
  const root = String(projectRoot ?? '').trim().replace(/[\\/]+$/, '');
  if (
    !root ||
    root === '/' ||
    /^[A-Za-z]:$/.test(root) ||
    !(
      /^[A-Za-z]:[\\/]/.test(root) ||
      /^(?:\\\\|\/\/)[^\\/]+[\\/][^\\/]+/.test(root) ||
      /^\//.test(root)
    )
  ) {
    throw new Error('REVIEW_PROJECT_ROOT 必须是具体项目的绝对路径。');
  }
  return root;
}

function projectRootPatterns(root) {
  if (/^[A-Za-z]:[\\/]/.test(root)) {
    const segments = root.split(/[\\/]+/);
    const raw = segments.map(escapeRegex).join('[\\\\/]+');
    const slashRoot = root.replace(/\\/g, '/');
    return [
      new RegExp(raw + '[\\\\/]+', 'gi'),
      new RegExp('file:\\/{2,3}' + slashRoot.split('/').map(escapeRegex).join('/+') + '/+', 'gi'),
      new RegExp(escapeRegex(encodeURI('file:///' + slashRoot + '/')), 'gi'),
    ];
  }

  if (/^(?:\\\\|\/\/)/.test(root)) {
    const slashRoot = root.replace(/^\\\\/, '//').replace(/\\/g, '/');
    const segments = slashRoot.slice(2).split('/').filter(Boolean);
    const rawBody = segments.map(escapeRegex).join('[\\\\/]+');
    return [
      new RegExp('(?:\\\\\\\\|//)' + rawBody + '[\\\\/]+', 'gi'),
      new RegExp('file://'+ segments.map(escapeRegex).join('/+') + '/+', 'gi'),
      new RegExp(escapeRegex(encodeURI('file:' + slashRoot + '/')), 'gi'),
    ];
  }

  const segments = root.split('/').filter(Boolean);
  const raw = '/+' + segments.map(escapeRegex).join('/+') + '/+';
  const slashRoot = '/' + segments.join('/');
  return [
    new RegExp(raw, 'g'),
    new RegExp('file:\\/{2}' + raw, 'g'),
    new RegExp(escapeRegex(encodeURI('file://' + slashRoot + '/')), 'g'),
  ];
}

function markReviewFileLinks(markdown) {
  const escapedToken = escapeRegex(ROOT_TOKEN);
  let result = markdown.replace(
    new RegExp('(\\]\\(\\s*<)(' + escapedToken + '[^>\\r\\n]+)(>\\s*\\))', 'g'),
    (_match, before, destination, after) =>
      before + reviewFileUrl(destination.slice(ROOT_TOKEN.length)) + after,
  );
  result = result.replace(
    new RegExp('(\\]\\(\\s*)(' + escapedToken + '[^\\s)\\r\\n]+)(\\s*\\))', 'g'),
    (_match, before, destination, after) =>
      before + reviewFileUrl(destination.slice(ROOT_TOKEN.length)) + after,
  );
  return result;
}

function reviewFileUrl(relativePath) {
  const normalized = relativePath.replace(/\\/g, '/').replace(/^\/+/, '');
  return REVIEW_FILE_SCHEME + encodeURIComponent(normalized);
}

function escapeRegex(value) {
  return value.replace(/[.*+?^$()|[\]{}\\]/g, '\\$&');
}
