# RUNBOOK：工作区 purge 演练（B0.4 第 4 步）

> 目的：在**不碰生产数据**的前提下，把"归档 → 软删 → 恢复 → 软删 → 到期 → 永久清除"全流程跑一遍，
> 验证行级/文件级清理、账本保留、用户不被连带删除。
>
> 铁律：**只在演练工作区上执行**；演练结束必须清理演练工作区、purge 备份、导出产物与临时配置。

## 一、演练环境

| 项 | 要求 |
| --- | --- |
| 工作区 | 新建，名称前缀 `演练-purge-{时间戳}`，独立 `workspace_id` |
| 保留期配置 | 演练实例把 `WORKSPACE_SOFT_DELETE_RETENTION_DAYS` 设为 **1**（用 `MEDIAFLOW_SETTING_OVERRIDE_WORKSPACE_SOFT_DELETE_RETENTION_DAYS=1` 进程级覆盖，**不写生产配置**） |
| 备份保留期 | 演练可临时设 `WORKSPACE_PURGE_BACKUP_RETENTION_DAYS=1`，便于验证过期清理 |
| 数据隔离 | 演练数据一律带固定前缀，便于按前缀核对与清理 |
| 记录 | 每一步的"预期 / 实际"写入演练报告 |

## 二、演练步骤（14 步）

| # | 步骤 | 预期结果 |
| --- | --- | --- |
| 1 | 创建演练工作区，邀请 1 个测试账号（editor） | 工作区 `status=active`；成员可见 |
| 2 | 灌入数据：内容 1 + 变体 2 + 修订 1 + 审核 1 + 发布任务 1 + 素材 1 + 知识库 1 | 各表行数 = 预期（记录基线快照） |
| 3 | 归档 `POST /workspaces/:id/archive` | `status=archived`、`archived_at` 有值；成员 **GET 200 / POST 403**；审计 `workspace.archive` |
| 4 | 取消归档 `POST /workspaces/:id/unarchive` | 恢复 `active`；成员写操作恢复 |
| 5 | 软删 `DELETE /workspaces/:id`（`confirmName` 正确） | `status=soft_deleted`、`deleted_at`/`purge_after` 有值（= deleted_at + 1 天）；成员下一个请求 **404**；缓存 key 被清空的证据；审计 `workspace.soft_delete` |
| 6 | 软删校验：`confirmName` 故意写错 | **400**，状态不变 |
| 7 | 数据完整性：软删后直接查库 | 业务表行数**未变**（软删只改状态） |
| 8 | 恢复 `POST /workspaces/:id/restore` | `status=active`；成员立即可用（缓存已失效）；逐项比对步骤 2 的快照 → 一致 |
| 9 | 再次软删；把演练实例的保留期设为 1 天；等待（或直接改 `purge_after` 为过去） | 扫描条件成立 |
| 10 | 超期恢复演练：让 `purge_after` 过期后再调 restore | **410**（不可恢复），状态不变 |
| 11 | 触发 purge（定时任务或 `DELETE /workspaces/:id/data` + 二次确认） | 先出备份；备份成功才继续 |
| 12 | purge 结果核对 | 14 张业务表该工作区行数 **= 0**；`audit_logs`/`ai_generations` **行数不变**；`workspaces` 行消失；`workspace_purge_batches` 有 `completed` 记录（含逐表行数、`backup_sha256`、`social_accounts_destroyed`）；审计 `workspace.purge_completed` + `workspace.purge.social_accounts_destroyed` |
| 13 | 用户不被连带删除（M8 关键验证） | 测试账号**仍能登录**、仍能访问其所在的其他工作区；`users.workspace_id` 为 **NULL** |
| 14 | 清理 | 删除演练工作区的 purge 备份与导出产物；核对生产基线（内容 1 / 用户 2 / 发布任务 0）未变 |

## 三、异常路径演练（同样必做）

| 场景 | 制造方式 | 预期 |
| --- | --- | --- |
| 备份失败 | 把备份目录设为只读 / 故意写错备份命令 | **purge 中止**，工作区仍为 `soft_deleted`，写 `workspace.purge_failed` |
| 有进行中的导出 | 先发起一个导出任务不完成 | purge → **409** |
| 未满保留期 | 手工调 `DELETE …/data` | **409**（提示剩余天数） |
| 二次确认错误 | `confirmText` 写成别的 | **400** |
| 跨租户越权 | 用 A 区 owner 令牌操作 B 区 | **403** |
| 重复 purge | 对同一工作区再执行一次 | **404/409**，不产生第二条账本记录 |

## 四、演练产物与收尾

1. 演练报告：每步"预期 / 实际 / 证据（SQL 输出或接口响应）"，归档到 `docs/AUDIT-B0.4-purge演练-{日期}.md`；
2. 备份文件：验证 `gzip -t` 通过、抽样 `zgrep` 能查到该工作区数据，然后按演练配置删除；
3. 核对生产基线未变（内容/用户/工作区/发布任务/通知）；
4. 演练实例的临时配置**不得**写入生产 `.env` 或数据库设置。

## 五、与生产的差异声明

演练使用 1 天保留期与进程级配置覆盖；生产为 30 天且配置来自数据库。
**演练通过 ≠ 可以直接对生产数据 purge**：真实工作区 purge 仍需用户逐次确认，且遵守 `DESIGN-多租户生命周期.md` §7 的全部前置校验。

## 六、演练实测补充（2026-09-21）

### 6.1 备份是"仅数据"，恢复必须先建表结构（重要）

`backupWorkspace()` 生成的是 **data-only** 备份：每张表一段
`COPY "表名" (列…) FROM STDIN WITH CSV HEADER;` + CSV + `\.`，外层 gzip。
**它不含建表语句**，因此恢复时必须先把 schema 准备好，否则 psql 会报
`relation "contents" does not exist` 而**静默恢复 0 行**（本轮演练第一次就是这么失败的）。

正确恢复步骤：
```bash
# ① 先建表结构（用生产库的 schema-only 导出，或对空库跑 pnpm migrate）
pg_dump -h 127.0.0.1 -U mediaflow -d mediaflow --schema-only --no-owner --no-privileges \
  -t contents -t content_variants -t content_revisions -t content_reviews -t publish_tasks \
  -t brand_knowledge -t content_templates -t media_assets -t social_accounts -t platforms \
  -t notifications -t analytics -t track_events -t workspace_members -t workspaces \
  | psql -X -q -h 127.0.0.1 -U mediaflow -d <恢复目标库>

# ② 再重放数据
gunzip -c <备份文件> | psql -X -q -h 127.0.0.1 -U mediaflow -d <恢复目标库>

# ③ 校验行数（应与清除前一致）
psql -h 127.0.0.1 -U mediaflow -d <恢复目标库> -c "SELECT count(*) FROM contents WHERE workspace_id='<原工作区 id>'"
```

### 6.2 保留期最小值是 7 天

配置项 `WORKSPACE_SOFT_DELETE_RETENTION_DAYS` 允许范围 **7–365 天**（设计如此）。
演练时把实例配置设为 1 会被夹到 7 天——这本身是正确的，**模拟"保留期结束"请改写 `purge_after`**：
```sql
UPDATE workspaces SET purge_after = now() - interval '1 hour', deleted_at = now() - interval '2 days' WHERE id = '<演练工作区>';
```

### 6.3 清除完成通报只走外部渠道

purge 完成后**不写站内通知**（只走邮件/群机器人，若已配置）。原因：站内通知属于 A 类业务数据，
而通知产生时工作区已经不存在，写下去会落进一个刚被清除的工作区里（实测导致"A 类表清空后仍残留 1 条通知"）。
责任人留痕由 `workspace_purge_batches` 账本 + `workspace.purge_*` 审计承担。

### 6.4 备份的独立校验清单（每次 purge 前后都应核对）

| 检查项 | 期望 | 取值方式 |
| --- | --- | --- |
| 文件存在与权限 | 存在且 600 | `stat -c '%A %n' <备份>` |
| 压缩完整 | `gzip -t` 退出码 0 | `gzip -t <备份>` |
| 校验和一致 | 与账本 `backup_sha256` 相同 | `sha256sum <备份>` vs `SELECT backup_sha256 FROM workspace_purge_batches WHERE …` |
| 内容确含该工作区 | `zgrep` 命中工作区 id | `zgrep -c "<workspace_id>" <备份>` |
| 可恢复 | 建表结构后重放，行数与清除前一致 | 见 6.1 |
| 保留期 | 默认 180 天（`WORKSPACE_PURGE_BACKUP_RETENTION_DAYS`） | 账本 `backup_expires_at` |

### 6.5 备份表顺序：恢复顺序与删除顺序**相反**（2026-09-21 实测踩坑）

- **删除**必须"子表先删"（`track_events → … → contents`），否则外键挡着删不掉；
- **备份/恢复**必须"父表先插"（`workspaces → contents → 子表 → 其余`），否则 `content_variants.content_id` 找不到父行 → 外键冲突 → **整个事务回滚、恢复 0 行**。
两套顺序都在 `workspace-purge.service.ts` 里各有清单（`BUSINESS_TABLES` / `BACKUP_TABLES`），并有单测防回归。改动任何一处都要同时想清楚另一处。

### 6.6 演练发现的运维细节

1. **消费者残留与预检自锁**：`XINFO CONSUMERS` 里的记录会随进程退出残留（pending=0 无害），应用启动时自行清理；
   若预检把残留也算作"并发消费者"，就会拦住"重启"这个清理手段。预检现按"在跑的消费者"（pending>0 或 idle<120s）判定。
2. **演练必须用独立实例 + 独立备份目录**：`PURGE_BACKUP_ROOT` 可指向临时目录（演练已清理时更省事），保留期用进程级覆盖，
   生产配置不受影响（演练后核对 `system_settings` 中无该键、`.env` 未变）。
3. **killed 进程会留下挂起命令**：演练脚本里所有 psql/pg_dump 都要带 `-w`（不提示口令）+ `PGPASSWORD` 环境变量（**流水线两侧都要带**，
   否则 `pg_dump` 会等口令而卡死）。
4. **建库/删库用应用角色即可**：给 `mediaflow` 角色 `CREATEDB` 权限后无需 `su postgres`（后者在非交互环境容易挂起）。

## 7. 运维铁律（B0.4 第 5 步确立）

### 7.1 禁止绕过 API 直接删 `workspaces` 行

```sql
-- ❌ 绝对不要这样删工作区：
DELETE FROM workspaces WHERE id = '<工作区 id>';
```

即使外键已经是 `ON DELETE CASCADE`，直接删父行依然会带来三个后果：

1. **静默销毁平台授权凭据**（`social_accounts` 随级联消失），且**不写审计**——purge 路径会写
   `workspace.purge.social_accounts_destroyed` 与清除账本，直接删不会；
2. **留下孤儿素材文件**：`media_assets` 行会被级联删除，但磁盘上的文件不由外键删除（purge 会逐文件清理）；
3. **留下孤儿队列消息**：`publish_tasks` 行没了，Redis 流里针对它们的消息还在（purge 会在同一流程清理）。

**正确做法**：`DELETE /api/workspaces/:id/data`（owner + 名称与固定串二次确认），或按本文档第 1–6 步演练流程操作。

### 7.2 删除顺序不要依赖数据库的级联顺序

purge 内部按"子表先删"的显式顺序执行（`social_accounts` 在 `platforms` 之前），这是**刻意**的：
`social_accounts.platform_id → platforms(id) ON DELETE RESTRICT`，若先删平台字典会被 RESTRICT 拦住。
数据库自身的级联顺序是"实现相关"的（实测 PostgreSQL 在本库的形态下会先处理引用侧，10/10 成功），
但**不要把正确性建立在它上面**——改动删除流程时保持显式顺序。

### 7.3 工作区被永久清除后，产物仍可取回（7 天有效期内）

清除**不会**删除导出任务行与产物文件：`workspace_export_jobs.workspace_id` 会被外键置空（`NULL`），
任务与产物原样保留到 `expires_at`。取回方式：

1. **清除前已发出的链接**：15 分钟内仍可用（一次性）；
2. **清除后重新申请**（推荐，给"关停前忘了下载"的场景兜底）：
   ```bash
   # 用**原申请人本人**的登录令牌（其他人会收到 403），路径里的工作区 id 用被清除的那个
   curl -s -X POST "$BASE/api/workspaces/<被清除的工作区 id>/export/<任务 id>/link"         -H "Authorization: Bearer <原申请人令牌>" -H 'Content-Type: application/json' -d '{}'
   # 返回的 url 15 分钟内有效且只能使用一次
   curl -sO "$BASE<返回的 url>"
   ```
   该动作会写审计 `workspace.export.link_issued_after_purge`（含被清除的工作区 id 与申请人）。
3. 产物过期后（默认 7 天）由 04:00 的清理任务删除文件，并**连行一起删除**（这类行已无归属，留着只会堆积）。
   账本与审计保留取证：`workspace_purge_batches.retained_export_jobs` 记录了清除时保留了多少个导出任务。

**注意**：取回仅限"原申请人本人"，非申请人一律 403 —— 清除后的产物不会变成公开资源。
