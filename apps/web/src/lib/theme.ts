/**
 * 品牌主题：把后台配置的主色推导成一整套色阶，覆盖 Design Token 的 CSS 变量。
 *
 * 设计要点：
 * - 只让运营填一个十六进制主色，深浅色阶自动推导，避免让他们去算 10 个颜色；
 * - 推导保持主色的色相与饱和度倾向：亮色降低饱和度靠白，暗色略提饱和度保持鲜明；
 * - 对比度兜底：如果主色过亮（浅黄、浅青），按钮上的白字会看不清，此时自动把 500 号色压暗。
 */

export interface BrandScale {
  50: string;
  100: string;
  200: string;
  300: string;
  400: string;
  500: string;
  600: string;
  700: string;
  800: string;
  900: string;
}

interface Hsl {
  h: number;
  s: number;
  l: number;
}

export function hexToHsl(hex: string): Hsl {
  const normalized = hex.replace('#', '');
  const full = normalized.length === 3 ? normalized.split('').map((char) => char + char).join('') : normalized;
  const r = parseInt(full.slice(0, 2), 16) / 255;
  const g = parseInt(full.slice(2, 4), 16) / 255;
  const b = parseInt(full.slice(4, 6), 16) / 255;

  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const delta = max - min;
  const l = (max + min) / 2;
  let h = 0;
  let s = 0;

  if (delta !== 0) {
    s = delta / (1 - Math.abs(2 * l - 1));
    if (max === r) h = ((g - b) / delta) % 6;
    else if (max === g) h = (b - r) / delta + 2;
    else h = (r - g) / delta + 4;
  }
  return { h: (h * 60 + 360) % 360, s: s * 100, l: l * 100 };
}

export function hslToHex({ h, s, l }: Hsl): string {
  const saturation = Math.min(100, Math.max(0, s)) / 100;
  const lightness = Math.min(100, Math.max(0, l)) / 100;
  const c = (1 - Math.abs(2 * lightness - 1)) * saturation;
  const x = c * (1 - Math.abs(((h / 60) % 2) - 1));
  const m = lightness - c / 2;

  const [r, g, b] =
    h < 60 ? [c, x, 0] : h < 120 ? [x, c, 0] : h < 180 ? [0, c, x] : h < 240 ? [0, x, c] : h < 300 ? [x, 0, c] : [c, 0, x];

  const toHex = (value: number): string =>
    Math.round((value + m) * 255)
      .toString(16)
      .padStart(2, '0')
      .toUpperCase();
  return `#${toHex(r)}${toHex(g)}${toHex(b)}`;
}

/** 相对亮度（WCAG 2.1），用于判断白色文字是否看得清。 */
function relativeLuminance(hex: string): number {
  const normalized = hex.replace('#', '');
  const full = normalized.length === 3 ? normalized.split('').map((char) => char + char).join('') : normalized;
  const channels = [0, 2, 4].map((offset) => parseInt(full.slice(offset, offset + 2), 16) / 255);
  const [r, g, b] = channels.map((value) => (value <= 0.03928 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4));
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

/** 与白色的对比度。按钮/标签都是白字，低于 3:1 就该压暗主色。 */
export function contrastWithWhite(hex: string): number {
  return 1.05 / (relativeLuminance(hex) + 0.05);
}

const MIN_CONTRAST = 3;

/** 二分搜索出"白字仍然可读"的最亮值：能保住原色就保住，保住不了才压暗。 */
function readableLightness(base: Hsl): number {
  if (contrastWithWhite(hslToHex({ ...base, l: base.l })) >= MIN_CONTRAST) return base.l;
  let low = 8;
  let high = base.l;
  for (let attempt = 0; attempt < 24; attempt += 1) {
    const middle = (low + high) / 2;
    if (contrastWithWhite(hslToHex({ ...base, l: middle })) >= MIN_CONTRAST) low = middle;
    else high = middle;
  }
  return low;
}

/**
 * 由主色推导 10 级色阶。
 * - 500 是主色本身（只有白字看不清时才压暗，绝不无端改色）；
 * - 50-400 由主色向白靠，600-900 向黑靠，亮度阶梯写死以保证严格单调；
 * - 浅色端降低饱和度、深色端略提饱和度，视觉上更接近真实设计稿。
 */
export function buildBrandScale(hex: string): BrandScale {
  const input = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.test(hex) ? hex.toUpperCase() : '#4F6BFF';
  const base = hexToHsl(input);
  const anchorLightness = readableLightness(base);
  const anchor = { ...base, l: anchorLightness };

  const ladder: Array<[keyof BrandScale, number, number]> = [
    [50, Math.min(96, anchorLightness + 44), 0.3],
    [100, Math.min(92, anchorLightness + 36), 0.4],
    [200, Math.min(86, anchorLightness + 27), 0.55],
    [300, Math.min(78, anchorLightness + 18), 0.7],
    [400, Math.min(70, anchorLightness + 9), 0.85],
    [500, anchorLightness, 1],
    [600, Math.max(26, anchorLightness - 8), 1.05],
    [700, Math.max(20, anchorLightness - 16), 1.1],
    [800, Math.max(14, anchorLightness - 24), 1.1],
    [900, Math.max(10, anchorLightness - 32), 1.1],
  ];

  const scale = {} as BrandScale;
  for (const [step, lightness, saturationScale] of ladder) {
    // 500 号保持运营填的原始值，避免 HSL 往返出现 ±1 的色差
    scale[step] = step === 500 && anchorLightness === base.l ? input : hslToHex({ h: anchor.h, s: anchor.s * saturationScale, l: lightness });
  }
  return scale;
}

/** 把色阶写进 :root，覆盖 Design Token 的 --mf-color-brand-*。 */
export function applyBrandColor(hex: string): void {
  if (typeof document === 'undefined') return;
  const scale = buildBrandScale(hex);
  const root = document.documentElement;
  for (const [step, value] of Object.entries(scale)) {
    root.style.setProperty(`--mf-color-brand-${step}`, value);
  }
  const meta = document.querySelector('meta[name="theme-color"]');
  if (meta) meta.setAttribute('content', scale[500]);
}
