/// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
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

  it('归档筛选控件变更后刷新首屏并沿用日期、级别、状态、Revision、提交人和关键词', async () => {
    const fetchMock = vi.spyOn(global, 'fetch');
    fetchMock
      .mockResolvedValueOnce(new Response(JSON.stringify({ items: [{ ...archivedReview, id: 7, title: '筛选归档' }], nextCursor: 'archive-next', hasMore: true }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ items: [{ ...archivedReview, id: 6, title: '筛选归档下一页' }], nextCursor: null, hasMore: false }), { status: 200 }));
    render(<ArchiveExplorer initialItems={[archivedReview]} initialCursor="old-next" initialHasMore />);

    fireEvent.change(screen.getByLabelText('开始日期'), { target: { value: '2026-08-01' } });
    fireEvent.change(screen.getByLabelText('结束日期'), { target: { value: '2026-08-27' } });
    fireEvent.change(screen.getByLabelText('按严重级别筛选'), { target: { value: 'P1' } });
    fireEvent.change(screen.getByLabelText('按问题状态筛选'), { target: { value: 'open' } });
    fireEvent.change(screen.getByLabelText('按 Revision 筛选'), { target: { value: '53365' } });
    fireEvent.change(screen.getByLabelText('按提交人筛选'), { target: { value: 'alice' } });
    fireEvent.change(screen.getByLabelText('搜索归档日志'), { target: { value: '权限' } });
    await userEvent.click(screen.getByRole('button', { name: '应用筛选' }));
    expect(await screen.findByText('筛选归档')).toBeTruthy();
    expect(screen.queryByText('已归档日志')).toBeNull();
    expect(window.location.search).toContain('fromDate=2026-08-01');
    expect(window.location.search).toContain('toDate=2026-08-27');
    expect(window.location.search).toContain('severity=P1');
    expect(window.location.search).toContain('status=open');
    expect(window.location.search).toContain('revision=53365');
    expect(window.location.search).toContain('author=alice');
    expect(window.location.search).toContain('keyword=%E6%9D%83%E9%99%90');
    const firstUrl = String(fetchMock.mock.calls.at(-1)?.[0]);
    expect(firstUrl).toContain('scope=archived');
    expect(firstUrl).toContain('fromDate=2026-08-01');
    expect(firstUrl).toContain('toDate=2026-08-27');
    expect(firstUrl).toContain('severity=P1');
    expect(firstUrl).toContain('status=open');
    expect(firstUrl).toContain('revision=53365');
    expect(firstUrl).toContain('author=alice');
    expect(firstUrl).toContain('keyword=%E6%9D%83%E9%99%90');

    await userEvent.click(screen.getByRole('button', { name: '加载更多归档日志' }));
    expect(await screen.findByText('筛选归档下一页')).toBeTruthy();
    const nextUrl = String(fetchMock.mock.calls.at(-1)?.[0]);
    expect(nextUrl).toContain('cursor=archive-next');
    expect(nextUrl).toContain('author=alice');
    expect(nextUrl).toContain('keyword=%E6%9D%83%E9%99%90');
    expect(screen.queryByText('已归档日志')).toBeNull();
  });

  it('连续快速应用筛选时旧响应不能覆盖最新结果、筛选和分页游标', async () => {
    const fetchMock = vi.spyOn(global, 'fetch');
    let resolveFirst!: (response: Response) => void;
    let resolveSecond!: (response: Response) => void;
    fetchMock
      .mockImplementationOnce(() => new Promise<Response>((resolve) => { resolveFirst = resolve; }))
      .mockImplementationOnce(() => new Promise<Response>((resolve) => { resolveSecond = resolve; }));

    render(<ArchiveExplorer initialItems={[archivedReview]} initialCursor={null} initialHasMore={false} />);

    fireEvent.change(screen.getByLabelText('按提交人筛选'), { target: { value: 'alice' } });
    await userEvent.click(screen.getByRole('button', { name: '应用筛选' }));
    fireEvent.change(screen.getByLabelText('按提交人筛选'), { target: { value: 'bob' } });
    await userEvent.click(screen.getByRole('button', { name: '应用筛选' }));

    resolveSecond(new Response(JSON.stringify({
      items: [{ ...archivedReview, id: 7, title: 'bob 归档' }], nextCursor: 'bob-next', hasMore: true,
    }), { status: 200 }));
    expect(await screen.findByText('bob 归档')).toBeTruthy();
    expect((screen.getByLabelText('当前筛选链接') as HTMLInputElement).value).toContain('author=bob');

    resolveFirst(new Response(JSON.stringify({
      items: [{ ...archivedReview, id: 6, title: 'alice 归档' }], nextCursor: 'alice-next', hasMore: true,
    }), { status: 200 }));
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(screen.queryByText('alice 归档')).toBeNull();
    expect((screen.getByLabelText('当前筛选链接') as HTMLInputElement).value).toContain('author=bob');

    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({ items: [], nextCursor: null, hasMore: false }), { status: 200 }));
    await userEvent.click(screen.getByRole('button', { name: '加载更多归档日志' }));
    const nextUrl = String(fetchMock.mock.calls.at(-1)?.[0]);
    expect(nextUrl).toContain('author=bob');
    expect(nextUrl).toContain('cursor=bob-next');
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
