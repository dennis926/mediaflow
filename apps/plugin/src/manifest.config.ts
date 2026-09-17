/** Plain manifest object so it can be unit tested and diffed without the CRXJS wrapper. */
export const PLATFORM_HOSTS = [
  'https://creator.xiaohongshu.com/*',
  'https://channels.weixin.qq.com/*',
  'https://zhuanlan.zhihu.com/*',
  'https://mp.toutiao.com/*',
  'https://baijiahao.baidu.com/*',
];

export const MEDIAFLOW_API_ORIGIN = 'https://auto.liangyijianye.cn/*';

export const manifestConfig = {
  manifest_version: 3 as const,
  name: 'MediaFlow 助手',
  version: '0.1.0',
  description: '内容分发与矩阵运营助手：自动填充内容，人工确认发布。',
  action: {
    default_popup: 'src/popup/index.html',
    default_title: 'MediaFlow 助手',
  },
  background: {
    service_worker: 'src/background/index.ts',
    type: 'module' as const,
  },
  content_scripts: [
    {
      matches: PLATFORM_HOSTS,
      js: ['src/content/index.ts'],
      run_at: 'document_idle' as const,
    },
  ],
  // Least privilege: no cookies, no webRequest, no <all_urls>.
  permissions: ['storage', 'tabs', 'activeTab', 'alarms'],
  host_permissions: [...PLATFORM_HOSTS, MEDIAFLOW_API_ORIGIN],
};
