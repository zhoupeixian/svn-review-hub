import { globalAdminUser, projectAdminErrorResponse } from '@/lib/global-admin-api';
import { createAdminProject, listAdminProjects } from '@/lib/project-administration';

export async function GET() {
  const auth = await globalAdminUser();
  if (auth.response) return auth.response;
  try {
    return Response.json({ projects: await listAdminProjects() });
  } catch (error) {
    return projectAdminErrorResponse(error);
  }
}

export async function POST(request: Request) {
  const auth = await globalAdminUser();
  if (auth.response) return auth.response;
  try {
    const project = await createAdminProject(auth.user, await request.json());
    return Response.json({ project }, { status: 201 });
  } catch (error) {
    return projectAdminErrorResponse(error);
  }
}
