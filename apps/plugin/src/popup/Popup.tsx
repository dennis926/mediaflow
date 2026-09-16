import { useEffect, useState } from 'react';

interface SessionState {
  loggedIn: boolean;
  pendingCount: number;
}

// Skeleton only: task list, bound accounts and login state land in the extension stage.
export function Popup() {
  const [state, setState] = useState<SessionState>({ loggedIn: false, pendingCount: 0 });

  useEffect(() => {
    void chrome.storage.local.get(['token']).then((values) => {
      setState((prev) => ({ ...prev, loggedIn: Boolean(values.token) }));
    });
  }, []);

  return (
    <div style={{ width: 360, height: 480, padding: 16, fontFamily: 'system-ui, sans-serif' }}>
      <h1 style={{ fontSize: 16, margin: '0 0 8px' }}>MediaFlow 助手</h1>
      <p style={{ fontSize: 13, color: '#64748B', margin: 0 }}>
        {state.loggedIn ? '已登录' : '未登录'}
      </p>
      <p style={{ fontSize: 13, color: '#64748B' }}>待发布任务：{state.pendingCount}</p>
      <p style={{ fontSize: 12, color: '#94A3B8' }}>插件骨架占位，功能待实现。</p>
    </div>
  );
}
