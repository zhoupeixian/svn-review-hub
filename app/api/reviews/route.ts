import { getChatGPTUser } from '@/app/chatgpt-auth';
import {
  allowAdministrator,
  getReviewPage,
  ingestReview,
  isSyncRequestAuthorized,
} from '@/lib/reviews';
import { ISSUE_STATUSES } from '@/lib/issue-lifecycle';

type SyncPayload = {
  markdown?: unknown;
  sourceKey?: unknown;
  sourceName?: unknown;
};

export function parseReviewFilters(url: URL) {
  const status = url.searchParams.get('status') || undefined;
  if (status && !ISSUE_STATUSES.includes(status as (typeof ISSUE_STATUSES)[number])) {
    throw new Error('问题状态无效。');
  }
  const severity = url.searchParams.get('severity') || undefined;
  if (severity && !['P1', 'P2', 'P3'].includes(severity)) {
    throw new Error('问题等级无效。');
  }
  const revisionValue = url.searchParams.get('revision');
  const parsedRevision = revisionValue ? Number(revisionValue) : undefined;
  if (revisionValue && (parsedRevision === undefined || !Number.isInteger(parsedRevision) || parsedRevision < 0)) {
    throw new Error('Revision 无效。');
  }
  const scope = url.searchParams.get('scope') || undefined;
  if (scope && scope !== 'active' && scope !== 'archived') {
    throw new Error('审查范围无效。');
  }
  const limitValue = url.searchParams.get('limit');
  const parsedLimit = limitValue ? Number(limitValue) : undefined;
  if (limitValue && (parsedLimit === undefined || !Number.isInteger(parsedLimit) || parsedLimit <= 0)) {
    throw new Error('分页大小无效。');
  }
  return {
    scope: scope as 'active' | 'archived' | undefined,
    fromDate: url.searchParams.get('fromDate') || undefined,
    toDate: url.searchParams.get('toDate') || undefined,
    author: url.searchParams.get('author') || undefined,
    revision: parsedRevision,
    severity: severity as 'P1' | 'P2' | 'P3' | undefined,
    status: status as (typeof ISSUE_STATUSES)[number] | undefined,
    keyword: url.searchParams.get('keyword') || undefined,
    cursor: url.searchParams.get('cursor') || undefined,
    limit: parsedLimit,
  };
}

export async function GET(request: Request) {
  try {
    const filters = parseReviewFilters(new URL(request.url));
    return Response.json(await getReviewPage(filters));
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
