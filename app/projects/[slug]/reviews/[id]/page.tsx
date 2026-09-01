import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import IssueStatusPanel from '@/app/components/issue-status-panel';
import ReviewMarkdownLink, { reviewMarkdownUrlTransform } from '@/app/components/review-markdown-link';
import { relativizeProjectPaths } from '@/lib/project-paths';
import { getEnabledReviewProject, getReviewDetail } from '@/lib/reviews';

export const dynamic = 'force-dynamic';

type Props = {
  params: Promise<{ slug: string; id: string }>;
};

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const { slug, id } = await params;
  const project = await getEnabledReviewProject(slug);
  const review = project ? await getReviewDetail(project.id, Number(id)) : null;
  if (!project || !review) return { title: '审查日志不存在' };
  return {
    title: `${review.logDate} · ${project.name} SVN 审查日志`,
    description: review.overview || `${project.name} SVN 提交审查日志。`,
  };
}

export default async function ProjectReviewPage({ params }: Props) {
  const { slug, id } = await params;
  const project = await getEnabledReviewProject(slug);
  if (!project) notFound();
  const review = await getReviewDetail(project.id, Number(id));
  if (!review) notFound();
  const basePath = `/projects/${project.slug}`;

  return (
    <main className="min-h-screen bg-[#f6f7f3] text-[#17211d]">
      <header className="border-b border-[#dce4dc] bg-[#fdfefc]/95">
        <div className="mx-auto flex max-w-6xl items-center justify-between px-5 py-4 sm:px-8">
          <a href={basePath} className="text-sm font-bold text-[#245d46]">← 返回 {project.name}</a>
          <div className="flex items-center gap-3 text-sm">
            <span className="font-bold text-[#355c49]">当前项目：{project.name}</span>
            <a href="/" className="text-[#536b5e]">项目目录</a>
          </div>
        </div>
      </header>

      <div className="mx-auto max-w-6xl px-5 py-9 sm:px-8 sm:py-12">
        <section className="rounded-3xl border border-[#d8e4d9] bg-white p-6 shadow-[0_14px_36px_rgba(31,77,51,0.06)] sm:p-8">
          <div className="flex flex-col justify-between gap-6 lg:flex-row lg:items-start">
            <div className="max-w-3xl">
              <p className="text-sm font-bold text-[#28654c]">{review.logDate}</p>
              <h1 className="mt-2 text-3xl font-black tracking-tight text-[#17382a] sm:text-4xl">{project.name} 当日 SVN 提交审查</h1>
              <p className="mt-4 text-base leading-7 text-[#51645a]">{review.overview || '本次日志没有可展示的总体结论。'}</p>
              {review.scopeText && <p className="mt-4 rounded-xl bg-[#f2f7f2] px-4 py-3 text-sm leading-6 text-[#5c7063]">{review.scopeText}</p>}
            </div>
            <div className="flex flex-wrap gap-2 lg:justify-end">
              <RiskBadge level="P1" count={review.p1Count} />
              <RiskBadge level="P2" count={review.p2Count} />
              <RiskBadge level="P3" count={review.p3Count} />
            </div>
          </div>
        </section>

        {review.issues.length > 0 && (
          <section className="mt-8">
            <div className="flex items-baseline justify-between gap-4"><h2 className="text-xl font-black tracking-tight text-[#243e31]">问题清单</h2><span className="text-sm text-[#718077]">{review.issues.length} 项已结构化提取</span></div>
            <div className="mt-4 grid gap-4">
              {review.issues.map((issue) => (
                <article key={issue.id} id={`issue-${issue.id}`} className="issue-card">
                  <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
                    <div><p className="risk-chip" data-severity={issue.severity}>{issue.severity}</p><h3 className="mt-3 text-base font-bold text-[#223c30]">{issue.title}</h3></div>
                    {issue.relatedRevisions && <span className="meta-chip">r{issue.relatedRevisions.split('、').join(' · r')}</span>}
                  </div>
                  <p className="mt-4 max-w-4xl whitespace-pre-line text-sm leading-7 text-[#607167]">{relativizeProjectPaths(issue.detail)}</p>
                  <IssueStatusPanel
                    issue={issue}
                    statusApiPath={`/api/projects/${encodeURIComponent(project.slug)}/issues/${issue.id}/status`}
                    readOnly={review.archivedAt !== null}
                  />
                </article>
              ))}
            </div>
          </section>
        )}

        <section className="mt-8 rounded-3xl border border-[#d8e4d9] bg-white p-6 sm:p-8">
          <div className="flex flex-col gap-4 border-b border-[#e7eee8] pb-5 sm:flex-row sm:items-center sm:justify-between">
            <div><p className="text-xs font-bold uppercase tracking-[0.14em] text-[#4a8068]">{project.name} 原始审查记录</p><h2 className="mt-1 text-xl font-black tracking-tight text-[#243e31]">完整 Markdown 日志</h2></div>
            <a href={`/api/projects/${project.slug}/reviews/${review.id}/raw`} className="inline-flex rounded-lg border border-[#c2d4c4] px-3 py-2 text-sm font-semibold text-[#275f48] hover:bg-[#eff6ef]">下载原始 Markdown</a>
          </div>
          <article className="review-markdown mt-7">
            <ReactMarkdown remarkPlugins={[remarkGfm]} components={{ a: ReviewMarkdownLink }} urlTransform={reviewMarkdownUrlTransform}>
              {review.markdown || '原始日志对象暂不可用。'}
            </ReactMarkdown>
          </article>
        </section>
      </div>
    </main>
  );
}

function RiskBadge({ level, count }: { level: string; count: number }) {
  return <span className="risk-chip" data-severity={level}>{level} {count}</span>;
}
