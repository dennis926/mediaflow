import { Injectable, Logger } from '@nestjs/common';
import { SettingsService } from '../settings/settings.service';
import {
  CatalogModel,
  DEFAULT_MODEL_CATALOG,
  DEFAULT_USD_CNY_RATE,
  ModelPriceUsd,
  findCatalogModel,
  findCatalogProvider,
  providerLabel,
} from './model-catalog';
import { ProviderConfig, ProviderConfigService } from './provider-config.service';

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
  /** 实付价（人民币 / 百万 token） */
  price: ModelPriceCny;
  /** 官方价（美元 / 百万 token），用于并排展示 */
  officialUsd: ModelPriceUsd;
  /** 价格来源：override=自定义覆盖，catalog=官方价（预置），global=全局兜底价 */
  source: 'override' | 'catalog' | 'global';
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
  /** 该供应商下模型：自定义的模型优先，预置模型补充 */
  models: ModelPricingView[];
}

export interface PricingRuleView {
  usdToCny: number;
  /** 说明：官方美元价按汇率折算成人民币展示 */
  description: string;
}

/**
 * 模型价格解析。
 *
 * 价格一律采用**供应商官方价**：目录里存官方美元价，按汇率折算成人民币展示；
 * 需要时用户可以按官方调价自行覆盖某个模型（AI_MODEL_PRICES）。
 * 三层优先级：用户覆盖价 > 官方价 × 汇率 > 全局兜底价。
 */
@Injectable()
export class ModelPricingService {
  private readonly logger = new Logger(ModelPricingService.name);

  constructor(
    private readonly settings: SettingsService,
    private readonly providers: ProviderConfigService,
  ) {}

  /** 汇率（美元 → 人民币） */
  async rate(): Promise<number> {
    const raw = await this.settings.get('AI_USD_CNY_RATE');
    const parsed = Number(raw ?? DEFAULT_USD_CNY_RATE);
    return Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_USD_CNY_RATE;
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

  /** 解析单个模型价格；provider 未配置也返回（用于价目展示）。 */
  async priceFor(provider: string, model: string, configs?: ProviderConfig[]): Promise<ModelPricingView> {
    const [rate, overrides, fallback, providerConfigs] = await Promise.all([
      this.rate(),
      this.overrides(),
      this.globalFallback(),
      configs ? Promise.resolve(configs) : this.providers.list(),
    ]);

    const config = providerConfigs.find((item) => item.provider === provider);
    const catalogModel = findCatalogModel(provider, model);
    const officialUsd = catalogModel?.officialUsd ?? { input: 0, output: 0, cacheWrite: 0, cacheRead: 0 };
    // 官方价按汇率折算（不做任何折扣）；统一保留 4 位小数，避免 1.9600000000000002 这类浮点尾数进库
    const round4 = (value: number): number => Math.round(value * 10_000) / 10_000;
    const converted: ModelPriceCny = {
      input: round4(officialUsd.input * rate),
      output: round4(officialUsd.output * rate),
      cacheWrite: round4(officialUsd.cacheWrite * rate),
      cacheRead: round4(officialUsd.cacheRead * rate),
    };

    const override = overrides[`${provider}/${model}`];
    const hasOverride = Boolean(override && ['input', 'output', 'cacheWrite', 'cacheRead'].some((key) => Number(override[key as keyof ModelPriceCny]) > 0));
    const hasUsableCatalog = officialUsd.input > 0 || officialUsd.output > 0;

    let price: ModelPriceCny;
    let source: ModelPricingView['source'];
    if (hasOverride && override) {
      /**
       * 只覆盖用户显式填写的段：没填的段回落到官方折算价。
       * 之前用 `?? converted` + `|| 0`，只改输入价会把输出价悄悄变成 0（成本统计少算）。
       */
      const pick = (key: keyof ModelPriceCny): number => {
        const raw = override[key];
        return typeof raw === 'number' && Number.isFinite(raw) ? round4(raw) : converted[key];
      };
      price = { input: pick('input'), output: pick('output'), cacheWrite: pick('cacheWrite'), cacheRead: pick('cacheRead') };
      source = 'override';
    } else if (hasUsableCatalog) {
      price = converted;
      source = 'catalog';
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
        models,
      });
    }

    if (!onlyConfigured) {
      // 未配置的供应商也列出（灰显），方便用户先看价目再决定买哪个
      for (const catalog of DEFAULT_MODEL_CATALOG) {
        if (configs.some((config) => config.provider === catalog.provider)) continue;
        const models = await Promise.all(catalog.models.map((model) => this.priceFor(catalog.provider, model.model, configs)));
        providers.push({
          provider: catalog.provider,
          label: catalog.label,
          configured: false,
          hasApiKey: false,
          baseUrl: catalog.defaultBaseUrl,
          protocol: catalog.protocol,
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
    const description = exampleModel
      ? `人民币价 = 官方美元价 × 汇率 ${rate}。例如 ${exampleModel.model} 输入价：官方 $${exampleModel.officialUsd.input.toFixed(2)} × ${rate} = ￥${exampleModel.price.input.toFixed(2)} / 百万 token`
      : `人民币价 = 官方美元价 × 汇率 ${rate}（先在「AI 用量」里配置供应商）`;
    return { usdToCny: rate, description };
  }

  /** 给调用侧用的精确价格（provider + model 必填）。 */
  async costOf(
    provider: string,
    model: string,
    tokens: { input: number; output: number; cacheWrite?: number; cacheRead?: number },
  ): Promise<{ cost: string; price: ModelPriceCny; source: ModelPricingView['source']; breakdown: ReturnType<ModelPricingService['computeCost']> }> {
    const pricing = await this.priceFor(provider, model);
    const breakdown = this.computeCost(tokens, pricing.price);
    return { cost: breakdown.total.toFixed(6), price: pricing.price, source: pricing.source, breakdown };
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
}
