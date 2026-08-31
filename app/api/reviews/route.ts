import { getChatGPTUser } from '@/app/chatgpt-auth';
import {
  allowAdministrator,
  getEnabledReviewProject,
  getReviewPage,
  ingestReview,
  isSyncRequestAuthorized,
} from '@/lib/reviews';
import { parseReviewFilters } from '@/lib/review-filters';

export { parseReviewFilters } from '@/lib/review-filters';

type SyncPayload = {
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
    if (isSyncRequestAuthorized(request)) {
      const payload = (await request.json()) as SyncPayload;
      if (
        typeof payload.markdown !== 'string' ||
        typeof payload.sourceKey !== 'string' ||
        typeof payload.sourceName !== 'string'
      ) {
        return Response.json(
          { error: '自动同步请求缺少日志内容或来源信息。' },
          { status: 400 },
        );
      }

      const review = await ingestReview({
        markdown: payload.markdown,
        sourceKey: payload.sourceKey,
        sourceName: payload.sourceName,
        importedBy: 'SVN 当日提交审查自动化',
        syncMode: 'automation',
      });
      return Response.json({ review, mode: 'automation' }, { status: 201 });
    }

    const user = await getChatGPTUser();
    if (!user) {
      return Response.json(
        { error: '请先使用管理员账号登录。' },
        { status: 401 },
      );
    }
    if (!(await allowAdministrator(user))) {
      return Response.json(
        { error: '当前账号没有上传审查日志的权限。' },
        { status: 403 },
      );
    }

    const form = await request.formData();
    const file = form.get('file');
    if (!(file instanceof File)) {
      return Response.json({ error: '请选择 Markdown 日志文件。' }, { status: 400 });
    }
    if (!file.name.toLowerCase().endsWith('.md')) {
      return Response.json({ error: '仅支持 .md 格式的审查日志。' }, { status: 400 });
    }

    const sourceKey =
      typeof form.get('sourceKey') === 'string' && String(form.get('sourceKey')).trim()
        ? String(form.get('sourceKey')).trim()
        : 'manual/' + file.name;
    const review = await ingestReview({
      markdown: await file.text(),
      sourceKey,
      sourceName: file.name,
      importedBy: user.email,
      syncMode: 'manual',
    });
    return Response.json({ review, mode: 'manual' }, { status: 201 });
  } catch (error) {
    const message = error instanceof Error ? error.message : '导入日志时发生未知错误。';
    return Response.json({ error: message }, { status: 400 });
  }
}
