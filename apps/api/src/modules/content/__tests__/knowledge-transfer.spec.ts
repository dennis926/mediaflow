import { describe, expect, it } from 'vitest';
import { autoMapColumns } from '../knowledge.transfer.service';

describe('导入字段自动映射', () => {
  it('英文表头按名字映射（不能串位）', () => {
    expect(autoMapColumns(['title', 'content', 'category', 'brand', 'tags'])).toEqual({
      title: 'title', content: 'content', brand: 'brand', category: 'category', tags: 'tags',
    });
  });

  it('中文表头按名字映射', () => {
    expect(autoMapColumns(['标题', '正文', '品牌', '分类', '标签'])).toEqual({
      title: '标题', content: '正文', brand: '品牌', category: '分类', tags: '标签',
    });
  });

  it('列顺序颠倒也不受影响', () => {
    expect(autoMapColumns(['brand', 'category', 'content', 'title'])).toEqual({
      title: 'title', content: 'content', brand: 'brand', category: 'category',
    });
  });

  it('混合中英文表头与常见别名', () => {
    const mapping = autoMapColumns(['问题', 'answer', '所属品牌', '类型', 'keywords', '优先级', '是否启用']);
    expect(mapping).toEqual({
      title: '问题', content: 'answer', brand: '所属品牌', category: '类型',
      keywords: 'keywords', priority: '优先级', isActive: '是否启用',
    });
  });

  it('一列不会被两个字段重复占用', () => {
    const mapping = autoMapColumns(['标题', '内容', '品牌']);
    const columns = Object.values(mapping);
    expect(new Set(columns).size).toBe(columns.length);
  });

  it('无法识别的列不产生映射', () => {
    expect(autoMapColumns(['备注', 'xx'])).toEqual({});
  });
});
