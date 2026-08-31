import { parseReviewFilters } from '@/lib/review-filters';
import { getIssueExportRows, toIssueWorkbook } from '@/lib/reviews';

export async function GET(request: Request) {
  try {
    const filters = parseReviewFilters(new URL(request.url));
    const workbook = toIssueWorkbook(
      await getIssueExportRows(1, filters),
      new URL(request.url).origin,
    );
    const date = new Date().toISOString().slice(0, 10);
    const filename = `ZHERP-审查问题-${date}.xlsx`;
    return new Response(Uint8Array.from(workbook).buffer, {
      headers: {
        'content-type': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
        'content-disposition': `attachment; filename="ZHERP-review-issues-${date}.xlsx"; filename*=UTF-8''${encodeURIComponent(filename)}`,
      },
    });
  } catch (error) {
    return Response.json(
      { error: error instanceof Error ? error.message : '导出参数无效。' },
      { status: 400 },
    );
  }
}
