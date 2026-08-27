'use client';

import { useEffect, useState } from 'react';

type Theme = 'office' | 'green' | 'night';

const themes: Array<{ value: Theme; label: string }> = [
  { value: 'office', label: '柔和办公' },
  { value: 'green', label: '工程绿' },
  { value: 'night', label: '夜间专注' },
];

function applyTheme(theme: Theme) {
  document.documentElement.dataset.theme = theme;
  window.localStorage.setItem('review-portal-theme', theme);
}

export default function ThemeSwitcher() {
  const [theme, setTheme] = useState<Theme>('office');

  useEffect(() => {
    const saved = window.localStorage.getItem('review-portal-theme');
    const next = themes.some((item) => item.value === saved) ? saved as Theme : 'office';
    applyTheme(next);
    if (next === theme) return;
    const timer = window.setTimeout(() => setTheme(next), 0);
    return () => window.clearTimeout(timer);
  }, [theme]);

  return (
    <div className="theme-switcher" aria-label="界面主题">
      <span>主题</span>
      <div className="theme-switcher-options">
        {themes.map((item) => (
          <button
            key={item.value}
            type="button"
            aria-pressed={theme === item.value}
            onClick={() => { setTheme(item.value); applyTheme(item.value); }}
          >
            {item.label}
          </button>
        ))}
      </div>
    </div>
  );
}
