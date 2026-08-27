import ReviewExplorer from '@/app/review-explorer';
import HomeQuickSearch from '@/app/components/home-quick-search';
import { getCurrentReviewStats, getReviewPage, getSyncHealth } from '@/lib/reviews';

export const dynamic = 'force-dynamic';

export default async function Home() {
  const [page, stats, health] = await Promise.all([getReviewPage({ scope: 'active' }), getCurrentReviewStats(), getSyncHealth()]);
  const reviews = page.items;
  const latest = reviews[0] ?? null;

  return (
    <main className="min-h-screen bg-[#f6f7f3] text-[#17211d]">
      <header className="border-b border-[#dce4dc] bg-[#fdfefc]/95">
        <div className="mx-auto flex max-w-7xl items-center justify-between px-5 py-4 sm:px-8">
          <a href="/" className="flex items-center gap-3">
            <span className="grid h-9 w-9 place-items-center rounded-xl bg-[#1d5b46] text-sm font-black text-white">
              Z
            </span>
            <span>
              <span className="block text-sm font-bold tracking-tight">ZHERP</span>
              <span className="block text-xs text-[#66766d]">SVN 审查日志</span>
            </span>
          </a>
          <nav className="flex items-center gap-2 text-sm">
            <a href="/archive" className="rounded-lg px-3 py-2 text-[#456153] hover:bg-[#e9f0ea]">
              归档库
            </a>
            <a
              href="/admin"
              className="rounded-lg border border-[#b9cbbb] bg-white px-3 py-2 font-medium text-[#1d5b46] hover:bg-[#edf4ee]"
            >
              管理入口
            </a>
          </nav>
        </div>
      </header>

      <section className="mx-auto max-w-7xl px-5 pb-8 pt-10 sm:px-8 sm:pt-14">
        <div className="grid gap-7 lg:grid-cols-[minmax(0,1.35fr)_minmax(300px,0.65fr)] lg:items-end">
          <div>
            <p className="mb-3 text-xs font-bold uppercase tracking-[0.16em] text-[#37735a]">
              每日自动沉淀 · 团队可随时查阅
            </p>
            <h1 className="max-w-3xl text-4xl font-black tracking-[-0.04em] text-[#18352b] sm:text-5xl">
              把每天的 SVN 审查，
              <br className="hidden sm:block" />
              变成团队可用的工程记忆。
            </h1>
            <p className="mt-5 max-w-2xl text-base leading-7 text-[#5d6e64]">
              汇总当日提交、风险问题、验证证据与待确认事项。开发人员可按日期、Revision、提交人和风险级别快速回溯。
            </p>
          </div>

          <aside className="rounded-2xl border border-[#d6e2d7] bg-white p-5 shadow-[0_12px_34px_rgba(32,67,48,0.07)]">
            <p className="text-xs font-semibold uppercase tracking-[0.12em] text-[#708177]">
              最近一次审查
            </p>
            {latest ? (
              <>
                <p className="mt-2 text-2xl font-black text-[#193b2e]">{latest.logDate}</p>
                <p className="mt-2 text-sm leading-6 text-[#5d6e64]">
                  {latest.reviewedCount} 个实际审查提交，{latest.p1Count} 个 P1、{latest.p2Count} 个 P2。
                </p>
                <a
                  href={'/reviews/' + latest.id}
                  className="mt-4 inline-flex items-center gap-1 text-sm font-bold text-[#1d6b4f] hover:text-[#134734]"
                >
                  阅读完整日志 <span aria-hidden="true">→</span>
                </a>
              </>
            ) : (
              <p className="mt-3 text-sm leading-6 text-[#5d6e64]">
                等待导入第一份审查日志。管理员可从管理入口上传，或等待每日自动同步。
              </p>
            )}
          </aside>
        </div>
      </section>

      <section className="mx-auto grid max-w-7xl gap-3 px-5 pb-6 sm:grid-cols-4 sm:px-8"><Stat label="当前日志" value={stats.reviewCount} href="#history" /><Stat label="待处理问题" value={stats.openIssueCount} href="/issues?status=open" /><Stat label="待确认问题" value={stats.pendingReviewCount} href="/issues?status=pending_review" /><Stat label="P1/P2 风险" value={stats.highRiskCount} href="/issues?severity=P1&severity=P2" /></section>
      <section className="mx-auto max-w-7xl px-5 pb-10 sm:px-8"><HomeQuickSearch /></section>
      <section className="mx-auto max-w-7xl px-5 pb-10 sm:px-8"><div className="rounded-2xl border border-[#d9e4da] bg-white p-5"><div className="flex flex-wrap items-start justify-between gap-4"><div><p className="text-xs font-semibold uppercase tracking-[0.12em] text-[#708177]">同步健康</p><h2 className="mt-2 text-xl font-black text-[#193b2e]">自动同步状态</h2></div><div className="text-right text-sm text-[#5d6e64]"><p>最近成功同步：{health.latestAutomationSyncAt ?? '暂无'}</p><p className="mt-1">最近日志：{health.latestLogDate ?? '暂无'} · 最新 Revision：{health.latestRevision ?? '暂无'}</p></div></div><div className="mt-4 grid gap-3 sm:grid-cols-3"><Stat label="当前问题" value={health.currentIssueCount} /><Stat label="待确认问题" value={health.pendingIssueCount} /><Stat label="当前日志" value={health.reviewCount} /></div>{health.parseFailure && <p role="alert" className="mt-4 text-sm font-semibold text-[#a44138]">最近一次自动同步未解析出有效提交，请检查日志格式。</p>}{health.zeroIssueWarning && !health.parseFailure && <p role="status" className="mt-4 text-sm font-semibold text-[#8a6a2b]">最近一次自动同步没有提取到问题，请确认审查结果是否完整。</p>}</div></section>
      <ReviewExplorer initialItems={reviews} initialCursor={page.nextCursor} initialHasMore={page.hasMore} />
    </main>
  );
}

function Stat({ label, value, href }: { label: string; value: number; href?: string }) {
  const content = <><p className="text-xs font-semibold text-[#718077]">{label}</p><p className="mt-1 text-2xl font-black text-[#245d46]">{value}</p></>;
  return href ? <a href={href} className="stat-card rounded-xl border border-[#d9e4da] bg-white p-4">{content}</a> : <div className="rounded-xl border border-[#d9e4da] bg-white p-4">{content}</div>;
}
