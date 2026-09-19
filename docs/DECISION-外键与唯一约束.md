# 决策记录：外键与唯一约束（B0.2 / P2-2、P2-10）

- 日期：2026-09-19
- 背景：审计 P2-10 指出部分表缺少外键，孤儿数据靠"定期清理"而非结构保证；P2-2 指出同一内容同平台可重复排期。
- 决策：**该由数据库保证的约束，不要靠应用层自觉。** 本轮先补齐与"删除内容"直接相关的 2 个外键，
  并给重复排期加数据库兜底；其余表按下列评估表分阶段处理。

## 一、本轮新增（已迁移并实测回滚）

| 对象 | 定义 | 为什么这样选 |
| --- | --- | --- |
| `content_revisions.content_id` | `→ contents(id) ON DELETE CASCADE` | 版本历史依附于内容，内容没了它没有独立意义；迁移时清理了 2 条历史孤儿（写审计 `data.cleanup.orphan_content_revisions`） |
| `ai_generations.content_id` | `→ contents(id) ON DELETE SET NULL` | AI 调用流水是**成本与审计资料**，内容删除后必须保留（用于计费追溯），只断开引用 |
| `UQ_publish_tasks_active_content_platform` | `UNIQUE (content_id, platform) WHERE status IN ('pending','scheduled','publishing')` | P2-2：同一内容同平台"未完成任务"只能有一条。服务端先给友好 409，索引兜住并发（23505 → 服务端转 409）；已取消/已发布不受限，保留历史 |

迁移文件：`1789700800000-PublishTaskActiveUnique.ts`、`1789700900000-ContentRevisionsFk.ts`、`1789701000000-AiGenerationsFk.ts`
（每个都有 `down()`，已实测 revert → 约束/索引被正确移除 → 再前滚恢复）

**为什么内容相关用 CASCADE 而 AI 流水用 SET NULL**：判断标准是"这条数据离开内容还有没有独立价值"。
版本历史没有，流水有（钱和用量已经发生）——同一个删除动作，两种正确处置。

## 二、仍无外键的表：逐个评估（19 张表，2026-09-19）

平台只有"工作区"这一层（没有独立 tenants 表，`workspaces.tenant_id` 承担租户标识）。

| 表 | 语义 | 建议 | 何时做 |
| --- | --- | --- | --- |
| `contents` `content_variants` `content_revisions` `content_reviews` `publish_tasks` `analytics` `track_events` `ai_generations` `media_assets` `brand_knowledge` `content_templates` `social_accounts` `platforms` | 工作区私有业务数据（**必须**属于某个工作区） | `workspace_id → workspaces(id) ON DELETE CASCADE` | **B0.4**（与工作区归档/硬删流程一起做，否则"删工作区"会留下大片孤儿） |
| `workspace_members` | 成员关系，随工作区消失 | `workspace_id → workspaces(id) ON DELETE CASCADE` | B0.4 |
| `notifications` | 通知属于工作区 | `workspace_id → workspaces(id) ON DELETE CASCADE` | B0.4 |
| `audit_logs` | **合规留痕**：工作区删除后审计仍须保留（30 天/长期） | **刻意不加外键** | 永久（本决策即记录理由） |
| `system_settings` | 名义上是全局配置，却带 `workspace_id` — 语义待澄清 | 先澄清语义，再决定是否加 | B0.5（租户级密钥隔离时一并处理） |
| `roles` | 全局角色字典，不该限定工作区 | 不加 | — |
| `workspaces` | 自身 | — | — |
| `users` | 已有 `workspace_id → workspaces(id) ON DELETE CASCADE`（历史遗留：用户归属首个工作区） | 保留现状；B0.4 重构用户-工作区归属 | B0.4 |

**加外键前的硬性前置**（每次都要做）：先查孤儿 → 清理（写审计）→ 再建约束，否则迁移直接失败。
校验 SQL：
```sql
SELECT count(*) FROM <表> t WHERE NOT EXISTS (SELECT 1 FROM workspaces w WHERE w.id = t.workspace_id);
```

## 三、为什么不全加 CASCADE

对外 SaaS 化后，"删工作区"会是最危险的操作。加 `workspace_id` 外键前必须先有：
1. 软删除 + 30 天保留（B0.4 的 `DELETE /workspaces/:id`）；
2. 删除前校验（无未完成发布任务、无未结账单）；
3. 硬删只发生在保留期之后，且需要 owner 二次确认。

**顺序不能反**：先做生命周期流程（能软删、能恢复、有审计），再上 CASCADE——否则一次误操作就是不可逆的数据消失。

## 四、回归防线

| 测试 | 覆盖 |
| --- | --- |
| `apps/api/test/schema-integrity.e2e.spec.ts`（3 例） | 约束/索引存在且删除规则正确；删内容后变体与修订消失、AI 流水保留且 `content_id` 置空；绕过服务端直插第二条活跃任务被 23505 拦住（非活跃状态可并存） |
| `apps/api/test/queue-concurrency.e2e.spec.ts` 用例 4 | 同内容同平台第二次建单 → 409；取消后可再次建单 |
| `apps/api/src/publish/__tests__/publish.service.spec.ts`（3 例） | 服务端幂等闸门：有活跃任务抛 409 且不入队；唯一冲突转 409；无活跃任务可正常建单 |
