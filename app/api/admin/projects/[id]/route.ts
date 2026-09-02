import { globalAdminUser, projectAdminErrorResponse } from '@/lib/global-admin-api';
import { ProjectAdminError, updateAdminProject } from '@/lib/project-administration';

type RouteContext = { params: Promise<{ id: string }> };

export async function PATCH(request: Request, context: RouteContext) {
  const auth = await globalAdminUser();
  if (auth.response) return auth.response;
  try {
    const id = Number((await context.params).id);
    if (!Number.isInteger(id) || id <= 0) {
      throw new ProjectAdminError('项目 ID 无效。', 'invalid_project_id', 400);
    }
    const project = await updateAdminProject(auth.user, id, await request.json());
    return Response.json({ project });
  } catch (error) {
    return projectAdminErrorResponse(error);
  }
}
