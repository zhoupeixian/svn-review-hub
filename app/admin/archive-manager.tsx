'use client';

import { useState } from 'react';
import type { PageResult, ReviewSummary } from '../../lib/reviews';
import { ISSUE_STATUS_LABELS, ISSUE_STATUSES } from '../../lib/issue-lifecycle';
import { appendFilters, type ArchiveFilters } from '../archive/archive-explorer';

type Props = {
  initialActive: PageResult<ReviewSummary>;
  initialArchived: PageResult<ReviewSummary>;
  reviewsApiPath: string;
  archiveApiPath: string;
  restoreApiPath: string;
};
type Counts = { reviewCount: number; revisionCount: number; issueCount: number; openIssueCount: number };

export default function ArchiveManager({
  initialActive,
  initialArchived,
  reviewsApiPath,
  archiveApiPath,
  restoreApiPath,
}: Props) {
  const [active, setActive] = useState(initialActive.items);
  const [archived, setArchived] = useState(initialArchived.items);
  const [selected, setSelected] = useState<number[]>([]);
  const [filters, setFilters] = useState<ArchiveFilters>({});
  const [appliedFilters, setAppliedFilters] = useState<ArchiveFilters>({});
  const [previewToken, setPreviewToken] = useState('');
  const [counts, setCounts] = useState<Counts | null>(null);
  const [message, setMessage] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  function toggle(id: number) {
    setSelected((current) => current.includes(id) ? current.filter((item) => item !== id) : [...current, id]);
  }

  async function applyFilters() {
    setBusy(true); setError(''); setAppliedFilters(filters); setSelected([]);
    try {
      const page = await fetchPage('active', filters);
      setActive(page.items ?? active);
      setMessage('筛选已应用。');
    } catch { setError('筛选失败，请稍后重试。'); }
    finally { setBusy(false); }
  }

  async function fetchPage(scope: 'active' | 'archived', values: ArchiveFilters) {
    const params = new URLSearchParams({ scope }); appendFilters(params, values);
    const response = await fetch(`${reviewsApiPath}?${params.toString()}`);
    if (!response.ok) throw new Error();
    return await response.json() as PageResult<ReviewSummary>;
  }

  async function preview(mode: 'ids' | 'filters') {
    setBusy(true); setError(''); setMessage('');
    const body = mode === 'ids' ? { mode: 'preview', ids: selected } : { mode: 'preview', filters: appliedFilters };
    try {
      const response = await fetch(archiveApiPath, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
      const result = await response.json() as Counts & { previewToken?: string; error?: string };
      if (!response.ok) throw new Error(result.error ?? '预览失败。');
      setCounts(result); setPreviewToken(result.previewToken ?? '');
    } catch (cause) { setError(cause instanceof Error ? cause.message : '预览失败，请稍后重试。'); }
    finally { setBusy(false); }
  }

  async function confirmArchive() {
    if (!previewToken) return;
    setBusy(true); setError('');
    try {
      const response = await fetch(archiveApiPath, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ mode: 'confirm', previewToken }) });
      const result = await response.json() as { archivedCount?: number; error?: string };
      if (!response.ok) throw new Error(result.error ?? '归档失败。');
      await refreshLists();
      setSelected([]); setCounts(null); setPreviewToken('');
      setMessage(`已归档 ${result.archivedCount ?? 0} 份日志。`);
    } catch (cause) { setError(cause instanceof Error ? cause.message : '归档失败，请稍后重试。'); }
    finally { setBusy(false); }
  }

  async function restore(id: number) {
    setBusy(true); setError('');
    try {
      const response = await fetch(restoreApiPath, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ ids: [id] }) });
      const result = await response.json() as { restoredCount?: number; error?: string };
      if (!response.ok) throw new Error(result.error ?? '恢复失败。');
      await refreshLists();
      setMessage(`已恢复 ${result.restoredCount ?? 0} 份日志。`);
    } catch (cause) { setError(cause instanceof Error ? cause.message : '恢复失败，请稍后重试。'); }
    finally { setBusy(false); }
  }

  async function refreshLists() {
    const [nextActive, nextArchived] = await Promise.all([fetchPage('active', {}), fetchPage('archived', {})]);
    setActive(nextActive.items); setArchived(nextArchived.items);
  }

  return <section className="mt-8 grid gap-8">
    <section className="rounded-3xl border border-[#d8e4d9] bg-white p-6 shadow-[0_12px_34px_rgba(31,77,51,0.05)] sm:p-8">
      <p className="text-xs font-bold uppercase tracking-[0.14em] text-[#4c8068]">归档管理</p>
      <h2 className="mt-1 text-xl font-black tracking-tight text-[#243e31]">选择当前日志归档</h2>
      <div className="archive-filter-panel mt-5 grid gap-3 md:grid-cols-4">
        <label>日期起<input aria-label="开始日期" type="date" value={filters.fromDate ?? ''} onChange={(e) => setFilters({ ...filters, fromDate: e.target.value })} /></label>
        <label>日期止<input aria-label="结束日期" type="date" value={filters.toDate ?? ''} onChange={(e) => setFilters({ ...filters, toDate: e.target.value })} /></label>
        <label>作者<input aria-label="按作者筛选活动日志" value={filters.author ?? ''} onChange={(e) => setFilters({ ...filters, author: e.target.value })} /></label>
        <label>Revision<input aria-label="按 Revision 筛选活动日志" value={filters.revision ?? ''} onChange={(e) => setFilters({ ...filters, revision: e.target.value })} /></label>
        <label>问题状态<select aria-label="按问题状态筛选活动日志" data-status={filters.status || 'all'} value={filters.status ?? ''} onChange={(e) => setFilters({ ...filters, status: e.target.value })}><option value="">全部状态</option>{ISSUE_STATUSES.map((status) => <option key={status} value={status}>{ISSUE_STATUS_LABELS[status]}</option>)}</select></label>
        <label>关键词<input aria-label="按关键词筛选活动日志" value={filters.keyword ?? ''} onChange={(e) => setFilters({ ...filters, keyword: e.target.value })} /></label>
        <label>级别<select aria-label="按问题级别筛选活动日志" data-severity={filters.severity || 'all'} value={filters.severity ?? ''} onChange={(e) => setFilters({ ...filters, severity: e.target.value })}><option value="">全部级别</option><option value="P1">P1</option><option value="P2">P2</option><option value="P3">P3</option></select></label>
        <button type="button" onClick={applyFilters} disabled={busy} className="filter-apply self-end">应用筛选</button>
      </div>
      <div className="mt-6 flex flex-wrap gap-3"><button type="button" onClick={() => setSelected(active.map((review) => review.id))} className="rounded-lg border border-[#b9cbbb] px-3 py-2 text-sm font-semibold text-[#1d5b46]">全选当前页</button><button type="button" onClick={() => setSelected([])} className="rounded-lg border border-[#d3ded4] px-3 py-2 text-sm font-semibold text-[#5f7165]">清空选择</button><button type="button" disabled={busy || selected.length === 0} onClick={() => preview('ids')} className="rounded-lg bg-[#1d5b46] px-3 py-2 text-sm font-bold text-white disabled:opacity-50">预览所选日志</button><button type="button" disabled={busy} onClick={() => preview('filters')} className="rounded-lg border border-[#1d5b46] px-3 py-2 text-sm font-bold text-[#1d5b46] disabled:opacity-50">预览当前筛选全部日志</button></div>
      <div className="mt-5 grid gap-3">{active.map((review) => <label key={review.id} className="flex items-start gap-3 rounded-xl border border-[#e0e8e0] p-4"><input type="checkbox" aria-label={review.title} checked={selected.includes(review.id)} onChange={() => toggle(review.id)} /><span><strong className="text-[#29483a]">{review.title}</strong><span className="mt-1 block text-xs text-[#718077]">{review.logDate} · {review.reviewedCount} 个审查提交</span></span></label>)}{!active.length && <p className="text-sm text-[#718077]">当前筛选没有活动日志。</p>}</div>
      {counts && <div role="status" className="mt-5 rounded-xl bg-[#edf6ee] px-4 py-3 text-sm text-[#35644d]">将归档 {counts.reviewCount} 份日志，包含 {counts.revisionCount} 个 Revision、{counts.issueCount} 个问题（其中 {counts.openIssueCount} 个待处理）。<button type="button" onClick={confirmArchive} disabled={busy} className="ml-3 rounded-lg bg-[#1d5b46] px-3 py-2 font-bold text-white disabled:opacity-50">确认归档</button></div>}
    </section>
    <section className="rounded-3xl border border-[#d8e4d9] bg-white p-6 sm:p-8"><div className="flex items-baseline justify-between gap-4"><div><p className="text-xs font-bold uppercase tracking-[0.14em] text-[#4c8068]">恢复</p><h2 className="mt-1 text-xl font-black tracking-tight text-[#243e31]">已归档日志</h2></div><span className="text-sm text-[#718077]">{archived.length} 份</span></div><div className="mt-5 grid gap-3">{archived.map((review) => <article key={review.id} aria-label={review.title} className="flex flex-col justify-between gap-3 rounded-xl border border-[#e0e8e0] p-4 sm:flex-row sm:items-center"><div><strong className="text-[#29483a]">{review.title}</strong><p className="mt-1 text-xs text-[#718077]">{review.logDate} · 归档于 {review.archivedAt ? new Date(review.archivedAt).toLocaleString('zh-CN') : '未知时间'}</p></div><button type="button" onClick={() => restore(review.id)} disabled={busy} className="rounded-lg border border-[#b9cbbb] px-3 py-2 text-sm font-bold text-[#1d5b46] disabled:opacity-50">恢复</button></article>)}{!archived.length && <p className="text-sm text-[#718077]">暂无归档日志。</p>}</div></section>
    {message && <p role="status" className="text-sm text-[#35644d]">{message}</p>}{error && <p role="alert" className="text-sm font-semibold text-[#a44138]">{error}</p>}
  </section>;
}
