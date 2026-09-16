import { Provider } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { AiProvider } from './ai.types';
import { DeepSeekProvider } from './providers/deepseek.provider';
import { MockAiProvider } from './providers/mock.provider';

export const AI_PROVIDER = 'MEDIAFLOW_AI_PROVIDER';

/** AI_PROVIDER=mock keeps the pipeline runnable offline; anything else talks to DeepSeek. */
export function buildAiProvider(config: ConfigService): AiProvider {
  const name = (config.get<string>('AI_PROVIDER') ?? 'deepseek').trim().toLowerCase();
  const model = config.get<string>('AI_MODEL') ?? 'deepseek-chat';

  if (name === 'mock') return new MockAiProvider(model);

  return new DeepSeekProvider({
    apiKey: config.get<string>('AI_API_KEY') ?? '',
    model,
    baseUrl: config.get<string>('AI_API_BASE') || undefined,
  });
}

export const aiProviderProvider: Provider = {
  provide: AI_PROVIDER,
  inject: [ConfigService],
  useFactory: buildAiProvider,
};
