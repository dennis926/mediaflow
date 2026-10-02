/**
 * Ops probe: 用真实 models.dev 数据验证聚合价目表这条链路。
 *
 * 走真实网络（不 mock），因此不进测试套件；部署后手工执行：
 *   node dist/scripts/verify-models-dev.js
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

  console.log('== 抓取聚合价目表（models.dev）==');
  const result = await pricing.refreshAggregatePrices();
  console.log(`  ✓ ${result.providers} 家供应商、${result.models} 个模型`);

  const snapshot = await store.read();
  const aggregate = snapshot?.aggregate;
  console.log(`  抓取时间：${aggregate?.fetchedAt}`);
  console.log(`  来源：${aggregate?.sourceUrl}`);
  for (const [provider, models] of Object.entries(aggregate?.providers ?? {})) {
    console.log(`  ${provider}: ${Object.keys(models).length} 个模型`);
  }

  console.log('\n== 计费解析（官网价优先，聚合价兜底）==');
  for (const [provider, model] of [
    ['deepseek', 'deepseek-flash'],
    ['openai', 'gpt-5-mini'],
    ['openai', 'gpt-5.5'],
    ['minimax', 'minimax-m3'],
    ['doubao', 'doubao-seed-2.1-pro'],
    ['anthropic', 'claude-opus-5-5'],
  ] as Array<[string, string]>) {
    const view = await pricing.priceFor(provider, model);
    console.log(
      `  ${provider}/${model}: 输入 ￥${view.price.input} 输出 ￥${view.price.output} | 来源=${view.source} | 档位=${view.tier}`,
    );
  }

  await app.close();
}

void main().catch((error) => {
  console.error(error);
  process.exit(1);
});
