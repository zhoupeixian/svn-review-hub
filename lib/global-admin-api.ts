import { getChatGPTUser, type ChatGPTUser } from '@/app/chatgpt-auth';
import { allowAdministrator } from '@/lib/reviews';
import { ProjectAdminError } from '@/lib/project-administration';

export async function globalAdminUser(): Promise<
  { user: ChatGPTUser; response?: never } | { user?: never; response: Response }
> {
  const user = await getChatGPTUser();
  if (!user) {
    return {
      response: Response.json({ error: '请先使用管理员账号登录。' }, { status: 401 }),
    };
  }
  if (!(await allowAdministrator(user))) {
    return {
      response: Response.json({ error: '当前账号没有全局项目管理权限。' }, { status: 403 }),
    };
  }
  return { user };
}

export function projectAdminErrorResponse(error: unknown): Response {
  if (error instanceof ProjectAdminError) {
    return Response.json({ error: error.message, code: error.code }, { status: error.status });
  }
  if (error instanceof SyntaxError) {
    return Response.json(
      { error: '请求 JSON 格式无效。', code: 'invalid_json' },
      { status: 400 },
    );
  }
  return Response.json(
    { error: '项目维护暂时不可用。' },
    { status: 500 },
  );
}
