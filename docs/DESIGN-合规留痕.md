# B0.6 设计：合规留痕

- 日期：2026-09-21
- 目标：把"AI 标识、审核留痕、个人数据导出、合规删除"四件事做成有证据、可审计、可执行的机制
- 结论：四项均已实现并通过接口级验证（5 条 E2E + 相应单元）

## 一、AI 标识系统化

**判定依据是系统自己的证据，不是用户填了什么**：`ai_generations.content_id` 是否指向该内容。

| 情形 | 系统行为 | 留痕 |
| --- | --- | --- |
| 有 AI 生成记录，标识为 `none`，**未填理由** | **强制回填**：`ai_flag_type → assisted`、`ai_generated → true`，并把显式标识文案并入正文 | 审计 `content.ai_flag.backfilled`（含证据条数、from/to） |
| 有 AI 生成记录，标识为 `none`，**填了理由** | 保留 `none`（理由存 `contents.ai_flag_exempt_reason`） | 审计 `content.ai_flag.exempted`（含理由与证据条数） |
| 无 AI 生成记录 | 不动 | —— |

**执行点**：`ContentReviewService.decide()` 中 `decision === 'approved'` 时（即"通过审核"是最后一道闸门）；
方法 `ContentService.assertAiFlagConsistency()`（`apps/api/src/modules/content/content.service.ts`）。
这样保证**任何被审核通过的内容，其标识都是自洽的**。

配套：`contents.ai_flag_exempt_reason varchar(200)`（迁移 `1789701600000-AiFlagExemptReason`），
内容 DTO 新增 `aiFlagExemptReason`（≤200 字）。

**生产现状**：当前生产库"有 AI 记录却标 none"的内容 **0 条**（无需回填）。

## 二、审核留痕（operator_ip / operator_ua）

`content_reviews.operator_ip varchar(64)` + `operator_ua varchar(256)`（迁移 `1789701700000-ReviewOperatorTrail`）。

- 审核提交与决定两条路径都会写入：`ContentReviewController.submit/decide` 通过 `@Ip()` 与 `User-Agent` 头取值，
  传给 `ContentReviewService`（`ReviewOperatorTrail`）；
- 超过 64/256 字符自动截断（防止超长 UA 撑爆列）；
- 在个人导出与工作区导出中都可取证（审核记录随 `my-reviews.jsonl` / `reviews` 数据集一起导出）。

## 三、个人数据导出 `GET /me/export`

`apps/api/src/modules/me/`（controller + service + module，`users` 与 `content_reviews` 只读查询）。

| 内容 | 说明 |
| --- | --- |
| `me.json` | 账号资料 + 我参与的工作区与角色 |
| `data/my-contents.jsonl` | 我创建的内容（含 AI 标识字段） |
| `data/my-reviews.jsonl` | 我提交或审核过的记录（含 operator_ip/ua） |
| `data/my-audit.jsonl` | 我的操作审计（actor_id = 我） |
| `data/my-ai-calls.jsonl` | 我发起的 AI 调用（provider/model/tokens/cost） |
| `README.txt` | 范围与上限说明 |

- 每类数据上限 **5000 行**；需要全量走工作区导出（owner/admin）；
- **不含**任何平台凭据、密钥或他人数据（E2E 断言压缩包里不出现 `enc:v1:` 密文）；
- 审计 `me.export.requested` 与 `me.export.downloaded`（含各类行数与字节数）。

## 四、租户级删除（与 purge 联动，承诺 30 天内完成）

表 `data_deletion_requests`（迁移 `1789701800000`）+ 两个接口：

| 接口 | 能力点 | 行为 |
| --- | --- | --- |
| `POST /api/workspaces/:id/deletion-request` | `workspace.delete`（owner） | ① 建台账（`due_at = 请求时刻 + 30 天`）；② 走既有软删（可恢复、有审计）；③ 把 `purge_after` **收紧**为 `min(现在 + 保留期, due_at)`；④ 审计 `compliance.deletion_requested` |
| `GET /api/workspaces/:id/deletion-request` | `workspace.manage` | 查询当前请求（状态、承诺期限、剩余天数、purge 账本关联） |

- 真正的清除仍是 B0.4 的 purge（独立备份 + 单事务 + 账本 + 审计 + 外部通报），**不新增不可逆动作**；
- 04:00 的到期清除任务会在这个期限前把它清掉（`purge_after` 已被收紧）；
- 清除完成后 `workspace-punge.service` 调 `completeDeletionRequest(workspaceId, batchId)` → 台账标记 `completed` 并关联账本；
- **恢复工作区 = 撤回请求**：`restoreWorkspace()` 调 `cancelDeletionRequest()` → 标记 `cancelled` 并写审计 `compliance.deletion_cancelled`
  （避免"请求了却悄悄恢复"）。

## 五、测试与证据

| 类型 | 文件 | 覆盖 |
| --- | --- | --- |
| 接口 5 条 | `apps/api/test/compliance-trail.e2e.spec.ts` | ① 有 AI 记录未填理由 → 审核通过时强制回填（`assisted` + 正文含标识 + 审计带证据条数）；①b 填了理由 → 保留 none + `exempted` 审计带理由与证据；② 审核记录带 `operator_ip`/`operator_ua`（用的是自定 UA）；③ `/me/export` 返回 ZIP 且含 5 个数据集 + 无密文 + 两条审计；④ 合规删除：软删 + `purge_after ≤ now+30d` + 台账 pending + 审计 + 状态接口 + 恢复后台账 `cancelled` 且有审计 |
| 生产核查 | SQL | "有 AI 记录却标 none"的内容 0 条 |

## 六、遗留

1. `/me/export` 是**即时生成**（内存打包，5000 行上限）；若将来单用户数据量很大，应改为与工作区导出一致的异步任务 + 一次性链接。
2. 合规删除目前以"工作区"为粒度（本系统的工作区即租户边界）；若将来引入"租户级"概念，需要在 `data_deletion_requests` 上加 `tenant_id` 维度的批量请求。
3. 审核留痕只记录 IP/UA，未做设备指纹（当前架构下不做）。
