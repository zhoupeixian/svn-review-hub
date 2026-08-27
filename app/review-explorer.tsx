'use client';

import Link from 'next/link';
import { useMemo, useState } from 'react';
import type { ReviewSummary } from '@/lib/reviews';

type Props = {
  reviews: ReviewSummary[];
};

type RiskFilter = 'all' | 'p1' | 'p2' | 'p3' | 'clear';

export default function ReviewExplorer({ reviews }: Props) {
  const [query, setQuery] = useState('');
  const [risk, setRisk] = useState<RiskFilter>('all');
  const filtered = useMemo(() => {
    const needle = query.trim().toLowerCase();

    return reviews.filter((review) => {
      const text = [
        review.logDate,
        review.overview,
        review.scopeText,
        review.sourceName,
      ]
        .join(' ')
        .toLowerCase();
      const matchesText = !needle || text.includes(needle);
      const matchesRisk =
        risk === 'all' ||
        (risk === 'p1' && review.p1Count > 0) ||
        (risk === 'p2' && review.p2Count > 0) ||
        (risk === 'p3' && review.p3Count > 0) ||
        (risk === 'clear' &&
          review.p1Count === 0 &&
          review.p2Count === 0 &&
          review.p3Count === 0);

      return matchesText && matchesRisk;
    });
  }, [query, reviews, risk]);

  const totalP1 = reviews.reduce((sum, review) => sum + review.p1Count, 0);
  const totalP2 = reviews.reduce((sum, review) => sum + review.p2Count, 0);
  const totalRevisions = reviews.reduce(
    (sum, review) => sum + review.reviewedCount,
    0,
  );

  return (
    <section id="history" className="border-t border-[#dfe7df] bg-white">
      <div className="mx-auto max-w-7xl px-5 py-10 sm:px-8 sm:py-14">
        <div className="grid gap-4 sm:grid-cols-3">
          <Stat label="归档日志" value={reviews.length} hint="可持续追加" tone="green" />
          <Stat label="已审查提交" value={totalRevisions} hint="来自日志中的实际审查数" tone="blue" />
          <Stat label="待处理高风险" value={totalP1 + totalP2} hint={totalP1 + ' 个 P1 · ' + totalP2 + ' 个 P2'} tone="amber" />
        </div>

        <div className="mt-12 flex flex-col justify-between gap-4 md:flex-row md:items-end">
          <div>
            <p className="text-xs font-bold uppercase tracking-[0.16em] text-[#3d7a61]">
              审查归档
            </p>
            <h2 className="mt-2 text-2xl font-black tracking-tight text-[#1d332a]">
              找到每一次判断背后的证据
            </h2>
          </div>
          <p className="max-w-lg text-sm leading-6 text-[#64746b]">
            输入日期、Revision 或日志中已有的文字即可筛选；点开单份日志可阅读原始 Markdown 与结构化问题清单。
          </p>
        </div>

        <div className="mt-6 grid gap-3 rounded-2xl border border-[#d9e4da] bg-[#f8fbf8] p-3 md:grid-cols-[1fr_190px]">
          <label className="flex items-center gap-3 rounded-xl bg-white px-4 py-3 shadow-sm">
            <span aria-hidden="true" className="text-[#597064]">⌕</span>
            <input
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder="搜索日期、Revision、日志描述…"
              className="w-full bg-transparent text-sm outline-none placeholder:text-[#98a59d]"
              aria-label="搜索审查日志"
            />
          </label>
          <label className="rounded-xl bg-white px-4 py-3 shadow-sm">
            <span className="sr-only">按风险级别筛选</span>
            <select
              value={risk}
              onChange={(event) => setRisk(event.target.value as RiskFilter)}
              className="w-full bg-transparent text-sm font-medium text-[#3e5649] outline-none"
              aria-label="按风险级别筛选"
            >
              <option value="all">全部风险级别</option>
              <option value="p1">含 P1 发布阻断</option>
              <option value="p2">含 P2 高风险</option>
              <option value="p3">含 P3 建议优化</option>
              <option value="clear">无确认问题</option>
            </select>
          </label>
        </div>

        <div className="mt-5 flex items-center justify-between text-sm text-[#6f7f76]">
          <span>共找到 {filtered.length} 份日志</span>
          {(query || risk !== 'all') && (
            <button
              type="button"
              onClick={() => {
                setQuery('');
                setRisk('all');
              }}
              className="font-semibold text-[#337153] hover:text-[#174e38]"
            >
              清除筛选
            </button>
          )}
        </div>

        <div className="mt-4 grid gap-4">
          {filtered.map((review) => (
            <article
              key={review.id}
              className="group rounded-2xl border border-[#dfe7df] bg-white p-5 transition hover:border-[#b3cdb9] hover:shadow-[0_10px_30px_rgba(31,77,51,0.08)] sm:p-6"
            >
              <div className="flex flex-col justify-between gap-5 lg:flex-row lg:items-start">
                <div className="min-w-0">
                  <div className="flex flex-wrap items-center gap-2">
                    <time className="text-sm font-bold text-[#245d46]">{review.logDate}</time>
                    <span className="rounded-full bg-[#eef5ef] px-2.5 py-1 text-xs font-medium text-[#4c6959]">
                      {review.syncMode === 'automation' ? '自动同步' : '管理员上传'}
                    </span>
                  </div>
                  <p className="mt-3 max-w-3xl text-sm leading-6 text-[#4f6257]">
                    {review.overview || '日志已归档，点击查看详情。'}
                  </p>
                  <div className="mt-4 flex flex-wrap gap-x-5 gap-y-2 text-xs text-[#728178]">
                    <span>{review.reviewedCount} 个实际审查提交</span>
                    <span>{review.skippedCount} 个跳过</span>
                    <span className="truncate">来源：{review.sourceName}</span>
                  </div>
                </div>
                <div className="flex shrink-0 flex-wrap items-center gap-2 lg:max-w-[220px] lg:justify-end">
                  <RiskBadge level="P1" count={review.p1Count} />
                  <RiskBadge level="P2" count={review.p2Count} />
                  <RiskBadge level="P3" count={review.p3Count} />
                </div>
              </div>
              <div className="mt-5 border-t border-[#edf1ed] pt-4">
                <Link
                  href={'/reviews/' + review.id}
                  className="inline-flex items-center gap-1 text-sm font-bold text-[#1e6b4e] hover:text-[#124a35]"
                >
                  打开审查日志 <span aria-hidden="true">→</span>
                </Link>
              </div>
            </article>
          ))}
          {!filtered.length && (
            <div className="rounded-2xl border border-dashed border-[#bfd0c0] bg-[#fbfdfb] px-6 py-14 text-center">
              <p className="font-bold text-[#365346]">没有匹配的审查日志</p>
              <p className="mt-2 text-sm text-[#708076]">试试清除筛选，或从管理入口导入新的 Markdown 日志。</p>
            </div>
          )}
        </div>
      </div>
    </section>
  );
}

function Stat({
  label,
  value,
  hint,
  tone,
}: {
  label: string;
  value: number;
  hint: string;
  tone: 'green' | 'blue' | 'amber';
}) {
  const tones = {
    green: 'border-[#cbe0cf] bg-[#f3faf4] text-[#216246]',
    blue: 'border-[#cbdbe6] bg-[#f3f8fb] text-[#235e7b]',
    amber: 'border-[#f0d9ac] bg-[#fff9ed] text-[#9a6516]',
  };

  return (
    <div className={'rounded-2xl border p-5 ' + tones[tone]}>
      <p className="text-sm font-semibold">{label}</p>
      <p className="mt-2 text-3xl font-black tracking-tight">{value}</p>
      <p className="mt-1 text-xs opacity-75">{hint}</p>
    </div>
  );
}

function RiskBadge({ level, count }: { level: string; count: number }) {
  const className =
    level === 'P1'
      ? 'border-[#f3c1bc] bg-[#fff3f1] text-[#b84339]'
      : level === 'P2'
        ? 'border-[#f1d8a4] bg-[#fff9eb] text-[#996119]'
        : 'border-[#c8d8e8] bg-[#f1f6fb] text-[#44729e]';

  return (
    <span className={'rounded-lg border px-2.5 py-1.5 text-xs font-bold ' + className}>
      {level} {count}
    </span>
  );
}
