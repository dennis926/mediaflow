import { Logger } from '@nestjs/common';
import { randomInt } from 'node:crypto';
import * as bcrypt from 'bcrypt';
import { DataSource } from 'typeorm';
import { AiFlagType, PLATFORM_LABELS, PlatformCode, PublishMode, PUBLISH_MODES } from '@mediaflow/shared';
import { Platform } from '../../modules/platform/entities/platform.entity';
import { PlatformCapabilities } from '../../modules/platform/entities/platform.entity';
import { Role, RoleCode } from '../../modules/workspace/entities/role.entity';
import { User } from '../../modules/workspace/entities/user.entity';
import { Workspace } from '../../modules/workspace/entities/workspace.entity';
import { DEFAULT_ADMIN_EMAIL, DEFAULT_ADMIN_ID, ROLE_IDS, resolveDefaultScope, DefaultScope } from './defaults';

const logger = new Logger('Seed');

const ROLES: Array<Pick<Role, 'code' | 'name' | 'description' | 'permissions'>> = [
  { code: 'owner', name: '超级管理员', description: '拥有全部权限，可管理成员与工作区设置', permissions: ['*'] },
  {
    code: 'admin',
    name: '管理员',
    description: '管理内容、发布与账号，不可删除工作区',
    permissions: ['content:*', 'publish:*', 'account:*', 'analytics:read', 'member:read'],
  },
  {
    code: 'editor',
    name: '内容运营',
    description: '创建与编辑内容、提交发布任务',
    permissions: ['content:create', 'content:update', 'content:read', 'publish:create', 'publish:read'],
  },
  {
    code: 'reviewer',
    name: '审核人',
    description: '审批内容与发布计划',
    permissions: ['content:read', 'approval:review', 'publish:read'],
  },
  { code: 'viewer', name: '只读成员', description: '仅查看数据与内容', permissions: ['content:read', 'analytics:read'] },
];

const CAPABILITIES: Record<string, PlatformCapabilities> = {
  [PlatformCode.WechatMp]: {
    canPublish: false,
    canFetchAnalytics: true,
    canInteract: false,
    supportsSchedule: false,
    maxBodyLength: 20000,
    supportedMedia: ['image'],
  },
  [PlatformCode.Douyin]: {
    canPublish: true,
    canFetchAnalytics: true,
    canInteract: false,
    supportsSchedule: true,
    maxBodyLength: 2000,
    supportedMedia: ['video'],
  },
  [PlatformCode.Xiaohongshu]: {
    canPublish: true,
    canFetchAnalytics: true,
    canInteract: false,
    supportsSchedule: true,
    maxBodyLength: 1000,
    supportedMedia: ['image', 'video'],
  },
};

const PLUGIN_CAPABILITIES: PlatformCapabilities = {
  canPublish: false,
  canFetchAnalytics: false,
  canInteract: false,
  supportsSchedule: true,
  maxBodyLength: 5000,
  supportedMedia: ['image', 'video'],
};

const SAFE_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZabcdefghjkmnpqrstuvwxyz23456789';

function generatePassword(length = 14): string {
  let password = '';
  for (let index = 0; index < length; index += 1) {
    password += SAFE_ALPHABET[randomInt(SAFE_ALPHABET.length)];
  }
  return password;
}

async function seedWorkspace(dataSource: DataSource, scope: DefaultScope): Promise<void> {
  const repository = dataSource.getRepository(Workspace);
  // 按 slug 判重：老安装的工作区 ID 与新常量不同，按 ID 查会重复插入。
  const existing = await repository.findOne({ where: { slug: 'default' } });
  if (existing) {
    logger.log(`工作区已存在，跳过：${existing.name}`);
    return;
  }
  await repository.insert({
    id: scope.workspaceId,
    tenantId: scope.tenantId,
    // The root workspace is its own scope.
    workspaceId: scope.workspaceId,
    name: '默认工作区',
    slug: 'default',
    status: 'active',
    settings: { locale: 'zh-CN', timezone: 'Asia/Shanghai' },
  });
  logger.log('已创建默认工作区：默认工作区 (slug=default)');
}

async function seedRoles(dataSource: DataSource, scope: DefaultScope): Promise<void> {
  const repository = dataSource.getRepository(Role);
  for (const role of ROLES) {
    const existing = await repository.findOne({ where: { tenantId: scope.tenantId, code: role.code } });
    if (existing) {
      logger.log(`角色已存在，跳过：${role.name}`);
      continue;
    }
    await repository.insert({
      id: ROLE_IDS[role.code],
      tenantId: scope.tenantId,
      workspaceId: scope.workspaceId,
      code: role.code as RoleCode,
      name: role.name,
      description: role.description,
      permissions: role.permissions,
      isSystem: true,
    });
    logger.log(`已创建角色：${role.name} (${role.code})`);
  }
}

async function seedPlatforms(dataSource: DataSource, scope: DefaultScope): Promise<void> {
  const repository = dataSource.getRepository(Platform);
  const codes = Object.values(PlatformCode);
  for (const [index, code] of codes.entries()) {
    const existing = await repository.findOne({ where: { code } });
    if (existing) {
      logger.log(`平台已存在，跳过：${PLATFORM_LABELS[code]}`);
      continue;
    }
    await repository.insert({
      id: `55555555-5555-4555-8555-5555555555${String(index + 1).padStart(2, '0')}`,
      tenantId: scope.tenantId,
      workspaceId: scope.workspaceId,
      code,
      name: PLATFORM_LABELS[code],
      publishMode: PUBLISH_MODES[code],
      capabilities: CAPABILITIES[code] ?? PLUGIN_CAPABILITIES,
      isActive: true,
      sortOrder: index,
    });
    logger.log(`已注册平台：${PLATFORM_LABELS[code]}（${PUBLISH_MODES[code] === PublishMode.Api ? '官方发布接口' : PUBLISH_MODES[code] === PublishMode.Manual ? '人工发布' : '插件填充'}）`);
  }
}

async function seedAdmin(dataSource: DataSource, scope: DefaultScope): Promise<string | null> {
  const userRepository = dataSource.getRepository(User);
  // 按邮箱判重：老安装的管理员 ID 与常量不同。
  const existing =
    (await userRepository.findOne({ where: { email: DEFAULT_ADMIN_EMAIL } })) ??
    (await userRepository.findOne({ where: { id: DEFAULT_ADMIN_ID } }));
  if (existing) {
    logger.log(`管理员已存在，密码保持不变：${existing.email}`);
    return null;
  }

  const password = generatePassword();
  const passwordHash = await bcrypt.hash(password, 10);
  await userRepository.insert({
    id: DEFAULT_ADMIN_ID,
    tenantId: scope.tenantId,
    workspaceId: scope.workspaceId,
    email: DEFAULT_ADMIN_EMAIL,
    phone: null,
    displayName: '系统管理员',
    passwordHash,
    avatarUrl: null,
    status: 'active',
    isSuperAdmin: true,
    lastLoginAt: null,
  });

  const role = await dataSource.getRepository(Role).findOne({ where: { code: 'owner', tenantId: scope.tenantId } });
  if (role) {
    await dataSource.query('INSERT INTO user_roles (users_id, roles_id) VALUES ($1, $2) ON CONFLICT DO NOTHING', [
      DEFAULT_ADMIN_ID,
      role.id,
    ]);
  }

  logger.log(`已创建管理员：${DEFAULT_ADMIN_EMAIL}`);
  return password;
}

export async function runSeed(dataSource: DataSource): Promise<void> {
  logger.log(`开始写入种子数据（AI 标识默认值：${AiFlagType.None}）`);
  await seedWorkspace(dataSource, await resolveDefaultScope(dataSource));
  const scope = await resolveDefaultScope(dataSource);
  await seedRoles(dataSource, scope);
  await seedPlatforms(dataSource, scope);
  const password = await seedAdmin(dataSource, scope);

  process.stdout.write('\n================ 初始登录信息 ================\n');
  process.stdout.write(`用户名：${DEFAULT_ADMIN_EMAIL}\n`);
  process.stdout.write(password ? `密码：${password}\n` : '密码：沿用已有账号密码（本次未重置）\n');
  process.stdout.write('角色：超级管理员\n');
  process.stdout.write('==============================================\n\n');
}
