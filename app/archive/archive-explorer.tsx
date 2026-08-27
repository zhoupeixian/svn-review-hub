'use client';

import { useState } from 'react';
import { ISSUE_STATUS_LABELS, ISSUE_STATUSES } from '../../lib/issue-lifecycle';
import PagedLoadMore from '../components/paged-load-more';
import type { PageResult, ReviewSummary } from '../../lib/reviews';

export type ArchiveFilters = {
  fromDate?: string;
  toDate?: string;
  author?: string;
  revision?: string;
  severity?: string;
  status?: string;
  keyword?: string;
};

type Props = {
  initialItems: ReviewSummary[];
  initialCursor: string | null;
  initialHasMore: boolean;
  filters?: ArchiveFilters;
};

export default function ArchiveExplorer({
  initialItems,
  initialCursor,
  initialHasMore,
  filters = {},
}: Props) {
  const [items, setItems] = useState(initialItems);
  const [cursor, setCursor] = useState(initialCursor);
  const [hasMore, setHasMore] = useState(initialHasMore);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [copied, setCopied] = useState(false);
  const [activeFilters, setActiveFilters] = useState<ArchiveFilters>(() => ({ ...filters }));
  const [draftFilters, setDraftFilters] = useState<ArchiveFilters>(() => ({ ...filters }));

  function updateDraft(key: keyof ArchiveFilters, value: string) {
    setDraftFilters((current) => ({ ...current, [key]: value }));
  }

  async function applyFilters() {
    const next = Object.fromEntries(Object.entries(draftFilters).filter(([, value]) => value)) as ArchiveFilters;
    setActiveFilters(next);
    const urlParams = new URLSearchParams({ scope: 'archived' });
    appendFilters(urlParams, next);
    window.history.replaceState({}, '', `/archive?${urlParams.toString()}`);
    setItems([]); setCursor(null); setHasMore(false); setLoading(true); setError('');
    try {
      const response = await fetch('/api/reviews?' + urlParams.toString());
      if (!response.ok) throw new Error();
      const page = await response.json() as PageResult<ReviewSummary>;
      setItems(page.items); setCursor(page.nextCursor); setHasMore(page.hasMore);
    } catch { setError('未能加载归档日志，请稍后重试。'); }
    finally { setLoading(false); }
  }

  async function loadMore() {
    if (!cursor || loading) return;
    setLoading(true);
    setError('');
    try {
      const params = new URLSearchParams({ scope: 'archived' });
      appendFilters(params, activeFilters);
      params.set('cursor', cursor);
      const response = await fetch('/api/reviews?' + params.toString());
      if (!response.ok) throw new Error('加载失败');
      const page = await response.json() as PageResult<ReviewSummary>;
      setItems((current) => [...current, ...page.items]);
      setCursor(page.nextCursor);
      setHasMore(page.hasMore);
    } catch {
      setError('未能加载更多归档日志，请稍后重试。');
    } finally {
      setLoading(false);
    }
  }

  const shareParams = new URLSearchParams({ scope: 'archived' });
  appendFilters(shareParams, activeFilters);
  const share = typeof window === 'undefined' ? `/archive?${shareParams.toString()}` : `${window.location.origin}/archive?${shareParams.toString()}`;
  const exportHref = `/api/reviews/export?${shareParams.toString()}`;
  async function copyShareLink() {
    try { await navigator.clipboard?.writeText(share); } catch { /* clipboard permission is optional */ }
    setCopied(true);
    window.setTimeout(() => setCopied(false), 1600);
  }

  return (
    <section className="mt-8">
      <div className="mb-5 grid gap-3 rounded-2xl border border-[#d9e4da] bg-[#f8fbf8] p-4 md:grid-cols-4"><label>开始日期<input type="date" aria-label="开始日期" value={draftFilters.fromDate ?? ''} onChange={(e) => updateDraft('fromDate', e.target.value)} /></label><label>结束日期<input type="date" aria-label="结束日期" value={draftFilters.toDate ?? ''} onChange={(e) => updateDraft('toDate', e.target.value)} /></label><label>严重级别<select aria-label="按严重级别筛选" value={draftFilters.severity ?? ''} onChange={(e) => updateDraft('severity', e.target.value)}><option value="">全部级别</option><option value="P1">P1</option><option value="P2">P2</option><option value="P3">P3</option></select></label><label>问题状态<select aria-label="按问题状态筛选" value={draftFilters.status ?? ''} onChange={(e) => updateDraft('status', e.target.value)}><option value="">全部状态</option>{ISSUE_STATUSES.map((status) => <option key={status} value={status}>{ISSUE_STATUS_LABELS[status]}</option>)}</select></label><label>Revision<input aria-label="按 Revision 筛选" value={draftFilters.revision ?? ''} onChange={(e) => updateDraft('revision', e.target.value)} /></label><label>提交人<input aria-label="按提交人筛选" value={draftFilters.author ?? ''} onChange={(e) => updateDraft('author', e.target.value)} /></label><label>关键词<input aria-label="搜索归档日志" value={draftFilters.keyword ?? ''} onChange={(e) => updateDraft('keyword', e.target.value)} /></label><button type="button" onClick={applyFilters}>应用筛选</button></div><div className="mb-5 flex flex-wrap items-end gap-3"><label className="min-w-[18rem] flex-1">当前筛选链接<input readOnly aria-label="当前筛选链接" value={share} /></label><button type="button" onClick={copyShareLink} className="rounded-lg border border-[#b9cbbb] bg-white px-3 py-2 text-sm font-bold text-[#1d5b46]">{copied ? '已复制' : '复制当前筛选链接'}</button><a href={exportHref} className="rounded-lg bg-[#1d5b46] px-3 py-2 text-sm font-bold text-white">导出当前筛选</a></div>
      <p className="mb-4 text-xs text-[#718077]">导出最多包含 1000 条归档日志。</p>
      <div className="grid gap-4">
        {items.map((review) => (
          <article key={review.id} aria-label={review.title} className="rounded-2xl border border-[#dfe7df] bg-white p-5 sm:p-6">
            <div className="flex flex-col justify-between gap-5 lg:flex-row lg:items-start">
              <div>
                <div className="flex flex-wrap items-center gap-2">
                  <time className="text-sm font-bold text-[#245d46]">{review.logDate}</time>
                  {review.archivedAt && <span className="rounded-lg bg-[#eef3ee] px-2 py-1 text-xs font-bold text-[#607167]">已归档</span>}
                </div>
                <h2 className="mt-2 font-bold text-[#223c30]">{review.title}</h2>
                <p className="mt-2 text-sm leading-6 text-[#4f6257]">{review.overview || '日志已归档，点击查看原文。'}</p>
                <p className="mt-3 text-xs text-[#728178]">{review.reviewedCount} 个实际审查提交 · 来源：{review.sourceName}</p>
              </div>
              <div className="flex gap-2">
                <Risk level="P1" count={review.p1Count} />
                <Risk level="P2" count={review.p2Count} />
                <Risk level="P3" count={review.p3Count} />
              </div>
            </div>
            <div className="mt-5 border-t border-[#edf1ed] pt-4">
              <a href={`/reviews/${review.id}`} className="text-sm font-bold text-[#1e6b4e]">查看归档原文与历史 →</a>
            </div>
          </article>
        ))}
        {!items.length && <div className="rounded-2xl border border-dashed border-[#bfd0c0] px-6 py-14 text-center"><p className="font-bold text-[#365346]">没有匹配的归档日志</p></div>}
      </div>
      {error && <p role="alert" className="mt-4 text-center text-sm font-semibold text-[#a44138]">{error}</p>}
      <PagedLoadMore hasMore={hasMore} loading={loading} label="加载更多归档日志" onLoad={loadMore} />
    </section>
  );
}

export function appendFilters(params: URLSearchParams, filters: ArchiveFilters) {
  const entries: Array<[keyof ArchiveFilters, string]> = [
    ['fromDate', filters.fromDate ?? ''], ['toDate', filters.toDate ?? ''], ['author', filters.author ?? ''],
    ['revision', filters.revision ?? ''], ['severity', filters.severity ?? ''], ['status', filters.status ?? ''],
    ['keyword', filters.keyword ?? ''],
  ];
  for (const [key, value] of entries) if (value) params.set(key, value);
}

function Risk({ level, count }: { level: string; count: number }) {
  return <span className="rounded-lg border border-[#d5dfd6] bg-[#f7faf7] px-2.5 py-1.5 text-xs font-bold text-[#526c5c]">{level} {count}</span>;
}
