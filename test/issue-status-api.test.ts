/// <reference types="@cloudflare/vitest-plugin/types" />
import { env } from 'cloudflare:workers';
import { beforeEach, expect, it, vi } from 'vitest';

vi.mock('@/app/chatgpt-auth', () => ({ getChatGPTUser: vi.fn(async () => null) }));

import { GET } from '@/app/api/issues/route';
import { PATCH } from '@/app/api/issues/[id]/status/route';
import { ingestReview } from '@/lib/reviews';

const DB = (env as { DB: D1Database }).DB;

beforeEach(async () => {
  await DB.batch([
    DB.prepare('DELETE FROM anonymous_update_limits'),
    DB.prepare('DELETE FROM review_issue_events'),
    DB.prepare('DELETE FROM review_issues'),
    DB.prepare('DELETE FROM review_revisions'),
    DB.prepare('DELETE FROM review_logs'),
    DB.prepare('DELETE FROM review_search'),
  ]);
  await ingestReview({
    markdown: `# API 日志\n日期：2026-08-27\n审查范围：共 1 个 revision，实际审查 1 个，跳过 0 个\n总体结论：保留 1 个 P1\n\n| Revision | 提交人 | 提交时间 | 说明 | 结论 |\n| --- | --- | --- | --- | --- |\n| 100 | alice | 2026-08-27 09:00 | 提交 | 已审查 |\n\n### P1\n\n#### API 问题\n相关 revision：100\n\n详情\n`,
    sourceKey: 'api-test', sourceName: 'api.md', importedBy: 'test', syncMode: 'automation',
  });
});

it('PATCH 只更新状态列并记录事件', async () => {
  const issue = await DB.prepare('SELECT id FROM review_issues LIMIT 1').first<{ id: number }>();
  const response = await PATCH(new Request('https://review.test', {
    method: 'PATCH', headers: { 'CF-Connecting-IP': '192.0.2.1' },
    body: JSON.stringify({ status: 'resolved', note: '已修复', version: 0 }),
  }), { params: Promise.resolve({ id: String(issue!.id) }) });
  expect(response.status).toBe(200);
  expect((await response.json())).toMatchObject({ status: 'resolved', version: 1 });
  expect((await DB.prepare('SELECT COUNT(*) AS count FROM review_issue_events').first<{ count: number }>())?.count).toBe(1);
});

it('相同版本并发更新只允许一个成功', async () => {
  const issue = await DB.prepare('SELECT id FROM review_issues LIMIT 1').first<{ id: number }>();
  const make = () => PATCH(new Request('https://review.test', {
    method: 'PATCH', headers: { 'CF-Connecting-IP': crypto.randomUUID() },
    body: JSON.stringify({ status: 'resolved', note: '', version: 0 }),
  }), { params: Promise.resolve({ id: String(issue!.id) }) });
  const responses = await Promise.all([make(), make()]);
  expect(responses.map((response) => response.status).sort()).toEqual([200, 409]);
});

it('事件写入失败时不提交状态或版本变更', async () => {
  const issue = await DB.prepare('SELECT id FROM review_issues LIMIT 1').first<{ id: number }>();
  await DB.prepare(
    "CREATE TRIGGER issue_event_insert_fails BEFORE INSERT ON review_issue_events BEGIN SELECT RAISE(ABORT, 'event insert failed'); END",
  ).run();
  try {
    const response = await PATCH(new Request('https://review.test', {
      method: 'PATCH', headers: { 'CF-Connecting-IP': '192.0.2.2' },
      body: JSON.stringify({ status: 'resolved', note: '不应保存', version: 0 }),
    }), { params: Promise.resolve({ id: String(issue!.id) }) });
    expect(response.status).toBe(500);
  } finally {
    await DB.prepare('DROP TRIGGER issue_event_insert_fails').run();
  }
  const unchanged = await DB.prepare(
    'SELECT status, status_note AS statusNote, version FROM review_issues WHERE id = ?',
  ).bind(issue!.id).first<{ status: string; statusNote: string | null; version: number }>();
  expect(unchanged).toEqual({ status: 'open', statusNote: null, version: 0 });
  expect((await DB.prepare('SELECT COUNT(*) AS count FROM review_issue_events').first<{ count: number }>())?.count).toBe(0);
});

it('问题列表默认只返回活动当前源问题', async () => {
  const response = await GET(new Request('https://review.test/api/issues'));
  expect(response.status).toBe(200);
  expect(((await response.json()) as { items: unknown[] }).items).toHaveLength(1);
});
