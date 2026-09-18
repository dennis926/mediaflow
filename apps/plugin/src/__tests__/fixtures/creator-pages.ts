/**
 * Synthetic fixtures shaped like the creator dashboards.
 *
 * They are hand-written, not captured from live pages: they encode the two layouts the parsers
 * have to cope with (embedded state and rendered labels) plus the failure shapes (truncated state,
 * empty counters, unrelated pages). Real dashboards change their key names over time, which is why
 * `metrics-parse.test.ts` also covers "no data" and "JSON broken, labels still readable".
 */

/** URL of a douyin work-data page (postId comes from the embedded state). */
export const DOUYIN_DATA_URL = 'https://creator.douyin.com/creator-micro/content/manage';

/** Counters live in `window._ROUTER_DATA`, numbers mix ints and the "1.2万" style. */
export const DOUYIN_DATA_PAGE = `<!doctype html>
<html><head><title>作品数据</title>
<script>window._ROUTER_DATA = {"loaderData":{"video_detail":{"videoInfo":{"awemeId":"7351234567890123456","title":"秋季肠道健康指南：3 个饮食搭配","statistics":{"playCount":128500,"diggCount":"1.2万","commentCount":342,"shareCount":88,"collectCount":1200}}}}};</script>
</head><body><div id="app">作品数据</div></body></html>`;

/** URL of a xiaohongshu note manager page. */
export const XIAOHONGSHU_DATA_URL = 'https://creator.xiaohongshu.com/new/note-manager?noteId=65f0c1a2b3d4e5f60718293a';

/** No embedded state at all: every counter has to come from the rendered labels. */
export const XIAOHONGSHU_NOTE_MANAGER_PAGE = `<!doctype html>
<html><head><title>笔记管理</title></head>
<body>
  <div id="app">
    <ul class="note-list">
      <li class="note-item">
        <div class="note-title">秋季肠道健康指南</div>
        <div class="stat"><span>观看</span><span>1.2万</span></div>
        <div class="stat"><span>点赞</span><span>1,234</span></div>
        <div class="stat"><span>评论</span><span>56</span></div>
        <div class="stat"><span>收藏</span><span>789</span></div>
        <div class="stat"><span>分享</span><span>12</span></div>
      </li>
    </ul>
  </div>
</body></html>`;

/** Two notes in one payload: the parsers keep the first match (documented behaviour). */
export const XIAOHONGSHU_TWO_NOTES_PAGE = `<!doctype html>
<html><head>
<script>window.__INITIAL_STATE__ = {"noteList":[{"noteId":"note-111111","title":"第一篇","viewCount":11111,"likeCount":111},{"noteId":"note-222222","title":"第二篇","viewCount":22222,"likeCount":222}]};</script>
</head><body><div id="app"></div></body></html>`;

/** Zhihu stores its numbers in a `<script id="js-initialData" type="text/json">` block. */
export const ZHIHU_DATA_URL = 'https://zhuanlan.zhihu.com/creator/analysis/articles';

export const ZHIHU_ANALYSIS_PAGE = `<!doctype html>
<html><head><title>创作中心</title></head>
<body>
<script id="js-initialData" type="text/json">{"initialState":{"entities":{"articles":{"651234567":{"id":"651234567","title":"肠道菌群与膳食纤维","readCount":98234,"likeCount":412,"commentCount":37,"favoriteCount":96,"shareCount":18}}}}}</script>
<div id="root">创作中心 · 数据分析</div>
</body></html>`;

/** Toutiao: `var _SSR_HYDRATED_DATA`, plus likes/comments only present in the markup. */
export const TOUTIAO_DATA_URL = 'https://mp.toutiao.com/profile_v4/graphic/articles';

export const TOUTIAO_DATA_PAGE = `<!doctype html>
<html><head><title>内容分析</title>
<script>var _SSR_HYDRATED_DATA = {"articleStats":{"itemId":"7345678901234567890","showCount":"15.6万","forwardCount":234,"favoriteCount":99}};</script>
</head><body>
<div class="stat"><span>点赞</span><span>2,345</span></div>
<div class="stat"><span>评论</span><span>87</span></div>
</body></html>`;

/** Baijiahao: label layout where 0 is a real value and "—" means "not available". */
export const BAIJIAHAO_DATA_URL = 'https://baijiahao.baidu.com/builder/rc/content/index';

export const BAIJIAHAO_CONTENT_PAGE = `<!doctype html>
<html><head><title>内容管理</title></head>
<body>
<div class="data-card">
  <div class="item"><span class="label">阅读量</span><span class="value">3,456</span></div>
  <div class="item"><span class="label">点赞</span><span class="value">0</span></div>
  <div class="item"><span class="label">评论</span><span class="value">—</span></div>
  <div class="item"><span class="label">分享</span><span class="value">4</span></div>
  <div class="item"><span class="label">收藏</span><span class="value">9</span></div>
</div>
</body></html>`;

/** Wechat video channel post list. */
export const WECHAT_VIDEO_DATA_URL = 'https://channels.weixin.qq.com/platform/post/list';

export const WECHAT_VIDEO_STATS_PAGE = `<!doctype html>
<html><head><title>视频号数据</title>
<script>window.__INITIAL_STATE__ = {"postData":{"list":[{"objectId":"export/UzFfBgAAxL","title":"三分钟看懂膳食纤维","playCount":45210,"likeCount":"1.5万","commentCount":120,"shareCount":64,"collectCount":310}]}};</script>
</head><body><div id="app"></div></body></html>`;

/** Wechat official account article list: labels only, and its own vocabulary (在看 / 留言). */
export const WECHAT_MP_DATA_URL = 'https://mp.weixin.qq.com/cgi-bin/appmsg?action=list_card';

export const WECHAT_MP_ARTICLE_PAGE = `<!doctype html>
<html><head><title>图文分析</title></head>
<body>
<div class="appmsg-row">
  <div class="cell"><span>阅读</span><span>1.2万</span></div>
  <div class="cell"><span>在看</span><span>88</span></div>
  <div class="cell"><span>点赞</span><span>210</span></div>
  <div class="cell"><span>分享</span><span>45</span></div>
  <div class="cell"><span>留言</span><span>14</span></div>
</div>
</body></html>`;

/** A generic error page: nothing to scrape, and nothing to crash on. */
export const UNRELATED_PAGE = `<!doctype html>
<html><head><title>页面走丢了</title></head>
<body><main><h1>页面走丢了</h1><p>请返回首页重新进入</p><a href="/home">返回首页</a></main></body></html>`;

/** A real editor page: state is present, counters are not. Must yield null, not zeros. */
export const EMPTY_EDITOR_PAGE = `<!doctype html>
<html><head>
<script>window.__INITIAL_STATE__ = {"editor":{"title":"","tags":[],"draftId":"draft-abc-123"}};</script>
</head><body><div id="app">发布笔记</div></body></html>`;

/** Douyin with a truncated state payload: JSON recovery must fail softly and fall back to labels. */
export const TRUNCATED_STATE_PAGE = `<!doctype html>
<html><head>
<script>window._ROUTER_DATA = {"loaderData":{"video":{"statistics":{"playCount":1234,</script>
</head><body>
<div class="stat"><span>点赞</span><span>3.2万</span></div>
<div class="stat"><span>评论</span><span>418</span></div>
</body></html>`;
