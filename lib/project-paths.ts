import {
  relativizeReviewMarkdown,
  reviewFilePathFromUrl,
} from './review-path-sanitizer.js';

const LEGACY_ZHERP_ROOT = /(?:file:\/{2,3})?D:[\\/]SVN[\\/]ZHERP[\\/]/i;
const LEGACY_ZHERP_PATH = /(?:file:\/{2,3})?D:[\\/]SVN[\\/]ZHERP[\\/]([^\s)\]}>]+)/gi;

export function projectRelativePath(value: string): string | null {
  const sanitizedPath = reviewFilePathFromUrl(value);
  if (sanitizedPath) return sanitizedPath;

  let decoded = value;
  try { decoded = decodeURIComponent(value); } catch { /* preserve malformed input for display */ }
  const match = LEGACY_ZHERP_ROOT.exec(decoded);
  if (!match || match.index !== 0) return null;
  return decoded.slice(match[0].length).replace(/\\/g, '/');
}

export function relativizeProjectPaths(value: string): string {
  return value.replace(
    LEGACY_ZHERP_PATH,
    (_absolute, relative: string) => relative.replace(/\\/g, '/'),
  );
}

export function sanitizeStoredReviewMarkdown(value: string, projectSlug: string): string {
  if (projectSlug !== 'zherp') return value;
  const legacyRoot = ['D:', 'SVN', 'ZHERP'].join('\\\\');
  return relativizeReviewMarkdown(value, legacyRoot);
}
