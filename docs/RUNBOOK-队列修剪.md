# RUNBOOK：发布队列（Redis Stream）修剪

适用对象：`mediaflow:publish:tasks`（消费组 `publish-workers`）
实现：`apps/api/src/publish/publish.queue.ts`、`apps/api/src/publish/queue-trim.task.ts`

## 1. 为什么需要修剪

Stream 里的消息即使被 ack 也不会自动消失，会一直累积（实测曾累积到 146 条已消费消息）。
需要上限，否则内存与 `XINFO`/`XADD` 开销会随时间增长。

## 2. 关键结论：`XADD … MAXLEN ~` 会静默吞掉任务（**不要用**）

2026-09-18 的对照实验（写入 200 条 → 读走 50 条不 ack → 再 XADD 15000 条）：

```
【旧方案】XADD key MAXLEN ~ 10000 * …
  XLEN=10000  XPENDING=50
  最早未确认消息 1789746214112-0 是否还能取到: ❌ 不能
  → PEL 里仍留着该 id，但 XRANGE / XAUTOCLAIM 都取不到消息本体 = 任务被静默吞掉

【现方案】入队不做自动修剪；修剪时先保护未确认消息
  场景：200 条历史已 ack → 追加 15000 条 → 读走 50 条不 ack（位于中段）
  XTRIM key MINID ~ 1789746265223-0 → 删除 200 条；XLEN=15000；XPENDING=50
  未确认 50 条中可取到 50 条 → ✅ 完好无损
  全部 ack 后 XTRIM key MAXLEN ~ 10000 → 删除 5000 条；XLEN=10000 ✅ 收敛到上限
```

**原因**：`MAXLEN` 按"条数"从最旧开始丢弃，不区分是否已 ack；PEL 只保存 ID，
消息本体被丢弃后认领与重放都会失败。

## 3. 正式方案（代码已实现）

`PublishQueueService.trim()`：

1. `XPENDING key group - + 1` 取**最早一条未 ack 的消息 ID**（floor）；
2. 有 floor → `XTRIM key MINID ~ <floor>`（只丢更旧、已处理完的历史，未确认消息必然保留）；
3. 无 floor → `XTRIM key MAXLEN ~ <PUBLISH_STREAM_MAXLEN>`（默认 10000，可在「设置 → 发布队列」调整）。

定时执行：`QueueTrimTask`，`@Cron(EVERY_HOUR)`。
告警：`XLEN > 上限×2` 通知；`XLEN > 上限×10` 额外写审计日志 `queue.trim.overflow`。

## 4. 人工操作手册

```bash
# 1) 先看状态
redis-cli XLEN mediaflow:publish:tasks
redis-cli XPENDING mediaflow:publish:tasks publish-workers      # 必须为 0 才能清空历史
redis-cli XINFO STREAM mediaflow:publish:tasks | head -20

# 2) 确认 XPENDING=0 后，清空已消费历史（只保留最新一条）
redis-cli XTRIM mediaflow:publish:tasks MINID <最新条目id>        # 最新 id 见 XINFO 的 last-generated-id

# 3) 复核
redis-cli XLEN mediaflow:publish:tasks
# 4) 留痕：写审计日志（action=queue.trim.manual，payload 含删除条数与执行人）
```

## 5. 故障处置

| 现象 | 处置 |
|---|---|
| 队列积压（XLEN 高且 XPENDING 高） | 检查 `mediaflow-api` 是否存活、`PUBLISH_WORKER_ENABLED=true`；看「发布队列 → 队列运维」的卡死任务，必要时 `requeue` |
| 有未确认消息长期不变 | 该任务可能已"发布成功但未落库"，重启 API 让 worker 接管（`XAUTOCLAIM`），不要手工 `XACK` |
| 需要紧急清空 | 先确认 XPENDING=0；否则先处理未确认消息，再清 |
| 误删了未确认消息（历史遗留） | 只能靠数据库 `publish_tasks` 重建任务（数据库是唯一事实来源），`requeue` 重新入队 |
