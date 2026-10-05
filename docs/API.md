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
| POST | `/api/auth/login` | 登录，返回 `accessToken` 与 `refreshToken`（有效期分别由 AUTH_ACCESS_EXPIRES / AUTH_REFRESH_EXPIRES 配置） |
| POST | `/api/auth/refresh` | 用 `refreshToken` 换新令牌；前端 401 时自动调用一次 | **公开**。邮箱 + 密码（bcrypt 校验）→ JWT（默认 2h，`JWT_ACCESS_EXPIRES` 可配） |
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
| DELETE | `/api/publish/tasks/:id` | **取消发布任务**（owner/admin/editor）；待发布/排期中/失败/待人工发布可取消，发布中或已发布返回 400 |
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
| PATCH | `/api/contents/:id/archive` | **归档 / 取消归档**（body `{archived: true|false}`）：归档后不再参与发布与检索，历史保留 |
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
| POST | `/api/media` | **上传素材**（multipart `file` + `groupName?`）：图片/视频/音频，按文件头校验真实类型，大小上限可配 |
| GET | `/api/media` | 素材列表（`kind`/`keyword`/`group`/分页） |
| GET | `/api/media/groups` | 素材分组与数量 |
| DELETE | `/api/media/:id` | 删除素材（软删除 + 移除磁盘文件） |
| GET | `/api/public/media/:storedName` | 素材公开访问（uuid 文件名，供平台抓取） |
| GET | `/api/content-templates` | **文案模板库**列表（`keyword`/`platform`/`category`/分页） |
| POST | `/api/content-templates` | 新建模板（`content.write`） |
| PUT | `/api/content-templates/:id` | 修改模板 |
| DELETE | `/api/content-templates/:id` | 删除模板（软删除） |
| POST | `/api/content-templates/:id/use` | 套用模板：累加引用次数并返回内容 |
| GET | `/api/workspaces` | **我能切换的工作区**列表（含当前标记与我的角色） |
| POST | `/api/workspaces` | 新建工作区（创建者成为所有者，`workspace.manage`） |
| GET | `/api/workspaces/:id/members` | 工作区成员与角色 |
| PUT | `/api/workspaces/:id/members` | 添加成员 / 调整角色 |
| DELETE | `/api/workspaces/:id/members/:userId` | 移出成员（保留至少一名所有者） |
| POST | `/api/auth/switch-workspace` | **切换工作区**：校验成员身份后重新签发令牌 |
| GET | `/api/publish/queue/health` | **队列运维**：消费组/消费者/队列长度 + 卡住任务 + 死信 |
| POST | `/api/publish/tasks/:id/requeue` | 强制重排（无视锁定状态，用于卡住的任务） |
| GET | `/api/audit-logs` | **审计日志**（`action`/`actionPrefix`/`actor`/`keyword`/`from`/`to`/分页），按工作区隔离，权限走 `audit.read` 能力点 |
| GET | `/api/audit-logs/actions` | 动作清单与次数（筛选下拉用） |
| GET | `/api/ai/usage` | **AI 用量与花费**：可按 `provider` + `model` 筛选；返回供应商/模型价目、四段计费明细（输入/输出/缓存写入/缓存读取）、按天/按任务/按模型统计 |
| GET | `/api/ai/providers` | 供应商与模型价目（`onlyConfigured=false` 时包含未配置的，用于先看价再决定） |
| GET | `/api/ai/provider-configs` | 已配置的供应商（密钥打码） |
| PUT | `/api/ai/provider-configs` | 新增/更新供应商配置（`provider`、`label`、`baseUrl`、`apiKey`、`models[]`、`multiplier`；密钥留空表示不改） |
| DELETE | `/api/ai/provider-configs/:provider` | 删除供应商配置（用量历史保留） |
| GET | `/api/ai/catalog` | 预置供应商与模型目录（"添加供应商"下拉用） |
| PUT | `/api/ai/model-price` | 覆盖单个模型的实付价（元/百万 token，四段） |
| GET | `/api/ai/pricing-rules` | 当前计费规则：汇率、当前时段（高峰/空闲）、高峰窗口定义、可抓取价格的供应商 |
| GET | `/api/ai/official-prices` | 官网价格快照：最近一次抓取时间、来源地址、各模型的峰谷两档价 |
| POST | `/api/ai/official-prices/refresh` | **立即抓取供应商官网价目表**（需 `settings.write`）；body `{ provider: 'deepseek' }`（省略则抓全部）。响应 `data.providers[]` 为成功清单、`data.failures[]` 为失败清单（含原因）。指定单个供应商且失败时返回 500 并带原因，不写入半份数据 |
| GET | `/api/ai/usage-legacy` |（保留）旧版用量汇总 | **AI 用量与花费**：按天/任务/模型聚合（`days` 默认 14） |
| POST | `/api/contents/batch` | 内容批量操作：`{ids[], action: archive\|unarchive\|delete}`，逐条返回失败原因 |
| GET | `/api/contents/:id/revisions` | 内容版本历史（新到旧） |
| POST | `/api/contents/:id/revisions/:revisionId/restore` | 回滚到指定版本（回滚前自动留档） |
| POST | `/api/publish/tasks/batch` | 发布任务批量：`{ids[], action: cancel\|retry}` |
| GET | `/api/knowledge` | 列表（分页/品牌/分类/状态/关键字；关键字同时匹配标签，所以按「来源：文件名」可找回某次导入的那批资料） |
| GET | `/api/knowledge` | 列表：`keyword`（标题/正文/品牌）、`brand`、`category`、`isActive`、分页（全员可读） |
| GET | `/api/knowledge/brands` | 品牌聚合（含条数），用于筛选下拉 |
| GET | `/api/knowledge/preview` | 预览某内容本次生成会引用哪些资料：`contentId`、`platform`、`limit`（默认 5） |
| GET | `/api/knowledge/:id` | 详情 |
| POST | `/api/knowledge` | 新增（owner/admin/editor） |
| PUT | `/api/knowledge/:id` | 更新（含 `isActive` 启停） |
| DELETE | `/api/knowledge/:id` | 软删除 |

| GET | `/api/public/site-config` | **未登录可读**的站点信息（名称/副标题/公司/支持邮箱/每页条数/AI 标识文案），登录页与侧边栏据此渲染 |
| GET | `/api/knowledge/categories` | 当前生效的分类配置 + 每个分类的资料数（分类是配置项，不是写死的枚举） |
| PUT | `/api/knowledge/categories` | 保存整套分类（`categories[{code,label,tone,description?}]`）；**正在被资料使用的分类不允许删除**；保存后 DTO 校验码表即时刷新 |
| POST | `/api/knowledge/export` | 导出知识库：`format` = `json`（原生，含分类配置，可整站迁移）/ `csv` / `markdown`，另可 `brand`/`category`/`includeInactive` 过滤；返回 `{fileName,mimeType,content}` 由前端下载 |
| POST | `/api/knowledge/import-data/preview` | **导入第一步**（multipart `file`）：解析 `.json/.csv/.tsv/.xlsx/.xls/.md/.txt`，自动识别字段映射（中英文别名），返回 `{columns,mapping,preview,rows,total,warnings}`，不写库 |
| POST | `/api/knowledge/import-data/commit` | **导入第二步**：`rows`+`mapping`+默认品牌/分类 入库；默认按「品牌+标题+正文前 200 字」**去重** |
| POST | `/api/knowledge/match` | **检索测试台**：喂 `title`/`body`/`tags`/`platform`/`limit`，返回会引用到的资料（含命中原因与得分），不写库 |
| POST | `/api/knowledge/ai-draft` | **AI 起草资料**：`brand`+`category`+`points` → 返回 `{ draft{title,content,tags,keywords}, generationId, model, references }`；只返回草案，人工确认后再调 `POST /api/knowledge` |
| POST | `/api/knowledge/ai-polish` | **AI 润色**（可作用于未保存的草稿）：`content`(+`brand`/`category`/`instruction`) → 返回润色后的 `content`，事实与数字不变 |
| GET | `/api/knowledge/sources` | 按**来源文件**分组的导入资料（文件名、条数、启用数、最近导入时间、ids），用于整批启用/停用/删除 |
| GET | `/api/knowledge/audit` | **知识库体检**：重复条目（3-gram 相似度 ≥ 0.75）+ 欠打磨条目（过短/过长/缺标签/长期未引用） |
| POST | `/api/knowledge/batch-delete` | 批量软删除（`ids[]`，≤100 条） |
| POST | `/api/knowledge/parse` | **第一步：只解析不入库**（multipart，字段 `file`）；返回 `{ parsed, tempFile, chunks[] }`，`chunks[].fromOcr` 标记该片来自本地 OCR，供前端逐片人工校对 |
| POST | `/api/knowledge/commit` | **第三步：按校对后的分片入库**（JSON：`brand`、`category`、`priority?`、`activate?`、`sourceFileName?`、`tempFile?`、`chunks[{content,title?,fromOcr?}]`）；暂存原文件此时移入 `uploads/knowledge/` 留档 |
| POST | `/api/knowledge/import` | **上传文档**（multipart，字段 `file` + `brand`、`category`、`priority?`、`autoActivate?`、`maxChunks?`）；支持 `.pdf/.docx/.pptx/.xlsx/.xls/.csv/.txt/.md`，单文件 ≤10MB。前端可多选文件后逐个调用，单个失败不影响其它文件 |
| POST | `/api/knowledge/batch-activate` | 批量启用/停用：`{ ids: [], isActive: bool }`（导入后确认用） |

**文档导入流程**：解析纯文本 → 按段落切 ~1200 字（重叠 200 字，最多 40 片）→ 每片生成一条资料（默认**停用草稿**）→ 人工确认后批量启用；原始文件留档在 `uploads/knowledge/`，路径记入资料的 `sourceUrl`，标签加「来源：文件名」。

**图片文字处理（本地 OCR，不调用 AI）**：

| 来源 | 处理方式 |
| --- | --- |
| `.pptx` | 按页提取文本框文字；`ppt/media` 里的图片逐张本地 OCR，追加到「幻灯片图片文字」 |
| `.docx` | 正文用 mammoth 提取；`word/media` 图片本地 OCR，追加到「文档内图片文字」 |
| `.pdf` | 优先用文字层；**没有文字层（扫描件）时自动把前 10 页渲染成图片做 OCR**（200 DPI） |
| 老版 `.ppt` | 明确报错，提示另存为 `.pptx` |

**导入流程分两步（界面默认走这条）**：`parse` 只解析并把切片交给人校对（原文件暂存 `uploads/tmp`，24 小时未确认自动清理）→ 人工确认后 `commit` 才写库，暂存文件随之移入留档目录。这样 OCR 错字能在入库前改掉，误上传也不会产生垃圾资料。`import` 为旧的一步式接口（解析即入库），保留给脚本调用。

OCR 引擎为 **tesseract 5（chi_sim+eng）**，离线运行；两种版面模式（psm 3 / psm 6）各跑一次取中文识别更优的结果；单文档最多识别 20 张图片（PDF 最多 10 页），超限会在响应 `warnings` 里说明。响应中的 `parsed.ocrSections` 表示 OCR 贡献了几段文字。可用环境变量 `OCR_ENABLED=false` 关闭、`OCR_LANGUAGES` 调整语言。

**检索与引用规则**：按内容的标题/正文/标签与资料的 `tags + keywords + brand` 做子串匹配（中文不分词），得分 = 命中维度数 ×10 + 优先级 + 引用次数微调；仅 `isActive` 的资料参与；每次生成默认注入 5 条，引用 id 写入 `ai_generations.inputRefs.knowledgeIds`（可追溯"AI 为什么这么写"），并累加该资料的 `usageCount` / `lastUsedAt`。

### 3.9 其它

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET/PATCH/POST | `/api/notifications` | 站内通知列表、标记已读、全部已读（发布失败/待人工/审核变动） |
| GET | `/api/accounts/oauth/:platform/authorize` | 生成平台授权链接（需先配置 AppID） |
| GET | `/api/accounts/oauth/:platform/callback` | 平台回调：换 token、加密入库、跳回前端 |

### AI 计费口径（v0.2.0 起）

- 价格优先级：用户覆盖价（`AI_MODEL_PRICES`）> 官网抓取价（`AI_OFFICIAL_PRICES.providers`）> 国内权威参考价（`AI_OFFICIAL_PRICES.domestic`，国家超算互联网，人民币）> 聚合价目表（`AI_OFFICIAL_PRICES.aggregate`，models.dev，美元）> 预置目录价 > 全局兜底价；**不加价、不打折**。
- `GET /api/ai/official-prices` 的 `data.detail[provider]` 逐家记录 `fetchedAt`（**只记成功时间**）、`error`、`failedAt`、`consecutiveFailures`、`failures[]`。从未成功抓取过的供应商同样建档，`fetchedAt` 为空字符串——界面据此区分「从未成功」与「上次成功时间」。
- `data.domestic` 是**国内权威参考价**（国家超算互联网）的兜底层：`fetchedAt` / `sourceUrl` / `providers` / `error`。人民币口径、不换算，只在官网抓取价缺失时优先于美元聚合价被读取。
- `data.aggregate` 是**聚合价目表**（models.dev）的兜底层：`fetchedAt` / `sourceUrl` / `providers` / `error`。美元口径，只有国内权威价也没有时才被读取（详见 `docs/DESIGN-AI计费口径.md` §2.1）。
- 计费返回的 `source` 取值：`override`（用户覆盖价）、`official`（官网抓取价）、`aggregate`（聚合价目表）、`catalog`（预置目录价）、`global`（全局兜底价）。
- 国内供应商（DeepSeek）直接采用官网人民币价，并按调用时刻落在**高峰/空闲**时段取对应档位：
  高峰 = 工作日 09:00-12:00、14:00-18:00（北京时间，不含法定节假日），其余为空闲（官网口径为空闲价为高峰价的一半）。
- 时段窗口与节假日在 `AI_PEAK_WINDOWS` 配置；配置损坏时一律按空闲计价（宁可少算，不虚高）。
- 每次调用把生效档位与单价写入 `ai_generations.price_snapshot`（含 `tier` / `tierLabel`），可追溯。
- 详见 `docs/DESIGN-AI计费口径.md`。

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

## 工作区生命周期与导出（B0.4）

| 方法 | 路径 | 能力点 | 说明 |
| --- | --- | --- | --- |
| POST | `/api/workspaces/:id/archive` | `workspace.archive` | 归档（只读态）；**200**，重复归档 409 |
| POST | `/api/workspaces/:id/unarchive` | `workspace.archive` | 取消归档；非归档态 409 |
| DELETE | `/api/workspaces/:id` | `workspace.delete` | 软删（保留期内可恢复）；body `{confirmName, reason?, confirmLastWorkspace?}`；名称不匹配 400、有未完成任务/导出 409、最后一个工作区未确认 400 |
| POST | `/api/workspaces/:id/restore` | `workspace.restore` | 恢复；超期 **410**（不可恢复） |
| GET | `/api/workspaces/:id/status` | `workspace.manage` | 状态视图（含 `daysUntilPurge` 倒计时） |
| POST | `/api/workspaces/:id/export` | `workspace.export` | 申请导出；超 5GB 413、并发 409 |
| GET | `/api/workspaces/:id/export/:jobId` | `workspace.export` | 导出进度与校验和 |
| POST | `/api/workspaces/:id/export/:jobId/link` | `workspace.export` | 一次性下载链接（15 分钟） |
| GET | `/api/workspaces/:id/export/:jobId/download` | 公开（令牌即鉴权） | 凭 `?token=` 下载；用过即失效 |

> 这 9 个路由均标注 `@WorkspaceLifecycle()`：即便调用者当前所在的工作区已被归档/软删，也允许调用（否则用户无法恢复自己的工作区）。
> 权限一律按**目标工作区**判定（非成员 404、成员非 owner 403）。

## 当前用户能力点（B0.4 UI 用）

`GET /api/auth/capabilities` —— 读取调用者**自己**在当前工作区生效的能力点，任何登录用户都可调用。

```json
{
  "code": 0,
  "message": "ok",
  "data": {
    "workspaceId": "22222222-2222-2222-2222-222222222222",
    "role": "owner",
    "roles": ["owner"],
    "capabilities": ["settings.write", "users.manage", "workspace.manage", "workspace.archive", "workspace.delete", "workspace.restore", "workspace.export", "workspace.purge"],
    "workspaceStatus": "active",
    "isSuperAdmin": false
  }
}
```

- 判定与 `CapabilityGuard` 逐条一致（含"矩阵里未配置 = 不限制"的语义），前端按钮显隐据此决定，不硬编码角色。
- 与 `AuthSessionService` 共用 30 秒缓存；权限矩阵/角色变更时缓存主动失效。
- 当前工作区被软删时仍返回 200（标记为生命周期豁免），`workspaceStatus` 为 `soft_deleted` 且包含 `workspace.restore`，供界面展示"恢复"入口。

### 生命周期与导出接口（B0.4）

| 方法 | 路径 | 能力点 | 说明 |
| --- | --- | --- | --- |
| GET | `/api/workspaces/:id/status` | `workspace.manage` | 状态 + 恢复倒计时（`daysUntilPurge` 由后端算） |
| POST | `/api/workspaces/:id/archive` / `unarchive` | `workspace.archive` | 归档/取消归档（可逆，200） |
| DELETE | `/api/workspaces/:id` | `workspace.delete` | 软删；body `{confirmName, confirmLastWorkspace?}`；400 名称不符/未确认最后一个，409 有未完成任务 |
| POST | `/api/workspaces/:id/restore` | `workspace.restore` | 保留期内恢复；410 已超期 |
| POST | `/api/workspaces/:id/export` | `workspace.export` | 申请导出；409 已有进行中任务，413 超 5GB |
| GET | `/api/workspaces/:id/export/:jobId` | `workspace.export` | 查询进度/结果 |
| POST | `/api/workspaces/:id/export/:jobId/link` | `workspace.export` | 一次性下载链接（15 分钟） |
| GET | `/api/workspaces/:id/purge-preview` | `workspace.purge` | 永久清除的影响面预估（界面不提供清除动作） |

**软删态下的可达性**：`GET /api/workspaces` 与 `POST /api/auth/switch-workspace` 豁免状态闸门（否则用户删掉当前工作区后无法切换），
其余业务接口一律 404，不暴露该工作区曾经存在。
