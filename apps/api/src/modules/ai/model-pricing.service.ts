import { Injectable, Logger } from '@nestjs/common';
import { SettingsService } from '../settings/settings.service';
import {
  CatalogModel,
  DEFAULT_MODEL_CATALOG,
  DEFAULT_USD_CNY_RATE,
  ModelPriceCnyTier,
  ModelPriceCnyTiered,
  ModelPriceUsd,
  findCatalogModel,
  findCatalogProvider,
  isScrapable,
  providerLabel,
} from './model-catalog';
import { ProviderConfig, ProviderConfigService } from './provider-config.service';
import { PeakWindowConfig, PriceTier, describeWindows, tierAt } from './pricing/peak-window';
import { ScrapeResult, scrapeDeepseek } from './pricing/deepseek-pricing';
import { OfficialPriceSnapshot, OfficialPriceStore } from './pricing/official-price.store';

/** 四段计价（人民币 / 百万 token），与中转站价目表一致。 */
export interface ModelPriceCny {
  input: number;
  output: number;
  cacheWrite: number;
  cacheRead: number;
}

export interface ModelPricingView {
  provider: string;
  providerLabel: string;
  model: string;
  label: string;
  /** 实付价（人民币 / 百万 token），按当前时段取峰或谷 */
  price: ModelPriceCny;
  /** 官方价（美元 / 百万 token），仅海外供应商有 */
  officialUsd: ModelPriceUsd | null;
  /** 官方价（人民币 / 百万 token），分峰谷；仅国内供应商有 */
  officialCny: ModelPriceCnyTiered | null;
  /** 当前生效的档位 */
  tier: PriceTier;
  /** 是否分峰谷两档计费 */
  tiered: boolean;
  /** 价格来源：override=自定义覆盖，official=官网抓取，catalog=预置，global=全局兜底价 */
  source: 'override' | 'official' | 'catalog' | 'global';
  /** 该模型是否已被配置为可用 */
  configured: boolean;
  reference: boolean;
  note?: string;
}

export interface ProviderPricingView {
  provider: string;
  label: string;
  /** 是否已在「AI 服务」里配置了密钥 */
  configured: boolean;
  /** 是否已填密钥（用于界面提示"留空不修改"） */
  hasApiKey: boolean;
  baseUrl: string;
  protocol: string;
  /** 是否支持从官网自动抓取价格 */
  scrapable: boolean;
  /** 该供应商下模型：自定义的模型优先，预置模型补充 */
  models: ModelPricingView[];
}

export interface PricingRuleView {
  usdToCny: number;
  /** 说明：当前按什么口径计费 */
  description: string;
  /** 当前时段（峰 / 谷） */
  tier: PriceTier;
  tierLabel: string;
  /** 高峰时段定义（人类可读） */
  peakWindows: string;
  peakConfig: PeakWindowConfig;
  /** 支持自动抓取价格的供应商 */
  scrapableProviders: string[];
}

/**
 * 模型价格解析。
 *
 * 价格优先级（从高到低）：
 *   1. 用户手工覆盖价（AI_MODEL_PRICES）—— 用户说了算
 *   2. 官网自动抓取价（AI_OFFICIAL_PRICES）—— 系统定时刷新，分峰谷
 *   3. 预置目录价（代码内 DEFAULT_MODEL_CATALOG）
 *   4. 全局兜底价（AI_PRICE_* 老配置）
 *
 * 计费时按**调用发生的那一刻**落在高峰还是空闲时段取对应档位，并把档位写进价格快照，
 * 日后官方调价也能解释清楚当时为什么是这个数。
 */
@Injectable()
export class ModelPricingService {
  private readonly logger = new Logger(ModelPricingService.name);

  constructor(
    private readonly settings: SettingsService,
    private readonly providers: ProviderConfigService,
    private readonly officialPrices: OfficialPriceStore,
  ) {}

  /** 汇率（美元 → 人民币） */
  async rate(): Promise<number> {
    const raw = await this.settings.get('AI_USD_CNY_RATE');
    const parsed = Number(raw ?? DEFAULT_USD_CNY_RATE);
    return Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_USD_CNY_RATE;
  }

  /** 峰谷窗口配置（高峰时段定义 + 节假日）。 */
  async peakConfig(): Promise<PeakWindowConfig> {
    const raw = await this.settings.get('AI_PEAK_WINDOWS');
    if (!raw) return { windows: [], holidays: [], timeZone: 'Asia/Shanghai' };
    try {
      const parsed = JSON.parse(raw) as Partial<PeakWindowConfig>;
      return {
        windows: Array.isArray(parsed.windows) ? parsed.windows : [],
        holidays: Array.isArray(parsed.holidays) ? parsed.holidays : [],
        timeZone: typeof parsed.timeZone === 'string' && parsed.timeZone ? parsed.timeZone : 'Asia/Shanghai',
      };
    } catch {
      this.logger.warn('AI_PEAK_WINDOWS 不是合法 JSON，已按不分峰谷处理');
      return { windows: [], holidays: [], timeZone: 'Asia/Shanghai' };
    }
  }

  /** 当前时段（高峰 / 空闲）。未配置任何窗口时恒为 offpeak。 */
  async currentTier(at: Date = new Date()): Promise<PriceTier> {
    const config = await this.peakConfig();
    if (!config.windows.length) return 'offpeak';
    return tierAt(at, config);
  }

  /** 用户自定义覆盖价（人民币 / 百万 token），key 形如 `openai/gpt-5.5`。 */
  private async overrides(): Promise<Record<string, Partial<ModelPriceCny>>> {
    const raw = await this.settings.get('AI_MODEL_PRICES');
    if (!raw) return {};
    try {
      const parsed = JSON.parse(raw) as Record<string, Partial<ModelPriceCny>>;
      return parsed && typeof parsed === 'object' ? parsed : {};
    } catch {
      this.logger.warn('AI_MODEL_PRICES 不是合法 JSON，已忽略');
      return {};
    }
  }

  /** 全局兜底价（老配置，人民币 / 百万 token）。 */
  private async globalFallback(): Promise<ModelPriceCny> {
    const [input, cacheRead, output] = await Promise.all([
      this.settings.get('AI_PRICE_INPUT_PER_MTOK'),
      this.settings.get('AI_PRICE_CACHED_INPUT_PER_MTOK'),
      this.settings.get('AI_PRICE_OUTPUT_PER_MTOK'),
    ]);
    const toNumber = (value: string | null): number => {
      const parsed = Number(value ?? 0);
      return Number.isFinite(parsed) && parsed > 0 ? parsed : 0;
    };
    const inputPrice = toNumber(input);
    return {
      input: inputPrice,
      output: toNumber(output),
      cacheWrite: inputPrice,
      cacheRead: toNumber(cacheRead) > 0 ? toNumber(cacheRead) : inputPrice,
    };
  }

  /**
   * 解析某个模型的**分档**官方人民币价。
   *
   * 返回 null 表示这个模型没有任何可用官方价（调用侧回落到全局兜底价）。
   */
  private resolveOfficial(
    provider: string,
    model: string,
    rate: number,
    snapshot: OfficialPriceSnapshot | null,
  ): { tiered: ModelPriceCnyTiered; source: 'official' | 'catalog' } | null {
    // 1) 官网抓取价（优先，且它带 peak/offpeak 两档）
    const scraped = snapshot?.providers?.[provider]?.[model];
    if (scraped && (scraped.peak.input > 0 || scraped.peak.output > 0)) {
      return {
        tiered: {
          peak: { input: scraped.peak.input, output: scraped.peak.output, cacheRead: scraped.peak.cacheRead },
          offpeak: { input: scraped.offpeak.input, output: scraped.offpeak.output, cacheRead: scraped.offpeak.cacheRead },
        },
        source: 'official',
      };
    }

    // 2) 预置目录价
    const catalogModel = findCatalogModel(provider, model);
    if (!catalogModel) return null;

    if (catalogModel.officialCny) {
      // 国内供应商：目录里直接就是人民币峰谷价
      return { tiered: catalogModel.officialCny, source: 'catalog' };
    }
    if (catalogModel.officialUsd) {
      // 海外供应商：美元价 × 汇率，不分峰谷（两档同价）
      const usd = catalogModel.officialUsd;
      const round4 = (value: number): number => Math.round(value * 10_000) / 10_000;
      const tier: ModelPriceCnyTier = {
        input: round4(usd.input * rate),
        output: round4(usd.output * rate),
        cacheRead: round4(usd.cacheRead * rate),
      };
      return { tiered: { peak: { ...tier }, offpeak: { ...tier } }, source: 'catalog' };
    }
    return null;
  }

  /** 解析单个模型价格；provider 未配置也返回（用于价目展示）。 */
  async priceFor(
    provider: string,
    model: string,
    configs?: ProviderConfig[],
    options: { at?: Date } = {},
  ): Promise<ModelPricingView> {
    const at = options.at ?? new Date();
    const [rate, overrides, fallback, providerConfigs, peakConfig, snapshot] = await Promise.all([
      this.rate(),
      this.overrides(),
      this.globalFallback(),
      configs ? Promise.resolve(configs) : this.providers.list(),
      this.peakConfig(),
      this.officialPrices.read(),
    ]);

    const config = providerConfigs.find((item) => item.provider === provider);
    const catalogModel = findCatalogModel(provider, model);
    const tier: PriceTier = peakConfig.windows.length ? tierAt(at, peakConfig) : 'offpeak';

    const official = this.resolveOfficial(provider, model, rate, snapshot);
    const officialUsd = catalogModel?.officialUsd ?? null;
    const officialCny = official?.tiered ?? null;
    const tiered = Boolean(
      officialCny &&
        (officialCny.peak.input !== officialCny.offpeak.input || officialCny.peak.output !== officialCny.offpeak.output),
    );

    const round4 = (value: number): number => Math.round(value * 10_000) / 10_000;
    const converted: ModelPriceCny | null = officialCny
      ? {
          input: round4(officialCny[tier].input),
          output: round4(officialCny[tier].output),
          // 供应商不单独报"缓存写入"时，按输入价计（保守口径）
          cacheWrite: round4(officialCny[tier].input),
          cacheRead: round4(officialCny[tier].cacheRead),
        }
      : null;

    const override = overrides[`${provider}/${model}`];
    const hasOverride = Boolean(
      override &&
        ['input', 'output', 'cacheWrite', 'cacheRead'].some((key) => Number(override[key as keyof ModelPriceCny]) > 0),
    );

    let price: ModelPriceCny;
    let source: ModelPricingView['source'];
    if (hasOverride && override) {
      /**
       * 只覆盖用户显式填写的段：没填的段回落到官方折算价。
       * 之前用 `?? converted` + `|| 0`，只改输入价会把输出价悄悄变成 0（成本统计少算）。
       */
      const base = converted ?? fallback;
      const pick = (key: keyof ModelPriceCny): number => {
        const raw = override[key];
        return typeof raw === 'number' && Number.isFinite(raw) ? round4(raw) : base[key];
      };
      price = {
        input: pick('input'),
        output: pick('output'),
        cacheWrite: pick('cacheWrite'),
        cacheRead: pick('cacheRead'),
      };
      source = 'override';
    } else if (converted) {
      price = converted;
      source = official?.source ?? 'catalog';
    } else {
      price = fallback;
      source = 'global';
    }

    return {
      provider,
      providerLabel: config?.label ?? providerLabel(provider),
      model,
      label: catalogModel?.label ?? model,
      price,
      officialUsd,
      officialCny,
      tier,
      tiered,
      source,
      configured: Boolean(config),
      reference: catalogModel?.reference ?? false,
      note: catalogModel?.note,
    };
  }

  /**
   * 供应商 + 模型清单（界面上的标签与价目表）。
   * @param options.onlyConfigured 只要已配置密钥的供应商（默认 true）
   */
  async list(options: { onlyConfigured?: boolean } = {}): Promise<ProviderPricingView[]> {
    const configs = await this.providers.list();
    const onlyConfigured = options.onlyConfigured ?? true;
    const providers: ProviderPricingView[] = [];

    for (const config of configs) {
      const models = await this.modelsFor(config);
      providers.push({
        provider: config.provider,
        label: config.label,
        configured: true,
        hasApiKey: Boolean(config.apiKey),
        baseUrl: config.baseUrl,
        protocol: config.protocol,
        scrapable: isScrapable(config.provider),
        models,
      });
    }

    if (!onlyConfigured) {
      // 未配置的供应商也列出（灰显），方便用户先看价目再决定买哪个
      for (const catalog of DEFAULT_MODEL_CATALOG) {
        if (configs.some((config) => config.provider === catalog.provider)) continue;
        const models = await Promise.all(
          catalog.models.map((model) => this.priceFor(catalog.provider, model.model, configs)),
        );
        providers.push({
          provider: catalog.provider,
          label: catalog.label,
          configured: false,
          hasApiKey: false,
          baseUrl: catalog.defaultBaseUrl,
          protocol: catalog.protocol,
          scrapable: isScrapable(catalog.provider),
          models,
        });
      }
    }

    return providers;
  }

  /** 某供应商下的模型：用户配置的模型列表优先，预置目录补充（去重）。 */
  private async modelsFor(config: ProviderConfig): Promise<ModelPricingView[]> {
    const catalog = findCatalogProvider(config.provider);
    const names = [...new Set([...config.models, ...(catalog?.models ?? []).map((model) => model.model)])];
    return Promise.all(names.map((model) => this.priceFor(config.provider, model)));
  }

  /** 按 token 用量与实际价格计算费用（人民币），四段分别计价。 */
  computeCost(
    tokens: { input: number; output: number; cacheWrite?: number; cacheRead?: number },
    price: ModelPriceCny,
  ): { total: number; input: number; output: number; cacheWrite: number; cacheRead: number } {
    const perMillion = (count: number, unit: number): number => (Math.max(0, count) / 1_000_000) * Math.max(0, unit);
    const input = perMillion(tokens.input, price.input);
    const output = perMillion(tokens.output, price.output);
    const cacheWrite = perMillion(tokens.cacheWrite ?? 0, price.cacheWrite);
    const cacheRead = perMillion(tokens.cacheRead ?? 0, price.cacheRead);
    return { total: input + output + cacheWrite + cacheRead, input, output, cacheWrite, cacheRead };
  }

  /** 计费规则说明（界面上像价目表那样直接展示公式与示例）。 */
  async rules(): Promise<PricingRuleView> {
    const rate = await this.rate();
    const configs = await this.providers.list();
    const example = configs[0];
    const exampleModel = example ? (await this.modelsFor(example))[0] : undefined;
    const peakConfig = await this.peakConfig();
    const tier = peakConfig.windows.length ? tierAt(new Date(), peakConfig) : 'offpeak';

    let description: string;
    if (!exampleModel) {
      description = '先在「AI 用量」里配置供应商，价目表会自动出现';
    } else if (exampleModel.officialCny) {
      const label = tier === 'peak' ? '高峰' : '空闲';
      description = `按官方人民币价计费，分峰谷两档：当前为${label}时段，${exampleModel.model} 输入 ￥${exampleModel.price.input} / 输出 ￥${exampleModel.price.output}（每百万 token）`;
    } else {
      description = `人民币价 = 官方美元价 × 汇率 ${rate}。例如 ${exampleModel.model} 输入价：官方 $${(exampleModel.officialUsd?.input ?? 0).toFixed(2)} × ${rate} = ￥${exampleModel.price.input.toFixed(2)} / 百万 token`;
    }

    return {
      usdToCny: rate,
      description,
      tier,
      tierLabel: tier === 'peak' ? '高峰时段' : '空闲时段',
      peakWindows: describeWindows(peakConfig),
      peakConfig,
      scrapableProviders: [...(await this.officialPrices.scrapableProviders())],
    };
  }

  /** 给调用侧用的精确价格（provider + model 必填）。 */
  async costOf(
    provider: string,
    model: string,
    tokens: { input: number; output: number; cacheWrite?: number; cacheRead?: number },
    options: { at?: Date } = {},
  ): Promise<{
    cost: string;
    price: ModelPriceCny;
    source: ModelPricingView['source'];
    tier: PriceTier;
    breakdown: ReturnType<ModelPricingService['computeCost']>;
  }> {
    const pricing = await this.priceFor(provider, model, undefined, options);
    const breakdown = this.computeCost(tokens, pricing.price);
    return { cost: breakdown.total.toFixed(6), price: pricing.price, source: pricing.source, tier: pricing.tier, breakdown };
  }

  /** 覆盖某个模型的实付价（元/百万 token，四段）；写进 AI_MODEL_PRICES 合并保存。 */
  async setOverride(key: string, price: ModelPriceCny): Promise<void> {
    const current = await this.overrides();
    const next = {
      ...current,
      [key]: {
        input: Math.max(0, Number(price.input) || 0),
        output: Math.max(0, Number(price.output) || 0),
        cacheWrite: Math.max(0, Number(price.cacheWrite) || 0),
        cacheRead: Math.max(0, Number(price.cacheRead) || 0),
      },
    };
    await this.settings.updateMany([{ key: 'AI_MODEL_PRICES', value: JSON.stringify(next) }], { id: null, name: '系统' });
    this.logger.log(`已覆盖模型价格：${key}`);
  }

  /** 删除某个模型的覆盖价，恢复官方价。 */
  async clearOverride(key: string): Promise<void> {
    const current = await this.overrides();
    if (!(key in current)) return;
    const next = { ...current };
    delete next[key];
    await this.settings.updateMany([{ key: 'AI_MODEL_PRICES', value: JSON.stringify(next) }], { id: null, name: '系统' });
    this.logger.log(`已恢复官方价：${key}`);
  }

  /** 预置目录（供设置界面展示全部可选模型）。 */
  catalog(): Array<{ provider: string; label: string; defaultBaseUrl: string; protocol: string; models: CatalogModel[] }> {
    return DEFAULT_MODEL_CATALOG.map((item) => ({
      provider: item.provider,
      label: item.label,
      defaultBaseUrl: item.defaultBaseUrl,
      protocol: item.protocol,
      models: item.models,
    }));
  }

  /** 手动触发一次官网抓取（界面「立即抓取」按钮）。 */
  async refreshOfficialPrices(provider: string): Promise<ScrapeResult> {
    if (provider !== 'deepseek') {
      throw new Error(`暂不支持抓取 ${provider} 的官方价格`);
    }
    const result = await scrapeDeepseek();
    if (!result.prices.length) {
      throw new Error(result.warning ?? '未解析到任何价格');
    }
    await this.officialPrices.save(result);
    this.logger.log(`已抓取 ${provider} 官方价格：${result.prices.map((price) => price.model).join('、')}`);
    return result;
  }

  /** 官网价格快照（界面展示抓取时间与来源）。 */
  async officialSnapshot(): Promise<OfficialPriceSnapshot | null> {
    return this.officialPrices.read();
  }

  /** 支持自动抓取的供应商清单。 */
  async scrapableProviders(): Promise<readonly string[]> {
    return this.officialPrices.scrapableProviders();
  }

  /** 是否开启「定时抓取官网价格」。 */
  async officialRefreshEnabled(): Promise<boolean> {
    const raw = await this.settings.get('AI_OFFICIAL_PRICE_AUTO_REFRESH');
    if (raw === null) return true;
    return raw === 'true' || raw === '1';
  }

  /** 抓取间隔（分钟）。0 表示不自动抓取。 */
  async officialRefreshIntervalMinutes(): Promise<number> {
    const raw = await this.settings.get('AI_OFFICIAL_PRICE_REFRESH_MINUTES');
    const parsed = Number(raw ?? 720);
    if (!Number.isFinite(parsed) || parsed < 0) return 720;
    return Math.min(parsed, 10_080);
  }
}
