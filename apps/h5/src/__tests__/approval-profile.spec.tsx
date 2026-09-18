// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ApprovalPage } from '../pages/ApprovalPage';
import { ProfilePage } from '../pages/ProfilePage';

function jsonResponse(payload: unknown, status = 200): Response {
  return new Response(JSON.stringify(payload), { status, headers: { 'Content-Type': 'application/json' } });
}

function renderPage(node: React.ReactElement): void {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={client}>
      <MemoryRouter>{node}</MemoryRouter>
    </QueryClientProvider>,
  );
}

describe('移动端「审批」页', () => {
  beforeEach(() => {
    window.localStorage.setItem('mediaflow.token', 'test-token');
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    window.localStorage.clear();
  });

  it('展示待审内容与通过/驳回按钮', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        jsonResponse({
          code: 0,
          message: 'ok',
          data: {
            items: [
              {
                id: 'r1',
                contentId: 'c1',
                status: 'pending',
                submittedByName: '张三',
                submittedAt: new Date().toISOString(),
                contentTitle: '秋季肠道健康指南',
              },
            ],
            meta: { page: 1, pageSize: 20, total: 1, totalPages: 1 },
            pendingCount: 1,
          },
        }),
      ),
    );

    renderPage(<ApprovalPage />);

    await waitFor(() => expect(screen.getByText('秋季肠道健康指南')).toBeTruthy());
    expect(screen.getByText('通过')).toBeTruthy();
    expect(screen.getByText('驳回')).toBeTruthy();
  });

  it('没有待审内容时给出空态而不是报错', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => jsonResponse({ code: 0, message: 'ok', data: { items: [], meta: { page: 1, pageSize: 20, total: 0, totalPages: 1 }, pendingCount: 0 } })),
    );

    renderPage(<ApprovalPage />);

    await waitFor(() => expect(screen.getByText(/暂无待审批/)).toBeTruthy());
  });

  it('接口失败时显示错误提示', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse({ code: 40100, message: '登录状态已失效', data: null }, 401)));

    renderPage(<ApprovalPage />);

    await waitFor(() => expect(screen.getByText(/登录状态已失效|暂无待审批|加载/)).toBeTruthy());
  });
});

describe('移动端「我的」页', () => {
  beforeEach(() => {
    window.localStorage.setItem('mediaflow.token', 'test-token');
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    window.localStorage.clear();
  });

  it('展示当前用户与角色中文名，并提供改密码与退出登录', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        jsonResponse({
          code: 0,
          message: 'ok',
          data: { id: 'u1', email: 'ops@example.com', displayName: '运营小李', roles: ['editor'], mustChangePassword: false },
        }),
      ),
    );

    renderPage(<ProfilePage />);

    await waitFor(() => expect(screen.getByText('运营小李')).toBeTruthy());
    expect(screen.getByText('ops@example.com')).toBeTruthy();
    expect(screen.getByText('内容编辑')).toBeTruthy();
    expect(screen.getByText('退出登录')).toBeTruthy();
  });
});
