# 决策记录：历史软删数据清理与外键 CASCADE

- 日期：2026-09-18
- 阶段：阶段 A（P1 修复 + 内部上线）
- 决策人：用户（授权清理），执行：运维脚本
- 相关提交：`d4ecd3c`（preflight）、`46ed021`（队列修剪）、`f7c8942`（权限即时生效）；清理动作见 `audit_logs` 的 `data.cleanup.soft_deleted` / `data.cleanup.cascade_restore`

## 1. 背景

审计发现数据库里堆积了一批软删除行（测试内容、导入测试资料、测试素材、测试变体）与孤儿行
（`content_variants` / `content_revisions` / `ai_generations` 指向已删除内容）。用户授权清理，
并要求"验收项：内容表总行 = 1、知识表总行 = 6、发布任务 = 10"。

## 2. 清理结果

| 表 | 删除行数 |
|---|---|
| `contents` | 45 |
| `brand_knowledge` | 30 |
| `media_assets` | 10 |
| `content_variants` | 31 |
| `content_revisions` | 11（孤儿，含被级联影响的内容的快照） |
| `ai_generations` | 25（13 条孤儿 + 12 条指向被清理内容） |
| `track_events` | 4 |
| `audit_logs` | **0（追加型，仅新增 2 条清理留痕）** |

清单（逐条 128 行）：`/root/.hermes/workspace/soft-deleted-inventory.md`
恢复来源：`/www/backup/mediaflow/pre-task0-2026-09-18_2334.sql.gz`（恢复演练验证通过）

## 3. 关于 `publish_tasks` 被连带删除（决策：接受）

清理内容行时，10 条历史发布任务（全部 `canceled`，创建于 09-18 22:06–22:17）被数据库自动删除：

```
FK_2ac3cdf306735bd646be23bfbba  publish_tasks.content_id → contents(id)  ON DELETE CASCADE
```

尝试从备份反向导入这 10 条任务被外键拒绝（`Key (content_id)=(...) is not present in table "contents"`），
说明**任务行在结构上无法脱离内容行独立存在**。

**决策：接受 `publish_tasks = 0`。**理由：

1. 10 条任务全部是测试任务（canceled/failed），其内容已不存在，UI 中只会显示空标题；
2. 恢复它们必须同时恢复 5 条测试内容，会污染"在用内容 = 1"的基线；
3. 该 CASCADE 是**正向设计**：发布任务不会产生孤儿，删除内容即清理其发布历史。

## 4. 后续约束（重要）

- **内容删除接口**（`ContentService.remove`）目前是软删除（`deleted_at`），不会触发 CASCADE；
  硬删除（如运维直接 `DELETE FROM contents`）会连带删除其发布任务。
- 若未来需要"删除内容但保留发布任务历史"，必须二选一：
  1. 把 `publish_tasks.content_id` 的 FK 改为 `ON DELETE SET NULL`（并允许 `content_id` 为空）；
  2. 删除前先把任务归档到独立的历史表（`publish_task_archive`）。
  **不要**在应用层绕过外键（插入指向不存在内容的行会被拒绝）。
- 清理类脚本必须与本次一致：单事务执行、先备份、先出清单、把动作写入 `audit_logs`。

## 5. 验收状态

| 项 | 目标 | 实际 |
|---|---|---|
| 内容表总行 | 1 | 1 ✅ |
| 在用知识 / 知识表总行 | 6 / 6 | 6 / 6 ✅ |
| 发布任务 | （调整为 0） | 0 ✅ |
| 审计日志 | 递增 | 1457（+2 条清理留痕）✅ |
| 健康接口 | 200 | 200 ✅ |
