# MediaFlow

社交媒体内容分发与矩阵运营平台。技术栈：NestJS 10 + Next.js 14 + PostgreSQL + Redis + TypeScript 5，pnpm workspace 单仓多包。

## 快速开始

```bash
pnpm install
pnpm build:packages     # 构建共享包（shared / design-tokens / channel-adapters）
pnpm dev                # 并行启动 api(4000) / web(3000) / h5(3101) / plugin(watch)
```

单独启动：`pnpm dev:api`、`pnpm dev:web`、`pnpm dev:h5`。

## 目录

| 路径 | 说明 |
| --- | --- |
| apps/api | NestJS 后端，接口前缀 `/api` |
| apps/web | Next.js PC 端 |
| apps/h5 | React + Vite 移动端 |
| apps/plugin | 浏览器扩展（MV3） |
| packages/shared | 共享类型 / 常量 / 工具 |
| packages/design-tokens | Design Token（CSS 变量唯一来源） |
| packages/channel-adapters | 平台适配器接口与注册表 |
| docs | PRD / 架构 / API / 数据库文档 |

## 线上地址

| 端 | 地址 |
| --- | --- |
| PC 端 | https://auto.liangyijianye.cn/ |
| 移动端 H5 | https://auto.liangyijianye.cn/h5/ |
| API | https://auto.liangyijianye.cn/api/health |

两个前端共用一套登录（Token 存 localStorage 的 `mediaflow.token`）。

## 开发环境备注

- 包管理器限定 pnpm；依赖锁定精确版本。
- 本机未安装 Docker，使用系统 PostgreSQL / Redis；`docker-compose.yml` 供目标环境使用。
- **构建前端必须用 `NODE_ENV=production`**：在 `development` 下 Next 的预渲染会整体报错（`useContext of null`）；而 `pnpm install` 又需要 `NODE_ENV=development`（已在 `.npmrc` 中固定 `production=false`）。
- H5 开发端口为 3101（3001 已被本机其它站点占用）。
- 复制 `.env.example` 为 `.env` 后按需调整；`.env` 不提交。

## 规范

开发前必读 `AGENTS.md`，其中包含平台接入硬约束（公众号禁止 API 发布、抖音无互动接口等）、AI 生成内容标识要求与代码规范。
