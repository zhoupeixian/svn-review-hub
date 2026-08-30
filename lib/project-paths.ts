const PROJECT_ROOT = /(?:file:\/{2,3})?D:[\\/]SVN[\\/]ZHERP[\\/]/i;
const PROJECT_PATH = /(?:file:\/{2,3})?D:[\\/]SVN[\\/]ZHERP[\\/]([^\s)\]}>"']+)/gi;

export function projectRelativePath(value: string): string | null {
  let decoded = value;
  try { decoded = decodeURIComponent(value); } catch { /* preserve malformed input for display */ }
  const match = PROJECT_ROOT.exec(decoded);
  if (!match || match.index !== 0) return null;
  return decoded.slice(match[0].length).replace(/\\/g, '/');
}

export function relativizeProjectPaths(value: string): string {
  return value.replace(PROJECT_PATH, (_absolute, relative: string) => relative.replace(/\\/g, '/'));
}
