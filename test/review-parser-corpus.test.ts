import { describe, expect, it } from 'vitest';
import { parseReviewMarkdown } from '../lib/review-parser';

describe('真实审查日志格式兼容', () => {
  it('2026-09-08：严重级计数以结构化问题为唯一事实来源', () => {
    const parsed = parseReviewMarkdown([
      '# ZHERP 当日 SVN 提交审查日志',
      '',
      '日期：2026-09-08',
      '',
      '总体结论：本轮发现 3 项需合并前修复的 P1 财务报表问题，以及 3 项 P2 功能/兼容性问题。',
      '',
      '### P1',
      '',
      '#### 第一个 P1',
      '',
      '详情。',
      '',
      '### P2',
      '',
      '#### 第一个 P2',
      '',
      '详情。',
    ].join('\n'));

    expect(parsed.issues).toHaveLength(2);
    expect(parsed).toMatchObject({ p1Count: 1, p2Count: 1, p3Count: 0 });
  });

  it('兼容行内问题标题并忽略近似标题', () => {
    const parsed = parseReviewMarkdown([
      '# ZHERP 当日 SVN 提交审查日志',
      '日期：2026-09-13',
      '### P1 不是合法问题标题',
      '### p2 ： r53839 行内标题',
      '相关 revision：53839',
      '',
      '### P3: ASCII 冒号标题',
      '相关 revision：53840',
    ].join('\n'));

    expect(parsed.issues).toEqual([
      expect.objectContaining({
        severity: 'P2',
        title: 'r53839 行内标题',
        relatedRevisions: '53839',
      }),
      expect.objectContaining({
        severity: 'P3',
        title: 'ASCII 冒号标题',
        relatedRevisions: '53840',
      }),
    ]);
  });

  it('不把只有摘要数量、没有结构化问题章节的文案当成问题', () => {
    const parsed = parseReviewMarkdown([
      '# ZHERP 当日 SVN 提交审查日志',
      '日期：2026-09-08',
      '总体结论：草稿预计保留 9 个 P1，但本文没有结构化问题清单。',
    ].join('\n'));

    expect(parsed.issues).toEqual([]);
    expect(parsed).toMatchObject({ p1Count: 0, p2Count: 0, p3Count: 0 });
  });

  it('review 7：审查范围在总体结论标签前停止', () => {
    const parsed = parseReviewMarkdown([
      '# ZHERP 当日 SVN 提交审查日志',
      '',
      '日期：2026-06-11',
      '',
      '审查范围：2026-06-10 19:00:00 到 2026-06-11 18:59:59，共 26 个 revision，分别为 51129、51136、51145、51146、51148、51150、51152、51154、51161、51166、51172、51180、51186、51187、51196。',
      '总体结论：本轮存在 1 个需要修正的问题。',
      '',
      '## 提交概览',
    ].join('\n'));

    expect(parsed.scopeText).toBe(
      '2026-06-10 19:00:00 到 2026-06-11 18:59:59，共 26 个 revision，分别为 51129、51136、51145、51146、51148、51150、51152、51154、51161、51166、51172、51180、51186、51187、51196。',
    );
    expect(parsed.overview).toBe('本轮存在 1 个需要修正的问题。');
  });

  it.each([
    [
      'review 6 的 reviewable 文案',
      '2026-06-09 19:00:00 到 2026-06-10 18:59:59 内共 22 个 revision，reviewable 19 个，分别为 51061、51074。',
      { revisionCount: 22, reviewedCount: 19, skippedCount: 3 },
    ],
    [
      'review 16 的 revision 进入审查文案',
      '2026-06-24 19:00:00 到 2026-06-25 18:59:59 内共 11 个 revision，其中 51554、51555 按默认跳过规则过滤，9 个 revision 进入代码审查。',
      { revisionCount: 11, reviewedCount: 9, skippedCount: 2 },
    ],
    [
      'review 20 的待审查与跳过文案',
      '2026-07-12 19:00:00 到 2026-07-13 18:59:59 内共 9 个需要审查的 revision；另有 2 个 revision 命中默认跳过规则。',
      { revisionCount: 11, reviewedCount: 9, skippedCount: 2 },
    ],
    [
      'review 23 的待审查提交文案',
      '2026-07-21 19:00:00 到 2026-07-22 18:59:59 内共 10 个待审查 revision。该时间窗共发现 12 个提交，另有 2 个提交按默认规则跳过。',
      { revisionCount: 12, reviewedCount: 10, skippedCount: 2 },
    ],
  ])('%s', (_name, scope, expected) => {
    expect(parseReviewMarkdown([
      '# ZHERP 当日 SVN 提交审查日志',
      '日期：2026-08-30',
      `审查范围：${scope}`,
    ].join('\n'))).toMatchObject(expected);
  });

  it('真实五列表头的时区后缀不会丢失提交时间', () => {
    const parsed = parseReviewMarkdown([
      '# ZHERP 当日 SVN 提交审查日志',
      '日期：2026-08-30',
      '审查范围：共 1 个 revision，实际审查 1 个，跳过 0 个',
      '',
      '| Revision | 提交人 | 提交时间 (+08:00) | 提交说明 | 结论 |',
      '| --- | --- | --- | --- | --- |',
      '| 53825 | liuc | 2026-08-28 17:10 | Bug #552 | 已审查 |',
    ].join('\n'));

    expect(parsed.revisions).toEqual([{
      revision: 53825,
      author: 'liuc',
      committedAt: '2026-08-28 17:10',
      description: 'Bug #552',
      conclusion: '已审查',
    }]);
  });

  it('review 7：历史五列表用实际行数补齐审查和跳过计数', () => {
    const revisions = [
      51129, 51136, 51145, 51146, 51148, 51150, 51152, 51154,
      51161, 51166, 51172, 51180, 51186, 51187, 51196,
    ];
    const tableRows = revisions.map(
      (revision) => `| ${revision} | reviewer | 2026-06-11 10:00 | 提交 ${revision} | 已审查 |`,
    );
    const parsed = parseReviewMarkdown([
      '# ZHERP 当日 SVN 提交审查日志',
      '日期：2026-06-11',
      '审查范围：2026-06-10 19:00:00 到 2026-06-11 18:59:59，共 26 个 revision，分别为 51129、51136、51145、51146、51148、51150、51152、51154、51161、51166、51172、51180、51186、51187、51196。',
      '总体结论：本轮存在 1 个需要修正的问题。',
      '',
      '| Revision | 提交人 | 提交时间 | 提交说明 | 结论 |',
      '| --- | --- | --- | --- | --- |',
      ...tableRows,
    ].join('\n'));

    expect(parsed).toMatchObject({
      revisionCount: 26,
      reviewedCount: 15,
      skippedCount: 11,
    });
    expect(parsed.revisions).toHaveLength(15);
  });

  it('review 32：包含跳过项的五列表按完整窗口处理', () => {
    const parsed = parseReviewMarkdown([
      '# ZHERP 当日 SVN 提交审查日志',
      '日期：2026-08-12',
      '审查范围：时间窗内共 3 个 revision，其中 2 个可审查、1 个按默认规则跳过。',
      '',
      '| Revision | 提交人 | 提交时间 | 提交说明 | 结论 |',
      '| --- | --- | --- | --- | --- |',
      '| 53046 | maogr | 2026-08-11 19:32:35 | 业务提交 | 已审查 |',
      '| 53053 | lansz | 2026-08-11 20:10:14 | Jenkins 发布版本 | 跳过：发布版本 |',
      '| 53054 | yt_suncl | 2026-08-11 20:12:15 | 更新日志 | 已审查 |',
    ].join('\n'));

    expect(parsed).toMatchObject({
      revisionCount: 3,
      reviewedCount: 2,
      skippedCount: 1,
      revisionTableMode: 'complete',
    });
    expect(parsed.revisions).toHaveLength(3);
  });

  it('review 15：仅声明总数时从完整表的结论推导跳过数', () => {
    const parsed = parseReviewMarkdown([
      '# ZHERP 当日 SVN 提交审查日志',
      '日期：2026-06-24',
      '审查范围：时间窗内共 3 个 revision，分别为 51503、51505、51506。',
      '',
      '| Revision | 提交人 | 提交时间 | 提交说明 | 结论 |',
      '| --- | --- | --- | --- | --- |',
      '| 51503 | reviewer | 2026-06-24 10:00 | 业务提交 | 已审查 |',
      '| 51505 | reviewer | 2026-06-24 10:01 | 发布版本 | 命中默认跳过规则 |',
      '| 51506 | reviewer | 2026-06-24 10:02 | 更新日志 | 命中默认跳过规则 |',
    ].join('\n'));

    expect(parsed).toMatchObject({
      revisionCount: 3,
      reviewedCount: 1,
      skippedCount: 2,
      revisionTableMode: 'complete',
    });
  });

  it.each([
    ['无新增提交', '审查范围：2026-06-05 19:00:00 到 2026-06-06 18:59:59 内无新增提交。'],
    ['时间窗内无提交', '审查范围：2026-06-06 19:00:00 到 2026-06-07 18:59:59\n总体结论：本时间窗内无新增提交。'],
  ])('历史零提交日志：%s', (_name, scopeLine) => {
    expect(parseReviewMarkdown([
      '# ZHERP 当日 SVN 提交审查日志',
      '日期：2026-06-07',
      scopeLine,
    ].join('\n'))).toMatchObject({
      revisionCount: 0,
      reviewedCount: 0,
      skippedCount: 0,
      revisions: [],
    });
  });
});
