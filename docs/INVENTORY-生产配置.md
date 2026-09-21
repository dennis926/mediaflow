# MediaFlow 生产配置清单（脱敏）

> 用途：接手人一眼看清"线上到底跑着什么"。**本文件只记录"有哪些配置项、是否已配置"，绝不记录任何密钥值。**

## 一、服务器与运行时

| 项 | 值 |
| --- | --- |
| 操作系统 | Ubuntu 26.04 LTS，时区 `Asia/Shanghai`（北京时间为准） |
| Node.js | 22.22.1 |
| 包管理器 | pnpm（版本锁定在根 `package.json` 的 `packageManager`） |
| 数据库 | PostgreSQL 18.6（`127.0.0.1:5432`，库 `mediaflow`） |
| 缓存/队列 | Redis 8.0.5（`127.0.0.1:6379`，无密码，仅本机监听） |
| Web 服务器 | 宝塔 nginx（`/www/server/panel/vhost/nginx/`） |
| 项目根 | `/www/wwwroot/mediaflow` |

## 二、监听端口（均为本机监听，仅 80/443 对外）

| 端口 | 进程 | 说明 |
| --- | --- | --- |
| 80 / 443 | nginx | 对外入口（HTTPS 与 QUIC 均开） |
| 4000 | `mediaflow-api` | NestJS API（`/api/*`） |
| 3000 | `mediaflow-web` | Next.js PC 端 |
| 5432 / 6379 | PostgreSQL / Redis | 仅 `127.0.0.1` |
| 8080 | 宝塔面板相关 | 本机管理用 |

## 三、systemd 单元

| 单元 | 作用 | 备注 |
| --- | --- | --- |
| `mediaflow-api.service` | API 服务 | `WorkingDirectory=/www/wwwroot/mediaflow/apps/api`，`ExecStart=/usr/bin/node dist/main.js`，`UMask=0077`，日志追加到 `/var/log/mediaflow-api.log` |
| `mediaflow-web.service` | PC 前端 | `next start -p 3000 -H 127.0.0.1`，日志 `/var/log/mediaflow-web.log` |
| `mediaflow-review-api/web.service` | 历史遗留（另一个 AI 的版本） | **已停用**；**不要启动**——其 Worker 会加入同一条 Redis 消费组造成重复消费 |

服务通过 `apps/api` 的 `ConfigModule`（`envFilePath: ['../../.env', '.env']`）读取 **`/www/wwwroot/mediaflow/.env`**，systemd 单元本身不含密钥环境变量。

## 四、环境变量清单（只列键名与状态，值不记录）

来源：`/www/wwwroot/mediaflow/.env`（权限 600，已被 git 忽略）。

| 分组 | 键名 | 状态 |
| --- | --- | --- |
| 运行 | `NODE_ENV` `APP_HOST` `APP_PORT` `APP_URL` `WEB_URL` `H5_URL` `OAUTH_CALLBACK_BASE` | 已设置 |
| 安全 | `JWT_SECRET`（≥48 字符）`SETTINGS_ENCRYPTION_KEY`（≥32 字符）`AUTH_ENFORCED=true` `JWT_ACCESS_EXPIRES` `JWT_REFRESH_EXPIRES` | 已设置 |
| 数据库 | `DB_HOST` `DB_PORT` `DB_NAME` `DB_USER` `DB_PASSWORD` `DB_LOGGING` | 已设置 |
| Redis | `REDIS_HOST` `REDIS_PORT` `REDIS_PASSWORD`(空) | 已设置 |
| 对象存储 | `MINIO_ENDPOINT` `MINIO_PORT` `MINIO_ACCESS_KEY` `MINIO_SECRET_KEY` `MINIO_BUCKET` | 已设置（当前素材实际走本地磁盘 `uploads/`，MinIO 为预留） |
| AI | `AI_PROVIDER` `AI_MODEL` `AI_API_KEY` | 已设置（Key 亦加密存于数据库，界面显示掩码） |
| 发布 | `PUBLISH_WORKER_ENABLED=true` `PUBLISH_RETRY_INTERVAL_MS` | 已设置 |
| 平台凭证 | `WECHAT_MP_APP_ID/SECRET`、`DOUYIN_CLIENT_KEY/SECRET`、`XIAOHONGSHU_APP_ID/SECRET`、`XIAOHONGSHU_API_BASE` | **空**（待用户提供，属阶段 A 未完成项） |

可运行时修改的配置（数据库优先于环境变量）在「设置」页维护，分组：站点信息、角色与权限、素材库、AI 服务、合规词库、知识库、发布队列、通知渠道、平台密钥、**运行监控**。
`MEDIAFLOW_SETTING_OVERRIDE_<KEY>` 为**测试专用**覆盖通道（优先级最高），生产不得使用。

## 五、nginx 摘要

| 项 | 值 |
| --- | --- |
| 站点配置 | `/www/server/panel/vhost/nginx/auto.liangyijianye.cn.conf` |
| 域名 | `auto.liangyijianye.cn`（另有 `auto.needai.ren` 也反代到同一后端） |
| 静态根 | `/www/wwwroot/auto.liangyijianye.cn`（H5 在 `/h5/`） |
| API 反代 | `/api/` → `http://127.0.0.1:4000`（**显式 `proxy_cache off`**） |
| PC 反代 | `/` → `http://127.0.0.1:3000`（**显式 `proxy_cache off`**） |
| 证书 | `/www/server/panel/vhost/cert/auto.liangyijianye.cn/fullchain.pem`，到期 **2026-12-15**（宝塔自动续期） |

> 宝塔 nginx 全局配置里有 `proxy_cache cache_one`，命中缓存会让前端"看起来像样式没加载"。新站点必须在 vhost 里显式 `proxy_cache off`。

## 六、定时任务（root crontab）

| 时间 | 任务 | 作用 |
| --- | --- | --- |
| 每 5 分钟 | `/root/.hermes/scripts/mediaflow_monitor.sh` | 健康检查与自愈（含实例保活） |
| 每天 04:30 | `/root/.hermes/scripts/mediaflow_backup.sh` | 数据库备份（`umask 077` + `chmod 600`，写入 `/www/backup/mediaflow/`） |
| 应用内 | `QueueTrimTask`（每小时）、`TokenRefreshTask`、`NotificationCleanupTask`、`OpsMonitorTask`（每分钟唤醒、按配置间隔执行） | 队列修剪、平台令牌刷新、通知清理、运行监控 |
| 宝塔 | 每日 09:20 宝塔计划任务（站点/数据库） | 见 `/www/server/cron/` |

## 七、备份与恢复

| 项 | 值 |
| --- | --- |
| 数据库备份 | `/www/backup/mediaflow/mediaflow_*.sql.gz`（600；保留策略见备份脚本） |
| 迁移前备份 | `/www/backup/mediaflow/pre-*.sql.gz`（如 `pre-key-rotation-2026-09-19_0742.sql.gz`） |
| 配置备份 | `.env.bak-*`、`dist.bak-*`（同目录，600） |
| 恢复步骤 | 见 `docs/RUNBOOK-部署与回滚.md` 第四节（先留现场再恢复） |

## 八、数据基线（阶段 A 收尾时点）

| 表 | 行数（未删除） |
| --- | --- |
| `contents` | 1 |
| `users` | 2（`admin@liangyijianye.com`、`admin@mediaflow.local`） |
| `workspaces` | 1（默认工作区） |
| `publish_tasks` | 0 |
| `media_assets` | 0 |
| 加密行 `system_settings.value` | 2（`AI_API_KEY`、`AI_PROVIDER_CONFIGS`） |

## 八之二、数据库结构与约束（2026-09-21，B0.4 第 5 步后）

| 项目 | 数值 / 说明 |
| --- | --- |
| 迁移总数 | **41**（`typeorm_migrations`；其中 16 个来自 B0.4 第 5 步，3 个来自 B0.6） |
| 指向 `workspaces(id)` 的外键总数 | **16**：14 张业务/结构表 `ON DELETE CASCADE` + `workspace_export_jobs` `SET NULL` + `users` `SET NULL`（M8） |
| 刻意不加外键的表 | `audit_logs`、`ai_generations`、`workspace_purge_batches`、`system_settings`、`roles`（理由见 `DESIGN-外键补全-第5步.md` §2.3） |
| `workspaces` 自引用列 | 存在 **`workspaces.workspace_id` NOT NULL** 列（值为自身 id；工作区行的历史结构，建行时必须填） |
| `platforms.code` | **全局唯一索引**（`IDX_f2dfc2261c3cb3322162a3b061`）——不是按工作区唯一；写种子/测试数据时必须保证 code 全局不重复 |
| 账本新列 | `workspace_purge_batches.retained_export_jobs`（purge 时保留的导出任务数） |
| 例行巡检 | 跨工作区引用（`social_accounts` ↔ `platforms`）必须 = **0**（SQL 见 `RUNBOOK-purge演练.md` §7.4） |
| B0.6 新增 | `contents.ai_flag_exempt_reason`、`content_reviews.operator_ip`/`operator_ua`、表 `data_deletion_requests`（合规删除台账） |

## 九、变更纪律

1. 任何配置/代码变更走 `bash scripts/deploy.sh`（断言失败即拒绝启动）。
2. 涉及密钥、数据库结构、备份恢复的变更，先读对应 `docs/RUNBOOK-*.md`。
3. `.env` 只读不写脚本化改动；改完必须 `chmod 600` 并跑一次预检。
4. 生产不得使用测试覆盖通道（`MEDIAFLOW_SETTING_OVERRIDE_*`）。
