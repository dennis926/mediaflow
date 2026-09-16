import { AI_DISCLOSURE_TEXT, AI_METADATA_KEY, AI_METADATA_PROVIDER } from '../constants';
import { AiFlagType } from '../types/content';

export function requiresAiDisclosure(aiFlagType: AiFlagType): boolean {
  return aiFlagType === AiFlagType.FullyGenerated || aiFlagType === AiFlagType.Assisted;
}

/** Appends the mandatory visible AI mark exactly once. */
export function appendAiDisclosure(body: string, aiFlagType: AiFlagType): string {
  if (!requiresAiDisclosure(aiFlagType)) return body;
  if (body.includes(AI_DISCLOSURE_TEXT)) return body;
  return `${body.trimEnd()}\n\n${AI_DISCLOSURE_TEXT}`;
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
