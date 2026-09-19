# 决策记录：依赖选型与漏洞处理

- 日期：2026-09-19（阶段 A，任务 5 / 5b）
- 相关提交：`6572ce6`（multer + exceljs）、`9fb8920`（next 15）、本次（bcrypt 6 + overrides + react-router 7）

## 1. 已升级（含理由与验证）

| 包 | 变更 | 理由 | 验证 |
|---|---|---|---|
| `multer` | 1.4.4 / 传递 2.0.2 → **2.4.0**（`pnpm.overrides` 统一） | 多条 DoS（含 fileFilter 竞态），修复线 ≥2.3.0 | 上传 4 类用例 + 线上 413/400/429 实测 |
| `xlsx` | **移除**，改用 **exceljs 4.4.0** | npm 上的 SheetJS 停在 0.18.5（原型污染 / ReDoS），新版本只发布在官方 CDN，等于持续暴露；exceljs 维护状态更好且支持流式读写 | 真实 xlsx/csv 文件导入预览、文档解析、`.xls` 明确拒绝 |
| `next` | 14.2.35 → **15.5.25** | 2 个 critical（AVIF 图片优化 RCE、Windows RCE 线） | web 构建 + 11 测试 + 16 页面回归；`/_next/image` 返回 400 |
| `bcrypt` | 5.1.1 → **6.0.0** | **根治 tar 链**：5.x 依赖 `@mapbox/node-pre-gyp`（带 tar@6.2.1，1 critical + 11 条），6.x 改用 `node-gyp-build` | `pnpm why tar` 已消失；**真实登录用旧 `$2b$` 哈希校验通过**；211 测试通过 |
| `qs` | 6.14.2 → **6.16.0**（overrides） | 运行时可达（express/body-parser 解析 query）：DoS、数组上限绕过 | typecheck + 全仓测试 + web 构建 |
| `body-parser` | 1.20.4 → **1.20.8**（overrides） | 同上（低危 DoS） | 同上 |
| `postcss` | 8.4.31 → **8.5.28**（overrides） | 构建期使用（next build 的 CSS 处理）：任意文件读、路径穿越 | web 构建成功 |
| `lodash` | 4.17.21 → **4.18.1**（overrides） | 运行时经 `@nestjs/config` 加载：原型污染、`_.template` 注入 | 全仓测试通过 |
| `react-router-dom` | 6.30.6 → **7.18.4**（H5） | 运行时可达（移动端路由）：open redirect、反序列化构造函数注入 | H5 16 测试 + 构建 + 页面 200 |

## 2. 记录为「不可达」、暂不升级

| 包 | 漏洞数 | 可达性判定（证据） | 处理 |
|---|---|---|---|
| `nodemailer` 6.9.16 | 12（3 high / 8 moderate / 1 low） | **当前不可达**：`NOTIFY_SMTP_HOST` 为空、通知渠道未配置、`notifications` 表外发尝试 0 条；邮件代码路径从未执行 | 记录。**启用 SMTP 前必须先升级到 ≥7.0.7**（7.x 有 breaking change，需同步改 `notification-channel.service.ts` 并跑真实发信集成测试） |
| `file-type` 20.4.1 | 2（moderate） | 不可达：来自 `@nestjs/common` 的内部依赖，本项目的上传类型校验是自研魔数（`media.service.ts` 的 `detectMimeType`），从未调用 `file-type` | 记录。等 Nest 升级时一并解决 |
| `uuid` 9.0.1 / 11.0.3 | 1（moderate） | 不可达：漏洞点在 `v3/v5/v6` 的 buffer 参数；项目用 `node:crypto` 的 `randomUUID`，Nest/TypeORM 只用 `v4` | 记录（不强行 override 到 11.x，避免破坏 TypeORM） |
| `@nestjs/core` 10.4.22 | 1（moderate） | 可达但**无同线补丁**：修复需 Nest 11/12（major，涉及装饰器/DI 行为变化） | 记录为阶段 B 评估项 |

## 3. 约定（避免回退）

1. **不要再引入 `xlsx`**：新版只在 SheetJS CDN，npm 包停留在有漏洞的 0.18.5。表格解析统一走 `apps/api/src/modules/content/spreadsheet.reader.ts`（exceljs + 自带 CSV 解析）。
2. **传递依赖修复优先用根 `package.json` 的 `pnpm.overrides`**（当前：multer / qs / body-parser / postcss / lodash），并在升级后跑全仓测试。
3. **major 升级必须跑真实链路验证**，不只看测试：bcrypt 6 的验证方式是"用既有哈希真实登录"；react-router 7 的验证方式是"H5 页面加载 + 16 测试 + 部署后 200"。
4. 每次升级后更新 `pnpm audit --prod`，把结果写入 `/root/.hermes/workspace/audit-after.txt`。

## 4. 阶段 A 结果

`pnpm audit --prod`：**87 → 18 条（critical 3 → 0，high 41 → 3）**；
剩余的 3 条 high 全部来自未启用的 `nodemailer`。

---

## 5. 标准动作：依赖漏洞必须做「可达性评估」（2026-09-19 追加）

今后处理任何依赖漏洞，都按以下顺序，不允许"看到告警就盲目升级"或"看到告警就忽略"：

1. **定位依赖路径**：`pnpm why <包> --prod`，区分直接依赖 / 传递依赖。
2. **判断运行时是否可达**：
   - 进程是否真的加载它（例：`/proc/<pid>/map_files`、`require.cache` 探针）；
   - 相关功能是否已启用（例：SMTP 是否配置、外发通知是否为 0 条）；
   - 项目是否调用脆弱函数（例：`file-type` 的解析函数 vs 自研魔数校验）。
3. **分级处理**：
   - **可达** → 优先修，且必须跑真实链路验证（例：bcrypt 用既有哈希真实登录；nodemailer 用真实 SMTP 发信）；
   - **不可达** → 降为 P3，记录证据与"何时会变可达"（例：`nodemailer` 一旦配置 SMTP 即可达）。
4. **修复方式优先级**：根治（换掉带毒依赖链，如 bcrypt 6 去掉 node-pre-gyp/tar）> 同 major overrides > major 升级 > 记录并接受。
5. **结果留痕**：更新 `pnpm audit --prod` 快照到 `/root/.hermes/workspace/audit-after.txt`，并在本文件登记。

## 6. nodemailer：已升级到 10.0.10（2026-09-19）

- 起因：任务 5 判断其"未启用不可达"；但评估改造成本后发现用法只有 1 处
  （`notification-channel.service.ts:96-109`：`createTransport({host,port,secure,auth,connectionTimeout})` + `sendMail({from,to,subject,text})`），
  且该 API 形状在 6→7→8→9→10 之间未变 → **改造成本 0 行**，故直接升级到最新 10.0.10（清掉全部 12 条告警）。
- 验证方式：**真实发信**。用本地 SMTP 接收器（临时）配置通知渠道，触发一次队列容量告警
  （走 `notify(external=true)` → `dispatch()` → `sendEmail()`），接收器收到完整报文：
  `From: notify@example.com` / `To: ops@example.com` / `Subject: [MediaFlow] 发布队列超过…` / 正文为告警文本 + 上下文 JSON。
  验证后已把 `NOTIFY_EMAIL_ENABLED` 恢复为 false、SMTP 相关项清空。
- `scripts/preflight.sh` 增加断言：`nodemailer` 实际版本必须 ≥ 9.1.1（防止被依赖回退到有漏洞的旧版本）。

## 7. @nestjs/core 的 moderate 漏洞（阶段 B 评估）

- 漏洞：`@nestjs/core Improperly Neutralizes Special Elements`，**同线（10.x）无补丁**，修复版本为 ≥11.1.18。
- 判定：可达但影响面对本项目有限（涉及 Nest 内部的特殊元素处理），且 Nest 10 → 11 属 major（装饰器/DI 行为、Express 5 等变化）。
- 处理：**阶段 B 评估 Nest 11 升级**（与多租户/计费改造一起做），当前记录并接受。
