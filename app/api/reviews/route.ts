import {
  authorizeProjectSync,
  getEnabledReviewProject,
  getReviewPage,
  ingestReviewForProject,
} from '@/lib/reviews';
import { parseReviewFilters } from '@/lib/review-filters';
import { handleEnabledReviewProject } from '@/lib/project-api';
import { uploadReviewForProject } from '@/lib/project-review-upload';

export { parseReviewFilters } from '@/lib/review-filters';

type SyncPayload = {
  projectSlug?: unknown;
  markdown?: unknown;
  sourceKey?: unknown;
  sourceName?: unknown;
};

export async function GET(request: Request) {
  try {
    const project = await getEnabledReviewProject('zherp');
    if (!project) return Response.json({ error: '审查项目不存在。' }, { status: 404 });
    const filters = parseReviewFilters(new URL(request.url));
    return Response.json(await getReviewPage(project.id, filters));
  } catch (error) {
    return Response.json(
      { error: error instanceof Error ? error.message : '查询参数无效。' },
      { status: 400 },
    );
  }
}

export async function POST(request: Request) {
  try {
    if (request.headers.get('content-type')?.includes('application/json')) {
      const payload = (await request.json()) as SyncPayload;
      if (
        typeof payload.projectSlug !== 'string' ||
        typeof payload.markdown !== 'string' ||
        typeof payload.sourceKey !== 'string' ||
        typeof payload.sourceName !== 'string'
      ) {
        return Response.json(
          { error: '自动同步请求缺少项目标识、日志内容或来源信息。' },
          { status: 400 },
        );
      }

      let project;
      try {
        project = await authorizeProjectSync(
          payload.projectSlug,
          request.headers.get('x-review-sync-key') ?? '',
        );
      } catch {
        return Response.json(
          { error: '站点项目同步密钥配置异常。' },
          { status: 500 },
        );
      }
      if (!project) {
        return Response.json(
          { error: '项目或项目同步密钥无效。' },
          { status: 401 },
        );
      }

      const review = await ingestReviewForProject(project, {
        markdown: payload.markdown,
        sourceKey: payload.sourceKey,
        sourceName: payload.sourceName,
        importedBy: 'SVN 当日提交审查自动化',
        syncMode: 'automation',
      });
      return Response.json({ review, mode: 'automation' }, { status: 201 });
    }

    return handleEnabledReviewProject('zherp', (project) =>
      uploadReviewForProject(request, project));
  } catch (error) {
    const message = error instanceof Error ? error.message : '导入日志时发生未知错误。';
    return Response.json({ error: message }, { status: 400 });
  }
}
