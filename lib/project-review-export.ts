import { parseReviewFilters } from '@/lib/review-filters';
import {
  getIssueExportRows,
  getReviewExportRows,
  toCsv,
  toIssueWorkbook,
  type ReviewProjectIdentity,
} from '@/lib/reviews';

export async function exportIssuesForProject(
  request: Request,
  project: ReviewProjectIdentity,
): Promise<Response> {
  try {
    const filters = parseReviewFilters(new URL(request.url));
    const workbook = toIssueWorkbook(
      await getIssueExportRows(project, filters),
      new URL(request.url).origin,
    );
    const date = new Date().toISOString().slice(0, 10);
    const filename = `${project.slug}-审查问题-${date}.xlsx`;
    return new Response(Uint8Array.from(workbook).buffer, {
      headers: {
        'content-type': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
        'content-disposition': `attachment; filename="${project.slug}-review-issues-${date}.xlsx"; filename*=UTF-8''${encodeURIComponent(filename)}`,
      },
    });
  } catch (error) {
    return Response.json(
      { error: error instanceof Error ? error.message : '导出参数无效。' },
      { status: 400 },
    );
  }
}

export async function exportReviewsForProject(
  request: Request,
  project: ReviewProjectIdentity,
): Promise<Response> {
  try {
    const filters = parseReviewFilters(new URL(request.url));
    const csv = '\uFEFF' + toCsv(await getReviewExportRows(project, filters));
    const date = new Date().toISOString().slice(0, 10);
    return new Response(csv, {
      headers: {
        'content-type': 'text/csv; charset=utf-8',
        'content-disposition': `attachment; filename="reviews-${project.slug}-${date}.csv"`,
      },
    });
  } catch (error) {
    return Response.json(
      { error: error instanceof Error ? error.message : '导出参数无效。' },
      { status: 400 },
    );
  }
}
