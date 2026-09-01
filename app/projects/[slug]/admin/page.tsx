import { notFound } from 'next/navigation';
import { requireChatGPTUser } from '@/app/chatgpt-auth';
import ArchiveManager from '@/app/admin/archive-manager';
import UploadForm from '@/app/admin/upload-form';
import { allowAdministrator, getEnabledReviewProject, getReviewPage } from '@/lib/reviews';

export const dynamic = 'force-dynamic';

type Props = {
  params: Promise<{ slug: string }>;
};

export default async function ProjectAdminPage({ params }: Props) {
  const { slug } = await params;
  const project = await getEnabledReviewProject(slug);
  if (!project) notFound();
  const basePath = `/projects/${project.slug}`;
  const user = await requireChatGPTUser(`${basePath}/admin`);
  const isAdmin = await allowAdministrator(user);
  const [activePage, archivedPage] = isAdmin
    ? await Promise.all([
        getReviewPage(project.id, { scope: 'active' }),
        getReviewPage(project.id, { scope: 'archived' }),
      ])
    : [{ items: [], nextCursor: null, hasMore: false }, { items: [], nextCursor: null, hasMore: false }];

  if (!isAdmin) {
    return (
      <main className="grid min-h-screen place-items-center bg-[#f6f7f3] px-5 text-[#17211d]">
        <section className="w-full max-w-lg rounded-3xl border border-[#d9e3da] bg-white p-8 text-center shadow-[0_14px_40px_rgba(31,77,51,0.07)]">
          <p className="text-xs font-bold uppercase tracking-[0.15em] text-[#987020]">访问受限</p>
          <h1 className="mt-3 text-2xl font-black tracking-tight text-[#253e32]">这是管理员管理区</h1>
          <p className="mt-3 text-sm leading-6 text-[#617268]">上传和归档管理仅向已登记的全局管理员开放。</p>
          <a href={basePath} className="mt-6 inline-flex rounded-lg bg-[#1e6349] px-4 py-2.5 text-sm font-bold text-white">返回 {project.name}</a>
        </section>
      </main>
    );
  }

  return (
    <main className="min-h-screen bg-[#f6f7f3] text-[#17211d]">
      <header className="border-b border-[#dce4dc] bg-[#fdfefc]/95">
        <div className="mx-auto flex max-w-5xl items-center justify-between px-5 py-4 sm:px-8">
          <a href={basePath} className="text-sm font-bold text-[#245d46]">← 返回 {project.name}</a>
          <span className="rounded-full bg-[#eaf3eb] px-3 py-1.5 text-xs font-semibold text-[#38654c]">管理员：{user.displayName}</span>
        </div>
      </header>
      <div className="mx-auto max-w-5xl px-5 py-10 sm:px-8">
        <p className="text-xs font-bold uppercase tracking-[0.16em] text-[#37735a]">{project.name} 日志管理</p>
        <h1 className="mt-2 text-3xl font-black tracking-tight text-[#1b382b]">管理当前项目的审查日志</h1>
        <div className="mt-7 grid gap-4 sm:grid-cols-3">
          <StatusCard label="已归档日志" value={`${archivedPage.items.length} 份`} />
          <StatusCard label="最近审查日期" value={activePage.items[0]?.logDate ?? '暂无'} />
          <StatusCard label="当前审查项目" value={project.name} />
        </div>
        <section className="mt-8 rounded-3xl border border-[#d8e4d9] bg-white p-6 shadow-[0_12px_34px_rgba(31,77,51,0.05)] sm:p-8">
          <p className="text-xs font-bold uppercase tracking-[0.14em] text-[#4c8068]">手工补录 / 更正</p>
          <h2 className="mt-1 text-xl font-black tracking-tight text-[#243e31]">上传审查日志 Markdown</h2>
          <p className="mt-2 text-sm leading-6 text-[#66766d]">日志将固定写入当前审查项目，不提供跨项目目标选择。</p>
          <UploadForm uploadApiPath={`/api/projects/${project.slug}/reviews`} />
        </section>
        <ArchiveManager
          initialActive={activePage}
          initialArchived={archivedPage}
          reviewsApiPath={`/api/projects/${project.slug}/reviews`}
          archiveApiPath={`/api/projects/${project.slug}/reviews/archive`}
          restoreApiPath={`/api/projects/${project.slug}/reviews/restore`}
        />
      </div>
    </main>
  );
}

function StatusCard({ label, value }: { label: string; value: string }) {
  return <div className="rounded-2xl border border-[#d5e2d6] bg-white p-5"><p className="text-xs font-semibold text-[#748278]">{label}</p><p className="mt-2 text-lg font-black text-[#28503c]">{value}</p></div>;
}
