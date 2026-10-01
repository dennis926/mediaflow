/**
 * Peak / off-peak billing windows.
 *
 * Some providers charge double during "peak" hours and half during "off-peak".
 * DeepSeek's rule (as published on its pricing page):
 *   peak = Beijing time, Mon-Fri (excluding Chinese public holidays) 09:00-12:00 and 14:00-18:00
 *   everything else (including weekends and holidays) = off-peak
 *
 * The windows and holiday list are configurable, because every provider words this
 * differently and the holiday calendar changes every year.
 */

export type PriceTier = 'peak' | 'offpeak';

export interface PeakWindow {
  /** 1 = Monday ... 7 = Sunday (ISO). */
  days: number[];
  /** Inclusive start, "HH:MM" in the provider's local time. */
  start: string;
  /** Exclusive end, "HH:MM". */
  end: string;
}

/** Beijing time, matching how DeepSeek documents its windows. */
export const DEFAULT_PEAK_WINDOWS: PeakWindow[] = [
  { days: [1, 2, 3, 4, 5], start: '09:00', end: '12:00' },
  { days: [1, 2, 3, 4, 5], start: '14:00', end: '18:00' },
];

/** Holiday dates ("YYYY-MM-DD") that are billed as off-peak all day. */
export const DEFAULT_HOLIDAYS: string[] = [];

export interface PeakWindowConfig {
  windows: PeakWindow[];
  holidays: string[];
  /** IANA zone the windows are expressed in. */
  timeZone: string;
}

export const DEFAULT_PEAK_CONFIG: PeakWindowConfig = {
  windows: DEFAULT_PEAK_WINDOWS,
  holidays: DEFAULT_HOLIDAYS,
  timeZone: 'Asia/Shanghai',
};

interface ZonedParts {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  /** ISO weekday: 1 = Monday ... 7 = Sunday. */
  weekday: number;
}

/**
 * Break a timestamp into calendar parts **in the target zone**.
 *
 * Uses Intl instead of manual UTC offsets so DST-free zones like Asia/Shanghai stay
 * correct and a future non-China provider can reuse this with its own zone.
 */
export function zonedParts(date: Date, timeZone: string): ZonedParts {
  const formatter = new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
    weekday: 'short',
  });
  const parts = formatter.formatToParts(date);
  const pick = (type: string): string => parts.find((part) => part.type === type)?.value ?? '';
  const hour = Number(pick('hour')) % 24;
  const weekdayToken = pick('weekday');
  const weekdayMap: Record<string, number> = { Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6, Sun: 7 };
  return {
    year: Number(pick('year')),
    month: Number(pick('month')),
    day: Number(pick('day')),
    hour,
    minute: Number(pick('minute')),
    weekday: weekdayMap[weekdayToken] ?? 1,
  };
}

/** "YYYY-MM-DD" in the target zone. */
export function zonedDateKey(date: Date, timeZone: string): string {
  const p = zonedParts(date, timeZone);
  return `${String(p.year).padStart(4, '0')}-${String(p.month).padStart(2, '0')}-${String(p.day).padStart(2, '0')}`;
}

function toMinutes(value: string): number | null {
  const match = /^(\d{1,2}):(\d{2})$/.exec(value.trim());
  if (!match) return null;
  const hours = Number(match[1]);
  const minutes = Number(match[2]);
  if (hours > 23 || minutes > 59) return null;
  return hours * 60 + minutes;
}

/**
 * Which tier a timestamp falls into.
 *
 * Fails **open to off-peak** on malformed config: under-charging is a display
 * inaccuracy, whereas inventing peak hours would inflate every reported cost.
 */
export function tierAt(date: Date, config: PeakWindowConfig = DEFAULT_PEAK_CONFIG): PriceTier {
  const parts = zonedParts(date, config.timeZone);
  if (config.holidays.includes(zonedDateKey(date, config.timeZone))) return 'offpeak';
  const nowMinutes = parts.hour * 60 + parts.minute;
  for (const window of config.windows) {
    if (!window.days.includes(parts.weekday)) continue;
    const start = toMinutes(window.start);
    const end = toMinutes(window.end);
    if (start === null || end === null || end <= start) continue;
    if (nowMinutes >= start && nowMinutes < end) return 'peak';
  }
  return 'offpeak';
}

/** Human-readable window summary for the settings/usage screens. */
export function describeWindows(config: PeakWindowConfig): string {
  const dayNames = ['一', '二', '三', '四', '五', '六', '日'];
  const label = (window: PeakWindow): string => {
    const unique = [...new Set(window.days)].sort((a, b) => a - b);
    // 周一到周五连着写太啰嗦，直接叫"工作日"
    const isWorkdays = unique.length === 5 && unique.every((day) => day >= 1 && day <= 5);
    const days = isWorkdays ? '工作日' : `周${unique.map((day) => dayNames[day - 1] ?? '?').join('')}`;
    return `${days} ${window.start}-${window.end}`;
  };
  return config.windows.map(label).join('、');
}
