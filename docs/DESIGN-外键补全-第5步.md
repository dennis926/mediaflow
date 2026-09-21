# B0.4 第 5 步：工作区外键补全（M4–M7）方案

> 状态：**待用户确认后实施**（2026-09-21 输出）。第 4 步已完成（purge + 演练 + UI），本步是 B0.4 的收尾之一。

## 0. 为什么需要这一步

`workspaces` 是根表：删掉一行工作区，业务数据本该随之消失。但改造前 15 张表**没有指向 `workspaces` 的外键**，
于是"删除工作区"只删掉了那一行父记录，子表数据留了下来变成**孤儿行**——既不安全（跨租户残留）也不自洽
（purge 手动逐表删，漏一张表就漏一批数据）。

**实证**：本次前置核查在生产库里查到 3 条孤儿行（`content_templates`/`platforms`/`notifications` 各 1 条，
内容为「演练模板」/`drill_code`/「演练通知」，父工作区 `e2706e7e-…` 已不存在）。根因是我自己的演练清理脚本
（`b0_4_purge_drill.py` 第 323/325 行）只删了 `workspace_members` 与 `workspaces` 两行——**没有外键时，删父行不会带走子行**。
如果当时就有 `ON DELETE CASCADE`，这 3 条不会留下。

## 1. 前置核查（已完成）

加外键前必须保证"引用完整性已经成立"，否则 `ADD CONSTRAINT` 会直接失败。

| 检查 | 结果 |
| --- | --- |
| 15 张表 `workspace_id IS NULL` | **全为 0** |
| 15 张表 `workspace_id` 指向不存在的工作区（孤儿行） | 清理前：`content_templates` 1、`platforms` 1、`notifications` 1，**合计 3**；已留档 `b0_4_step5_orphan_rows_backup.json` 后删除；清理后 **全为 0** |
| 15 张表是否有 `workspace_id` 索引 | **全部已有**（purge 按 `workspace_id` 删行，无需新建索引；`workspace_members` 另有唯一索引 `UQ_workspace_members_workspace_user`） |
| 被刻意排除的表 | `audit_logs` 863 条孤儿、`ai_generations` 6 条、`workspace_purge_batches` 0 条 —— **这是设计预期**（B 类账本在工作区消失后仍须保留），故不加外键 |

## 2. 逐表 ON DELETE 规则表（15 条外键）

统一约定：`ON DELETE CASCADE`、`ON UPDATE NO ACTION`、约束名 `FK_<表名>_workspace`（与现有 `UQ_*`/`IDX_*` 命名风格一致）。

### 2.1 十三张工作区私有表（A 类：随工作区消失）

| # | 表 | 规则 | 理由 | 上线时的补充动作 |
| --- | --- | --- | --- | --- |
| 1 | `contents` | `workspace_id → workspaces(id) ON DELETE CASCADE` | 内容是最核心的租户数据，工作区没了内容就没有归属；已有 `author_id → users SET NULL`，与"人走内容留、工作区走内容走"的语义一致 | 无 |
| 2 | `content_variants` | CASCADE | 平台版本依附于内容（已有 `content_id → contents CASCADE`），双路径都指向"随工作区消失"，不会互相打架 | 无 |
| 3 | `content_revisions` | CASCADE | 修订历史属于内容（`content_id → contents CASCADE`，B0.2 已加）；版本历史不该跨工作区存活 | 无 |
| 4 | `content_reviews` | CASCADE | 审核记录属于内容（`content_id → contents CASCADE`）；审核留痕由审计表承担，不由业务表承担 | 无 |
| 5 | `publish_tasks` | CASCADE | 发布任务绑定内容与平台账号，工作区消失后任务无从执行；队列里的消息由 `PublishQueueService.removeByTaskIds` 在同一流程里清（purge 已实现） | purge 流程会先取消/清理队列消息（已实现，本次不改） |
| 6 | `analytics` | CASCADE | 平台数据是内容的附属统计（`content_id → contents CASCADE`） | 无 |
| 7 | `track_events` | CASCADE | 前端埋点事件按工作区隔离，属于纯业务数据 | 无 |
| 8 | `media_assets` | CASCADE | 素材行属于工作区；**注意**：文件系统上的文件不由外键删除，purge 已在删行前逐文件清理（演练已验证 0 残留）；**直接删工作区行会留下孤儿文件**，故"禁止绕过 purge 直接删工作区行"写入运维禁令（见 §4） | 无 |
| 9 | `social_accounts` | CASCADE | 平台授权凭据随工作区销毁；`platform_id → platforms RESTRICT` 要求先删账号再删平台字典（purge 的删除顺序已满足） | **凭据销毁必须留痕**：purge 已在删行前统计并写 `workspace.purge.social_accounts_destroyed` 审计（第 4 步已实现）；CASCADE 使"直接删父行"也会销毁凭据，故同样受运维禁令约束 |
| 10 | `brand_knowledge` | CASCADE | 品牌知识库（AI 适配的事实依据）是工作区私有资产 | 无 |
| 11 | `content_templates` | CASCADE | 文案模板属于工作区 | 本次核查发现的孤儿行之一，加外键后不会再出现 |
| 12 | `platforms` | CASCADE | 当前是"每个工作区一份平台字典"（工作区创建时种子），`social_accounts.platform_id` 指向它 | 若将来改成全局共享字典（B0.5 之后可能），本外键需改为**不加外键**并迁移数据；届时另开决策记录 |
| 13 | `workspace_export_jobs` | CASCADE | 导出任务与产物都属于工作区（purge 已显式删除其行与产物目录）；加外键后行为与 purge 一致，且不会再留孤儿任务 | 无 |

### 2.2 两张结构性表

| # | 表 | 规则 | 理由 |
| --- | --- | --- | --- |
| 14 | `workspace_members` | `workspace_id → workspaces(id) ON DELETE CASCADE` | 成员关系是"用户 ↔ 工作区"的连接，工作区消失后连接必须消失；用户本身**不删**（M8 已把 `users.workspace_id` 改为 `SET NULL`，用户由 `workspace_members` 表达归属） |
| 15 | `notifications` | `workspace_id → workspaces(id) ON DELETE CASCADE` | 站内通知属于工作区；purge 完成通知已改为**只走外部渠道**（第 4 步修复），因此不会再出现"通知写进刚被清除的工作区"的反例 |

### 2.3 明确**不加**外键的表

| 表 | 决定 | 理由 |
| --- | --- | --- |
| `audit_logs` | 不加 | **合规留痕**：工作区被清除后审计必须仍可查（长期保留）。外键会随父行级联删除，直接销毁证据 |
| `ai_generations` | 不加 | AI 调用账本属于 B 类（成本/计费口径，B0.7 计费表也在此类），工作区消失后仍须保留；`content_id` 已是 `SET NULL` 保留行 |
| `workspace_purge_batches` | 不加 | 清除账本本身：记录"哪个工作区何时被谁是清除的"，父工作区当然不存在 |
| `system_settings` | 暂不加 | 名义全局、实际带 `workspace_id`，语义待澄清（B0.5 租户级密钥隔离时一并处理） |
| `roles` | 不加 | 全局角色字典，被 `user_roles` 引用；`workspace_id` 字段是历史遗留，不该限定工作区 |
| `users` | 保持现状 | 已是 `workspace_id → workspaces(id) ON DELETE SET NULL`（M8），语义是"人保留、归属清空" |
| `user_roles` / `typeorm_migrations` | 不适用 | 无 `workspace_id` 字段 |

## 3. 迁移与回滚方案

**一表一迁移，互不依赖**（失败可单独回滚，不影响其他表）：

| 迁移 | 内容 | 回滚 |
| --- | --- | --- |
| `1789701500000-FkContentsWorkspace` | `ALTER TABLE contents ADD CONSTRAINT FK_contents_workspace FOREIGN KEY (workspace_id) REFERENCES workspaces(id) ON DELETE CASCADE` | `DROP CONSTRAINT FK_contents_workspace` |
| `1789701501000-FkContentVariantsWorkspace` | 同上（`content_variants`） | 同上 |
| `1789701502000-FkContentRevisionsWorkspace` | `content_revisions` | 同上 |
| `1789701503000-FkContentReviewsWorkspace` | `content_reviews` | 同上 |
| `1789701504000-FkPublishTasksWorkspace` | `publish_tasks` | 同上 |
| `1789701505000-FkAnalyticsWorkspace` | `analytics` | 同上 |
| `1789701506000-FkTrackEventsWorkspace` | `track_events` | 同上 |
| `1789701507000-FkMediaAssetsWorkspace` | `media_assets` | 同上 |
| `1789701508000-FkSocialAccountsWorkspace` | `social_accounts` | 同上 |
| `1789701509000-FkBrandKnowledgeWorkspace` | `brand_knowledge` | 同上 |
| `1789701510000-FkContentTemplatesWorkspace` | `content_templates` | 同上 |
| `1789701511000-FkPlatformsWorkspace` | `platforms` | 同上 |
| `1789701512000-FkWorkspaceExportJobsWorkspace` | `workspace_export_jobs` | 同上 |
| `1789701513000-FkWorkspaceMembersWorkspace` | `workspace_members` | 同上 |
| `1789701514000-FkNotificationsWorkspace` | `notifications` | 同上 |

实施细节：

1. **先清孤儿再加外键**：已在上线前置核查完成（0 孤儿、0 空值）。迁移脚本本身不做数据清理（避免把"修数据"藏在 schema 迁移里）。
2. **大表用两段式**：本库全是小表，直接 `ADD CONSTRAINT` 即可；方案里保留 `NOT VALID` + `VALIDATE CONSTRAINT` 的写法说明，
   供将来数据量大时复用（`ADD CONSTRAINT ... NOT VALID` 只加锁瞬间，随后 `VALIDATE` 可并发）。
3. **每步 up/down 都要实测**：迁移 → 断言 → `migrate:revert` → 再 `migrate`，与前三步的做法一致。
4. **回滚不影响数据**：`DROP CONSTRAINT` 只解除约束，不删行。

## 4. 验收标准（实施时必须全部通过）

1. `schema-integrity.e2e.spec.ts` 扩展：断言 15 条外键**都存在**且 `delete_rule = CASCADE`；断言被排除的 3 张账本表**确实没有**指向 `workspaces` 的外键。
2. **级联实测**：新建工作区 → 在 15 张表各造 1 行 → 直接 `DELETE FROM workspaces` → 15 张表的行**全部消失**，而 `audit_logs` / `ai_generations` / `workspace_purge_batches` 的行**仍在**。
3. **purge 演练复跑**：A 类 14 表仍为 0、B 类保留、C 类不变（外键是"兜底"，不改变 purge 自身行为）。
4. `pnpm migrate` / `migrate:revert` 全部往返成功；迁移数量 22 → 37。
5. 单元测试与 E2E 全绿；生产 `/api/health` = 200；基线不变（工作区 1 / 内容 1 / 用户 2）。
6. **运维禁令写入 `RUNBOOK-`**：**禁止绕过 API 直接 `DELETE FROM workspaces`**（会静默销毁平台凭据与素材文件，且不写审计）；
   需要清除数据一律走 `DELETE /api/workspaces/:id/data`（有二次确认、备份、审计、账本）。

## 5. 风险与已知取舍

| 风险 | 处置 |
| --- | --- |
| 外键 CASCADE 会"静默"销毁 `social_accounts` 凭据 | 已审计（purge 路径）+ 运维禁令（禁止直接删父行）；CASCADE 让后果可预测，比"留下孤儿凭据"更安全 |
| 素材文件不由外键删除 | purge 已逐文件清理（演练验证）；直接删父行会留孤儿文件 → 靠运维禁令 + 定期孤儿文件巡检（可加进运维监控） |
| `platforms` 将来可能改全局共享 | 已记录：届时去掉该外键并迁移数据（B0.5 之后再评估） |
| 加外键会让"删除工作区"变慢 | 本库数据量极小，且 `workspace_id` 索引全在；将来量大时用两段式 `NOT VALID` + `VALIDATE` |
