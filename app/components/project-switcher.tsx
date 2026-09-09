'use client';

import { useEffect, useRef, useState } from 'react';

type ProjectOption = {
  name: string;
  slug: string;
};

type Props = {
  currentSlug: string;
  projects: ProjectOption[];
};

export default function ProjectSwitcher({ currentSlug, projects }: Props) {
  const [open, setOpen] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const firstOptionRef = useRef<HTMLAnchorElement>(null);
  const focusFirstOnOpen = useRef(false);
  const currentProject = projects.find((project) => project.slug === currentSlug) ?? projects[0];

  useEffect(() => {
    if (open && focusFirstOnOpen.current) {
      focusFirstOnOpen.current = false;
      firstOptionRef.current?.focus();
    }
  }, [open]);

  useEffect(() => {
    if (!open) return;

    function closeOnOutsidePointer(event: PointerEvent) {
      if (!containerRef.current?.contains(event.target as Node)) setOpen(false);
    }

    function closeOnEscape(event: KeyboardEvent) {
      if (event.key !== 'Escape') return;
      setOpen(false);
      triggerRef.current?.focus();
    }

    document.addEventListener('pointerdown', closeOnOutsidePointer);
    document.addEventListener('keydown', closeOnEscape);
    return () => {
      document.removeEventListener('pointerdown', closeOnOutsidePointer);
      document.removeEventListener('keydown', closeOnEscape);
    };
  }, [open]);

  function handleTriggerKeyDown(event: React.KeyboardEvent<HTMLButtonElement>) {
    if (event.key !== 'ArrowDown') return;
    event.preventDefault();
    focusFirstOnOpen.current = true;
    setOpen(true);
  }

  function handleMenuKeyDown(event: React.KeyboardEvent<HTMLDivElement>) {
    if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) return;
    const options = Array.from(containerRef.current?.querySelectorAll<HTMLAnchorElement>('[data-project-option]') ?? []);
    const index = options.indexOf(document.activeElement as HTMLAnchorElement);
    const nextIndex = event.key === 'Home'
      ? 0
      : event.key === 'End'
        ? options.length - 1
        : event.key === 'ArrowUp'
          ? (index - 1 + options.length) % options.length
          : (index + 1) % options.length;
    event.preventDefault();
    options[nextIndex]?.focus();
  }

  if (!currentProject) return null;

  return (
    <div className="project-navigation">
      <a href="/" aria-label="项目目录" title="项目目录" className="project-directory-link">
        <svg aria-hidden="true" viewBox="0 0 20 20" width="20" height="20">
          <path d="M3 5h14M3 10h14M3 15h14" fill="none" stroke="currentColor" strokeLinecap="round" strokeWidth="1.8" />
        </svg>
      </a>
      <div ref={containerRef} className="project-switcher">
        <button
          ref={triggerRef}
          type="button"
          aria-label="切换审查项目"
          aria-expanded={open}
          aria-controls="project-switcher-menu"
          className="project-switcher-trigger"
          onClick={() => setOpen((value) => !value)}
          onKeyDown={handleTriggerKeyDown}
        >
          <span className="project-switcher-icon" aria-hidden="true">
            {currentProject.name.slice(0, 1).toUpperCase()}
          </span>
          <span className="project-switcher-copy">
            <span className="project-switcher-name">{currentProject.name}</span>
            <span className="project-switcher-caption">SVN 审查日志</span>
          </span>
          <span className="project-switcher-chevron" aria-hidden="true">▾</span>
        </button>

        {open && (
          <div id="project-switcher-menu" className="project-switcher-menu" onKeyDown={handleMenuKeyDown}>
            <nav aria-label="项目列表" className="project-switcher-options">
              {projects.map((project, index) => {
                const current = project.slug === currentSlug;
                return (
                  <a
                    ref={index === 0 ? firstOptionRef : undefined}
                    key={project.slug}
                    href={`/projects/${project.slug}`}
                    data-project-option
                    aria-label={current ? `当前项目：${project.name}` : `切换到 ${project.name}`}
                    aria-current={current ? 'page' : undefined}
                    className="project-switcher-option"
                  >
                    <span className="project-switcher-option-icon" aria-hidden="true">
                      {project.name.slice(0, 1).toUpperCase()}
                    </span>
                    <span className="min-w-0 flex-1 truncate font-bold">{project.name}</span>
                    {current && <span className="project-switcher-current">当前项目</span>}
                  </a>
                );
              })}
            </nav>
          </div>
        )}
      </div>
    </div>
  );
}
