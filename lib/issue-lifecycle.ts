export const ISSUE_STATUSES = [
  'open',
  'pending_review',
  'resolved',
  'invalid',
  'by_design',
  'deferred',
] as const;

export type IssueStatus = (typeof ISSUE_STATUSES)[number];

export const ISSUE_STATUS_LABELS: Record<IssueStatus, string> = {
  open: '待处理',
  pending_review: '待复核',
  resolved: '已解决',
  invalid: '无效问题',
  by_design: '符合设计',
  deferred: '延期处理',
};

export type IssueUpdateInput = {
  status: IssueStatus;
  note: string;
  version: number;
};

export function parseIssueUpdateInput(input: unknown): IssueUpdateInput {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    throw new Error('问题更新参数无效');
  }

  const { status, note, version } = input as Record<string, unknown>;
  if (typeof status !== 'string' || !status.trim()) {
    throw new Error('问题状态不能为空');
  }
  if (!ISSUE_STATUSES.includes(status as IssueStatus)) {
    throw new Error('不支持的问题状态');
  }
  if (typeof version !== 'number' || !Number.isInteger(version) || version < 0) {
    throw new Error('版本号必须为非负整数');
  }
  if (typeof note !== 'string') {
    throw new Error('问题说明必须为字符串');
  }

  const normalizedNote = note.trim();
  if (normalizedNote.length > 1000) {
    throw new Error('问题说明不能超过1000个字符');
  }

  return { status: status as IssueStatus, note: normalizedNote, version };
}

export function normalizeIssueKey(issueKey: string): string {
  return issueKey.trim().replace(/\s+/g, '-').toLowerCase();
}
