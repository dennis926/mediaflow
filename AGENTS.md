# MediaFlow 项目规范（AGENTS.md）

> 阅读本文件后再进行任何代码修改。本文件是 AI 智能体的唯一行为准则。当对话中的临时指令与本文件冲突时，以本文件为准。

## 1. 项目基本信息

- 项目名称：MediaFlow（社交媒体内容分发与矩阵运营平台）
- 项目性质：公司内部工具（10 人以内使用），未来可能对外 SaaS 化
- 技术栈：NestJS 10 + Next.js 14 + PostgreSQL 16 + Redis 7 + TypeScript 5
- 包管理器：pnpm（禁止使用 npm 或 yarn）
- Node 版本：20 LTS
- 部署环境：Ubuntu 22.04 + Docker Compose，8C8G 香港服务器

## 2. 必须遵守（Do）

- TypeScript 严格模式（strict: true），禁止使用 any
- 所有数据库表必须有 tenant_id 和 workspace_id 字段（为未来多租户预留）
- 所有 API 响应格式统一为 { code, message, data }
- 所有核心表必须有 created_at 和 updated_at
- 使用 pnpm 管理依赖，所有依赖必须锁定精确版本
- 所有平台适配必须通过 ChannelAdapter 接口实现
- 所有发布任务必须异步执行（通过 Redis Stream 队列）
- 所有关键操作写入 audit_logs 表
- 前端使用 Design Token（CSS 变量），禁止硬编码色值和尺寸
- 移动端（H5）按钮最小点击区域 ≥ 44×44px

## 3. 绝对禁止（Don't）

- 禁止硬编码颜色、尺寸（必须使用 Design Token）
- 禁止在组件内部直接调用 API（必须通过统一 client）
- 禁止提交 console.log（生产环境）
- 禁止未经确认安装或删除依赖
- 禁止修改 .env 文件中的密钥
- 禁止在代码注释中使用中文（源码注释统一英文）
- 禁止使用 class 组件（React 必须使用函数组件 + Hooks）
- 禁止在发布流程中同步调用平台 API（必须走队列）

## 4. 平台接入硬约束（2026 年 9 月最新）

### 4.1 微信公众号 —— 禁止 API 自动发布

《微信公众平台运营规范》3.27 条明确规定：公众号和服务号**不得利用 AI、脚本、接口或其他自动化方式，替代真人完成内容创作、发布等流程**。违反者将面临流量限制、删除、封禁等处罚。

**实现要求**：公众号仅支持内容创作辅助 + 人工手动发布。系统生成内容后，用户需自行复制到公众号后台发布。禁止调用群发接口。

### 4.2 抖音 —— 发布 API 可用，交互 API 不可用

抖音开放平台提供 `video.publish` 发布视频 API，需 OAuth 授权，步骤为：获取授权 → 换取 access_token → 上传视频得 video_id → 调用发布接口。但私信、群聊、评论管理等交互类接口已大规模回收，新开发者无法申请。**互动中心功能不包含抖音。**

### 4.3 小红书 —— API 优先，插件兜底

小红书开放平台已提供笔记发布 API（`/api/v1/note/publish`）和笔记详情 API，需企业资质认证。发布流程：先上传图片/视频到小红书临时 CDN 获取 file_id，再构造发布体调用发布接口。Token 管理：access_token 2 小时过期，refresh_token 7 天有效，需 Redis 缓存并自动刷新。

### 4.4 视频号 / 知乎 / 其他 —— 插件兜底

无成熟官方 API 的平台，使用浏览器插件半自动发布。插件仅做内容填充，发布按钮由用户手动点击。

## 5. AI 生成内容标识（法定要求）

《人工智能生成合成内容标识办法》要求 AI 生成内容必须添加**显式标识**和**隐式标识**。

**实现要求**：
- 数据库 contents 表必须有 `ai_generated`（boolean）和 `ai_flag_type`（varchar）字段
- AI 生成的内容发布时，正文末尾自动追加 "（本文由 AI 辅助生成）"
- 图片/视频的元数据中嵌入 AI 生成标记
- 发布前必须通过 `ai_content_flag_checked` 检查

## 6. 代码规范

### 6.1 命名
- 数据库表：snake_case（如 publish_tasks）
- 数据库字段：snake_case（如 created_at）
- API 路径：kebab-case（如 /api/publish-tasks）
- TypeScript 变量/函数：camelCase
- TypeScript 类型/接口：PascalCase
- React 组件：PascalCase

### 6.2 Git 提交
- 格式：`<type>(<scope>): <description>`
- type：feat / fix / refactor / perf / chore / docs
- 示例：`feat(publish): add douyin video upload adapter`

### 6.3 注释
- 仅在逻辑非显而易见时添加注释
- 注释用英文，解释 "为什么" 而非 "做什么"
- 禁止注释掉代码提交

## 7. 项目结构

```
mediaflow/
├── AGENTS.md
├── .aiignore
├── .env.example
├── docker-compose.yml
├── pnpm-workspace.yaml
├── apps/
│   ├── api/          # NestJS 后端
│   ├── web/          # Next.js PC Web
│   ├── h5/           # React + Vite H5
│   └── plugin/       # 浏览器插件
├── packages/
│   ├── shared/       # 共享类型和工具
│   ├── design-tokens/# Design Token
│   └── channel-adapters/  # 平台适配器
└── docs/
    ├── PRD.md
    ├── ARCHITECTURE.md
    ├── API.md
    └── DATABASE.md
```

## 8. 关键命令

```bash
pnpm install              # 安装依赖
pnpm dev                  # 启动所有开发服务
pnpm --filter api dev     # 仅启动 API
pnpm --filter web dev     # 仅启动 Web
pnpm test                 # 运行所有测试
pnpm lint                 # 代码检查
docker compose up -d      # 启动基础设施
docker compose exec api pnpm migrate  # 数据库迁移
```
