import { getEnabledReviewProject, getIssuePage } from '@/lib/reviews';
import { parseReviewFilters } from '@/lib/review-filters';

export async function GET(request: Request) {
  try {
    const project = await getEnabledReviewProject('zherp');
    if (!project) return Response.json({ error: '审查项目不存在。' }, { status: 404 });
    const filters = parseReviewFilters(new URL(request.url));
    return Response.json(await getIssuePage(project.id, filters));
  } catch (error) {
    return Response.json(
      { error: error instanceof Error ? error.message : '查询参数无效。' },
      { status: 400 },
    );
  }
}
