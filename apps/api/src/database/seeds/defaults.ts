import { DataSource } from 'typeorm';
import { Workspace } from '../../modules/workspace/entities/workspace.entity';

/**
 * Deterministic ids keep the seed idempotent and make local fixtures reproducible.
 *
 * 必须是符合 RFC 的 v4 UUID（版本位 4、variant 位 8）：早期用的
 * 11111111-1111-1111-... 形状会被 @IsUUID('4') 判为非法，导致"切换工作区"直接 400。
 */
export const DEFAULT_TENANT_ID = '11111111-1111-4111-8111-111111111111';
export const DEFAULT_WORKSPACE_ID = '22222222-2222-4222-8222-222222222222';

export const ROLE_IDS: Record<string, string> = {
  owner: '33333333-3333-4333-8333-333333333301',
  admin: '33333333-3333-4333-8333-333333333302',
  editor: '33333333-3333-4333-8333-333333333303',
  reviewer: '33333333-3333-4333-8333-333333333304',
  viewer: '33333333-3333-4333-8333-333333333305',
};

export const DEFAULT_ADMIN_ID = '44444444-4444-4444-8444-444444444401';
export const DEFAULT_ADMIN_EMAIL = 'admin@mediaflow.local';

export interface DefaultScope {
  tenantId: string;
  workspaceId: string;
}

/**
 * 解析"默认作用域"，供种子脚本写入新数据时使用。
 *
 * 不能直接用常量：老安装的工作区是更早的固定 ID，常量一改就会导致
 * 重复建工作区或把数据挂到不存在的工作区上。这里按 slug 找既有工作区，
 * 找不到才回退常量（全新安装的情况）。
 */
export async function resolveDefaultScope(dataSource: DataSource): Promise<DefaultScope> {
  const repository = dataSource.getRepository(Workspace);
  const existing = await repository.findOne({ where: { slug: 'default' } });
  if (existing) {
    return { tenantId: existing.tenantId, workspaceId: existing.id };
  }
  return { tenantId: DEFAULT_TENANT_ID, workspaceId: DEFAULT_WORKSPACE_ID };
}
