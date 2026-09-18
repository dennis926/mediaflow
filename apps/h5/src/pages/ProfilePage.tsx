import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState, type FormEvent } from 'react';
import { useNavigate } from 'react-router-dom';
import { Dialog } from '../components/Dialog';
import { PageHeader } from '../components/PageHeader';
import { ApiError, clearSession, getRefreshToken } from '../lib/api/client';
import { authApi } from '../lib/api/endpoints';
import { roleLabel, roleTone } from '../lib/roles';

interface PasswordForm {
  current: string;
  next: string;
  confirm: string;
}

interface PasswordErrors {
  current?: string;
  next?: string;
  confirm?: string;
}

const EMPTY_FORM: PasswordForm = { current: '', next: '', confirm: '' };

/** Mirrors the backend PASSWORD_RULE (8-72 chars, at least one letter and one digit). */
function validatePassword(form: PasswordForm): PasswordErrors {
  const errors: PasswordErrors = {};
  if (!form.current) errors.current = '请输入当前密码';
  if (form.next.length < 8 || form.next.length > 72) errors.next = '新密码长度需为 8-72 位';
  else if (!/[A-Za-z]/.test(form.next) || !/\d/.test(form.next)) errors.next = '新密码需同时包含字母和数字';
  else if (form.next === form.current) errors.next = '新密码不能与当前密码相同';
  if (!form.confirm) errors.confirm = '请再次输入新密码';
  else if (form.confirm !== form.next) errors.confirm = '两次输入的新密码不一致';
  return errors;
}

export function ProfilePage() {
  const navigate = useNavigate();
  const queryClient = useQueryClient();

  const profile = useQuery({ queryKey: ['h5', 'auth', 'me'], queryFn: () => authApi.me() });

  const [form, setForm] = useState<PasswordForm>(EMPTY_FORM);
  const [errors, setErrors] = useState<PasswordErrors>({});
  const [notice, setNotice] = useState<string | null>(null);
  const [failure, setFailure] = useState<string | null>(null);
  const [logoutOpen, setLogoutOpen] = useState(false);

  const changePassword = useMutation({
    mutationFn: (payload: PasswordForm) => authApi.changePassword(payload.current, payload.next),
    onSuccess: () => {
      setForm(EMPTY_FORM);
      setErrors({});
      setFailure(null);
      setNotice('密码已更新，请使用新密码登录其他设备');
      void queryClient.invalidateQueries({ queryKey: ['h5', 'auth', 'me'] });
    },
    onError: (error: unknown) => {
      setNotice(null);
      setFailure(error instanceof ApiError ? error.message : '修改密码失败，请稍后重试');
    },
  });

  const handleSubmit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setNotice(null);
    setFailure(null);
    const nextErrors = validatePassword(form);
    setErrors(nextErrors);
    if (Object.keys(nextErrors).length > 0) return;
    changePassword.mutate(form);
  };

  const handleLogout = () => {
    // 通知服务端作废刷新令牌（失败不阻塞本地登出）
    void authApi
      .logout(getRefreshToken() ?? undefined)
      .catch(() => undefined)
      .finally(() => {
        clearSession();
        queryClient.clear();
        navigate('/login', { replace: true });
      });
  };

  const user = profile.data;
  const initial = (user?.displayName?.trim() || user?.email || 'M').slice(0, 1).toUpperCase();

  return (
    <>
      <PageHeader title="我的" subtitle="账号与安全" />
      <div className="app-main">
        <div className="card profile-card">
          {profile.isLoading ? (
            <div className="skeleton" />
          ) : profile.isError || !user ? (
            <div className="banner banner-danger" role="alert">
              {profile.error instanceof ApiError ? profile.error.message : '账号信息加载失败，请稍后重试'}
            </div>
          ) : (
            <>
              <div className="profile-identity">
                <span className="avatar" aria-hidden>
                  {initial}
                </span>
                <div className="profile-text">
                  <strong>{user.displayName || '未命名成员'}</strong>
                  <span className="muted">{user.email}</span>
                </div>
              </div>
              <div className="profile-roles">
                {user.roles.length > 0 ? (
                  user.roles.map((code) => (
                    <span key={code} className={`tag tag-${roleTone(code)}`}>
                      {roleLabel(code)}
                    </span>
                  ))
                ) : (
                  <span className="tag tag-default">未分配角色</span>
                )}
              </div>
            </>
          )}
        </div>

        {user?.mustChangePassword ? (
          <div className="banner banner-warning" role="alert" style={{ marginTop: 'var(--mf-space-3)' }}>
            你正在使用管理员分配的临时密码，请立即修改后再继续使用。
          </div>
        ) : null}

        {notice ? (
          <div className="banner banner-info" role="status" style={{ marginTop: 'var(--mf-space-3)' }}>
            {notice}
          </div>
        ) : null}
        {failure ? (
          <div className="banner banner-danger" role="alert" style={{ marginTop: 'var(--mf-space-3)' }}>
            {failure}
          </div>
        ) : null}

        <div className="card" style={{ marginTop: 'var(--mf-space-3)' }}>
          <strong>修改密码</strong>
          <form className="password-form" onSubmit={handleSubmit} noValidate>
            <div className="field">
              <label htmlFor="current-password">当前密码</label>
              <input
                id="current-password"
                name="current-password"
                type="password"
                autoComplete="current-password"
                placeholder="请输入当前密码"
                value={form.current}
                onChange={(event) => setForm({ ...form, current: event.target.value })}
              />
              {errors.current ? <span className="field-error">{errors.current}</span> : null}
            </div>

            <div className="field">
              <label htmlFor="new-password">新密码</label>
              <input
                id="new-password"
                name="new-password"
                type="password"
                autoComplete="new-password"
                placeholder="至少 8 位，含字母和数字"
                value={form.next}
                onChange={(event) => setForm({ ...form, next: event.target.value })}
              />
              {errors.next ? <span className="field-error">{errors.next}</span> : null}
            </div>

            <div className="field">
              <label htmlFor="confirm-password">确认新密码</label>
              <input
                id="confirm-password"
                name="confirm-password"
                type="password"
                autoComplete="new-password"
                placeholder="再次输入新密码"
                value={form.confirm}
                onChange={(event) => setForm({ ...form, confirm: event.target.value })}
              />
              {errors.confirm ? <span className="field-error">{errors.confirm}</span> : null}
            </div>

            <button type="submit" className="btn btn-primary btn-block" disabled={changePassword.isPending}>
              {changePassword.isPending ? '提交中…' : '保存新密码'}
            </button>
          </form>
        </div>

        <div className="card" style={{ marginTop: 'var(--mf-space-3)' }}>
          <span className="muted">退出登录会清除本机保存的登录状态，需要重新输入邮箱与密码。</span>
          <button
            type="button"
            className="btn btn-secondary btn-block"
            style={{ marginTop: 'var(--mf-space-3)' }}
            onClick={() => setLogoutOpen(true)}
          >
            退出登录
          </button>
        </div>
      </div>

      <Dialog
        open={logoutOpen}
        title="退出登录"
        description="确认退出当前账号？"
        confirmLabel="退出登录"
        danger
        onCancel={() => setLogoutOpen(false)}
        onConfirm={handleLogout}
      />
    </>
  );
}
