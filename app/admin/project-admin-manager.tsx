'use client';

import { useState, type FormEvent } from 'react';
import type {
  AdminProject,
  ProjectAdminAction,
  ProjectAdminAudit,
} from '@/lib/project-administration';

type Props = {
  initialProjects: AdminProject[];
  initialAudits: ProjectAdminAudit[];
  initialAuditCursor?: string | null;
  initialAuditHasMore?: boolean;
};

type ProjectDraft = { name: string; description: string };

const ACTION_LABELS: Record<ProjectAdminAction, string> = {
  'project.create': '创建项目',
  'project.update': '编辑项目',
  'project.reorder': '调整排序',
  'project.disable': '停用项目',
  'project.restore': '恢复项目',
  'project.sync-key.copy': '复制同步密钥',
  'project.sync-key.rotate': '轮换同步密钥',
};

const UTF8_ENCODER = new TextEncoder();

export default function ProjectAdminManager({
  initialProjects,
  initialAudits,
  initialAuditCursor = null,
  initialAuditHasMore = false,
}: Props) {
  const [projects, setProjects] = useState(initialProjects);
  const [audits, setAudits] = useState(initialAudits);
  const [auditCursor, setAuditCursor] = useState(initialAuditCursor);
  const [auditHasMore, setAuditHasMore] = useState(initialAuditHasMore);
  const [auditQuery, setAuditQuery] = useState('');
  const [drafts, setDrafts] = useState<Record<number, ProjectDraft>>(() =>
    Object.fromEntries(initialProjects.map((project) => [
      project.id,
      { name: project.name, description: project.description },
    ])),
  );
  const [message, setMessage] = useState('');
  const [busy, setBusy] = useState(false);

  async function createProject(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = event.currentTarget;
    const data = new FormData(form);
    await run(async () => {
      const project = await request<{ project: AdminProject }>('/api/admin/projects', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          name: data.get('name'),
          slug: data.get('slug'),
          description: data.get('description'),
          displayOrder: Number(data.get('displayOrder')),
        }),
      });
      setProjects((current) => sortProjects([...current, project.project]));
      setDrafts((current) => ({
        ...current,
        [project.project.id]: {
          name: project.project.name,
          description: project.project.description,
        },
      }));
      form.reset();
      setMessage(`已创建项目 ${project.project.name}。`);
    });
  }

  async function saveProject(project: AdminProject) {
    const draft = drafts[project.id] ?? { name: project.name, description: project.description };
    await run(async () => {
      const result = await request<{ project: AdminProject }>(`/api/admin/projects/${project.id}`, {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(draft),
      });
      setProjects((current) => sortProjects(current.map((item) =>
        item.id === result.project.id ? result.project : item,
      )));
      setDrafts((current) => ({
        ...current,
        [result.project.id]: {
          name: result.project.name,
          description: result.project.description,
        },
      }));
      setMessage(`已保存 ${result.project.name} 的项目资料。`);
    });
  }

  async function moveProject(index: number, offset: -1 | 1) {
    const nextIndex = index + offset;
    if (nextIndex < 0 || nextIndex >= projects.length) return;
    const next = [...projects];
    [next[index], next[nextIndex]] = [next[nextIndex], next[index]];
    await run(async () => {
      const result = await request<{ projects: AdminProject[] }>('/api/admin/projects/order', {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ projectIds: next.map((project) => project.id) }),
      });
      setProjects(result.projects);
      setMessage('项目显示顺序已更新。');
    });
  }

  async function setProjectEnabled(project: AdminProject, enabled: boolean) {
    if (!enabled && !window.confirm(`确认停用项目“${project.name}”？停用期间普通协作者将无法访问或写入。`)) {
      return;
    }
    await run(async () => {
      const result = await request<{ project: AdminProject }>(
        `/api/admin/projects/${project.id}/status`,
        {
          method: 'PATCH',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ enabled }),
        },
      );
      setProjects((current) => current.map((item) =>
        item.id === result.project.id ? result.project : item,
      ));
      setMessage(enabled
        ? `已恢复项目 ${result.project.name}。`
        : `已停用项目 ${result.project.name}。`);
    });
  }

  async function copyProjectSyncKey(project: AdminProject) {
    await run(async () => {
      const result = await request<{ syncKey: string }>(
        `/api/admin/projects/${project.id}/sync-key/copy`,
        { method: 'POST' },
      );
      await navigator.clipboard.writeText(result.syncKey);
      setMessage(`已复制 ${project.name} 的同步密钥。`);
    });
  }

  async function rotateProjectSyncKey(project: AdminProject) {
    if (!window.confirm(`确认轮换项目“${project.name}”的同步密钥？旧密钥将立即失效。`)) {
      return;
    }
    await run(async () => {
      const result = await request<{ project: AdminProject }>(
        `/api/admin/projects/${project.id}/sync-key/rotate`,
        { method: 'POST' },
      );
      setProjects((current) => current.map((item) =>
        item.id === result.project.id ? result.project : item,
      ));
      setMessage(`已轮换 ${result.project.name} 的同步密钥，请复制新密钥更新自动化配置。`);
    });
  }

  async function filterAudits(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const data = new FormData(event.currentTarget);
    const params = new URLSearchParams();
    for (const key of ['projectSlug', 'adminUserId', 'action']) {
      const value = String(data.get(key) ?? '').trim();
      if (value) params.set(key, value);
    }
    await run(async () => {
      const result = await request<{
        audits: ProjectAdminAudit[];
        nextCursor?: string | null;
        hasMore?: boolean;
      }>(
        `/api/admin/project-audits?${params}`,
      );
      setAudits(result.audits);
      setAuditCursor(result.nextCursor ?? null);
      setAuditHasMore(Boolean(result.hasMore));
      setAuditQuery(params.toString());
      setMessage(`已加载 ${result.audits.length} 条审计记录。`);
    });
  }

  async function loadMoreAudits() {
    if (!auditCursor) return;
    const params = new URLSearchParams(auditQuery);
    params.set('cursor', auditCursor);
    await run(async () => {
      const result = await request<{
        audits: ProjectAdminAudit[];
        nextCursor: string | null;
        hasMore: boolean;
      }>(`/api/admin/project-audits?${params}`);
      setAudits((current) => [...current, ...result.audits]);
      setAuditCursor(result.nextCursor);
      setAuditHasMore(result.hasMore);
      setMessage(`已追加 ${result.audits.length} 条更早的审计记录。`);
    });
  }

  async function run(action: () => Promise<void>) {
    setBusy(true);
    setMessage('');
    try {
      await action();
    } catch (error) {
      setMessage(error instanceof Error ? error.message : '操作失败。');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="space-y-8">
      <section className="rounded-3xl border border-[#d8e4d9] bg-white p-6 shadow-[0_12px_34px_rgba(31,77,51,0.05)] sm:p-8">
        <p className="text-xs font-bold uppercase tracking-[0.14em] text-[#4c8068]">全局项目资料</p>
        <h1 className="mt-2 text-3xl font-black tracking-tight text-[#1b382b]">维护审查项目</h1>
        <p className="mt-3 text-sm leading-6 text-[#617268]">
          此处只维护项目资料和目录顺序；日志上传、归档和恢复仍在各项目自己的日志管理页完成。
        </p>

        <form className="mt-6 grid gap-4 rounded-2xl bg-[#f4f7f3] p-5 sm:grid-cols-2" onSubmit={createProject}>
          <Field label="新项目名称" name="name" required />
          <Field label="新项目标识" name="slug" required pattern="[a-z0-9]+(?:-[a-z0-9]+)*" />
          <Field label="新项目简介" name="description" />
          <Field label="新项目显示顺序" name="displayOrder" type="number" min="0" defaultValue="0" required />
          <button disabled={busy} className="rounded-xl bg-[#1e6349] px-5 py-3 text-sm font-bold text-white disabled:opacity-50 sm:col-span-2">
            创建项目
          </button>
        </form>
      </section>

      <section aria-labelledby="project-list-title" className="space-y-4">
        <div>
          <p className="text-xs font-bold uppercase tracking-[0.14em] text-[#4c8068]">公共目录顺序</p>
          <h2 id="project-list-title" className="mt-1 text-2xl font-black text-[#1b382b]">现有项目</h2>
        </div>
        {projects.map((project, index) => {
          const draft = drafts[project.id] ?? { name: project.name, description: project.description };
          return (
            <article key={project.id} className="rounded-3xl border border-[#d8e4d9] bg-white p-6 shadow-[0_10px_28px_rgba(31,77,51,0.04)]">
              <div className="flex flex-wrap items-start justify-between gap-4">
                <div>
                  <p className="text-xs font-bold text-[#748278]">目录位置 {index + 1}</p>
                  <p className="mt-1 text-lg font-black text-[#28503c]">{project.name}</p>
                  <p className="mt-1 text-xs font-bold text-[#718077]">{project.enabled ? '启用中' : '已停用'}</p>
                </div>
                <div className="flex flex-wrap gap-2">
                  <button type="button" disabled={busy || index === 0} onClick={() => moveProject(index, -1)} className="rounded-lg border border-[#cddace] px-3 py-2 text-xs font-bold disabled:opacity-40">
                    上移 {project.name}
                  </button>
                  <button type="button" disabled={busy || index === projects.length - 1} onClick={() => moveProject(index, 1)} className="rounded-lg border border-[#cddace] px-3 py-2 text-xs font-bold disabled:opacity-40">
                    下移 {project.name}
                  </button>
                </div>
              </div>
              <div className="mt-5 grid gap-4 sm:grid-cols-2">
                <label className="grid gap-2 text-sm font-bold text-[#4d6256]">
                  {project.name} 项目名称
                  <input
                    aria-label={`${project.name} 项目名称`}
                    value={draft.name}
                    onChange={(event) => setDrafts((current) => ({
                      ...current,
                      [project.id]: { ...draft, name: event.target.value },
                    }))}
                    className="rounded-xl border border-[#cfdccf] bg-[#f8faf7] px-4 py-3 font-normal text-[#17211d]"
                  />
                </label>
                <label className="grid gap-2 text-sm font-bold text-[#4d6256]">
                  {project.name} 项目标识
                  <input
                    aria-label={`${project.name} 项目标识`}
                    value={project.slug}
                    readOnly
                    className="rounded-xl border border-[#d9e1d9] bg-[#eef2ed] px-4 py-3 font-mono font-normal text-[#66766d]"
                  />
                </label>
                <label className="grid gap-2 text-sm font-bold text-[#4d6256] sm:col-span-2">
                  {project.name} 项目简介
                  <textarea
                    aria-label={`${project.name} 项目简介`}
                    value={draft.description}
                    onChange={(event) => setDrafts((current) => ({
                      ...current,
                      [project.id]: { ...draft, description: event.target.value },
                    }))}
                    className="min-h-24 rounded-xl border border-[#cfdccf] bg-[#f8faf7] px-4 py-3 font-normal text-[#17211d]"
                  />
                </label>
              </div>
              <section aria-label={`${project.name} 同步密钥`} className="mt-5 rounded-2xl border border-[#dbe5dc] bg-[#f7faf6] p-4">
                <p className="text-xs font-bold text-[#607269]">项目同步密钥</p>
                <code className="mt-2 block font-mono text-sm font-bold tracking-wide text-[#29483a]">{project.syncKeyMasked}</code>
                <p className="mt-2 text-xs leading-5 text-[#718077]">页面始终只显示脱敏片段；完整值仅在复制动作中短暂返回。</p>
                <div className="mt-3 flex flex-wrap gap-2">
                  <button type="button" disabled={busy} onClick={() => copyProjectSyncKey(project)} className="rounded-lg border border-[#b9cbbb] px-3 py-2 text-xs font-bold text-[#1d5b46] disabled:opacity-50">
                    复制 {project.name} 同步密钥
                  </button>
                  <button type="button" disabled={busy} onClick={() => rotateProjectSyncKey(project)} className="rounded-lg border border-[#d7b9ae] px-3 py-2 text-xs font-bold text-[#8a4331] disabled:opacity-50">
                    轮换 {project.name} 同步密钥
                  </button>
                </div>
              </section>
              <div className="mt-5 flex flex-wrap items-center gap-3">
                <button type="button" disabled={busy} onClick={() => saveProject(project)} className="rounded-xl bg-[#1e6349] px-4 py-2.5 text-sm font-bold text-white disabled:opacity-50">
                  保存 {project.name} 项目资料
                </button>
                <a href={`/projects/${project.slug}/admin`} className="rounded-xl border border-[#bfcfc1] px-4 py-2.5 text-sm font-bold text-[#245d46]">
                  进入 {project.name} 历史管理
                </a>
                <button
                  type="button"
                  disabled={busy}
                  onClick={() => setProjectEnabled(project, !project.enabled)}
                  className={project.enabled
                    ? 'rounded-xl border border-[#d7b9ae] px-4 py-2.5 text-sm font-bold text-[#8a4331] disabled:opacity-50'
                    : 'rounded-xl bg-[#1e6349] px-4 py-2.5 text-sm font-bold text-white disabled:opacity-50'}
                >
                  {project.enabled ? `停用 ${project.name}` : `恢复 ${project.name}`}
                </button>
              </div>
            </article>
          );
        })}
      </section>

      <section className="rounded-3xl border border-[#d8e4d9] bg-white p-6 shadow-[0_12px_34px_rgba(31,77,51,0.05)] sm:p-8">
        <p className="text-xs font-bold uppercase tracking-[0.14em] text-[#4c8068]">只读记录</p>
        <h2 className="mt-1 text-2xl font-black text-[#1b382b]">项目操作审计</h2>
        <form className="mt-5 grid gap-4 rounded-2xl bg-[#f4f7f3] p-5 sm:grid-cols-3" onSubmit={filterAudits}>
          <Field label="按项目标识筛选审计" name="projectSlug" />
          <Field label="按管理员 ID 筛选审计" name="adminUserId" />
          <label className="grid gap-2 text-sm font-bold text-[#4d6256]">
            按动作筛选审计
            <select name="action" aria-label="按动作筛选审计" className="rounded-xl border border-[#cfdccf] bg-white px-4 py-3 font-normal text-[#17211d]">
              <option value="">全部动作</option>
              {Object.entries(ACTION_LABELS).map(([value, label]) => <option key={value} value={value}>{label}</option>)}
            </select>
          </label>
          <button disabled={busy} className="rounded-xl bg-[#1e6349] px-5 py-3 text-sm font-bold text-white disabled:opacity-50 sm:col-span-3">
            查询审计
          </button>
        </form>
        <div className="mt-5 space-y-3">
          {audits.map((audit) => (
            <article key={audit.id} className="rounded-2xl border border-[#dbe5dc] p-4 text-sm text-[#52655a]">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <p className="font-black text-[#264936]">{audit.projectName ?? audit.projectSlug ?? '项目排序'}</p>
                <time dateTime={audit.createdAt}>{formatAuditTime(audit.createdAt)}</time>
              </div>
              <p className="mt-2">
                {ACTION_LABELS[audit.action]} ·{' '}
                <span>{audit.result === 'success' ? '成功' : `失败（${audit.failureCode ?? '未知原因'}）`}</span>
              </p>
              <p className="mt-1">{audit.adminDisplayName}（{audit.adminEmail}）</p>
              <p className="mt-1 font-mono text-xs">管理员 ID：{audit.adminUserId}</p>
              <details className="mt-2">
                <summary className="cursor-pointer font-bold text-[#32654d]">查看项目快照</summary>
                <pre className="mt-2 overflow-auto rounded-lg bg-[#f4f7f3] p-3 text-xs">{prettySnapshot(audit.projectSnapshot)}</pre>
              </details>
            </article>
          ))}
          {!audits.length && <p className="rounded-2xl border border-dashed border-[#cbd8cc] p-6 text-center text-sm text-[#6b7a71]">没有符合条件的审计记录。</p>}
          {auditHasMore && auditCursor && (
            <button type="button" disabled={busy} onClick={loadMoreAudits} className="w-full rounded-xl border border-[#bfcfc1] px-4 py-3 text-sm font-bold text-[#245d46] disabled:opacity-50">
              加载更早审计
            </button>
          )}
        </div>
      </section>

      {message && <p role="status" className="rounded-xl border border-[#cbd9cc] bg-[#eef5ee] px-4 py-3 text-sm font-bold text-[#28533e]">{message}</p>}
    </div>
  );
}

function Field({ label, name, ...inputProps }: {
  label: string;
  name: string;
} & React.InputHTMLAttributes<HTMLInputElement>) {
  return (
    <label className="grid gap-2 text-sm font-bold text-[#4d6256]">
      {label}
      <input name={name} aria-label={label} {...inputProps} className="rounded-xl border border-[#cfdccf] bg-white px-4 py-3 font-normal text-[#17211d]" />
    </label>
  );
}

async function request<T>(input: string, init?: RequestInit): Promise<T> {
  const response = await fetch(input, init);
  const body = await response.json() as T & { error?: string };
  if (!response.ok) throw new Error(body.error ?? '项目维护失败。');
  return body;
}

function sortProjects(projects: AdminProject[]): AdminProject[] {
  return [...projects].sort((left, right) =>
    left.displayOrder - right.displayOrder || compareSqliteNoCase(left.name, right.name) || left.id - right.id,
  );
}

function compareSqliteNoCase(left: string, right: string): number {
  const leftBytes = UTF8_ENCODER.encode(left);
  const rightBytes = UTF8_ENCODER.encode(right);
  const length = Math.min(leftBytes.length, rightBytes.length);
  for (let index = 0; index < length; index += 1) {
    const leftByte = asciiLowerByte(leftBytes[index]);
    const rightByte = asciiLowerByte(rightBytes[index]);
    if (leftByte !== rightByte) return leftByte - rightByte;
  }
  return leftBytes.length - rightBytes.length;
}

function asciiLowerByte(value: number): number {
  return value >= 65 && value <= 90 ? value + 32 : value;
}

function prettySnapshot(value: string): string {
  try {
    return JSON.stringify(JSON.parse(value), null, 2);
  } catch {
    return value;
  }
}

function formatAuditTime(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  const beijing = new Date(date.getTime() + 8 * 60 * 60 * 1000);
  const parts = [
    beijing.getUTCFullYear(),
    beijing.getUTCMonth() + 1,
    beijing.getUTCDate(),
    beijing.getUTCHours(),
    beijing.getUTCMinutes(),
    beijing.getUTCSeconds(),
  ];
  const [year, ...rest] = parts;
  const padded = rest.map((part) => String(part).padStart(2, '0'));
  return `${year}-${padded[0]}-${padded[1]} ${padded[2]}:${padded[3]}:${padded[4]}`;
}
