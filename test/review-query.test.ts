import { describe, expect, it } from 'vitest';
import {
  decodePageCursor,
  encodePageCursor,
  normalizePageSize,
} from '../lib/review-query';

describe('分页游标', () => {
  it('可以往返编码与解码', () => {
    const cursor = { updatedAt: '2026-08-27T00:00:00.000Z', id: 42 };

    expect(decodePageCursor(encodePageCursor(cursor))).toEqual(cursor);
  });

  it('拒绝无效游标', () => {
    expect(() => decodePageCursor('not-a-valid-cursor')).toThrow('无效的分页游标');
    expect(() =>
      decodePageCursor('eyJ1cGRhdGVkQXQiOiIyMDI2LTA4LTI3VDAwOjAwOjAwLjAwMFoifQ'),
    ).toThrow('无效的分页游标');
  });

  it('拒绝含有额外字段或非法排序时间的游标', () => {
    expect(() =>
      decodePageCursor(
        toBase64Url({
          updatedAt: '2026-08-27T00:00:00.000Z',
          id: 42,
          scope: 'current',
        }),
      ),
    ).toThrow('无效的分页游标');
    expect(() =>
      decodePageCursor(toBase64Url({ updatedAt: 'not-a-date', id: 42 })),
    ).toThrow('无效的分页游标');
  });

  it('将分页条数规范为 20 或 50', () => {
    expect(normalizePageSize(undefined)).toBe(20);
    expect(normalizePageSize('50')).toBe(50);
  });
});

function toBase64Url(value: unknown): string {
  return btoa(JSON.stringify(value))
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
}
