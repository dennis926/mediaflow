import { Logger } from '@nestjs/common';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { DataSource } from 'typeorm';
import { BrandKnowledge } from '../../modules/content/entities/brand-knowledge.entity';
import { resolveDefaultScope } from './defaults';

const logger = new Logger('SeedKnowledge');

interface SampleEntry {
  brand: string;
  category: string;
  title: string;
  content: string;
  tags?: string[];
  keywords?: string[];
  priority?: number;
}

/**
 * 示例品牌资料改为**数据文件**驱动，而不是写死在代码里：
 * - 默认读取同目录的 sample-knowledge.json（可整体替换成贵公司的资料）；
 * - 置空/关闭：环境变量 SEED_SAMPLE_CONTENT=false 时直接跳过（新环境不放示例数据）；
 * - 自定义文件：环境变量 SEED_KNOWLEDGE_FILE=/path/to/your.json。
 */
function loadSampleEntries(): SampleEntry[] {
  const custom = process.env.SEED_KNOWLEDGE_FILE?.trim();
  const file = custom && existsSync(custom) ? custom : join(__dirname, 'sample-knowledge.json');
  if (!existsSync(file)) {
    logger.warn(`示例资料文件不存在，跳过：${file}`);
    return [];
  }
  try {
    const parsed = JSON.parse(readFileSync(file, 'utf8')) as { entries?: SampleEntry[] } | SampleEntry[];
    const entries = Array.isArray(parsed) ? parsed : (parsed.entries ?? []);
    return entries.filter((entry) => Boolean(entry?.title && entry?.content && entry?.brand && entry?.category));
  } catch (error) {
    logger.warn(`示例资料文件解析失败，跳过：${error instanceof Error ? error.message : String(error)}`);
    return [];
  }
}

export async function seedKnowledge(dataSource: DataSource): Promise<number> {
  if ((process.env.SEED_SAMPLE_CONTENT ?? 'true').toLowerCase() === 'false') {
    logger.log('SEED_SAMPLE_CONTENT=false，已跳过示例品牌资料写入');
    return 0;
  }

  const entries = loadSampleEntries();
  if (entries.length === 0) return 0;

  const repository = dataSource.getRepository(BrandKnowledge);
  // 默认作用域按 slug 解析，兼容历史安装（工作区 ID 可能是更早的固定值）。
  const scope = await resolveDefaultScope(dataSource);
  let created = 0;

  for (const entry of entries) {
    const existing = await repository.findOne({ where: { workspaceId: scope.workspaceId, title: entry.title } });
    if (existing) continue;
    await repository.insert({
      tenantId: scope.tenantId,
      workspaceId: scope.workspaceId,
      brand: entry.brand,
      category: entry.category,
      title: entry.title,
      content: entry.content,
      tags: entry.tags ?? [],
      keywords: entry.keywords ?? [],
      priority: entry.priority ?? 0,
      platforms: [],
      sourceUrl: null,
      isActive: true,
      usageCount: 0,
      lastUsedAt: null,
      aiGenerated: false,
    });
    created += 1;
  }

  logger.log(`品牌资料种子完成：新增 ${created} 条，跳过 ${entries.length - created} 条已存在`);
  return created;
}
