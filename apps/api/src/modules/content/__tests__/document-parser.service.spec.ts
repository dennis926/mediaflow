import { BadRequestException } from '@nestjs/common';
import { describe, expect, it } from 'vitest';
import { DocumentParserService } from '../document-parser.service';

const parser = new DocumentParserService();

describe('DocumentParserService', () => {
  it('拒绝不支持的类型与超大文件', () => {
    expect(() => parser.assertSupported('a.exe', 100)).toThrow(BadRequestException);
    expect(() => parser.assertSupported('a.pdf', 20 * 1024 * 1024)).toThrow(BadRequestException);
    expect(() => parser.assertSupported('a.txt', 0)).toThrow(BadRequestException);
  });

  it('解析 txt 并归一化空白', async () => {
    const first = '卿尔美专注膳食纤维与益生元的日常营养补充。';
    const second = '品牌面向关注肠道健康、日常纤维摄入不足的人群。';
    const result = await parser.parse('公司简介.txt', Buffer.from(`${first}\r\n\r\n\r\n${second}`));
    expect(result.fileType).toBe('.txt');
    expect(result.text).toBe(`${first}\n\n${second}`);
  });

  it('解析 CSV 保留工作表结构', async () => {
    const csv = '产品,规格,卖点\n畅享版,8g*12袋,复配益生元\n增强版,3.8g*10袋,DHA';
    const result = await parser.parse('产品表.csv', Buffer.from(csv, 'utf8'));
    expect(result.text).toContain('畅享版');
    expect(result.text).toContain('复配益生元');
  });

  it('文本过少时明确报错（扫描件提示）', async () => {
    await expect(parser.parse('扫描件.txt', Buffer.from('短'))).rejects.toThrow(BadRequestException);
  });

  it('切片：按段落合并、长段落定长切分并带重叠', () => {
    const long = '甲'.repeat(3000);
    const chunks = parser.chunk(`第一段\n\n${long}`);

    expect(chunks.length).toBeGreaterThan(1);
    expect(chunks.every((chunk) => chunk.charCount <= 1200)).toBe(true);
    expect(chunks[0].index).toBe(1);
    // 重叠：后一片开头与前一片结尾有交集
    const overlapped = chunks.slice(1).some((chunk, position) => {
      const previous = chunks[position];
      const tail = previous.content.slice(-100);
      return chunk.content.startsWith(tail.slice(0, 50));
    });
    expect(overlapped).toBe(true);
  });

  it('切片会生成可读标题', () => {
    const chunks = parser.chunk('## 卿尔美品牌定位\n\n专注膳食纤维与益生元的日常营养补充，服务关注肠道健康的人群。');
    expect(chunks[0].title).toContain('卿尔美品牌定位');
  });
});
