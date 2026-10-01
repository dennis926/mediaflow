import { useQuery } from '@tanstack/react-query';
import { useNavigate } from 'react-router-dom';
import { useEffect, useState } from 'react';
import { authApi } from '../lib/api/endpoints';
import { clearSession, getRefreshToken } from '../lib/api/client';
import { useQueryClient } from '@tanstack/react-query';

/**
 * 临时密码强制改密（P1-4）。
 *
 * 服务端会拦住持临时密码的其它请求（403），所以移动端必须在登录后立刻把用户送到
 * 改密表单，而不是让他自己去「我的」页面找。改密成功后失效 me 查询，本组件自动卸载。
 */
export function MustChangePasswordGate({ children }: { children: React.ReactNode }) {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const profile = useQuery({ queryKey: ['h5', 'auth', 'me'], queryFn: () => authApi.me() });
  const [leaving, setLeaving] = useState(false);

  const required = profile.data?.mustChangePassword === true;

  useEffect(() => {
    if (required) navigate('/profile', { replace: true });
  }, [required, navigate]);

  const handleLogout = (): void => {
    setLeaving(true);
    void authApi
      .logout(getRefreshToken() ?? undefined)
      .catch(() => undefined)
      .finally(() => {
        clearSession();
        queryClient.clear();
        navigate('/login', { replace: true });
      });
  };

  if (required) {
    return (
      <div className="page" style={{ padding: 'var(--mf-space-5)', textAlign: 'center' }}>
        <div className="card" style={{ padding: 'var(--mf-space-5)' }}>
          <h2 style={{ marginBottom: 'var(--mf-space-3)' }}>请先修改初始密码</h2>
          <p style={{ color: 'var(--mf-color-text-muted)', marginBottom: 'var(--mf-space-4)' }}>
            你正在使用管理员分配的临时密码，修改后才能使用其它功能。
          </p>
          <button
            type="button"
            className="btn btn-primary btn-block"
            onClick={() => navigate('/profile', { replace: true })}
          >
            去修改密码
          </button>
          <button
            type="button"
            className="btn btn-ghost btn-block"
            style={{ marginTop: 'var(--mf-space-2)' }}
            disabled={leaving}
            onClick={handleLogout}
          >
            退出登录
          </button>
        </div>
      </div>
    );
  }

  return <>{children}</>;
}
