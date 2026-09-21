# RUNBOOK：容器化部署与回滚（B0.8 / B0.9）

> 本手册描述 `docker-compose.yml` 这条部署路径。**当前生产仍以 systemd 运行**（见 `INVENTORY-生产配置.md`），
> 容器栈使用独立端口，可以与本机 systemd 版并存做灰度；正式切换需要停 systemd 单元并把 nginx 反代指到容器端口。

## 一、前置条件

| 项 | 要求 | 现状 |
| --- | --- | --- |
| Docker | 20.10+，含 compose v2 | **29.1.3（2026-09-21 为 B0.8 验证安装）** |
| 环境文件 | `.env.docker`（从 `.env.docker.example` 复制）、权限 **600** | 已生成，600，已被 `.gitignore` 忽略 |
| 端口 | api `4300`、web `3300`（宿主）；数据库与 Redis **不映射到宿主** | 与 systemd 版（4000/3000）不冲突 |
| 密钥 | `JWT_SECRET ≥ 48`、`SETTINGS_ENCRYPTION_KEY ≥ 32`、两者不同 | `deploy-docker.sh` 第 0 步会断言 |

### ⚠️ 必须带 `--env-file .env.docker`

```bash
docker compose --env-file .env.docker <命令>
```

**原因（实测踩过）**：compose 默认读取项目目录下的 `.env`，而本仓库的 `.env` 是**生产环境**文件——
不带这个参数会出现"postgres 容器用生产口令初始化、api 容器用容器口令连接"的认证失败，
更糟的是可能把生产密钥插值进容器配置。`scripts/deploy-docker.sh` 与 `scripts/rollback-docker.sh` 已固化该参数。

## 二、部署

```bash
cd /www/wwwroot/mediaflow
bash scripts/deploy-docker.sh              # 自动生成 tag（git 短 sha + 时间戳）
bash scripts/deploy-docker.sh v1.2.0       # 指定 tag
```

脚本顺序（任一步失败即中止，**不动正在运行的服务**）：

0. 断言：`.env.docker` 存在且 600、密钥长度达标、两个密钥不同、`compose config` 合法
1. `docker compose build`（API 与 Web 多阶段构建）
2. **迁移先行**：`docker compose run --rm --no-deps api node dist/database/cli.js migrate`
   —— 失败即退出（此时旧版容器仍在服务）
3. `docker compose up -d`（只替换有变化的容器）
4. 健康校验：容器状态 + `curl http://127.0.0.1:4300/api/health`（非 200 即失败并提示回滚）
5. 记录 `.deploy/last-good-tag`（上一版挪到 `.deploy/previous-tag`，供一键回滚）

## 三、回滚

```bash
bash scripts/rollback-docker.sh            # 回滚到 .deploy/previous-tag
bash scripts/rollback-docker.sh v1.2.0     # 回滚到指定 tag
```

- 回滚只切镜像 tag 并重启容器，**不动数据库**；
- 迁移默认保持已应用状态（本项目所有迁移都是向后兼容的增量）；
  确需回滚迁移时：`docker compose --env-file .env.docker run --rm api node dist/database/cli.js migrate:revert`
  （逐个回滚，见 `RUNBOOK-部署与回滚.md` §4.4）。

## 四、日常运维

```bash
docker compose --env-file .env.docker ps                       # 状态与 healthcheck
docker compose --env-file .env.docker logs -f api worker web   # 日志
docker compose --env-file .env.docker restart api              # 只重启 API
docker compose --env-file .env.docker down                     # 停止（保留数据卷）
docker compose --env-file .env.docker down -v                  # 停止并删除数据卷（⚠️ 数据库一起删）
```

| 服务 | 角色 | 端口 | 说明 |
| --- | --- | --- | --- |
| `postgres` | 数据库 | 容器内 5432（不发布） | 卷 `postgres-data`；healthcheck `pg_isready` |
| `redis` | 队列/缓存 | 容器内 6379（不发布） | 卷不落盘（`appendonly no`） |
| `api` | HTTP API（**不含消费者**） | 宿主 4300 → 容器 4000 | `PUBLISH_WORKER_ENABLED=false` |
| `worker` | 发布队列消费者 | 无端口 | `PUBLISH_WORKER_ENABLED=true`；与 api 同镜像，入口 `dist/worker.js` |
| `web` | Next.js 前端 | 宿主 3300 → 容器 3000 | healthcheck 抓首页 |

**为什么 api 与 worker 分开**：发布队列**只允许一个消费者**（`scripts/preflight.sh` 第 3 节断言），
拆成两个容器后语义清晰：api 不消费、worker 不监听端口。两者共用 `api-uploads` 卷。

## 五、与 systemd 版的关系（灰度切换步骤）

当前生产由 systemd 提供（`mediaflow-api.service`、`mediaflow-web.service`，端口 127.0.0.1:4000/3000）。
若要切到容器：

1. 先按本文档把容器栈跑起来并验证 `http://127.0.0.1:4300/api/health` = 200 与 `http://127.0.0.1:3300/` 可访问；
2. 数据迁移：`pg_dump` 生产库 → 导入容器库（或用同一份数据库，把 `DB_HOST` 指向宿主并开放 5432 到容器网络）；
3. 改 nginx 反代到 4300/3300，`nginx -t && systemctl reload nginx`；
4. `systemctl stop mediaflow-api mediaflow-web && systemctl disable mediaflow-api mediaflow-web`；
5. 回滚路径：反向操作即可（把 nginx 指回 4000/3000、重新 enable 两个单元）。

> 注意：**不要在同一个数据库上同时跑 systemd 版与容器版的消费者**（两个消费者 = 重复消费风险）。
> 切换期间让容器 `worker` 先不动，或用 `PUBLISH_WORKER_ENABLED=false` 起容器。

## 六、故障处置

| 症状 | 排查 |
| --- | --- |
| `password authentication failed` | 用了没带 `--env-file .env.docker` 的命令（postgres 与 api 口令来源不一致）；重建时 `down -v` 让库用容器口令重新初始化 |
| `port is already allocated` | 4300/3300 被占；`ss -ltnp` 查占用，或改 compose 的宿主端口 |
| 容器 healthcheck 一直 starting | `docker compose logs api`；常见是迁移没跑（先执行第 2 步）或密钥长度不达标导致进程退出 |
| `node dist/database/cli.js` 报未知命令 | 只支持 `migrate` / `migrate:revert` / `seed` |
| 队列任务不执行 | 检查 `worker` 容器是否在跑、`PUBLISH_WORKER_ENABLED` 是否为 true（api 容器应为 false） |
