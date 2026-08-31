'use client';

import { useState } from 'react';
import PagedLoadMore from './components/paged-load-more';
import type { PageResult, ReviewSummary } from '@/lib/reviews';

type Props = {
  initialItems: ReviewSummary[];
  initialCursor: string | null;
  initialHasMore: boolean;
  projectBasePath: string;
  reviewsApiPath: string;
};

export default function ReviewExplorer({
  initialItems,
  initialCursor,
  initialHasMore,
  projectBasePath,
  reviewsApiPath,
}: Props) {
  const [items, setItems] = useState(initialItems);
  const [cursor, setCursor] = useState(initialCursor);
  const [hasMore, setHasMore] = useState(initialHasMore);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');

  async function loadMore() {
    if (!cursor || loading) return;
    setLoading(true); setError('');
    try {
      const response = await fetch(`${reviewsApiPath}?scope=active&cursor=${encodeURIComponent(cursor)}`);
      if (!response.ok) throw new Error('加载失败');
      const page = await response.json() as PageResult<ReviewSummary>;
      setItems((current) => [...current, ...page.items]);
      setCursor(page.nextCursor); setHasMore(page.hasMore);
    } catch { setError('未能加载更多日志，请稍后重试。'); }
    finally { setLoading(false); }
  }

  return <section id="history" className="border-t border-[#dfe7df] bg-white"><div className="mx-auto max-w-7xl px-5 py-10 sm:px-8 sm:py-14">
    <div className="flex flex-col justify-between gap-4 md:flex-row md:items-end"><div><p className="text-xs font-bold uppercase tracking-[0.16em] text-[#3d7a61]">当前审查日志</p><h2 className="mt-2 text-2xl font-black text-[#1d332a]">团队正在处理的审查记录</h2></div><a href={`${projectBasePath}/issues`} className="text-sm font-bold text-[#1e6b4e] hover:text-[#124a35]">打开当前问题看板 →</a></div>
    <div className="mt-6 grid gap-4">{items.map((review) => <article key={review.id} className="rounded-2xl border border-[#dfe7df] bg-white p-5 sm:p-6"><div className="flex flex-col justify-between gap-5 lg:flex-row lg:items-start"><div><time className="text-sm font-bold text-[#245d46]">{review.logDate}</time><h3 className="mt-2 font-bold text-[#223c30]">{review.title}</h3><p className="mt-2 text-sm leading-6 text-[#4f6257]">{review.overview || '日志已同步，点击查看详情。'}</p><p className="mt-3 text-xs text-[#728178]">{review.reviewedCount} 个实际审查提交 · 来源：{review.sourceName}</p></div><div className="flex gap-2"><Risk level="P1" count={review.p1Count} /><Risk level="P2" count={review.p2Count} /><Risk level="P3" count={review.p3Count} /></div></div><div className="mt-5 border-t border-[#edf1ed] pt-4"><a href={`${projectBasePath}/reviews/${review.id}`} className="text-sm font-bold text-[#1e6b4e]">打开审查日志 →</a></div></article>)}
      {!items.length && <div className="rounded-2xl border border-dashed border-[#bfd0c0] px-6 py-14 text-center"><p className="font-bold text-[#365346]">当前没有审查日志</p><p className="mt-2 text-sm text-[#708076]">新日志同步后会显示在这里。</p></div>}
    </div>
    {error && <p role="alert" className="mt-4 text-center text-sm font-semibold text-[#a44138]">{error}</p>}
    {items.length > 0 && <PagedLoadMore hasMore={hasMore} loading={loading} label="加载更多日志" onLoad={loadMore} />}
  </div></section>;
}

function Risk({ level, count }: { level: string; count: number }) {
  return <span className="risk-chip" data-severity={level}>{level} {count}</span>;
}
