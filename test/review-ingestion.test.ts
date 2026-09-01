/// <reference types="@cloudflare/vitest-plugin/types" />

import { env } from 'cloudflare:workers';
import { beforeEach, describe, expect, it } from 'vitest';
import {
  getIssuePage,
  ingestReview,
} from '@/lib/reviews';
import { parseReviewMarkdown } from '@/lib/review-parser';

type TestEnv = {
  DB: D1Database;
  FILES: R2Bucket;
};

type IssueRow = {
  id: number;
  issueKey: string;
  severity: string;
  title: string;
  relatedRevisions: string;
  detail: string;
  status: string;
  statusNote: string | null;
  statusUpdatedAt: string | null;
  sourceCurrent: number;
  version: number;
};

const runtime = env as unknown as TestEnv;
const { DB, FILES } = runtime;
const SOURCE_KEY = '2026-08-27/svn审查日志-2026-08-27.md';

describe('审查日志合并导入', () => {
  it('识别可审查和按规则跳过的审查范围文案', () => {
    expect(parseReviewMarkdown([
      '# 上传日志',
      '日期：2026-08-27',
      '审查范围：共 24 个 revision，其中 22 个可审查，2 个按默认规则跳过',
    ].join('\n'))).toMatchObject({
      revisionCount: 24,
      reviewedCount: 22,
      skippedCount: 2,
    });
  });

  it('识别进入代码审查和命中默认跳过规则的文案', () => {
    expect(parseReviewMarkdown([
      '# 上传日志',
      '日期：2026-08-20',
      '审查范围：共发现 22 个 revision，其中 17 个进入代码审查，5 个命中默认跳过规则。',
    ].join('\n'))).toMatchObject({
      revisionCount: 22,
      reviewedCount: 17,
      skippedCount: 5,
    });
  });

  it('识别 ASCII 标点分隔的审查和跳过计数', () => {
    expect(parseReviewMarkdown([
      '# 上传日志',
      '日期：2026-08-30',
      '审查范围：共 5 个 revision, 实际审查 4 个, 跳过 1 个',
    ].join('\n'))).toMatchObject({
      revisionCount: 5,
      reviewedCount: 4,
      skippedCount: 1,
    });
  });

  it.each([
    ['个后空格', '共 5 个 revision，其中 3 个 可审查', 3, 2],
    ['均可审查空格', '共 5 个 revision，其中 3 个 均 可审查', 3, 2],
    ['进入审查空格', '共 5 个 revision，其中 3 个 进入审查', 3, 2],
    ['进入代码审查空格', '共 5 个 revision，其中 3 个 进入 代码审查', 3, 2],
    ['中文逗号', '共 5 个 revision，其中 3 个可审查，2 个按规则跳过', 3, 2],
    ['ASCII 逗号', '共 5 个 revision, 其中 3 个可审查, 2 个按规则跳过', 3, 2],
    ['中文分号', '共 5 个 revision；其中 3 个可审查；2 个按规则跳过', 3, 2],
    ['ASCII 分号', '共 5 个 revision; 其中 3 个可审查; 2 个按规则跳过', 3, 2],
    ['中文句号', '共 5 个 revision。其中 3 个可审查。2 个按规则跳过', 3, 2],
    ['顿号', '共 5 个 revision，其中 3 个可审查、2 个按规则跳过', 3, 2],
    ['明确跳过', '共 5 个 revision，其中 3 个可审查，跳过 2 个', 3, 2],
    ['默认规则跳过', '共 5 个 revision，其中 3 个可审查，2 个按默认规则跳过', 3, 2],
    ['命中跳过规则', '共 5 个 revision，其中 3 个可审查，2 个命中默认跳过规则', 3, 2],
  ])('稳定解析审查范围计数：%s', (_name, scope, reviewedCount, skippedCount) => {
    expect(parseReviewMarkdown([
      '# 上传日志',
      '日期：2026-08-30',
      `审查范围：${scope}`,
    ].join('\n'))).toMatchObject({
      revisionCount: 5,
      reviewedCount,
      skippedCount,
    });
  });

  it('交叉验证所有支持的计数措辞和分隔符', () => {
    const totalPhrases = [
      '共 5 个 revision',
      '共发现 5 个 revision',
      '共 5 个提交',
    ];
    const reviewedPhrases = [
      '实际审查 3 个',
      '3 个可审查',
      '3 个 均 可审查',
      '3 个 进入审查',
      '3 个 进入 代码审查',
    ];
    const skippedPhrases = [
      '跳过 2 个',
      '2 个跳过',
      '2 个按规则跳过',
      '2 个按 默认 规则 跳过',
      '2 个命中跳过规则',
      '2 个命中 默认 跳过 规则',
    ];
    const separators = ['，', ',', '；', ';', '。', '、'];

    for (const total of totalPhrases) {
      for (const reviewed of reviewedPhrases) {
        for (const skipped of skippedPhrases) {
          for (const separator of separators) {
            const scope = `${total}${separator}其中 ${reviewed}${separator}${skipped}`;
            expect(
              parseReviewMarkdown([
                '# 上传日志',
                '日期：2026-08-30',
                `审查范围：${scope}`,
              ].join('\n')),
              scope,
            ).toMatchObject({
              revisionCount: 5,
              reviewedCount: 3,
              skippedCount: 2,
            });
          }
        }
      }
    }
  });

  it('审查范围换行后仍按同一语义解析计数', () => {
    expect(parseReviewMarkdown([
      '# 上传日志',
      '日期：2026-08-30',
      '审查范围：共 5 个 revision，其中 3 个',
      '可审查、2 个按规则跳过',
    ].join('\n'))).toMatchObject({
      revisionCount: 5,
      reviewedCount: 3,
      skippedCount: 2,
    });
  });

  it('审查范围在语义词之间换行时仍能解析计数', () => {
    expect(parseReviewMarkdown([
      '# 上传日志',
      '日期：2026-08-30',
      '审查范围：共',
      '发现 5 个 revision，其中 3 个',
      '可',
      '审查、2 个按',
      '规则跳过',
    ].join('\n'))).toMatchObject({
      revisionCount: 5,
      reviewedCount: 3,
      skippedCount: 2,
    });
  });

  it('Revision 列表和说明编号不干扰审查范围计数', () => {
    expect(parseReviewMarkdown([
      '# 上传日志',
      '日期：2026-08-30',
      '审查范围：共发现 5 个 revision：r53833、r53834、r53835、r53839、r53840。其中 3 个可审查、2 个按规则跳过，对应 BUG #552。',
    ].join('\n'))).toMatchObject({
      revisionCount: 5,
      reviewedCount: 3,
      skippedCount: 2,
    });
  });

  it('兼容以提交表述总数的旧日志', () => {
    expect(parseReviewMarkdown([
      '# 上传日志',
      '日期：2026-08-24',
      '审查范围：共 23 个提交，其中 22 个可审查 revision，1 个按默认规则跳过。',
    ].join('\n'))).toMatchObject({
      revisionCount: 23,
      reviewedCount: 22,
      skippedCount: 1,
    });
  });

  it('总数和已审查数明确时推导未单独计数的跳过数', () => {
    expect(parseReviewMarkdown([
      '# 上传日志',
      '日期：2026-08-19',
      '审查范围：内共 26 个 revision；其中 20 个进入审查。其余 revision 命中默认跳过规则。',
    ].join('\n'))).toMatchObject({
      revisionCount: 26,
      reviewedCount: 20,
      skippedCount: 6,
    });
  });

  it('只有提交总数时不猜测审查和跳过分布', () => {
    expect(parseReviewMarkdown([
      '# 上传日志',
      '日期：2026-08-19',
      '审查范围：共 6 个 revision。',
    ].join('\n'))).toMatchObject({
      revisionCount: 6,
      reviewedCount: 0,
      skippedCount: 0,
    });
  });

  it('解析 2026-08-28 单行范围、4 列提交表和旧版问题标题', () => {
    const parsed = parseReviewMarkdown(reviewMarkdown20260828());

    expect(parsed).toMatchObject({
      logDate: '2026-08-28',
      revisionCount: 17,
      reviewedCount: 17,
      skippedCount: 0,
      p1Count: 1,
      p2Count: 1,
    });
    expect(parsed.revisions).toHaveLength(17);
    expect(parsed.revisions[0]).toEqual({
      revision: 53788,
      author: 'yt_cheny',
      committedAt: '',
      description: 'Task #3474 生产订单接收接口调整二开检查配置',
      conclusion: '未发现明显问题',
    });
    expect(parsed.issues).toEqual([
      expect.objectContaining({
        severity: 'P1',
        title: 'r53825 新增的 BokeDee 7024 与内向交货删除触发器复用',
        relatedRevisions: '53825',
      }),
      expect.objectContaining({
        severity: 'P2',
        title: 'r53799/r53825 海化院条码接口固定使用测试租户参数',
        relatedRevisions: '53799、53825',
      }),
    ]);
  });

  it('解析 2026-08-29 章节范围、r 前缀提交和行内问题标题', () => {
    const parsed = parseReviewMarkdown(reviewMarkdown20260829());

    expect(parsed).toMatchObject({
      logDate: '2026-08-29',
      revisionCount: 5,
      reviewedCount: 3,
      skippedCount: 2,
      p1Count: 1,
    });
    expect(parsed.scopeText).toContain('共发现 5 个 revision');
    expect(parsed.revisions).toHaveLength(5);
    expect(parsed.revisions.at(-1)).toMatchObject({
      revision: 53840,
      committedAt: '',
    });
    expect(parsed.issues).toEqual([
      expect.objectContaining({
        severity: 'P1',
        title: 'r53839 注册并调用了当时未随提交进入 SVN 的 Java 类',
        relatedRevisions: '53839',
        detail: expect.not.stringContaining('r53833：结果分析单增加删除操作'),
      }),
    ]);
  });

  it('读取审查范围章节中完整的换行段落', () => {
    const parsed = parseReviewMarkdown([
      '# 上传日志',
      '日期：2026-08-30',
      '## 审查范围与执行边界',
      '',
      '审查窗口为 2026-08-29 19:00:00 至 2026-08-30 18:59:59，',
      '共发现 5 个 revision，其中 3 个可审查，2 个按规则跳过。',
      '',
      '本段说明不属于审查范围摘要。',
    ].join('\n'));

    expect(parsed).toMatchObject({
      scopeText: '审查窗口为 2026-08-29 19:00:00 至 2026-08-30 18:59:59， 共发现 5 个 revision，其中 3 个可审查，2 个按规则跳过。',
      revisionCount: 5,
      reviewedCount: 3,
      skippedCount: 2,
    });
  });

  it('读取带标签审查范围中完整的换行段落', () => {
    const parsed = parseReviewMarkdown([
      '# 上传日志',
      '日期：2026-08-30',
      '审查范围：审查窗口为 2026-08-29 19:00:00 至 2026-08-30 18:59:59，',
      '共发现 5 个 revision，其中 3 个可审查，2 个按规则跳过。',
      '',
      '本段说明不属于审查范围摘要。',
    ].join('\n'));

    expect(parsed).toMatchObject({
      scopeText: '审查窗口为 2026-08-29 19:00:00 至 2026-08-30 18:59:59， 共发现 5 个 revision，其中 3 个可审查，2 个按规则跳过。',
      revisionCount: 5,
      reviewedCount: 3,
      skippedCount: 2,
    });
  });

  it('关联 Revision 不吸收后续说明中的编号', () => {
    const parsed = parseReviewMarkdown([
      '# 上传日志',
      '日期：2026-08-30',
      '审查范围：共 2 个 revision，实际审查 2 个，跳过 0 个',
      '### P1：r53613/r53618 示例问题',
      '相关 revision：`r53613` / r53618（对应 BUG #552）',
    ].join('\n'));

    expect(parsed.issues[0]).toMatchObject({
      relatedRevisions: '53613、53618',
    });
  });

  it('空格分隔的关联 Revision 不跨行吸收说明编号', () => {
    const parsed = parseReviewMarkdown([
      '# 上传日志',
      '日期：2026-08-30',
      '审查范围：共 2 个 revision，实际审查 2 个，跳过 0 个',
      '### P1：示例问题',
      '相关 revision：53825 53826',
      '552 是下一行的说明编号。',
    ].join('\n'));

    expect(parsed.issues[0]).toMatchObject({
      relatedRevisions: '53825、53826',
    });
  });

  it('解析省略尾部竖线的 Revision 表', () => {
    const parsed = parseReviewMarkdown([
      '# 上传日志',
      '日期：2026-08-30',
      '审查范围：共 1 个 revision，实际审查 1 个，跳过 0 个',
      '| Revision | 作者 | 提交说明 | 结果',
      '| --- | --- | --- | ---',
      '| r53841 | zhoupx | 补交 Java 类 | 已审查',
    ].join('\n'));

    expect(parsed.revisions).toEqual([{
      revision: 53841,
      author: 'zhoupx',
      committedAt: '',
      description: '补交 Java 类',
      conclusion: '已审查',
    }]);
  });

  it('解析省略首部竖线的 Revision 表', () => {
    const parsed = parseReviewMarkdown([
      '# 上传日志',
      '日期：2026-08-30',
      '审查范围：共 1 个 revision，实际审查 1 个，跳过 0 个',
      'Revision | 作者 | 提交说明 | 结果 |',
      '--- | --- | --- | --- |',
      'r53841 | zhoupx | 补交 Java 类 | 已审查 |',
    ].join('\n'));

    expect(parsed.revisions).toEqual([{
      revision: 53841,
      author: 'zhoupx',
      committedAt: '',
      description: '补交 Java 类',
      conclusion: '已审查',
    }]);
  });

  it('解析 Revision 表单元格中的转义竖线', () => {
    const parsed = parseReviewMarkdown([
      '# 上传日志',
      '日期：2026-08-30',
      '审查范围：共 1 个 revision，实际审查 1 个，跳过 0 个',
      '| Revision | 作者 | 提交说明 | 结果 |',
      '| --- | --- | --- | --- |',
      String.raw`| r53841 | zhoupx | 修复 A \| B | 已审查 |`,
    ].join('\n'));

    expect(parsed.revisions).toEqual([{
      revision: 53841,
      author: 'zhoupx',
      committedAt: '',
      description: '修复 A | B',
      conclusion: '已审查',
    }]);
  });

  beforeEach(async () => {
    await DB.batch([
      DB.prepare('DELETE FROM review_issue_events'),
      DB.prepare('DELETE FROM review_issues'),
      DB.prepare('DELETE FROM review_revisions'),
      DB.prepare('DELETE FROM review_logs'),
      DB.prepare('DELETE FROM review_search'),
    ]);
    await clearBucket();
  });

  it('拒绝非零提交计数与提交表不完整的日志', async () => {
    const incomplete = reviewMarkdown20260829().replace(
      '| r53840 | guangyh | 修正条件判断 | 已审查 |\n',
      '',
    );

    await expect(ingestReview(ingestInput(incomplete))).rejects.toThrow(
      '提交表解析不完整',
    );
    expect(await reviewStorageRow()).toBeNull();
    expect(await bucketKeys()).toEqual([]);
  });

  it('拒绝缺少必需列的 Revision 行', async () => {
    const truncated = fiveRevisionMarkdown(
      '共 5 个 revision，实际审查 5 个，跳过 0 个',
    ).replace('| 53841 | zhoupx | 提交一 | 已审查 |', '| r53841 |');

    await expect(ingestReview(ingestInput(truncated))).rejects.toThrow(
      '提交表解析不完整',
    );
    expect(await reviewStorageRow()).toBeNull();
    expect(await bucketKeys()).toEqual([]);
  });

  it.each([
    ['显式跳过零个', '共 5 个 revision，实际审查 4 个，跳过 0 个'],
    ['显式审查零个', '共 5 个 revision，实际审查 0 个，跳过 2 个'],
    ['显式审查和跳过均为零', '共 5 个 revision，实际审查 0 个，跳过 0 个'],
  ])('拒绝%s但总数矛盾的日志', async (_caseName, scope) => {
    await expect(
      ingestReview(ingestInput(fiveRevisionMarkdown(scope))),
    ).rejects.toThrow('审查范围计数不一致');
    expect(await reviewStorageRow()).toBeNull();
    expect(await bucketKeys()).toEqual([]);
  });

  it('允许明确声明零提交的日志', async () => {
    const result = await ingestReview(ingestInput(zeroRevisionMarkdown()));

    expect(result).toMatchObject({
      revisionCount: 0,
      reviewedCount: 0,
      skippedCount: 0,
    });
    expect(await revisionRows()).toEqual([]);
  });

  it('允许审查范围换行后明确声明零提交', async () => {
    const markdown = zeroRevisionMarkdown().replace(
      '共 0 个 revision',
      '共\n发现 0 个 revision',
    );
    const result = await ingestReview(ingestInput(markdown));

    expect(result).toMatchObject({
      revisionCount: 0,
      reviewedCount: 0,
      skippedCount: 0,
    });
    expect(await revisionRows()).toEqual([]);
  });

  it('允许使用“提交”文案明确声明零提交', async () => {
    const markdown = zeroRevisionMarkdown().replace('0 个 revision', '0 个提交');
    const result = await ingestReview(ingestInput(markdown));

    expect(result).toMatchObject({
      revisionCount: 0,
      reviewedCount: 0,
      skippedCount: 0,
    });
    expect(await revisionRows()).toEqual([]);
  });

  it('允许历史日志使用“无新增提交”明确声明零提交', async () => {
    const markdown = zeroRevisionMarkdown().replace(
      '共 0 个 revision',
      '本时间窗内无新增提交',
    );
    const result = await ingestReview(ingestInput(markdown));

    expect(result).toMatchObject({
      revisionCount: 0,
      reviewedCount: 0,
      skippedCount: 0,
    });
    expect(await revisionRows()).toEqual([]);
  });

  it('允许 review 3 仅在总体结论中声明无新增提交', async () => {
    const markdown = `# ZHERP 当日 SVN 提交审查日志
日期：2026-06-07
审查范围：2026-06-06 19:00:00 到 2026-06-07 18:59:59
总体结论：本时间窗内无新增提交，无需进入代码审查。
`;
    const result = await ingestReview(ingestInput(markdown));

    expect(result).toMatchObject({
      revisionCount: 0,
      reviewedCount: 0,
      skippedCount: 0,
    });
    expect(await revisionRows()).toEqual([]);
  });

  it('重复导入同一问题时保留状态、说明、版本和事件，并更新源字段', async () => {
    await ingestReview(ingestInput(initialMarkdown()));
    const firstPass = await issueRows();
    const preserved = firstPass.find(
      (issue) => issue.title === 'Parameter Count Mismatch',
    );
    expect(firstPass).toHaveLength(2);
    expect(firstPass.map((issue) => issue.status)).toEqual(['open', 'open']);

    await DB.batch([
      DB.prepare(
        `UPDATE review_issues
         SET status = 'resolved', status_note = '已修复并验证',
             status_updated_at = '2026-08-27T10:00:00.000Z', version = 3
         WHERE id = ?`,
      ).bind(preserved!.id),
      DB.prepare(
        `INSERT INTO review_issue_events (
          issue_id, from_status, to_status, note, created_at
        ) VALUES (?, 'open', 'resolved', '已修复并验证',
                  '2026-08-27T10:00:00.000Z')`,
      ).bind(preserved!.id),
    ]);

    await ingestReview(ingestInput(formatVariantMarkdown()));

    const secondPass = await issueRows();
    const merged = secondPass.find(
      (issue) => issue.issueKey === 'p1:parameter-count-mismatch:100、101',
    );
    const events = await DB.prepare(
      'SELECT COUNT(*) AS count FROM review_issue_events WHERE issue_id = ?',
    )
      .bind(preserved!.id)
      .first<{ count: number }>();

    expect(secondPass).toHaveLength(2);
    expect(merged).toMatchObject({
      id: preserved!.id,
      severity: 'P1',
      title: 'parameter   count mismatch',
      relatedRevisions: '100、101',
      detail: expect.stringContaining('新版详情'),
      status: 'resolved',
      statusNote: '已修复并验证',
      statusUpdatedAt: '2026-08-27T10:00:00.000Z',
      sourceCurrent: 1,
      version: 3,
    });
    expect(events?.count).toBe(1);
  });

  it('标题推导 Revision 时兼容旧问题标识并保留协作状态', async () => {
    const markdown = titleDerivedRevisionMarkdown();
    await ingestReview(ingestInput(markdown));
    const original = (await issueRows())[0];

    await DB.batch([
      DB.prepare(
        `UPDATE review_issues
         SET issue_key = 'p2:r53825-some-problem:', related_revisions = '',
             status = 'resolved', status_note = '旧问题已解决', version = 4
         WHERE id = ?`,
      ).bind(original.id),
      DB.prepare(
        `INSERT INTO review_issue_events (
          issue_id, from_status, to_status, note, created_at
        ) VALUES (?, 'open', 'resolved', '旧问题已解决',
                  '2026-08-27T10:00:00.000Z')`,
      ).bind(original.id),
    ]);

    const result = await ingestReview(ingestInput(markdown));
    const issues = await issueRows();
    const events = await DB.prepare(
      'SELECT COUNT(*) AS count FROM review_issue_events WHERE issue_id = ?',
    )
      .bind(original.id)
      .first<{ count: number }>();

    expect(result.ingestion).toEqual({
      createdIssueCount: 0,
      updatedIssueCount: 1,
      parsedIssueCount: 1,
    });
    expect(issues).toEqual([
      expect.objectContaining({
        id: original.id,
        issueKey: 'p2:r53825-some-problem:',
        relatedRevisions: '53825',
        status: 'resolved',
        statusNote: '旧问题已解决',
        sourceCurrent: 1,
        version: 4,
      }),
    ]);
    expect(events?.count).toBe(1);
  });

  it('空格分隔相关 Revision 时保留旧问题状态并排除说明编号', async () => {
    const markdown = whitespaceSeparatedRevisionMarkdown();
    await ingestReview(ingestInput(markdown));
    const original = (await issueRows())[0];

    await DB.prepare(
      `UPDATE review_issues
       SET issue_key = 'p2:whitespace-related-revisions:53825、53826',
           related_revisions = '53825、53826', status = 'resolved',
           status_note = '空格格式问题已解决', version = 2
       WHERE id = ?`,
    )
      .bind(original.id)
      .run();

    const result = await ingestReview(ingestInput(markdown));
    const issues = await issueRows();

    expect(result.ingestion).toEqual({
      createdIssueCount: 0,
      updatedIssueCount: 1,
      parsedIssueCount: 1,
    });
    expect(issues).toEqual([
      expect.objectContaining({
        id: original.id,
        issueKey: 'p2:whitespace-related-revisions:53825、53826',
        relatedRevisions: '53825、53826',
        status: 'resolved',
        statusNote: '空格格式问题已解决',
        sourceCurrent: 1,
        version: 2,
      }),
    ]);
  });

  it.each([
    ['r 前缀', 'r53825', '', '53825', 'p2:explicit-related-revisions:'],
    ['斜杠分隔', '53825/53826', '53825', '53825、53826', 'p2:explicit-related-revisions:53825'],
  ])(
    '显式相关 Revision 使用%s时兼容旧问题标识并保留协作状态',
    async (_caseName, sourceRevisions, legacyRevisions, parsedRevisions, legacyKey) => {
      const markdown = explicitRevisionMarkdown(sourceRevisions);
      await ingestReview(ingestInput(markdown));
      const original = (await issueRows())[0];

      await DB.batch([
        DB.prepare(
          `UPDATE review_issues
           SET issue_key = ?, related_revisions = ?, status = 'resolved',
               status_note = '旧问题协作状态', version = 3
           WHERE id = ?`,
        ).bind(legacyKey, legacyRevisions, original.id),
        DB.prepare(
          `INSERT INTO review_issue_events (
            issue_id, from_status, to_status, note, created_at
          ) VALUES (?, 'open', 'resolved', '旧问题协作状态',
                    '2026-08-27T10:00:00.000Z')`,
        ).bind(original.id),
      ]);

      const result = await ingestReview(ingestInput(markdown));
      const issues = await issueRows();
      const events = await DB.prepare(
        'SELECT COUNT(*) AS count FROM review_issue_events WHERE issue_id = ?',
      )
        .bind(original.id)
        .first<{ count: number }>();

      expect(result.ingestion).toEqual({
        createdIssueCount: 0,
        updatedIssueCount: 1,
        parsedIssueCount: 1,
      });
      expect(issues).toEqual([
        expect.objectContaining({
          id: original.id,
          issueKey: legacyKey,
          relatedRevisions: parsedRevisions,
          status: 'resolved',
          statusNote: '旧问题协作状态',
          sourceCurrent: 1,
          version: 3,
        }),
      ]);
      expect(events?.count).toBe(1);
    },
  );

  it('源问题增删及重新出现时保留历史行，只让当前问题进入总览', async () => {
    await ingestReview(ingestInput(initialMarkdown()));
    const firstPass = await issueRows();
    const returning = firstPass.find(
      (issue) => issue.title === 'Legacy Authorization Reuse',
    )!;

    await DB.batch([
      DB.prepare(
        `UPDATE review_issues
         SET status = 'by_design', status_note = '符合现有权限模型', version = 2
         WHERE id = ?`,
      ).bind(returning.id),
      DB.prepare(
        `INSERT INTO review_issue_events (
          issue_id, from_status, to_status, note, created_at
        ) VALUES (?, 'open', 'by_design', '符合现有权限模型',
                  '2026-08-27T11:00:00.000Z')`,
      ).bind(returning.id),
    ]);

    const changed = await ingestReview(ingestInput(changedMarkdown()));
    const afterChange = await issueRows();
    const currentPage = await getIssuePage(1);
    expect(changed.ingestion).toEqual({
      createdIssueCount: 1,
      updatedIssueCount: 1,
      parsedIssueCount: 2,
    });
    expect(afterChange).toHaveLength(3);
    expect(afterChange.find((issue) => issue.id === returning.id)).toMatchObject({
      status: 'by_design',
      statusNote: '符合现有权限模型',
      sourceCurrent: 0,
      version: 2,
    });
    expect(
      afterChange.find((issue) => issue.title === 'Fresh Source Problem'),
    ).toMatchObject({
      status: 'open',
      statusNote: null,
      sourceCurrent: 1,
      version: 0,
    });
    expect(currentPage.items.map((issue) => issue.title).sort()).toEqual([
      'Fresh Source Problem',
      'Parameter Count Mismatch',
    ]);

    const reappeared = await ingestReview(ingestInput(reappearedMarkdown()));
    const afterReappeared = await issueRows();
    const restored = afterReappeared.find((issue) => issue.id === returning.id);
    const eventCount = await DB.prepare(
      'SELECT COUNT(*) AS count FROM review_issue_events WHERE issue_id = ?',
    )
      .bind(returning.id)
      .first<{ count: number }>();

    expect(reappeared.ingestion).toEqual({
      createdIssueCount: 0,
      updatedIssueCount: 2,
      parsedIssueCount: 2,
    });
    expect(afterReappeared).toHaveLength(3);
    expect(restored).toMatchObject({
      id: returning.id,
      status: 'by_design',
      statusNote: '符合现有权限模型',
      sourceCurrent: 1,
      version: 2,
    });
    expect(eventCount?.count).toBe(1);
  });

  it('不同标题或关联 Revision 生成不同稳定键，不会错误合并', async () => {
    await ingestReview(ingestInput(distinctIssuesMarkdown()));

    const issues = await issueRows();
    expect(issues.map((issue) => issue.issueKey).sort()).toEqual([
      'p2:another-title:200',
      'p2:same-title:200',
      'p2:same-title:201',
    ]);
    expect(new Set(issues.map((issue) => issue.id)).size).toBe(3);
  });

  it('兼容 Task 2 已按旧 Revision 顺序回填的稳定键', async () => {
    await ingestReview(ingestInput(initialMarkdown()));
    const original = (await issueRows()).find(
      (issue) => issue.title === 'Parameter Count Mismatch',
    )!;
    await DB.prepare(
      `UPDATE review_issues
       SET issue_key = 'p1:parameter-count-mismatch:101、100',
           related_revisions = '101、100', status = 'resolved',
           status_note = '升级前已解决', version = 5
       WHERE id = ?`,
    )
      .bind(original.id)
      .run();

    await ingestReview(ingestInput(formatVariantMarkdown()));

    const matching = (await issueRows()).filter(
      (issue) => issue.title.toLowerCase().replace(/\s+/g, ' ') ===
        'parameter count mismatch',
    );
    expect(matching).toEqual([
      expect.objectContaining({
        id: original.id,
        issueKey: 'p1:parameter-count-mismatch:101、100',
        relatedRevisions: '100、101',
        status: 'resolved',
        statusNote: '升级前已解决',
        sourceCurrent: 1,
        version: 5,
      }),
    ]);
  });

  it('D1 导入中途失败时回滚日志、Revision 和问题，但保留先写成功的 R2 原文', async () => {
    await ingestReview(ingestInput(initialMarkdown()));
    const reviewBefore = await reviewStorageRow();
    const issuesBefore = await issueRows();
    const revisionsBefore = await revisionRows();
    const objectsBefore = await bucketKeys();

    await expect(
      ingestReview(ingestInput(failingMarkdownWithDuplicateRevision())),
    ).rejects.toThrow('D1 原子更新失败');

    expect(await reviewStorageRow()).toEqual(reviewBefore);
    expect(await issueRows()).toEqual(issuesBefore);
    expect(await revisionRows()).toEqual(revisionsBefore);
    const objectsAfter = await bucketKeys();
    expect(objectsAfter).toHaveLength(objectsBefore.length + 1);
    expect(objectsAfter).toEqual(
      expect.arrayContaining(objectsBefore),
    );
  });

  it('自动同步重复导入时返回兼容的导入计数', async () => {
    const first = await ingestReview(ingestInput(initialMarkdown()));
    const second = await ingestReview(ingestInput(initialMarkdown()));

    expect(first).toMatchObject({
      logDate: '2026-08-27',
      ingestion: {
        createdIssueCount: 2,
        updatedIssueCount: 0,
        parsedIssueCount: 2,
      },
    });
    expect(second).toMatchObject({
      logDate: '2026-08-27',
      ingestion: {
        createdIssueCount: 0,
        updatedIssueCount: 2,
        parsedIssueCount: 2,
      },
    });
    expect(
      await DB.prepare(
        `SELECT p.slug
         FROM review_logs l
         JOIN review_projects p ON p.id = l.project_id
         WHERE l.id = ?`,
      )
        .bind(first.id)
        .first(),
    ).toEqual({ slug: 'zherp' });
  });
});

function ingestInput(markdown: string) {
  return {
    markdown,
    sourceKey: SOURCE_KEY,
    sourceName: 'svn审查日志-2026-08-27.md',
    importedBy: 'Workers 集成测试',
    syncMode: 'automation' as const,
  };
}

async function issueRows(): Promise<IssueRow[]> {
  const result = await DB.prepare(
    `SELECT id, issue_key AS issueKey, severity, title,
            related_revisions AS relatedRevisions, detail, status,
            status_note AS statusNote, status_updated_at AS statusUpdatedAt,
            source_current AS sourceCurrent, version
     FROM review_issues ORDER BY id`,
  ).all<IssueRow>();
  return result.results ?? [];
}

async function revisionRows() {
  const result = await DB.prepare(
    `SELECT revision, author, committed_at AS committedAt, description, conclusion
     FROM review_revisions ORDER BY revision`,
  ).all();
  return result.results ?? [];
}

async function reviewStorageRow() {
  return DB.prepare(
    `SELECT log_date AS logDate, source_hash AS sourceHash,
            content_object_key AS contentObjectKey, title, overview, updated_at AS updatedAt
     FROM review_logs WHERE source_key = ?`,
  )
    .bind(SOURCE_KEY)
    .first();
}

async function clearBucket(): Promise<void> {
  const keys = await bucketKeys();
  if (keys.length) await FILES.delete(keys);
}

async function bucketKeys(): Promise<string[]> {
  const keys: string[] = [];
  let cursor: string | undefined;
  do {
    const page = await FILES.list({ cursor });
    keys.push(...page.objects.map((object) => object.key));
    cursor = page.truncated ? page.cursor : undefined;
  } while (cursor);
  return keys.sort();
}

function initialMarkdown(): string {
  return `# 初始审查日志
日期：2026-08-27
审查范围：共 2 个 revision，实际审查 2 个，跳过 0 个
总体结论：保留 1 个 P1、1 个 P2

| Revision | 提交人 | 提交时间 | 说明 | 结论 |
| --- | --- | --- | --- | --- |
| 100 | alice | 2026-08-27 09:00 | 首次提交 | 已审查 |
| 101 | bob | 2026-08-27 09:30 | 后续提交 | 已审查 |

### P1

#### Parameter Count Mismatch
相关 revision：101、100

初始详情。

### P2

#### Legacy Authorization Reuse
相关 revision：102

权限复用详情。
`;
}

function formatVariantMarkdown(): string {
  return `# 格式变化后的审查日志
日期：2026-08-27
审查范围：共 2 个 revision，实际审查 2 个，跳过 0 个
总体结论：保留 1 个 P1、1 个 P2

| Revision | 提交人 | 提交时间 | 说明 | 结论 |
| --- | --- | --- | --- | --- |
| 100 | changed-author | 2026-08-27 09:00 | 首次提交 | 已审查 |
| 101 | bob | 2026-08-27 09:30 | 后续提交 | 已审查 |

### p1

#### parameter   count mismatch
相关 revision：100, 101

新版详情，不能进入稳定键。

### p2

#### legacy authorization reuse
相关 revision：102

更新后的权限详情。
`;
}

function changedMarkdown(): string {
  return `# 增删问题后的审查日志
日期：2026-08-27
审查范围：共 1 个 revision，实际审查 1 个，跳过 0 个
总体结论：保留 1 个 P1、1 个 P3

| Revision | 提交人 | 提交时间 | 说明 | 结论 |
| --- | --- | --- | --- | --- |
| 100 | alice | 2026-08-27 09:00 | 首次提交 | 已审查 |

### P1

#### Parameter Count Mismatch
相关 revision：100、101

当前问题。

### P3

#### Fresh Source Problem
相关 revision：103

新增问题。
`;
}

function reappearedMarkdown(): string {
  return `# 问题重新出现的审查日志
日期：2026-08-27
审查范围：共 1 个 revision，实际审查 1 个，跳过 0 个
总体结论：保留 1 个 P2、1 个 P3

| Revision | 提交人 | 提交时间 | 说明 | 结论 |
| --- | --- | --- | --- | --- |
| 102 | carol | 2026-08-27 10:00 | 权限提交 | 已审查 |

### P2

#### Legacy Authorization Reuse
相关 revision：102

重新出现后的源详情。

### P3

#### Fresh Source Problem
相关 revision：103

仍然存在。
`;
}

function distinctIssuesMarkdown(): string {
  return `# 稳定键边界审查日志
日期：2026-08-27
审查范围：共 1 个 revision，实际审查 1 个，跳过 0 个
总体结论：保留 3 个 P2

| Revision | 提交人 | 提交时间 | 说明 | 结论 |
| --- | --- | --- | --- | --- |
| 200 | alice | 2026-08-27 09:00 | 边界提交 | 已审查 |

### P2

#### Same Title
相关 revision：200

第一项。

#### Same Title
相关 revision：201

第二项。

#### Another Title
相关 revision：200

第三项。
`;
}

function failingMarkdownWithDuplicateRevision(): string {
  return `# 不应提交的失败日志
日期：2026-08-27
审查范围：共 2 个 revision，实际审查 2 个，跳过 0 个
总体结论：保留 1 个 P3

| Revision | 提交人 | 提交时间 | 说明 | 结论 |
| --- | --- | --- | --- | --- |
| 999 | alice | 2026-08-27 12:00 | 重复一 | 已审查 |
| 999 | bob | 2026-08-27 12:01 | 重复二 | 已审查 |

### P3

#### Only Failed Import Problem
相关 revision：999

该问题不得替换旧问题。
`;
}

function reviewMarkdown20260828(): string {
  return `# ZHERP 当日 SVN 提交审查日志

日期：2026-08-28
审查范围：2026-08-27 19:00:00 至 2026-08-28 18:59:59，共 17 个 revision，17 个均可审查。
总体结论：代码审查确认 1 个 P1 高风险问题；另有 1 个 P2 环境配置风险。

| Revision | 提交人 | 提交说明 | 审查结论 |
| --- | --- | --- | --- |
| 53788 | yt_cheny | Task #3474 生产订单接收接口调整二开检查配置 | 未发现明显问题 |
| 53791 | maogr | BUG #522 | 未发现明显问题 |
| 53792 | maogr | TASK #2750 | 未发现明显问题 |
| 53793 | panzq | Task #2764 | 未发现确认缺陷 |
| 53794 | yt_yaomw | Bug #6738 | 未发现明显问题 |
| 53797 | yangbo02 | Bug #552 | 未发现明显问题 |
| 53799 | liuc | Bug #552 | 有 P2 环境配置风险 |
| 53800 | qiuhb | TASK #2600 | 未发现明显问题 |
| 53809 | yt_yaomw | Bug #552 | 未发现明显问题 |
| 53812 | panzq | Bug #552 | 未发现明显问题 |
| 53814 | yangbo02 | task #2697 | 未发现确认缺陷 |
| 53816 | panzq | Task #2764 | 未发现明显问题 |
| 53817 | panzq | Task #2764 | 未发现明显问题 |
| 53819 | panzq | Task #2764 | 未发现明显问题 |
| 53820 | qiuhb | BUG #6740 | 有待业务确认观察 |
| 53823 | yt_yaomw | Bug #552 | 未发现明显问题 |
| 53825 | liuc | Bug #552 | 有 P1 高风险问题及 P2 环境配置风险 |

### P1

#### r53825 新增的 BokeDee 7024 与内向交货删除触发器复用

- 相关 revision：53825
- 证据：调用参数仍写入 BizType=7020。

### P2

#### r53799/r53825 海化院条码接口固定使用测试租户参数

- 相关 revision：53799、53825
- 证据：companycode 使用 _test 参数。
`;
}

function reviewMarkdown20260829(): string {
  return `# ZHERP 当日 SVN 提交审查日志

日期：2026-08-29

## 审查范围与执行边界

审查窗口为 2026-08-28 19:00:00 至 2026-08-29 18:59:59，共发现 5 个 revision：\`r53833\`、\`r53834\`、\`r53835\`、\`r53839\`、\`r53840\`。其中 3 个可审查，2 个按默认规则跳过。

## 提交概览

| Revision | 作者 | 提交说明 | 结果 |
| --- | --- | --- | --- |
| r53833 | qiuhb | BUG#552 放出删除按钮 | 已审查 |
| r53834 | lansz | Jenkins 发布版本记录 | 跳过 |
| r53835 | yt_suncl | ZHERP 更新日志 | 跳过 |
| r53839 | zhoupx | Task #2772 益神项目毛利表开发 | 发现 1 个 P1 |
| r53840 | guangyh | 修正条件判断 | 已审查 |

## 审查问题

### P1：r53839 注册并调用了当时未随提交进入 SVN 的 Java 类

相关变更中未随提交进入 SVN，后续由 r53841 补交。

## 其他提交结论

### r53833：结果分析单增加删除操作

未发现审查问题。
`;
}

function zeroRevisionMarkdown(): string {
  return `# ZHERP 当日 SVN 提交审查日志
日期：2026-08-30
审查范围：共 0 个 revision，实际审查 0 个，跳过 0 个
总体结论：当日无提交。
`;
}

function fiveRevisionMarkdown(scope: string): string {
  return `# ZHERP 当日 SVN 提交审查日志
日期：2026-08-30
审查范围：${scope}

| Revision | 作者 | 提交说明 | 结果 |
| --- | --- | --- | --- |
| 53841 | zhoupx | 提交一 | 已审查 |
| 53842 | zhoupx | 提交二 | 已审查 |
| 53843 | zhoupx | 提交三 | 已审查 |
| 53844 | zhoupx | 提交四 | 已审查 |
| 53845 | zhoupx | 提交五 | 已审查 |
`;
}

function titleDerivedRevisionMarkdown(): string {
  return `# 标题 Revision 审查日志
日期：2026-08-27
审查范围：共 1 个 revision，实际审查 1 个，跳过 0 个

| Revision | 作者 | 提交说明 | 结果 |
| --- | --- | --- | --- |
| 53825 | zhoupx | 标题关联测试 | 已审查 |

### P2

#### r53825 Some problem

问题详情未显式声明相关 revision。
`;
}

function whitespaceSeparatedRevisionMarkdown(): string {
  return `# 空格 Revision 审查日志
日期：2026-08-27
审查范围：共 2 个 revision，实际审查 2 个，跳过 0 个

| Revision | 作者 | 提交说明 | 结果 |
| --- | --- | --- | --- |
| 53825 | zhoupx | 第一条提交 | 已审查 |
| 53826 | zhoupx | 第二条提交 | 已审查 |

### P2

#### Whitespace Related Revisions

相关 revision：53825 53826（对应 BUG #552）
`;
}

function explicitRevisionMarkdown(relatedRevisions: string): string {
  return `# 显式 Revision 审查日志
日期：2026-08-27
审查范围：共 2 个 revision，实际审查 2 个，跳过 0 个

| Revision | 作者 | 提交说明 | 结果 |
| --- | --- | --- | --- |
| 53825 | zhoupx | 第一条提交 | 已审查 |
| 53826 | zhoupx | 第二条提交 | 已审查 |

### P2

#### Explicit Related Revisions

相关 revision：${relatedRevisions}
`;
}
