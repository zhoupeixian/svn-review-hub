import { requireChatGPTUser } from '@/app/chatgpt-auth';
import ProjectAdminManager from '@/app/admin/project-admin-manager';
import {
  listAdminProjects,
  listProjectAdminAudits,
} from '@/lib/project-administration';
import { allowAdministrator } from '@/lib/reviews';

export const dynamic = 'force-dynamic';

export default async function GlobalAdminPage() {
  const user = await requireChatGPTUser('/admin');
  const isAdmin = await allowAdministrator(user);

  if (!isAdmin) {
    return (
      <main className="grid min-h-screen place-items-center bg-[#f6f7f3] px-5 text-[#17211d]">
        <section className="w-full max-w-lg rounded-3xl border border-[#d9e3da] bg-white p-8 text-center shadow-[0_14px_40px_rgba(31,77,51,0.07)]">
          <p className="text-xs font-bold uppercase tracking-[0.15em] text-[#987020]">访问受限</p>
          <h1 className="mt-3 text-2xl font-black tracking-tight text-[#253e32]">这是全局项目管理区</h1>
          <p className="mt-3 text-sm leading-6 text-[#617268]">项目资料、排序与审计仅向已登记的全局管理员开放。</p>
          <a href="/" className="mt-6 inline-flex rounded-lg bg-[#1e6349] px-4 py-2.5 text-sm font-bold text-white">返回项目目录</a>
        </section>
      </main>
    );
  }

  const [projects, audits] = await Promise.all([
    listAdminProjects(),
    listProjectAdminAudits(new URL('https://app.local/api/admin/project-audits')),
  ]);

  return (
    <main className="min-h-screen bg-[#f6f7f3] text-[#17211d]">
      <header className="border-b border-[#dce4dc] bg-[#fdfefc]/95">
        <div className="mx-auto flex max-w-6xl items-center justify-between px-5 py-4 sm:px-8">
          <a href="/" className="text-sm font-bold text-[#245d46]">← 返回项目目录</a>
          <span className="rounded-full bg-[#eaf3eb] px-3 py-1.5 text-xs font-semibold text-[#38654c]">全局管理员：{user.displayName}</span>
        </div>
      </header>
      <div className="mx-auto max-w-6xl px-5 py-10 sm:px-8">
        <ProjectAdminManager initialProjects={projects} initialAudits={audits} />
      </div>
    </main>
  );
}
