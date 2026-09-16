import { defineManifest } from '@crxjs/vite-plugin';

const TARGET_HOSTS = [
  'https://creator.xiaohongshu.com/*',
  'https://channels.weixin.qq.com/*',
  'https://zhuanlan.zhihu.com/*',
  'https://mp.toutiao.com/*',
  'https://baijiahao.baidu.com/*',
];

export default defineManifest({
  manifest_version: 3,
  name: 'MediaFlow 助手',
  version: '0.1.0',
  description: '内容分发与矩阵运营助手：自动填充内容，人工确认发布。',
  action: {
    default_popup: 'src/popup/index.html',
    default_title: 'MediaFlow 助手',
  },
  background: {
    service_worker: 'src/background/index.ts',
    type: 'module',
  },
  content_scripts: [
    {
      matches: TARGET_HOSTS,
      js: ['src/content/index.ts'],
      run_at: 'document_idle',
    },
  ],
  permissions: ['storage', 'tabs', 'activeTab'],
  host_permissions: [...TARGET_HOSTS, 'http://api.mediaflow.internal/*'],
});
