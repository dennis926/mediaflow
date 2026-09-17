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
```

| 现象 | 排查 |
| --- | --- |
| 502 | 后端服务未启动或端口不符：`systemctl status mediaflow-api`、`ss -lntp | grep 4000` |
| 页面白屏 | 查看 `next` 日志与浏览器控制台；确认 `NODE_ENV=production` 构建 |
| 任务不执行 | `publish/queue/stats` 的 consumers 是否为 1；Worker 开关是否为 true |
| 迁移失败 | 检查 `DB_*`、数据库是否存在、是否已有同名表 |

## 9. 备份

- 数据库：`pg_dump -U mediaflow mediaflow > mediaflow_$(date +%F).sql`
- 上传/构建产物：`apps/*/dist`、`/www/wwwroot/auto.liangyijianye.cn/h5`
- 配置：`.env`（含密钥，单独安全存放，不要提交到仓库）
