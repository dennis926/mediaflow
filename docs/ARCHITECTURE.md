# NeedAi 内容分发系统 架构文档

> 内部代号 MediaFlow。描述**当前线上真实架构**（v0.2.0）。

## 1. 总体架构

```
apps/web (Next.js 14, PC)  ─┐
apps/h5  (React + Vite, 移动) ─┼─→ apps/api (NestJS 10, /api)  ─→ PostgreSQL 16+
apps/plugin (CRXJS 扩展)    ─┘                                 ─→ Redis 7 (Stream 队列)
                                                               ─→ MinIO (媒体存储，当前素材走本地磁盘)
                                                               ─→ DeepSeek V4.1 Flash (AI)
                                                               ─→ 供应商官网价目表 (AI 计费价源)
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
- 版本号单一来源：`packages/shared/src/constants/version.ts` 的 `APP_VERSION`，由 `pnpm release` 递增并打标签；组件内禁止写死版本字符串
- AI 计费只认官方价，价格优先级「用户覆盖价 > 官网抓取价 > 国内权威参考价（国家超算互联网，人民币）> 聚合价目表（models.dev，美元）> 预置目录价 > 全局兜底价」，禁止折扣与倍率

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

## 4.3 运行时配置（系统设置）

`system_settings` 表 + `SettingsService` 提供「数据库优先、.env 兜底」的运行时配置：

- 配置项注册表在 `apps/api/src/modules/settings/settings.registry.ts`（新增配置项只改这里 + 前端自动渲染）
- 密钥字段用 `CryptoService`（AES-256-GCM）加密入库，接口只返回掩码
- AI 提供方由 `AiProviderFactory` 按当前配置动态构建，配置变更后无需重启即可生效（发布 Worker 开关与重试间隔改动仍需重启 API）
- PC 端「系统设置」页（`/settings`）按分组渲染表单，含「测试连接」按钮
- 因此把仓库公开出去时，仓库里只有 `.env.example` 模板，真实密钥一律在后台维护（提交前可跑 `pnpm check:secrets`）
- AI 计费相关配置：`AI_PEAK_WINDOWS`（峰谷窗口 + 节假日）、`AI_OFFICIAL_PRICE_AUTO_REFRESH` / `AI_OFFICIAL_PRICE_REFRESH_MINUTES`（官网抓取）、`AI_OFFICIAL_PRICES`（抓取结果，系统自动写入）

### 4.3.1 AI 计费链路

```
AI 调用 ──> AiService.complete()
              ├─ 解析当前时段（pricing/peak-window.ts，按 Asia/Shanghai 日历判定高峰/空闲）
              ├─ 取价（ModelPricingService.resolveOfficial）
              │    官网抓取价 AI_OFFICIAL_PRICES  ──(优先)──┐
              │    预置目录价 model-catalog.ts              ├─> 人民币峰谷价
              │    用户覆盖价 AI_MODEL_PRICES ──(最高)──────┘
              ├─ 四段计价（输入 / 输出 / 缓存写入 / 缓存读取）
              └─ 落库 ai_generations.cost + price_snapshot（含 tier / tierLabel）

定时任务 OfficialPriceRefreshTask（每分钟醒来，按配置间隔执行）
  └─> pricing/deepseek-pricing.ts 抓取官网 ──> 解析 HTML 表格 ──> OfficialPriceStore 落库
      解析失败：保留上一份价格 + 日志告警，绝不影响计费
```

## 4.4 移动端（apps/h5）

- React 18 + Vite 5，移动优先：底部 4 Tab 导航（56px + safe-area）、点击区域 ≥44px、输入框字号 16px（防 iOS 缩放）
- 页面：`/h5/login`、`/h5/dashboard`（2×2 数据卡片）、`/h5/publish/queue`（Tab 过滤 + 卡片列表）、`/h5/publish/task/:id`（详情 + 重试）
- 生产构建 `base=/h5/`，与 PC 端共用同一套 `/api` 与 `mediaflow.token`

## 4.5 部署拓扑（生产）

```
浏览器 ──HTTPS──> 宝塔 nginx (auto.liangyijianye.cn)
                    ├── /h5/   → 静态文件 /www/wwwroot/auto.liangyijianye.cn/h5/
                    ├── /api/  → 127.0.0.1:4000  mediaflow-api.service (NestJS, node dist/main.js)
                    └── /      → 127.0.0.1:3000  mediaflow-web.service  (Next.js, next start)
                        ↓
             PostgreSQL 18 (mediaflow) + Redis 8 (发布队列)
```

- 两个服务均为 systemd 单元（`Restart=always`、开机自启），日志在 `/var/log/mediaflow-api.log`、`/var/log/mediaflow-web.log`
- 生产仅监听回环地址（`APP_HOST=127.0.0.1`），公网只能经 nginx 访问
- 部署流程：`NODE_ENV=production pnpm --filter @mediaflow/api run build` → 重启 api；`NODE_ENV=production pnpm --filter @mediaflow/web run build` → 重启 web；H5 构建产物拷到 `/www/wwwroot/auto.liangyijianye.cn/h5/`

## 5. 本机开发环境说明（与 AGENTS.md 的差异）

| 项 | AGENTS.md 目标环境 | 当前生产机 |
| --- | --- | --- |
| 容器 | Docker Compose | Docker 29.1.3 + compose v2 **已安装**，容器栈（B0.8）与 systemd 生产并存：容器 api/web 在 4300/3300，systemd 生产在 4000/3000 |
| PostgreSQL | 16 | 18.6（协议兼容）；容器栈内为 16-alpine |
| Node | 20 LTS | 22.22.1（满足 engines >= 20） |
| H5 端口 | 3001 | 3101（3001 已被本机其它站点占用） |

生产**以 systemd 承载为主**（`mediaflow-api` / `mediaflow-web`），容器栈用于验证容器化部署路径。
`docker compose` 命令必须带 `--env-file .env.docker`，否则会读生产 `.env` 把密钥带进容器。

本地开发可用 `docker compose up -d postgres redis minio`，或直接用系统服务
`systemctl start postgresql redis-server`。

## 6. 观测与运维

- **运行监控**：`OpsMonitorService` 7 项巡检（队列积压 / 磁盘 / 发布失败率 / 登录失败 / 跨工作区引用与孤儿行 / AI 配额等），
  按 `scope: 'platform' | 'workspace'` 区分口径；前端「系统设置 → 运行监控」可视化。
- **外部巡检**：cron 每 5 分钟探 `/api/health`，日志 `/var/log/mediaflow-monitor.log`。
- **备份**：cron 每日 04:30 全库 `pg_dump`，产物 600 权限，保留在 `/www/backup/mediaflow/`。
- **审计**：关键操作写 `audit_logs`；AI 调用写 `ai_generations`（含费用与档位快照）。

## 7. 已知技术债

| 项 | 说明 | 文档 |
| --- | --- | --- |
| 无全局租户过滤器 | 隔离靠逐查询带 `workspace_id`，已加**静态闸门**（`scripts/check-tenant-scope.mjs`）在 CI/预检拦截"按裸 id 读取"的新代码 | — |
| purge 备份与库同机 | 备份未异地存放，同机故障会同时丢数据 | `TECHDEBT-purge备份异地.md` |
| E2E 与生产隔离 | 已用临时库+哨兵解决；生产库仍有历史测试残留 | `TECHDEBT-E2E隔离.md` |
| 权限粒度 | 角色级而非细粒度 ACL | `TECHDEBT-权限粒度.md` |
| 角色数据源 | `roles` 表与代码内置角色双轨 | `TECHDEBT-角色数据源.md` |
