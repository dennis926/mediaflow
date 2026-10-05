import { Injectable, Logger } from '@nestjs/common';
import { SettingsService } from '../../settings/settings.service';
import { SCRAPABLE_PROVIDERS } from '../model-catalog';
import { ScrapeResult, ScrapedPrice } from './types';

/**
 * 官网价格快照的存取。
 *
 * 存在 `system_settings` 的 `AI_OFFICIAL_PRICES`（JSON，非密钥），而不是单独建表：
 * 它是一份"最近一次抓取结果"的缓存，没有查询/关联需求，放设置里可复用现成的
 * 租户隔离、审计与导出能力，也避免为一次抓取引入一张生命周期复杂的表。
 *
 * 每个供应商独立记录 `fetchedAt` 与失败原因：抓一家失败不能让另一家的
 * "上次成功时间"看起来也是新的，否则界面会显示一个骗人的新鲜度。
 */
export interface OfficialPriceProviderSnapshot {
  /** 最近一次「抓取成功」的时间；失败不会推进它，界面据此判断价格是否还新鲜。 */
  fetchedAt: string;
  sourceUrl: string;
  /** 该供应商最近一次抓取到的模型价格（key = 供应商自己的模型名）。 */
  models: Record<string, ScrapedPrice>;
  /** 最近一次抓取失败的原因；成功后清空。 */
  error?: string;
  /** 最近一次抓取失败的时间；成功后清空。 */
  failedAt?: string;
  /** 连续失败次数；成功后归零。用于定时任务的退避。 */
  consecutiveFailures?: number;
  /** 最近的失败记录（新→旧，最多保留 FAILURE_LOG_LIMIT 条），抓取成功后保留。 */
  failures?: PriceFailureRecord[];
}

/** 一条抓取失败记录。 */
export interface PriceFailureRecord {
  at: string;
  message: string;
}

export interface OfficialPriceSnapshot {
  /** 最近一次任意供应商抓取的时间（兼容旧字段）。 */
  fetchedAt: string;
  /** provider -> sourceUrl（兼容旧字段）。 */
  sources: Record<string, string>;
  /** provider -> 模型价格（兼容旧字段）。 */
  providers: Record<string, Record<string, ScrapedPrice>>;
  /** provider -> 抓取明细（新字段，界面按它显示新鲜度与失败原因）。 */
  detail?: Record<string, OfficialPriceProviderSnapshot>;
  /**
   * 聚合价目表（models.dev）的价格，**只在官网抓取价缺失时使用**。
   *
   * 单独放一层而不是混进 `providers`：它是美元聚合价，且把峰谷拍平成单档，
   * 一旦覆盖官网价会让高峰时段少收一半。分开存才能保证优先级不可越级。
   */
  aggregate?: {
    fetchedAt: string;
    sourceUrl: string;
    /** provider -> 目录模型 id -> 价格 */
    providers: Record<string, Record<string, ScrapedPrice>>;
    error?: string;
  };
  /**
   * 国内权威参考价（国家超算互联网）。
   *
   * 与 `aggregate` 分开一层的原因：这一层是**人民币、国内官方口径**，不涉及
   * 币种换算；它单独存在是为了在「官网抓不到」时优先于美元聚合价——对国内
   * 供应商来说，人民币参考价远比按汇率折算的美元价可靠（少了汇率这一层误差）。
   * 但它仍是平台转售刊例价，不是厂商官网价，所以排在官网抓取价之后。
   */
  domestic?: {
    fetchedAt: string;
    sourceUrl: string;
    providers: Record<string, Record<string, ScrapedPrice>>;
    error?: string;
  };
  warnings?: string[];
}

const SETTING_KEY = 'AI_OFFICIAL_PRICES';

/** 每个供应商最多保留多少条失败记录（防止设置项无限膨胀）。 */
const FAILURE_LOG_LIMIT = 20;

@Injectable()
export class OfficialPriceStore {
  private readonly logger = new Logger(OfficialPriceStore.name);

  constructor(private readonly settings: SettingsService) {}

  /** 读取最近一次抓取结果；从未抓取或 JSON 损坏时返回 null。 */
  async read(): Promise<OfficialPriceSnapshot | null> {
    const raw = await this.settings.get(SETTING_KEY);
    if (!raw) return null;
    try {
      const parsed = JSON.parse(raw) as OfficialPriceSnapshot;
      if (!parsed || typeof parsed !== 'object' || !parsed.providers) return null;
      return parsed;
    } catch {
      this.logger.warn(`${SETTING_KEY} 不是合法 JSON，已忽略`);
      return null;
    }
  }

  /** 合并保存一次抓取结果（按供应商覆盖，其他供应商的既有结果保留）。 */
  async save(result: ScrapeResult): Promise<OfficialPriceSnapshot> {
    return this.saveMany([result]);
  }

  /**
   * 批量保存多次抓取结果（一轮定时抓取会拿到多个供应商）。
   *
   * 只写一次设置项：逐个写会产生多份中间态，界面上会出现"抓了一半"的价目表。
   */
  async saveMany(results: ScrapeResult[]): Promise<OfficialPriceSnapshot> {
    const current = await this.read();
    const providers: OfficialPriceSnapshot['providers'] = { ...(current?.providers ?? {}) };
    const sources: OfficialPriceSnapshot['sources'] = { ...(current?.sources ?? {}) };
    const detail: Record<string, OfficialPriceProviderSnapshot> = { ...(current?.detail ?? {}) };
    let latest = current?.fetchedAt ?? new Date(0).toISOString();

    for (const result of results) {
      const models: Record<string, ScrapedPrice> = {};
      for (const price of result.prices) {
        models[price.model] = price;
      }
      providers[result.provider] = models;
      sources[result.provider] = result.sourceUrl;
      const previous = detail[result.provider];
      detail[result.provider] = {
        fetchedAt: result.fetchedAt,
        sourceUrl: result.sourceUrl,
        models,
        // 成功即清空「当前错误」，但保留历史失败记录——否则一次成功会把
        // 「这家曾经连续被反爬拦截 6 次」这类信息抹掉。
        failures: previous?.failures,
      };
      if (result.fetchedAt > latest) latest = result.fetchedAt;
    }

    const warnings = results
      .map((result) => result.warning)
      .filter((warning): warning is string => Boolean(warning));

    const next: OfficialPriceSnapshot = {
      fetchedAt: latest,
      sources,
      providers,
      detail,
      aggregate: current?.aggregate,
      domestic: current?.domestic,
      warnings: warnings.length ? [...(current?.warnings ?? []), ...warnings] : current?.warnings,
    };
    await this.settings.updateMany([{ key: SETTING_KEY, value: JSON.stringify(next) }], {
      id: null,
      name: '系统',
    });
    return next;
  }

  /**
   * 记录某供应商抓取失败（保留其上一份价格，只更新失败原因与失败时间）。
   *
   * 对「从未成功抓取过」的供应商同样建档（`fetchedAt` 置空字符串）：
   * 否则一家从上线第一天起就被反爬拦住的供应商在快照里完全不存在，
   * 界面上看不出它被配置过、更看不出它为什么没价格——这正是豆包遇到的情况。
   */
  async recordFailure(provider: string, error: string, sourceUrl = ''): Promise<void> {
    const current = await this.read();
    const detail: Record<string, OfficialPriceProviderSnapshot> = { ...(current?.detail ?? {}) };
    const existing = detail[provider];
    const at = new Date().toISOString();
    const failures = [{ at, message: error }, ...(existing?.failures ?? [])].slice(0, FAILURE_LOG_LIMIT);
    detail[provider] = {
      fetchedAt: existing?.fetchedAt ?? '',
      sourceUrl: existing?.sourceUrl || sourceUrl,
      models: existing?.models ?? {},
      error,
      failedAt: at,
      consecutiveFailures: (existing?.consecutiveFailures ?? 0) + 1,
      failures,
    };
    const next: OfficialPriceSnapshot = {
      fetchedAt: current?.fetchedAt ?? new Date().toISOString(),
      sources: current?.sources ?? {},
      providers: current?.providers ?? {},
      detail,
      aggregate: current?.aggregate,
      domestic: current?.domestic,
      warnings: current?.warnings,
    };
    await this.settings.updateMany([{ key: SETTING_KEY, value: JSON.stringify(next) }], {
      id: null,
      name: '系统',
    });
  }

  /**
   * 保存聚合价目表（models.dev）的结果。
   *
   * 只覆盖 `aggregate` 层，绝不触碰 `providers`（官网抓取价）——两层混在一起
   * 就没法保证「官网价优先」了。
   */
  async saveAggregate(results: ScrapeResult[]): Promise<void> {
    const current = await this.read();
    const providers: Record<string, Record<string, ScrapedPrice>> = { ...(current?.aggregate?.providers ?? {}) };
    let fetchedAt = current?.aggregate?.fetchedAt ?? '';
    let sourceUrl = current?.aggregate?.sourceUrl ?? '';

    for (const result of results) {
      const models: Record<string, ScrapedPrice> = {};
      for (const price of result.prices) models[price.model] = price;
      providers[result.provider] = models;
      sourceUrl = result.sourceUrl;
      if (result.fetchedAt > fetchedAt) fetchedAt = result.fetchedAt;
    }

    const next: OfficialPriceSnapshot = {
      fetchedAt: current?.fetchedAt ?? new Date().toISOString(),
      sources: current?.sources ?? {},
      providers: current?.providers ?? {},
      detail: current?.detail,
      aggregate: { fetchedAt, sourceUrl, providers },
      domestic: current?.domestic,
      warnings: current?.warnings,
    };
    await this.settings.updateMany([{ key: SETTING_KEY, value: JSON.stringify(next) }], {
      id: null,
      name: '系统',
    });
  }

  /** 记录聚合价目表抓取失败（保留上一份聚合价，只写原因）。 */
  async recordAggregateFailure(error: string, sourceUrl = ''): Promise<void> {
    const current = await this.read();
    const next: OfficialPriceSnapshot = {
      fetchedAt: current?.fetchedAt ?? new Date().toISOString(),
      sources: current?.sources ?? {},
      providers: current?.providers ?? {},
      detail: current?.detail,
      aggregate: {
        fetchedAt: current?.aggregate?.fetchedAt ?? '',
        sourceUrl: current?.aggregate?.sourceUrl || sourceUrl,
        providers: current?.aggregate?.providers ?? {},
        error,
      },
      domestic: current?.domestic,
      warnings: current?.warnings,
    };
    await this.settings.updateMany([{ key: SETTING_KEY, value: JSON.stringify(next) }], {
      id: null,
      name: '系统',
    });
  }

  /**
   * 保存国内权威参考价（国家超算互联网）。
   *
   * 与 `saveAggregate` 一样只覆盖自己这一层：国内参考价与美元聚合价的优先级
   * 不同（人民币参考价优先），混进同一层就没法区分了。
   */
  async saveDomestic(results: ScrapeResult[]): Promise<void> {
    const current = await this.read();
    const providers: Record<string, Record<string, ScrapedPrice>> = { ...(current?.domestic?.providers ?? {}) };
    let fetchedAt = current?.domestic?.fetchedAt ?? '';
    let sourceUrl = current?.domestic?.sourceUrl ?? '';

    for (const result of results) {
      const models: Record<string, ScrapedPrice> = {};
      for (const price of result.prices) models[price.model] = price;
      providers[result.provider] = models;
      sourceUrl = result.sourceUrl;
      if (result.fetchedAt > fetchedAt) fetchedAt = result.fetchedAt;
    }

    const next: OfficialPriceSnapshot = {
      fetchedAt: current?.fetchedAt ?? new Date().toISOString(),
      sources: current?.sources ?? {},
      providers: current?.providers ?? {},
      detail: current?.detail,
      aggregate: current?.aggregate,
      domestic: { fetchedAt, sourceUrl, providers },
      warnings: current?.warnings,
    };
    await this.settings.updateMany([{ key: SETTING_KEY, value: JSON.stringify(next) }], {
      id: null,
      name: '系统',
    });
  }

  /** 记录国内权威参考价抓取失败（保留上一份，只写原因）。 */
  async recordDomesticFailure(error: string, sourceUrl = ''): Promise<void> {
    const current = await this.read();
    const next: OfficialPriceSnapshot = {
      fetchedAt: current?.fetchedAt ?? new Date().toISOString(),
      sources: current?.sources ?? {},
      providers: current?.providers ?? {},
      detail: current?.detail,
      aggregate: current?.aggregate,
      domestic: {
        fetchedAt: current?.domestic?.fetchedAt ?? '',
        sourceUrl: current?.domestic?.sourceUrl || sourceUrl,
        providers: current?.domestic?.providers ?? {},
        error,
      },
      warnings: current?.warnings,
    };
    await this.settings.updateMany([{ key: SETTING_KEY, value: JSON.stringify(next) }], {
      id: null,
      name: '系统',
    });
  }

  /** 支持自动抓取的供应商清单。 */
  async scrapableProviders(): Promise<readonly string[]> {
    return SCRAPABLE_PROVIDERS;
  }
}
