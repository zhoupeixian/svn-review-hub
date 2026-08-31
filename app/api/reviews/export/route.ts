import { parseReviewFilters } from '@/lib/review-filters';
import { getReviewExportRows, toCsv } from '@/lib/reviews';

export async function GET(request: Request) {
  try {
    const filters = parseReviewFilters(new URL(request.url));
    const csv = '\uFEFF' + toCsv(await getReviewExportRows(1, filters));
    const date = new Date().toISOString().slice(0, 10);
    return new Response(csv, {
      headers: {
        'content-type': 'text/csv; charset=utf-8',
        'content-disposition': `attachment; filename="reviews-${date}.csv"`,
      },
    });
  } catch (error) {
    return Response.json(
      { error: error instanceof Error ? error.message : '导出参数无效。' },
      { status: 400 },
    );
  }
}
