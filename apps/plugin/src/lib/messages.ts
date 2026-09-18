/**
 * Message names exchanged between the popup, the service worker and the content script.
 * Kept in one module so the three sides cannot drift apart.
 */

/** Asks the page (the content script) to scrape its own numbers. Used for pull-style collection. */
export const MSG_COLLECT_METRICS = 'mediaflow:collect-metrics';

/** Content script → background: numbers scraped off the page that is currently open. */
export const MSG_METRICS_COLLECTED = 'mediaflow:metrics-collected';

/** Popup → background: rebuild the alarm and sweep the configured data pages right now. */
export const MSG_COLLECT_NOW = 'mediaflow:collect-now';
