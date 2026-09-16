export interface FillPayload {
  title: string;
  body: string;
  tags: string[];
  mediaUrls: string[];
}

/**
 * Content scripts extend this class. They only fill the editor: publishing stays a human action.
 */
export abstract class BasePlatformAdapter {
  abstract readonly platform: string;
  abstract readonly matches: string[];

  canHandle(url: string): boolean {
    return this.matches.some((pattern) => url.includes(pattern));
  }

  abstract fill(payload: FillPayload): Promise<void>;
}
