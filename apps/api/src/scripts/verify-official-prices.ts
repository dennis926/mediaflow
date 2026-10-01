/**
 * Ops probe: run the real scrape → store → pricing chain inside the Nest
 * application context, so the encrypted settings write and the price resolution
 * path are exercised exactly as they are in production.
 *
 * Not a test (it talks to the network); run manually after a deploy:
 *   node dist/src/scripts/verify-official-prices.js
 *
 * console output is the whole point of a CLI probe, hence the lint exemption.
 */
/* eslint-disable no-console */
import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { AppModule } from '../app.module';
import { ModelPricingService } from '../modules/ai/model-pricing.service';
import { OfficialPriceStore } from '../modules/ai/pricing/official-price.store';

async function main(): Promise<void> {
  const app = await NestFactory.createApplicationContext(AppModule, { logger: ['error', 'warn'] });
  const pricing = app.get(ModelPricingService);
  const store = app.get(OfficialPriceStore);

  console.log('== 抓取全部支持的供应商 ==');
  const { succeeded, failed } = await pricing.refreshAllOfficialPrices();
  for (const result of succeeded) {
    console.log(`  ✓ ${result.provider}: ${result.prices.length} 个模型`);
    for (const price of result.prices.slice(0, 3)) {
      console.log(
        `      ${price.model} [${price.currency}] 输入 ${price.peak.input} / 输出 ${price.peak.output} / 缓存读 ${price.peak.cacheRead}`,
      );
    }
  }
  for (const failure of failed) {
    console.log(`  ✗ ${failure.provider}: ${failure.message}`);
  }

  console.log('\n== 快照已落库（含加密设置写入）==');
  const snapshot = await store.read();
  for (const [provider, detail] of Object.entries(snapshot?.detail ?? {})) {
    const count = Object.keys(detail.models).length;
    console.log(`  ${provider}: ${count} 个模型，抓取于 ${detail.fetchedAt}${detail.error ? `，错误：${detail.error}` : ''}`);
  }

  console.log('\n== 计费解析（走 官网价 > 目录价 优先级）==');
  for (const [provider, model] of [
    ['deepseek', 'deepseek-flash'],
    ['zhipu', 'GLM-5.3'],
    ['kimi', 'kimi-k3'],
    ['anthropic', 'claude-opus-5-5'],
    ['google', 'gemini-3.8-flash'],
    ['xai', 'grok-4.7'],
    ['doubao', 'doubao-seed-evolving'],
  ] as Array<[string, string]>) {
    const view = await pricing.priceFor(provider, model);
    const peak = view.officialCny?.peak;
    const offpeak = view.officialCny?.offpeak;
    console.log(
      `  ${provider}/${model}: 实付 输入${view.price.input}/输出${view.price.output}（${view.tier}）` +
        (peak && offpeak
          ? ` | 官方 峰 ${peak.input}/${peak.output} 谷 ${offpeak.input}/${offpeak.output}`
          : ' | 官方价按目录美元价折算') +
        ` | 来源=${view.source}`,
    );
  }

  await app.close();
}

void main().catch((error) => {
  console.error(error);
  process.exit(1);
});
