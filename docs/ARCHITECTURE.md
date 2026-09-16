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

## 4. 异步发布链路

发布任务一律异步：`POST /api/publish/tasks` 写库 → 入 Redis Stream → PublishWorker 消费 → 调用 ChannelAdapter → 回写状态。
平台策略：`api`（抖音、小红书）走官方接口；`manual`（公众号）返回 `manual_required`；`plugin`（视频号、知乎等）等待插件回传人工确认结果。

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
