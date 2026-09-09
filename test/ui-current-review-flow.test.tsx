/// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import ReviewExplorer from '../app/review-explorer';
import IssueExplorer from '../app/issues/issue-explorer';
import IssueStatusPanel from '../app/components/issue-status-panel';
import ThemeSwitcher from '../app/components/theme-switcher';
import HomeQuickSearch from '../app/components/home-quick-search';
import ProjectDirectory from '../app/components/project-directory';
import ProjectSwitcher from '../app/components/project-switcher';

const review = {
  id: 1, logDate: '2026-08-27', title: '当前日志', overview: '摘要', scopeText: '',
  sourceName: 'review.md', revisionCount: 1, reviewedCount: 1, skippedCount: 0,
  p1Count: 1, p2Count: 0, p3Count: 0, syncMode: 'automation', importedAt: '', updatedAt: '', archivedAt: null,
};

const issue = {
  id: 42, reviewId: 1, issueKey: 'issue-42', severity: 'P1' as const, title: '权限问题', relatedRevisions: '100',
  status: 'open' as const, statusNote: null, statusUpdatedAt: null, sourceCurrent: 1, version: 0,
  logDate: '2026-08-27', reviewTitle: '当前日志', authors: 'alice',
};

const zherpReviewProps = {
  projectBasePath: '/projects/zherp',
  reviewsApiPath: '/api/projects/zherp/reviews',
};

const zherpIssueProps = {
  projectBasePath: '/projects/zherp',
  issuesApiPath: '/api/projects/zherp/issues',
  issuesExportPath: '/api/issues/export',
};

describe('当前审查协作 UI', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    cleanup();
    window.history.replaceState({}, '', '/');
  });

  it('首页加载更多追加 API 返回的下一页', async () => {
    vi.spyOn(global, 'fetch').mockResolvedValue(new Response(JSON.stringify({ items: [{ ...review, id: 2, logDate: '2026-08-26' }], nextCursor: null, hasMore: false }), { status: 200 }));
    render(<ReviewExplorer initialItems={[review]} initialCursor="next" initialHasMore {...zherpReviewProps} />);
    await userEvent.click(screen.getByRole('button', { name: '加载更多日志' }));
    expect(await screen.findByText('2026-08-26')).toBeTruthy();
    expect(fetch).toHaveBeenCalledWith('/api/projects/zherp/reviews?scope=active&cursor=next');
  });

  it('项目目录展示项目状态和统计，并从项目卡进入独立首页', () => {
    render(<ProjectDirectory projects={[
      {
        id: 2, name: '海华项目', slug: 'haihua', description: '海华专项审查', displayOrder: 10,
        latestReviewDate: '2026-08-31', openIssueCount: 3, highRiskCount: 1,
        latestAutomationSyncAt: '2026-08-31T10:00:00.000Z', syncStatus: 'healthy',
      },
      {
        id: 1, name: 'ZHERP', slug: 'zherp', description: '', displayOrder: 20,
        latestReviewDate: null, openIssueCount: 0, highRiskCount: 0,
        latestAutomationSyncAt: null, syncStatus: 'waiting',
      },
    ]} />);

    expect(screen.getByRole('link', { name: /海华项目/ }).getAttribute('href')).toBe('/projects/haihua');
    expect(screen.getByText('最近审查：2026-08-31')).toBeTruthy();
    expect(screen.getByText('待处理问题 3')).toBeTruthy();
    expect(screen.getByText('P1/P2 风险 1')).toBeTruthy();
    expect(screen.getByText('最近接收正常')).toBeTruthy();
    expect(screen.getAllByText('等待首次同步')).toHaveLength(2);
  });

  it('项目目录独立显示，项目切换下拉只保留项目列表并支持键盘和外部点击关闭', async () => {
    const fetchMock = vi.spyOn(global, 'fetch').mockResolvedValue(new Response(JSON.stringify({
      items: [{ ...review, id: 2, logDate: '2026-08-26' }], nextCursor: null, hasMore: false,
    }), { status: 200 }));
    render(<>
      <ProjectSwitcher
        currentSlug="haihua"
        projects={[{ name: '海华项目', slug: 'haihua' }, { name: 'ZHERP', slug: 'zherp' }]}
      />
      <HomeQuickSearch action="/projects/haihua/issues" />
      <ReviewExplorer
        initialItems={[review]}
        initialCursor="next"
        initialHasMore
        projectBasePath="/projects/haihua"
        reviewsApiPath="/api/projects/haihua/reviews"
      />
    </>);

    const trigger = screen.getByRole('button', { name: '切换审查项目' });
    expect(screen.getByRole('link', { name: '项目目录' }).getAttribute('href')).toBe('/');
    expect(trigger.getAttribute('aria-expanded')).toBe('false');
    expect(screen.queryByRole('link', { name: '切换到 ZHERP' })).toBeNull();

    await userEvent.click(trigger);
    expect(trigger.getAttribute('aria-expanded')).toBe('true');
    expect(screen.getByRole('link', { name: '切换到 ZHERP' }).getAttribute('href')).toBe('/projects/zherp');
    expect(screen.queryByRole('link', { name: '查看全部项目' })).toBeNull();
    expect(screen.queryByText('审查项目')).toBeNull();
    expect(screen.getByText('当前项目', { selector: '.project-switcher-current' })).toBeTruthy();

    await userEvent.keyboard('{Escape}');
    expect(trigger.getAttribute('aria-expanded')).toBe('false');
    expect(document.activeElement).toBe(trigger);

    await userEvent.click(trigger);
    fireEvent.pointerDown(document.body);
    expect(trigger.getAttribute('aria-expanded')).toBe('false');

    trigger.focus();
    await userEvent.keyboard('{ArrowDown}');
    expect(trigger.getAttribute('aria-expanded')).toBe('true');
    expect(document.activeElement).toBe(screen.getByRole('link', { name: '当前项目：海华项目' }));
    expect(screen.getByRole('search').getAttribute('action')).toBe('/projects/haihua/issues');
    expect(screen.getByRole('link', { name: '打开审查日志 →' }).getAttribute('href')).toBe('/projects/haihua/reviews/1');
    await userEvent.click(screen.getByRole('button', { name: '加载更多日志' }));
    expect(fetchMock).toHaveBeenCalledWith('/api/projects/haihua/reviews?scope=active&cursor=next');
  });

  it('项目问题看板只使用当前项目的页面和查询接口', async () => {
    const fetchMock = vi.spyOn(global, 'fetch').mockResolvedValue(new Response(JSON.stringify({
      items: [issue], nextCursor: null, hasMore: false,
    }), { status: 200 }));
    render(<IssueExplorer
      initialItems={[issue]}
      initialCursor={null}
      initialHasMore={false}
      projectBasePath="/projects/haihua"
      issuesApiPath="/api/projects/haihua/issues"
      issuesExportPath="/api/projects/haihua/issues/export"
    />);

    expect(screen.getByRole('link', { name: '打开原日志 →' }).getAttribute('href')).toBe('/projects/haihua/reviews/1#issue-42');
    expect(screen.getByRole('link', { name: '导出 Excel 跟进表' }).getAttribute('href')).toContain('/api/projects/haihua/issues/export?');
    await userEvent.click(screen.getByRole('button', { name: '应用筛选' }));
    expect(String(fetchMock.mock.calls[0]?.[0])).toContain('/api/projects/haihua/issues?');
    expect(window.location.pathname).toBe('/projects/haihua/issues');
  });

  it('问题卡片带数据库锚点和当前筛选操作', () => {
    window.history.pushState({}, '', '/projects/zherp/issues?status=open&severity=P1');
    render(<IssueExplorer initialItems={[issue]} initialCursor={null} initialHasMore {...zherpIssueProps} />);
    expect(document.getElementById('issue-42')).toBeTruthy();
    expect(screen.getByRole('link', { name: '打开原日志 →' }).getAttribute('href')).toBe('/projects/zherp/reviews/1#issue-42');
    expect(screen.getByRole('button', { name: '复制当前筛选链接' })).toBeTruthy();
    expect(screen.getByRole('link', { name: '导出 Excel 跟进表' }).getAttribute('href')).toContain('status=open&severity=P1');
    expect(document.querySelector('#issue-42 [data-severity="P1"]')?.textContent).toBe('P1');
    expect(document.querySelector('#issue-42 [data-status="open"]')?.textContent).toBe('待处理');
  });

  it('严重级别和状态下拉框暴露当前选中值供主题着色', async () => {
    render(<IssueExplorer initialItems={[issue]} initialCursor={null} initialHasMore={false} {...zherpIssueProps} />);
    const severity = screen.getByLabelText('按严重级别筛选');
    const status = screen.getByLabelText('按状态筛选');
    expect(severity.getAttribute('data-severity')).toBe('all');
    expect(status.getAttribute('data-status')).toBe('active');
    await userEvent.selectOptions(severity, 'P2');
    await userEvent.selectOptions(status, 'resolved');
    expect(severity.getAttribute('data-severity')).toBe('P2');
    expect(status.getAttribute('data-status')).toBe('resolved');
  });

  it('主题切换保存并恢复本机偏好', async () => {
    render(<ThemeSwitcher />);
    await userEvent.click(screen.getByRole('button', { name: '夜间专注' }));
    await waitFor(() => expect(document.documentElement.dataset.theme).toBe('night'));
    expect(window.localStorage.getItem('review-portal-theme')).toBe('night');

    cleanup();
    document.documentElement.dataset.theme = '';
    render(<ThemeSwitcher />);
    await waitFor(() => expect(document.documentElement.dataset.theme).toBe('night'));
    await waitFor(() => expect(screen.getByRole('button', { name: '夜间专注' }).getAttribute('aria-pressed')).toBe('true'));
  });

  it('主页快捷查询用原生 GET 将关键词、Revision 和日期带到问题看板', () => {
    render(<HomeQuickSearch action="/projects/zherp/issues" />);
    const form = screen.getByRole('search');
    expect(form.getAttribute('action')).toBe('/projects/zherp/issues');
    expect(form.getAttribute('method')).toBe('get');
    expect(screen.getByLabelText('快捷关键词').getAttribute('name')).toBe('q');
    expect(screen.getByLabelText('快捷 Revision').getAttribute('name')).toBe('revision');
    expect(screen.getByLabelText('快捷日期').getAttribute('name')).toBe('from');
  });

  it('问题筛选将次要条件收入更多条件，并可重置为默认范围', async () => {
    const fetchMock = vi.spyOn(global, 'fetch').mockResolvedValue(new Response(JSON.stringify({
      items: [issue], nextCursor: null, hasMore: false,
    }), { status: 200 }));
    render(<IssueExplorer initialItems={[issue]} initialCursor={null} initialHasMore {...zherpIssueProps} />);

    expect(screen.queryByLabelText('按作者筛选')).toBeNull();
    await userEvent.click(screen.getByRole('button', { name: '更多条件' }));
    fireEvent.change(screen.getByLabelText('按作者筛选'), { target: { value: 'alice' } });
    await userEvent.click(screen.getByRole('button', { name: '应用筛选' }));
    expect(String(fetchMock.mock.calls[0]?.[0])).toContain('author=alice');

    await userEvent.click(screen.getByRole('button', { name: '重置' }));
    expect((screen.getByLabelText('按作者筛选') as HTMLInputElement).value).toBe('');
    expect(window.location.search).toBe('');
    expect(String(fetchMock.mock.calls[1]?.[0])).not.toContain('author=');
  });

  it('P1 + P2 联合筛选保留两个严重级别到查询与 Excel 导出', async () => {
    const fetchMock = vi.spyOn(global, 'fetch').mockResolvedValue(new Response(JSON.stringify({
      items: [issue], nextCursor: null, hasMore: false,
    }), { status: 200 }));
    render(<IssueExplorer initialItems={[issue]} initialCursor={null} initialHasMore {...zherpIssueProps} />);

    await userEvent.selectOptions(screen.getByLabelText('按严重级别筛选'), 'P1,P2');
    await userEvent.click(screen.getByRole('button', { name: '应用筛选' }));

    expect(String(fetchMock.mock.calls[0]?.[0])).toContain('severity=P1&severity=P2');
    expect(screen.getByRole('link', { name: '导出 Excel 跟进表' }).getAttribute('href')).toContain('severity=P1&severity=P2');
  });

  it('切换问题筛选后重置分页，并只追加新筛选的后续页', async () => {
    const fetchMock = vi.spyOn(global, 'fetch');
    fetchMock
      .mockResolvedValueOnce(new Response(JSON.stringify({
        items: [{ ...issue, id: 43, title: '已解决问题', status: 'resolved' }],
        nextCursor: 'resolved-next', hasMore: true,
      }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        items: [{ ...issue, id: 44, title: '已解决问题下一页', status: 'resolved' }],
        nextCursor: null, hasMore: false,
      }), { status: 200 }));
    render(<IssueExplorer initialItems={[issue]} initialCursor="open-next" initialHasMore {...zherpIssueProps} />);

    await userEvent.selectOptions(screen.getByLabelText('按状态筛选'), 'resolved');
    await userEvent.click(screen.getByRole('button', { name: '应用筛选' }));
    expect(await screen.findByText(/已解决问题/)).toBeTruthy();
    expect(screen.queryByText(/权限问题/)).toBeNull();
    expect(String(fetchMock.mock.calls[0]?.[0])).toContain('status=resolved');
    expect(String(fetchMock.mock.calls[0]?.[0])).not.toContain('cursor=');

    await userEvent.click(screen.getByRole('button', { name: '加载更多问题' }));
    expect(await screen.findByText(/已解决问题下一页/)).toBeTruthy();
    expect(String(fetchMock.mock.calls[1]?.[0])).toContain('status=resolved');
    expect(String(fetchMock.mock.calls[1]?.[0])).toContain('cursor=resolved-next');
    expect(screen.queryByText(/权限问题/)).toBeNull();
  });

  it('日期和 Revision 筛选可见，刷新首屏并让加载更多沿用全部参数', async () => {
    const fetchMock = vi.spyOn(global, 'fetch');
    fetchMock.mockImplementation((input) => Promise.resolve(new Response(JSON.stringify({ items: [input.toString().includes('cursor=') ? { ...issue, id: 46, title: '日期版本下一页' } : { ...issue, id: 45, title: '日期版本问题' }], nextCursor: input.toString().includes('cursor=') ? null : 'filtered-next', hasMore: !input.toString().includes('cursor=') }), { status: 200 })));
    render(<IssueExplorer initialItems={[issue]} initialCursor="old-next" initialHasMore {...zherpIssueProps} />);

    await userEvent.click(screen.getByRole('button', { name: '更多条件' }));
    fireEvent.change(screen.getByLabelText('开始日期'), { target: { value: '2026-08-01' } });
    fireEvent.change(screen.getByLabelText('结束日期'), { target: { value: '2026-08-27' } });
    fireEvent.change(screen.getByLabelText('按 Revision 筛选'), { target: { value: '53365' } });
    await userEvent.click(screen.getByRole('button', { name: '应用筛选' }));
    expect(await screen.findByText(/日期版本问题/)).toBeTruthy();
    expect(screen.queryByText('权限问题')).toBeNull();
    expect(window.location.search).toContain('from=2026-08-01');
    expect(window.location.search).toContain('to=2026-08-27');
    expect(window.location.search).toContain('revision=53365');
    expect(String(fetchMock.mock.calls.at(-1)?.[0])).toContain('fromDate=2026-08-01');
    expect(String(fetchMock.mock.calls.at(-1)?.[0])).toContain('toDate=2026-08-27');
    expect(String(fetchMock.mock.calls.at(-1)?.[0])).toContain('revision=53365');

    await userEvent.click(screen.getByRole('button', { name: '加载更多问题' }));
    expect(await screen.findByText(/日期版本下一页/)).toBeTruthy();
    const nextUrl = String(fetchMock.mock.calls.at(-1)?.[0]);
    expect(nextUrl).toContain('fromDate=2026-08-01');
    expect(nextUrl).toContain('toDate=2026-08-27');
    expect(nextUrl).toContain('revision=53365');
    expect(nextUrl).toContain('cursor=filtered-next');
    expect(screen.queryByText('权限问题')).toBeNull();
  });

  it('只读状态面板仍显示处理信息，但不提供保存操作', () => {
    render(
      <IssueStatusPanel
        issue={{ ...issue, statusNote: '已归档说明' }}
        statusApiPath="/api/projects/zherp/issues/42/status"
        readOnly
      />,
    );
    expect(screen.getByText('当前状态：待处理').getAttribute('data-status')).toBe('open');
    expect(screen.getByText('处理说明：已归档说明')).toBeTruthy();
    expect(screen.queryByRole('button', { name: '保存状态' })).toBeNull();
  });

  it('状态更新成功显示新状态，409 保留说明', async () => {
    const fetchMock = vi.spyOn(global, 'fetch');
    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({ id: 42, status: 'resolved', statusNote: '已修复', statusUpdatedAt: '2026-08-27T12:00:00.000Z', version: 1 }), { status: 200 }));
    render(
      <IssueStatusPanel
        issue={{ ...issue }}
        statusApiPath="/api/projects/haihua/issues/42/status"
      />,
    );
    const note = screen.getByLabelText('处理说明');
    await userEvent.type(note, '已修复');
    await userEvent.click(screen.getByRole('button', { name: '保存状态' }));
    expect(await screen.findByText('状态已更新。')).toBeTruthy();
    expect(screen.getByText('处理说明：已修复')).toBeTruthy();
    expect(fetchMock).toHaveBeenLastCalledWith(
      '/api/projects/haihua/issues/42/status',
      expect.objectContaining({ method: 'PATCH' }),
    );

    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({ error: '问题版本已变化，请刷新后重试。', currentVersion: 2 }), { status: 409 }));
    await userEvent.clear(note);
    await userEvent.type(note, '保留这段说明');
    await userEvent.click(screen.getByRole('button', { name: '保存状态' }));
    await waitFor(() => expect(screen.getByDisplayValue('保留这段说明')).toBeTruthy());
    expect(screen.getByRole('alert').textContent).toContain('问题版本已变化');
  });
});
