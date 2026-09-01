import { env } from 'cloudflare:workers';
import { getChatGPTUser } from '@/app/chatgpt-auth';
import { handleEnabledReviewProject } from '@/lib/project-api';
import {
  allowAdministrator,
  ensureReviewSchema,
  type ReviewProjectIdentity,
} from '@/lib/reviews';

type RuntimeEnv = { DB: D1Database };

export async function restoreReviewsForProject(
  request: Request,
  project: ReviewProjectIdentity,
): Promise<Response> {
  try {
    const projectId = project.id;
    const user = await getChatGPTUser();
    if (!user) return Response.json({ error: '请先使用管理员账号登录。' }, { status: 401 });
    if (!(await allowAdministrator(user))) {
      return Response.json({ error: '当前账号没有恢复权限。' }, { status: 403 });
    }
    const body = (await request.json()) as { ids?: unknown };
    if (!Array.isArray(body.ids) || body.ids.length === 0) {
      return Response.json({ error: '请提供已归档日志 ID。' }, { status: 400 });
    }
    const ids = body.ids.map(Number);
    if (ids.some((id) => !Number.isInteger(id) || id <= 0)) {
      return Response.json({ error: '日志 ID 无效。' }, { status: 400 });
    }
    const uniqueIds = [...new Set(ids)];
    await ensureReviewSchema();
    const database = (env as unknown as RuntimeEnv).DB;
    const marks = uniqueIds.map(() => '?').join(',');
    const before = await database
      .prepare(`SELECT COUNT(*) AS count FROM review_logs WHERE project_id = ? AND id IN (${marks}) AND archived_at IS NOT NULL`)
      .bind(projectId, ...uniqueIds)
      .first<{ count: number }>();
    if ((before?.count ?? 0) !== uniqueIds.length) {
      return Response.json({ error: '仅可恢复已归档且存在的日志。' }, { status: 404 });
    }
    const result = await database
      .prepare(`UPDATE review_logs SET archived_at = NULL WHERE project_id = ? AND id IN (${marks}) AND archived_at IS NOT NULL`)
      .bind(projectId, ...uniqueIds)
      .run();
    if (Number(result.meta.changes ?? 0) !== uniqueIds.length) {
      const check = await database
        .prepare(`SELECT COUNT(*) AS count FROM review_logs WHERE project_id = ? AND id IN (${marks}) AND archived_at IS NULL`)
        .bind(projectId, ...uniqueIds)
        .first<{ count: number }>();
      if ((check?.count ?? 0) === uniqueIds.length) {
        return Response.json({ restoredCount: uniqueIds.length });
      }
      return Response.json({ error: '仅可恢复已归档且存在的日志。' }, { status: 404 });
    }
    return Response.json({ restoredCount: uniqueIds.length });
  } catch (error) {
    return Response.json(
      { error: error instanceof Error ? error.message : '恢复操作失败。' },
      { status: 400 },
    );
  }
}

export async function POST(request: Request) {
  return handleEnabledReviewProject('zherp', (project) =>
    restoreReviewsForProject(request, project));
}
