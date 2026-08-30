'use client';

import { useRef, useState } from 'react';
import PagedLoadMore from '../components/paged-load-more';
import type { PageResult, ReviewIssueSummary } from '../../lib/reviews';
import { ISSUE_STATUS_LABELS, ISSUE_STATUSES } from '../../lib/issue-lifecycle';

type Props = { initialItems: ReviewIssueSummary[]; initialCursor: string | null; initialHasMore: boolean };

export default function IssueExplorer({ initialItems, initialCursor, initialHasMore }: Props) {
  const initialParams = () => new URLSearchParams(typeof window === 'undefined' ? '' : window.location.search);
  const [items, setItems] = useState(initialItems);
  const [cursor, setCursor] = useState(initialCursor);
  const [hasMore, setHasMore] = useState(initialHasMore);
  const [loading, setLoading] = useState(false);
  const [params, setParams] = useState(initialParams);
  const [draft, setDraft] = useState(initialParams);
  const [advanced, setAdvanced] = useState(() => Boolean(initialParams().get('author') || initialParams().get('from') || initialParams().get('to') || initialParams().get('revision')));
  const [error, setError] = useState('');
  const [copied, setCopied] = useState(false);
  const requestId = useRef(0);

  function queryFor(filters: URLSearchParams, pageCursor?: string) {
    const query = new URLSearchParams('scope=active');
    for (const [key, value] of filters) {
      const target = key === 'q' ? 'keyword' : key === 'from' ? 'fromDate' : key === 'to' ? 'toDate' : key;
      if (target === 'severity' || target === 'status') query.append(target, value); else query.set(target, value);
    }
    if (!filters.get('status')) { query.append('status', 'open'); query.append('status', 'pending_review'); }
    if (pageCursor) query.set('cursor', pageCursor);
    return query;
  }

  function updateDraft(key: string, value: string) {
    setDraft((current) => {
      const next = new URLSearchParams(current);
      if (value) next.set(key, value); else next.delete(key);
      return next;
    });
  }

  function updateSeverity(value: string) {
    setDraft((current) => {
      const next = new URLSearchParams(current);
      next.delete('severity');
      for (const severity of value ? value.split(',') : []) next.append('severity', severity);
      return next;
    });
  }

  async function applyFilters(next = new URLSearchParams(draft)) {
    const request = ++requestId.current;
    setParams(next); setDraft(new URLSearchParams(next));
    window.history.replaceState({}, '', next.size ? `/issues?${next}` : '/issues');
    setItems([]); setCursor(null); setHasMore(false); setError(''); setLoading(true);
    try {
      const response = await fetch(`/api/issues?${queryFor(next)}`);
      if (!response.ok) throw new Error();
      const page = await response.json() as PageResult<ReviewIssueSummary>;
      if (request !== requestId.current) return;
      setItems(page.items); setCursor(page.nextCursor); setHasMore(page.hasMore);
    } catch { if (request === requestId.current) setError('未能加载问题，请稍后重试。'); }
    finally { if (request === requestId.current) setLoading(false); }
  }

  async function loadMore() {
    if (!cursor || loading) return;
    const request = ++requestId.current;
    setLoading(true);
    try {
      const response = await fetch(`/api/issues?${queryFor(params, cursor)}`);
      if (!response.ok) throw new Error();
      const page = await response.json() as PageResult<ReviewIssueSummary>;
      if (request !== requestId.current) return;
      setItems((old) => [...old, ...page.items]); setCursor(page.nextCursor); setHasMore(page.hasMore);
    } catch { if (request === requestId.current) setError('未能加载更多问题，请稍后重试。'); }
    finally { if (request === requestId.current) setLoading(false); }
  }

  const share = typeof window === 'undefined' ? '' : `${window.location.origin}/issues${params.size ? `?${params}` : ''}`;
  const exportParams = new URLSearchParams('scope=active');
  for (const [key, value] of params) {
    const target = key === 'q' ? 'keyword' : key === 'from' ? 'fromDate' : key === 'to' ? 'toDate' : key;
    if (target === 'severity' || target === 'status') exportParams.append(target, value); else exportParams.set(target, value);
  }
  if (!params.get('status')) { exportParams.append('status', 'open'); exportParams.append('status', 'pending_review'); }

  async function copyShareLink() {
    try { await navigator.clipboard?.writeText(share); } catch { /* clipboard permission is optional */ }
    setCopied(true); window.setTimeout(() => setCopied(false), 1600);
  }

  return <section className="mt-6">
    <div className="filter-panel">
      <div className="flex flex-wrap items-start justify-between gap-3"><div><p className="text-sm font-black text-[#243e31]">筛选问题</p><p className="mt-1 text-xs text-[#718077]">先选常用条件，再按需展开日期、作者和 Revision。</p></div><button type="button" className="filter-quiet" onClick={() => setAdvanced((value) => !value)}>{advanced ? '收起条件' : '更多条件'}</button></div>
      <div className="mt-4 grid gap-3 md:grid-cols-3"><label>状态<select aria-label="按状态筛选" data-status={draft.get('status') || 'active'} value={draft.get('status') ?? ''} onChange={(event) => updateDraft('status', event.target.value)}><option value="">待处理、待确认</option>{ISSUE_STATUSES.map((value) => <option key={value} value={value}>{ISSUE_STATUS_LABELS[value]}</option>)}</select></label><label>严重级别<select aria-label="按严重级别筛选" data-severity={draft.getAll('severity').sort().join(',') || 'all'} value={draft.getAll('severity').sort().join(',')} onChange={(event) => updateSeverity(event.target.value)}><option value="">全部级别</option><option value="P1,P2">P1 + P2</option><option value="P1">P1</option><option value="P2">P2</option><option value="P3">P3</option></select></label><label>关键词<input aria-label="搜索问题" placeholder="标题、详情或处理说明" value={draft.get('q') ?? ''} onChange={(event) => updateDraft('q', event.target.value)} /></label></div>
      {advanced && <div className="mt-3 grid gap-3 md:grid-cols-4"><label>作者<input aria-label="按作者筛选" value={draft.get('author') ?? ''} onChange={(event) => updateDraft('author', event.target.value)} /></label><label>开始日期<input type="date" aria-label="开始日期" value={draft.get('from') ?? ''} onChange={(event) => updateDraft('from', event.target.value)} /></label><label>结束日期<input type="date" aria-label="结束日期" value={draft.get('to') ?? ''} onChange={(event) => updateDraft('to', event.target.value)} /></label><label>Revision<input inputMode="numeric" aria-label="按 Revision 筛选" value={draft.get('revision') ?? ''} onChange={(event) => updateDraft('revision', event.target.value)} /></label></div>}
      <div className="mt-4 flex flex-wrap items-center gap-2"><button type="button" className="filter-apply" onClick={() => applyFilters()}>应用筛选</button><button type="button" className="filter-quiet" onClick={() => applyFilters(new URLSearchParams())}>重置</button><span className="text-xs text-[#718077]">当前已显示 {items.length} 条，导出最多包含 1,000 条问题。</span></div>
    </div>
    <div className="share-actions mt-3"><div><p className="text-sm font-bold text-[#243e31]">分享当前筛选</p><p className="mt-1 text-xs text-[#718077]">复制链接后可发送给团队成员，导出将沿用同一筛选范围。</p></div><div className="flex flex-wrap gap-2"><button type="button" onClick={copyShareLink} className="filter-quiet">{copied ? '已复制' : '复制当前筛选链接'}</button><a href={`/api/issues/export?${exportParams}`} className="filter-apply">导出 Excel 跟进表</a></div></div>
    <div className="mt-5 grid gap-3">{items.map((issue) => <article id={`issue-${issue.id}`} key={issue.id} className="issue-card"><div className="flex flex-wrap items-start justify-between gap-3"><div className="min-w-0"><div className="flex flex-wrap gap-2"><span className="meta-chip" data-severity={issue.severity}>{issue.severity}</span><span className="meta-chip" data-status={issue.status}>{ISSUE_STATUS_LABELS[issue.status]}</span></div><strong className="mt-3 block text-base text-[#223c30]">{issue.title}</strong>{issue.statusNote && <p className="mt-2 line-clamp-2 text-sm text-[#52655a]">处理说明：{issue.statusNote}</p>}</div><span className="meta-chip">r{issue.relatedRevisions.split('、').join(' · r')}</span></div><div className="mt-4 flex flex-wrap items-center justify-between gap-3 border-t border-[#edf1ed] pt-3 text-xs text-[#718077]"><span>{issue.logDate} · {issue.reviewTitle} · {issue.authors || '提交人待补充'}</span><a className="font-bold text-[#1d5b46]" href={`/reviews/${issue.reviewId}#issue-${issue.id}`}>打开原日志 →</a></div></article>)}</div>
    {!items.length && !loading && <p className="mt-5 text-sm text-[#718077]">没有匹配的问题。</p>}{error && <p role="alert" className="mt-4 text-sm font-semibold text-[#a44138]">{error}</p>}<PagedLoadMore hasMore={hasMore} loading={loading} label="加载更多问题" onLoad={loadMore} />
  </section>;
}
