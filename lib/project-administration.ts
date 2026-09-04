import { env } from 'cloudflare:workers';
import type { ChatGPTUser } from '@/app/chatgpt-auth';
import {
  decryptProjectSyncKey,
  encryptProjectSyncKey,
  ensureReviewSchema,
  generateProjectSyncKey,
  maskProjectSyncKey,
} from '@/lib/reviews';

type RuntimeEnv = { DB: D1Database };
type SqlValue = string | number | null;

export const PROJECT_ADMIN_ACTIONS = [
  'project.create',
  'project.update',
  'project.reorder',
  'project.disable',
  'project.restore',
  'project.sync-key.copy',
  'project.sync-key.rotate',
] as const;

export type ProjectAdminAction = (typeof PROJECT_ADMIN_ACTIONS)[number];

export type AdminProject = {
  id: number;
  name: string;
  slug: string;
  description: string;
  displayOrder: number;
  enabled: boolean;
  syncKeyMasked: string;
  createdAt: string;
  updatedAt: string;
};

export type ProjectAdminAudit = {
  id: number;
  projectId: number | null;
  projectSlug: string | null;
  projectName: string | null;
  projectSnapshot: string;
  adminUserId: string;
  adminEmail: string;
  adminDisplayName: string;
  action: ProjectAdminAction;
  result: 'success' | 'failure';
  failureCode: string | null;
  createdAt: string;
};

export type ProjectAdminAuditPage = {
  audits: ProjectAdminAudit[];
  nextCursor: string | null;
  hasMore: boolean;
};

type StoredProject = Omit<AdminProject, 'enabled' | 'syncKeyMasked'> & {
  enabled: number;
  syncKeyEncrypted: string | null;
};

type AuditInput = {
  project?: Partial<AdminProject> | null;
  snapshot: unknown;
  action: ProjectAdminAction;
  result: 'success' | 'failure';
  failureCode?: string | null;
};

const PROJECT_SLUG_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const RESERVED_PROJECT_SLUGS = new Set([
  'admin',
  'api',
  'archive',
  'callback',
  'issues',
  'projects',
  'reviews',
  'signin-with-chatgpt',
  'signout-with-chatgpt',
]);

export class ProjectAdminError extends Error {
  constructor(
    message: string,
    public readonly code: string,
    public readonly status: number,
  ) {
    super(message);
    this.name = 'ProjectAdminError';
  }
}

function db(): D1Database {
  const value = (env as unknown as RuntimeEnv).DB;
  if (!value) throw new Error('审查站的数据存储尚未连接。');
  return value;
}

async function adminProject(row: StoredProject): Promise<AdminProject> {
  const { syncKeyEncrypted, enabled, ...project } = row;
  let syncKeyMasked = '';
  if (syncKeyEncrypted) {
    try {
      syncKeyMasked = maskProjectSyncKey(
        await decryptProjectSyncKey(project, syncKeyEncrypted),
      );
    } catch {
      syncKeyMasked = '不可用';
    }
  }
  return {
    ...project,
    enabled: enabled === 1,
    syncKeyMasked,
  };
}

function projectSelect(): string {
  return `SELECT id, name, slug, description, display_order AS displayOrder,
                 enabled, sync_key_encrypted AS syncKeyEncrypted,
                 created_at AS createdAt, updated_at AS updatedAt
          FROM review_projects`;
}

async function firstProject(statement: string, values: SqlValue[] = []): Promise<AdminProject | null> {
  let row = await db().prepare(statement).bind(...values).first<StoredProject>();
  if (!row) return null;
  if (!row.syncKeyEncrypted) {
    await provisionProjectSyncKeys([row]);
    row = await db().prepare(statement).bind(...values).first<StoredProject>();
  }
  return row ? adminProject(row) : null;
}

export async function listAdminProjects(): Promise<AdminProject[]> {
  await ensureReviewSchema();
  const result = await db().prepare(
    `${projectSelect()} ORDER BY display_order, name COLLATE NOCASE, id`,
  ).all<StoredProject>();
  let rows = result.results ?? [];
  const missing = rows.filter((row) => !row.syncKeyEncrypted);
  if (missing.length) {
    await provisionProjectSyncKeys(missing);
    rows = (await db().prepare(
      `${projectSelect()} ORDER BY display_order, name COLLATE NOCASE, id`,
    ).all<StoredProject>()).results ?? [];
  }
  return Promise.all(rows.map(adminProject));
}

export async function createAdminProject(
  user: ChatGPTUser,
  input: unknown,
): Promise<AdminProject> {
  await ensureReviewSchema();
  let candidate: CreateProjectInput;
  try {
    candidate = parseCreateInput(input);
    await assertUniqueProject(candidate.name, candidate.slug);
  } catch (error) {
    const businessError = asProjectAdminError(error);
    await writeAudit(user, {
      project: projectCandidate(input),
      snapshot: projectCandidate(input) ?? {},
      action: 'project.create',
      result: 'failure',
      failureCode: businessError.code,
    });
    throw businessError;
  }

  const syncKey = generateProjectSyncKey();
  const syncKeyEncrypted = await encryptProjectSyncKey(
    { id: 0, slug: candidate.slug },
    syncKey,
  );
  const now = new Date().toISOString();
  try {
    await db().batch([
      db().prepare(
        `INSERT INTO review_projects
           (name, slug, description, display_order, enabled, sync_key_encrypted,
            created_at, updated_at)
         VALUES (?, ?, ?, ?, 1, ?, ?, ?)`,
      ).bind(
        candidate.name,
        candidate.slug,
        candidate.description,
        candidate.displayOrder,
        syncKeyEncrypted,
        now,
        now,
      ),
      auditProjectSelectStatement(user, 'project.create', 'success', null, now, candidate.slug),
    ]);
  } catch (error) {
    const businessError = uniqueConstraintError(error, candidate);
    if (!businessError) throw error;
    await writeAudit(user, {
      project: candidate,
      snapshot: candidate,
      action: 'project.create',
      result: 'failure',
      failureCode: businessError.code,
    });
    throw businessError;
  }

  const project = await firstProject(`${projectSelect()} WHERE slug = ?`, [candidate.slug]);
  if (!project) throw new Error('项目已创建，但无法读取创建结果。');
  return project;
}

export async function updateAdminProject(
  user: ChatGPTUser,
  projectId: number,
  input: unknown,
): Promise<AdminProject> {
  await ensureReviewSchema();
  const existing = await firstProject(`${projectSelect()} WHERE id = ?`, [projectId]);
  if (!existing) {
    const error = new ProjectAdminError('审查项目不存在。', 'project_not_found', 404);
    await writeAudit(user, {
      project: { id: projectId },
      snapshot: { id: projectId },
      action: 'project.update',
      result: 'failure',
      failureCode: error.code,
    });
    throw error;
  }

  let candidate: UpdateProjectInput;
  try {
    candidate = parseUpdateInput(input, existing);
    await assertUniqueProject(candidate.name, existing.slug, existing.id);
  } catch (error) {
    const businessError = asProjectAdminError(error);
    await writeAudit(user, {
      project: existing,
      snapshot: existing,
      action: 'project.update',
      result: 'failure',
      failureCode: businessError.code,
    });
    throw businessError;
  }

  const now = new Date().toISOString();
  try {
    await db().batch([
      db().prepare(
        `UPDATE review_projects
         SET name = ?, description = ?, updated_at = ?
         WHERE id = ?`,
      ).bind(candidate.name, candidate.description, now, existing.id),
      auditProjectSelectStatement(user, 'project.update', 'success', null, now, existing.slug),
    ]);
  } catch (error) {
    const businessError = uniqueConstraintError(error, {
      ...candidate,
      slug: existing.slug,
      displayOrder: existing.displayOrder,
    });
    if (!businessError) throw error;
    await writeAudit(user, {
      project: existing,
      snapshot: existing,
      action: 'project.update',
      result: 'failure',
      failureCode: businessError.code,
    });
    throw businessError;
  }

  const updated = await firstProject(`${projectSelect()} WHERE id = ?`, [existing.id]);
  if (!updated) throw new Error('项目已更新，但无法读取更新结果。');
  return updated;
}

export async function setAdminProjectEnabled(
  user: ChatGPTUser,
  projectId: number,
  input: unknown,
): Promise<AdminProject> {
  await ensureReviewSchema();
  const enabled = parseEnabledStatus(input);
  const action: ProjectAdminAction = enabled ? 'project.restore' : 'project.disable';
  const existing = await firstProject(`${projectSelect()} WHERE id = ?`, [projectId]);
  if (!existing) {
    const error = new ProjectAdminError('审查项目不存在。', 'project_not_found', 404);
    await writeAudit(user, {
      project: { id: projectId },
      snapshot: { id: projectId },
      action,
      result: 'failure',
      failureCode: error.code,
    });
    throw error;
  }
  if (existing.enabled === enabled) {
    const code = enabled ? 'project_already_enabled' : 'project_already_disabled';
    const error = new ProjectAdminError(
      enabled ? '项目已经启用。' : '项目已经停用。',
      code,
      409,
    );
    await writeAudit(user, {
      project: existing,
      snapshot: existing,
      action,
      result: 'failure',
      failureCode: error.code,
    });
    throw error;
  }

  const now = new Date().toISOString();
  const target = enabled ? 1 : 0;
  const current = existing.enabled ? 1 : 0;
  const results = await db().batch([
    db().prepare(
      `UPDATE review_projects SET enabled = ?, updated_at = ?
       WHERE id = ? AND enabled = ? AND updated_at = ?`,
    ).bind(target, now, projectId, current, existing.updatedAt),
    auditProjectStatusSelectStatement(user, action, now, projectId, target),
  ]);
  const updateWriteCount = Number(results[0]?.meta.changes ?? 0);
  const auditWriteCount = Number(results[1]?.meta.changes ?? 0);
  if (updateWriteCount !== 1 || auditWriteCount !== 1) {
    const latest = await firstProject(`${projectSelect()} WHERE id = ?`, [projectId]);
    const error = new ProjectAdminError(
      '项目状态已变化，请刷新后重试。',
      'project_status_changed',
      409,
    );
    await writeAudit(user, {
      project: latest ?? existing,
      snapshot: latest ?? existing,
      action,
      result: 'failure',
      failureCode: error.code,
    });
    throw error;
  }
  const updated = await firstProject(`${projectSelect()} WHERE id = ?`, [projectId]);
  if (!updated) throw new Error('项目状态已更新，但无法读取更新结果。');
  return updated;
}

export async function copyAdminProjectSyncKey(
  user: ChatGPTUser,
  projectId: number,
): Promise<{ syncKey: string; syncKeyMasked: string }> {
  await ensureReviewSchema();
  const stored = await requireStoredProject(user, projectId, 'project.sync-key.copy');
  let syncKey: string;
  try {
    syncKey = await decryptProjectSyncKey(stored, stored.syncKeyEncrypted);
  } catch {
    const project = await adminProject(stored);
    const error = projectSyncKeyUnavailableError();
    await writeAudit(user, {
      project,
      snapshot: project,
      action: 'project.sync-key.copy',
      result: 'failure',
      failureCode: error.code,
    });
    throw error;
  }
  const createdAt = new Date().toISOString();
  const result = await auditProjectSyncKeyStatement(
    user,
    'project.sync-key.copy',
    createdAt,
    projectId,
    stored.syncKeyEncrypted,
    false,
  ).run();
  if (Number(result.meta.changes ?? 0) !== 1) {
    const error = new ProjectAdminError(
      '项目同步密钥已变化，请重试复制。',
      'project_sync_key_changed',
      409,
    );
    await writeAudit(user, {
      project: await firstProject(`${projectSelect()} WHERE id = ?`, [projectId]) ?? { id: projectId },
      snapshot: { id: projectId },
      action: 'project.sync-key.copy',
      result: 'failure',
      failureCode: error.code,
    });
    throw error;
  }
  return { syncKey, syncKeyMasked: maskProjectSyncKey(syncKey) };
}

export async function rotateAdminProjectSyncKey(
  user: ChatGPTUser,
  projectId: number,
): Promise<AdminProject> {
  await ensureReviewSchema();
  const stored = await requireStoredProject(user, projectId, 'project.sync-key.rotate');
  let syncKeyEncrypted: string;
  try {
    syncKeyEncrypted = await encryptProjectSyncKey(stored, generateProjectSyncKey());
  } catch {
    const project = await adminProject(stored);
    const error = projectSyncKeyUnavailableError();
    await writeAudit(user, {
      project,
      snapshot: project,
      action: 'project.sync-key.rotate',
      result: 'failure',
      failureCode: error.code,
    });
    throw error;
  }
  const createdAt = new Date().toISOString();
  const results = await db().batch([
    db().prepare(
      `UPDATE review_projects SET sync_key_encrypted = ?, updated_at = ?
       WHERE id = ? AND sync_key_encrypted = ?`,
    ).bind(syncKeyEncrypted, createdAt, projectId, stored.syncKeyEncrypted),
    auditProjectSyncKeyStatement(
      user,
      'project.sync-key.rotate',
      createdAt,
      projectId,
      syncKeyEncrypted,
      true,
    ),
  ]);
  if (
    Number(results[0]?.meta.changes ?? 0) !== 1 ||
    Number(results[1]?.meta.changes ?? 0) !== 1
  ) {
    const latest = await firstProject(`${projectSelect()} WHERE id = ?`, [projectId]);
    const error = new ProjectAdminError(
      '项目同步密钥已变化，请刷新后重试。',
      'project_sync_key_changed',
      409,
    );
    await writeAudit(user, {
      project: latest ?? { id: projectId },
      snapshot: latest ?? { id: projectId },
      action: 'project.sync-key.rotate',
      result: 'failure',
      failureCode: error.code,
    });
    throw error;
  }
  const updated = await firstProject(`${projectSelect()} WHERE id = ?`, [projectId]);
  if (!updated) throw new Error('项目同步密钥已轮换，但无法读取项目。');
  return updated;
}

export async function reorderAdminProjects(
  user: ChatGPTUser,
  input: unknown,
): Promise<AdminProject[]> {
  await ensureReviewSchema();
  const projects = await listAdminProjects();
  let projectIds: number[];
  try {
    projectIds = parseProjectOrder(input);
    const knownIds = new Set(projects.map((project) => project.id));
    if (projectIds.some((id) => !knownIds.has(id))) {
      throw new ProjectAdminError('排序中包含不存在的项目。', 'unknown_project_id', 400);
    }
    if (projectIds.length !== projects.length) {
      throw new ProjectAdminError('排序必须包含全部项目。', 'incomplete_project_order', 400);
    }
  } catch (error) {
    const businessError = asProjectAdminError(error);
    await writeAudit(user, {
      snapshot: projectOrderCandidate(input, projects),
      action: 'project.reorder',
      result: 'failure',
      failureCode: businessError.code,
    });
    throw businessError;
  }

  const now = new Date().toISOString();
  const projectSetGuard = currentProjectSetGuard(projectIds);
  const projectIdsJson = JSON.stringify(projectIds);
  const results = await db().batch([
    db().prepare(
      `UPDATE review_projects
       SET display_order = (
             SELECT CAST(requested.key AS INTEGER) * 10
             FROM json_each(?) AS requested
             WHERE CAST(requested.value AS INTEGER) = review_projects.id
           ),
           updated_at = ?
       WHERE ${projectSetGuard.sql}`,
    ).bind(projectIdsJson, now, ...projectSetGuard.values),
    auditProjectSetStatement(user, 'project.reorder', now, projectSetGuard),
  ]);
  const auditWriteCount = results[1]?.meta.changes ?? 0;
  if (auditWriteCount !== projectIds.length) {
    const currentProjects = await listAdminProjects();
    const error = new ProjectAdminError(
      '项目列表已变化，请刷新后重新排序。',
      'project_set_changed',
      409,
    );
    await writeAudit(user, {
      snapshot: { requestedProjectIds: projectIds, projects: currentProjects },
      action: 'project.reorder',
      result: 'failure',
      failureCode: error.code,
    });
    throw error;
  }
  return listAdminProjects();
}

export async function getProjectAdminAuditPage(
  url: URL,
): Promise<ProjectAdminAuditPage> {
  await ensureReviewSchema();
  const conditions: string[] = [];
  const values: SqlValue[] = [];
  const projectSlug = url.searchParams.get('projectSlug')?.trim() ?? '';
  const adminUserId = url.searchParams.get('adminUserId')?.trim() ?? '';
  const action = url.searchParams.get('action')?.trim() ?? '';
  const cursorValue = url.searchParams.get('cursor')?.trim() ?? '';

  if (projectSlug) {
    conditions.push('project_slug_snapshot = ?');
    values.push(projectSlug);
  }
  if (adminUserId) {
    conditions.push('admin_user_id = ?');
    values.push(adminUserId);
  }
  if (action) {
    if (!PROJECT_ADMIN_ACTIONS.includes(action as ProjectAdminAction)) {
      throw new ProjectAdminError('审计动作筛选无效。', 'invalid_audit_action', 400);
    }
    conditions.push('action = ?');
    values.push(action);
  }
  if (cursorValue) {
    const cursor = decodeAuditCursor(cursorValue);
    conditions.push('(created_at < ? OR (created_at = ? AND id < ?))');
    values.push(cursor.createdAt, cursor.createdAt, cursor.id);
  }

  const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';
  const result = await db().prepare(
    `SELECT id, project_id_snapshot AS projectId,
            project_slug_snapshot AS projectSlug,
            project_name_snapshot AS projectName,
            project_snapshot_json AS projectSnapshot,
            admin_user_id AS adminUserId,
            admin_email_snapshot AS adminEmail,
            admin_display_name_snapshot AS adminDisplayName,
            action, result, failure_code AS failureCode,
            created_at AS createdAt
     FROM project_admin_audits
     ${where}
     ORDER BY created_at DESC, id DESC
     LIMIT 101`,
  ).bind(...values).all<ProjectAdminAudit>();
  const rows = result.results ?? [];
  const audits = rows.slice(0, 100);
  const hasMore = rows.length > audits.length;
  const last = hasMore ? audits.at(-1) : null;
  return {
    audits,
    nextCursor: last ? encodeAuditCursor(last) : null,
    hasMore,
  };
}

type CreateProjectInput = {
  name: string;
  slug: string;
  description: string;
  displayOrder: number;
};

type UpdateProjectInput = {
  name: string;
  description: string;
};

function parseCreateInput(input: unknown): CreateProjectInput {
  const record = objectInput(input);
  const name = requiredName(record.name);
  const slug = requiredSlug(record.slug);
  const description = optionalDescription(record.description);
  const displayOrder = integerDisplayOrder(record.displayOrder ?? 0);
  return { name, slug, description, displayOrder };
}

function parseUpdateInput(input: unknown, existing: AdminProject): UpdateProjectInput {
  const record = objectInput(input);
  if (Object.prototype.hasOwnProperty.call(record, 'slug')) {
    throw new ProjectAdminError('项目标识创建后不可修改。', 'immutable_slug', 409);
  }
  if (Object.prototype.hasOwnProperty.call(record, 'displayOrder')) {
    throw new ProjectAdminError('请使用项目排序功能调整显示顺序。', 'use_project_order', 400);
  }
  return {
    name: record.name === undefined ? existing.name : requiredName(record.name),
    description: record.description === undefined
      ? existing.description
      : optionalDescription(record.description),
  };
}

function parseProjectOrder(input: unknown): number[] {
  const value = objectInput(input).projectIds;
  if (!Array.isArray(value) || value.length === 0) {
    throw new ProjectAdminError('请提供完整的项目排序。', 'invalid_project_order', 400);
  }
  const ids = value.map(Number);
  if (ids.some((id) => !Number.isSafeInteger(id) || id <= 0)) {
    throw new ProjectAdminError('项目排序中存在无效 ID。', 'invalid_project_id', 400);
  }
  if (new Set(ids).size !== ids.length) {
    throw new ProjectAdminError('项目排序不能包含重复项目。', 'duplicate_project_id', 400);
  }
  return ids;
}

function parseEnabledStatus(input: unknown): boolean {
  const record = objectInput(input);
  if (
    typeof record.enabled !== 'boolean' ||
    Object.keys(record).some((key) => key !== 'enabled')
  ) {
    throw new ProjectAdminError('项目状态请求无效。', 'invalid_project_status', 400);
  }
  return record.enabled;
}

function objectInput(input: unknown): Record<string, unknown> {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    throw new ProjectAdminError('请求内容必须是对象。', 'invalid_request', 400);
  }
  return input as Record<string, unknown>;
}

function requiredName(value: unknown): string {
  if (typeof value !== 'string' || !value.trim()) {
    throw new ProjectAdminError('项目名称不能为空。', 'invalid_name', 400);
  }
  return value.trim();
}

function requiredSlug(value: unknown): string {
  if (typeof value !== 'string' || !PROJECT_SLUG_PATTERN.test(value)) {
    throw new ProjectAdminError(
      '项目标识只能使用小写字母、数字和单个连字符。',
      'invalid_slug',
      400,
    );
  }
  if (RESERVED_PROJECT_SLUGS.has(value)) {
    throw new ProjectAdminError('该项目标识为系统保留字。', 'reserved_slug', 400);
  }
  return value;
}

function optionalDescription(value: unknown): string {
  if (value === undefined || value === null) return '';
  if (typeof value !== 'string') {
    throw new ProjectAdminError('项目简介必须是文本。', 'invalid_description', 400);
  }
  return value.trim();
}

function integerDisplayOrder(value: unknown): number {
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number < 0) {
    throw new ProjectAdminError('显示顺序必须是非负整数。', 'invalid_display_order', 400);
  }
  return number;
}

async function assertUniqueProject(name: string, slug: string, exceptId?: number): Promise<void> {
  const except = exceptId === undefined ? '' : ' AND id <> ?';
  const values: SqlValue[] = exceptId === undefined ? [name, slug] : [name, exceptId, slug, exceptId];
  const existing = await db().prepare(
    `SELECT
       EXISTS(SELECT 1 FROM review_projects WHERE name = ? COLLATE NOCASE${except}) AS duplicateName,
       EXISTS(SELECT 1 FROM review_projects WHERE slug = ?${except}) AS duplicateSlug`,
  ).bind(...values).first<{ duplicateName: number; duplicateSlug: number }>();
  if (existing?.duplicateName) {
    throw new ProjectAdminError('项目名称已经存在。', 'duplicate_name', 409);
  }
  if (existing?.duplicateSlug) {
    throw new ProjectAdminError('项目标识已经存在。', 'duplicate_slug', 409);
  }
}

function uniqueConstraintError(error: unknown, candidate: CreateProjectInput): ProjectAdminError | null {
  const message = error instanceof Error ? error.message : String(error);
  if (!/unique constraint/i.test(message)) return null;
  return message.includes('review_projects.name')
    ? new ProjectAdminError('项目名称已经存在。', 'duplicate_name', 409)
    : new ProjectAdminError(`项目标识 ${candidate.slug} 已经存在。`, 'duplicate_slug', 409);
}

function asProjectAdminError(error: unknown): ProjectAdminError {
  if (error instanceof ProjectAdminError) return error;
  throw error;
}

function projectCandidate(input: unknown): Partial<AdminProject> | null {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return null;
  const record = input as Record<string, unknown>;
  return {
    ...(typeof record.name === 'string' ? { name: record.name } : {}),
    ...(typeof record.slug === 'string' ? { slug: record.slug } : {}),
    ...(typeof record.description === 'string' ? { description: record.description } : {}),
    ...(Number.isInteger(record.displayOrder) ? { displayOrder: Number(record.displayOrder) } : {}),
  };
}

function projectOrderCandidate(input: unknown, projects: AdminProject[]): unknown {
  const requestedProjectIds = input && typeof input === 'object' && !Array.isArray(input)
    ? (input as Record<string, unknown>).projectIds
    : undefined;
  return { requestedProjectIds, projects };
}

function encodeAuditCursor(audit: Pick<ProjectAdminAudit, 'createdAt' | 'id'>): string {
  return btoa(JSON.stringify({ createdAt: audit.createdAt, id: audit.id }));
}

function decodeAuditCursor(value: string): { createdAt: string; id: number } {
  try {
    const decoded = JSON.parse(atob(value)) as { createdAt?: unknown; id?: unknown };
    if (
      typeof decoded.createdAt !== 'string' ||
      !decoded.createdAt ||
      !Number.isSafeInteger(decoded.id) ||
      Number(decoded.id) <= 0
    ) {
      throw new Error('invalid cursor');
    }
    return { createdAt: decoded.createdAt, id: Number(decoded.id) };
  } catch {
    throw new ProjectAdminError('审计游标无效。', 'invalid_audit_cursor', 400);
  }
}

async function provisionProjectSyncKeys(
  projects: Array<Pick<StoredProject, 'id' | 'slug'>>,
): Promise<void> {
  if (!projects.length) return;
  const generated = await Promise.all(projects.map(async (project) => ({
    id: project.id,
    ciphertext: await encryptProjectSyncKey(project, generateProjectSyncKey()),
  })));
  await db().prepare(
    `WITH generated AS (
       SELECT CAST(json_extract(value, '$.id') AS INTEGER) AS id,
              json_extract(value, '$.ciphertext') AS ciphertext
       FROM json_each(?)
     )
     UPDATE review_projects
     SET sync_key_encrypted = (
           SELECT ciphertext FROM generated WHERE generated.id = review_projects.id
         ),
         updated_at = ?
     WHERE sync_key_encrypted IS NULL
       AND id IN (SELECT id FROM generated)`,
  ).bind(JSON.stringify(generated), new Date().toISOString()).run();
}

async function requireStoredProject(
  user: ChatGPTUser,
  projectId: number,
  action: 'project.sync-key.copy' | 'project.sync-key.rotate',
): Promise<StoredProject & { syncKeyEncrypted: string }> {
  let project = await db().prepare(
    `${projectSelect()} WHERE id = ?`,
  ).bind(projectId).first<StoredProject>();
  if (!project) {
    const error = new ProjectAdminError('审查项目不存在。', 'project_not_found', 404);
    await writeAudit(user, {
      project: { id: projectId },
      snapshot: { id: projectId },
      action,
      result: 'failure',
      failureCode: error.code,
    });
    throw error;
  }
  if (!project.syncKeyEncrypted) {
    try {
      await provisionProjectSyncKeys([project]);
    } catch {
      const safeProject = await adminProject(project);
      const error = projectSyncKeyUnavailableError();
      await writeAudit(user, {
        project: safeProject,
        snapshot: safeProject,
        action,
        result: 'failure',
        failureCode: error.code,
      });
      throw error;
    }
    project = await db().prepare(
      `${projectSelect()} WHERE id = ?`,
    ).bind(projectId).first<StoredProject>();
  }
  if (!project?.syncKeyEncrypted) {
    throw new Error('项目同步密钥未能生成。');
  }
  return project as StoredProject & { syncKeyEncrypted: string };
}

function projectSyncKeyUnavailableError(): ProjectAdminError {
  return new ProjectAdminError(
    '当前项目同步密钥不可用，请检查站点主密钥配置或轮换密钥。',
    'project_sync_key_unavailable',
    409,
  );
}

function auditProjectSelectStatement(
  user: ChatGPTUser,
  action: ProjectAdminAction,
  result: 'success' | 'failure',
  failureCode: string | null,
  createdAt: string,
  slug: string,
): D1PreparedStatement {
  return db().prepare(
    `INSERT INTO project_admin_audits
       (project_id_snapshot, project_slug_snapshot, project_name_snapshot,
        project_snapshot_json, admin_user_id, admin_email_snapshot,
        admin_display_name_snapshot, action, result, failure_code, created_at)
     SELECT id, slug, name,
            json_object('id', id, 'name', name, 'slug', slug,
                        'description', description, 'displayOrder', display_order,
                        'enabled', CASE WHEN enabled = 1 THEN json('true') ELSE json('false') END),
            ?, ?, ?, ?, ?, ?, ?
     FROM review_projects WHERE slug = ?`,
  ).bind(
    user.userId,
    user.email,
    user.displayName,
    action,
    result,
    failureCode,
    createdAt,
    slug,
  );
}

function auditProjectSyncKeyStatement(
  user: ChatGPTUser,
  action: 'project.sync-key.copy' | 'project.sync-key.rotate',
  createdAt: string,
  projectId: number,
  syncKeyEncrypted: string,
  requirePreviousChange: boolean,
): D1PreparedStatement {
  return db().prepare(
    `INSERT INTO project_admin_audits
       (project_id_snapshot, project_slug_snapshot, project_name_snapshot,
        project_snapshot_json, admin_user_id, admin_email_snapshot,
        admin_display_name_snapshot, action, result, failure_code, created_at)
     SELECT id, slug, name,
            json_object('id', id, 'name', name, 'slug', slug,
                        'description', description, 'displayOrder', display_order,
                        'enabled', CASE WHEN enabled = 1 THEN json('true') ELSE json('false') END),
            ?, ?, ?, ?, 'success', NULL, ?
     FROM review_projects
     WHERE id = ? AND sync_key_encrypted = ?${requirePreviousChange ? ' AND changes() = 1' : ''}`,
  ).bind(
    user.userId,
    user.email,
    user.displayName,
    action,
    createdAt,
    projectId,
    syncKeyEncrypted,
  );
}

function auditProjectSetStatement(
  user: ChatGPTUser,
  action: ProjectAdminAction,
  createdAt: string,
  projectSetGuard: { sql: string; values: SqlValue[] },
): D1PreparedStatement {
  return db().prepare(
    `INSERT INTO project_admin_audits
       (project_id_snapshot, project_slug_snapshot, project_name_snapshot,
        project_snapshot_json, admin_user_id, admin_email_snapshot,
        admin_display_name_snapshot, action, result, failure_code, created_at)
     SELECT id, slug, name,
            json_object('id', id, 'name', name, 'slug', slug,
                        'description', description, 'displayOrder', display_order,
                        'enabled', CASE WHEN enabled = 1 THEN json('true') ELSE json('false') END),
            ?, ?, ?, ?, 'success', NULL, ?
     FROM review_projects WHERE ${projectSetGuard.sql}`,
  ).bind(
    user.userId,
    user.email,
    user.displayName,
    action,
    createdAt,
    ...projectSetGuard.values,
  );
}

function auditProjectStatusSelectStatement(
  user: ChatGPTUser,
  action: ProjectAdminAction,
  createdAt: string,
  projectId: number,
  enabled: number,
): D1PreparedStatement {
  return db().prepare(
    `INSERT INTO project_admin_audits
       (project_id_snapshot, project_slug_snapshot, project_name_snapshot,
        project_snapshot_json, admin_user_id, admin_email_snapshot,
        admin_display_name_snapshot, action, result, failure_code, created_at)
     SELECT id, slug, name,
            json_object('id', id, 'name', name, 'slug', slug,
                        'description', description, 'displayOrder', display_order,
                        'enabled', CASE WHEN enabled = 1 THEN json('true') ELSE json('false') END),
            ?, ?, ?, ?, 'success', NULL, ?
     FROM review_projects
     WHERE id = ? AND enabled = ? AND updated_at = ? AND changes() = 1`,
  ).bind(
    user.userId,
    user.email,
    user.displayName,
    action,
    createdAt,
    projectId,
    enabled,
    createdAt,
  );
}

function currentProjectSetGuard(projectIds: number[]): {
  sql: string;
  values: SqlValue[];
} {
  const projectIdsJson = JSON.stringify(projectIds);
  return {
    sql: `(SELECT COUNT(*) FROM review_projects) = json_array_length(?)
          AND NOT EXISTS (
            SELECT 1 FROM review_projects
            WHERE id NOT IN (SELECT CAST(value AS INTEGER) FROM json_each(?))
          )`,
    values: [projectIdsJson, projectIdsJson],
  };
}

async function writeAudit(user: ChatGPTUser, input: AuditInput): Promise<void> {
  const project = input.project ?? null;
  await db().prepare(
    `INSERT INTO project_admin_audits
       (project_id_snapshot, project_slug_snapshot, project_name_snapshot,
        project_snapshot_json, admin_user_id, admin_email_snapshot,
        admin_display_name_snapshot, action, result, failure_code, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).bind(
    typeof project?.id === 'number' ? project.id : null,
    typeof project?.slug === 'string' ? project.slug : null,
    typeof project?.name === 'string' ? project.name : null,
    JSON.stringify(input.snapshot),
    user.userId,
    user.email,
    user.displayName,
    input.action,
    input.result,
    input.failureCode ?? null,
    new Date().toISOString(),
  ).run();
}
