export enum PlatformCode {
  WechatMp = 'wechat_mp',
  WechatVideo = 'wechat_video',
  Douyin = 'douyin',
  Xiaohongshu = 'xiaohongshu',
  Zhihu = 'zhihu',
  Toutiao = 'toutiao',
  Baijiahao = 'baijiahao',
}

/** How a platform can be driven by MediaFlow, per the platform access constraints. */
export enum PublishMode {
  /** Official publish API is available and allowed. */
  Api = 'api',
  /** No usable API: browser extension fills the form, human clicks publish. */
  Plugin = 'plugin',
  /** Automated publishing is forbidden by platform policy: copy content manually. */
  Manual = 'manual',
}
