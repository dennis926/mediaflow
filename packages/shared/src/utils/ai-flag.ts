import { AI_DISCLOSURE_TEXT, AI_METADATA_KEY, AI_METADATA_PROVIDER } from '../constants';
import { AiFlagType } from '../types/content';

/**
 * 《人工智能生成合成内容标识办法》要求：AI 生成的内容必须带显式标识。
 * 「AI 翻译/改写」（translated）同样是 AI 生成的合成内容（审计 P1-3：此前漏标），
 * 因此与「完全生成」「辅助生成」一起纳入标识范围。
 */
export function requiresAiDisclosure(aiFlagType: AiFlagType): boolean {
  return (
    aiFlagType === AiFlagType.FullyGenerated ||
    aiFlagType === AiFlagType.Assisted ||
    aiFlagType === AiFlagType.Translated
  );
}

/** Appends the mandatory visible AI mark exactly once. */
export function appendAiDisclosure(body: string, aiFlagType: AiFlagType, disclosureText = AI_DISCLOSURE_TEXT): string {
  if (!requiresAiDisclosure(aiFlagType)) return body;
  if (body.includes(disclosureText)) return body;
  return `${body.trimEnd()}\n\n${disclosureText}`;
}

/** Builds the invisible mark embedded into image/video metadata. */
export function buildAiMetadata(aiFlagType: AiFlagType, model: string): Record<string, string> {
  return {
    [AI_METADATA_KEY]: String(requiresAiDisclosure(aiFlagType)),
    provider: AI_METADATA_PROVIDER,
    flagType: aiFlagType,
    model,
  };
}
