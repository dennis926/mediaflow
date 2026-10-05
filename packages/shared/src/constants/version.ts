/**
 * Product version — the single source of truth shown in the UI.
 *
 * Release rule: bump this on every delivered iteration and tag the commit
 * `v<version>` so the running build can always be traced back to a commit.
 *
 *   patch  e.g. 0.1.1  bug fix / small UI tweak
 *   minor  e.g. 0.2.0  new feature or new module
 *   major  e.g. 1.0.0  first external release (SaaS)
 *
 * Keep it in sync with the root package.json version.
 */
export const APP_VERSION = '0.6.0';

/** Short build label shown next to the version in the sidebar footer. */
export const APP_EDITION = '内部版';
