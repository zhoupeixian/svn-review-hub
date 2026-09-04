import { globalAdminUser, projectAdminErrorResponse } from '@/lib/global-admin-api';
import { ProjectAdminError, rotateAdminProjectSyncKey } from '@/lib/project-administration';

type RouteContext = { params: Promise<{ id: string }> };

export async function POST(_request: Request, context: RouteContext) {
  const auth = await globalAdminUser();
  if (auth.response) return auth.response;
  try {
    const id = Number((await context.params).id);
    if (!Number.isSafeInteger(id) || id <= 0) {
      throw new ProjectAdminError('项目 ID 无效。', 'invalid_project_id', 400);
    }
    const project = await rotateAdminProjectSyncKey(auth.user, id);
    return Response.json(
      { project },
      { headers: { 'cache-control': 'no-store' } },
    );
  } catch (error) {
    return projectAdminErrorResponse(error);
  }
}
