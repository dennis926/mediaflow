# 设计文档：工作区管理 UI（PC 端最小可用）

> **状态：待确认，尚未实施。** 后端能力（归档/取消归档/软删/恢复/导出，含最后一个工作区软保护）已在 B0.4 第 1–3 步上线，
> 但 `apps/web` 目前**没有任何生命周期入口**——这些能力只有 API 可用。本设计给出最小可用界面，实施前请确认。

---

## 1. 位置

**落在现有页面**：`apps/web/src/app/(app)/workspaces/page.tsx`（现 253 行，"工作区管理"页，侧边栏已有入口）。
不新建页面——工作区相关的切换、成员维护已在那一页，生命周期与导出放同一页最符合用户心智。

页面布局（自上而下，现有内容不动，新增两块）：

```
工作区管理（标题栏：AppShell 已定义）
├── [现有] 工作区列表 / 新建工作区（切换用）
├── [现有] 当前工作区成员与角色维护
├── [新增] 工作区状态与生命周期卡片   ← WorkspaceLifecycleCard
└── [新增] 数据导出面板               ← WorkspaceExportPanel
```

「工作区状态与生命周期」只针对**当前工作区**（用户正在用的那个）；对其它工作区的生命周期操作不在本页提供
（避免误操作，且跨工作区操作属运维场景，用 API 或后续的"管理员视图"）。

---

## 2. 组件结构

| 文件 | 类型 | 说明 |
| --- | --- | --- |
| `apps/web/src/app/(app)/workspaces/page.tsx` | 改 | 引入并渲染两个新面板；页面级测试 |
| `apps/web/src/components/workspace/WorkspaceLifecycleCard.tsx` | 新 | 状态徽标 + 倒计时 + 归档/取消归档/删除/恢复按钮 |
| `apps/web/src/components/workspace/WorkspaceLifecycleCard.module.css` | 新 | 样式（沿用现有 CSS 变量/设计令牌） |
| `apps/web/src/components/workspace/WorkspaceExportPanel.tsx` | 新 | 导出申请、进度轮询、下载按钮、有效期显示 |
| `apps/web/src/components/workspace/WorkspaceExportPanel.module.css` | 新 | 样式 |
| `apps/web/src/components/workspace/DeleteWorkspaceDialog.tsx` | 新 | 删除二次确认（含"最后一个工作区"红字 + 勾选） |
| `apps/web/src/components/workspace/ArchiveWorkspaceDialog.tsx` | 新 | 归档确认（说明只读语义） |
| `apps/web/src/components/workspace/__tests__/lifecycle.spec.tsx` | 新 | jsdom 单测（见 §8） |
| `apps/web/src/components/workspace/__tests__/export.spec.tsx` | 新 | jsdom 单测（见 §8） |
| `apps/web/src/lib/api/endpoints.ts` | 改 | `workspacesApi` 增 8 个方法；新增 `authApi.capabilities()` |
| `apps/web/src/lib/api/types.ts` | 改 | 增 `WorkspaceStatusView`、`WorkspaceExportJobView` |
| `apps/web/src/lib/capabilities.ts` | 新 | `useCapabilities()` hook（见 §5） |

**后端补充（一处）**：新增 `GET /api/auth/capabilities` → `{ capabilities: Capability[] }`。
理由：权限矩阵是可配置的（设置页可改），前端不能硬编码"owner 才有删除权"，否则改矩阵后 UI 会说谎。
该接口按"当前用户在当前工作区的角色 × 生效矩阵"计算，只读、无副作用（`auth.controller.ts` + `auth.service.ts` 各 10 行内）。

---

## 3. 展示内容

### 3.1 状态卡（`WorkspaceLifecycleCard`）

| 区域 | 内容 |
| --- | --- |
| 状态徽标 | `active` = 绿「正常」｜`archived` = 黄「已归档（只读）」｜`soft_deleted` = 红「已删除（可恢复）」 |
| 说明文案 | active：「工作区正常运行」；archived：「归档后只读，随时可取消归档」；soft_deleted：「还有 **X 天**可恢复，到期后数据将被永久清除」 |
| 时间信息 | `archivedAt` / `deletedAt` / `purgeAfter` 三个时间（有则显示，格式沿用 `formatDateTime`） |
| 按钮区 | 见 §3.3 |

**倒计时**：用后端返回的 `daysUntilPurge`（整数天）+ `purgeAfter` 时间。前端**不自己算天数**（避免时区/边界算错），
只做展示："还有 {daysUntilPurge} 天可恢复（截至 {purgeAfter}）"。
`daysUntilPurge === 0` 时文案为「**今天到期**，请尽快恢复」，并把恢复按钮置为高亮。

### 3.2 导出面板（`WorkspaceExportPanel`）

| 区域 | 内容 |
| --- | --- |
| 说明 | 「导出包含内容、素材、知识库与审计日志的数据包（ZIP）。平台凭证会被脱敏。」 |
| 选项 | ☑ 包含素材文件（关闭后只导数据，适合超大工作区）｜☑ 包含审计日志 |
| 开始按钮 | 「申请导出」；已有进行中任务时禁用并显示「已有导出任务进行中」 |
| 进度 | 轮询 `GET /workspaces/:id/export/:jobId`（每 2 秒，完成/失败即停）：进度条 + 状态文案 |
| 完成态 | 显示大小（KB/MB）、sha256 前 12 位、**有效期至**（7 天）、按钮「获取下载链接」 |
| 下载 | 点「获取下载链接」→ 调 `POST .../link` → 立刻 `window.open(url)`；同时提示「链接 15 分钟内有效，且仅能使用一次」 |
| 历史 | 最近 5 条导出任务（状态/时间/大小，可重新申请） |

### 3.3 按钮与可见性（按能力点，不做前端硬编码）

| 按钮 | 能力点 | 显示条件 |
| --- | --- | --- |
| 归档 | `workspace.archive` | 状态 = active |
| 取消归档 | `workspace.archive` | 状态 = archived |
| 删除工作区 | `workspace.delete` | 状态 = active 或 archived |
| 恢复工作区 | `workspace.restore` | 状态 = soft_deleted |
| 申请导出 | `workspace.export` | 任意状态（导出是只读操作） |
| 永久清除 | **不在本页提供**（高危，仅 API + 运维流程，见 §7） | — |

无权限时**不显示**按钮（而不是显示后禁用），并在卡片底部提示「你当前的角色（{角色}）不能执行归档/删除操作」。

---

## 4. 删除确认框（`DeleteWorkspaceDialog`）

**普通删除**（工作区数 > 1）：
1. 标题「删除工作区」；
2. 正文：说明后果（「删除后该工作区对所有成员不可见，**30 天内可恢复**，到期后数据将被永久清除」）+ 列出将被删除的数据量（内容 X 条 / 素材 Y 个 / 成员 Z 人）；
3. 输入框：要求**原样输入工作区名称**（不匹配时「删除」按钮禁用）；
4. 可选备注（写进审计）；
5. 按钮：取消（次要）/ 删除（危险，红）。

**最后一个工作区**（前端据此判断：`workspacesApi.mine()` 里 active/archived 的工作区数 = 1，且就是当前工作区）：
1. 顶部**红字警告**：「⚠ 这是你的最后一个工作区，删除后将**无法登录平台**（没有任何可用工作区时登录会被拒绝）」；
2. 额外的勾选框：☐「我确认这是最后一个工作区，并已知晓后果」——**未勾选时删除按钮禁用**；
3. 请求体带 `confirmLastWorkspace: true`；
4. 若后端仍返回 400（例如并发下别人新建/删除了工作区），把后端的提示原文显示出来，并刷新工作区列表。

**归档确认框**（`ArchiveWorkspaceDialog`）：标题「归档工作区」；正文「归档后该工作区变为**只读**：成员仍可查看，但不能再创建/编辑/发布；**随时可以取消归档**」；按钮 取消 / 归档。

**恢复确认**：直接在卡片上点「恢复」即可，无需对话框（非破坏性），但成功后用 Banner 提示「工作区已恢复」。

---

## 5. 权限

- 新增 `apps/web/src/lib/capabilities.ts`：
  ```ts
  export function useCapabilities(): { capabilities: Set<string>; loading: boolean }
  ```
  调用 `GET /api/auth/capabilities`，用 TanStack Query 缓存（5 分钟），切换工作区后失效重取。
- 页面不读取角色字符串做判断，只判断 `capabilities.has('workspace.delete')` 等——**改权限矩阵后 UI 自动跟随**。
- 后端仍是最终裁决者：UI 隐藏按钮只是体验优化，越权请求由服务端返回 403/404（已有测试覆盖）。

---

## 6. 错误处理（文案与动作）

| 后端 | 场景 | UI 文案与动作 |
| --- | --- | --- |
| 400 | 未确认最后一个工作区 | 显示后端原文（「…如确认，请在请求中带 confirmLastWorkspace: true」）+ 勾选框高亮 |
| 400 | 工作区名称不匹配 | 输入框下方红字「名称与工作区不一致」，按钮保持禁用 |
| 409 | 有未完成的发布任务 | 「该工作区还有 N 个未完成的发布任务，请先取消或等待完成」+ 提供跳转「发布队列」链接 |
| 409 | 有进行中的导出任务 | 「有正在进行的导出任务，请等待其完成」+ 高亮导出面板 |
| 409 | 重复归档 / 非归档态取消归档 | 刷新状态并提示「状态已变化：{最新状态}」 |
| 410 | 超过保留期不可恢复 | 「该工作区已超过保留期，数据不可恢复」+ 把恢复按钮换成「申请数据副本」（若在保留期内曾导出过则指向导出记录） |
| 403 / 404 | 无权限 / 目标工作区不可见 | 「你没有权限执行该操作」并刷新工作区列表 |
| 413 | 导出超过 5GB | 「预计超过 5GB，请关闭『包含素材文件』后重试」+ 自动取消勾选该选项 |
| 401 | 登录过期 | 沿用现有 client 的刷新/跳登录逻辑（无需特殊处理） |

所有成功操作后用 `Banner` 提示（归档/取消归档/删除/恢复/导出申请完成）。

---

## 7. 本次不做

1. **H5 端不做工作区管理**（仅 PC 端）——手机端只保留切换工作区。
2. **不在 UI 提供「永久清除（purge）」**：不可逆操作只走 API + RUNBOOK 流程（`docs/RUNBOOK-purge演练.md`），避免误点。
3. 不做工作区级别的**成员邀请流程改版**（现有成员维护不动）。
4. 不做多工作区的批量操作（批量归档/批量删除）。
5. 不做导出包的**在线预览**（只提供下载）。
6. 不做跨工作区的生命周期管理界面（管理别人所在的其它工作区 → 运维场景）。

---

## 8. 测试（jsdom，与现有 `components/ui/__tests__/ui.spec.tsx` 同风格）

`components/workspace/__tests__/lifecycle.spec.tsx`
1. 三种状态各自的徽标与文案（active/archived/soft_deleted）；
2. **倒计时**：`daysUntilPurge = 7` → 「还有 7 天可恢复」；`= 0` → 「今天到期」且恢复按钮高亮；
3. **按钮可见性按能力点**：给 `workspace.delete` → 显示删除；不给 → 不显示且出现角色提示；`workspace.export` 同理；
4. **最后一个工作区的红字逻辑**：工作区数为 1 时打开删除框 → 出现红字警告、勾选框未勾选时删除按钮 `disabled`；勾选后可点；请求体带 `confirmLastWorkspace: true`；
5. 名称不匹配时删除按钮禁用；
6. **错误映射**：mock 服务端返回 409（有未完成任务）→ 显示「未完成的发布任务」并含跳转链接；410 → 显示不可恢复文案且恢复按钮消失。

`components/workspace/__tests__/export.spec.tsx`
1. 申请导出 → 显示进度条与「进行中」；
2. 轮询到完成 → 显示大小/校验和/有效期 + 「获取下载链接」可用；
3. 「包含素材文件」关闭后仍可申请（请求体 `includeMedia: false`）；
4. 413 → 提示超限并自动取消勾选素材选项；
5. 已有进行中任务时「申请导出」禁用。

**回归**：`pnpm --filter @mediaflow/web run test` 全绿 + `next build` 通过 + 用无头浏览器截图确认三种状态下的界面（人工核验）。

---

## 9. 实施顺序（确认后）

1. 后端：`GET /api/auth/capabilities`（+ 单测/接口测试）
2. 前端 API 层：`endpoints.ts` / `types.ts` / `useCapabilities()`
3. 组件：`WorkspaceLifecycleCard` → `DeleteWorkspaceDialog` / `ArchiveWorkspaceDialog` → `WorkspaceExportPanel`
4. 接入 `workspaces/page.tsx`
5. 测试（§8）+ `next build` + 截图核验
6. 文档：`docs/API.md` 补 `capabilities` 接口；本设计文档追加"实施记录"

预计工作量：后端 0.5 小时、前端 3–4 小时、测试与核验 1–1.5 小时。
