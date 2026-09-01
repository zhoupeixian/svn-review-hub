import { updateIssueStatusForProject } from '@/lib/issue-status-update';
import { getEnabledReviewProject } from '@/lib/reviews';

type Context = {
  params: Promise<{ slug: string; id: string }>;
};

export async function PATCH(request: Request, { params }: Context) {
  const { slug, id } = await params;
  const project = await getEnabledReviewProject(slug);
  const issueId = Number(id);
  if (!project) {
    return Response.json({ error: '未找到当前问题。' }, { status: 404 });
  }
  return updateIssueStatusForProject(request, project.id, issueId);
}
