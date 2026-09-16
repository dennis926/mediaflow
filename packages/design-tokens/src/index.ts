import tokensJson from './tokens.json';

export type DesignTokens = typeof tokensJson;
export type TokenGroup = keyof DesignTokens;

export const tokens: DesignTokens = tokensJson;

/** CSS variable prefix shared by every generated token. */
export const TOKEN_PREFIX = '--mf';

/** Maps a dot path (e.g. "color.brand.500") to its CSS variable name. */
export function cssVar(path: string): string {
  return `${TOKEN_PREFIX}-${path.split('.').join('-')}`;
}

/** Maps a dot path to a var() reference usable inside CSS strings. */
export function tokenVar(path: string): string {
  return `var(${cssVar(path)})`;
}

export const breakpoints = tokens.breakpoint;
export default tokens;
