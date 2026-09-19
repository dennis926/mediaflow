# 设计文档：多租户生命周期（B0.4）

> **状态：待确认，尚未实施。** 本文件是 B0.4 的实施依据；其中 `workspace_id` 外键的 `CASCADE` 是不可逆操作，
> 必须先经确认再逐步实施（每步一个迁移 + 每步一个交付报告）。
>
> 编写日期：2026-09-19｜基于当前代码与生产库实况（22 张表、1 个工作区、数据基线：内容 1 / 用户 2 / 审计 2854 行）
>
> **实施进度**：第 1 步（M1–M3 迁移 + 状态机 + 缓存失效）已完成并通过测试（见文末 §12）；
> 第 2–6 步待逐步实施。本次修订已吸收用户对 6 个确认点的决策与 4 项补充要求。

---

## 0. 一句话设计

**先能"软"、再能"回"，最后才允许"删"**：归档（只读，随时可逆）→ 软删（30 天保留，可恢复）→ 硬删（不可逆，二次确认 + 独立备份）。
数据分三类对待：**业务数据**（随工作区消失）、**成本与审计账本**（永久保留）、**全局共享数据**（用户、角色字典、全局设置，不随工作区消失）。

---

## 1. 数据保留策略（逐表）

### 1.1 类别 A：工作区私有业务数据 —— 硬删时**级联删除**

| 表 | 当前 workspace_id 外键 | 本设计要加的规则 | 理由 |
| --- | --- | --- | --- |
| `contents` | 无 | `ON DELETE CASCADE` | 工作区的核心业务数据，随工作区消失 |
| `content_variants` | 无 | `CASCADE` | 内容的分平台版本，依附内容（已有 contents FK CASCADE） |
| `content_revisions` | 无 | `CASCADE` | 版本历史（B0.2 已补 contents FK CASCADE） |
| `content_reviews` | 无 | `CASCADE` | 审核记录属于该内容的审批流程 |
| `publish_tasks` | 无 | `CASCADE` | 发布任务（已有 contents FK CASCADE） |
| `analytics` | 无 | `CASCADE` | 内容成效数据，依附内容 |
| `track_events` | 无 | `CASCADE` | 埋点事件，依附内容/工作区 |
| `media_assets` | 无 | `CASCADE`（**行**） | 素材库属于工作区；**文件**需由清理任务单独删除（见 §1.4） |
| `brand_knowledge` | 无 | `CASCADE`（行） | 知识库属于工作区；`source_url` 指向的留档文件同样要删 |
| `content_templates` | 无 | `CASCADE` | 内容模板属于工作区 |
| `social_accounts` | 无 | `CASCADE` | 平台账号绑定（含加密凭证）必须随工作区销毁——这也是合规要求。**清除后额外写审计** `workspace.purge.social_accounts_destroyed`，payload 记录销毁条数（凭证密文随行删除，不在任何日志/备份之外留存） |
| `platforms` | 无 | `CASCADE` | 工作区级的平台清单（种子数据） |
| `workspace_members` | 无 | `CASCADE` | 成员关系 |
| `notifications` | 无 | `CASCADE` | 站内通知是过程产物，无长期价值 |

> 这 14 张表就是"业务数据"，硬删时行级全清、文件级另清（§1.4）。

### 1.2 类别 B：成本 / 审计账本 —— 硬删时**保留**（不加外键，或 `SET NULL`）

| 表 | 处置 | 为什么必须保留 |
| --- | --- | --- |
| `audit_logs` | **保留**，不加 `workspace_id` 外键 | 合规留痕：谁在什么时候做了什么。工作区删除本身就是一条要留痕的事件；删了工作区就查不到历史操作，等于审计链断裂 |
| `ai_generations` | **保留**；`content_id` 已在 B0.2 改为 `SET NULL`；`workspace_id` **不加外键** | AI 调用是**已发生成本**：账单、用量分析、按租户计费都要靠它。内容可删，成本不可抹 |
| `usage_records`（B0.7 新增） | **保留**（`workspace_id` 不加外键） | 同上，配额与计费的事实来源 |
| `invoices`（B0.7 新增） | **保留** | 财务凭据，法律上需长期留存（建议 ≥ 5 年）；即使租户退租也要能出示 |
| `subscriptions`（B0.7 新增） | **保留**（标记 `canceled_at`，不删） | 订阅历史用于对账与续费纠纷 |
| `workspace_purge_batches`（B0.4 新增） | **永久保留** | 它本身就是"工作区已不存在"之后的证据：谁在何时删了哪个工作区、逐表删了多少行、保留了什么。删了它就等于毁掉清除记录 |
| `workspace_export_jobs`（B0.4 新增） | 保留到产物过期（7 天）后再由任务清理 | 导出任务要在工作区硬删后仍能下载，故**不加外键** |

**保留方式**：这些表在硬删时**不做任何删除或置空**，只写一条 `purge_batch` 标记（见 §7），用于区分"历史遗留"与"仍在使用的租户"。
查询侧按 `workspace_id` 过滤即可，成本/审计页面在租户已删除时显示"该工作区已于 X 时间删除"。

### 1.3 类别 C：全局共享数据 —— **不随工作区消失**

| 表 | 处置 | 说明 |
| --- | --- | --- |
| `users` | **保留用户本体**，只删其在该工作区的 `workspace_members` 行 | 一个用户可以属于多个工作区；删工作区不该删人。**注意**：`users.workspace_id` 是历史遗留的"归属首个工作区"字段，且带 `ON DELETE CASCADE` —— 若不动它，删工作区会连带删除用户，**必须在 B0.4 中改为 `SET NULL` 或直接废弃该列**（见 §8.4，这是本设计发现的**高危遗留**） |
| `roles` | 保留 | 全局角色字典（owner/admin/editor/reviewer/viewer） |
| `user_roles` | 保留 | 用户-角色关联（与 `workspace_members.role_codes` 双写的技术债见 `TECHDEBT-角色数据源.md`） |
| `system_settings` | 保留 | 当前是全局单例配置却带 `workspace_id`。**B0.4 不改语义**，B0.5 租户级密钥隔离时再拆分为"全局设置 + 租户覆盖" |
| `workspaces` | 硬删时**最终删除该行**（保留期结束后），删除前先把关键字段抄进 `purge_batch` 账本 | 工作区自身的元数据（名称/租户/时间）留在账本里，便于事后追溯 |
| `typeorm_migrations` | 保留 | 迁移历史 |

### 1.4 文件级数据（外键管不到）

| 位置 | 内容 | 处置 |
| --- | --- | --- |
| `uploads/media/` | 素材文件（`media_assets.stored_name`） | 硬删前按行取出文件名，逐个删除，再删行；删除前校验路径不含 `..`（防目录穿越） |
| `uploads/knowledge/` | 知识库留档（`brand_knowledge.source_url`） | 同上 |
| `uploads/tmp/` | 知识库"解析→校对"的 24 小时暂存 | 不区分租户，按 TTL 自然过期（已有 `pruneTempFiles()`） |
| 导出产物（新增） | `uploads/exports/{workspaceId}/` | 有效期 7 天后由定时任务删除（§6） |

**顺序**：先删文件 → 成功后再删行（若反过来，行没了就找不到文件名，文件成永久垃圾）。
**失败处理**：单个文件删除失败不阻断整体（记入 `purge_batch.failures`），但会在审计里留痕，供人工复核。

---

## 2. 状态机

```
        ┌──────────── restore ────────────┐
        │                                 │
   [active] ──archive──> [archived] ──delete──> [soft_deleted] ──30 天──> [purged]
        ▲                     │                      │                        │
        └───── unarchive ─────┘                      └─── restore ────────────┘
                                                     （30 天内可逆；之后拒绝）
```

| 转换 | 触发接口/能力点 | 前置条件 | 可逆性 | 审计动作 |
| --- | --- | --- | --- | --- |
| active → archived | `POST /workspaces/:id/archive`（`workspace.archive`） | 调用者是该工作区 owner；工作区处于 active | **随时可逆**（unarchive） | `workspace.archive` |
| archived → active | `POST /workspaces/:id/unarchive`（`workspace.archive`） | 同上 | 可逆 | `workspace.unarchive` |
| archived → soft_deleted | `DELETE /workspaces/:id`（`workspace.delete`） | ① 该工作区无未完成发布任务（`pending/scheduled/publishing` 计数为 0）② 无未结算账单（B0.7 前恒真）③ `confirmName` 与工作区名称一致 | **30 天内可恢复** | `workspace.soft_delete` |
| active → soft_deleted | 同上（允许跳过归档） | 同上 | 同上 | 同上 |
| soft_deleted → active | `POST /workspaces/:id/restore`（`workspace.restore`） | `now() - deleted_at ≤ 30 天` | 可逆 | `workspace.restore` |
| soft_deleted → purged | 定时任务 `WorkspacePurgeTask`（每天 04:00）或 `DELETE /workspaces/:id/data`（`workspace.purge`，需 §7 的二次确认） | ① `deleted_at ≤ now()-30d`（手工 purge 需先软删满 30 天）② 无进行中的导出任务 | **不可逆** | `workspace.purge` |

**状态存储**：`workspaces.status` 已存在。
- **现状（与代码核对）**：`WorkspaceStatus = 'active' | 'suspended'`（`workspace.entity.ts:5`），生产库 1 行且为 `active`。
- **本设计扩展为**：`active | archived | soft_deleted`；**`suspended` 废弃**（语义与 `archived` 重叠且从未使用）——迁移时把可能存在的 `suspended` 行改写为 `archived` 并写审计（当前生产库无此类行，属防御性处理）。
- 同时新增列：
- `archived_at`（timestamptz，可空）
- `deleted_at`（timestamptz，可空）——30 天保留期的计时起点
- `purge_after`（timestamptz，可空）——软删时写入 `deleted_at + 30 天`，便于索引查询

**30 天保留期实现方式**：软删写 `deleted_at`/`purge_after` → 每日 04:00 扫描 `status='soft_deleted' AND purge_after <= now()` → 走 purge 流程（§7）→ 写 `purge_batch` 账本 → 删除 `workspaces` 行。
**恢复期可配置**：设置项 **`WORKSPACE_SOFT_DELETE_RETENTION_DAYS`**（默认 30，范围 7–365，分组「工作区与租户」）。
硬删的前置校验与定时任务都**读该配置**，不写死任何天数；对外 SaaS 时按合同调整即可。

---

## 3. 接口设计

统一约定：错误用 `{ code, message, data }` 信封；409=状态冲突、400=前置条件不满足、403=权限不足、404=不存在或不可见。

| # | 接口 | 能力点 | 请求 | 成功返回 | 关键错误 |
| --- | --- | --- | --- | --- | --- |
| 1 | `DELETE /api/workspaces/:id` | `workspace.delete` | body：`{ confirmName: string }` | `200 { id, status: 'soft_deleted', deletedAt, purgeAfter, restoreDeadline }` | 400 名称不匹配 / 409 有未完成任务 / 403 非 owner / 404 工作区不存在 |
| 2 | `POST /api/workspaces/:id/archive` | `workspace.archive` | 无 body | `200 { id, status: 'archived', archivedAt }` | 409 已在归档态 / 400 已软删（需先恢复） |
| 3 | `POST /api/workspaces/:id/unarchive` | `workspace.archive` | 无 body | `200 { id, status: 'active' }` | 409 非归档态 |
| 4 | `POST /api/workspaces/:id/restore` | `workspace.restore` | 无 body | `200 { id, status: 'active' }` | 410 超过 30 天保留期（Gone，明确"不可恢复"）/ 409 非软删态 |
| 5 | `POST /api/workspaces/:id/export` | `workspace.export` | `{ includeMedia?: boolean (默认 true), includeAudit?: boolean (默认 true), note?: string }` | `202 { jobId, status: 'queued', estimatedBytes? }` | 409 已有进行中的导出 / 413 预估超过 5GB（见 §6） |
| 6 | `GET /api/workspaces/:id/export/:jobId` | `workspace.export` | — | `200 { jobId, status, progress, sizeBytes?, downloadUrl?, expiresAt?, checksum?, error? }` | 404 |
| 7 | `GET /api/workspaces/:id/export/:jobId/download` | 一次性签名令牌（见 §6.4） | query：`token` | `200` 文件流 | 401 令牌无效/过期 / 410 已过期删除 |
| 8 | `DELETE /api/workspaces/:id/data` | `workspace.purge` | body：`{ confirmName, confirmText: '永久删除', reason?: string }` | `200 { purgeBatchId, deleted: {表→行数}, filesDeleted, ledgerRetained: [...] }` | 400 确认串不对 / 409 未满 30 天 / 409 有进行中的导出 |
| 9 | `GET /api/workspaces/:id/status`（只读，便于前端展示倒计时） | `workspace.manage` | — | `200 { status, archivedAt, deletedAt, purgeAfter, daysUntilPurge }` | 404 |

**审计动作**（全部写 `audit_logs`，含操作人/时间/结果）：
`workspace.archive`、`workspace.unarchive`、`workspace.soft_delete`、`workspace.restore`、`workspace.export_requested`、`workspace.export_completed`、`workspace.export_downloaded`、`workspace.export_expired`、`workspace.purge_started`、`workspace.purge_completed`（含逐表行数）、`workspace.purge_failed`。

**DTO 校验要点**：`confirmName` 必须与 `workspaces.name` **完全一致**（前后空格 trim 后比较）；`confirmText` 固定串 `永久删除`，用于防误触；`reason` 记录合规事由（≤500 字）。

**当前工作区被软删后的行为**：该工作区的所有接口对它自己的成员返回 **404**（与 P1-2 的"非成员 404"一致，避免暴露"这个工作区存在但被删了"）；但 §3 的生命周期接口（4、6、8、9）**不受当前工作区状态限制**——它们按"目标工作区"判定权限（见 §4.2），否则用户永远无法恢复自己刚删掉的工作区。

---

## 4. 权限

### 4.1 新增能力点

| 能力点 | 默认矩阵 | 说明 |
| --- | --- | --- |
| `workspace.archive` | owner | 归档/取消归档（含 unarchive）|
| `workspace.delete` | owner | 软删（30 天内可恢复） |
| `workspace.restore` | owner | 恢复软删的工作区 |
| `workspace.export` | **owner + admin** | 导出是只读操作，允许 admin 用于交接/备份；**不包含**删除类权限 |
| `workspace.purge` | **仅 owner** | 不可逆，必须最高权限 |

放入现有可配置矩阵（`PERMISSION_MATRIX`，设置页可改），与 `CapabilityGuard` 的集成方式**无需改代码**——只需在 `capabilities.ts` 的 `Capability` 联合类型、`CAPABILITIES`、`CAPABILITY_LABELS`、`DEFAULT_PERMISSION_MATRIX` 四处登记，`@Capability('workspace.delete')` 即可生效。

### 4.2 跨工作区的权限判定（关键设计）

现有接口（`/workspaces/:id/members`）的权限是"以**当前令牌所在工作区**的角色"判定，而生命周期接口的目标是**另一个**工作区，因此必须改为：

> **目标工作区权限判定**：在服务层新增 `requireWorkspaceRole(targetWorkspaceId, userId, ['owner'])` —— 直接从 `workspace_members`（必要时回落 `user_roles`）读取该用户在**目标工作区**的角色；不满足则 403。

理由与副作用：
- 恢复/删除/导出必须由"该工作区的 owner"发起，而不是"碰巧在别的工作区是 owner 的人"；
- 这样判定后，即便调用者当前工作区已被软删（他的令牌 404），他仍能调用 restore（因为判定只看目标工作区的成员关系）；
- 现有 `workspace.manage` 的成员管理接口**保持原语义不变**（不在本次范围内改动，避免影响已验收功能）。

### 4.3 只读态（archived）的强制方式

新增 `WorkspaceStateInterceptor`（或扩展 `WorkspaceScopeInterceptor`）：当**当前工作区**状态为 `archived` 时，除 `GET/HEAD` 与 lifecycle 接口外一律 403，提示"工作区已归档，请先取消归档"。
`soft_deleted` 时：一律 404（lifecycle 接口除外）。

---

## 5. 缓存失效

复用 P1-2 的机制，但需要**按工作区维度**失效（现有 `invalidate(userId)` 是按用户维度）：

| 场景 | 失效动作 | 效果 |
| --- | --- | --- |
| 归档 / 取消归档 | ① 写库 ② `invalidateWorkspace(workspaceId)` ③ 写审计 | 所有成员**下一个请求**即被拦（无需等 30 秒 TTL） |
| 软删 / 恢复 | 同上 | 软删后成员下一个请求 404；恢复后立即恢复正常 |
| 成员被移出（已有） | `invalidate(userId)`（已有） | 该用户在该工作区的缓存立即失效 |
| 硬删（purge） | `invalidateWorkspace(workspaceId)` + 清 `workspace_members` 缓存 | 防止已删工作区仍被访问 |

**实现**：`AuthSessionService` 新增 `invalidateWorkspace(workspaceId)`，用 `SCAN MATCH auth:user:*:{workspaceId}` 批量删除（与现有 `invalidate` 同一模式，注意用 SCAN 而非 KEYS）。
**快照扩展**：`AuthSessionSnapshot` 增加 `workspaceStatus: 'active' | 'archived' | 'soft_deleted'`（由 `load()` 从 `workspaces` 表读取，与用户状态同一个查询里完成），守卫据此返回 403/404。
**多实例注意**：缓存失效是 Redis 广播式的，单实例与未来多实例都成立（依赖同一 Redis）。

---

## 6. 导出格式

### 6.1 ZIP 结构

```
mediaflow-export-{slug}-{YYYYMMDD-HHMMSS}.zip
├── manifest.json                # 元数据 + 每表行数 + 每个文件的 sha256
├── README.txt                   # 中文说明：怎么读这份导出、如何恢复
├── data/
│   ├── contents.jsonl           # 每行一条 JSON（避免一次性载入大数组）
│   ├── content_variants.jsonl
│   ├── content_reviews.jsonl
│   ├── publish_tasks.jsonl
│   ├── brand_knowledge.jsonl
│   ├── content_templates.jsonl
│   ├── media_assets.jsonl       # 文件元数据（不含二进制）
│   ├── social_accounts.jsonl    # 凭证字段**脱敏**（只导 provider/账号标识，不导密文）
│   └── analytics.jsonl
├── media/                       # 素材二进制（includeMedia=true 时）
│   └── {storedName}
├── knowledge/                   # 知识库留档文件
│   └── {storedName}
└── audit/
    └── audit_logs.jsonl         # includeAudit=true 时；按时间升序
```

### 6.2 manifest.json 字段

```json
{
  "exportVersion": 1,
  "exportedAt": "2026-09-19T11:00:00+08:00",
  "workspace": { "id": "…", "name": "…", "slug": "…", "tenantId": "…", "createdAt": "…" },
  "requestedBy": { "id": "…", "email": "…" },
  "counts": { "contents": 1, "content_variants": 2, "audit_logs": 2854, "media_files": 0 },
  "files": [ { "path": "media/xxx.png", "bytes": 12345, "sha256": "…" } ],
  "checksum": "sha256 of data/*.jsonl 汇总清单"
}
```
校验和覆盖范围：每个 `data/*.jsonl` 与每个 `media/*` 文件的 sha256（写入 manifest），以及一个整体 checksum 便于快速比对。

### 6.3 限制

| 项 | 规则 |
| --- | --- |
| 单次导出大小 | **预估 ≤ 5GB**；超过则 413 并提示"请关闭 includeMedia 后重试"（`includeMedia=false` 只导元数据） |
| 并发 | 同一工作区**同时只允许 1 个导出任务**（用 Redis 锁 `workspace:export:lock:{id}` + 数据库任务表双重校验） |
| 超时 | 单次导出任务上限 30 分钟；超时置 `failed` 并释放锁 |
| 内存 | 逐表流式写入（`jsonl` 逐行 push 到 ZIP），不整表载入内存 |
| 有效期 | 产物 **7 天**后由每日任务删除（并写 `workspace.export_expired` 审计） |
| 落盘位置 | `uploads/exports/{workspaceId}/{jobId}.zip`（目录 700） |

### 6.4 下载鉴权

下载链接带**一次性签名令牌**：`HMAC(workspaceId + jobId + exp, SETTINGS_ENCRYPTION_KEY 派生的签名密钥)`，有效期 15 分钟，用完不失效但受 7 天产物有效期约束；
下载动作写 `workspace.export_downloaded` 审计（含 IP/UA）。**不暴露静态目录**，由 API 流式返回（避免 nginx 直读绕过鉴权）。

### 6.5 任务表（新增）

```sql
CREATE TABLE workspace_export_jobs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL, workspace_id uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
  status varchar(16) NOT NULL,            -- queued|running|completed|failed|expired
  requested_by uuid, include_media boolean NOT NULL DEFAULT true, include_audit boolean NOT NULL DEFAULT true,
  file_path varchar(512), size_bytes bigint, checksum varchar(128),
  progress int NOT NULL DEFAULT 0, error_message text,
  expires_at timestamptz
);
```
（`workspace_id` **不加外键**：导出任务的产物要在工作区硬删后仍可下载至有效期结束。）

---

## 7. 硬删（不可逆）的确认与留痕

### 7.1 前置校验（任一不满足即拒绝）

1. 工作区处于 `soft_deleted` 且 `now() - deleted_at ≥ 30 天`（手工 purge 同样要求先软删满期）；
2. 无进行中的导出任务（`workspace_export_jobs.status IN ('queued','running')` = 0）；
3. 无未完成的发布任务（防御性检查：软删时已校验，硬删前再查一次）；
4. 二次确认全部通过：`confirmName` = 工作区名称；`confirmText` = `永久删除`。

### 7.2 执行顺序（每一步都留痕）

1. **独立备份（purge 的硬前置：备份失败即中止，绝不先删后备份）**
   - 位置：`/www/backup/mediaflow/purge/{workspaceId}/{YYYYMMDD-HHMMSS}.sql.gz`
   - 内容：按表 `WHERE workspace_id = …` 逐表导出 + 该工作区的 `workspace_members`/`workspaces` 行 + 账本表全量
   - 命名含校验和：`{workspaceId}-{ts}-{sha256 前 12 位}.sql.gz`，并把完整 sha256 写入 `workspace_purge_batches.backup_sha256`
   - 权限 600；**保留 180 天**（配置项 `WORKSPACE_PURGE_BACKUP_RETENTION_DAYS`，默认 180）
   - **异地要求**：备份**不得与数据库同机存放**。当前服务器无独立对象存储，属技术债（见 `docs/TECHDEBT-purge备份异地.md`）；
     有异地存储后改为先上传校验、再删本地。清理任务在 180 天后删除本地备份并写审计 `workspace.purge_backup_expired`
   - 失败处理：备份命令非 0 退出 / `gzip -t` 校验失败 / 磁盘空间不足 → **purge 立即中止**，工作区保持 soft_deleted，写审计 `workspace.purge_failed`
2. 写 `purge_batch` 账本行（见 §7.3），状态 `started`；
3. 删除文件（media/knowledge，按 §1.4）；
4. 在**单个事务**内按 §1.1 顺序删除业务表行（`workspace_members` → `notifications` → `platforms`/`social_accounts` → `analytics`/`track_events` → `publish_tasks`/`content_reviews` → `content_revisions`/`content_variants`/`contents` → `media_assets`/`brand_knowledge`/`content_templates`）；
5. 删除 `workspaces` 行；
6. 更新账本 `completed` + 逐表行数 + 文件数 + 失败清单；
7. 写审计 `workspace.purge_completed`；`invalidateWorkspace()`；通知所有原成员（若他们还有其他工作区，站内通知即可）。

### 7.3 账本表（新增，永久保留）

```sql
CREATE TABLE workspace_purge_batches (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL, tenant_id uuid NOT NULL,
  workspace_name varchar(100) NOT NULL, workspace_slug varchar(50) NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
  status varchar(16) NOT NULL,                 -- started|completed|failed
  reason text, requested_by uuid, requested_by_name varchar(80),
  deleted_rows jsonb NOT NULL DEFAULT '{}',    -- {"contents":1,"content_variants":2,...}
  deleted_files int NOT NULL DEFAULT 0, failures jsonb NOT NULL DEFAULT '[]',
  backup_path varchar(512), backup_expires_at timestamptz,
  ledger_retained jsonb NOT NULL DEFAULT '[]'  -- ["audit_logs","ai_generations",...]
);
```
（同样**不加外键**——它本身是"工作区已不存在"之后的证据。）

---

## 8. 迁移方案

### 8.1 外键迁移（14 张业务表 + 2 张新表）

| 顺序 | 迁移 | 内容 | `ON DELETE` |
| --- | --- | --- | --- |
| M1 | `WorkspaceArchiveFields` | `workspaces` 加 `archived_at`/`deleted_at`/`purge_after` 三列（可空）+ 索引 `(status, purge_after)` | — |
| M2 | `WorkspaceExportJobs` | 建 `workspace_export_jobs` 表 | — |
| M3 | `WorkspacePurgeBatches` | 建 `workspace_purge_batches` 表 | — |
| M4 | `WorkspaceFkContent` | `contents`、`content_variants`、`content_revisions`、`content_reviews` 的 `workspace_id → workspaces(id)` | CASCADE |
| M5 | `WorkspaceFkPublishAnalytics` | `publish_tasks`、`analytics`、`track_events` | CASCADE |
| M6 | `WorkspaceFkAssetsKnowledge` | `media_assets`、`brand_knowledge`、`content_templates` | CASCADE |
| M7 | `WorkspaceFkMembersPlatform` | `workspace_members`、`notifications`、`platforms`、`social_accounts` | CASCADE |
| M8 | `UsersWorkspaceLegacyFix` | **`users.workspace_id` 的 CASCADE → SET NULL**（高危遗留，见 §8.4） | SET NULL |

每张迁移都有 `down()`：
- M1：`DROP COLUMN IF EXISTS …`
- M2/M3：`DROP TABLE IF EXISTS …`
- M4–M7：`ALTER TABLE … DROP CONSTRAINT IF EXISTS …`
- M8：重建原 CASCADE 约束

### 8.2 孤儿回填/清理（加外键前的硬性前置）

当前生产库只有 1 个工作区、无孤儿，但迁移仍必须**自证干净**（换台机器部署也要成立）：每个迁移开头执行
```sql
SELECT count(*) FROM <表> t WHERE NOT EXISTS (SELECT 1 FROM workspaces w WHERE w.id = t.workspace_id);
```
- 若为 0 → 直接建约束；
- 若 > 0 → **不静默删除**，而是把孤儿行的 `workspace_id` 指向该租户下最早的工作区（回填），并写审计 `data.backfill.workspace_id`；只有无法回填（租户下无工作区）时才删除（并写审计）。

理由：回填保住数据，删除是最后手段；两者都比"迁移失败"好。

### 8.3 迁移顺序与部署顺序

**先加列/建表（M1–M3，可逆、无风险）→ 部署新版代码（生命周期接口可用）→ 再加外键（M4–M8）**。
理由：外键一旦加上，旧代码的删除路径会变成级联删除（行为变化）；先把新代码部署上去，让删除路径都走新流程，再加约束兜底。

### 8.4 高危遗留：`users.workspace_id ON DELETE CASCADE`

现状：`users.workspace_id → workspaces(id) ON DELETE CASCADE`（见 `INVENTORY-生产配置.md` 的 FK 清单）。
含义：**删除一个工作区会连带删除"归属它"的用户行**。在引入工作区删除之前，这个约束永远不会触发；一旦引入，就会变成"删工作区把人也删了"。
处置：M8 改为 `SET NULL`（用户保留，`workspace_id` 置空表示"无默认工作区"），成员关系完全由 `workspace_members` 表达。
**这是一条必须在 B0.4 里修的高危项**——它比外键缺失更危险。

### 8.5 需要同时补的现有表缺口

- `content_revisions` / `ai_generations` 的 `content_id` 外键已在 B0.2 补齐 ✅
- `contents.deleted_at`（软删）已有 ✅；`content_variants` 的软删在 `VariantSoftDelete` 迁移里已有 ✅
- `media_assets.brand_knowledge` 等交叉引用不在本次范围

---

## 9. 测试计划

所有用例沿用现有 E2E 测试骨架（`test/support/e2e-harness.ts`：独立队列/独立流/前缀清理），并为本次新增"临时工作区"工厂（创建 → 用完硬删）。

| # | 场景 | 断言要点 |
| --- | --- | --- |
| 1 | 归档后成员访问 | 归档工作区的成员：GET 200 但 POST/PUT/DELETE **403**；unarchive 后恢复可写 |
| 2 | 软删后成员访问 | 软删工作区成员的下一个请求 → **404**（未过期令牌，不依赖 TTL）；缓存 key 已被删除 |
| 3 | 30 天内 restore | 恢复后数据**完整**（内容数、素材数、知识库数、成员数逐项比对软删前快照） |
| 4 | 超期 restore | `deleted_at = now()-31d` 的工作区 restore → **410**，且提示不可恢复 |
| 5 | purge 前置校验 | 未软删/未满 30 天 → 409；`confirmName` 错误 → 400；有进行中导出 → 409 |
| 6 | purge 执行 | 业务表行数归零（逐表断言）；`audit_logs`/`ai_generations`/`usage_records`/`invoices` **行数不变**；`workspace_purge_batches` 有 `completed` 记录含逐表行数；文件目录清空；`workspaces` 行消失 |
| 7 | purge 有备份 | `backup_path` 指向的文件存在、`gzip -t` 通过、内容含该工作区数据（抽样 `zcat | grep`） |
| 8 | 导出内容完整 | ZIP 可解压；`manifest.json` 各表行数 = 数据库实际行数；每个文件 sha256 与 manifest 一致；`social_accounts.jsonl` **不含密文** |
| 9 | 导出限制 | 第二个并发导出 → 409；`includeMedia=false` 时无 `media/` 目录；过期产物 → 410 |
| 10 | 下载鉴权 | 无令牌/错误令牌 → 401；过期令牌 → 401；正确令牌 → 200 且 sha256 与 manifest 一致 |
| 11 | 跨工作区隔离 | A 区 owner 对 B 区执行 archive/delete/export/purge → **403**（`requireWorkspaceRole` 生效）；A 区 owner 不能读 B 区导出任务 |
| 12 | 定时任务 | 把 `purge_after` 设为过去 → 手动触发 `WorkspacePurgeTask` → 该工作区被清理、其他工作区不受影响 |
| 13 | 外键行为 | 硬删一个工作区后：14 张业务表对应行数为 0；`users` 行仍在且 `workspace_id` 为 NULL（验证 M8） |
| 14 | 迁移回滚 | 逐个 `migrate:revert` 后约束/列/表被正确移除，再前滚恢复（与 B0.2 同样的做法） |

覆盖目标：新增 **约 20-24 个 E2E 用例** + 单元测试（状态机分支、导出 manifest 生成、purge 前置校验各 3-5 例）。

---

## 10. 风险与不做项

### 10.1 本次不做（明确边界）

| 不做项 | 为什么 | 何时 |
| --- | --- | --- |
| 跨工作区数据迁移/复制 | 与"删除"是两套语义，且涉及冲突合并策略 | B1 或按需 |
| 工作区合并 | 同上，且需要去重规则 | 阶段 C |
| 计费/账单校验（`invoices` 未结算检查） | 计费表在 B0.7 才建 | B0.7 后追加该前置校验 |
| 数据导出到对象存储（S3/MinIO） | 当前 8 核 8G、导出 ≤5GB 落本地盘够用 | 阶段 C（多租户放量时） |
| 物理删除备份（90 天保留自动清理） | 需要一个独立的备份保留任务 | B0.9/B1 |
| 租户级密钥隔离（provider_configs 按租户） | 属 B0.5 | B0.5 |
| 归档态下"只读但可导出"的细分策略 | 先统一 403（写操作全禁），导出属 lifecycle 接口不受影响 | 按反馈 |

### 10.2 已知风险与缓解

| 风险 | 影响 | 缓解 |
| --- | --- | --- |
| **误删**（不可逆） | 数据永久丢失 | ①必须先软删满 30 天才能 purge ②二次确认（工作区名称 + 固定串）③purge 前自动独立 `pg_dump`（90 天）④账本留痕 |
| 外键 CASCADE 让"删工作区=删一切" | 一次误操作放大 | 先上代码路径（软删/恢复），后加约束；CASCADE 只作用于"已确认要删"的 purge 事务 |
| 大工作区导出超时/爆盘 | 导出失败、磁盘告警 | ≤5GB 上限、`includeMedia=false` 兜底、30 分钟超时、产物 7 天自动清理、导出前检查磁盘可用空间（预留 2× 预估大小） |
| 删文件成功但删行失败（或反之） | 数据不一致 | 顺序固定（先文件后行）；失败清单进账本；提供 `--dry-run` 式的"预估清理"接口（`GET /status` 已含预估行数） |
| `users.workspace_id` 遗留 CASCADE | 删工作区连带删用户 | **M8 必须与 purge 同时或更早上线**；测试用例 13 专门验证 |
| 导出含敏感数据（平台凭证） | 泄露 | `social_accounts.jsonl` 只导标识不导密文；下载走一次性签名令牌 + 审计；产物目录 700 |
| 恢复后缓存脏读 | 恢复后仍 404 | restore 时 `invalidateWorkspace()`；测试用例 3 验证"恢复后立即可用" |
| 多实例并发 purge 同一工作区 | 重复删除/报错 | purge 用数据库行锁（`SELECT … FOR UPDATE`）+ Redis 锁 `workspace:purge:lock:{id}` |

### 10.3 与后续阶段的依赖

- **B0.5（租户级密钥隔离）**：purge 需删除 `social_accounts` 里的密文（本设计已含）；B0.5 的按租户密钥表也要在 purge 时清理。
- **B0.7（计费）**：新增 `subscriptions/invoices/usage_records` 后，purge 的前置校验要加"无未结算账单"，且这三张表进入 §1.2 的保留清单（本设计已预留）。
- **B0.9（CI/CD）**：purge 的独立备份需要纳入备份策略与磁盘监控（`MONITOR_DISK_USED_PERCENT`）。
- **B1（真机联调）**：不依赖本设计，可并行。

---

## 11. 实施步骤建议（确认后按此分步，每步一个交付报告）

| 步 | 内容 | 可回滚性 |
| --- | --- | --- |
| 1 | M1–M3 迁移（加列/建表）+ 状态机与缓存失效代码 + 单元测试 | 完全可逆（无数据删除） |
| 2 | 归档/取消归档/软删/恢复四个接口 + E2E（用例 1–4、13 的一部分） | 可逆（不删数据） |
| 3 | 导出（任务表 + jszip + 签名下载 + 限制）+ E2E（用例 8–11） | 可逆（只增不删） |
| 4 | purge（备份 → 删文件 → 删行 → 账本）+ E2E（用例 5–7、12–14）**在临时工作区上演练** | 不可逆，但只在演练用工作区上执行 |
| 5 | M4–M8 外键迁移（最后做） | 可逆（DROP CONSTRAINT） |
| 6 | 文档与运维：RUNBOOK、备份保留、监控项 | — |

**每步之间都会停下来报告**；第 4 步（purge）会先用一个临时创建的"演练工作区"完整跑一遍，再考虑对真实数据启用。

---

## 12. 补充要求与实施进度（2026-09-19 用户决策后修订）

### 12.1 演练工作区（补充 2）

purge 是唯一不可逆的操作，**必须先在演练工作区上跑通**，再考虑对真实数据启用：

| 步骤 | 内容 |
| --- | --- |
| 1 | 创建演练工作区：`POST /api/workspaces`，名称带前缀 `演练-purge-{时间戳}`（独立的 `workspace_id`，与生产数据物理隔离在同一库的不同租户行） |
| 2 | 灌入测试数据：内容 + 变体 + 修订 + 审核 + 发布任务 + 素材 + 知识库 + 成员（用固定前缀，便于核对） |
| 3 | 归档 → 验证只读 → 取消归档 |
| 4 | 软删 → 验证成员 404、缓存失效 |
| 5 | 恢复 → 逐项核对数据完整（与软删前快照一致） |
| 6 | 再次软删；演练实例把 `WORKSPACE_SOFT_DELETE_RETENTION_DAYS` 临时设为 **1 天**（**只在演练进程/演练实例生效，不写生产配置**） |
| 7 | 触发 `WorkspacePurgeTask` → purge → 逐表核对行数归零、账本保留、`users` 行仍在且 `workspace_id` 为 NULL |
| 8 | 清理：删除演练工作区的 purge 备份、导出产物、临时配置；核对生产表基线未变 |

完整操作步骤见 **`docs/RUNBOOK-purge演练.md`**。

### 12.2 跨租户越权测试（补充 3，必须覆盖）

| # | 场景 | 期望 |
| --- | --- | --- |
| 15 | A 区 owner 调 `DELETE /api/workspaces/{B_id}` | **403**（目标工作区角色判定：他不是 B 的 owner） |
| 16 | A 区 owner 调 `POST /api/workspaces/{B_id}/restore` | **403** |
| 17 | A 区 owner 调 `POST /api/workspaces/{B_id}/export` | **403** |
| 18 | 当前工作区被软删后，其 owner 调 `POST /api/workspaces/{自己}/restore` | **200**（生命周期接口豁免状态闸门 + 目标工作区角色判定） |
| 19 | purge 某工作区后，原成员仍能登录、并能访问其所在的其他工作区 | **200**（验证 M8：用户未被连带删除） |

### 12.3 导出限流（补充 4）

- 同一工作区**同时只允许 1 个导出任务**，重复请求返回 **409**（Redis 锁 + 数据库二次校验）；
- 产物 **7 天**后自动清理，删除前写审计 `workspace.export_expired`；
- 一次性签名下载链接 **15 分钟**有效，过期拒绝（401）；
- 单次导出 ≤5GB，超限 413；`includeMedia=false` 可只导元数据。

### 12.4 第 1 步实施记录（已完成）

| 交付 | 内容 |
| --- | --- |
| 迁移 M1 | `1789701100000-WorkspaceArchiveFields.ts`：`workspaces` 增 `archived_at`/`deleted_at`/`purge_after` + 复合索引 `(status, purge_after)`；历史 `suspended` → `archived` 并写审计 |
| 迁移 M2 | `1789701200000-WorkspaceExportJobs.ts`：`workspace_export_jobs`（17 列，无外键） |
| 迁移 M3 | `1789701300000-WorkspacePurgeBatches.ts`：`workspace_purge_batches`（20 列，含 `backup_sha256`/`social_accounts_destroyed`，无外键） |
| 状态机 | `WorkspaceStatus = 'active' \| 'archived' \| 'soft_deleted'`（`suspended` 废弃）；实体新增三个时间列 |
| 配置 | 新设置分组「工作区与租户」：`WORKSPACE_SOFT_DELETE_RETENTION_DAYS`(30, 7–365)、`WORKSPACE_PURGE_BACKUP_RETENTION_DAYS`(180, 30–3650)，均进入 `runtime().workspace` |
| 能力点 | 新增 5 个：`workspace.archive/delete/restore`（owner）、`workspace.export`（owner+admin）、`workspace.purge`（owner） |
| 缓存失效 | `AuthSessionService.invalidateWorkspace(workspaceId)`（SCAN `auth:user:*:{workspaceId}`）+ 快照新增 `workspaceStatus` |
| 状态闸门 | 守卫：软删 → 404、归档 → 写 403 / 读放行；`@WorkspaceLifecycle()` 标记的接口豁免（否则无法恢复自己的工作区）；**修正了守卫 catch 吞掉 403 的缺陷** |
| 测试 | 单元 257 通过（新增 11：能力点矩阵、保留期配置、快照状态、按工作区失效、守卫 5 例）；3 个迁移实测「应用 → 逐个回滚 → 重放」 |
