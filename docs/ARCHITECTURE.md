# MediaFlow 架构文档

> 状态：骨架占位。随各阶段开发逐步补全。

## 1. 总体架构

```
apps/web (Next.js 14, PC)  ─┐
apps/h5  (React + Vite, 移动) ─┼─→ apps/api (NestJS 10, /api)  ─→ PostgreSQL 16+
apps/plugin (CRXJS 扩展)    ─┘                                 ─→ Redis 7 (Stream 队列)
                                                               ─→ MinIO (媒体存储)
                                                               ─→ DeepSeek V4-Flash (AI)
```

## 2. 仓库结构

pnpm workspace 单仓多包：

- `apps/*`：可运行应用（api / web / h5 / plugin）
- `packages/shared`：跨端共享的类型、常量、工具（统一响应体、平台枚举、AI 标识工具）
- `packages/design-tokens`：Design Token 唯一来源（`src/tokens.json` → 构建产出 `dist/tokens.css`）
- `packages/channel-adapters`：ChannelAdapter 接口与适配器注册表

## 3. 关键约定

- 依赖全部锁定精确版本（`.npmrc: save-exact=true`）
- 前后端共享类型只能来自 `@mediaflow/shared`，禁止各端复制定义
- 前端颜色 / 尺寸只能引用 CSS 变量 `var(--mf-*)`，不得硬编码
- 所有 API 响应由 `ResponseInterceptor` 统一封装为 `{ code, message, data }`

## 4. 平台适配层与异步发布链路

### 4.1 适配层（packages/channel-adapters）

- 契约 `ChannelAdapter`：`auth` / `refreshToken` / `publish` / `fetchAnalytics` + `capabilities`
- 已实现适配器：
  | 适配器 | 平台 | 模式 | 发布行为 |
  | --- | --- | --- | --- |
  | `WechatMpAdapter` | 微信公众号 | manual | 永不调用群发接口，返回 `manual_required` 让运营手动发布；可拉取图文分析数据 |
  | `DouyinAdapter` | 抖音 | api | `video/upload` → `video/create`；无 access_token 时明确失败；**无互动能力** |
  | `XiaohongshuAdapter` | 小红书 | api | `note/publish`、`note/detail`；开放平台地址由 `XIAOHONGSHU_API_BASE` 配置，未配置则拒绝调用 |
  | `PluginFillAdapter` | 视频号/知乎/头条/百家号 | plugin | 返回 `pending`，等待浏览器插件填充 + 人工点击发布 |
- Token 缓存：适配器只依赖 `TokenStore` 接口，API 侧由 `RedisTokenStore` 用 Redis 实现（公众号 app_token 提前 5 分钟过期）

### 4.2 发布链路

`POST /api/publish/tasks` → 校验（内容存在、AI 标识已校验、平台有适配器）→ 写 `publish_tasks` → `XADD` 入 Redis Stream
→ `PublishWorker`（消费组 `publish-workers`）读消息 → 重新读取任务 → **条件更新抢锁**（`attempts+1`，并发安全）→ 调用适配器 → 回写状态 + 审计日志。

- 扫描器每 15s 兜底：把到点的 `scheduled` 任务、以及被 Redis 丢失的 `pending` 任务重新入队（等待人工确认的插件任务不再入队）
- 失败重试：间隔 `PUBLISH_RETRY_INTERVAL_MS`，达到 `maxAttempts` 后置 `failed`
- 终态：`published` / `manual_required` / `failed` / `canceled`；worker 对终态任务直接跳过（幂等）

## 5. 本机开发环境说明（与 AGENTS.md 的差异）

| 项 | AGENTS.md 目标环境 | 当前开发机 |
| --- | --- | --- |
| 容器 | Docker Compose | **未安装 Docker**，使用原生 PostgreSQL / Redis 服务 |
| PostgreSQL | 16 | 18.6（协议兼容） |
| Node | 20 LTS | 22.22.1（满足 engines >= 20） |
| H5 端口 | 3001 | 3101（3001 已被本机其它站点占用） |

`docker-compose.yml` 保留，用于目标环境；本机使用系统服务：
`systemctl start postgresql redis-server`。

## 6. 待补充

- 部署拓扑与 Nginx 反代
- 队列消费幂等与死信处理
- 观测（日志 / 指标 / 告警）
