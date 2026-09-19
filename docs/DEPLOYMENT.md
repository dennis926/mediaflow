# MediaFlow 部署文档

## 1. 拓扑

```
浏览器 ──HTTPS──> nginx (auto.liangyijianye.cn)
                    ├── /h5/   → 静态文件（apps/h5 构建产物）
                    ├── /api/  → 127.0.0.1:4000  mediaflow-api.service
                    └── /      → 127.0.0.1:3000  mediaflow-web.service
                        ↓
        PostgreSQL 18（库/用户 mediaflow） + Redis 8（发布队列）
```

- 服务器：Ubuntu 26.04（香港），8C/7.9G 内存 + 4G swap
- 代码目录：`/www/wwwroot/mediaflow`（pnpm workspace）
- 日志：`/var/log/mediaflow-api.log`、`/var/log/mediaflow-web.log`、`/www/wwwlogs/auto.liangyijianye.cn.log`

## 2. 依赖准备

```bash
cd /www/wwwroot/mediaflow
cp .env.example .env          # 生产务必修改 JWT_SECRET（可用 openssl rand -base64 48）
NODE_ENV=development pnpm install
NODE_ENV=development pnpm build:packages
pnpm migrate && pnpm seed     # 建表 + 初始工作区/角色/平台/管理员
```

数据库与 Redis：

```bash
sudo -u postgres psql -c "CREATE ROLE mediaflow LOGIN PASSWORD '...'"
sudo -u postgres psql -c "CREATE DATABASE mediaflow OWNER mediaflow ENCODING 'UTF8'"
systemctl enable --now postgresql redis-server
```

> 本机未安装 Docker；`docker-compose.yml` 仅作目标环境参考。

## 3. 构建与发布

```bash
# 后端
NODE_ENV=production pnpm --filter @mediaflow/api run build
# 前端（必须 NODE_ENV=production，否则 Next 预渲染会失败）
NODE_ENV=production pnpm --filter @mediaflow/web run build
# 移动端（base=/h5/）
NODE_ENV=production pnpm --filter @mediaflow/h5 run build
cp -r apps/h5/dist/. /www/wwwroot/auto.liangyijianye.cn/h5/
# 浏览器插件
NODE_ENV=production pnpm --filter @mediaflow/plugin run build   # 产物 apps/plugin/dist

systemctl restart mediaflow-api mediaflow-web
```

## 4. systemd 单元

`/etc/systemd/system/mediaflow-api.service`

```ini
[Unit]
Description=MediaFlow API (NestJS)
After=network.target postgresql.service redis-server.service

[Service]
Type=simple
WorkingDirectory=/www/wwwroot/mediaflow/apps/api
Environment=NODE_ENV=production
ExecStart=/usr/bin/node dist/main.js
Restart=always
RestartSec=5
StandardOutput=append:/var/log/mediaflow-api.log
StandardError=append:/var/log/mediaflow-api.log

[Install]
WantedBy=multi-user.target
```

`/etc/systemd/system/mediaflow-web.service` 同理，`ExecStart=/www/wwwroot/mediaflow/node_modules/.bin/next start -p 3000 -H 127.0.0.1`，工作目录 `apps/web`。

```bash
systemctl daemon-reload && systemctl enable --now mediaflow-api mediaflow-web
```

## 5. nginx 关键片段

```nginx
# MediaFlow API
location ^~ /api/ {
    proxy_pass http://127.0.0.1:4000;
    proxy_set_header Host $http_host;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Proto $scheme;
    client_max_body_size 50m;
}
# MediaFlow 移动端（构建产物）
location ^~ /h5/ {
    alias /www/wwwroot/auto.liangyijianye.cn/h5/;
    try_files $uri $uri/ /h5/index.html;
}
# MediaFlow Web
location ^~ / {
    proxy_pass http://127.0.0.1:3000;
    proxy_set_header Host $http_host;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Proto $scheme;
}
```

## 6. 环境变量要点

| 变量 | 说明 |
| --- | --- |
| `NODE_ENV` | 生产 `production` |
| `DB_*` / `REDIS_*` | 数据库与 Redis 连接 |
| `JWT_SECRET` | **生产必须替换为随机值** |
| `SETTINGS_ENCRYPTION_KEY` | 后台密钥加密用；留空回退 JWT_SECRET |
| `APP_HOST` / `APP_PORT` | 生产建议 `127.0.0.1` / `4000`（只允许 nginx 访问） |
| `AI_*` / 平台密钥 | 可留空，改在「系统设置」页面维护 |
| `AUTH_ENFORCED` | 生产保持 `true` |
| `PUBLISH_WORKER_ENABLED` | 是否启动发布 Worker |

## 6.5 OAuth 授权绑定配置

1. 在平台后台创建应用并在「回调/授权域名」处登记（每个平台一条）：
   - 微信服务号：公众号后台 → 设置与开发 → 网页授权域名（上传 `MP_verify_xxx.txt` 到站点根目录，**不校验 ICP 备案**）
   - 抖音开放平台：应用 → 授权回调地址（**要求域名已备案**）
   - 小红书开放平台：应用 → 回调地址
2. 回调地址格式：`https://<站点>/api/accounts/oauth/<平台>/callback`
   - 平台标识：`wechat_mp`、`douyin`、`xiaohongshu`
3. `.env` 里的 `OAUTH_CALLBACK_BASE` 必须与平台登记的一致（默认取站点地址）；换域名只改这一行 + 平台后台。
4. 令牌刷新任务每 30 分钟检查一次即将过期的账号（`@nestjs/schedule`）。

> 域名建议：微信网页授权不要求备案，用香港站域名即可；**抖音要求回调域名备案**，
> 这种场景把回调域名换成已备案域名（如 `mf.liangyijianye.com`），只改 `OAUTH_CALLBACK_BASE` 与平台后台即可。

## 6.6 nginx 缓存（重要坑）

宝塔的 `/www/server/nginx/conf/proxy.conf` 在 **http 层全局开启了 `proxy_cache cache_one`**，
而 Next 的静态页响应头是 `s-maxage=31536000` → **nginx 会把整页缓存一年**，表现为"部署了新版本但页面还是旧的"。

本项目已在 vhost 中显式关闭：

```nginx
location ^~ /api/ { proxy_cache off; proxy_no_cache 1; proxy_cache_bypass 1; ... }
location ^~ /   { proxy_cache off; proxy_no_cache 1; proxy_cache_bypass 1; ... }
```

同时 `next.config.mjs` 里加了响应头策略：页面 `no-store`，`/_next/static/**` `immutable`。

发布后若仍看到旧页面：`rm -rf /www/server/nginx/proxy_cache_dir/*` 然后 `nginx -s reload`。

## 6.7 用户与审核（迁移说明）

`UserReviewEnhancements` 迁移新增：`users.must_change_password` / `users.invited_by` / `users.deleted_at`、`content_reviews.submitted_by` / `submitted_name` / `reviewer_name` / `decided_at`。
升级后旧数据自动兼容（新列可空）。

## 7. 升级与回滚

```bash
git pull                       # 或解压新版本覆盖
NODE_ENV=development pnpm install
NODE_ENV=development pnpm build:packages
pnpm migrate                   # 有迁移时
NODE_ENV=production pnpm --filter @mediaflow/api run build && systemctl restart mediaflow-api
NODE_ENV=production pnpm --filter @mediaflow/web run build && systemctl restart mediaflow-web
```

回滚：`git checkout <上一个提交>` 后重复上面的构建步骤；数据库回滚用 `pnpm --filter @mediaflow/api run migrate:revert`。

## 8. 巡检与排障

```bash
systemctl status mediaflow-api mediaflow-web nginx
curl -s https://<域名>/api/health
tail -f /var/log/mediaflow-api.log
curl -s -H "Authorization: Bearer <token>" https://<域名>/api/publish/queue/stats   # 队列长度/未确认/消费者
pnpm check:secrets            # 发布仓库前的密钥自检
# 端到端测试需要管理员凭据（仓库里不含密码）：
E2E_ADMIN_EMAIL=you@example.com E2E_ADMIN_PASSWORD=... pnpm --filter @mediaflow/api test
```

| 现象 | 排查 |
| --- | --- |
| 502 | 后端服务未启动或端口不符：`systemctl status mediaflow-api`、`ss -lntp | grep 4000` |
| 页面白屏 | 查看 `next` 日志与浏览器控制台；确认 `NODE_ENV=production` 构建 |
| 任务不执行 | `publish/queue/stats` 的 consumers 是否为 1；Worker 开关是否为 true |
| 迁移失败 | 检查 `DB_*`、数据库是否存在、是否已有同名表 |

## 8.5 数据库备份（必做）

`mediaflow` 库此前不在任何备份任务中（2026-09-17 审计发现并修复）。现在：

```bash
# 脚本：scripts/backup-db.sh（同时部署在 /root/.hermes/scripts/mediaflow_backup.sh）
# cron：每天 04:30 执行，保留 14 天
30 4 * * * /root/.hermes/scripts/mediaflow_backup.sh >> /var/log/mediaflow-backup.log 2>&1
```

- 导出前先写明文临时文件，校验「≥15 张表 + ≥10 个数据段」通过后才压缩落盘，避免留下坏备份
- 备份目录：`/www/backup/mediaflow/mediaflow_<日期>_<时间>.sql.gz`
- 恢复：`gunzip -c 备份文件 | psql -h 127.0.0.1 -U mediaflow -d mediaflow`
- 已做恢复演练：备份可成功导入到临时库（19 张表、用户/内容/设置数据齐全）

## 9. 备份

- 数据库：`pg_dump -U mediaflow mediaflow > mediaflow_$(date +%F).sql`
- 上传/构建产物：`apps/*/dist`、`/www/wwwroot/auto.liangyijianye.cn/h5`
- 配置：`.env`（含密钥，单独安全存放，不要提交到仓库）


## 交付给其他公司：改配置即可上线

1. **站点信息**：名称、副标题、公司、支持邮箱、品牌主色、Logo、每页条数、AI 标识文案 —— 「设置 → 站点信息」。
2. **AI 服务**：服务商/Key/模型/写作规范/各平台风格/随机度/最大输出/单价/限流与每日额度 —— 「设置 → AI 服务」。
3. **合规词库**：违规词 + 原因 + 建议 + 扣分权重 —— 「设置 → 合规词库」。
4. **知识库**：分类（可视化编辑）、引用条数、切片长度/重叠/片数、单文件上限、OCR 开关与参数 —— 「设置 → 知识库」。
5. **发布队列**：Worker 开关、重试次数与间隔、轮询参数、通知保留天数、队列名、AI 元数据开关 —— 「设置 → 发布队列」。
6. **角色与权限**：权限矩阵、角色显示名、登录有效期与免登录时长 —— 「设置 → 角色与权限」。
7. **平台密钥**：微信/抖音/小红书 AppID 与 Secret —— 「设置 → 平台密钥」。

### 初始化命令（新环境按顺序执行）

```bash
pnpm install && pnpm build:packages
pnpm migrate                                        # 建表/升表
pnpm seed                                           # 工作区、角色、平台、管理员
pnpm --filter @mediaflow/api run seed:knowledge     # 示例品牌资料（数据文件驱动）
pnpm --filter @mediaflow/api run seed:templates     # 示例文案模板（数据文件驱动）
pnpm --filter @mediaflow/api run build
# 生产由 systemd 承载：systemctl restart mediaflow-api mediaflow-web
```

### 初始化数据
- 示例品牌资料放在 `apps/api/src/database/seeds/sample-knowledge.json`，**可以直接替换成自己的资料**；
- 或者设 `SEED_SAMPLE_CONTENT=false` 跳过示例数据（推荐交付时这么做）；
- 也可以用 `SEED_KNOWLEDGE_FILE=/path/to/your.json` 指定自己的初始化文件；
- 知识库还能整包迁移：导出 JSON（含分类配置）→ 新环境导入。

### 浏览器插件品牌
- 插件名称、说明与 **API 域名**（`apiOrigin`，决定 host_permissions）都在 `apps/plugin/plugin.config.json`，或用环境变量 `PLUGIN_NAME` / `PLUGIN_DESCRIPTION` 覆盖后重新构建；
- 插件弹窗里的站点名是运行时从 `/api/public/site-config` 读取的，改后台配置即可，不用重新打包。


## 备份异地与健康巡检（可选，运维期）

**备份**：`/root/.hermes/scripts/mediaflow_backup.sh`（cron 每天 04:30）已支持

- `KEEP_DAYS`：本地保留天数（默认 14）；
- `BACKUP_REMOTE_COMMAND`：异地同步命令，用 `{file}` 占位本次备份路径，例如
  `BACKUP_REMOTE_COMMAND="rclone copy {file} mypan:mediaflow-backup/"`；
- `ALERT_WEBHOOK_URL`：备份失败或异地同步失败时推送告警。

把这些写进 `/root/.hermes/scripts/mediaflow-backup.env` 即可（不放进仓库）。

**巡检**：`/root/.hermes/scripts/mediaflow_monitor.sh`（cron 每 5 分钟）检查 `/api/health`：

- `MONITOR_PING_URL`：成功时 GET 一次，可对接 Uptime Kuma / Healthchecks.io 这样的外部心跳；
- `ALERT_WEBHOOK_URL` + `ALERT_AFTER_FAILURES`：连续失败 N 次才告警（默认 3，避免网络抖动误报）；
- 配置写 `/root/.hermes/scripts/mediaflow-monitor.env`。

**端到端测试**：`pnpm test:e2e` 会读取 `.env.e2e`（包含 `E2E_ADMIN_EMAIL`/`E2E_ADMIN_PASSWORD`，不进仓库）后跑完整的
登录 → 建内容 → AI 适配 → 建发布任务 → 查队列 → 通知 流程；缺少凭据文件时会明确报错而不是静默跳过。


## 为什么生产不用 Docker（与仓库里的 docker-compose.yml 的关系）

- `docker-compose.yml` **只用于本地开发**：起 PostgreSQL、Redis、MinIO 三个基础设施容器，方便在本机跑起来。
- 生产环境（当前服务器）**不使用 Docker**：应用以 systemd 单元运行，Nginx 负责 TLS 与反代，理由：
  1. 这台机器上数据库/Redis 是系统服务，已在跑，重复起容器会争端口和资源；
  2. 排障更直接（`journalctl -u mediaflow-api`、`systemctl status`），不需要额外理解容器网络；
  3. 备份/监控脚本直接读进程与文件，不用绕进容器。
- 如果你希望**用 Docker 交付**给别人：把 `apps/api`、`apps/web` 各自加一个 Dockerfile，compose 里补齐 `api`/`web` 服务
  并把 `DB_HOST`/`REDIS_HOST` 指向 compose 服务名即可；AGENTS.md 里列的命令（`pnpm dev`、`pnpm migrate`）在容器内同样适用。


## 日志轮转

已配置 `/etc/logrotate.d/mediaflow`：`/var/log/mediaflow*.log` 每天轮转、保留 14 天、压缩存储（`copytruncate` 不影响正在写入的进程）。
新增服务时如果日志名符合 `mediaflow*.log` 会自动纳入；如需调整保留天数改这一个文件即可。


## 安全响应头

Nginx 已在站点配置里统一加上：`Strict-Transport-Security`、`X-Content-Type-Options: nosniff`、
`X-Frame-Options: SAMEORIGIN`、`Referrer-Policy`、`Permissions-Policy`。
API 自身的跨域是**白名单制**（`WEB_URL` / `H5_URL` / `CORS_ORIGINS` + `chrome-extension://`），不是 `*`。

## 部署脚本（scripts/deploy.sh）与部署断言

**部署的唯一入口是 `scripts/deploy.sh`**，它为"坏配置不得上线"提供强制保证。

### 用法

```bash
bash scripts/deploy.sh                 # 断言 → 构建（API/PC/H5）→ 重启 → 健康校验
bash scripts/deploy.sh --check-only    # 只跑断言（巡检/演练，不做任何变更）
bash scripts/deploy.sh --with-migrate  # 额外执行数据库迁移
bash scripts/deploy.sh --api           # 只重建后端（前端不动）
```

### 强制断言（第 0 步：任一项失败即中止，**不重启任何服务**）

| 断言 | 要求 |
| --- | --- |
| `.env` 权限 | 必须 600 |
| 运行日志权限 | `/var/log/mediaflow-api.log`、`mediaflow-web.log` 为 640 |
| 备份权限 | `/www/backup/mediaflow/*.sql*` 为 600 |
| `AUTH_ENFORCED` | 必须 true（否则无令牌即可访问接口） |
| `PUBLISH_WORKER_ENABLED` | 必须 true（否则发布任务无人执行） |
| `SETTINGS_ENCRYPTION_KEY` | 非空且长度 ≥32（指纹化输出，不回显值） |
| `JWT_SECRET` | 长度 ≥48，且**指纹 ≠ 2026-09-19 泄露值**（`9d87f6490bc0`） |
| 密钥分离 | `JWT_SECRET` ≠ `SETTINGS_ENCRYPTION_KEY` |
| 队列消费者数 | ≤1（严格模式为失败项，多实例会造成重复消费） |
| 健康接口 | 200 |
| 上传上限 | `MEDIA_MAX_FILE_MB` 环境变量与数据库配置一致；代码内不得再有静态硬上限，且必须走磁盘暂存 |
| 依赖下限 | `nodemailer` ≥ 9.1.1（防回退） |
| 依赖漏洞（`--strict`） | 不得存在 high/critical |

### 失败行为（已实测）

断言失败时脚本在**第 0 步**即中止：不安装、不构建、不重启。实测耗时 3.3 秒，
服务 MainPID 与 `dist` 时间戳均未变化，线上保持可用（健康 200）。

### 断言与密钥的关系

所有密钥类断言**只输出长度与 sha256 前 12 位指纹**，绝不回显密钥值（2026-09-19 的
JWT_SECRET 泄露事件即因回显造成，详见 `docs/RUNBOOK-密钥轮换.md` 的禁止事项）。

## 持续集成（.github/workflows/ci.yml）

CI 拆成两个并行 job，任一失败整个 CI 变红：

| job | 步骤 |
| --- | --- |
| 静态检查 | `pnpm install --frozen-lockfile` → `pnpm -r typecheck` → `pnpm -r lint` → `pnpm check:secrets` → `bash scripts/preflight.sh --config-only` → `pnpm audit --prod --audit-level=high` |
| 单元测试 | `pnpm install --frozen-lockfile` → `pnpm build:packages` → `pnpm -r test` |

**为什么拆两个 job**：串行执行约 4.5-5 分钟，接近 5 分钟上限；并行后墙钟≈最长 job + 安装时间。
**明确不做**：不跑 E2E（需要真实数据库/Redis 与管理员凭据，属发布前人工步骤）、不降低 audit 等级、不跳过步骤。

### 待办（必须由仓库管理员在 GitHub 网页完成）

- [ ] **开启分支保护**：Settings → Branches → Add rule（`main`）→ 勾选 **Require status checks to pass before merging**，并选中 CI 的 `static` 与 `test` 两个 job。这一步是"CI 失败必须阻止合并"的唯一落地方式，代码侧无法代替。
- [ ] 若仓库尚未推送到 GitHub，CI 不会运行——请先把仓库推到远程（例如 `dennis926/mediaflow`）。

### 本地等价命令（提交前自查）

```bash
pnpm -r typecheck && pnpm -r lint && pnpm check:secrets && pnpm -r test
bash scripts/preflight.sh --config-only
pnpm audit --prod --audit-level=high
```
