# NeedAi 内容分发系统（内部代号 MediaFlow）

社交媒体内容分发与矩阵运营平台。技术栈：NestJS 10 + Next.js 14 + PostgreSQL + Redis + TypeScript 5，pnpm workspace 单仓多包。

- 线上地址：<https://auto.liangyijianye.cn/>（PC）、`/h5/`（移动端）、`/api/`（后端）
- 界面显示的品牌名来自设置项 `SITE_NAME`（设置 → 站点信息），**交给别的公司时改配置即可，不必改代码**
- 当前版本见侧边栏页脚 `v<版本号> · <版本标识>`，与 git 标签一一对应

## 版本迭代

界面版本号来自 `packages/shared/src/constants/version.ts`，由发版脚本统一维护：

```bash
pnpm release patch "修复发布队列重试次数统计"   # 0.2.0 → 0.2.1
pnpm release minor "新增 XX 功能"              # 0.2.0 → 0.3.0
pnpm release major "首个对外 SaaS 版本"        # 0.2.0 → 1.0.0
```

脚本会同步改所有 `package.json`、追加 `CHANGELOG.md`、提交并打 `v<版本号>` 标签。
排查线上问题时，用页脚版本号即可直接定位到对应提交。

## 快速开始

```bash
pnpm install
pnpm build:packages     # 构建共享包（shared / design-tokens / channel-adapters）
pnpm dev                # 并行启动 api(4000) / web(3000) / h5(3101) / plugin(watch)
```

单独启动：`pnpm dev:api`、`pnpm dev:web`、`pnpm dev:h5`。

### 本地从零跑起来（完整步骤）

```bash
# 1) 基础设施：PostgreSQL 16 + Redis（也可用仓库里的 docker-compose.yml 起容器，仅用于本地开发）
docker compose up -d postgres redis minio

# 2) 环境变量：复制模板后按需修改（数据库、Redis、JWT_SECRET 等）
cp .env.example .env

# 3) 依赖与共享包
pnpm install && pnpm build:packages

# 4) 建表 + 初始数据（默认工作区、5 个角色、1 个管理员、示例资料/模板）
pnpm migrate
pnpm seed                 # 交付给别人时设 SEED_SAMPLE_CONTENT=false 可跳过示例内容
pnpm --filter @mediaflow/api run seed:knowledge
pnpm --filter @mediaflow/api run seed:templates

# 5) 启动
pnpm dev
```

> 生产环境不使用 Docker：由 systemd（`mediaflow-api` / `mediaflow-web`）+ Nginx 承载，
> 完整步骤、备份、监控与"交付给别人要改哪些配置"见 `docs/DEPLOYMENT.md`。

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

## 运行时配置（推荐）

登录后进入 **系统设置** 页面即可配置 AI 密钥、平台密钥与发布队列参数：

- 数据库中的配置优先于 `.env`，密钥加密存储、界面只显示后四位
- 「测试连接」按钮可立即验证 AI 密钥是否可用
- 留空 = 清除后台配置，回退到 `.env`

## 发布到仓库前（安全）

- 真实密钥只放在 `.env`，该文件已在 `.gitignore` 中，**永不入库**；仓库里只有 `.env.example` 模板（占位符）
- 提交前跑一次自检：`pnpm check:secrets`（扫描受版本控制的文件里是否有 `sk-*`、AppSecret、JWT 密钥、令牌、私钥）
- 新增配置项时同步更新 `.env.example`，不要写真实值
- 生产部署时密钥通过 `.env` 或环境变量注入，不要写进代码或文档

## 规范

开发前必读 `AGENTS.md`，其中包含平台接入硬约束（公众号禁止 API 发布、抖音无互动接口等）、AI 生成内容标识要求与代码规范。
