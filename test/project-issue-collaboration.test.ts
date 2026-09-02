/// <reference types="@cloudflare/vitest-plugin/types" />

import { env } from 'cloudflare:workers';
import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { PATCH as patchProjectIssue } from '@/app/api/projects/[slug]/issues/[id]/status/route';
import { hashAnonymousSource } from '@/lib/anonymous-rate-limit';
import { ensureReviewSchema, ingestReview, ingestReviewForProject } from '@/lib/reviews';

const DB = (env as unknown as { DB: D1Database }).DB;

describe.sequential('按项目隔离匿名问题协作', () => {
  beforeAll(async () => {
    await ensureReviewSchema();
  });

  beforeEach(async () => {
    await DB.batch([
      DB.prepare('DELETE FROM anonymous_update_limits'),
      DB.prepare('DELETE FROM review_issue_events'),
      DB.prepare('DELETE FROM review_issues'),
      DB.prepare('DELETE FROM review_revisions'),
      DB.prepare('DELETE FROM review_logs'),
      DB.prepare('DELETE FROM review_search'),
      DB.prepare('DELETE FROM review_projects WHERE id <> 1'),
      DB.prepare(
        `INSERT INTO review_projects (
           id, name, slug, description, display_order, enabled
         ) VALUES (2, '海华项目', 'haihua', '', 10, 1)`,
      ),
    ]);
    await ingestReview(reviewInput('zherp-source'));
    await ingestReviewForProject(
      { id: 2, slug: 'haihua' },
      reviewInput('haihua-source'),
    );
  });

  it('通过一个项目地址提交另一个项目的问题 ID 时返回 404 且不写事件', async () => {
    const haihuaIssue = await issueForProject('haihua');

    const response = await patchProjectIssue(
      updateRequest('192.0.2.10'),
      {
        params: Promise.resolve({
          slug: 'zherp',
          id: String(haihuaIssue.id),
        }),
      },
    );

    expect(response.status).toBe(404);
    expect(await DB.prepare(
      'SELECT COUNT(*) AS count FROM review_issue_events',
    ).first()).toEqual({ count: 0 });
    expect(await issueForProject('haihua')).toMatchObject({
      status: 'open',
      version: 0,
    });
  });

  it('跨项目问题即使请求体无效也优先返回 404', async () => {
    const haihuaIssue = await issueForProject('haihua');
    const response = await patchProjectIssue(
      new Request('https://review.test/api/project/issues/status', {
        method: 'PATCH',
        body: '{',
      }),
      {
        params: Promise.resolve({
          slug: 'zherp',
          id: String(haihuaIssue.id),
        }),
      },
    );

    expect(response.status).toBe(404);
    expect(await DB.prepare(
      'SELECT COUNT(*) AS count FROM review_issue_events',
    ).first()).toEqual({ count: 0 });
  });

  it('更新一个项目的相同问题时不影响另一个项目', async () => {
    const zherpIssue = await issueForProject('zherp');
    const haihuaIssue = await issueForProject('haihua');

    const response = await patchProjectIssue(
      updateRequest('192.0.2.11'),
      {
        params: Promise.resolve({
          slug: 'haihua',
          id: String(haihuaIssue.id),
        }),
      },
    );

    expect(response.status).toBe(200);
    expect(await issueForProject('haihua')).toMatchObject({
      status: 'resolved',
      version: 1,
    });
    expect(await issueForProject('zherp')).toEqual(zherpIssue);
    expect(await DB.prepare(
      'SELECT issue_id AS issueId FROM review_issue_events',
    ).all()).toMatchObject({ results: [{ issueId: haihuaIssue.id }] });
  });

  it('同一匿名来源在不同项目分别限流并记录项目内来源摘要', async () => {
    const clientIp = '192.0.2.12';
    const zherpIssue = await issueForProject('zherp');
    const haihuaIssue = await issueForProject('haihua');

    for (let version = 0; version < 10; version += 1) {
      const response = await patchProjectIssue(
        updateRequest(
          clientIp,
          version % 2 === 0 ? 'resolved' : 'open',
          version,
        ),
        {
          params: Promise.resolve({
            slug: 'zherp',
            id: String(zherpIssue.id),
          }),
        },
      );
      expect(response.status).toBe(200);
    }

    const limited = await patchProjectIssue(
      updateRequest(clientIp, 'resolved', 10),
      {
        params: Promise.resolve({
          slug: 'zherp',
          id: String(zherpIssue.id),
        }),
      },
    );
    expect(limited.status).toBe(429);

    const otherProject = await patchProjectIssue(
      updateRequest(clientIp, 'resolved', 0),
      {
        params: Promise.resolve({
          slug: 'haihua',
          id: String(haihuaIssue.id),
        }),
      },
    );
    expect(otherProject.status).toBe(200);

    const hashes = await DB.prepare(
      `SELECT DISTINCT anonymous_source_hash AS sourceHash
       FROM review_issue_events
       ORDER BY anonymous_source_hash`,
    ).all<{ sourceHash: string }>();
    const enumerableHashes = await Promise.all([
      plainSha256(`1:${clientIp}`),
      plainSha256(`2:${clientIp}`),
    ]);
    expect(hashes.results).toHaveLength(2);
    expect(hashes.results.every((row) => /^[a-f0-9]{64}$/.test(row.sourceHash))).toBe(true);
    expect(hashes.results.every((row) => !enumerableHashes.includes(row.sourceHash))).toBe(true);
  });

  it('用至少 32 字符的服务端密钥生成可验证且随密钥变化的 HMAC', async () => {
    const source = '1:192.0.2.12';
    const firstKey = '0123456789abcdef0123456789abcdef';
    const secondKey = 'fedcba9876543210fedcba9876543210';

    await expect(hashAnonymousSource('', source)).rejects.toThrow('长度不足');
    await expect(hashAnonymousSource('too-short', source)).rejects.toThrow('长度不足');
    await expect(hashAnonymousSource(firstKey, source)).resolves.toBe(
      '296e51feb916c3a046f5152a9f97ae5dddc6068d8c016b58637cf14e65ae270c',
    );
    await expect(hashAnonymousSource(secondKey, source)).resolves.not.toBe(
      await hashAnonymousSource(firstKey, source),
    );
  });
});

async function plainSha256(value: string): Promise<string> {
  const digest = await crypto.subtle.digest(
    'SHA-256',
    new TextEncoder().encode(value),
  );
  return [...new Uint8Array(digest)]
    .map((part) => part.toString(16).padStart(2, '0'))
    .join('');
}

function reviewInput(sourceKey: string) {
  return {
    markdown: `# 项目问题协作日志
日期：2026-09-01
审查范围：共 1 个 revision，实际审查 1 个，跳过 0 个
总体结论：发现 1 个 P1

| Revision | 提交人 | 提交时间 | 说明 | 结论 |
| --- | --- | --- | --- | --- |
| 55000 | alice | 2026-09-01 09:00 | 相同提交 | 已审查 |

### P1

#### 相同问题
相关 revision：55000

两个项目中内容相同的问题。
`,
    sourceKey,
    sourceName: 'svn审查日志-2026-09-01.md',
    importedBy: 'test',
    syncMode: 'automation' as const,
  };
}

function updateRequest(
  clientIp: string,
  status = 'resolved',
  version = 0,
): Request {
  return new Request('https://review.test/api/project/issues/status', {
    method: 'PATCH',
    headers: {
      'content-type': 'application/json',
      'CF-Connecting-IP': clientIp,
    },
    body: JSON.stringify({ status, note: '已处理', version }),
  });
}

async function issueForProject(slug: string): Promise<{
  id: number;
  status: string;
  version: number;
}> {
  const issue = await DB.prepare(
    `SELECT i.id, i.status, i.version
     FROM review_issues i
     JOIN review_logs l ON l.id = i.review_id
     JOIN review_projects p ON p.id = l.project_id
     WHERE p.slug = ?`,
  ).bind(slug).first<{ id: number; status: string; version: number }>();
  if (!issue) throw new Error(`测试项目 ${slug} 没有问题。`);
  return issue;
}
