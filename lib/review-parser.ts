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
  relatedRevisionSource?: 'explicit' | 'title';
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
  revisions: ParsedRevision[];
  issues: ParsedIssue[];
};

export function parseReviewMarkdown(markdown: string): ParsedReview {
  const lines = markdown.replace(/\r\n/g, '\n').split('\n');
  const title =
    lines.find((line) => line.startsWith('# '))?.replace(/^#\s+/, '').trim() ??
    'ZHERP SVN 提交审查日志';
  const logDate =
    lineValue(lines, '日期：').match(/\d{4}-\d{2}-\d{2}/)?.[0] ??
    '';
  const scopeText =
    firstParagraphFromLabel(lines, '审查范围：') ||
    firstParagraphAfterHeading(lines, '审查范围与执行边界');
  const overview = lineValue(lines, '总体结论：');

  return {
    logDate,
    title,
    overview,
    scopeText,
    ...parseReviewScopeCounts(scopeText),
    p1Count: countSeverity(markdown, 'P1'),
    p2Count: countSeverity(markdown, 'P2'),
    p3Count: countSeverity(markdown, 'P3'),
    revisions: parseRevisionTable(lines),
    issues: parseIssues(markdown),
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
    paragraph.push(trimmed);
  }
  return paragraph.join(' ');
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
  return countFromClauses(
    reviewScopeClauses(scopeText),
    revisionCountPatterns,
  ) === 0;
}

export function parseReviewScopeCounts(scopeText: string): Pick<ParsedReview, 'revisionCount' | 'reviewedCount' | 'skippedCount'> {
  const clauses = reviewScopeClauses(scopeText);
  const revisionCount = countFromClauses(clauses, revisionCountPatterns) ?? 0;
  const parsedReviewedCount = countFromClauses(clauses, [
    /实际\s*审查\s*(\d+)\s*个/i,
    /(\d+)\s*个\s*(?:均\s*)?可\s*审查(?:\s*revision)?/i,
    /(\d+)\s*个\s*进入\s*(?:代码\s*)?审查/i,
  ]);
  const parsedSkippedCount = countFromClauses(clauses, [
    /跳过\s*(\d+)\s*个/i,
    /(\d+)\s*个\s*(?:按\s*(?:默认\s*)?规则\s*跳过|命中\s*(?:默认\s*)?跳过\s*规则|跳过)/i,
  ]);

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
  };
}

function countSeverity(markdown: string, severity: 'P1' | 'P2' | 'P3'): number {
  const pattern = new RegExp(
    '(?:保留\\s*)?(\\d+)\\s*个\\s*' + severity,
    'i',
  );
  return Number(markdown.match(pattern)?.[1] ?? 0);
}

function parseRevisionTable(lines: string[]): ParsedRevision[] {
  const revisions: ParsedRevision[] = [];

  for (let index = 0; index < lines.length; index += 1) {
    const headers = tableCells(lines[index]);
    const revisionIndex = headers.findIndex((cell) => /^revision$/i.test(cell));
    if (revisionIndex < 0) continue;

    const authorIndex = headers.findIndex((cell) => /^(?:提交人|作者)$/.test(cell));
    const committedAtIndex = headers.findIndex((cell) => cell === '提交时间');
    const descriptionIndex = headers.findIndex((cell) => /^(?:提交说明|说明)$/.test(cell));
    const conclusionIndex = headers.findIndex((cell) => /^(?:审查结论|结论|结果)$/.test(cell));
    if (authorIndex < 0 || descriptionIndex < 0 || conclusionIndex < 0) continue;

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

  return revisions;
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

function parseIssues(markdown: string): ParsedIssue[] {
  const sections = [
    ...markdown.matchAll(/^###\s+(P[123])(?:\s*[：:]\s*(.+?))?\s*$/gim),
  ];
  const issues: ParsedIssue[] = [];

  for (let index = 0; index < sections.length; index += 1) {
    const section = sections[index];
    const severity = section[1].toUpperCase() as ParsedIssue['severity'];
    const start = (section.index ?? 0) + section[0].length;
    const nextSectionStart =
      index + 1 < sections.length
        ? sections[index + 1].index ?? markdown.length
        : markdown.length;
    const nextHeadingOffset = markdown
      .slice(start, nextSectionStart)
      .search(/^##\s+/m);
    const nextStart =
      nextHeadingOffset >= 0 ? start + nextHeadingOffset : nextSectionStart;
    const body = markdown.slice(start, nextStart);
    const inlineTitle = section[2]?.trim();
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
      const titleRevisions = normalizeTitleRevisions(titleLine);
      const revisions = explicitRevisions || titleRevisions;

      if (titleLine.trim()) {
        issues.push({
          severity,
          title: titleLine.trim(),
          relatedRevisions: revisions,
          relatedRevisionSource: explicitRevisions
            ? 'explicit'
            : titleRevisions
              ? 'title'
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
