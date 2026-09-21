# B0.4 验收报告：多租户生命周期（归档 → 软删 → 恢复 → 永久清除 → 导出）

- 验收日期：2026-09-21
- 范围：B0.4 全部 6 个步骤（设计 → 字段与状态机 → M8 高风险修复与 4 个生命周期端点 → 导出与最后工作区软保护 → 永久清除与演练 → 外键补全与文档收尾）
- 生产：`/www/wwwroot/mediaflow`（`https://auto.liangyijianye.cn/`），健康 200
- 相关文档：`DESIGN-多租户生命周期.md`（~643 行）、`DESIGN-外键补全-第5步.md`（185 行）、`DESIGN-工作区管理UI.md`、`RUNBOOK-purge演练.md`、`RUNBOOK-部署与回滚.md` §4.4.0、`TECHDEBT-E2E隔离.md` §8、`TECHDEBT-purge备份异地.md`

## 一、交付物清单

| # | 交付物 | 位置 |
| --- | --- | --- |
| 1 | 生命周期设计（三分类保留策略、状态机、9 个接口、M1–M8 迁移、演练计划） | `docs/DESIGN-多租户生命周期.md` |
| 2 | 迁移 M1/M2/M3：`workspaces` 归档字段、`workspace_export_jobs`、`workspace_purge_batches` | `apps/api/src/database/migrations/1789701100000…1789701300000` |
| 3 | 迁移 M8：`users.workspace_id` CASCADE → **SET NULL**（高危遗留修复） | `1789701400000-UsersWorkspaceSetNull.ts` |
| 4 | 4 个生命周期端点：`archive` / `unarchive` / `DELETE :id`（软删）/ `restore` + `GET :id/status` | `apps/api/src/modules/workspace/workspace.controller.ts` |
| 5 | 权限与状态闸门：`@WorkspaceLifecycle()` 豁免、按**目标工作区**判权、5 个能力点 | `auth/workspace-lifecycle.decorator.ts`、`auth/capabilities.ts` |
| 6 | 数据导出：ZIP 流水线、`manifest.json`（逐文件 sha256）、11 张表 jsonl、5GB 上限、1 并发、7 天产物、15 分钟一次性链接 | `workspace/workspace-export.service.ts`、`workspace-export.task.ts` |
| 7 | 永久清除：独立备份（父表在前、可重放）、单事务删行、账本、审计、外部通报、备份失败即中止 | `workspace/workspace-purge.service.ts`、`workspace-purge.task.ts` |
| 8 | 租户级能力点接口 `GET /api/auth/capabilities`（只读自己）+ 软删态"逃生"豁免 | `auth/auth.controller.ts`、`auth/auth.service.ts` |
| 9 | 前端工作区管理 UI（状态卡片、恢复倒计时、导出面板、两个确认框、能力点驱动按钮）+ jsdom 20 条 | `apps/web/src/components/workspace/`、`app/(app)/workspaces/page.tsx` |
| 10 | 界面截图与可复现脚本 | `docs/screenshots/`（3 张 + README + 步骤 json）、`scripts/cdp-qa.py` |
| 11 | 15 条指向 `workspaces` 的外键（14 CASCADE + 导出任务 SET NULL）+ 账本补列 | `1789701500000…1789701515000`（16 个迁移） |
| 12 | 演练脚本与报告 | `/root/.hermes/workspace/b0_4_purge_drill.py`、`b0_4_step5_post_purge_download.py`、同名 `.log` |
| 13 | 运维文档：purge 演练手册（含三条铁律）、部署与回滚补 16 个迁移逆序回滚 | `docs/RUNBOOK-purge演练.md` §7、`docs/RUNBOOK-部署与回滚.md` §4.4.0 |

## 二、验收标准对照

### 第 1 步（字段与状态机）

| 标准 | 结果 |
| --- | --- |
| `workspaces` 增 `archived_at`/`deleted_at`/`purge_after` + `(status, purge_after)` 索引 | ✓ 迁移 `1789701100000`，up/down 实测 |
| `WorkspaceStatus = active \| archived \| soft_deleted`（`suspended` 废弃并迁移） | ✓ |
| 会话快照含 `workspaceStatus`，守卫按状态拦请求（软删 404 / 归档写 403） | ✓ 并修掉"403 被吞成 401"的真实缺陷 |

### 第 2 步（M8 + 4 个端点）

| 标准 | 结果 |
| --- | --- |
| M8：`users.workspace_id` 由 CASCADE 改 SET NULL 且可空，删工作区**用户不丢** | ✓ up/down 往返 + 实测"删工作区后用户存活、workspace_id 为 NULL" |
| 4 个端点按**目标工作区**判权（404 非成员 / 403 非 owner） | ✓ |
| 错误码：400 名称不符 / 409 状态或未完成任务 / 410 超期恢复 | ✓ |
| 备份表顺序问题（父表在前） | ✓ 演练暴露后修复并加 2 条回归单测 |

### 第 3 步（导出 + 最后工作区软保护）

| 标准 | 结果 |
| --- | --- |
| ZIP 含 manifest（逐文件 sha256）、README、11 张表 jsonl、审计 jsonl | ✓ 生产演练 13 个条目、逐文件 sha256 全对 |
| 5GB 拒绝（413，不截断）、单工作区 1 并发（409）、产物 7 天清理（审计 `workspace.export.expired`） | ✓ |
| 一次性链接 15 分钟且用过即失效 | ✓ 演练：首次 200、同链接复用 401 |
| 平台令牌在导出中脱敏 | ✓ `social_accounts.jsonl` 无 token |
| 最后一个工作区 = 软保护（确认 + 审计 + 通知），不硬阻止 | ✓ 4 条单测 |

### 第 4 步（永久清除 + 演练）

| 标准 | 结果 |
| --- | --- |
| 备份失败即中止，**不先删后备份** | ✓ 演练：503、零删除、账本 `failed`、审计 `workspace.purge_failed` |
| A/B/C 三类逐类验证 | ✓ A 类 14 表全 0；B 类保留（审计 10 / AI 流水 1 / 账本 completed）；C 类不变 |
| 备份可恢复 | ✓ 临时库重放：各表行数与清除前一致 |
| 备份文件 600 / `gzip -t` / sha256 与账本一致 / 保留 180 天 | ✓ |
| 保留期配置不污染生产（演练 1 天被夹到 7 天最小；生产仍默认 30 天） | ✓ |
| 演练后生产验证 | ✓ 默认工作区 active、基线不变、残留 0 |

### 第 5 步（外键补全）

| 标准 | 结果 |
| --- | --- |
| 15 条外键存在且规则正确（14 CASCADE + 导出任务 SET NULL） | ✓ `schema-integrity` 断言 + 生产核查 16 条（含 `users`） |
| 5 张刻意不加外键的表确认没有外键 | ✓ 断言写死 |
| 先清孤儿再加外键 | ✓ 3 条孤儿（演练残留）留档后清除；迁移内"孤儿=0"守卫 |
| 一表一迁移 + 独立回滚 | ✓ 16 个迁移，上下行各 16 次往返 |
| 级联实测 | ✓ 删工作区：14 表级联清空、导出任务保留并置空、3 张账本表原样留下、旁观工作区不受影响 |
| 矛盾 1/矛盾 2 澄清 | ✓ 见 `DESIGN-外键补全-第5步.md` §2.4/§2.5 |
| 清除后仍可下载（第 1 步承诺） | ✓ 真机：pre-purge 链接与重新申请链接均可下载（200 + ZIP 魔数），外部人 403 |

## 三、测试覆盖

| 层 | 数量 | 说明 |
| --- | --- | --- |
| 单元（全仓） | **445** | API 311（含 `workspace-purge.service.spec`、`workspace-lifecycle.service.spec`、`workspace-export.service.spec` 12 条、`capabilities.spec` 6 条）、web 31（含 jsdom 20 条）、shared 6、channel-adapters 8、plugin 71、h5 18 |
| 集成 / E2E | **99**（16 个文件） | 状态机越权 10、权限即时生效 3、跨工作区隔离 8、队列并发 4、上传边界 6、刷新轮换 7、数据库完整性 3+4、运行监控 5、部署断言 8、工作区生命周期 16、导出 20、能力点 4、列表隔离 2、级联实测 1、清扫否证 1 |
| 真机演练 | 2 套 | purge 14 步演练（含 6 类异常路径）、清除后下载专项 |
| 静态 | 全绿 | `tsc --noEmit`、`next lint`、`pnpm -r lint`、`check:secrets`、`preflight --strict` |
| 依赖漏洞 | 3 moderate / 0 high / 0 critical | `@nestjs/core` 1（Phase B 处理）、`file-type` 2（不可达路径） |

## 四、演练记录

| 演练 | 报告 | 关键结论 |
| --- | --- | --- |
| purge 14 步（4 轮迭代） | `/root/.hermes/workspace/b0_4_purge_drill.log` | 暴露并修复：`pg_dump` 无 `--where`、purge 通知写进刚清除的工作区、备份表顺序导致恢复 0 行；最终 A/B/C 全通过 |
| 清除后下载专项 | `/root/.hermes/workspace/b0_4_step5_post_purge_download.log` | 任务行保留（`workspace_id=NULL`）、产物在、pre-purge 链接与重新申请链接均可下载、外部人 403 |
| 密钥轮换演练（任务 7 遗留） | `docs/AUDIT-任务7密钥轮换演练-2026-09-19.md` | 6/6 场景通过 |

## 五、已知缺口与不做项

| 项 | 状态 | 处理 |
| --- | --- | --- |
| purge 备份与 DB 同机 | **技术债** | `TECHDEBT-purge备份异地.md`；异地存储待用户提供账号后接入 |
| E2E 直接读写生产 DB / Redis | **技术债（必须在 B0.9 解决，不得推迟 B1）** | `TECHDEBT-E2E隔离.md`；
本次已加"启动前清扫残留"（防止崩溃的运行留下孤儿行），但隔离仍待 B0.9 的临时 PG+Redis |
| 没有异地告警渠道 | 待用户提供 | 外部通报当前仅记日志（`NotificationChannelService` 可用但未配置） |
| 界面不提供"永久清除" | 设计如此 | 出口写在删除确认框与生命周期卡片，操作步骤见 `RUNBOOK-purge演练.md` §7 |
| 跨工作区引用巡检 | 已文档化，自动化待 B0.9 | `RUNBOOK-purge演练.md` §7.4（当前值 0） |
| H5 端不做工作区管理 | 设计如此 | 移动端只做工作区内的业务操作 |

## 六、运维交接

1. **删除工作区只走 API**：软删 → 保留期内恢复 → 到期/手工永久清除。**禁止**直接 `DELETE FROM workspaces`（三条后果见 `RUNBOOK-purge演练.md` §7.1）。
2. **清除前备份**：`PURGE_BACKUP_ROOT`（默认 `/www/backup/mediaflow/purge`），失败即中止且零删除，保留 180 天。
3. **产物取回**：清除后 7 天内由原申请人重新申请一次性链接（§7.3）。
4. **例行巡检**：跨工作区引用 = 0（§7.4）。
5. **回滚**：16 个迁移的逆序回滚（`RUNBOOK-部署与回滚.md` §4.4.0）。
6. **配置项**：`WORKSPACE_SOFT_DELETE_RETENTION_DAYS`（默认 30，7–365）、`WORKSPACE_PURGE_BACKUP_RETENTION_DAYS`（默认 180，30–3650）。
7. **未闭环提醒**：`/root/.mediaflow-secrets/settings-encryption-key-2026-09-19.txt` 需用户本人转存密码管理器后删除（指纹 `728ff7d1c48a`）。

## 七、下一阶段依赖

| 阶段 | 前置条件 |
| --- | --- |
| B0.5（租户级密钥隔离） | 本报告验收；`system_settings` 租户语义由用户确认（全局默认 + 租户覆盖 / 每租户独立） |
| B0.6（合规留痕） | B0.5 完成；合规要求的具体条款（用户提供） |
| B0.7（计费表结构） | 只做表结构与配额逻辑；定价模型待 B2 |
| B0.8（容器化） | 无 |
| B0.9（CI/CD + E2E 隔离） | 需用户提供 registry 地址与凭据（未提供则只做本地构建验证） |
| B1（真机联调） | 微信公众号 AppID/Secret、抖音 ClientKey/Secret、小红书企业资质、告警渠道、异地备份账号 |
