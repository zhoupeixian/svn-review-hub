export type PageCursor = {
  updatedAt: string;
  id: number;
};

export type PageResult<T> = {
  items: T[];
  nextCursor: string | null;
};

const DEFAULT_PAGE_SIZE = 20;
const LARGE_PAGE_SIZE = 50;

export function encodePageCursor(cursor: PageCursor): string {
  assertPageCursor(cursor);
  return toBase64Url(JSON.stringify(cursor));
}

export function decodePageCursor(value: string): PageCursor {
  try {
    if (typeof value !== 'string' || !value) throw new Error();
    const decoded = JSON.parse(fromBase64Url(value));
    assertPageCursor(decoded);
    return decoded;
  } catch {
    throw new Error('无效的分页游标');
  }
}

export function normalizePageSize(value: unknown): 20 | 50 {
  return Number(value) === LARGE_PAGE_SIZE ? LARGE_PAGE_SIZE : DEFAULT_PAGE_SIZE;
}

function assertPageCursor(value: unknown): asserts value is PageCursor {
  if (
    !value ||
    typeof value !== 'object' ||
    Array.isArray(value) ||
    typeof (value as PageCursor).updatedAt !== 'string' ||
    !(value as PageCursor).updatedAt.trim() ||
    !Number.isInteger((value as PageCursor).id)
  ) {
    throw new Error('无效的分页游标');
  }
}

function toBase64Url(value: string): string {
  const bytes = new TextEncoder().encode(value);
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function fromBase64Url(value: string): string {
  if (!/^[A-Za-z0-9_-]+$/.test(value)) throw new Error('无效的分页游标');
  const base64 = value.replace(/-/g, '+').replace(/_/g, '/');
  const padding = '='.repeat((4 - (base64.length % 4)) % 4);
  const binary = atob(base64 + padding);
  const bytes = Uint8Array.from(binary, (character) => character.charCodeAt(0));
  return new TextDecoder().decode(bytes);
}
