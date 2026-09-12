import { notFound } from 'next/navigation';
import { localAuthEnabled, safeLoginReturn } from '@/lib/local-auth';
import { getChatGPTUser } from '@/app/chatgpt-auth';

export default async function Login({ searchParams }: { searchParams: Promise<{ return_to?: string; error?: string }> }) {
  if (!localAuthEnabled()) notFound();
  const params = await searchParams;
  const user = await getChatGPTUser();
  return (
    <main className="mx-auto max-w-md px-6 py-16">
      <h1 className="text-2xl font-bold">管理员登录</h1>
      {user ? <>
        <p className="my-4">你已登录。</p>
        <a href={safeLoginReturn(params.return_to ?? null)}>进入管理页</a>
        <form action="/api/session/logout" method="post" className="mt-6"><button type="submit">退出登录</button></form>
      </> : <form action="/api/session" method="post" className="mt-6 space-y-4">
        <input type="hidden" name="return_to" value={safeLoginReturn(params.return_to ?? null)} />
        <label className="block">管理员密码<input className="mt-2 w-full rounded border p-3" type="password" name="password" autoComplete="current-password" required maxLength={256} /></label>
        {params.error && <p role="alert">登录失败，请检查密码；尝试过多时请在 15 分钟后重试。</p>}
        <button className="rounded bg-[#1d5b46] px-5 py-3 text-white" type="submit">登录</button>
      </form>}
      <p className="mt-8"><a href="/">返回项目目录</a></p>
    </main>
  );
}
