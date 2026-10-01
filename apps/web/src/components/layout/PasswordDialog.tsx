'use client';

import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { ApiError } from '../../lib/api/client';
import { authApi } from '../../lib/api/endpoints';
import { Banner } from '../ui/Banner';
import { Button } from '../ui/Button';
import { Dialog } from '../ui/Dialog';
import { Input } from '../ui/Field';

export interface PasswordDialogProps {
  open: boolean;
  onClose: () => void;
  /**
   * 强制改密模式（P1-4）：服务端会拦住临时密码的其它请求，这里同步把弹窗做成
   * 不可关闭（无遮罩点击、无 Esc、无右上角关闭按钮），避免用户关掉后满屏 403。
   */
  required?: boolean;
}

export function PasswordDialog({ open, onClose, required = false }: PasswordDialogProps) {
  const queryClient = useQueryClient();
  const [currentPassword, setCurrentPassword] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [message, setMessage] = useState<{ tone: 'success' | 'danger'; text: string } | null>(null);

  const change = useMutation({
    mutationFn: () => authApi.changePassword(currentPassword, newPassword),
    onSuccess: () => {
      setMessage({ tone: 'success', text: '密码已修改，下次登录请使用新密码' });
      setCurrentPassword('');
      setNewPassword('');
      setConfirmPassword('');
      /**
       * 刷新自己的身份：守卫读的是服务端会话快照，改密后 mustChangePassword 变为 false，
       * 重新拉取 /auth/me 才能让强制弹窗真正消失。
       */
      void queryClient.invalidateQueries({ queryKey: ['auth', 'me'] });
    },
    onError: (error: unknown) =>
      setMessage({ tone: 'danger', text: error instanceof ApiError ? error.message : '修改失败' }),
  });

  const mismatch = confirmPassword.length > 0 && newPassword !== confirmPassword;
  const tooShort = newPassword.length > 0 && newPassword.length < 8;

  return (
    <Dialog
      open={open}
      dismissible={!required}
      title={required ? '请先修改初始密码' : '修改密码'}
      onClose={() => {
        setMessage(null);
        onClose();
      }}
      footer={
        <>
          {required ? null : (
            <Button variant="secondary" onClick={onClose}>
              关闭
            </Button>
          )}
          <Button
            loading={change.isPending}
            disabled={!currentPassword || !newPassword || mismatch || tooShort}
            onClick={() => change.mutate()}
          >
            保存
          </Button>
        </>
      }
    >
      {required && !message ? (
        <Banner tone="warning">你正在使用管理员分配的临时密码，修改后才能使用其它功能。</Banner>
      ) : null}
      {message ? <Banner tone={message.tone}>{message.text}</Banner> : null}
      <Input
        label="当前密码"
        name="currentPassword"
        type="password"
        autoComplete="current-password"
        value={currentPassword}
        onChange={(event) => setCurrentPassword(event.target.value)}
      />
      <Input
        label="新密码"
        name="newPassword"
        type="password"
        autoComplete="new-password"
        hint="至少 8 位，需同时包含字母和数字"
        error={tooShort ? '密码长度至少 8 位' : undefined}
        value={newPassword}
        onChange={(event) => setNewPassword(event.target.value)}
      />
      <Input
        label="确认新密码"
        name="confirmPassword"
        type="password"
        autoComplete="new-password"
        error={mismatch ? '两次输入的密码不一致' : undefined}
        value={confirmPassword}
        onChange={(event) => setConfirmPassword(event.target.value)}
      />
    </Dialog>
  );
}
