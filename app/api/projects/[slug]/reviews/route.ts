import { parseReviewFilters } from '@/lib/review-filters';
import { getEnabledReviewProject, getReviewPage } from '@/lib/reviews';

type Context = {
  params: Promise<{ slug: string }>;
};

export async function GET(request: Request, { params }: Context) {
  const { slug } = await params;
  const project = await getEnabledReviewProject(slug);
  if (!project) return Response.json({ error: '审查项目不存在。' }, { status: 404 });

  try {
    return Response.json(
      await getReviewPage(project.id, parseReviewFilters(new URL(request.url))),
    );
  } catch (error) {
    return Response.json(
      { error: error instanceof Error ? error.message : '查询参数无效。' },
      { status: 400 },
    );
  }
}

export async function POST(request: Request, { params }: Context) {
  const { slug } = await params;
  const project = await getEnabledReviewProject(slug);
  if (!project) {
    return Response.json({ error: '审查项目不存在。' }, { status: 404 });
  }
  const { uploadReviewForProject } = await import('@/lib/project-review-upload');
  return uploadReviewForProject(request, project);
}
