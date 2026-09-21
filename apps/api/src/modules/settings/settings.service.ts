import { BadRequestException, Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { AuditService } from '../../audit/audit.service';
import { CryptoService } from '../../common/crypto.service';
import { WorkspaceContextService } from '../../common/workspace-context.service';
import { currentWorkspaceScope } from '../../common/workspace-context.store';
import { SystemSetting } from './entities/system-setting.entity';
import { SETTING_BY_KEY, SETTING_DEFINITIONS, SETTING_GROUP_LABELS, SettingGroup } from './settings.registry';
import { applyRuntimeConfig, dropWorkspaceRuntimeConfig, runtime, setFallbackWorkspace } from './runtime-config';

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
  /**
   * 配置值缓存。**键必须含租户与工作区**：早期只按 key 缓存，多工作区场景下
   * A 公司读到的会是 B 公司（或默认工作区）的值 —— 涉及 AI 密钥这类敏感项时是越权读取（B0.5 修复）。
   */
  private readonly cache = new Map<string, string | null>();

  private cacheKey(tenantId: string, workspaceId: string, key: string): string {
    return `${tenantId}::${workspaceId}::${key}`;
  }

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
      try {
        const value = await this.get(definition.key);
        if (value !== null && value !== undefined && value !== '') values[definition.key] = value;
      } catch (error) {
        /**
         * 单个键读取失败（典型场景：数据库还没跑迁移/种子）不能让整份运行时配置退回代码默认值——
         * 那样会连**环境变量**提供的兜底值一起丢掉（B0.8 实测：容器里 API 因此误启动了队列消费者）。
         * 这里逐键容错，环境的兜底仍然会通过 get() 生效。
         */
        this.logger.debug(`配置项 ${definition.key} 读取失败，已跳过：${error instanceof Error ? error.message : String(error)}`);
      }
    }
    return values;
  }

  /**
   * 把当前工作区的配置刷进**它自己那一份**运行时快照（B0.5）。
   *
   * 启动时（没有请求作用域）解析到的是默认工作区：此时额外把它设为"无作用域时的兜底"，
   * 这样队列 worker、cron 任务读到的仍然是运维在后台配的那一套（与改造前行为一致），
   * 而其它工作区保存设置只影响自己的工作区，不再互相覆盖。
   */
  async refreshRuntimeConfig(): Promise<void> {
    const scope = await this.workspaceContext.current();
    const flat = await this.flat();
    applyRuntimeConfig(flat, (message) => this.logger.warn(`配置解析失败：${message}`), scope.workspaceId);
    if (!currentWorkspaceScope()) setFallbackWorkspace(scope.workspaceId);
    this.logger.debug(`运行时配置已刷新：工作区 ${scope.workspaceId}`);
  }

  /** 工作区被彻底清除时调用：丢弃它的运行时快照（避免内存里长期留着死租户的配置）。 */
  forgetWorkspace(workspaceId: string): void {
    dropWorkspaceRuntimeConfig(workspaceId);
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

    const definition = SETTING_BY_KEY.get(key);
    const scope = await this.workspaceContext.current();
    const cacheKey = this.cacheKey(scope.tenantId, scope.workspaceId, key);
    if (this.cache.has(cacheKey)) return this.cache.get(cacheKey) ?? null;
    // 租户 + 工作区双条件：只按工作区过滤时，构造出的"同工作区但属别的租户"的行会被读到（B0.5 修复）
    const row = await this.repository.findOne({
      where: { tenantId: scope.tenantId, workspaceId: scope.workspaceId, key },
    });

    let value: string | null = null;
    if (row && row.value !== null && row.value !== '') {
      value = row.isSecret ? this.crypto.decrypt(row.value) : row.value;
    } else if (definition) {
      const fromEnv = process.env[definition.envKey];
      value = fromEnv && fromEnv.trim() !== '' ? fromEnv : null;
    }
    this.cache.set(cacheKey, value);
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
    const rows = await this.repository.find({ where: { tenantId: scope.tenantId, workspaceId: scope.workspaceId } });
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
        where: { tenantId: scope.tenantId, workspaceId: scope.workspaceId, key: item.key },
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
