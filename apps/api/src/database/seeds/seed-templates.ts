import 'reflect-metadata';
import { Logger } from '@nestjs/common';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import AppDataSource from '../data-source';
import { ContentTemplate } from '../../modules/content/entities/content-template.entity';
import { resolveDefaultScope } from './defaults';

const logger = new Logger('SeedTemplates');

interface SampleTemplate {
  name: string;
  description?: string;
  category?: string;
  platform?: string | null;
  title: string;
  body: string;
  tags?: string[];
}

/**
 * 示例文案模板：与示例品牌资料一样走**数据文件**（sample-templates.json），
 * 交付给别人时可以直接换掉内容，或用 SEED_SAMPLE_CONTENT=false 跳过。
 */
export async function seedTemplates(dataSource = AppDataSource): Promise<number> {
  if ((process.env.SEED_SAMPLE_CONTENT ?? 'true').toLowerCase() === 'false') {
    logger.log('SEED_SAMPLE_CONTENT=false，已跳过示例模板写入');
    return 0;
  }

  const file = process.env.SEED_TEMPLATE_FILE?.trim() || join(__dirname, 'sample-templates.json');
  let entries: SampleTemplate[] = [];
  try {
    const parsed = JSON.parse(readFileSync(file, 'utf8')) as { templates?: SampleTemplate[] } | SampleTemplate[];
    entries = Array.isArray(parsed) ? parsed : (parsed.templates ?? []);
  } catch (error) {
    logger.warn(`示例模板读取失败，跳过：${error instanceof Error ? error.message : String(error)}`);
    return 0;
  }

  if (!(await dataSource.isInitialized)) await dataSource.initialize();
  const repository = dataSource.getRepository(ContentTemplate);
  // 默认作用域按 slug 解析，兼容历史安装。
  const scope = await resolveDefaultScope(dataSource);
  let created = 0;
  for (const entry of entries) {
    if (!entry?.name || !entry?.title || !entry?.body) continue;
    const existing = await repository.findOne({ where: { workspaceId: scope.workspaceId, name: entry.name } });
    if (existing) continue;
    await repository.insert({
      tenantId: scope.tenantId,
      workspaceId: scope.workspaceId,
      name: entry.name,
      description: entry.description ?? null,
      category: entry.category ?? null,
      platform: entry.platform ?? null,
      title: entry.title,
      body: entry.body,
      tags: entry.tags ?? [],
      isActive: true,
      usageCount: 0,
      lastUsedAt: null,
      createdBy: null,
      createdByName: '系统预置',
      deletedAt: null,
    });
    created += 1;
  }
  logger.log(`示例文案模板写入完成：新增 ${created} 条，跳过 ${entries.length - created} 条已存在`);
  return created;
}

async function main(): Promise<void> {
  await AppDataSource.initialize();
  try {
    await seedTemplates(AppDataSource);
  } finally {
    await AppDataSource.destroy();
  }
}

if (require.main === module) {
  void main().catch((error: unknown) => {
    process.stderr.write(`模板写入失败：${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
