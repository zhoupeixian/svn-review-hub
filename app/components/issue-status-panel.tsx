'use client';

import { useState } from 'react';
import { ISSUE_STATUS_LABELS, ISSUE_STATUSES, type IssueStatus } from '../../lib/issue-lifecycle';

export type EditableIssue = {
  id: number;
  status: IssueStatus;
  statusNote: string | null;
  statusUpdatedAt: string | null;
  version: number;
  events?: Array<{ id: number; fromStatus: IssueStatus | null; toStatus: IssueStatus; note: string; createdAt: string }>;
};

export default function IssueStatusPanel({ issue, readOnly = false }: { issue: EditableIssue; readOnly?: boolean }) {
  const [current, setCurrent] = useState(issue);
  const [status, setStatus] = useState<IssueStatus>(issue.status);
  const [note, setNote] = useState(issue.statusNote ?? '');
  const [events, setEvents] = useState(issue.events ?? []);
  const [message, setMessage] = useState('');
  const [conflict, setConflict] = useState(false);
  const [saving, setSaving] = useState(false);

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    setSaving(true); setMessage(''); setConflict(false);
    try {
      const response = await fetch(`/api/issues/${issue.id}/status`, {
        method: 'PATCH', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ status, note, version: current.version }),
      });
      const body = await response.json() as { error?: string; currentVersion?: number; status?: IssueStatus; statusNote?: string; statusUpdatedAt?: string; version?: number };
      if (!response.ok) {
        setConflict(response.status === 409);
        setMessage(body.error ?? '保存失败，请稍后重试。');
        return;
      }
      const next = { ...current, status: body.status!, statusNote: body.statusNote ?? '', statusUpdatedAt: body.statusUpdatedAt!, version: body.version! };
      setCurrent(next);
      setEvents((items) => [{ id: Date.now(), fromStatus: current.status, toStatus: next.status, note: next.statusNote ?? '', createdAt: next.statusUpdatedAt! }, ...items]);
      setMessage('状态已更新。');
    } catch {
      setMessage('网络异常，未能保存状态。');
    } finally { setSaving(false); }
  }

  return (
    <section className="status-panel mt-5" aria-label="问题协作状态">
      <div className="flex flex-wrap items-center gap-3 text-sm">
        <strong className="meta-chip" data-status={current.status}>当前状态：{ISSUE_STATUS_LABELS[current.status]}</strong>
        {current.statusUpdatedAt && <time className="text-[#718077]">更新于 {formatTime(current.statusUpdatedAt)}</time>}
      </div>
      {current.statusNote && <p className="mt-2 text-sm text-[#586b60]">处理说明：{current.statusNote}</p>}
      {!readOnly && <form onSubmit={submit} className="mt-4 grid gap-3 sm:grid-cols-[180px_1fr_auto] sm:items-end">
        <label className="grid gap-1.5 text-sm font-semibold text-[#40594c]">状态
          <select value={status} data-status={status} onChange={(event) => setStatus(event.target.value as IssueStatus)} className="rounded-lg border border-[#c8d7ca] bg-white px-3 py-2.5 font-normal focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#1d5b46]">
            {ISSUE_STATUSES.map((value) => <option key={value} value={value}>{ISSUE_STATUS_LABELS[value]}</option>)}
          </select>
        </label>
        <label className="grid gap-1.5 text-sm font-semibold text-[#40594c]">处理说明
          <input value={note} maxLength={1000} placeholder="例如：已修复，待验证" onChange={(event) => setNote(event.target.value)} className="rounded-lg border border-[#c8d7ca] bg-white px-3 py-2.5 font-normal focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#1d5b46]" />
        </label>
        <button disabled={saving} className="rounded-lg bg-[#1d5b46] px-4 py-2.5 text-sm font-bold text-white hover:bg-[#174936] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#1d5b46] disabled:opacity-60">{saving ? '保存中…' : '保存状态'}</button>
      </form>}
      {message && <p role={conflict ? 'alert' : 'status'} className={`mt-3 text-sm ${conflict ? 'font-semibold text-[#a44138]' : 'text-[#35644d]'}`}>{message}{conflict && ' 已保留当前填写内容，请重新加载页面后再提交。'}</p>}
      {events.length > 0 && <div className="mt-5"><h4 className="text-sm font-bold text-[#40594c]">处理时间线</h4><ol className="mt-2 grid gap-2">{events.map((item) => <li key={item.id} className="rounded-lg bg-[#f5f8f5] px-3 py-2 text-xs leading-5 text-[#607167]"><time>{formatTime(item.createdAt)}</time> · {item.fromStatus ? ISSUE_STATUS_LABELS[item.fromStatus] : '初始'} → {ISSUE_STATUS_LABELS[item.toStatus]}{item.note && ` · ${item.note}`}</li>)}</ol></div>}
    </section>
  );
}

function formatTime(value: string) {
  return new Intl.DateTimeFormat('zh-CN', { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(value));
}
