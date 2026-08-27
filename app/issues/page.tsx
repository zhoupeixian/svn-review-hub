import { getIssuePage } from '@/lib/reviews';
import IssueExplorer from './issue-explorer';
export const dynamic = 'force-dynamic';
type Props = { searchParams: Promise<Record<string, string | string[] | undefined>> };
export default async function IssuesPage({ searchParams }: Props) {
  const raw = await searchParams;
  const value = (key: string) => typeof raw[key] === 'string' ? raw[key] as string : undefined;
  const values = (key: string) => Array.isArray(raw[key]) ? raw[key].filter((item): item is string => typeof item === 'string') : value(key) ? [value(key)!] : [];
  const selectedSeverities = values('severity').filter((item): item is 'P1' | 'P2' | 'P3' => ['P1', 'P2', 'P3'].includes(item));
  const fromDate = value('from');
  const filters = { scope: 'active' as const, status: value('status') as 'open' | 'pending_review' | 'resolved' | 'invalid' | 'by_design' | 'deferred' | undefined, severity: selectedSeverities.length === 1 ? selectedSeverities[0] : undefined, severities: selectedSeverities.length > 1 ? selectedSeverities : undefined, author: value('author'), revision: value('revision') ? Number(value('revision')) : undefined, fromDate, toDate: value('to') ?? fromDate, keyword: value('q') };
  const page = filters.status ? await getIssuePage(filters) : await getIssuePage({ ...filters, statuses: ['open', 'pending_review'] });
  return <main className="min-h-screen bg-[#f6f7f3] text-[#17211d]"><header className="border-b border-[#dce4dc] bg-[#fdfefc]/95"><div className="mx-auto flex max-w-6xl items-center justify-between px-5 py-4 sm:px-8"><a href="/" className="text-sm font-bold text-[#245d46]">← 返回当前日志</a><a href="/issues" className="text-sm font-bold text-[#245d46]">问题看板</a></div></header><div className="mx-auto max-w-6xl px-5 py-9 sm:px-8 sm:py-12"><p className="text-xs font-bold uppercase tracking-[0.16em] text-[#3d7a61]">当前协作</p><h1 className="mt-2 text-3xl font-black text-[#17382a]">问题看板</h1><p className="mt-3 text-sm leading-6 text-[#607167]">默认显示待处理和待确认问题。状态和说明可直接在原日志详情中更新。</p><IssueExplorer initialItems={page.items} initialCursor={page.nextCursor} initialHasMore={page.hasMore} /></div></main>;
}
