import ProjectDirectory from '@/app/components/project-directory';
import { getReviewProjectDirectory } from '@/lib/reviews';

export const dynamic = 'force-dynamic';

export default async function Home() {
  const projects = await getReviewProjectDirectory();

  return (
    <main className="min-h-screen bg-[#f6f7f3] text-[#17211d]">
      <header className="border-b border-[#dce4dc] bg-[#fdfefc]/95">
        <div className="mx-auto flex max-w-7xl items-center justify-between px-5 py-4 sm:px-8">
          <a href="/" className="flex items-center gap-3">
            <span className="grid h-9 w-9 place-items-center rounded-xl bg-[#1d5b46] text-sm font-black text-white">
              Z
            </span>
            <span>
              <span className="block text-sm font-bold tracking-tight">SVN 审查中心</span>
              <span className="block text-xs text-[#66766d]">项目目录</span>
            </span>
          </a>
          <a href="/admin" className="rounded-xl border border-[#bfd0c0] px-4 py-2 text-sm font-bold text-[#245d46]">
            管理入口
          </a>
        </div>
      </header>

      <section className="mx-auto max-w-7xl px-5 py-10 sm:px-8 sm:py-14">
        <p className="text-xs font-bold uppercase tracking-[0.16em] text-[#37735a]">
          项目目录
        </p>
        <h1 className="mt-3 max-w-3xl text-3xl font-black tracking-[-0.04em] text-[#18352b] sm:text-5xl">
          选择要查阅的审查项目
        </h1>
        <p className="mt-5 max-w-2xl text-base leading-7 text-[#5d6e64]">
          每个项目拥有独立的日志、问题、统计和归档。进入项目后即可查看最近审查和处理进度。
        </p>
        <div className="mt-8">
          <ProjectDirectory projects={projects} />
        </div>
      </section>
    </main>
  );
}
