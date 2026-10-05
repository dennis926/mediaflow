import { BadRequestException, Body, Controller, Get, Put } from '@nestjs/common';
import { toActor } from '../auth/actor.util';
import { AuthUser } from '../auth/auth.types';
import { CurrentUser } from '../auth/current-user.decorator';
import { Capability } from '../auth/capabilities';
import {
  CAPABILITIES,
  CAPABILITY_GROUPS,
  CAPABILITY_LABELS,
  DEFAULT_PERMISSION_MATRIX,
  DEFAULT_ROLE_LABELS,
  DANGEROUS_CAPABILITIES,
  rolesForCapability,
  type Capability as CapabilityName,
} from '../auth/capabilities';
import { ROLE_CODES, type RoleCode } from '../workspace/entities/role.entity';
import { SettingsService } from './settings.service';

interface RoleView {
  code: string;
  label: string;
  /** 内置角色不可删除，但显示名与权限都可以改。 */
  isSystem: boolean;
  /** 该角色拥有的能力点数量，界面上做概览用。 */
  capabilityCount: number;
}

interface CapabilityView {
  key: CapabilityName;
  label: string;
  dangerous: boolean;
  /** 当前允许该能力点的角色代码。 */
  roles: string[];
}

interface CapabilityGroupView {
  group: string;
  label: string;
  description: string;
  capabilities: CapabilityView[];
}

export interface PermissionMatrixView {
  roles: RoleView[];
  groups: CapabilityGroupView[];
  /** 所有能力点 → 中文名，界面上做 tooltip 用。 */
  capabilityLabels: Record<string, string>;
  dangerous: string[];
}

/**
 * 角色与权限的可视化配置。
 *
 * 以前只能手写 PERMISSION_MATRIX / ROLE_LABELS 两段 JSON，运营很容易写错（少个引号整个矩阵就退回默认值，
 * 而且没有任何提示）。这里把它们变成「角色显示名 + 分组勾选的权限表」两个接口：
 * 界面只负责勾选，拼 JSON 与校验都由服务端做。
 */
@Controller('permissions')
export class PermissionsController {
  constructor(private readonly settings: SettingsService) {}

  @Capability('settings.write')
  @Get()
  async view(): Promise<PermissionMatrixView> {
    const roleLabels = (await this.settings.get('ROLE_LABELS')) ?? '';
    const labels = this.parseLabels(roleLabels);

    const roles: RoleView[] = ROLE_CODES.map((code) => ({
      code,
      label: labels[code] ?? DEFAULT_ROLE_LABELS[code] ?? code,
      isSystem: true,
      capabilityCount: CAPABILITIES.filter((capability) => rolesForCapability(capability).includes(code)).length,
    }));

    const groups: CapabilityGroupView[] = CAPABILITY_GROUPS.map((group) => ({
      group: group.group,
      label: group.label,
      description: group.description,
      capabilities: group.capabilities.map((capability) => ({
        key: capability,
        label: CAPABILITY_LABELS[capability],
        dangerous: DANGEROUS_CAPABILITIES.includes(capability),
        roles: rolesForCapability(capability),
      })),
    }));

    return { roles, groups, capabilityLabels: { ...CAPABILITY_LABELS }, dangerous: [...DANGEROUS_CAPABILITIES] };
  }

  /** 保存权限矩阵：能力点 → 角色代码数组。 */
  @Capability('settings.write')
  @Put('matrix')
  async saveMatrix(
    @Body() body: { matrix?: Record<string, unknown> },
    @CurrentUser() user?: AuthUser,
  ): Promise<PermissionMatrixView> {
    const input = body?.matrix;
    if (!input || typeof input !== 'object') throw new BadRequestException('缺少 matrix');

    const validRoles = new Set<string>(ROLE_CODES);
    const matrix: Record<string, string[]> = {};
    for (const capability of CAPABILITIES) {
      const raw = (input as Record<string, unknown>)[capability];
      if (raw === undefined) {
        // 未提交的能力点保持原样，避免界面漏传一项就把它的权限清空
        matrix[capability] = rolesForCapability(capability);
        continue;
      }
      if (!Array.isArray(raw)) throw new BadRequestException(`${capability} 的角色必须是数组`);
      const roles = raw.map((item) => String(item)).filter((item) => validRoles.has(item));
      const unknown = raw.map((item) => String(item)).filter((item) => !validRoles.has(item));
      if (unknown.length > 0) throw new BadRequestException(`${capability} 含未知角色：${unknown.join('、')}`);
      matrix[capability] = [...new Set(roles)];
    }

    await this.settings.updateMany(
      [{ key: 'PERMISSION_MATRIX', value: JSON.stringify(matrix) }],
      toActor(user),
    );
    return this.view();
  }

  /** 保存角色显示名：角色代码 → 公司内部叫法。 */
  @Capability('settings.write')
  @Put('roles')
  async saveRoleLabels(
    @Body() body: { labels?: Record<string, unknown> },
    @CurrentUser() user?: AuthUser,
  ): Promise<PermissionMatrixView> {
    const input = body?.labels;
    if (!input || typeof input !== 'object') throw new BadRequestException('缺少 labels');

    const validRoles = new Set<string>(ROLE_CODES);
    const labels: Record<string, string> = {};
    for (const code of ROLE_CODES) {
      const raw = (input as Record<string, unknown>)[code];
      if (raw === undefined) continue;
      const text = String(raw).trim();
      if (text.length > 20) throw new BadRequestException(`角色「${code}」的显示名不能超过 20 个字`);
      // 空字符串表示恢复默认叫法
      if (text === '') continue;
      if (!validRoles.has(code)) continue;
      labels[code] = text;
    }

    await this.settings.updateMany(
      [{ key: 'ROLE_LABELS', value: Object.keys(labels).length > 0 ? JSON.stringify(labels) : '' }],
      toActor(user),
    );
    return this.view();
  }

  /** 恢复出厂设置：矩阵与显示名都回到代码里的默认值。 */
  @Capability('settings.write')
  @Put('reset')
  async reset(@CurrentUser() user?: AuthUser): Promise<PermissionMatrixView> {
    await this.settings.updateMany(
      [
        { key: 'PERMISSION_MATRIX', value: '' },
        { key: 'ROLE_LABELS', value: '' },
      ],
      toActor(user),
    );
    return this.view();
  }

  private parseLabels(raw: string): Record<string, string> {
    if (!raw) return {};
    try {
      const parsed = JSON.parse(raw) as Record<string, unknown>;
      if (!parsed || typeof parsed !== 'object') return {};
      return Object.fromEntries(Object.entries(parsed).map(([code, label]) => [code, String(label)]));
    } catch {
      return {};
    }
  }
}

/** 默认矩阵导出给测试用，避免测试里重复一份常量。 */
export const DEFAULT_MATRIX_FOR_TEST: Record<string, RoleCode[]> = DEFAULT_PERMISSION_MATRIX;
