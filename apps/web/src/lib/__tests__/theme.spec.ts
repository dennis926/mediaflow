import { describe, expect, it } from 'vitest';
import { buildBrandScale, contrastWithWhite, hexToHsl, hslToHex } from '../theme';

describe('品牌主题色推导', () => {
  it('十六进制与 HSL 互转稳定', () => {
    const hsl = hexToHsl('#4F6BFF');
    expect(Math.round(hsl.h)).toBeGreaterThan(220);
    expect(Math.round(hsl.h)).toBeLessThan(240);
    expect(hslToHex(hsl).toUpperCase()).toBe('#4F6BFF');
  });

  it('色阶由浅到深单调变暗', () => {
    const scale = buildBrandScale('#4F6BFF');
    const steps = [50, 100, 200, 300, 400, 500, 600, 700, 800, 900] as const;
    const lightness = steps.map((step) => hexToHsl(scale[step]).l);
    for (let index = 1; index < lightness.length; index += 1) {
      // 允许 8bit 量化带来的 1 像素级误差
      expect(lightness[index]).toBeLessThanOrEqual(lightness[index - 1] + 1);
    }
    expect(lightness[0] - lightness[lightness.length - 1]).toBeGreaterThan(40);
  });

  it('主色过亮时压暗到白字可读，正常主色原样保留', () => {
    const pale = buildBrandScale('#FFF3A0');
    expect(contrastWithWhite(pale[500])).toBeGreaterThanOrEqual(3);

    // 默认主色本来就够对比度，绝不能被改掉（否则等于偷偷换了设计）
    const normal = buildBrandScale('#4F6BFF');
    expect(normal[500].toUpperCase()).toBe('#4F6BFF');
    expect(contrastWithWhite('#4F6BFF')).toBeGreaterThanOrEqual(3);
  });

  it('对比度达标的主色原样保留，不做四舍五入漂移', () => {
    for (const color of ['#4F6BFF', '#E4572E', '#1B4B8F']) {
      expect(contrastWithWhite(color)).toBeGreaterThanOrEqual(3);
      expect(buildBrandScale(color)[500]).toBe(color);
    }
  });

  it('临界主色（绿色系）会被压到 3:1 以上，宁可微调也不让白字看不清', () => {
    const green = buildBrandScale('#1FA97A')[500];
    expect(contrastWithWhite(green)).toBeGreaterThanOrEqual(3);
  });

  it('每个色阶都能被浏览器解析（不产生非法颜色）', () => {
    const scale = buildBrandScale('#1FA97A');
    for (const value of Object.values(scale)) {
      expect(value).toMatch(/^#[0-9A-F]{6}$/);
    }
  });

  it('非法输入回退默认色而不是抛异常', () => {
    const scale = buildBrandScale('不是颜色');
    expect(scale[500]).toMatch(/^#[0-9A-F]{6}$/);
  });
});
