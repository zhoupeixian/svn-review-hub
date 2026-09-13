export type ParsedRevision = {
  revision: number;
  author: string;
  committedAt: string;
  description: string;
  conclusion: string;
};

export type ParsedIssue = {
  severity: 'P1' | 'P2' | 'P3';
  title: string;
  relatedRevisions: string;
  legacyRelatedRevisions?: string;
  detail: string;
};

export type ParsedReview = {
  logDate: string;
  title: string;
  overview: string;
  scopeText: string;
  revisionCount: number;
  reviewedCount: number;
  skippedCount: number;
  p1Count: number;
  p2Count: number;
  p3Count: number;
  revisionTableMode: 'reviewed-only' | 'complete' | 'missing';
  revisions: ParsedRevision[];
  issues: ParsedIssue[];
};

export function parseReviewMarkdown(markdown: string): ParsedReview {
  const lines = markdown.replace(/\r\n/g, '\n').split('\n');
  const title =
    lines.find((line) => line.startsWith('# '))?.replace(/^#\s+/, '').trim() ??
    'SVN 提交审查日志';
  const logDate =
    lineValue(lines, '日期：').match(/\d{4}-\d{2}-\d{2}/)?.[0] ??
    '';
  const scopeText =
    firstParagraphFromLabel(lines, '审查范围：') ||
    firstParagraphAfterHeading(lines, '审查范围与执行边界');
  const overview = lineValue(lines, '总体结论：');
  const revisionTable = parseRevisionTable(lines);
  const scopeCounts = reconcileReviewCounts(
    parseReviewScopeCountsWithEvidence(scopeText),
    revisionTable,
  );
  const issues = parseIssues(markdown);

  return {
    logDate,
    title,
    overview,
    scopeText,
    ...scopeCounts,
    p1Count: issues.filter((issue) => issue.severity === 'P1').length,
    p2Count: issues.filter((issue) => issue.severity === 'P2').length,
    p3Count: issues.filter((issue) => issue.severity === 'P3').length,
    revisionTableMode: scopeCounts.revisionTableMode,
    revisions: revisionTable.revisions,
    issues,
  };
}

function firstParagraphAfterHeading(lines: string[], heading: string): string {
  const headingIndex = lines.findIndex(
    (line) => line.replace(/^#+\s*/, '').trim() === heading,
  );
  if (headingIndex < 0) return '';

  return collectParagraph(lines, headingIndex + 1);
}

function firstParagraphFromLabel(lines: string[], label: string): string {
  const labelIndex = lines.findIndex((line) => line.startsWith(label));
  if (labelIndex < 0) return '';

  const firstLine = lines[labelIndex].slice(label.length).trim();
  return collectParagraph(
    lines,
    labelIndex + 1,
    firstLine ? [firstLine] : [],
  );
}

function collectParagraph(
  lines: string[],
  startIndex: number,
  paragraph: string[] = [],
): string {
  for (const line of lines.slice(startIndex)) {
    const trimmed = line.trim();
    if (!trimmed) {
      if (paragraph.length) break;
      continue;
    }
    if (trimmed.startsWith('#')) break;
    if (paragraph.length && isTopLevelMetadataLine(trimmed)) break;
    paragraph.push(trimmed);
  }
  return paragraph.join(' ');
}

const topLevelMetadataLabels = [
  '日期：',
  '审查范围：',
  '运行批次：',
  '工作副本：',
  '总体结论：',
];

function isTopLevelMetadataLine(line: string): boolean {
  return topLevelMetadataLabels.some((label) => line.startsWith(label));
}

function lineValue(lines: string[], label: string): string {
  return lines.find((line) => line.startsWith(label))?.slice(label.length).trim() ?? '';
}

function countFrom(value: string, pattern: RegExp): number | null {
  const match = value.match(pattern);
  if (!match) return null;
  return Number(match.slice(1).find((group) => group !== undefined) ?? 0);
}

function countFromClauses(clauses: string[], patterns: RegExp[]): number | null {
  for (const pattern of patterns) {
    for (const clause of clauses) {
      const count = countFrom(clause, pattern);
      if (count !== null) return count;
    }
  }
  return null;
}

const revisionCountPatterns = [
  /共\s*(?:发现\s*)?(\d+)\s*个\s*(?:revision|提交)/i,
];

function reviewScopeClauses(scopeText: string): string[] {
  return scopeText
    .replace(/\s+/g, ' ')
    .split(/[，,；;。、]+/)
    .map((clause) => clause.trim())
    .filter(Boolean);
}

export function reviewScopeDeclaresZeroRevisions(scopeText: string): boolean {
  if (/无新增\s*(?:revision|提交)/i.test(scopeText)) return true;
  return countFromClauses(
    reviewScopeClauses(scopeText),
    revisionCountPatterns,
  ) === 0;
}

export function parseReviewScopeCounts(scopeText: string): Pick<ParsedReview, 'revisionCount' | 'reviewedCount' | 'skippedCount'> {
  const counts = parseReviewScopeCountsWithEvidence(scopeText);
  return {
    revisionCount: counts.revisionCount,
    reviewedCount: counts.reviewedCount,
    skippedCount: counts.skippedCount,
  };
}

type ParsedScopeCounts = Pick<ParsedReview, 'revisionCount' | 'reviewedCount' | 'skippedCount'> & {
  reviewedCountDeclared: boolean;
  skippedCountDeclared: boolean;
};

function parseReviewScopeCountsWithEvidence(scopeText: string): ParsedScopeCounts {
  const clauses = reviewScopeClauses(scopeText);
  const parsedRevisionCount = countFromClauses(clauses, revisionCountPatterns);
  const parsedReviewedCount = countFromClauses(clauses, [
    /实际\s*审查\s*(\d+)\s*个/i,
    /(\d+)\s*个\s*(?:均\s*)?可\s*审查(?:\s*revision)?/i,
    /reviewable\s*(?:为\s*)?(\d+)\s*个/i,
    /(?:共\s*)?(\d+)\s*个\s*(?:待\s*审查|需要\s*审查的?)\s*revision/i,
    /(\d+)\s*个\s*(?:revision\s*)?进入\s*(?:代码\s*)?审查/i,
  ]);
  const parsedSkippedCount = countFromClauses(clauses, [
    /跳过\s*(\d+)\s*个/i,
    /(\d+)\s*个\s*(?:(?:revision|提交)\s*)?(?:按\s*(?:默认\s*)?规则\s*跳过|命中\s*(?:默认\s*)?跳过\s*规则|跳过)/i,
  ]);
  const revisionCount =
    parsedRevisionCount ??
    (parsedReviewedCount !== null && parsedSkippedCount !== null
      ? parsedReviewedCount + parsedSkippedCount
      : 0);

  return {
    revisionCount,
    reviewedCount:
      parsedReviewedCount ??
      (parsedSkippedCount !== null && revisionCount >= parsedSkippedCount
        ? revisionCount - parsedSkippedCount
        : 0),
    skippedCount:
      parsedSkippedCount ??
      (parsedReviewedCount !== null && revisionCount >= parsedReviewedCount
        ? revisionCount - parsedReviewedCount
        : 0),
    reviewedCountDeclared: parsedReviewedCount !== null,
    skippedCountDeclared: parsedSkippedCount !== null,
  };
}

function reconcileReviewCounts(
  counts: ParsedScopeCounts,
  table: ParsedRevisionTable,
): Pick<ParsedReview, 'revisionCount' | 'reviewedCount' | 'skippedCount' | 'revisionTableMode'> {
  const rowCount = table.revisions.length;
  if (rowCount > 0 && counts.revisionCount > 0 && rowCount === counts.revisionCount) {
    if (!counts.reviewedCountDeclared && !counts.skippedCountDeclared) {
      const skippedCount = table.revisions.filter((revision) =>
        /跳过/.test(revision.conclusion),
      ).length;
      return {
        revisionCount: counts.revisionCount,
        reviewedCount: counts.revisionCount - skippedCount,
        skippedCount,
        revisionTableMode: 'complete',
      };
    }
    return publicCounts(counts, 'complete');
  }
  if (rowCount > 0 && counts.reviewedCount > 0 && rowCount === counts.reviewedCount) {
    return publicCounts(counts, 'reviewed-only');
  }
  if (table.mode !== 'reviewed-only' || rowCount === 0) {
    return publicCounts(counts, table.mode);
  }

  if (counts.revisionCount === 0) {
    return {
      revisionCount: rowCount,
      reviewedCount: rowCount,
      skippedCount: 0,
      revisionTableMode: 'reviewed-only',
    };
  }
  if (!counts.reviewedCountDeclared && !counts.skippedCountDeclared) {
    return {
      revisionCount: counts.revisionCount,
      reviewedCount: rowCount,
      skippedCount: Math.max(0, counts.revisionCount - rowCount),
      revisionTableMode: 'reviewed-only',
    };
  }
  return publicCounts(counts, table.mode);
}

function publicCounts(
  counts: ParsedScopeCounts,
  revisionTableMode: ParsedReview['revisionTableMode'],
): Pick<ParsedReview, 'revisionCount' | 'reviewedCount' | 'skippedCount' | 'revisionTableMode'> {
  return {
    revisionCount: counts.revisionCount,
    reviewedCount: counts.reviewedCount,
    skippedCount: counts.skippedCount,
    revisionTableMode,
  };
}

type ParsedRevisionTable = {
  mode: ParsedReview['revisionTableMode'];
  revisions: ParsedRevision[];
};

function parseRevisionTable(lines: string[]): ParsedRevisionTable {
  const revisions: ParsedRevision[] = [];
  let mode: ParsedRevisionTable['mode'] = 'missing';

  for (let index = 0; index < lines.length; index += 1) {
    const headers = tableCells(lines[index]);
    const revisionIndex = headers.findIndex((cell) => /^revision$/i.test(cell));
    if (revisionIndex < 0) continue;

    const authorIndex = headers.findIndex((cell) => /^(?:提交人|作者)$/.test(cell));
    const committedAtIndex = headers.findIndex((cell) => /^提交时间(?:\s*\([^)]*\))?$/.test(cell));
    const descriptionIndex = headers.findIndex((cell) => /^(?:提交说明|说明)$/.test(cell));
    const conclusionIndex = headers.findIndex((cell) => /^(?:审查结论|结论|结果)$/.test(cell));
    if (authorIndex < 0 || descriptionIndex < 0 || conclusionIndex < 0) continue;
    mode = committedAtIndex >= 0 ? 'reviewed-only' : 'complete';

    for (let rowIndex = index + 2; rowIndex < lines.length; rowIndex += 1) {
      const cells = tableCells(lines[rowIndex]);
      if (!cells.length) break;
      if (
        [revisionIndex, authorIndex, descriptionIndex, conclusionIndex].some(
          (requiredIndex) => requiredIndex >= cells.length,
        )
      ) {
        continue;
      }
      const revisionMatch = cells[revisionIndex]?.match(/^r?(\d+)$/i);
      if (!revisionMatch) continue;

      revisions.push({
        revision: Number(revisionMatch[1]),
        author: cells[authorIndex] ?? '',
        committedAt:
          committedAtIndex >= 0 ? cells[committedAtIndex] ?? '' : '',
        description: cells[descriptionIndex] ?? '',
        conclusion: cells[conclusionIndex] ?? '',
      });
    }
  }

  return { mode, revisions };
}

function tableCells(line: string): string[] {
  const trimmed = line.trim();
  if (!trimmed.includes('|')) return [];

  const cells: string[] = [];
  let cell = '';
  for (const character of trimmed) {
    if (character !== '|') {
      cell += character;
      continue;
    }

    let backslashCount = 0;
    for (let index = cell.length - 1; cell[index] === '\\'; index -= 1) {
      backslashCount += 1;
    }
    if (backslashCount % 2 === 1) {
      cell = `${cell.slice(0, -1)}|`;
      continue;
    }

    cells.push(cell.trim());
    cell = '';
  }
  cells.push(cell.trim());
  if (cells[0] === '') cells.shift();
  if (cells.at(-1) === '') cells.pop();
  return cells;
}

type IssueSection = {
  severity: ParsedIssue['severity'];
  inlineTitle?: string;
  index: number;
  length: number;
};

function findIssueSections(markdown: string): IssueSection[] {
  const sections: IssueSection[] = [];
  let lineStart = 0;

  while (lineStart <= markdown.length) {
    const newlineIndex = markdown.indexOf('\n', lineStart);
    const lineEnd = newlineIndex >= 0 ? newlineIndex : markdown.length;
    const rawLine = markdown.slice(lineStart, lineEnd);
    const heading = parseIssueSectionHeading(rawLine);
    if (heading) {
      sections.push({
        ...heading,
        index: lineStart,
        length: rawLine.length,
      });
    }
    if (newlineIndex < 0) break;
    lineStart = newlineIndex + 1;
  }

  return sections;
}

function parseIssueSectionHeading(
  rawLine: string,
): Pick<IssueSection, 'severity' | 'inlineTitle'> | null {
  const line = rawLine.endsWith('\r') ? rawLine.slice(0, -1) : rawLine;
  if (!line.startsWith('###')) return null;

  let cursor = 3;
  if (cursor >= line.length || !isLineWhitespace(line[cursor])) return null;
  while (cursor < line.length && isLineWhitespace(line[cursor])) cursor += 1;

  if (
    cursor + 1 >= line.length ||
    line[cursor].toUpperCase() !== 'P' ||
    !'123'.includes(line[cursor + 1])
  ) {
    return null;
  }
  const severity = `P${line[cursor + 1]}` as ParsedIssue['severity'];
  cursor += 2;

  while (cursor < line.length && isLineWhitespace(line[cursor])) cursor += 1;
  if (cursor === line.length) return { severity };

  if (line[cursor] !== ':' && line[cursor] !== '：') return null;
  cursor += 1;
  if (cursor === line.length) return null;

  const inlineTitle = line.slice(cursor).trim();
  return inlineTitle ? { severity, inlineTitle } : { severity };
}

function isLineWhitespace(character: string): boolean {
  return character.trim() === '';
}

function parseIssues(markdown: string): ParsedIssue[] {
  const sections = findIssueSections(markdown);
  const issues: ParsedIssue[] = [];

  for (let index = 0; index < sections.length; index += 1) {
    const section = sections[index];
    const severity = section.severity;
    const start = section.index + section.length;
    const nextSectionStart =
      index + 1 < sections.length
        ? sections[index + 1].index
        : markdown.length;
    const nextHeadingOffset = markdown
      .slice(start, nextSectionStart)
      .search(/^##\s+/m);
    const nextStart =
      nextHeadingOffset >= 0 ? start + nextHeadingOffset : nextSectionStart;
    const body = markdown.slice(start, nextStart);
    const inlineTitle = section.inlineTitle;
    const entries = inlineTitle
      ? [`${inlineTitle}\n${body}`]
      : body.split(/^####\s+/m).slice(1);

    for (const entry of entries) {
      const [titleLine = '', ...detailLines] = entry.split('\n');
      const detail = detailLines.join('\n').trim();
      const explicitRevisions = normalizeRelatedRevisions(
        detail.match(
          /相关[ \t]+revision[：:][ \t]*((?:`?r?\d+`?)(?:(?:[ \t]*[、，,/][ \t]*|[ \t]+)`?r?\d+`?)*)/i,
        )?.[1] ?? '',
      );
      const legacyExplicitRevisions = normalizeRelatedRevisions(
        detail.match(/相关 revision：\s*([0-9、，,\s]+)/i)?.[1] ?? '',
      );
      const titleRevisions = normalizeTitleRevisions(titleLine);
      const revisions = explicitRevisions || titleRevisions;

      if (titleLine.trim()) {
        issues.push({
          severity,
          title: titleLine.trim(),
          relatedRevisions: revisions,
          legacyRelatedRevisions: explicitRevisions
            ? legacyExplicitRevisions
            : titleRevisions
              ? ''
              : undefined,
          detail,
        });
      }
    }
  }

  return issues;
}

function normalizeTitleRevisions(title: string): string {
  return normalizeRelatedRevisions(
    [...title.matchAll(/\br(\d+)\b/gi)]
      .map((match) => match[1])
      .join('、'),
  );
}

export function normalizeRelatedRevisions(value: string): string {
  const revisions = [...new Set(value.match(/\d+/g) ?? [])];
  return revisions
    .sort((left, right) => Number(left) - Number(right))
    .join('、');
}
