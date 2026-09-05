import { globalAdminUser, projectAdminErrorResponse } from '@/lib/global-admin-api';
import {
  deleteAdminProject,
  previewAdminProjectDeletion,
  ProjectAdminError,
} from '@/lib/project-administration';

type RouteContext = { params: Promise<{ id: string }> };

export async function GET(_request: Request, context: RouteContext) {
  const auth = await globalAdminUser();
  if (auth.response) return auth.response;
  try {
    const projectId = await routeProjectId(context);
    const preview = await previewAdminProjectDeletion(projectId);
    return Response.json(preview, {
      headers: { 'cache-control': 'no-store' },
    });
  } catch (error) {
    return projectAdminErrorResponse(error);
  }
}

export async function DELETE(request: Request, context: RouteContext) {
  const auth = await globalAdminUser();
  if (auth.response) return auth.response;
  try {
    const projectId = await routeProjectId(context);
    const result = await deleteAdminProject(auth.user, projectId, await request.json());
    return Response.json(result, {
      headers: { 'cache-control': 'no-store' },
    });
  } catch (error) {
    return projectAdminErrorResponse(error);
  }
}

async function routeProjectId(context: RouteContext): Promise<number> {
  const projectId = Number((await context.params).id);
  if (!Number.isSafeInteger(projectId) || projectId <= 0) {
    throw new ProjectAdminError('项目 ID 无效。', 'invalid_project_id', 400);
  }
  return projectId;
}
