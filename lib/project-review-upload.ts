import { getChatGPTUser } from '@/app/chatgpt-auth';
import {
  allowAdministrator,
  ingestReviewForProject,
  type ReviewProjectIdentity,
} from '@/lib/reviews';

export async function uploadReviewForProject(
  request: Request,
  project: ReviewProjectIdentity,
): Promise<Response> {
  try {
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
    const review = await ingestReviewForProject(project, {
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
