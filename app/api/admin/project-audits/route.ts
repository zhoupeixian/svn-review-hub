import { globalAdminUser, projectAdminErrorResponse } from '@/lib/global-admin-api';
import { getProjectAdminAuditPage } from '@/lib/project-administration';

export async function GET(request: Request) {
  const auth = await globalAdminUser();
  if (auth.response) return auth.response;
  try {
    return Response.json(await getProjectAdminAuditPage(new URL(request.url)));
  } catch (error) {
    return projectAdminErrorResponse(error);
  }
}
