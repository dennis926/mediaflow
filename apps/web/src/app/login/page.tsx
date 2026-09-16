'use client';

import { useMutation } from '@tanstack/react-query';
import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { Banner } from '../../components/ui/Banner';
import { Button } from '../../components/ui/Button';
import { Input } from '../../components/ui/Field';
import { authApi } from '../../lib/api/endpoints';
import { ApiError, setToken } from '../../lib/api/client';
import styles from './page.module.css';

export default function LoginPage() {
  const router = useRouter();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);

  const login = useMutation({
    mutationFn: () => authApi.login(email.trim(), password),
    onSuccess: (result) => {
      setToken(result.accessToken);
      router.replace('/dashboard');
    },
    onError: (mutationError: unknown) => {
      setError(mutationError instanceof ApiError ? mutationError.message : '登录失败，请稍后重试');
    },
  });

  return (
    <div className={styles.page}>
      <div className={styles.card}>
        <div className={styles.brand}>
          <span className={styles.brandMark}>M</span>
          <div>
            <h1 className={styles.title}>MediaFlow</h1>
            <span className={styles.subtitle}>社交媒体内容分发与矩阵运营平台</span>
          </div>
        </div>

        {error ? <Banner tone="danger">{error}</Banner> : null}

        <form
          className={styles.form}
          onSubmit={(event) => {
            event.preventDefault();
            setError(null);
            login.mutate();
          }}
        >
          <Input
            label="邮箱"
            name="email"
            type="email"
            autoComplete="username"
            placeholder="name@company.com"
            value={email}
            required
            onChange={(event) => setEmail(event.target.value)}
          />
          <Input
            label="密码"
            name="password"
            type="password"
            autoComplete="current-password"
            placeholder="请输入密码"
            value={password}
            required
            onChange={(event) => setPassword(event.target.value)}
          />
          <Button type="submit" size="lg" fullWidth loading={login.isPending}>
            登录
          </Button>
        </form>

        <span className={styles.footnote}>内部工具 · 登录行为会记录到审计日志</span>
      </div>
    </div>
  );
}
