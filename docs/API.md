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

### 3.6 用户与角色（仅 owner / admin）

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/api/users` | 成员列表：`keyword`、`status`、`role`、分页 |
| GET | `/api/users/roles` | 角色字典（含各角色在用人数） |
| GET | `/api/users/:id` | 成员详情 |
| POST | `/api/users` | 创建成员（不传密码则生成临时密码，返回一次） |
| POST | `/api/users/invite` | 邀请成员（生成一次性临时密码，默认 editor 角色） |
| PUT | `/api/users/:id` | 修改姓名/手机/头像 |
| DELETE | `/api/users/:id` | 软删除（仅 owner；保留审计痕迹） |
| PATCH | `/api/users/:id/roles` | 分配角色（仅 owner） |
| PATCH | `/api/users/:id/reset-password` | 重置密码（默认生成临时密码并要求首次登录修改） |
| PATCH | `/api/users/:id/status` | 启用/停用 |
| POST | `/api/auth/change-password` | 用户自助改密（≥8 位且含字母+数字） |

**防锁死规则**：不能删除/停用自己、不能取消自己的 owner 角色、不能删除或停用最后一个管理员（返回 400/403 并说明原因）。

### 3.7 内容审核工作流

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| POST | `/api/reviews/submit` | 提交审核（标题/正文不能为空；同一内容不允许重复待审） |
| GET | `/api/reviews` | 审核列表：`status` 筛选，返回内容标题与 `pendingCount` |
| GET | `/api/reviews/:id` | 审核详情（按工作区过滤） |
| PUT | `/api/reviews/:id` | 审核决定：`approved` / `rejected` / `changes_requested`（驳回必填原因；**不能审核自己提交的内容**） |
| GET | `/api/reviews/history/:contentId` | 内容的审核历史（按轮次倒序） |
| GET | `/api/reviews/checklist` | 检查项字典（合规表述/AI 标识/事实准确性/文字差错/品牌口吻） |

**闭环规则**：审核通过 → 内容变「已通过」；驳回/要求修改 → 退回草稿；已通过的内容被再次编辑 → 自动退回草稿（原审核结论失效）；系统设置开启「发布前必须审核通过」后，未通过的内容不能创建发布任务。

### 3.8 品牌知识库

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/api/knowledge` | 列表：`keyword`（标题/正文/品牌）、`brand`、`category`、`isActive`、分页（全员可读） |
| GET | `/api/knowledge/brands` | 品牌聚合（含条数），用于筛选下拉 |
| GET | `/api/knowledge/preview` | 预览某内容本次生成会引用哪些资料：`contentId`、`platform`、`limit`（默认 5） |
| GET | `/api/knowledge/:id` | 详情 |
| POST | `/api/knowledge` | 新增（owner/admin/editor） |
| PUT | `/api/knowledge/:id` | 更新（含 `isActive` 启停） |
| DELETE | `/api/knowledge/:id` | 软删除 |

| POST | `/api/knowledge/import` | **上传文档**（multipart，字段 `file` + `brand`、`category`、`priority?`、`autoActivate?`、`maxChunks?`）；支持 `.pdf/.docx/.xlsx/.xls/.csv/.txt/.md`，单文件 ≤10MB |
| POST | `/api/knowledge/batch-activate` | 批量启用/停用：`{ ids: [], isActive: bool }`（导入后确认用） |

**文档导入流程**：解析纯文本 → 按段落切 ~1200 字（重叠 200 字，最多 40 片）→ 每片生成一条资料（默认**停用草稿**）→ 人工确认后批量启用；原始文件留档在 `uploads/knowledge/`，路径记入资料的 `sourceUrl`，标签加「来源：文件名」。扫描版 PDF（无文字层）会明确报错，不会产生垃圾资料。

**检索与引用规则**：按内容的标题/正文/标签与资料的 `tags + keywords + brand` 做子串匹配（中文不分词），得分 = 命中维度数 ×10 + 优先级 + 引用次数微调；仅 `isActive` 的资料参与；每次生成默认注入 5 条，引用 id 写入 `ai_generations.inputRefs.knowledgeIds`（可追溯"AI 为什么这么写"），并累加该资料的 `usageCount` / `lastUsedAt`。

### 3.9 其它

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET/PATCH/POST | `/api/notifications` | 站内通知列表、标记已读、全部已读（发布失败/待人工/审核变动） |
| GET | `/api/accounts/oauth/:platform/authorize` | 生成平台授权链接（需先配置 AppID） |
| GET | `/api/accounts/oauth/:platform/callback` | 平台回调：换 token、加密入库、跳回前端 |

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
