type ProjectOption = {
  name: string;
  slug: string;
};

type Props = {
  currentSlug: string;
  projects: ProjectOption[];
};

export default function ProjectSwitcher({ currentSlug, projects }: Props) {
  return (
    <nav aria-label="切换审查项目" className="flex flex-wrap items-center gap-2">
      {projects.map((project) => (
        <a
          key={project.slug}
          href={`/projects/${project.slug}`}
          aria-label={project.slug === currentSlug ? `当前项目：${project.name}` : `切换到 ${project.name}`}
          aria-current={project.slug === currentSlug ? 'page' : undefined}
          className={project.slug === currentSlug
            ? 'rounded-full bg-[#1d5b46] px-3 py-1.5 text-xs font-bold text-white'
            : 'rounded-full border border-[#c7d5c8] bg-white px-3 py-1.5 text-xs font-bold text-[#3f6151] hover:bg-[#edf4ee]'}
        >
          {project.name}
        </a>
      ))}
    </nav>
  );
}
