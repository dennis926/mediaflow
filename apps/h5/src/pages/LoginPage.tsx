import { useMutation } from '@tanstack/react-query';
import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { ApiError, setToken } from '../lib/api/client';
import { authApi } from '../lib/api/endpoints';

export function LoginPage() {
  const navigate = useNavigate();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);

  const login = useMutation({
    mutationFn: () => authApi.login(email.trim(), password),
    onSuccess: (result) => {
      setToken(result.accessToken);
      navigate('/dashboard', { replace: true });
    },
    onError: (mutationError: unknown) =>
      setError(mutationError instanceof ApiError ? mutationError.message : '登录失败，请稍后重试'),
  });

  return (
    <div style={{ minHeight: '100vh', display: 'flex', flexDirection: 'column', padding: 'var(--mf-space-6)' }}>
      <div style={{ marginTop: 'calc(var(--mf-space-16) + var(--mf-space-8))', display: 'flex', flexDirection: 'column', gap: 'var(--mf-space-3)' }}>
        <span
          style={{
            width: 'var(--mf-space-12)',
            height: 'var(--mf-space-12)',
            borderRadius: 'var(--mf-radius-lg)',
            background: 'var(--mf-color-brand-500)',
            color: 'var(--mf-color-text-inverse)',
            display: 'inline-flex',
            alignItems: 'center',
            justifyContent: 'center',
            fontSize: 'var(--mf-font-size-2xl)',
            fontWeight: 'var(--mf-font-weight-bold)',
          }}
        >
          M
        </span>
        <h1 style={{ margin: 0, fontSize: 'var(--mf-font-size-3xl)' }}>MediaFlow</h1>
        <span className="muted">内容分发与矩阵运营 · 移动端</span>
      </div>

      {error ? (
        <div className="banner banner-danger" style={{ marginTop: 'var(--mf-space-5)' }} role="alert">
          {error}
        </div>
      ) : null}

      <form
        style={{ marginTop: 'var(--mf-space-6)', display: 'flex', flexDirection: 'column', gap: 'var(--mf-space-4)' }}
        onSubmit={(event) => {
          event.preventDefault();
          setError(null);
          login.mutate();
        }}
      >
        <div className="field">
          <label htmlFor="email">邮箱</label>
          <input
            id="email"
            name="email"
            type="email"
            inputMode="email"
            autoComplete="username"
            placeholder="name@company.com"
            value={email}
            onChange={(event) => setEmail(event.target.value)}
          />
        </div>
        <div className="field">
          <label htmlFor="password">密码</label>
          <input
            id="password"
            name="password"
            type="password"
            autoComplete="current-password"
            placeholder="请输入密码"
            value={password}
            onChange={(event) => setPassword(event.target.value)}
          />
        </div>
        <button type="submit" className="btn btn-primary btn-block" disabled={login.isPending}>
          {login.isPending ? '登录中…' : '登录'}
        </button>
      </form>

      <span className="muted" style={{ marginTop: 'auto', textAlign: 'center' }}>
        内部工具 · 登录行为会记录到审计日志
      </span>
    </div>
  );
}
