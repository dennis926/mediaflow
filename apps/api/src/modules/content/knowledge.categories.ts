import { BadRequestException } from '@nestjs/common';
import { registerDecorator, ValidationOptions } from 'class-validator';

/** 知识库分类定义。整套分类都可以在界面上增删改，方便换一家公司直接改内容上线。 */
export interface KnowledgeCategoryDef {
  /** 存库用的稳定标识：小写字母开头，可含数字与下划线，建好后不要改。 */
  code: string;
  label: string;
  /** 界面配色语义：brand / success / info / warning / danger / default */
  tone: KnowledgeTone;
  description?: string;
}

export type KnowledgeTone = 'brand' | 'success' | 'info' | 'warning' | 'danger' | 'default';

export const KNOWLEDGE_TONES: KnowledgeTone[] = ['brand', 'success', 'info', 'warning', 'danger', 'default'];

export const MAX_KNOWLEDGE_CATEGORIES = 30;
const CODE_PATTERN = /^[a-z][a-z0-9_]{0,29}$/;

/** 开箱即用的默认分类（食品营养健康行业），换行业时在界面上改即可。 */
export const DEFAULT_KNOWLEDGE_CATEGORIES: KnowledgeCategoryDef[] = [
  { code: 'brand', label: '品牌定位', tone: 'brand', description: '品牌是谁、面向谁、什么调性、红线在哪' },
  { code: 'product', label: '产品卖点', tone: 'success', description: '配方、规格、工艺、认证等可验证事实' },
  { code: 'ingredient', label: '成分说明', tone: 'info', description: '单一成分的作用、来源与适用人群' },
  { code: 'compliance', label: '合规红线', tone: 'danger', description: '不能写的表述与替换说法' },
  { code: 'faq', label: '常见问答', tone: 'warning', description: '用户常问的问题与标准回答口径' },
  { code: 'tone', label: '话术基调', tone: 'default', description: '语气、称谓与结构偏好' },
];

export const CATEGORY_SETTING_KEY = 'KB_CATEGORIES';

/**
 * 校验用的分类码表：DTO 校验是同步的，所以这里放一份由数据库加载后的快照，
 * 由 KnowledgeService 在启动时与保存分类后刷新（见 refreshCategoryCodes）。
 */
let codeRegistry: string[] = DEFAULT_KNOWLEDGE_CATEGORIES.map((item) => item.code);

export function getCategoryCodes(): string[] {
  return codeRegistry;
}

export function setCategoryCodes(codes: string[]): void {
  codeRegistry = codes.length > 0 ? [...codes] : DEFAULT_KNOWLEDGE_CATEGORIES.map((item) => item.code);
}

/** 校验并规范化一份分类配置；不合规直接抛 400，避免把脏配置写进数据库。 */
export function normalizeCategories(input: unknown): KnowledgeCategoryDef[] {
  if (!Array.isArray(input) || input.length === 0) {
    throw new BadRequestException('分类至少保留一个');
  }
  if (input.length > MAX_KNOWLEDGE_CATEGORIES) {
    throw new BadRequestException(`分类最多 ${MAX_KNOWLEDGE_CATEGORIES} 个`);
  }

  const seen = new Set<string>();
  const result: KnowledgeCategoryDef[] = [];
  for (const raw of input) {
    if (typeof raw !== 'object' || raw === null) throw new BadRequestException('分类格式不正确');
    const record = raw as Record<string, unknown>;
    const code = String(record.code ?? '').trim();
    const label = String(record.label ?? '').trim();
    const tone = String(record.tone ?? 'default').trim() as KnowledgeTone;
    const description = record.description === undefined ? undefined : String(record.description).trim();

    if (!CODE_PATTERN.test(code)) {
      throw new BadRequestException(`分类标识「${code || '(空)'}」不合法：请用小写字母开头，可含数字与下划线`);
    }
    if (seen.has(code)) throw new BadRequestException(`分类标识「${code}」重复`);
    if (label.length === 0 || label.length > 20) throw new BadRequestException(`分类「${code}」的名称需 1-20 个字`);
    if (!KNOWLEDGE_TONES.includes(tone)) throw new BadRequestException(`分类「${code}」的配色取值不合法`);

    seen.add(code);
    result.push({ code, label, tone, ...(description ? { description } : {}) });
  }
  return result;
}

/** 从数据库读到的 JSON 解析；坏数据时退回默认分类而不是让整个模块打不开。 */
export function parseStoredCategories(raw: string | null): KnowledgeCategoryDef[] {
  if (!raw) return DEFAULT_KNOWLEDGE_CATEGORIES;
  try {
    return normalizeCategories(JSON.parse(raw) as unknown);
  } catch {
    return DEFAULT_KNOWLEDGE_CATEGORIES;
  }
}

/** class-validator 装饰器：用运行时分类码表校验（支持自定义分类）。 */
export function IsKnowledgeCategory(validationOptions?: ValidationOptions) {
  return function (object: object, propertyName: string): void {
    registerDecorator({
      name: 'isKnowledgeCategory',
      target: object.constructor,
      propertyName,
      options: validationOptions,
      validator: {
        validate(value: unknown): boolean {
          return typeof value === 'string' && getCategoryCodes().includes(value);
        },
        defaultMessage(): string {
          return `分类不存在，可选：${getCategoryCodes().join('、')}`;
        },
      },
    });
  };
}
