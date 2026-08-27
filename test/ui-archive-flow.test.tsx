/// @vitest-environment jsdom

import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import ArchiveExplorer from '../app/archive/archive-explorer';
import ArchiveManager from '../app/admin/archive-manager';

const activeReview = {
  id: 1,
  logDate: '2026-08-27',
  title: '当前日志',
  overview: '摘要',
  scopeText: '',
  sourceName: 'review.md',
  revisionCount: 2,
  reviewedCount: 2,
  skippedCount: 0,
  p1Count: 1,
  p2Count: 0,
  p3Count: 0,
  syncMode: 'automation',
  importedAt: '',
  updatedAt: '',
  archivedAt: null,
};

const archivedReview = {
  ...activeReview,
  id: 9,
  logDate: '2026-08-20',
  title: '已归档日志',
  archivedAt: '2026-08-27T10:00:00.000Z',
};

const emptyPage = { items: [], nextCursor: null, hasMore: false };

describe('归档库与归档管理 UI', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    cleanup();
    window.history.replaceState({}, '', '/');
  });

  it('归档库加载更多时保留归档范围和当前筛选', async () => {
    vi.spyOn(global, 'fetch').mockResolvedValue(new Response(JSON.stringify({
      items: [{ ...archivedReview, id: 8, logDate: '2026-08-19' }],
      nextCursor: null,
      hasMore: false,
    }), { status: 200 }));

    render(<ArchiveExplorer
      initialItems={[archivedReview]}
      initialCursor="next page"
      initialHasMore
      filters={{ author: 'alice', revision: '53365', status: 'open', keyword: '权限' }}
    />);

    await userEvent.click(screen.getByRole('button', { name: '加载更多归档日志' }));

    expect(await screen.findByText('2026-08-19')).toBeTruthy();
    const requestUrl = String(vi.mocked(fetch).mock.calls[0]?.[0]);
    expect(requestUrl).toContain('scope=archived');
    expect(requestUrl).toContain('author=alice');
    expect(requestUrl).toContain('revision=53365');
    expect(requestUrl).toContain('status=open');
    expect(requestUrl).toContain('keyword=%E6%9D%83%E9%99%90');
    expect(requestUrl).toContain('cursor=next+page');
  });

  it('显式选择日志后先预览，确认时只提交预览令牌', async () => {
    const fetchMock = vi.spyOn(global, 'fetch');
    fetchMock
      .mockResolvedValueOnce(new Response(JSON.stringify({
        previewToken: 'preview-1', reviewCount: 1, revisionCount: 2, issueCount: 1, openIssueCount: 1,
      }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ archivedCount: 1 }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify(emptyPage), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ items: [archivedReview], nextCursor: null, hasMore: false }), { status: 200 }));

    render(<ArchiveManager
      initialActive={{ items: [activeReview], nextCursor: null, hasMore: false }}
      initialArchived={emptyPage}
    />);

    await userEvent.click(screen.getByRole('checkbox', { name: /当前日志/ }));
    await userEvent.click(screen.getByRole('button', { name: '预览所选日志' }));

    expect(await screen.findByText(/将归档 1 份日志/)).toBeTruthy();
    expect(JSON.parse(String(vi.mocked(fetch).mock.calls[0]?.[1]?.body))).toEqual({ mode: 'preview', ids: [1] });

    await userEvent.click(screen.getByRole('button', { name: '确认归档' }));
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(4));
    expect(JSON.parse(String(vi.mocked(fetch).mock.calls[1]?.[1]?.body))).toEqual({
      mode: 'confirm', previewToken: 'preview-1',
    });
    expect(await screen.findByText('已归档 1 份日志。')).toBeTruthy();
  });

  it('按当前筛选预览时发送筛选条件并展示服务端总数', async () => {
    vi.spyOn(global, 'fetch')
      .mockResolvedValueOnce(new Response(JSON.stringify({ items: [activeReview], nextCursor: null, hasMore: false }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        previewToken: 'preview-filter', reviewCount: 27, revisionCount: 45, issueCount: 8, openIssueCount: 3,
      }), { status: 200 }));

    render(<ArchiveManager
      initialActive={{ items: [activeReview], nextCursor: null, hasMore: false }}
      initialArchived={emptyPage}
    />);

    await userEvent.type(screen.getByLabelText('按作者筛选活动日志'), 'alice');
    await userEvent.selectOptions(screen.getByLabelText('按问题状态筛选活动日志'), 'open');
    await userEvent.click(screen.getByRole('button', { name: '应用筛选' }));
    await userEvent.click(screen.getByRole('button', { name: '预览当前筛选全部日志' }));

    const previewCall = vi.mocked(fetch).mock.calls.at(-1)!;
    expect(JSON.parse(String(previewCall[1]?.body))).toEqual({
      mode: 'preview', filters: { author: 'alice', status: 'open' },
    });
    expect(await screen.findByText(/将归档 27 份日志/)).toBeTruthy();
  });

  it('恢复单条归档日志后重新查询活动列表和归档列表', async () => {
    const fetchMock = vi.spyOn(global, 'fetch');
    fetchMock
      .mockResolvedValueOnce(new Response(JSON.stringify({ restoredCount: 1 }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ items: [activeReview], nextCursor: null, hasMore: false }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify(emptyPage), { status: 200 }));

    render(<ArchiveManager
      initialActive={emptyPage}
      initialArchived={{ items: [archivedReview], nextCursor: null, hasMore: false }}
    />);

    const archivedRow = screen.getByRole('article', { name: '已归档日志' });
    await userEvent.click(within(archivedRow).getByRole('button', { name: '恢复' }));

    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(3));
    expect(fetchMock).toHaveBeenNthCalledWith(1, '/api/reviews/restore', expect.objectContaining({
      method: 'POST', body: JSON.stringify({ ids: [9] }),
    }));
    expect(fetchMock).toHaveBeenNthCalledWith(2, '/api/reviews?scope=active');
    expect(fetchMock).toHaveBeenNthCalledWith(3, '/api/reviews?scope=archived');
    expect(await screen.findByText('已恢复 1 份日志。')).toBeTruthy();
  });
});
