import type { ReviewProjectDirectoryItem } from '@/lib/reviews';

type Props = {
  projects: ReviewProjectDirectoryItem[];
};

const SYNC_STATUS_LABELS: Record<ReviewProjectDirectoryItem['syncStatus'], string> = {
  waiting: '等待首次同步',
  manual_only: '尚无自动同步',
  healthy: '同步正常',
  attention: '同步结果待检查',
};

export default function ProjectDirectory({ projects }: Props) {
  return (
    <div className="grid gap-4 md:grid-cols-2">
      {projects.map((project) => (
        <a
          key={project.id}
          href={`/projects/${project.slug}`}
          className="group rounded-3xl border border-[#d7e2d8] bg-white p-6 shadow-[0_14px_36px_rgba(31,77,51,0.06)] transition hover:-translate-y-0.5 hover:border-[#a9c2af]"
        >
          <div className="flex items-start justify-between gap-4">
            <div>
              <p className="text-xs font-bold uppercase tracking-[0.14em] text-[#4b7c64]">
                审查项目
              </p>
              <h2 className="mt-2 text-2xl font-black text-[#18382b]">
                {project.name}
              </h2>
            </div>
            <span className="rounded-full bg-[#edf5ee] px-3 py-1.5 text-xs font-bold text-[#2b654b]">
              {SYNC_STATUS_LABELS[project.syncStatus]}
            </span>
          </div>
          <p className="mt-3 min-h-12 text-sm leading-6 text-[#5e7065]">
            {project.description || '查看该项目的 SVN 审查日志、问题、统计和归档。'}
          </p>
          <div className="mt-5 grid gap-2 border-t border-[#e7eee8] pt-4 text-sm text-[#51665a] sm:grid-cols-3">
            <span>{project.latestReviewDate ? `最近审查：${project.latestReviewDate}` : '等待首次同步'}</span>
            <span>待处理问题 {project.openIssueCount}</span>
            <span>P1/P2 风险 {project.highRiskCount}</span>
          </div>
          <p className="mt-5 text-sm font-bold text-[#1d684d]">
            进入项目 <span aria-hidden="true">→</span>
          </p>
        </a>
      ))}
      {!projects.length && (
        <div className="rounded-3xl border border-dashed border-[#bfcfc1] px-6 py-14 text-center text-sm text-[#617268] md:col-span-2">
          当前没有启用的审查项目。
        </div>
      )}
    </div>
  );
}
