/// @vitest-environment jsdom
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import ReviewExplorer from '../app/review-explorer';
import IssueExplorer from '../app/issues/issue-explorer';
import IssueStatusPanel from '../app/components/issue-status-panel';

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

describe('当前审查协作 UI', () => {
  beforeEach(() => vi.restoreAllMocks());

  it('首页加载更多追加 API 返回的下一页', async () => {
    vi.spyOn(global, 'fetch').mockResolvedValue(new Response(JSON.stringify({ items: [{ ...review, id: 2, logDate: '2026-08-26' }], nextCursor: null, hasMore: false }), { status: 200 }));
    render(<ReviewExplorer initialItems={[review]} initialCursor="next" initialHasMore />);
    await userEvent.click(screen.getByRole('button', { name: '加载更多日志' }));
    expect(await screen.findByText('2026-08-26')).toBeTruthy();
    expect(fetch).toHaveBeenCalledWith('/api/reviews?scope=active&cursor=next');
  });

  it('问题卡片带数据库锚点和当前筛选链接', () => {
    window.history.pushState({}, '', '/issues?status=open&severity=P1');
    render(<IssueExplorer initialItems={[issue]} initialCursor={null} initialHasMore />);
    expect(document.getElementById('issue-42')).toBeTruthy();
    expect(screen.getByRole('link', { name: /当前日志/ }).getAttribute('href')).toBe('/reviews/1#issue-42');
    expect((screen.getByLabelText('当前筛选链接') as HTMLInputElement).value).toContain('status=open&severity=P1');
  });

  it('状态更新成功显示新状态，409 保留说明', async () => {
    const fetchMock = vi.spyOn(global, 'fetch');
    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({ id: 42, status: 'resolved', statusNote: '已修复', statusUpdatedAt: '2026-08-27T12:00:00.000Z', version: 1 }), { status: 200 }));
    render(<IssueStatusPanel issue={{ ...issue }} />);
    const note = screen.getByLabelText('处理说明');
    await userEvent.type(note, '已修复');
    await userEvent.click(screen.getByRole('button', { name: '保存状态' }));
    expect(await screen.findByText('状态已更新。')).toBeTruthy();
    expect(screen.getByText('处理说明：已修复')).toBeTruthy();

    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({ error: '问题版本已变化，请刷新后重试。', currentVersion: 2 }), { status: 409 }));
    await userEvent.clear(note);
    await userEvent.type(note, '保留这段说明');
    await userEvent.click(screen.getByRole('button', { name: '保存状态' }));
    await waitFor(() => expect(screen.getByDisplayValue('保留这段说明')).toBeTruthy());
    expect(screen.getByRole('alert').textContent).toContain('问题版本已变化');
  });
});
