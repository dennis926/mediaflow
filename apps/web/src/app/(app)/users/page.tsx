'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { Banner } from '../../../components/ui/Banner';
import { Button } from '../../../components/ui/Button';
import { Card } from '../../../components/ui/Card';
import { DataTable, type Column } from '../../../components/ui/DataTable';
import { Dialog } from '../../../components/ui/Dialog';
import { EmptyState } from '../../../components/ui/EmptyState';
import { Input, Select } from '../../../components/ui/Field';
import { Pagination } from '../../../components/ui/Pagination';
import { SkeletonRows } from '../../../components/ui/Skeleton';
import { Tag } from '../../../components/ui/Tag';
import { useSiteConfig } from '../../../lib/knowledge';
import { ApiError } from '../../../lib/api/client';
import { usersApi } from '../../../lib/api/endpoints';
import type { UserItem } from '../../../lib/api/types';
import { formatDateTime } from '../../../lib/format';
import { AccountIcon, PlusIcon } from '../../../lib/icons';
import styles from './page.module.css';

const ROLE_LABELS: Record<string, string> = {
  owner: '超级管理员',
  admin: '管理员',
  editor: '内容运营',
  reviewer: '审核人',
  viewer: '只读成员',
};

const ROLE_TONES: Record<string, 'brand' | 'info' | 'success' | 'warning' | 'default'> = {
  owner: 'brand',
  admin: 'info',
  editor: 'success',
  reviewer: 'warning',
  viewer: 'default',
};

const STATUS_OPTIONS = [
  { value: '', label: '全部状态' },
  { value: 'active', label: '已启用' },
  { value: 'disabled', label: '已停用' },
];

export default function UsersPage() {
  const site = useSiteConfig();
  const queryClient = useQueryClient();
  const [keyword, setKeyword] = useState('');
  const [appliedKeyword, setAppliedKeyword] = useState('');
  const [status, setStatus] = useState('');
  const [role, setRole] = useState('');
  const [page, setPage] = useState(1);
  const [feedback, setFeedback] = useState<{ tone: 'success' | 'danger' | 'info'; text: string } | null>(null);
  const [tempPassword, setTempPassword] = useState<{ email: string; password: string } | null>(null);
  const [createOpen, setCreateOpen] = useState(false);
  const [rolesOpen, setRolesOpen] = useState<UserItem | null>(null);
  const [editTarget, setEditTarget] = useState<UserItem | null>(null);
  const [pendingDelete, setPendingDelete] = useState<UserItem | null>(null);
  const [selectedRoles, setSelectedRoles] = useState<string[]>([]);
  const [form, setForm] = useState({ email: '', displayName: '', phone: '' });
  const [editForm, setEditForm] = useState({ displayName: '', phone: '' });

  const users = useQuery({
    queryKey: ['users', { appliedKeyword, status, role, page }],
    queryFn: () =>
      usersApi.list({
        keyword: appliedKeyword || undefined,
        status: status || undefined,
        role: role || undefined,
        page,
        pageSize: site.pageSize,
      }),
  });
  const roles = useQuery({ queryKey: ['users', 'roles'], queryFn: () => usersApi.roles() });

  const refresh = (): void => {
    void queryClient.invalidateQueries({ queryKey: ['users'] });
  };

  const onError = (error: unknown, fallback: string): void =>
    setFeedback({ tone: 'danger', text: error instanceof ApiError ? error.message : fallback });

  const create = useMutation({
    mutationFn: () =>
      usersApi.create({
        email: form.email.trim(),
        displayName: form.displayName.trim(),
        phone: form.phone.trim() || undefined,
        roleCodes: ['editor'],
      }),
    onSuccess: (result) => {
      setCreateOpen(false);
      setForm({ email: '', displayName: '', phone: '' });
      refresh();
      if (result.tempPassword) {
        setTempPassword({ email: result.user.email, password: result.tempPassword });
      } else {
        setFeedback({ tone: 'success', text: `已创建用户：${result.user.displayName}` });
      }
    },
    onError: (error: unknown) => onError(error, '创建失败'),
  });

  const invite = useMutation({
    mutationFn: () => usersApi.invite({ email: form.email.trim(), displayName: form.displayName.trim(), roleCodes: ['editor'] }),
    onSuccess: (result) => {
      setCreateOpen(false);
      setForm({ email: '', displayName: '', phone: '' });
      refresh();
      setTempPassword({ email: result.user.email, password: result.tempPassword });
    },
    onError: (error: unknown) => onError(error, '邀请失败'),
  });

  const update = useMutation({
    mutationFn: () =>
      usersApi.update(editTarget!.id, {
        displayName: editForm.displayName.trim(),
        phone: editForm.phone.trim() || undefined,
      }),
    onSuccess: () => {
      setEditTarget(null);
      setFeedback({ tone: 'success', text: '已保存' });
      refresh();
    },
    onError: (error: unknown) => onError(error, '保存失败'),
  });

  const updateRoles = useMutation({
    mutationFn: () => usersApi.updateRoles(rolesOpen!.id, selectedRoles),
    onSuccess: () => {
      setRolesOpen(null);
      setFeedback({ tone: 'success', text: '角色已更新' });
      refresh();
      void queryClient.invalidateQueries({ queryKey: ['users', 'roles'] });
    },
    onError: (error: unknown) => onError(error, '角色更新失败'),
  });

  const resetPassword = useMutation({
    mutationFn: (user: UserItem) => usersApi.resetPassword(user.id),
    onSuccess: (result, user) => {
      refresh();
      if (result.tempPassword) setTempPassword({ email: user.email, password: result.tempPassword });
      else setFeedback({ tone: 'success', text: '密码已重置' });
    },
    onError: (error: unknown) => onError(error, '重置失败'),
  });

  const toggleStatus = useMutation({
    mutationFn: (user: UserItem) => usersApi.updateStatus(user.id, user.status === 'active' ? 'disabled' : 'active'),
    onSuccess: () => {
      setFeedback({ tone: 'success', text: '状态已更新' });
      refresh();
    },
    onError: (error: unknown) => onError(error, '状态更新失败'),
  });

  const remove = useMutation({
    mutationFn: (user: UserItem) => usersApi.remove(user.id),
    onSuccess: () => {
      setPendingDelete(null);
      setFeedback({ tone: 'info', text: '用户已删除（软删除，可保留审计记录）' });
      refresh();
    },
    onError: (error: unknown) => onError(error, '删除失败'),
  });

  const columns: Array<Column<UserItem>> = [
    {
      key: 'user',
      title: '成员',
      render: (row) => (
        <div className={styles.userCell}>
          <span className={styles.avatar}>{row.displayName.slice(0, 1)}</span>
          <span className={styles.meta}>
            <span style={{ fontWeight: 'var(--mf-font-weight-medium)' }}>{row.displayName}</span>
            <span className={styles.email}>{row.email}</span>
          </span>
        </div>
      ),
    },
    {
      key: 'roles',
      title: '角色',
      width: '180px',
      render: (row) => (
        <div className={styles.tags}>
          {row.roles.length === 0 ? <Tag>未分配</Tag> : row.roles.map((code) => <Tag key={code} tone={ROLE_TONES[code] ?? 'default'}>{ROLE_LABELS[code] ?? code}</Tag>)}
        </div>
      ),
    },
    {
      key: 'status',
      title: '状态',
      width: '140px',
      render: (row) => (
        <div className={styles.tags}>
          <Tag tone={row.status === 'active' ? 'success' : 'danger'}>{row.status === 'active' ? '已启用' : '已停用'}</Tag>
          {row.mustChangePassword ? <Tag tone="warning">待改密</Tag> : null}
        </div>
      ),
    },
    {
      key: 'lastLoginAt',
      title: '最后登录',
      width: '160px',
      render: (row) => <span className={styles.email}>{formatDateTime(row.lastLoginAt)}</span>,
    },
    {
      key: 'actions',
      title: '操作',
      width: '330px',
      align: 'right',
      render: (row) => (
        <div className={styles.actions}>
          <Button variant="text" size="sm" onClick={() => { setEditTarget(row); setEditForm({ displayName: row.displayName, phone: row.phone ?? '' }); }}>
            编辑
          </Button>
          <Button variant="text" size="sm" onClick={() => { setRolesOpen(row); setSelectedRoles(row.roles); }}>
            角色
          </Button>
          <Button variant="text" size="sm" onClick={() => resetPassword.mutate(row)}>
            重置密码
          </Button>
          <Button variant="text" size="sm" onClick={() => toggleStatus.mutate(row)}>
            {row.status === 'active' ? '停用' : '启用'}
          </Button>
          <Button variant="text" size="sm" onClick={() => setPendingDelete(row)}>
            删除
          </Button>
        </div>
      ),
    },
  ];

  return (
    <>
      {feedback ? (
        <Banner tone={feedback.tone}>
          {feedback.text}
          <button type="button" onClick={() => setFeedback(null)} style={{ marginLeft: 'auto', background: 'none', border: 'none', cursor: 'pointer', color: 'inherit' }}>
            知道了
          </button>
        </Banner>
      ) : null}

      <Card flush>
        <div className={styles.toolbar} style={{ padding: 'var(--mf-space-5) var(--mf-space-5) 0' }}>
          <div className={styles.search}>
            <Input
              label="搜索"
              name="keyword"
              placeholder="邮箱或姓名"
              value={keyword}
              onChange={(event) => setKeyword(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === 'Enter') {
                  setAppliedKeyword(keyword.trim());
                  setPage(1);
                }
              }}
            />
          </div>
          <div className={styles.filter}>
            <Select label="状态" name="status" options={STATUS_OPTIONS} value={status} onChange={(event) => { setStatus(event.target.value); setPage(1); }} />
          </div>
          <div className={styles.filter}>
            <Select
              label="角色"
              name="role"
              options={[{ value: '', label: '全部角色' }, ...Object.entries(ROLE_LABELS).map(([value, label]) => ({ value, label }))]}
              value={role}
              onChange={(event) => { setRole(event.target.value); setPage(1); }}
            />
          </div>
          <Button variant="secondary" onClick={() => { setAppliedKeyword(keyword.trim()); setPage(1); }}>
            搜索
          </Button>
          <div className={styles.spacer}>
            <Button icon={<PlusIcon width={16} height={16} />} onClick={() => setCreateOpen(true)}>
              添加成员
            </Button>
          </div>
        </div>

        <div style={{ padding: 'var(--mf-space-4) 0 0' }}>
          {users.isLoading ? (
            <div style={{ padding: 'var(--mf-space-5)' }}>
              <SkeletonRows rows={5} />
            </div>
          ) : (
            <DataTable
              columns={columns}
              rows={users.data?.items ?? []}
              rowKey={(row) => row.id}
              empty={<EmptyState title="还没有成员" description="邀请同事加入后即可分配角色。" icon={<AccountIcon width={22} height={22} />} />}
            />
          )}
        </div>

        <Pagination page={page} pageSize={site.pageSize} total={users.data?.meta.total ?? 0} onChange={setPage} />
      </Card>

      <Card title="角色说明">
        <div className={styles.roles}>
          {(roles.data ?? []).map((item) => (
            <div className={styles.roleCard} key={item.code}>
              <span className={styles.roleName}>
                {item.name}
                <Tag tone={ROLE_TONES[item.code] ?? 'default'}>{item.memberCount} 人</Tag>
              </span>
              <span className={styles.email}>{item.description}</span>
            </div>
          ))}
        </div>
      </Card>

      <Dialog
        open={createOpen}
        title="添加成员"
        onClose={() => setCreateOpen(false)}
        footer={
          <>
            <Button variant="secondary" onClick={() => setCreateOpen(false)}>
              取消
            </Button>
            <Button variant="secondary" loading={invite.isPending} disabled={!form.email.trim() || !form.displayName.trim()} onClick={() => invite.mutate()}>
              邀请（生成临时密码）
            </Button>
            <Button loading={create.isPending} disabled={!form.email.trim() || !form.displayName.trim()} onClick={() => create.mutate()}>
              创建（同样生成临时密码）
            </Button>
          </>
        }
      >
        <Input label="邮箱" name="email" type="email" required value={form.email} onChange={(event) => setForm({ ...form, email: event.target.value })} />
        <Input label="姓名" name="displayName" required value={form.displayName} onChange={(event) => setForm({ ...form, displayName: event.target.value })} />
        <Input label="手机号（可选）" name="phone" value={form.phone} onChange={(event) => setForm({ ...form, phone: event.target.value })} />
        <Banner tone="info">
          <span>两种方式都会生成一次性临时密码并要求对方首次登录后修改；密码只在创建后显示一次，请及时转达。</span>
        </Banner>
      </Dialog>

      <Dialog
        open={Boolean(tempPassword)}
        title="临时密码（仅显示一次）"
        onClose={() => setTempPassword(null)}
        footer={
          <Button onClick={() => setTempPassword(null)}>我已记录</Button>
        }
      >
        <span>
          账号：<strong>{tempPassword?.email}</strong>
        </span>
        <span className={styles.secret}>{tempPassword?.password}</span>
        <Banner tone="warning">
          <span>请通过安全渠道转达给对方；对方首次登录后会被要求修改密码，此密码随即失效。</span>
        </Banner>
      </Dialog>

      <Dialog
        open={Boolean(editTarget)}
        title="编辑成员"
        onClose={() => setEditTarget(null)}
        footer={
          <>
            <Button variant="secondary" onClick={() => setEditTarget(null)}>
              取消
            </Button>
            <Button loading={update.isPending} onClick={() => update.mutate()}>
              保存
            </Button>
          </>
        }
      >
        <Input label="姓名" name="displayName" value={editForm.displayName} onChange={(event) => setEditForm({ ...editForm, displayName: event.target.value })} />
        <Input label="手机号" name="phone" value={editForm.phone} onChange={(event) => setEditForm({ ...editForm, phone: event.target.value })} />
      </Dialog>

      <Dialog
        open={Boolean(rolesOpen)}
        title={`分配角色：${rolesOpen?.displayName ?? ''}`}
        onClose={() => setRolesOpen(null)}
        footer={
          <>
            <Button variant="secondary" onClick={() => setRolesOpen(null)}>
              取消
            </Button>
            <Button loading={updateRoles.isPending} disabled={selectedRoles.length === 0} onClick={() => updateRoles.mutate()}>
              保存角色
            </Button>
          </>
        }
      >
        {(roles.data ?? []).map((item) => {
          const active = selectedRoles.includes(item.code);
          return (
            <label key={item.code} style={{ display: 'flex', alignItems: 'center', gap: 'var(--mf-space-3)', minHeight: 'var(--mf-size-touch-min)' }}>
              <input
                type="checkbox"
                checked={active}
                onChange={() => setSelectedRoles(active ? selectedRoles.filter((code) => code !== item.code) : [...selectedRoles, item.code])}
              />
              <span>
                {item.name}
                <span className={styles.email}> · {item.permissions.slice(0, 3).join('、')}</span>
              </span>
            </label>
          );
        })}
        <Banner tone="warning">
          <span>系统会阻止「取消自己的管理员角色」「停用或删除最后一个管理员」这类会把系统锁死的操作。</span>
        </Banner>
      </Dialog>

      <Dialog
        open={Boolean(pendingDelete)}
        title="删除成员"
        onClose={() => setPendingDelete(null)}
        footer={
          <>
            <Button variant="secondary" onClick={() => setPendingDelete(null)}>
              取消
            </Button>
            <Button variant="danger" loading={remove.isPending} onClick={() => pendingDelete && remove.mutate(pendingDelete)}>
              确认删除
            </Button>
          </>
        }
      >
        <span>删除为软删除：账号立即无法登录，数据行保留以便审计。确定删除「{pendingDelete?.displayName}」吗？</span>
      </Dialog>
    </>
  );
}
