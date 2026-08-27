'use client';
import { useState } from 'react';
import PagedLoadMore from '../components/paged-load-more';
import type { PageResult, ReviewIssueSummary } from '../../lib/reviews';
import { ISSUE_STATUS_LABELS, ISSUE_STATUSES, type IssueStatus } from '../../lib/issue-lifecycle';
type Props = { initialItems: ReviewIssueSummary[]; initialCursor: string | null; initialHasMore: boolean };
export default function IssueExplorer({ initialItems, initialCursor, initialHasMore }: Props) {
  const [items, setItems] = useState(initialItems); const [cursor, setCursor] = useState(initialCursor); const [hasMore, setHasMore] = useState(initialHasMore); const [loading, setLoading] = useState(false); const [params, setParams] = useState(() => new URLSearchParams(typeof window === 'undefined' ? '' : window.location.search)); const [error, setError] = useState('');
  const [copied, setCopied] = useState(false);
  const status = params.get('status') as IssueStatus | null;
  function update(key: string, value: string) { const next = new URLSearchParams(params); if (value) next.set(key, value); else next.delete(key); setParams(next); window.history.replaceState({}, '', `/issues?${next.toString()}`); }
  async function loadMore() { if (!cursor || loading) return; setLoading(true); try { const query = new URLSearchParams('scope=active'); for (const [key, value] of params) query.set(key === 'q' ? 'keyword' : key === 'from' ? 'fromDate' : key === 'to' ? 'toDate' : key, value); if (!params.get('status')) { query.append('status', 'open'); query.append('status', 'pending_review'); } query.set('cursor', cursor); const response = await fetch(`/api/issues?${query}`); if (!response.ok) throw new Error(); const page = await response.json() as PageResult<ReviewIssueSummary>; setItems((old) => [...old, ...page.items]); setCursor(page.nextCursor); setHasMore(page.hasMore); } catch { setError('未能加载更多问题，请稍后重试。'); } finally { setLoading(false); } }
  const share = typeof window === 'undefined' ? '' : `${window.location.origin}/issues?${params.toString()}`;
  const exportParams = new URLSearchParams('scope=active');
  for (const [key, value] of params) exportParams.set(key === 'q' ? 'keyword' : key === 'from' ? 'fromDate' : key === 'to' ? 'toDate' : key, value);
  if (!params.get('status')) { exportParams.append('status', 'open'); exportParams.append('status', 'pending_review'); }
  const exportHref = `/api/issues/export?${exportParams.toString()}`;
  async function copyShareLink() {
    try { await navigator.clipboard?.writeText(share); } catch { /* clipboard permission is optional */ }
    setCopied(true);
    window.setTimeout(() => setCopied(false), 1600);
  }
  return <section><div className="grid gap-3 rounded-2xl border border-[#d9e4da] bg-[#f8fbf8] p-4 md:grid-cols-4"><label>状态<select aria-label="按状态筛选" value={status ?? ''} onChange={(e) => update('status', e.target.value)}><option value="">待处理、待确认</option>{ISSUE_STATUSES.map((s) => <option key={s} value={s}>{ISSUE_STATUS_LABELS[s]}</option>)}</select></label><label>严重级别<select aria-label="按严重级别筛选" value={params.get('severity') ?? ''} onChange={(e) => update('severity', e.target.value)}><option value="">全部级别</option><option>P1</option><option>P2</option><option>P3</option></select></label><label>作者<input aria-label="按作者筛选" value={params.get('author') ?? ''} onChange={(e) => update('author', e.target.value)} /></label><label>关键词<input aria-label="搜索问题" value={params.get('q') ?? ''} onChange={(e) => update('q', e.target.value)} /></label></div><div className="mt-3 flex flex-wrap items-end gap-3"><label className="min-w-[18rem] flex-1">当前筛选链接<input readOnly aria-label="当前筛选链接" value={share} /></label><button type="button" onClick={copyShareLink} className="rounded-lg border border-[#b9cbbb] bg-white px-3 py-2 text-sm font-bold text-[#1d5b46]">{copied ? '已复制' : '复制当前筛选链接'}</button><a href={exportHref} className="rounded-lg bg-[#1d5b46] px-3 py-2 text-sm font-bold text-white">导出当前筛选</a></div><p className="mt-2 text-xs text-[#718077]">导出最多包含 1000 条问题。</p><div>{items.map((issue) => <article id={`issue-${issue.id}`} key={issue.id}><strong>{issue.severity} {issue.title}</strong><p>{issue.logDate} · {issue.authors} · r{issue.relatedRevisions}</p><a href={`/reviews/${issue.reviewId}#issue-${issue.id}`}>{issue.reviewTitle}</a></article>)}</div>{!items.length && <p>没有匹配的问题。</p>}{error && <p role="alert">{error}</p>}<PagedLoadMore hasMore={hasMore} loading={loading} label="加载更多问题" onLoad={loadMore} /></section>;
}
