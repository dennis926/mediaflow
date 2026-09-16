# MediaFlow API 文档

> 状态：已实现健康检查 + 发布任务（Prompt 3）。接口随开发阶段继续补全。

## 1. 通用约定

- 基础路径：`/api`
- 统一响应体：

```json
{ "code": 0, "message": "ok", "data": {} }
```

- `code = 0` 表示成功，非 0 为业务错误码（见 `@mediaflow/shared` 的 `ApiCode`）：

| code | 含义 | HTTP |
| --- | --- | --- |
| 0 | 成功 | 200 |
| 40000 | 参数错误 / 业务校验不通过 | 400 |
| 40100 | 未登录 / Token 失效 | 401 |
| 40300 | 无权限 | 403 |
| 40400 | 资源不存在 | 404 |
| 40900 | 冲突 | 409 |
| 42900 | 请求过于频繁 | 429 |
| 50000 | 服务端错误 | 500 |

- 分页响应 `data`：`{ items: [], meta: { page, pageSize, total, totalPages } }`

## 2. 鉴权

除标注 **公开** 的接口外，全部接口需要 `Authorization: Bearer <accessToken>`，缺失或失效返回 `40100`。

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| POST | `/api/auth/login` | **公开**。邮箱 + 密码（bcrypt 校验）→ JWT（默认 2h，`JWT_ACCESS_EXPIRES` 可配） |
| GET | `/api/auth/me` | 当前登录用户（含角色） |

- 全局 `JwtAuthGuard`：`@Public()` 标记的接口（`/api/health`、`/api/auth/login`、`/api/publish/adapters`、`/api/ai/status`）免鉴权
- 本地调试可设 `AUTH_ENFORCED=false` 临时关闭鉴权（生产保持 true）
- 登录成功/失败、发布任务状态变化、AI 调用等都会写入 `audit_logs`

## 3. 已实现接口

### 3.1 系统

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/api/health` | 健康检查 |

### 3.2 发布中心

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/api/publish/adapters` | 已接入的平台适配器与能力（模式 / 能否发布 / 能否取数 / 互动支持） |
| GET | `/api/publish/queue/stats` | 发布队列状态（stream 长度、未确认条数、消费者数） |
| GET | `/api/publish/tasks` | 任务列表，支持 `status`、`platform`、`page`、`pageSize` |
| GET | `/api/publish/tasks/:id` | 任务详情（含内容、平台版本） |
| POST | `/api/publish/tasks` | 创建发布任务（支持多平台、定时） |
| POST | `/api/publish/tasks/:id/retry` | 重试任务（failed / manual_required / canceled / pending 可重试）：重置状态与尝试次数并重新入队 |

`POST /api/publish/tasks` 请求体：

```json
{
  "contentId": "uuid",
  "platforms": ["wechat_mp", "zhihu"],
  "socialAccountId": "uuid（可选）",
  "scheduledAt": "2026-09-20T10:00:00+08:00（可选，未来时间则进入排期）",
  "maxAttempts": 3
}
```

校验规则：

- 内容不存在 → 40400
- `platforms` 取值非法 / 空数组 → 40000
- **AI 生成内容若未通过 AI 标识校验（`ai_flag_checked=false`）→ 40000 拒绝发布**（法定要求）
- 平台无适配器 → 40000

### 3.3 内容中心

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/api/contents` | 列表：`keyword`（标题/摘要/正文模糊搜索）、`status`、`platform`（有该平台版本）、`aiGenerated`、`page`、`pageSize` |
| POST | `/api/contents` | 创建内容；`aiFlagType != none` 时自动置 `aiGenerated=true` 并把 AI 标识写入正文 |
| GET | `/api/contents/:id` | 详情（含平台版本） |
| PUT | `/api/contents/:id` | 更新（同样重算 AI 标识） |
| DELETE | `/api/contents/:id` | 软删除（`deleted_at`，列表与详情立即不可见） |
| PATCH | `/api/contents/:id/ai-flag-check` | 标记 AI 标识已复核（`aiFlagChecked=true/true` 才能发布 AI 内容） |
| GET | `/api/contents/:id/variants` | 平台版本列表 |
| POST | `/api/contents/:id/ai-adapt` | AI 多平台适配，生成/更新 `content_variants` |

`POST /api/contents/:id/ai-adapt` 请求体：

```json
{
  "platforms": ["wechat_mp", "xiaohongshu"],
  "tone": "通俗易懂",
  "keywords": ["肠道", "膳食纤维"],
  "overwrite": false
}
```

- 所有目标平台都已有版本且 `overwrite=false` → **提前返回 40900，不会白调用 AI**
- 新版本自动带上 AI 标识（`aiFlagType=assisted`），正文末尾追加"（本文由 AI 辅助生成）"
- 响应含 `generationId`（对应 `ai_generations` 记录）与 `model`

### 3.4 AI 服务

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/api/ai/status` | 当前 AI 提供方与模型（`mock` 表示离线提供方） |
| POST | `/api/ai/generate` | 纯文本生成 |
| POST | `/api/ai/optimize-title` | 标题优化，返回 3 个候选 |
| POST | `/api/ai/compliance-check` | 合规检查：本地规则（医疗功效/绝对化/效果承诺/权威背书）+ AI 复核说明；返回 `passed`、`score`、`violations[]` |
| GET | `/api/ai/generations` | AI 调用日志（提供方、模型、token、耗时、状态、错误） |

**每一次 AI 调用都会写入 `ai_generations`**，包含 prompt、输出、token 数、耗时与失败原因。

### 3.5 系统设置（仅 owner / admin）

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/api/settings` | 分组返回全部可配置项；密钥类只返回 `••••后四位`，并标注来源 `db` / `env` / `none` |
| PUT | `/api/settings` | 批量保存，body：`{"items":[{"key":"AI_API_KEY","value":"sk-..."}]}`；空值 = 清除后台配置、回退 .env |
| POST | `/api/settings/ai/test` | 连接测试；可选传入未保存的 `apiKey` / `model` / `baseUrl` |

- 配置优先级：**数据库（后台界面）> `.env` > 代码默认值**
- 密钥类字段用 AES-256-GCM 加密后入库（密钥来自 `SETTINGS_ENCRYPTION_KEY`，未配置则用 `JWT_SECRET` 派生）
- 保存动作写入审计日志，只记录改了哪些 key，不记录值
- 角色不足返回 `40300`

## 4. 任务状态机

```
pending ──(到点/入队)──> publishing ──> published
   │                          │
   │                          ├──> manual_required（公众号：人工发布）
   │                          ├──> pending（插件平台等待人工确认，extra.awaitingConfirmation=true）
   │                          └──> pending(等待重试, attempts<maxAttempts) 或 failed
scheduled ──(到点，由扫描器入队)──> pending
```

- 失败重试：`PUBLISH_RETRY_INTERVAL_MS`（默认 300000ms，5 分钟），最多 `maxAttempts` 次
- 队列：Redis Stream `mediaflow:publish:tasks`，消费组 `publish-workers`；worker 崩溃留下的未确认消息 60s 后被接管
- 数据库是唯一事实来源：队列消息只带任务 ID，消费时重新读取并做条件更新

## 5. 规划接口（待实现）

- 内容：`/api/contents`、`/api/contents/:id`、`/api/contents/:id/ai-adapt`
- 发布：`/api/publish/tasks/:id/retry`、`/api/publish/calendar`
- 数据：`/api/analytics/overview`、`/api/analytics/trend`
- 账号：`/api/accounts`、`/api/accounts/bind`
