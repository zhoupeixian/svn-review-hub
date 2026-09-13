import { env } from '@/lib/runtime';
import { consumeAnonymousUpdate } from '@/lib/anonymous-rate-limit';
import { parseIssueUpdateInput } from '@/lib/issue-lifecycle';
import { ensureReviewSchema } from '@/lib/reviews';

type RuntimeEnv = { DB: D1Database };

export async function updateIssueStatusForProject(
  request: Request,
  projectId: number,
  issueId: number,
): Promise<Response> {
  if (!Number.isInteger(issueId) || issueId <= 0) {
    return Response.json({ error: '未找到当前问题。' }, { status: 404 });
  }

  try {
    await ensureReviewSchema();
    const db = (env as unknown as RuntimeEnv).DB;
    const current = await db
      .prepare(
        `SELECT i.status AS status, i.version AS version,
                i.source_current AS sourceCurrent, l.archived_at AS archivedAt
         FROM review_issues i
         JOIN review_logs l ON l.id = i.review_id
         WHERE i.id = ? AND l.project_id = ?`,
      )
      .bind(issueId, projectId)
      .first<{
        status: string;
        version: number;
        sourceCurrent: number;
        archivedAt: string | null;
      }>();
    if (!current || current.sourceCurrent !== 1 || current.archivedAt !== null) {
      return Response.json({ error: '未找到当前问题。' }, { status: 404 });
    }

    let input: ReturnType<typeof parseIssueUpdateInput>;
    try {
      const body = (await request.json()) as unknown;
      if (
        !body ||
        typeof body !== 'object' ||
        Array.isArray(body) ||
        Object.keys(body).some((key) => !['status', 'note', 'version'].includes(key))
      ) {
        return Response.json({ error: '问题更新参数包含不支持的字段。' }, { status: 400 });
      }
      input = parseIssueUpdateInput(body);
    } catch (error) {
      return Response.json(
        { error: error instanceof Error ? error.message : '问题更新参数无效。' },
        { status: 400 },
      );
    }

    const anonymous = await consumeAnonymousUpdate(projectId, request);
    if (!anonymous.allowed) {
      return Response.json({ error: '匿名更新次数已达到当前窗口上限。' }, { status: 429 });
    }

    const updatedAt = new Date().toISOString();
    const [, updated] = await db.batch<{ version: number; statusUpdatedAt: string }>([
      db.prepare(
        `INSERT INTO review_issue_events
         (issue_id, from_status, to_status, note, created_at, anonymous_source_hash)
         SELECT i.id, i.status, ?, ?, ?, ?
         FROM review_issues i
         JOIN review_logs l ON l.id = i.review_id
         JOIN review_projects p ON p.id = l.project_id
         WHERE i.id = ? AND l.project_id = ?
           AND i.source_current = 1 AND i.version = ? AND l.archived_at IS NULL
           AND p.enabled = 1`,
      ).bind(
        input.status,
        input.note,
        updatedAt,
        anonymous.sourceHash,
        issueId,
        projectId,
        input.version,
      ),
      db.prepare(
        `UPDATE review_issues
         SET status = ?, status_note = ?, status_updated_at = ?, version = version + 1
         WHERE id = ? AND source_current = 1 AND version = ?
           AND EXISTS (
             SELECT 1 FROM review_logs l
             JOIN review_projects p ON p.id = l.project_id
             WHERE l.id = review_issues.review_id
               AND l.project_id = ? AND l.archived_at IS NULL AND p.enabled = 1
           )
         RETURNING version, status_updated_at AS statusUpdatedAt`,
      ).bind(
        input.status,
        input.note,
        updatedAt,
        issueId,
        input.version,
        projectId,
      ),
    ]);
    if (!updated.results?.length) {
      const latest = await db.prepare(
        `SELECT i.version, p.enabled AS projectEnabled
         FROM review_issues i
         JOIN review_logs l ON l.id = i.review_id
         JOIN review_projects p ON p.id = l.project_id
         WHERE i.id = ? AND l.project_id = ?`,
      ).bind(issueId, projectId).first<{ version: number; projectEnabled: number }>();
      if (latest?.projectEnabled !== 1) {
        return Response.json({ error: '未找到当前问题。' }, { status: 404 });
      }
      return Response.json(
        { error: '问题版本已变化，请刷新后重试。', currentVersion: latest?.version ?? current.version },
        { status: 409 },
      );
    }

    return Response.json({
      id: issueId,
      status: input.status,
      statusNote: input.note,
      statusUpdatedAt: updatedAt,
      version: updated.results[0].version,
    });
  } catch (error) {
    return Response.json(
      { error: error instanceof Error ? error.message : '更新问题时发生未知错误。' },
      { status: 500 },
    );
  }
}
