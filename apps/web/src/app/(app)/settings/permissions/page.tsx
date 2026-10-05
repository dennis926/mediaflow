'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import { Banner } from '../../../../components/ui/Banner';
import { Button } from '../../../../components/ui/Button';
import { Card } from '../../../../components/ui/Card';
import { Input } from '../../../../components/ui/Field';
import { SkeletonRows } from '../../../../components/ui/Skeleton';
import { Checkbox } from '../../../../components/ui/Switch';
import { Tag } from '../../../../components/ui/Tag';
import { ApiError } from '../../../../lib/api/client';
import { permissionsApi } from '../../../../lib/api/endpoints';
import styles from '../page.module.css';

/**
 * 角色与权限（勾选表格）。
 *
 * 用户要求：「角色权限，最好是表格选择那种，不要用手写，容易出错，我的要求是让用户选择权限即可，
 * 可以设置权限分组，选择对应的权限，角色显示名都做成可编辑可改的，不要以代码形式出现。」
 *
 * 所以这一页里看不到任何 JSON：能力点按业务分组列出中文名，角色列显示可编辑的中文名，
 * 勾选即生效。拼 JSON、校验角色代码、防漏传都放在服务端做。
 */
export default function PermissionsPage() {
  const queryClient = useQueryClient();
  const view = useQuery({ queryKey: ['permissions'], queryFn: () => permissionsApi.view() });

  /** 本地草稿：能力点 → 角色代码数组 */
  const [matrix, setMatrix] = useState<Record<string, string[]>>({});
  /** 本地草稿：角色代码 → 显示名 */
  const [labels, setLabels] = useState<Record<string, string>>({});
  const [feedback, setFeedback] = useState<{ tone: 'success' | 'danger' | 'info'; text: string } | null>(null);

  useEffect(() => {
    if (!view.data) return;
    const next: Record<string, string[]> = {};
    for (const group of view.data.groups) {
      for (const capability of group.capabilities) next[capability.key] = [...capability.roles];
    }
    setMatrix(next);
    const nextLabels: Record<string, string> = {};
    for (const role of view.data.roles) nextLabels[role.code] = role.label;
    setLabels(nextLabels);
  }, [view.data]);

  const matrixDirty =
    Boolean(view.data) &&
    view.data!.groups.some((group) =>
      group.capabilities.some((capability) => {
        const current = [...(matrix[capability.key] ?? [])].sort().join(',');
        return current !== [...capability.roles].sort().join(',');
      }),
    );

  const labelsDirty =
    Boolean(view.data) && view.data!.roles.some((role) => (labels[role.code] ?? '') !== role.label);

  const saveMatrix = useMutation({
    mutationFn: () => permissionsApi.saveMatrix(matrix),
    onSuccess: () => {
      setFeedback({ tone: 'success', text: '权限已保存并立即生效（用户刷新页面后按钮就会跟着变）' });
      void queryClient.invalidateQueries({ queryKey: ['permissions'] });
      void queryClient.invalidateQueries({ queryKey: ['auth', 'capabilities'] });
    },
    onError: (error: unknown) =>
      setFeedback({ tone: 'danger', text: error instanceof ApiError ? error.message : '保存失败' }),
  });

  const saveLabels = useMutation({
    mutationFn: () => permissionsApi.saveRoleLabels(labels),
    onSuccess: () => {
      setFeedback({ tone: 'success', text: '角色显示名已保存' });
      void queryClient.invalidateQueries({ queryKey: ['permissions'] });
    },
    onError: (error: unknown) =>
      setFeedback({ tone: 'danger', text: error instanceof ApiError ? error.message : '保存失败' }),
  });

  const reset = useMutation({
    mutationFn: () => permissionsApi.reset(),
    onSuccess: () => {
      setFeedback({ tone: 'info', text: '已恢复出厂权限设置' });
      void queryClient.invalidateQueries({ queryKey: ['permissions'] });
      void queryClient.invalidateQueries({ queryKey: ['auth', 'capabilities'] });
    },
  });

  const toggle = (capability: string, role: string, checked: boolean) => {
    setMatrix((prev) => {
      const current = new Set(prev[capability] ?? []);
      if (checked) current.add(role);
      else current.delete(role);
      return { ...prev, [capability]: [...current] };
    });
  };

  return (
    <>
      {feedback ? (
        <Banner tone={feedback.tone}>
          {feedback.text}
          <button type="button" onClick={() => setFeedback(null)} className={styles.bannerClose}>
            知道了
          </button>
        </Banner>
      ) : null}

      {view.isLoading ? (
        <Card title="角色与权限">
          <SkeletonRows rows={8} />
        </Card>
      ) : (
        <>
          <Card
            title="角色显示名"
            extra={
              <Button size="sm" loading={saveLabels.isPending} disabled={!labelsDirty} onClick={() => saveLabels.mutate()}>
                保存显示名
              </Button>
            }
          >
            <Banner tone="info">
              <span>
                把内置角色改成贵公司的叫法（例如「管理员」→「运营主管」）。改的是显示名，
                权限由下面的表格决定；界面各处会自动跟着变，不需要改代码。
              </span>
            </Banner>
            <div className={styles.roleNames}>
              {(view.data?.roles ?? []).map((role) => (
                <div className={styles.roleNameCard} key={role.code}>
                  <Input
                    label={`角色 ${role.code}`}
                    name={`role-${role.code}`}
                    value={labels[role.code] ?? ''}
                    placeholder={role.label}
                    maxLength={20}
                    onChange={(event) => setLabels({ ...labels, [role.code]: event.target.value })}
                  />
                  <span className={styles.roleNameCode}>
                    拥有 {matrix ? Object.values(matrix).filter((roles) => roles.includes(role.code)).length : role.capabilityCount} 项权限
                  </span>
                </div>
              ))}
            </div>
          </Card>

          <Card
            title="权限表"
            extra={
              <div style={{ display: 'flex', gap: 'var(--mf-space-2)' }}>
                <Button variant="text" size="sm" loading={reset.isPending} onClick={() => reset.mutate()}>
                  恢复出厂设置
                </Button>
                <Button size="sm" loading={saveMatrix.isPending} disabled={!matrixDirty} onClick={() => saveMatrix.mutate()}>
                  保存权限
                </Button>
              </div>
            }
          >
            <Banner tone="warning">
              <span>
                勾选 = 该角色可以做这件事。<strong>全部不勾</strong>表示不限制（所有角色都可用）；
                带红色标记的是高风险权限，建议只给「所有者」。
              </span>
            </Banner>

            <div className={styles.matrixWrap}>
              <table className={styles.matrix}>
                <thead>
                  <tr>
                    <th>权限</th>
                    {(view.data?.roles ?? []).map((role) => (
                      <th key={role.code} className={styles.centerCell}>
                        {labels[role.code] || role.label}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {(view.data?.groups ?? []).map((group) => (
                    <>
                      <tr className={styles.groupRow} key={group.group}>
                        <td colSpan={1 + (view.data?.roles.length ?? 0)}>
                          {group.label}
                          <span className={styles.groupDesc}>{group.description}</span>
                        </td>
                      </tr>
                      {group.capabilities.map((capability) => (
                        <tr key={capability.key}>
                          <td>
                            <div className={styles.capabilityCell}>
                              <span className={capability.dangerous ? styles.dangerText : undefined}>
                                {capability.label}
                                {capability.dangerous ? <Tag tone="danger">高危</Tag> : null}
                              </span>
                              <span className={styles.capabilityKey}>{capability.key}</span>
                            </div>
                          </td>
                          {(view.data?.roles ?? []).map((role) => (
                            <td key={role.code} className={styles.centerCell}>
                              <Checkbox
                                checked={(matrix[capability.key] ?? []).includes(role.code)}
                                tone={capability.dangerous ? 'danger' : 'default'}
                                title={`${labels[role.code] || role.label} · ${capability.label}`}
                                onChange={(checked) => toggle(capability.key, role.code, checked)}
                              />
                            </td>
                          ))}
                        </tr>
                      ))}
                    </>
                  ))}
                </tbody>
              </table>
            </div>

            <div className={styles.footer} style={{ marginTop: 'var(--mf-space-4)' }}>
              <Button loading={saveMatrix.isPending} disabled={!matrixDirty} onClick={() => saveMatrix.mutate()}>
                保存权限{matrixDirty ? '（有改动）' : ''}
              </Button>
              <span className={styles.desc}>
                保存后立即生效：权限判断由服务端实时计算，用户下次操作就会按新权限执行。
              </span>
            </div>
          </Card>
        </>
      )}
    </>
  );
}
