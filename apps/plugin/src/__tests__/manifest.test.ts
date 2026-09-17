import { describe, expect, it } from 'vitest';
import { manifestConfig } from '../manifest.config';

describe('扩展清单', () => {
  it('uses manifest v3 and least-privilege permissions', () => {
    expect(manifestConfig.manifest_version).toBe(3);
    expect(manifestConfig.permissions).toEqual(expect.arrayContaining(['storage', 'tabs', 'activeTab']));
    expect(manifestConfig.permissions).not.toContain('cookies');
    expect(manifestConfig.permissions).not.toContain('webRequest');
  });

  it('declares the platform editor hosts and the MediaFlow API host only', () => {
    const hosts = manifestConfig.host_permissions;
    expect(hosts).toContain('https://creator.xiaohongshu.com/*');
    expect(hosts).toContain('https://channels.weixin.qq.com/*');
    expect(hosts).toContain('https://auto.liangyijianye.cn/*');
    expect(hosts.some((host) => host === '<all_urls>' || host === '*://*/*')).toBe(false);
  });

  it('routes the popup, worker and content script', () => {
    expect(manifestConfig.action.default_popup).toBe('src/popup/index.html');
    expect(manifestConfig.background.service_worker).toBe('src/background/index.ts');
    expect(manifestConfig.content_scripts[0]?.js).toEqual(['src/content/index.ts']);
  });
});
