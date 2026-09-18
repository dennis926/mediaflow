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
  /** 实付相对官方的折扣（0.11 = 约官方的 11%） */
  ratioOfOfficial: number;
  /** 价格来源：override=自定义覆盖，catalog=预置参考价，global=全局兜底价 */
  source: 'override' | 'catalog' | 'global';
  /** 该模型是否已被配置为可用 */
  configured: boolean;
  reference: boolean;
  note?: string;
  /** 供应商分组倍率（实付 = 官方 × 汇率 × 倍率） */
  multiplier: number;
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
  multiplier: number;
  /** 该供应商下模型：自定义的模型优先，预置模型补充 */
  models: ModelPricingView[];
}

export interface PricingRuleView {
  usdToCny: number;
  /** 示例：官方 $5.00 的模型在当前倍率下的实付价 */
  description: string;
}

/**
 * 模型价格解析。
 *
 * 三层优先级：用户覆盖价（人民币，AI_MODEL_PRICES）> 预置目录（美元 × 汇率 × 供应商倍率）> 全局兜底价。
 * 这样既开箱可用，又能让用户按自己买的中转分组价精确对上账单。
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
    const multiplier = config?.multiplier && config.multiplier > 0 ? config.multiplier : 1;
    const catalogModel = findCatalogModel(provider, model);
    const officialUsd = catalogModel?.officialUsd ?? { input: 0, output: 0, cacheWrite: 0, cacheRead: 0 };
    const converted: ModelPriceCny = {
      input: officialUsd.input * rate * multiplier,
      output: officialUsd.output * rate * multiplier,
      cacheWrite: officialUsd.cacheWrite * rate * multiplier,
      cacheRead: officialUsd.cacheRead * rate * multiplier,
    };

    const override = overrides[`${provider}/${model}`];
    const hasOverride = Boolean(override && ['input', 'output', 'cacheWrite', 'cacheRead'].some((key) => Number(override[key as keyof ModelPriceCny]) > 0));
    const hasUsableCatalog = officialUsd.input > 0 || officialUsd.output > 0;

    let price: ModelPriceCny;
    let source: ModelPricingView['source'];
    if (hasOverride && override) {
      price = {
        input: Number(override.input ?? converted.input) || 0,
        output: Number(override.output ?? converted.output) || 0,
        cacheWrite: Number(override.cacheWrite ?? converted.cacheWrite) || 0,
        cacheRead: Number(override.cacheRead ?? converted.cacheRead) || 0,
      };
      source = 'override';
    } else if (hasUsableCatalog) {
      price = converted;
      source = 'catalog';
    } else {
      price = fallback;
      source = 'global';
    }

    const officialCny = officialUsd.input * rate;
    const ratioOfOfficial = officialCny > 0 ? Number((price.input / (officialCny * multiplier)).toFixed(3)) : 1;

    return {
      provider,
      providerLabel: config?.label ?? providerLabel(provider),
      model,
      label: catalogModel?.label ?? model,
      price,
      officialUsd,
      ratioOfOfficial,
      source,
      configured: Boolean(config),
      reference: catalogModel?.reference ?? false,
      note: catalogModel?.note,
      multiplier,
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
        multiplier: config.multiplier,
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
          multiplier: 1,
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
      ? `实付价 = 官方美元价 × 汇率 ${rate} × 分组倍率。例如 ${exampleModel.model} 输入价：官方 $${exampleModel.officialUsd.input.toFixed(2)} × ${rate} × ${exampleModel.multiplier} = ￥${exampleModel.price.input.toFixed(2)} / 百万 token`
      : `实付价 = 官方美元价 × 汇率 ${rate} × 分组倍率（先在「AI 服务」里配置供应商）`;
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
