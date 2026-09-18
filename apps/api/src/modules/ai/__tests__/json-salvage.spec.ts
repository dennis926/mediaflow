import { describe, expect, it } from 'vitest';
import { salvageJson } from '../json-salvage';

const variants = { variants: [{ platform: 'wechat_mp', title: '标题', body: '正文', tags: ['a'] }] };

describe('salvageJson', () => {
  it('原样合法的 JSON 不做任何修复', () => {
    const result = salvageJson(JSON.stringify(variants));
    expect(result?.value).toEqual(variants);
    expect(result?.repairs).toEqual([]);
  });

  it('剥掉 ```json 代码块', () => {
    const result = salvageJson('```json\n{"variants":[]}\n```');
    expect(result?.value).toEqual({ variants: [] });
    expect(result?.repairs).toContain('strip-fence');
  });

  it('代码块没闭合也能剥出来', () => {
    const result = salvageJson('```json\n{"variants":[{"platform":"douyin","title":"t","body":"b","tags":[]}]');
    expect(result?.value).toEqual({ variants: [{ platform: 'douyin', title: 't', body: 'b', tags: [] }] });
  });

  it('前后夹带解释文字时取出中间对象', () => {
    const result = salvageJson('好的，以下是改写结果：\n{"variants":[]}\n希望满意！');
    expect(result?.value).toEqual({ variants: [] });
    expect(result?.repairs).toContain('extract-balanced');
  });

  it('清理尾随逗号', () => {
    const result = salvageJson('{"variants":[{"platform":"douyin",},],}');
    expect(result?.value).toEqual({ variants: [{ platform: 'douyin' }] });
    expect(result?.repairs).toContain('trailing-comma');
  });

  it('中文全角标点写进结构也能救回来', () => {
    const result = salvageJson('{“variants”：[{“platform”：“wechat_mp”，“title”：“标题”}]}');
    expect(result?.value).toEqual({ variants: [{ platform: 'wechat_mp', title: '标题' }] });
    expect(result?.repairs).toContain('wide-punctuation');
  });

  it('单引号当定界符也能救回来', () => {
    const result = salvageJson("{'variants': [{'platform': 'zhihu', 'title': '标题'}]}");
    expect(result?.value).toEqual({ variants: [{ platform: 'zhihu', title: '标题' }] });
    expect(result?.repairs).toContain('single-quotes');
  });

  it('被 max_tokens 截断时补全结构，保住已有字段', () => {
    const truncated = '{"variants":[{"platform":"wechat_mp","title":"标题","body":"正文","tags":["a"]},{"platform":"douyin","title":"抖音';
    const result = salvageJson(truncated);
    const value = result?.value as { variants: Array<{ platform: string }> };
    expect(Array.isArray(value.variants)).toBe(true);
    expect(value.variants[0].platform).toBe('wechat_mp');
    expect(result?.repairs).toContain('close-truncated');
  });

  it('字符串里带花括号不会被误判为结构结束', () => {
    const payload = { variants: [{ platform: 'wechat_mp', body: '示例 {不是结构} 与 "引号"' }] };
    const result = salvageJson(`说明：\n${JSON.stringify(payload)}`);
    expect(result?.value).toEqual(payload);
  });

  it('顶层数组按任务语义包一层', () => {
    expect(salvageJson('[{"platform":"douyin"}]')?.value).toEqual({ variants: [{ platform: 'douyin' }] });
    expect(salvageJson('["标题一","标题二"]')?.value).toEqual({ titles: ['标题一', '标题二'] });
  });

  it('完全不是 JSON 时返回 null（由调用方给出可读错误）', () => {
    expect(salvageJson('抱歉，我无法完成这个请求。')).toBeNull();
    expect(salvageJson('')).toBeNull();
  });

  it('注释会被去掉', () => {
    const result = salvageJson('{\n  // 平台版本\n  "variants": []\n}');
    expect(result?.value).toEqual({ variants: [] });
    expect(result?.repairs).toContain('comments');
  });
});
