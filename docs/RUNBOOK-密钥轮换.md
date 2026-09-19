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

## 轮换后 24 小时观察期

轮换完成不等于结束。密钥类变更的故障常在数小时后以"某个功能悄悄不可用"的形式出现，因此强制观察 24 小时。

| 动作 | 频率 | 方式 |
| --- | --- | --- |
| 健康检查（本机 + 公网） | 30 分钟 | `scripts/post-rotation-watch.sh`（异常才告警，正常只写日志） |
| 密钥/解密/AI 错误扫描 | 30 分钟 | 同上（扫描 `/var/log/mediaflow-api.log`） |
| 密文解密抽查 | 观察期结束时 | `apps/api/scripts/verify-settings-key.cjs`（只读，不应失败） |
| AI 调用成功率 | 观察期结束时 | `ai_generations` 表近 24 小时成功/失败计数 |
| 汇总报告 | T+24h | `scripts/post-rotation-report.sh` |

观察期内的日志：`/root/.hermes/workspace/mediaflow_key_rotation_watch.log`。

**若发现 AI 调用失败或解密错误**：不要反复重启尝试，直接执行下方回滚步骤。

### 回滚步骤（完整 9 步，不得只做部分）

```bash
TS=202609190820                      # 备份时间戳（按实际替换）
systemctl stop mediaflow-api                                        # 1 停止服务
pg_dump -h 127.0.0.1 -U mediaflow mediaflow | gzip > /www/backup/mediaflow/failed-attempt-$(date +%Y%m%d_%H%M).sql.gz   # 2 先留存现场
gunzip -c /www/backup/mediaflow/pre-key-rotation-2026-09-19_0742.sql.gz | PGPASSWORD=mediaflow_dev psql -h 127.0.0.1 -U mediaflow -d mediaflow   # 3 恢复数据库
cp /www/backup/mediaflow/.env.bak-$TS /www/wwwroot/mediaflow/.env && chmod 600 /www/wwwroot/mediaflow/.env             # 4 恢复 .env（SETTINGS_ENCRYPTION_KEY 回到空值）
cd /www/wwwroot/mediaflow && git checkout apps/api/src/common/crypto.service.ts                                        # 5 恢复源码
rm -rf apps/api/dist && cp -a /www/backup/mediaflow/dist.bak-$TS apps/api/dist                                         # 6 恢复 dist
systemctl start mediaflow-api                                        # 7 启动
curl -s -o /dev/null -w '%{http_code}\n' http://127.0.0.1:4000/api/health                                            # 8 健康应为 200
cd apps/api && node scripts/verify-settings-key.cjs                  # 9 解密验证（回滚后旧密钥应能解密全部行）
```

### 第 2 次轮换：2026-09-19（JWT_SECRET，因执行日志泄露）

| 项 | 值 |
| --- | --- |
| 原因 | 第 1 次轮换时，辅助命令 `grep '^JWT_SECRET=' .env` 的**输出被回显**到执行日志与对话中，泄露事实不可撤回 |
| 执行人 | 运维脚本（人工监督），用户批准（任务 8b） |
| 旧指纹 | `9d87f6490bc0`（48 字符） |
| 新指纹 | `7c6f756673e3`（48 字符，`openssl rand -base64 36` → 恰好 48 字符） |
| 影响 | 全部 access/refresh 令牌立即失效，2 个用户需重新登录；**不影响**密文解密、账号绑定、内容数据 |
| 停机 | 仅重启 API 约 4 秒 |
| 验证 | 旧 access → 401；旧 refresh → 401；新登录成功；新令牌读 AI 配置与 AI 测试正常；密文 2/2 仍可解密 |
| 审计 | `settings.jwt_secret.rotated`（含新旧指纹，不含密钥值） |
| 通知 | 站内通知「请重新登录」（type `system.security_notice`） |
| 备份 | `.env.bak-jwt-202609190825` |

**关键结论：`JWT_SECRET` 与设置加密已解耦。** 第 1 次轮换后 `SETTINGS_ENCRYPTION_KEY` 独立承担密文加解密，
因此本次轮换 JWT_SECRET **完全不影响** `AI_API_KEY` / `AI_PROVIDER_CONFIGS` 的解密。
后续若要再次轮换 JWT_SECRET，可随时单独进行。

**注意**：`openssl rand -base64 48` 产出 **64** 字符；若要求 48 字符（与历史格式一致），应使用
`openssl rand -base64 36`（36 字节 → 48 字符，无填充）。

## 禁止事项（重要）

1. **任何 `grep` / `sed` / `awk` / `echo` 输出密钥类变量前，必须先做指纹化处理**——只输出 `sha256 前 12 位`，
   绝不回显原值。2026-09-19 的 JWT_SECRET 泄露即由此产生（辅助函数直接打印了 grep 结果）。
2. 不得在聊天、邮件、工单、文档中传递密钥明文。
3. 不得把密钥写入代码、日志、审计 payload、工单截图。
4. 不得先改 `.env` 后备份；不得跳过临时库演练。
5. 不得用同一密钥同时承担登录签名与数据加密（本次教训：JWT_SECRET 既是签名密钥又是加密主密钥，
   导致"签名密钥泄露"被迫连带评估数据安全）。
