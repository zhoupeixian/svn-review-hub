import { archiveReviewsForProject } from '@/app/api/reviews/archive/route';
import { getEnabledReviewProject } from '@/lib/reviews';

type Context = {
  params: Promise<{ slug: string }>;
};

export async function POST(request: Request, { params }: Context) {
  const { slug } = await params;
  const project = await getEnabledReviewProject(slug);
  if (!project) {
    return Response.json({ error: '审查项目不存在。' }, { status: 404 });
  }
  return archiveReviewsForProject(request, project.id);
}
