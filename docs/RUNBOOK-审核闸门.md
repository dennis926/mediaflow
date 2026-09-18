# RUNBOOK：内容审核闸门（REQUIRE_CONTENT_APPROVAL）

涉及代码：`apps/api/src/publish/publish.service.ts`（闸门）、`modules/content/content-review.service.ts`（审批）、
`modules/content/entities/content-review.entity.ts`（版本快照）。
背景：审计 P1-1（客户端可写 status 绕过审核）已在任务 3 修复。

## 1. 闸门判定规则（当前实现）

开启「发布前必须审核通过」（`REQUIRE_CONTENT_APPROVAL=true`）时，创建发布任务必须同时满足：

1. `contents.status === 'approved'`；
2. `content_reviews` 里**最新一轮**（`round` 最大）的结论是 `approved`；
3. 审批之后内容**没有被修改**（内容 `updatedAt` ≤ 审批时记录的 `content_updated_at`）。

任一不满足 → 400，文案区分「尚未通过最新一轮审核」与「审核通过后又被修改，请重新提交审核」。

## 2. 已踩过的陷阱（务必保留本段）

**不要用 `content.updatedAt > review.decidedAt` 判断"审批后是否被改动"。**
审批本身会在同一事务里更新内容状态，从而刷新 `contents.updated_at`，使该比较**恒为真** ——
表现为"审核通过后正常发布也被 400 拦截"（任务 3 实测踩到）。
正确做法：审批时把当时的内容版本快照写入 `content_reviews.content_updated_at`，之后用它比较。

同样注意：
- 状态字段本身不足以作为依据（历史数据可能被直接改库），必须回到审核记录；
- 任何"影响发布内容"的字段变更（标题/正文/**标签/素材/封面**）都应让审核结论失效
  （`content.service.ts` 的 `contentChanged` 已覆盖这 5 个字段）。

## 3. 状态机（改动后）

```
create ──► draft
draft/rejected ──提交审核──► reviewing ──审批通过──► approved ──► 可发布
                                  ├─驳回──► rejected ──► 不可发布
                                  └─要求修改──► draft ──► 不可发布
approved ──编辑(标题/正文/标签/素材/封面)──► draft（结论失效）──► 不可发布
任意 ──归档──► archived ──► 不可发布（且未发出的任务被自动取消）
```

## 4. 运维要点

| 场景 | 处置 |
|---|---|
| 内容已通过却仍 400 | 看 `audit_logs` 中该内容的 `content.status_change`（含 from/to/reason），确认是否被编辑过 |
| 需要"改一个字也要重审" | 现状即是：任何影响发布的字段改动都会退回 draft |
| 需要临时放行 | 关闭「发布前必须审核通过」（会记录 settings.update），上线前务必确认该开关状态 |
| 归档后想再发 | 先 `PATCH /contents/:id/archive {archived:false}`（退回 draft），再走审核 |

## 5. 审计留痕

- 提交送审：`content.status_change`（draft → reviewing）
- 审批决策：`content.status_change`（reviewing → approved/rejected/draft，含 round、reviewId）
- 归档/取消归档：`content.status_change` + `content.archive` / `content.unarchive`
- 发布拦截：发布接口返回 400（不写审计；如需留痕可在 phase B 补 `publish.gate_blocked`）
