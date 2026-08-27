import { getReviewPage } from '@/lib/reviews';
import ArchiveExplorer, { type ArchiveFilters } from './archive-explorer';

export const dynamic = 'force-dynamic';

type Props = { searchParams: Promise<Record<string, string | string[] | undefined>> };

export default async function ArchivePage({ searchParams }: Props) {
  const raw = await searchParams;
  const value = (key: string) => typeof raw[key] === 'string' ? raw[key] as string : undefined;
  const filters: ArchiveFilters = {
    fromDate: value('fromDate') ?? value('from'),
    toDate: value('toDate') ?? value('to'),
    author: value('author'), revision: value('revision'), severity: value('severity'),
    status: value('status'), keyword: value('keyword') ?? value('q'),
  };
  const page = await getReviewPage({
    scope: 'archived', fromDate: filters.fromDate, toDate: filters.toDate, author: filters.author,
    revision: filters.revision ? Number(filters.revision) : undefined,
    severity: filters.severity as 'P1' | 'P2' | 'P3' | undefined,
    status: filters.status as 'open' | 'pending_review' | 'resolved' | 'invalid' | 'by_design' | 'deferred' | undefined,
    keyword: filters.keyword,
  });

  return (
    <main className="min-h-screen bg-[#f6f7f3] text-[#17211d]">
      <header className="border-b border-[#dce4dc] bg-[#fdfefc]/95">
        <div className="mx-auto flex max-w-7xl items-center justify-between px-5 py-4 sm:px-8">
          <a href="/" className="text-sm font-bold text-[#245d46]">← 返回当前日志</a>
          <nav className="flex items-center gap-3 text-sm"><a href="/issues" className="font-semibold text-[#456153]">问题看板</a><a href="/admin" className="rounded-lg border border-[#b9cbbb] bg-white px-3 py-2 font-medium text-[#1d5b46]">管理入口</a></nav>
        </div>
      </header>
      <div className="mx-auto max-w-7xl px-5 py-10 sm:px-8 sm:py-14">
        <p className="text-xs font-bold uppercase tracking-[0.16em] text-[#3d7a61]">公开只读</p>
        <h1 className="mt-2 text-3xl font-black tracking-tight text-[#18352b]">归档库</h1>
        <p className="mt-3 max-w-2xl text-sm leading-6 text-[#5d6e64]">已完成归档的 SVN 审查日志。原始内容、问题状态和历史事件均保留查看。</p>
        <ArchiveExplorer initialItems={page.items} initialCursor={page.nextCursor} initialHasMore={page.hasMore} filters={filters} />
      </div>
    </main>
  );
}
