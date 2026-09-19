# MediaFlow 部署与回滚手册

> 适用对象：接手本项目的运维/开发人员。**部署唯一入口是 `scripts/deploy.sh`**，不要手工 `pnpm build && systemctl restart` 拼步骤——
> 脚本会把"坏配置不得上线"变成硬约束。

## 一、部署入口

```bash
cd /www/wwwroot/mediaflow

bash scripts/deploy.sh                 # 断言 → 构建（API/PC/H5）→ 重启 → 健康校验
bash scripts/deploy.sh --check-only    # 只跑断言（巡检/演练，不做任何变更）
bash scripts/deploy.sh --config-only --check-only   # 只校验配置与代码约束（不连库、不看服务，CI 可用）
bash scripts/deploy.sh --with-migrate  # 额外执行数据库迁移
bash scripts/deploy.sh --api           # 只重建后端（前端不动，改后端时的日常路径）
```

典型耗时：`--api` 约 30 秒；全量（含 Web/H5 构建）约 70 秒。

### 第 0 步断言（失败即中止，**不安装、不构建、不重启**）

| 断言 | 要求 |
| --- | --- |
| `.env` 权限 | 600 |
| 运行日志权限 | `/var/log/mediaflow-api.log`、`mediaflow-web.log` 为 640 |
| 备份权限 | `/www/backup/mediaflow/*.sql*` 为 600 |
| `AUTH_ENFORCED` | `true`（否则无令牌可访问接口） |
| `PUBLISH_WORKER_ENABLED` | `true`（否则发布任务永不执行） |
| `SETTINGS_ENCRYPTION_KEY` | 非空且长度 ≥ 32 |
| `JWT_SECRET` | 长度 ≥ 48，且指纹 ≠ 历史泄露值 `9d87f6490bc0` |
| 密钥分离 | `JWT_SECRET` ≠ `SETTINGS_ENCRYPTION_KEY` |
| 队列消费者数 | ≤ 1（严格模式为失败项） |
| 健康接口 | 200 |
| 上传上限 | `MEDIA_MAX_FILE_MB` 环境变量与数据库一致；代码无静态硬上限；走磁盘暂存；失败路径清理临时文件 |
| 依赖下限 | `nodemailer` ≥ 9.1.1 |
| 依赖漏洞（`--strict`） | 无 high/critical |

**失败行为已验证**：断言失败时脚本在第 0 步中止（实测 3.3 秒），服务 MainPID 与 `dist` 时间戳均不变，线上继续可用。

## 二、部署步骤（脚本内部顺序）

1. 断言（见上）。
2. `pnpm install --frozen-lockfile` + `pnpm build:packages`（共享包）。
3. `pnpm --filter @mediaflow/api run build`（Nest 编译 → `apps/api/dist`）。
4. `pnpm --filter @mediaflow/web run build`（Next.js）。
5. `pnpm --filter @mediaflow/h5 run build` → 发布到 `/www/wwwroot/auto.liangyijianye.cn/h5`（**发布前清理上一版 hash 产物**）。
6. `systemctl restart mediaflow-api`（`--api` 时不动 web）。
7. 健康校验：本机 `http://127.0.0.1:4000/api/health` 与公网 `https://auto.liangyijianye.cn/api/health` 都必须 200；失败会打印回滚提示并以非 0 退出。

> **注意**：`NODE_ENV=production` 必须用于构建（Next.js 构建依赖它）；`pnpm install` 必须用 `NODE_ENV=development`，否则会跳过 devDependencies（项目 `.npmrc` 已设 `production=false`）。

## 三、部署后核验清单

```bash
curl -s -o /dev/null -w '%{http_code}\n' https://auto.liangyijianye.cn/api/health      # 200
curl -s -o /dev/null -w '%{http_code}\n' https://auto.liangyijianye.cn/               # 200（PC）
curl -s -o /dev/null -w '%{http_code}\n' https://auto.liangyijianye.cn/h5/            # 200（H5）
cd apps/api && node scripts/verify-settings-key.cjs                                    # 2/2 行可解密
bash scripts/preflight.sh                                                              # 关键失败 0
```

## 四、回滚

### 4.1 代码回滚（最常见）

```bash
cd /www/wwwroot/mediaflow
git log --oneline | head -5                 # 找到上一个正常提交
git checkout <上一个提交>                    # 或 git revert <本次提交>
bash scripts/deploy.sh --api                # 重新构建 + 重启 + 健康校验
```

### 4.2 前端回滚

H5 是静态产物：`git checkout <上一个提交> && bash scripts/deploy.sh`（会重新构建并覆盖发布目录）。
PC 端由 `mediaflow-web` 进程直接跑源码构建产物，回滚同 4.1。

### 4.3 配置/密钥回滚

`.env` 与加密主密钥的回滚步骤**不要自己临时发挥**，按 `docs/RUNBOOK-密钥轮换.md` 的 9 步手册执行
（含"先留存现场再恢复备份"、恢复 `.env`/`dist` 备份、重启、解密验证）。

### 4.4 数据库回滚

```bash
ls -lt /www/backup/mediaflow/*.sql.gz                       # 选最近的备份
pg_dump -h 127.0.0.1 -U mediaflow mediaflow | gzip > /www/backup/mediaflow/failed-attempt-$(date +%Y%m%d_%H%M).sql.gz   # 先留现场
gunzip -c /www/backup/mediaflow/<备份文件>.sql.gz | PGPASSWORD=<密码> psql -h 127.0.0.1 -U mediaflow -d mediaflow
systemctl restart mediaflow-api
```
**先备份再恢复**是硬要求：否则事后无法分析。

## 五、常见故障处置

| 现象 | 首查 | 处置 |
| --- | --- | --- |
| 部署后健康非 200 | `tail -50 /var/log/mediaflow-api.log` | 多为配置类错误（密钥/数据库连接）：按日志提示修 `.env`，或按第四节回滚 |
| 启动即报 `SETTINGS_ENCRYPTION_KEY 必须配置且长度 ≥ 32` | `.env` 该键 | 生成：`openssl rand -base64 32`；已有密文时**必须**沿用原密钥，否则密文不可解 |
| 启动即报 `JWT_SECRET 必须配置且长度 ≥ 48` | `.env` 该键 | 生成：`openssl rand -base64 36`（36 字节 → 48 字符）；轮换会使全部会话失效 |
| 页面样式"回到未加载"状态 | nginx 全局是否命中 `proxy_cache` | vhost 中已有 `proxy_cache off`；新增站点要照抄 |
| 上传报 413 / 429 | `MEDIA_MAX_FILE_MB`、`MEDIA_MAX_CONCURRENT_UPLOADS` | 413 = 超单文件上限；429 = 并发超限（每人默认 3） |
| 发布任务一直 pending | 队列消费者数、`/api/publish/queue/health` | 确认只有一个 Worker 在跑；卡死任务用「队列运维」强制重排 |

## 六、待办（需要仓库管理员在 GitHub 侧完成）

- **分支保护**：`main` 分支要求 `CI` 检查通过才能合并（Settings → Branches → Require status checks，勾选 `ci`）。
  这是"CI 失败必须阻止合并"的落地动作，代码侧无法代替。
