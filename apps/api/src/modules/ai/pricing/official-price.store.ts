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
  fetchedAt: string;
  sourceUrl: string;
  /** 该供应商本次抓取到的模型价格（key = 供应商自己的模型名）。 */
  models: Record<string, ScrapedPrice>;
  /** 最近一次抓取失败的原因；成功后清空。 */
  error?: string;
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
  warnings?: string[];
}

const SETTING_KEY = 'AI_OFFICIAL_PRICES';

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
      detail[result.provider] = {
        fetchedAt: result.fetchedAt,
        sourceUrl: result.sourceUrl,
        models,
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
      warnings: warnings.length ? [...(current?.warnings ?? []), ...warnings] : current?.warnings,
    };
    await this.settings.updateMany([{ key: SETTING_KEY, value: JSON.stringify(next) }], {
      id: null,
      name: '系统',
    });
    return next;
  }

  /** 记录某供应商抓取失败（保留其上一份价格，只更新失败原因）。 */
  async recordFailure(provider: string, error: string): Promise<void> {
    const current = await this.read();
    const detail: Record<string, OfficialPriceProviderSnapshot> = { ...(current?.detail ?? {}) };
    const existing = detail[provider];
    if (!existing) return;
    detail[provider] = { ...existing, error };
    const next: OfficialPriceSnapshot = {
      fetchedAt: current?.fetchedAt ?? new Date().toISOString(),
      sources: current?.sources ?? {},
      providers: current?.providers ?? {},
      detail,
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
