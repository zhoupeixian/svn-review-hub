export type PageCursor = {
  updatedAt: string;
  id: number;
};

export type PageResult<T> = {
  items: T[];
  nextCursor: string | null;
  hasMore: boolean;
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
  const keys =
    value && typeof value === 'object' && !Array.isArray(value)
      ? Object.keys(value)
      : [];
  if (
    !value ||
    typeof value !== 'object' ||
    Array.isArray(value) ||
    keys.length !== 2 ||
    !keys.includes('updatedAt') ||
    !keys.includes('id') ||
    typeof (value as PageCursor).updatedAt !== 'string' ||
    !isIsoSortTimestamp((value as PageCursor).updatedAt) ||
    !Number.isInteger((value as PageCursor).id)
  ) {
    throw new Error('无效的分页游标');
  }
}

function isIsoSortTimestamp(value: string): boolean {
  const match = /^(\d{4})-(\d{2})-(\d{2})(?:T(\d{2}):(\d{2}):(\d{2})(?:\.\d+)?(?:Z|([+-])(\d{2}):(\d{2})))?$/.exec(
    value,
  );
  if (!match) return false;

  const [, year, month, day, hour, minute, second, , offsetHour, offsetMinute] =
    match;
  if (!isCalendarDate(Number(year), Number(month), Number(day))) return false;
  if (!hour) return true;

  return (
    Number(hour) <= 23 &&
    Number(minute) <= 59 &&
    Number(second) <= 59 &&
    (!offsetHour ||
      (Number(offsetHour) <= 23 && Number(offsetMinute) <= 59))
  );
}

function isCalendarDate(year: number, month: number, day: number): boolean {
  const date = new Date(Date.UTC(year, month - 1, day));
  return (
    month >= 1 &&
    month <= 12 &&
    day >= 1 &&
    date.getUTCFullYear() === year &&
    date.getUTCMonth() === month - 1 &&
    date.getUTCDate() === day
  );
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
