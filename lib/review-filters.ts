import { ISSUE_STATUSES } from '@/lib/issue-lifecycle';

export function parseReviewFilters(url: URL) {
  const statuses = url.searchParams.getAll('status').filter(Boolean);
  const status = url.searchParams.get('status') || undefined;
  if (statuses.some((value) => !ISSUE_STATUSES.includes(value as (typeof ISSUE_STATUSES)[number]))) {
    throw new Error('问题状态无效。');
  }
  const severities = [...new Set(url.searchParams.getAll('severity').filter(Boolean))];
  if (severities.some((severity) => !['P1', 'P2', 'P3'].includes(severity))) {
    throw new Error('问题等级无效。');
  }
  const revisionValue = url.searchParams.get('revision');
  const parsedRevision = revisionValue ? Number(revisionValue) : undefined;
  if (revisionValue && (parsedRevision === undefined || !Number.isInteger(parsedRevision) || parsedRevision < 0)) {
    throw new Error('Revision 无效。');
  }
  const scope = url.searchParams.get('scope') || undefined;
  if (scope && scope !== 'active' && scope !== 'archived') {
    throw new Error('审查范围无效。');
  }
  const limitValue = url.searchParams.get('limit');
  const parsedLimit = limitValue ? Number(limitValue) : undefined;
  if (limitValue && (parsedLimit === undefined || !Number.isInteger(parsedLimit) || parsedLimit <= 0)) {
    throw new Error('分页大小无效。');
  }
  return {
    scope: scope as 'active' | 'archived' | undefined,
    fromDate: url.searchParams.get('fromDate') || undefined,
    toDate: url.searchParams.get('toDate') || undefined,
    author: url.searchParams.get('author') || undefined,
    revision: parsedRevision,
    severity: severities.length === 1 ? severities[0] as 'P1' | 'P2' | 'P3' : undefined,
    severities: severities.length > 1 ? severities as ('P1' | 'P2' | 'P3')[] : undefined,
    status: status as (typeof ISSUE_STATUSES)[number] | undefined,
    statuses: statuses.length > 1 ? statuses as (typeof ISSUE_STATUSES)[number][] : undefined,
    keyword: url.searchParams.get('keyword') || undefined,
    cursor: url.searchParams.get('cursor') || undefined,
    limit: parsedLimit,
  };
}
