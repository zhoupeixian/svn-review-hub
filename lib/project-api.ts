import {
  getEnabledReviewProject,
  type ReviewProjectIdentity,
} from '@/lib/reviews';

export async function handleEnabledReviewProject(
  locator: string | Promise<{ slug: string }>,
  action: (project: ReviewProjectIdentity) => Promise<Response>,
): Promise<Response> {
  const slug = typeof locator === 'string' ? locator : (await locator).slug;
  const project = await getEnabledReviewProject(slug);
  if (!project) {
    return Response.json({ error: '审查项目不存在。' }, { status: 404 });
  }
  return action(project);
}
