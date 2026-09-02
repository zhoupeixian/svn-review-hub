import { globalAdminUser, projectAdminErrorResponse } from '@/lib/global-admin-api';
import { reorderAdminProjects } from '@/lib/project-administration';

export async function PUT(request: Request) {
  const auth = await globalAdminUser();
  if (auth.response) return auth.response;
  try {
    const projects = await reorderAdminProjects(auth.user, await request.json());
    return Response.json({ projects });
  } catch (error) {
    return projectAdminErrorResponse(error);
  }
}
