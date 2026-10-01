import { Injectable, Logger } from '@nestjs/common';
import { SettingsService } from '../../settings/settings.service';
import { ScrapedPrice, ScrapeResult } from './deepseek-pricing';

/**
 * 官网价格快照的存取。
 *
 * 存在 `system_settings` 的 `AI_OFFICIAL_PRICES`（JSON，非密钥），而不是单独建表：
 * 它是一份"最近一次抓取结果"的缓存，没有查询/关联需求，放设置里可复用现成的
 * 租户隔离、审计与导出能力，也避免为一次抓取引入一张生命周期复杂的表。
 */
export interface OfficialPriceSnapshot {
  fetchedAt: string;
  /** provider -> sourceUrl */
  sources: Record<string, string>;
  /** provider -> model -> 价格 */
  providers: Record<string, Record<string, ScrapedPrice>>;
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
    const current = await this.read();
    const providers: OfficialPriceSnapshot['providers'] = { ...(current?.providers ?? {}) };
    const models: Record<string, ScrapedPrice> = {};
    for (const price of result.prices) {
      models[price.model] = price;
    }
    providers[result.provider] = models;

    const next: OfficialPriceSnapshot = {
      fetchedAt: result.fetchedAt,
      sources: { ...(current?.sources ?? {}), [result.provider]: result.sourceUrl },
      providers,
      warnings: result.warning ? [...(current?.warnings ?? []), result.warning] : current?.warnings,
    };
    await this.settings.updateMany([{ key: SETTING_KEY, value: JSON.stringify(next) }], { id: null, name: '系统' });
    return next;
  }

  /** 支持自动抓取的供应商清单。 */
  async scrapableProviders(): Promise<readonly string[]> {
    return ['deepseek'];
  }
}
