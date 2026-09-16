# MediaFlow 数据库设计

> 状态：骨架占位，实体随 Prompt 2（数据库层）补全。

## 1. 通用规则

- 所有表包含：`id`(uuid) / `tenant_id` / `workspace_id` / `created_at` / `updated_at`
- 软删除统一使用 `deleted_at`（null 表示未删除）
- 主键 uuid，时间戳 `timestamptz`
- 表名与字段名 snake_case

## 2. 计划表清单

| 模块 | 表 |
| --- | --- |
| 组织 | workspaces, users, roles, user_roles |
| 平台 | platforms, social_accounts |
| 内容 | contents, content_variants, content_reviews, brand_knowledge |
| 发布 | publish_tasks, approvals |
| 数据 | analytics, track_events |
| AI | ai_generations |
| 系统 | audit_logs |

## 3. 关键字段约束

- `contents.ai_generated` (boolean) 与 `contents.ai_flag_type` (varchar)：AI 生成标识（法定要求）
- `contents.ai_content_flag_checked` (boolean)：发布前校验标记
- `publish_tasks.status`：pending / scheduled / publishing / published / failed / canceled / manual_required
- `social_accounts`：access_token / refresh_token / expires_at（小红书 2h / 7d 生命周期）

## 4. 待补充

- 完整 ER 图、索引设计与迁移文件说明
