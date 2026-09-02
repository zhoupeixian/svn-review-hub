import { env } from 'cloudflare:workers';
import type { ChatGPTUser } from '@/app/chatgpt-auth';
import { ensureReviewSchema } from '@/lib/reviews';

type RuntimeEnv = { DB: D1Database };
type SqlValue = string | number | null;

export const PROJECT_ADMIN_ACTIONS = [
  'project.create',
  'project.update',
  'project.reorder',
] as const;

export type ProjectAdminAction = (typeof PROJECT_ADMIN_ACTIONS)[number];

export type AdminProject = {
  id: number;
  name: string;
  slug: string;
  description: string;
  displayOrder: number;
  enabled: boolean;
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

type StoredProject = Omit<AdminProject, 'enabled'> & { enabled: number };

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

function adminProject(row: StoredProject): AdminProject {
  return { ...row, enabled: row.enabled === 1 };
}

function projectSelect(): string {
  return `SELECT id, name, slug, description, display_order AS displayOrder,
                 enabled, created_at AS createdAt, updated_at AS updatedAt
          FROM review_projects`;
}

async function firstProject(statement: string, values: SqlValue[] = []): Promise<AdminProject | null> {
  const row = await db().prepare(statement).bind(...values).first<StoredProject>();
  return row ? adminProject(row) : null;
}

export async function listAdminProjects(): Promise<AdminProject[]> {
  await ensureReviewSchema();
  const result = await db().prepare(
    `${projectSelect()} ORDER BY display_order, name COLLATE NOCASE, id`,
  ).all<StoredProject>();
  return (result.results ?? []).map(adminProject);
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

  const now = new Date().toISOString();
  try {
    await db().batch([
      db().prepare(
        `INSERT INTO review_projects
           (name, slug, description, display_order, enabled, created_at, updated_at)
         VALUES (?, ?, ?, ?, 1, ?, ?)`,
      ).bind(
        candidate.name,
        candidate.slug,
        candidate.description,
        candidate.displayOrder,
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

export async function reorderAdminProjects(
  user: ChatGPTUser,
  input: unknown,
): Promise<AdminProject[]> {
  await ensureReviewSchema();
  let projectIds: number[];
  try {
    projectIds = parseProjectOrder(input);
    const projects = await listAdminProjects();
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
      snapshot: projectOrderCandidate(input),
      action: 'project.reorder',
      result: 'failure',
      failureCode: businessError.code,
    });
    throw businessError;
  }

  const now = new Date().toISOString();
  const statements: D1PreparedStatement[] = [];
  projectIds.forEach((projectId, index) => {
    statements.push(
      db().prepare(
        'UPDATE review_projects SET display_order = ?, updated_at = ? WHERE id = ?',
      ).bind(index * 10, now, projectId),
      auditProjectIdSelectStatement(user, 'project.reorder', now, projectId),
    );
  });
  await db().batch(statements);
  return listAdminProjects();
}

export async function listProjectAdminAudits(
  url: URL,
): Promise<ProjectAdminAudit[]> {
  await ensureReviewSchema();
  const conditions: string[] = [];
  const values: SqlValue[] = [];
  const projectSlug = url.searchParams.get('projectSlug')?.trim() ?? '';
  const adminUserId = url.searchParams.get('adminUserId')?.trim() ?? '';
  const action = url.searchParams.get('action')?.trim() ?? '';

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
     LIMIT 200`,
  ).bind(...values).all<ProjectAdminAudit>();
  return result.results ?? [];
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
  if (ids.some((id) => !Number.isInteger(id) || id <= 0)) {
    throw new ProjectAdminError('项目排序中存在无效 ID。', 'invalid_project_id', 400);
  }
  if (new Set(ids).size !== ids.length) {
    throw new ProjectAdminError('项目排序不能包含重复项目。', 'duplicate_project_id', 400);
  }
  return ids;
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
  if (!Number.isInteger(number) || number < 0) {
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

function projectOrderCandidate(input: unknown): unknown {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return {};
  return { projectIds: (input as Record<string, unknown>).projectIds };
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

function auditProjectIdSelectStatement(
  user: ChatGPTUser,
  action: ProjectAdminAction,
  createdAt: string,
  projectId: number,
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
     FROM review_projects WHERE id = ?`,
  ).bind(user.userId, user.email, user.displayName, action, createdAt, projectId);
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
