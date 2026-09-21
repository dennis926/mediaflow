# B0.5 设计：租户级密钥与配置隔离

- 日期：2026-09-21
- 目标：把"配置与密钥"从"进程级全局"改为"按租户 / 工作区隔离"，并澄清 `system_settings` 的语义
- 结论：**4 个真实隔离缺陷已修复**，单元 8 条 + 接口级 4 条验证通过，生产已部署

## 一、`system_settings` 语义澄清（定稿）

**定稿语义：平台默认（`.env` + 代码默认）→ 工作区覆盖（数据库）。不存在"全局行"。**

| 层级 | 存放位置 | 谁来改 | 说明 |
| --- | --- | --- | --- |
| 平台默认 | `.env`（`settings.registry.ts` 的 `envKey`）+ 代码默认值 | 运维（部署时） | 所有工作区共用同一份默认值 |
| 工作区覆盖 | `system_settings` 表，**每行必须同时带 `tenant_id` 与 `workspace_id`** | 各工作区 owner/admin（设置页） | 只影响该工作区；不配置则回落平台默认 |

**为什么不做"每租户独立一套"**：本系统的工作区即是配置边界（一家公司一个或多个工作区），
再加一层"租户默认"会让"改了没生效"这类问题变得难以解释；真要给多租户 SaaS 提供平台级设置，
应在 B2 引入独立的"平台设置"存储，而不是把 `system_settings` 变成三态表。

**数据现状核查**：17 行全部带 `tenant_id` + `workspace_id`，`workspace_id IS NULL` 的行 **0 条**；
且表上有 `UNIQUE (workspace_id, key)`（`IDX_5f65e27568da019d71396f6e10`）——**同一工作区不可能出现同名键两行**
（包括"同工作区但别家租户"的脏数据，插不进去）。因此本步**无需数据迁移**。

## 二、发现并修复的 4 个隔离缺陷

### 缺陷 1（越权读取，最严重）：设置值缓存只按 key

`apps/api/src/modules/settings/settings.service.ts`

```
// 修复前：Map<key, value> —— 多工作区下 A 读到的是 B 的值（AI 密钥就是越权读取）
if (this.cache.has(key)) return this.cache.get(key) ?? null;
```

修复：缓存键改为 `tenantId::workspaceId::key`（`cacheKey()`），读写一致；

### 缺陷 2（越权影响）：运行时快照是进程单例

`apps/api/src/modules/settings/runtime-config.ts` + `settings.service.ts`

`refreshRuntimeConfig()` 在"保存设置"时被调用，而 `runtime()` 返回的是全局 `snapshot`——
于是**A 公司改自己的权限矩阵/上传上限，会立刻改变 B 公司的行为**（权限矩阵属安全相关）。

修复：

- `runtime-config.ts`：新增 `workspaceSnapshots: Map<workspaceId, RuntimeConfig>`；
  `runtime()`（同步）按当前作用域取 → 无该工作区快照时回退到 `fallbackWorkspaceId` → 再回退平台默认；
  新增 `setFallbackWorkspace()`（启动时设为默认工作区，保持后台任务行为不变）、
  `dropWorkspaceRuntimeConfig()`（清除工作区后丢弃）；
- `settings.service.ts`：`refreshRuntimeConfig()` 显式解析作用域并把配置只写进**该工作区**的快照；
  启动（无请求作用域）时额外把它设为兜底；
- `workspace-purge.service.ts`：永久清除后调用 `settings.forgetWorkspace()` 丢弃快照；
- `workspace.module.ts`：`imports: [..., SettingsModule]`（E2E 启动真实 AppModule 时发现 DI 未接线，会导致服务起不来）。

### 缺陷 3：设置查询缺租户条件

`settings.service.ts` 的 `get()` / `list()` / `updateMany()` 原来只带 `workspaceId`；
现全部改为 `tenantId + workspaceId` 双条件（`data-source` 层再兜一道）。

### 缺陷 4：平台字典被全表读取

`apps/api/src/modules/platform/social-account.service.ts`

```ts
// 修复前：取全表平台行，把别的工作区/别家公司的平台行也拿进来做展示映射
const platformRows = await this.platforms.find();
```

修复：改为 `where: { tenantId, workspaceId }`；账号查询（列表 / 解绑）同时补上租户条件。

## 三、密钥与凭据的现状（已核查）

| 对象 | 存放 | 加密 | 读取校验 |
| --- | --- | --- | --- |
| 主密钥 `SETTINGS_ENCRYPTION_KEY` | `.env`（600），**全局一份** | —— | 启动即校验长度 ≥32、与 JWT_SECRET 不同（否则拒绝启动） |
| AI 凭据（`AI_API_KEY`、`AI_PROVIDER_CONFIGS`） | `system_settings`（每工作区一行） | AES-256-GCM（`enc:v1:`），**密文按行分区 = 按租户/工作区分区** | 经 `SettingsService.get()`，带 `tenantId + workspaceId` 过滤；接口只返回掩码 |
| 平台凭据（`access_token`/`refresh_token`） | `social_accounts` 行内（密文） | 同上 | 查询带 `tenantId + workspaceId`；导出时脱敏（`REDACTED_COLUMNS`） |
| 通知渠道（webhook/邮箱密码） | `system_settings` | 同上 | 同上 |

**主密钥仍全局一份**是刻意的：密钥轮换成本与租户数无关；隔离靠"每个租户的密文单独一行 + 查询强制带租户"实现。

## 四、测试与证据

| 类型 | 文件 | 覆盖 |
| --- | --- | --- |
| 单元 8 条 | `apps/api/src/modules/settings/__tests__/settings-isolation.spec.ts` | 缓存按"租户+工作区"隔离（切工作区必改变结果，正反两面）；`get` 查询条件含双 id；同工作区别租户的行读不到；`list()` 只返回本工作区；`updateMany` 写入行带双 id；运行时快照按工作区隔离（A 保存不影响 B / B 保存不影响 A）；无作用域时用兜底工作区；`forgetWorkspace` 丢弃快照 |
| 接口 4 条 | `apps/api/test/settings-isolation.e2e.spec.ts` | 工作区 B 改设置 → A 读到自己的值（真实 HTTP + 真实库）；唯一索引拒绝同工作区重复键 + 别的租户/工作区的行不可见；`system_settings` 无"全局行"；上传上限按工作区生效（B 改 7 不影响 A） |
| 生产核查 | SQL | `workspace_id IS NULL` 0 行；17 行均带双 id；`UNIQUE(workspace_id,key)` 存在 |

## 五、遗留与不做项

1. **运维级阈值（`monitor.*`、`publish.*`、`notify.*`、`workspace.*` 保留期）仍以兜底工作区（默认工作区）的配置为准**——
   这是刻意的：它们描述"这台服务器/这套部署"的运维策略，不属于某个租户。多租户 SaaS 化时若需要按租户覆盖，
   再评估引入"平台设置"层（B2）。
2. `runtime()` 保持同步（79 处调用点），工作区快照只覆盖"按工作区保存的设置"；未保存过设置的工作区回落到兜底快照，
   与改造前行为一致。
3. 主密钥轮换流程见 `RUNBOOK-密钥轮换.md`（本轮未改）。
