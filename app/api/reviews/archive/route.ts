import { env } from 'cloudflare:workers';
import { getChatGPTUser } from '@/app/chatgpt-auth';
import { parseReviewFilters } from '@/lib/review-filters';
import { allowAdministrator, ensureReviewSchema, getReviewPage } from '@/lib/reviews';

type RuntimeEnv = { DB: D1Database };
type ArchiveBody = {
  mode?: unknown;
  ids?: unknown;
  filters?: Record<string, unknown>;
  previewToken?: unknown;
};

function db(): D1Database {
  const value = (env as unknown as RuntimeEnv).DB;
  if (!value) throw new Error('审查站的数据存储尚未连接。');
  return value;
}

function normalizeIds(value: unknown): number[] {
  if (!Array.isArray(value) || value.length === 0) throw new Error('请提供日志 ID。');
  const ids = value.map((id) => Number(id));
  if (ids.some((id) => !Number.isInteger(id) || id <= 0)) throw new Error('日志 ID 无效。');
  return [...new Set(ids)];
}

async function idsFromBody(body: ArchiveBody): Promise<number[]> {
  if (body.ids !== undefined) return normalizeIds(body.ids);
  if (!body.filters || typeof body.filters !== 'object' || Array.isArray(body.filters)) {
    throw new Error('请提供日志 ID 或已验证过滤条件。');
  }
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(body.filters)) {
    if (value !== undefined && value !== null) params.set(key, String(value));
  }
  const filters = parseReviewFilters(new URL(`https://review.local/?${params}`));
  const ids: number[] = [];
  let cursor: string | undefined;
  do {
    const page = await getReviewPage(1, { ...filters, scope: 'active', cursor });
    ids.push(...page.items.map((item) => item.id));
    cursor = page.nextCursor ?? undefined;
  } while (cursor);
  if (!ids.length) throw new Error('没有符合条件的活动日志。');
  return ids;
}

function placeholders(count: number): string {
  return Array.from({ length: count }, () => '?').join(',');
}

async function currentCounts(ids: number[]) {
  const database = db();
  const marks = placeholders(ids.length);
  const reviewCount = await database
    .prepare(`SELECT COUNT(*) AS count FROM review_logs WHERE id IN (${marks}) AND archived_at IS NULL`)
    .bind(...ids)
    .first<{ count: number }>();
  const issueCounts = await database
    .prepare(
      `SELECT COUNT(*) AS issueCount,
              SUM(CASE WHEN status IN ('open', 'pending_review') THEN 1 ELSE 0 END) AS openIssueCount
       FROM review_issues WHERE review_id IN (${marks}) AND source_current = 1`,
    )
    .bind(...ids)
    .first<{ issueCount: number; openIssueCount: number | null }>();
  const revisions = await database
    .prepare(`SELECT COALESCE(SUM(revision_count), 0) AS revisionCount FROM review_logs WHERE id IN (${marks})`)
    .bind(...ids)
    .first<{ revisionCount: number }>();
  return {
    reviewCount: reviewCount?.count ?? 0,
    issueCount: issueCounts?.issueCount ?? 0,
    openIssueCount: issueCounts?.openIssueCount ?? 0,
    revisionCount: revisions?.revisionCount ?? 0,
  };
}

export async function POST(request: Request) {
  try {
    const user = await getChatGPTUser();
    if (!user) return Response.json({ error: '请先使用管理员账号登录。' }, { status: 401 });
    if (!(await allowAdministrator(user))) {
      return Response.json({ error: '当前账号没有归档权限。' }, { status: 403 });
    }
    await ensureReviewSchema();
    const body = (await request.json()) as ArchiveBody;
    if (body.mode !== 'preview' && body.mode !== 'confirm') {
      return Response.json({ error: '归档操作模式无效。' }, { status: 400 });
    }
    const database = db();

    if (body.mode === 'preview') {
      const ids = await idsFromBody(body);
      const counts = await currentCounts(ids);
      if (counts.reviewCount !== ids.length) {
        return Response.json({ error: '日志范围已变化，请重新筛选。' }, { status: 409 });
      }
      const token = crypto.randomUUID();
      const now = new Date();
      await database
        .prepare(
          `INSERT INTO archive_operation_previews
           (token, admin_user_id, review_ids_json, review_count, revision_count, issue_count, created_at, expires_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .bind(
          token,
          user.userId,
          JSON.stringify(ids),
          counts.reviewCount,
          counts.revisionCount,
          counts.issueCount,
          now.toISOString(),
          new Date(now.getTime() + 10 * 60 * 1000).toISOString(),
        )
        .run();
      return Response.json({ previewToken: token, ...counts });
    }

    if (typeof body.previewToken !== 'string' || !body.previewToken) {
      return Response.json({ error: '缺少预览令牌。' }, { status: 400 });
    }
    const preview = await database
      .prepare(
        `SELECT review_ids_json AS reviewIdsJson, review_count AS reviewCount, expires_at AS expiresAt
         FROM archive_operation_previews
         WHERE token = ? AND admin_user_id = ?`,
      )
      .bind(body.previewToken, user.userId)
      .first<{ reviewIdsJson: string; reviewCount: number; expiresAt: string }>();
    if (!preview || Date.parse(preview.expiresAt) <= Date.now()) {
      return Response.json({ error: '预览令牌无效或已过期。' }, { status: 409 });
    }
    let ids: number[];
    try {
      ids = normalizeIds(JSON.parse(preview.reviewIdsJson));
    } catch {
      return Response.json({ error: '预览令牌内容无效。' }, { status: 409 });
    }
    if (ids.length !== preview.reviewCount) {
      return Response.json({ error: '预览范围已变化，请重新预览。' }, { status: 409 });
    }
    const marks = placeholders(ids.length);
    const timestamp = new Date().toISOString();
    const before = await database
      .prepare(`SELECT COUNT(*) AS count FROM review_logs WHERE id IN (${marks}) AND archived_at IS NULL`)
      .bind(...ids)
      .first<{ count: number }>();
    if ((before?.count ?? 0) !== ids.length) {
      return Response.json({ error: '预览范围已变化，请重新预览。' }, { status: 409 });
    }
    const result = await database
      .prepare(
        `UPDATE review_logs SET archived_at = ?
         WHERE id IN (${marks}) AND archived_at IS NULL
           AND (SELECT COUNT(*) FROM review_logs WHERE id IN (${marks}) AND archived_at IS NULL) = ?`,
      )
      .bind(timestamp, ...ids, ...ids, ids.length)
      .run();
    const changed = Number(result.meta.changes ?? 0);
    if (changed !== ids.length) {
      const check = await database
        .prepare(`SELECT COUNT(*) AS count FROM review_logs WHERE id IN (${marks}) AND archived_at IS NOT NULL`)
        .bind(...ids)
        .first<{ count: number }>();
      if ((check?.count ?? 0) === ids.length) {
        await database.prepare('DELETE FROM archive_operation_previews WHERE token = ?').bind(body.previewToken).run();
        return Response.json({ archivedCount: ids.length, archivedAt: timestamp });
      }
      return Response.json({ error: '预览范围已变化，请重新预览。' }, { status: 409 });
    }
    await database.prepare('DELETE FROM archive_operation_previews WHERE token = ?').bind(body.previewToken).run();
    return Response.json({ archivedCount: ids.length, archivedAt: timestamp });
  } catch (error) {
    return Response.json(
      { error: error instanceof Error ? error.message : '归档操作失败。' },
      { status: 400 },
    );
  }
}
