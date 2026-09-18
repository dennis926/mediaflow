'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { ApiError, setToken } from '../../lib/api/client';
import { authApi, workspacesApi } from '../../lib/api/endpoints';
import styles from './AppShell.module.css';

/**
 * 侧边栏的工作区切换器：一个部署里可以放多个工作区（多家公司/品牌矩阵），
 * 切换会请服务端重新签发令牌，然后刷新页面。
 * 只有一个工作区时不显示，避免占地方。
 */
export function WorkspaceSwitcher(): React.JSX.Element | null {
  const queryClient = useQueryClient();
  const [error, setError] = useState('');
  const mine = useQuery({ queryKey: ['workspaces', 'mine'], queryFn: () => workspacesApi.mine(), staleTime: 60_000 });

  const switchTo = useMutation({
    mutationFn: (workspaceId: string) => authApi.switchWorkspace(workspaceId),
    onSuccess: (result) => {
      setToken(result.accessToken, result.refreshToken);
      queryClient.clear();
      window.location.reload();
    },
    onError: (caught: unknown) => setError(caught instanceof ApiError ? caught.message : '切换失败'),
  });

  const workspaces = mine.data ?? [];
  if (workspaces.length <= 1) return null;
  const current = workspaces.find((item) => item.isCurrent) ?? workspaces[0];

  return (
    <div className={styles.workspaceSwitcher}>
      <span className={styles.workspaceLabel}>工作区</span>
      <select
        className={styles.workspaceSelect}
        aria-label="切换工作区"
        value={current.id}
        disabled={switchTo.isPending}
        onChange={(event) => {
          setError('');
          if (event.target.value !== current.id) switchTo.mutate(event.target.value);
        }}
      >
        {workspaces.map((workspace) => (
          <option key={workspace.id} value={workspace.id}>
            {workspace.name}
          </option>
        ))}
      </select>
      {switchTo.isPending ? <span className={styles.workspaceLabel}>切换中…</span> : null}
      {error ? <span className={styles.workspaceError}>{error}</span> : null}
    </div>
  );
}
