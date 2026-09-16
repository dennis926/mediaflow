# MediaFlow 数据库设计

> 状态：已落地（Prompt 2 完成）。实体代码在 `apps/api/src/modules/*/entities/`，迁移在 `apps/api/src/database/migrations/`。

## 1. 通用规则

- 主键：`id uuid`，默认值 `gen_random_uuid()`（PostgreSQL 内置，无需扩展）
- 所有业务表必须包含：`tenant_id`、`workspace_id`、`created_at`、`updated_at`
- 表名 / 字段名 / 关系名统一 snake_case，由 `SnakeNamingStrategy` 强制（AGENTS.md 6.1），实体属性用 camelCase
- 时间类型统一 `timestamptz`，数据库时区跟随服务器（Asia/Shanghai）
- 软删除：`contents.deleted_at`（TypeORM `DeleteDateColumn`，默认查询自动过滤）
- 敏感字段 `select: false`：`users.password_hash`、`social_accounts.access_token`、`social_accounts.refresh_token`

## 2. 表清单（16 张 + 1 张迁移表）

| 模块 | 表 | 说明 |
| --- | --- | --- |
| 组织 | `workspaces` | 工作区，`slug` 唯一（根工作区的 `workspace_id` = 自身 id） |
| 组织 | `users` | 用户，`(tenant_id, email)` 唯一 |
| 组织 | `roles` | 角色，`(tenant_id, code)` 唯一，权限存 `permissions jsonb` |
| 组织 | `user_roles` | 用户-角色关联表（TypeORM `@JoinTable` 生成） |
| 平台 | `platforms` | 平台字典，`code` 唯一，含 `publish_mode` 与 `capabilities jsonb` |
| 平台 | `social_accounts` | 已绑定平台账号，`(workspace_id, platform_id, platform_account_id)` 唯一 |
| 内容 | `contents` | 内容主表，含 AI 标识三字段 |
| 内容 | `content_variants` | 多平台版本，`(content_id, platform)` 唯一 |
| 内容 | `content_reviews` | 内容审核记录（轮次 round） |
| 内容 | `brand_knowledge` | 品牌知识库（AI 生成的事实来源） |
| 发布 | `publish_tasks` | 发布任务，状态机 + 重试 + 队列锁字段 |
| 发布 | `approvals` | 审批单（内容/版本/任务三类目标） |
| 数据 | `analytics` | 平台数据快照，`(content_id, captured_at)` 索引 |
| 数据 | `track_events` | 埋点事件 |
| AI | `ai_generations` | 每次 AI 调用的审计与成本记录 |
| 系统 | `audit_logs` | 关键操作审计日志 |
| 框架 | `typeorm_migrations` | TypeORM 迁移版本表 |

## 3. 关键字段约束

- `contents.ai_generated` (bool) / `ai_flag_type` (varchar 32：none|fully_generated|assisted|translated) / `ai_flag_checked` (bool)
  —— 法定 AI 标识要求；发布前必须 `ai_flag_checked = true`（AGENTS.md 5）
- `content_variants.platform` 取值来自共享枚举 `PlatformCode`
- `publish_tasks`：`status`（pending|scheduled|publishing|published|failed|canceled|manual_required）、`attempts` / `max_attempts`（默认 3）、`locked_by` + `locked_at`（队列 worker 幂等占用）
- `social_accounts.token_expires_at` 支撑小红书 access_token 2 小时 / refresh_token 7 天的自动刷新
- `platforms.publish_mode`：`api`（抖音/小红书）、`manual`（微信公众号，禁止 API 发布）、`plugin`（视频号/知乎/头条/百家号）

## 4. 关系（外键）

```
workspaces 1─n users
users n─n roles（user_roles）
contents n─1 users(author_id)         contents 1─n content_variants 1─n publish_tasks
contents 1─n content_reviews          platforms 1─n social_accounts 1─n publish_tasks
contents 1─n analytics                analytics / track_events / ai_generations 以 uuid 关联业务对象（不设外键，避免埋点与 AI 日志被级联删除）
```

## 5. 约定中的例外（明确的取舍）

| 表 | 例外 | 原因 |
| --- | --- | --- |
| `user_roles` | 无 `tenant_id` / `workspace_id` / 时间戳 | TypeORM `@JoinTable` 生成的关联表，租户归属由两端父表继承；如需独立审计再升级为实体表 |
| `typeorm_migrations` | 同上 | 框架自带表，非业务表 |
| 平台字典 / AI 日志 | `tenant_id`、`workspace_id` 当前均填默认工作区 | 为未来多租户预留，现阶段单租户运行 |

## 6. 常用命令

```bash
pnpm migrate                                        # 执行迁移（根目录）
pnpm --filter @mediaflow/api run migration:generate src/database/migrations/XxxSchema   # 按实体变更生成迁移
pnpm --filter @mediaflow/api run migrate:revert     # 回滚最近一次迁移
pnpm seed                                           # 写入种子数据（幂等）
pnpm --filter @mediaflow/api run schema:log         # 对比实体与库结构（应为空）
```

## 7. 种子数据（幂等，可重复执行）

- 1 个工作区：默认工作区（slug=default）
- 5 个角色：owner 超级管理员 / admin 管理员 / editor 内容运营 / reviewer 审核人 / viewer 只读成员
- 7 个平台：微信(manual)、视频号(plugin)、抖音(api)、小红书(api)、知乎(plugin)、头条(plugin)、百家号(plugin)
- 1 个管理员：`admin@mediaflow.local`（超级管理员，首次执行时打印随机密码；再次执行不重置密码）

固定 UUID 便于本地复现：租户 `1111…1111`、工作区 `2222…2222`、角色 `3333…3301~3305`、管理员 `4444…4401`。
