'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { Banner } from '../../../components/ui/Banner';
import { Button } from '../../../components/ui/Button';
import { Card } from '../../../components/ui/Card';
import { DataTable, type Column } from '../../../components/ui/DataTable';
import { EmptyState } from '../../../components/ui/EmptyState';
import { Input, Select } from '../../../components/ui/Field';
import { SkeletonRows } from '../../../components/ui/Skeleton';
import { Tag } from '../../../components/ui/Tag';
import { ApiError, setToken } from '../../../lib/api/client';
import { authApi, usersApi, workspacesApi } from '../../../lib/api/endpoints';
import type { UserItem, WorkspaceMemberItem, WorkspaceSummaryItem } from '../../../lib/api/types';
import { formatDateTime } from '../../../lib/format';
import { AccountIcon, PlusIcon } from '../../../lib/icons';
import { useSiteConfig } from '../../../lib/knowledge';
import styles from './page.module.css';

const ROLE_OPTIONS = [
  { value: 'owner', label: '所有者' },
  { value: 'admin', label: '管理员' },
  { value: 'editor', label: '内容编辑' },
  { value: 'reviewer', label: '审核员' },
  { value: 'viewer', label: '只读' },
];

function roleLabels(codes: string[]): string {
  return codes.map((code) => ROLE_OPTIONS.find((option) => option.value === code)?.label ?? code).join('、');
}

/**
 * 工作区管理：一个实例里可以放多个业务空间（多家公司 / 多个品牌矩阵），数据按工作区隔离。
 * 在这里可以切换、新建工作区，以及维护当前工作区的成员与角色。
 */
export default function WorkspacesPage() {
  const router = useRouter();
  const queryClient = useQueryClient();
  const site = useSiteConfig();
  const [newName, setNewName] = useState('');
  const [memberForm, setMemberForm] = useState<{ userId: string; roleCodes: string[] }>({ userId: '', roleCodes: ['editor'] });
  const [feedback, setFeedback] = useState<{ tone: 'success' | 'danger' | 'info'; text: string } | null>(null);

  const mine = useQuery({ queryKey: ['workspaces', 'mine'], queryFn: () => workspacesApi.mine() });
  const current = mine.data?.find((item) => item.isCurrent) ?? null;
  const users = useQuery({ queryKey: ['users', 'options'], queryFn: () => usersApi.list({ page: 1, pageSize: 100 }) });

  const switchTo = useMutation({
    mutationFn: (workspaceId: string) => authApi.switchWorkspace(workspaceId),
    onSuccess: (result) => {
      // 服务端已经按新工作区签发了令牌，这里替换后刷新即可
      setToken(result.accessToken, result.refreshToken);
      setFeedback({ tone: 'success', text: `已切换到「${result.user.workspaceId === current?.id ? current?.name : '新工作区'}」` });
      queryClient.clear();
      router.refresh();
      window.location.reload();
    },
    onError: (error: unknown) => setFeedback({ tone: 'danger', text: error instanceof ApiError ? error.message : '切换失败' }),
  });

  const createWorkspace = useMutation({
    mutationFn: () => workspacesApi.create({ name: newName.trim() }),
    onSuccess: (workspace) => {
      setNewName('');
      setFeedback({ tone: 'success', text: `工作区「${workspace.name}」已创建，你可以切换过去或继续在「${current?.name ?? '当前工作区'}」里工作` });
      void queryClient.invalidateQueries({ queryKey: ['workspaces', 'mine'] });
    },
    onError: (error: unknown) => setFeedback({ tone: 'danger', text: error instanceof ApiError ? error.message : '创建失败' }),
  });

  const members = useQuery({
    queryKey: ['workspaces', current?.id, 'members'],
    queryFn: () => workspacesApi.members(current!.id),
    enabled: Boolean(current?.id),
  });

  const upsertMember = useMutation({
    mutationFn: () => workspacesApi.upsertMember(current!.id, memberForm),
    onSuccess: (member) => {
      setFeedback({ tone: 'success', text: `已更新 ${member.displayName} 的角色` });
      setMemberForm({ userId: '', roleCodes: ['editor'] });
      void queryClient.invalidateQueries({ queryKey: ['workspaces', current?.id, 'members'] });
    },
    onError: (error: unknown) => setFeedback({ tone: 'danger', text: error instanceof ApiError ? error.message : '保存失败' }),
  });

  const removeMember = useMutation({
    mutationFn: (userId: string) => workspacesApi.removeMember(current!.id, userId),
    onSuccess: () => {
      setFeedback({ tone: 'info', text: '成员已移出该工作区' });
      void queryClient.invalidateQueries({ queryKey: ['workspaces', current?.id, 'members'] });
    },
    onError: (error: unknown) => setFeedback({ tone: 'danger', text: error instanceof ApiError ? error.message : '移除失败' }),
  });

  const workspaceColumns: Array<Column<WorkspaceSummaryItem>> = [
    {
      key: 'name',
      title: '工作区',
      render: (row) => (
        <div className={styles.titleCell}>
          <span className={styles.titleStrong}>
            {row.name}
            {row.isCurrent ? <Tag tone="success">当前</Tag> : null}
          </span>
          <span className={styles.meta}>标识 {row.slug} · 我的角色：{roleLabels(row.roleCodes)}</span>
        </div>
      ),
    },
    {
      key: 'action',
      title: '操作',
      width: '140px',
      align: 'right',
      render: (row) =>
        row.isCurrent ? (
          <span className={styles.meta}>使用中</span>
        ) : (
          <Button variant="secondary" size="sm" loading={switchTo.isPending && switchTo.variables === row.id} onClick={() => switchTo.mutate(row.id)}>
            切换到此处
          </Button>
        ),
    },
  ];

  const memberColumns: Array<Column<WorkspaceMemberItem>> = [
    {
      key: 'user',
      title: '成员',
      render: (row) => (
        <div className={styles.titleCell}>
          <span className={styles.titleStrong}>{row.displayName}</span>
          <span className={styles.meta}>{row.email}</span>
        </div>
      ),
    },
    { key: 'roles', title: '角色', width: '160px', render: (row) => <Tag tone="info">{roleLabels(row.roleCodes)}</Tag> },
    { key: 'joined', title: '加入时间', width: '170px', render: (row) => <span className={styles.meta}>{formatDateTime(row.joinedAt)}</span> },
    {
      key: 'action',
      title: '操作',
      width: '110px',
      align: 'right',
      render: (row) => (
        <Button variant="text" size="sm" loading={removeMember.isPending && removeMember.variables === row.userId} onClick={() => removeMember.mutate(row.userId)}>
          移出
        </Button>
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

      <Banner tone="info">
        <span>
          一个部署可以放多个<strong>工作区</strong>（多家公司 / 多个品牌矩阵）：内容、知识库、素材、发布任务、设置都按工作区隔离，互不干扰。
          切换工作区会重新签发登录令牌，切过去之后你看到的都是那个工作区的数据。
        </span>
      </Banner>

      <Card flush>
        <div className={styles.sectionHead}>
          <span className={styles.titleStrong}>我参与的工作区</span>
          <span className={styles.meta}>共 {mine.data?.length ?? 0} 个</span>
        </div>
        {mine.isLoading ? (
          <div style={{ padding: 'var(--mf-space-5)' }}>
            <SkeletonRows rows={2} />
          </div>
        ) : (
          <DataTable
            columns={workspaceColumns}
            rows={mine.data ?? []}
            rowKey={(row) => row.id}
            empty={<EmptyState title="还没有工作区" description="新建一个工作区开始使用。" icon={<AccountIcon width={22} height={22} />} />}
          />
        )}
      </Card>

      <Card>
        <div className={styles.sectionHead}>
          <span className={styles.titleStrong}>新建工作区</span>
          <span className={styles.meta}>创建者自动成为该工作区的所有者</span>
        </div>
        <div className={styles.toolbar}>
          <Input label="工作区名称" name="workspaceName" placeholder="例如：卿尔美品牌矩阵" value={newName} onChange={(event) => setNewName(event.target.value)} />
          <Button icon={<PlusIcon width={15} height={15} />} loading={createWorkspace.isPending} disabled={!newName.trim()} onClick={() => createWorkspace.mutate()}>
            创建
          </Button>
        </div>
      </Card>

      <Card flush>
        <div className={styles.sectionHead}>
          <span className={styles.titleStrong}>「{current?.name ?? '当前工作区'}」的成员</span>
          <span className={styles.meta}>每个人在一个工作区里可以有不同角色</span>
        </div>
        <div style={{ padding: '0 var(--mf-space-5) var(--mf-space-3)' }}>
          <div className={styles.toolbar}>
            <Select
              label="选择用户"
              name="memberUser"
              options={[
                { value: '', label: '请选择…' },
                ...((users.data?.items ?? []) as UserItem[]).map((user) => ({ value: user.id, label: `${user.displayName}（${user.email}）` })),
              ]}
              value={memberForm.userId}
              onChange={(event) => setMemberForm({ ...memberForm, userId: event.target.value })}
            />
            <Select
              label="角色"
              name="memberRole"
              options={ROLE_OPTIONS}
              value={memberForm.roleCodes[0] ?? 'editor'}
              onChange={(event) => setMemberForm({ ...memberForm, roleCodes: [event.target.value] })}
            />
            <Button variant="secondary" loading={upsertMember.isPending} disabled={!memberForm.userId} onClick={() => upsertMember.mutate()}>
              加入 / 更新角色
            </Button>
          </div>
        </div>
        {members.isLoading ? (
          <div style={{ padding: 'var(--mf-space-5)' }}>
            <SkeletonRows rows={3} />
          </div>
        ) : (
          <DataTable
            columns={memberColumns}
            rows={members.data ?? []}
            rowKey={(row) => row.userId}
            empty={<EmptyState title="这个工作区还没有成员" description="从上面的下拉里选一个用户加入。" icon={<AccountIcon width={22} height={22} />} />}
          />
        )}
      </Card>

      <span className={styles.meta}>当前站点：{site.name} · 工作区级设置（AI Key、知识库分类、通知渠道等）在各工作区内独立维护。</span>
    </>
  );
}
