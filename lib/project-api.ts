import {
  allowAdministrator,
  getEnabledReviewProject,
  getReviewProject,
  type ReviewProject,
  type ReviewProjectIdentity,
} from '@/lib/reviews';
import { getChatGPTUser } from '@/app/chatgpt-auth';

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

export async function getAccessibleReviewProject(
  slug: string,
): Promise<ReviewProject | null> {
  const project = await getReviewProject(slug);
  if (!project || project.enabled) return project;
  const user = await getChatGPTUser();
  return user && await allowAdministrator(user) ? project : null;
}

export async function handleAccessibleReviewProject(
  locator: string | Promise<{ slug: string }>,
  action: (project: ReviewProject) => Promise<Response>,
): Promise<Response> {
  const slug = typeof locator === 'string' ? locator : (await locator).slug;
  const project = await getAccessibleReviewProject(slug);
  if (!project) {
    return Response.json({ error: '审查项目不存在。' }, { status: 404 });
  }
  return action(project);
}
