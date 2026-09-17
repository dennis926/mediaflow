import { api } from './api/client';
import { getToken } from './api/client';

const SESSION_KEY = 'mediaflow.session';

/** 会话内稳定的埋点标识（不涉及任何个人信息）。 */
function sessionId(): string {
  if (typeof window === 'undefined') return 'server';
  const existing = window.sessionStorage.getItem(SESSION_KEY);
  if (existing) return existing;
  const created = `s-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
  window.sessionStorage.setItem(SESSION_KEY, created);
  return created;
}

export interface TrackPayload {
  platform?: string;
  contentId?: string;
  properties?: Record<string, unknown>;
}

/**
 * 前端行为埋点。失败不打扰用户（静默忽略），未登录则不发。
 * 事件会进 track_events 表，数据中心据此分析使用情况。
 */
export async function trackEvent(eventName: string, payload: TrackPayload = {}): Promise<void> {
  if (!getToken()) return;
  try {
    await api.post<{ id: string }>('/analytics/track', {
      eventName,
      sessionId: sessionId(),
      platform: payload.platform,
      contentId: payload.contentId,
      properties: payload.properties ?? {},
    });
  } catch {
    // 埋点失败不影响业务
  }
}
