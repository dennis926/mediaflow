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
