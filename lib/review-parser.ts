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

const INTEGER_PATTERN = /\d+/;

export function parseReviewMarkdown(markdown: string): ParsedReview {
  const lines = markdown.replace(/\r\n/g, '\n').split('\n');
  const title =
    lines.find((line) => line.startsWith('# '))?.replace(/^#\s+/, '').trim() ??
    'ZHERP SVN 提交审查日志';
  const logDate =
    lineValue(lines, '日期：').match(/\d{4}-\d{2}-\d{2}/)?.[0] ??
    '';
  const scopeText = lineValue(lines, '审查范围：');
  const overview = lineValue(lines, '总体结论：');

  return {
    logDate,
    title,
    overview,
    scopeText,
    revisionCount: countFrom(scopeText, /共\s*(\d+)\s*个\s*revision/i),
    reviewedCount:
      countFrom(scopeText, /实际审查\s*(\d+)\s*个/i) ||
      countFrom(scopeText, /(\d+)\s*个\s*可审查/i),
    skippedCount: countFrom(
      scopeText,
      /跳过\s*(\d+)\s*个|(\d+)\s*个[^，。]*跳过/i,
    ),
    p1Count: countSeverity(markdown, 'P1'),
    p2Count: countSeverity(markdown, 'P2'),
    p3Count: countSeverity(markdown, 'P3'),
    revisions: parseRevisionTable(lines),
    issues: parseIssues(markdown),
  };
}

function lineValue(lines: string[], label: string): string {
  return lines.find((line) => line.startsWith(label))?.slice(label.length).trim() ?? '';
}

function countFrom(value: string, pattern: RegExp): number {
  return Number(value.match(pattern)?.slice(1).find(Boolean) ?? 0);
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

  for (const line of lines) {
    if (!line.startsWith('|')) continue;
    const cells = line
      .split('|')
      .slice(1, -1)
      .map((cell) => cell.trim());

    if (
      cells.length < 5 ||
      !INTEGER_PATTERN.test(cells[0]) ||
      !/^\d+$/.test(cells[0])
    ) {
      continue;
    }

    revisions.push({
      revision: Number(cells[0]),
      author: cells[1],
      committedAt: cells[2],
      description: cells[3],
      conclusion: cells[4],
    });
  }

  return revisions;
}

function parseIssues(markdown: string): ParsedIssue[] {
  const sections = [...markdown.matchAll(/^###\s+(P[123])\s*$/gim)];
  const issues: ParsedIssue[] = [];

  for (let index = 0; index < sections.length; index += 1) {
    const section = sections[index];
    const severity = section[1].toUpperCase() as ParsedIssue['severity'];
    const start = (section.index ?? 0) + section[0].length;
    const nextStart =
      index + 1 < sections.length
        ? sections[index + 1].index ?? markdown.length
        : markdown.length;
    const body = markdown.slice(start, nextStart);
    const entries = body.split(/^####\s+/m).slice(1);

    for (const entry of entries) {
      const [titleLine = '', ...detailLines] = entry.split('\n');
      const detail = detailLines.join('\n').trim();
      const revisions = normalizeRelatedRevisions(
        detail.match(/相关 revision：\s*([0-9、，,\s]+)/i)?.[1] ?? '',
      );

      if (titleLine.trim()) {
        issues.push({
          severity,
          title: titleLine.trim(),
          relatedRevisions: revisions,
          detail,
        });
      }
    }
  }

  return issues;
}

export function normalizeRelatedRevisions(value: string): string {
  const revisions = [...new Set(value.match(/\d+/g) ?? [])];
  return revisions
    .sort((left, right) => Number(left) - Number(right))
    .join('、');
}
