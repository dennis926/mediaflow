import { BadRequestException, Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { AuditService } from '../../audit/audit.service';
import { CryptoService } from '../../common/crypto.service';
import { WorkspaceContextService } from '../../common/workspace-context.service';
import { SystemSetting } from './entities/system-setting.entity';
import { SETTING_BY_KEY, SETTING_DEFINITIONS, SETTING_GROUP_LABELS, SettingGroup } from './settings.registry';
import { applyRuntimeConfig, runtime } from './runtime-config';

export interface SettingView {
  key: string;
  label: string;
  description: string;
  secret: boolean;
  group: SettingGroup;
  groupLabel: string;
  value: string;
  configured: boolean;
  /** db = 后台界面配置，env = 来自 .env，none = 尚未配置 */
  source: 'db' | 'env' | 'none';
  placeholder?: string;
  options?: Array<{ value: string; label: string }>;
}

export interface SettingGroupView {
  group: SettingGroup;
  label: string;
  items: SettingView[];
}

export interface SettingsActor {
  id?: string | null;
  name?: string | null;
}

/**
 * Runtime configuration store: database first, environment as fallback.
 * Values marked as secret are encrypted with CryptoService before they hit the database.
 */
@Injectable()
export class SettingsService implements OnModuleInit {
  private readonly logger = new Logger(SettingsService.name);
  /** Bumped on every write so cached consumers (e.g. the AI provider) rebuild. */
  private version = 1;
  private readonly cache = new Map<string, string | null>();

  constructor(
    @InjectRepository(SystemSetting) private readonly repository: Repository<SystemSetting>,
    private readonly crypto: CryptoService,
    private readonly workspaceContext: WorkspaceContextService,
    private readonly audit: AuditService,
  ) {}

  get revision(): number {
    return this.version;
  }

  /** 启动时把数据库里的配置刷进运行时快照，业务代码同步读 runtime()。 */
  async onModuleInit(): Promise<void> {
    try {
      await this.refreshRuntimeConfig();
      const config = runtime();
      this.logger.log(`运行时配置已加载：站点「${config.site.name}」，合规规则 ${config.compliance.length} 组，知识库注入上限 ${config.knowledge.injectLimit} 条`);
    } catch (error) {
      this.logger.warn(`运行时配置加载失败，使用默认值：${error instanceof Error ? error.message : String(error)}`);
    }
  }

  /** 全部配置的扁平快照（未配置的键不出现，由默认值兜底）。 */
  async flat(): Promise<Record<string, string | undefined>> {
    const values: Record<string, string | undefined> = {};
    for (const definition of SETTING_DEFINITIONS) {
      const value = await this.get(definition.key);
      if (value !== null && value !== undefined && value !== '') values[definition.key] = value;
    }
    return values;
  }

  /** 把当前配置刷进运行时快照；保存设置后会自动调用。 */
  async refreshRuntimeConfig(): Promise<void> {
    applyRuntimeConfig(await this.flat(), (message) => this.logger.warn(`配置解析失败：${message}`));
  }

  /** Effective value: database override, then environment, then undefined. */
  async get(key: string): Promise<string | null> {
    /**
     * 测试专用覆盖：`MEDIAFLOW_SETTING_OVERRIDE_<KEY>` 优先级高于数据库。
     * 用于端到端测试强制走离线 mock 提供方（数据库里的真实配置会覆盖普通环境变量，靠 env 是锁不住的）。
     * 生产环境不设置这些变量，因此没有行为变化。
     */
    const override = process.env[`MEDIAFLOW_SETTING_OVERRIDE_${key}`];
    if (override !== undefined) return override;

    if (this.cache.has(key)) return this.cache.get(key) ?? null;
    const definition = SETTING_BY_KEY.get(key);
    const scope = await this.workspaceContext.current();
    const row = await this.repository.findOne({ where: { workspaceId: scope.workspaceId, key } });

    let value: string | null = null;
    if (row && row.value !== null && row.value !== '') {
      value = row.isSecret ? this.crypto.decrypt(row.value) : row.value;
    } else if (definition) {
      const fromEnv = process.env[definition.envKey];
      value = fromEnv && fromEnv.trim() !== '' ? fromEnv : null;
    }
    this.cache.set(key, value);
    return value;
  }

  async getBoolean(key: string, fallback: boolean): Promise<boolean> {
    const value = await this.get(key);
    if (value === null) return fallback;
    return value === 'true';
  }

  async getNumber(key: string, fallback: number): Promise<number> {
    const value = await this.get(key);
    const parsed = Number(value);
    return value !== null && Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
  }

  async list(): Promise<SettingGroupView[]> {
    const scope = await this.workspaceContext.current();
    const rows = await this.repository.find({ where: { workspaceId: scope.workspaceId } });
    const byKey = new Map(rows.map((row) => [row.key, row]));

    const groups = new Map<SettingGroup, SettingView[]>();
    for (const definition of SETTING_DEFINITIONS) {
      const row = byKey.get(definition.key);
      let plain: string | null = null;
      if (row && row.value !== null && row.value !== '') {
        plain = row.isSecret ? this.crypto.decrypt(row.value) : row.value;
      }
      const fromDb = plain !== null && plain !== '';
      const fromEnvValue = process.env[definition.envKey];
      const fromEnv = !fromDb && Boolean(fromEnvValue && fromEnvValue.trim() !== '');

      // Non-secret keys expose the effective value so the form reflects reality; secrets are masked.
      const effective = definition.secret ? (plain ? this.crypto.mask(plain) : '') : (plain ?? fromEnvValue ?? '');
      const view: SettingView = {
        key: definition.key,
        label: definition.label,
        description: definition.description,
        secret: definition.secret,
        group: definition.group,
        groupLabel: SETTING_GROUP_LABELS[definition.group],
        value: effective,
        configured: fromDb || fromEnv,
        source: fromDb ? 'db' : fromEnv ? 'env' : 'none',
        placeholder: definition.placeholder,
        options: definition.options,
      };
      const bucket = groups.get(definition.group) ?? [];
      bucket.push(view);
      groups.set(definition.group, bucket);
    }

    return [...groups.entries()].map(([group, items]) => ({
      group,
      label: SETTING_GROUP_LABELS[group],
      items,
    }));
  }

  /** Upserts the given keys. An empty value clears the override so the .env value is used again. */
  async updateMany(items: Array<{ key: string; value: string }>, actor: SettingsActor): Promise<SettingGroupView[]> {
    const scope = await this.workspaceContext.current();
    const changed: string[] = [];

    for (const item of items) {
      const definition = SETTING_BY_KEY.get(item.key);
      if (!definition) throw new BadRequestException(`未知配置项：${item.key}`);

      const trimmed = item.value?.trim() ?? '';
      const existing = await this.repository.findOne({
        where: { workspaceId: scope.workspaceId, key: item.key },
      });

      if (trimmed === '') {
        if (existing) await this.repository.delete({ id: existing.id });
        changed.push(item.key);
        continue;
      }

      const isMaskedPlaceholder = definition.secret && trimmed.startsWith('••••');
      if (isMaskedPlaceholder) continue;

      const value = definition.secret ? this.crypto.encrypt(trimmed) : trimmed;
      if (existing) {
        await this.repository.update({ id: existing.id }, { value, isSecret: definition.secret, updatedBy: actor.id ?? null });
      } else {
        await this.repository.save(
          this.repository.create({
            tenantId: scope.tenantId,
            workspaceId: scope.workspaceId,
            key: item.key,
            value,
            isSecret: definition.secret,
            updatedBy: actor.id ?? null,
          }),
        );
      }
      changed.push(item.key);
    }

    this.cache.clear();
    this.version += 1;
    // 配置改完立刻生效：业务代码读的是运行时快照，不需要重启服务。
    await this.refreshRuntimeConfig();

    await this.audit.record({
      action: 'settings.update',
      resourceType: 'system_setting',
      resourceId: null,
      tenantId: scope.tenantId,
      workspaceId: scope.workspaceId,
      actorId: actor.id ?? null,
      actorName: actor.name ?? null,
      // Never log secret values, only which keys changed.
      payload: { keys: changed },
    });
    this.logger.log(`配置已更新：${changed.join(', ')}`);
    return this.list();
  }
}
