import { getIssuePage } from '@/lib/reviews';
import { parseReviewFilters } from '@/app/api/reviews/route';

export async function GET(request: Request) {
  try {
    const filters = parseReviewFilters(new URL(request.url));
    return Response.json(await getIssuePage(filters));
  } catch (error) {
    return Response.json(
      { error: error instanceof Error ? error.message : '查询参数无效。' },
      { status: 400 },
    );
  }
}
