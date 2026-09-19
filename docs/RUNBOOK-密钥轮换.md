# RUNBOOK：设置加密主密钥（SETTINGS_ENCRYPTION_KEY）的备份与轮换

涉及代码：`apps/api/src/common/crypto.service.ts`（AES-256-GCM + scrypt 派生）、
`apps/api/src/modules/settings/settings.service.ts`（写入时加密、读取时解密）。
影响范围：`system_settings.value` 中所有 `enc:v1:` 前缀的密文（当前 2 行为 `AI_API_KEY`、`AI_PROVIDER_CONFIGS`）。

## 1. 密钥备份约束（最重要）

- `SETTINGS_ENCRYPTION_KEY` 生成后**必须立即备份到独立的密钥管理系统**（1Password / Vault / 纸质密封等）。
- **不得只存在服务器 `.env`**：`.env` 丢失或被覆盖 = 所有 `enc:v1:` 密文**永久不可解密**，只能重录。
- `.env` 权限必须 600（`scripts/preflight.sh` 会断言）。
- 备份物与备份介质不得与数据库备份放在同一处（数据库备份里只有密文，密钥丢了同样解不开）。

## 2. 轮换流程（五步，缺一不可）

1. **备份**：`pg_dump ... | gzip > /www/backup/mediaflow/pre-key-rotation-<timestamp>.sql.gz` + `gzip -t` 校验。
2. **演练**：在临时库（如 `mediaflow_keytest`）用旧密钥解密 → 新密钥重加密 → 随机读验证 → 演练库删除。
3. **生产执行**：写新密钥到 `.env`（600）→ 重加密脚本 → 随机读 3 条验证 → 重启服务 → `/api/health` 必须 200。
4. **验证**：`GET /ai/provider-configs` 掩码正常；`POST /settings/ai/test` 真实调用成功；审计日志记录轮换动作。
5. **旧密钥归档 → 销毁**：旧密钥至少保留 **30 天**（用于回滚），到期后安全销毁。

## 3. 责任人

| 角色 | 职责 |
|---|---|
| 密钥保管人（默认：账号所有者） | 生成/备份新密钥、保管密钥管理系统的访问权 |
| 执行人（运维） | 按本手册执行轮换、记录审计日志 |
| 审批人（默认：账号所有者） | 批准轮换窗口；生产执行前必须明确批准 |

（当前为内部工具，保管人与审批人为同一人时也需在审计日志里留下记录。）

## 4. 触发条件

- 密钥泄露或疑似泄露（立即轮换）
- 人员离职且曾接触密钥
- 合规要求（审计/协议变更）
- **定期轮换：建议每 12 个月**

## 5. 禁止事项

- 不得在聊天、邮件、工单、文档中传递密钥明文；
- 不得把密钥写入代码、镜像、日志或 CI 变量以外的任何位置；
- 不得在未备份的情况下先改 `.env`（顺序永远是"先备份后改"）；
- 不得跳过演练直接改生产。

## 6. 故障处置

| 现象 | 原因 | 处置 |
|---|---|---|
| 启动报错 "SETTINGS_ENCRYPTION_KEY 必须配置" | 密钥缺失/过短（<32 字符） | 从密钥管理系统取回并写入 `.env`（600），重启 |
| 读取密钥类配置报"解密失败" | 主密钥与密文不匹配（换过密钥/换过 JWT_SECRET） | 用归档的旧密钥解密 → 用当前密钥重加密；无法解密则重录该项 |
| 轮换后 AI 调用失败 | 重加密未完成或密钥写错 | 从 `pre-key-rotation-*.sql.gz` 恢复 + 还原旧 `.env` → 重启 → 复盘 |

## 轮换记录

### 第 1 次轮换：2026-09-19（JWT_SECRET 派生 → 专用 SETTINGS_ENCRYPTION_KEY）

| 项 | 值 |
| --- | --- |
| 日期 | 2026-09-19 08:20–08:21（CST） |
| 执行人 | 运维脚本 `apps/api/scripts/rotate-settings-key.cjs`（人工监督执行） |
| 审批 | 用户批准（执行前经过临时库 6 场景演练 + dry-run 核对） |
| 影响范围 | 表 `system_settings`、列 `value`，**2 行**（`AI_API_KEY`、`AI_PROVIDER_CONFIGS`） |
| 旧主密钥 | `JWT_SECRET`（48 字符），指纹 sha256 前 12 位：`9d87f6490bc0` |
| 新主密钥 | `SETTINGS_ENCRYPTION_KEY`（44 字符 base64 = 32 字节），指纹：`728ff7d1c48a` |
| 停机时间 | API 停止约 60 秒（Web/数据库不受影响） |
| 审计日志 | `settings.encryption_key.rotated`（含 assets：rows=2、newKeyFingerprint） |
| 验证 | 全量 2 行解密成功；登录正常；`GET /ai/provider-configs` 掩码正常；`POST /settings/ai/test` ok；真实 AI 适配成功（2 个平台变体） |
| 备份 | `.env.bak-202609190820`、`dist.bak-202609190820`、`pre-key-rotation-2026-09-19_0742.sql.gz`（均在 `/www/backup/mediaflow/`） |
| 归档位置 | `/root/.mediaflow-secrets/settings-encryption-key-2026-09-19.txt`（600）+ **待人工存入独立密钥管理系统** |
| 旧密钥处置 | 保留 30 天（至 2026-10-19），确认无回滚需求后销毁 |

**本次特殊说明**：轮换前的加密密钥是 `JWT_SECRET` 的回退值。轮换后 `JWT_SECRET` 仍用于签发 JWT，
但不再参与设置加密——**两者已解耦**，后续轮换互不影响。

**演练与生产执行的差异（已按用户要求调整执行顺序）**：
演练脚本首轮暴露"`nest build` 直接覆盖生产 dist"的风险，且原定顺序（先构建、后重加密）会在
"数据库已是新密文、旧服务仍持旧密钥"的窗口内造成解密失败。故生产执行改为**原子序列**：
停止服务 → 备份 dist/.env → dry-run → 写新密钥 → 改源码并构建 → 重加密 → 回读验证 → 启动 → 业务验证 → 审计。
