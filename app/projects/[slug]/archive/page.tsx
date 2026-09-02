import { notFound } from 'next/navigation';
import ArchiveExplorer, { type ArchiveFilters } from '@/app/archive/archive-explorer';
import { getEnabledReviewProject, getReviewPage } from '@/lib/reviews';

export const dynamic = 'force-dynamic';

type Props = {
  params: Promise<{ slug: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
};

export default async function ProjectArchivePage({ params, searchParams }: Props) {
  const { slug } = await params;
  const project = await getEnabledReviewProject(slug);
  if (!project) notFound();
  const raw = await searchParams;
  const value = (key: string) => typeof raw[key] === 'string' ? raw[key] as string : undefined;
  const filters: ArchiveFilters = {
    fromDate: value('fromDate') ?? value('from'),
    toDate: value('toDate') ?? value('to'),
    author: value('author'),
    revision: value('revision'),
    severity: value('severity'),
    status: value('status'),
    keyword: value('keyword') ?? value('q'),
  };
  const page = await getReviewPage(project.id, {
    scope: 'archived',
    fromDate: filters.fromDate,
    toDate: filters.toDate,
    author: filters.author,
    revision: filters.revision ? Number(filters.revision) : undefined,
    severity: filters.severity as 'P1' | 'P2' | 'P3' | undefined,
    status: filters.status as 'open' | 'pending_review' | 'resolved' | 'invalid' | 'by_design' | 'deferred' | undefined,
    keyword: filters.keyword,
  });
  const basePath = `/projects/${project.slug}`;

  return (
    <main className="min-h-screen bg-[#f6f7f3] text-[#17211d]">
      <header className="border-b border-[#dce4dc] bg-[#fdfefc]/95">
        <div className="mx-auto flex max-w-7xl items-center justify-between px-5 py-4 sm:px-8">
          <a href={basePath} className="text-sm font-bold text-[#245d46]">← 返回 {project.name}</a>
          <span className="text-sm font-bold text-[#355c49]">当前项目：{project.name}</span>
        </div>
      </header>
      <div className="mx-auto max-w-7xl px-5 py-10 sm:px-8 sm:py-14">
        <p className="text-xs font-bold uppercase tracking-[0.16em] text-[#3d7a61]">{project.name} · 公开只读</p>
        <h1 className="mt-2 text-3xl font-black tracking-tight text-[#18352b]">归档库</h1>
        <p className="mt-3 max-w-2xl text-sm leading-6 text-[#5d6e64]">这里只显示当前审查项目已经归档的日志。</p>
        <ArchiveExplorer
          initialItems={page.items}
          initialCursor={page.nextCursor}
          initialHasMore={page.hasMore}
          filters={filters}
          projectBasePath={basePath}
          reviewsApiPath={`/api/projects/${project.slug}/reviews`}
          reviewsExportPath={`/api/projects/${project.slug}/reviews/export`}
        />
      </div>
    </main>
  );
}
