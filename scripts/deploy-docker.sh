#!/usr/bin/env bash
# MediaFlow 容器化部署（B0.9）
#
# 顺序（任一步失败即中止，且**不会**动正在运行的服务）：
#   0. 断言：.env.docker 存在且 600、密钥长度达标、compose 配置合法
#   1. 打 tag（默认 git 短 sha + 时间戳）并构建镜像
#   2. **迁移先行**：一次性容器里跑 node dist/database/cli.js migrate（失败即退出）
#   3. docker compose --env-file .env.docker up -d（只替换有变化的服务）
#   4. 健康校验：容器 healthcheck 状态 + curl /api/health
#   5. 记录 last-good / previous 镜像 tag（供一键回滚）
#
# 用法：bash scripts/deploy-docker.sh [tag]
set -Eeuo pipefail
cd "$(dirname "$0")/.."

TAG="${1:-$(git rev-parse --short HEAD 2>/dev/null || echo nogit)-$(date +%Y%m%d%H%M)}"
export MEDIAFLOW_TAG="$TAG"
STATE_DIR=".deploy"
mkdir -p "$STATE_DIR"

step() { echo; echo "== $* =="; }
die() { echo "✗ $*" >&2; exit 1; }

step "第 0 步：部署断言"
[ -f .env.docker ] || die "缺少 .env.docker（从 .env.docker.example 复制并填密钥）"
perm=$(stat -c %a .env.docker)
[ "$perm" = "600" ] || die ".env.docker 权限应为 600，当前 $perm"
# shellcheck disable=SC1091
set -a; . ./.env.docker; set +a
[ "${#JWT_SECRET}" -ge 48 ] || die "JWT_SECRET 至少 48 字符（当前 ${#JWT_SECRET}）"
[ "${#SETTINGS_ENCRYPTION_KEY}" -ge 32 ] || die "SETTINGS_ENCRYPTION_KEY 至少 32 字符（当前 ${#SETTINGS_ENCRYPTION_KEY}）"
[ "$JWT_SECRET" != "$SETTINGS_ENCRYPTION_KEY" ] || die "两个密钥不能相同"
docker compose --env-file .env.docker config --quiet || die "compose 配置不合法"
echo "  断言通过（tag=$TAG）"

step "第 1 步：构建镜像"
docker compose --env-file .env.docker build || die "镜像构建失败"

# 同时把镜像也打成 :local —— 手工执行 `docker compose ...` 时若没带 MEDIAFLOW_TAG，
# compose 会用 ${MEDIAFLOW_TAG:-local}，不打这个标签就会命中**旧镜像**（实测踩过：种子跑的是老代码）
docker tag "mediaflow-api:$TAG" mediaflow-api:local
docker tag "mediaflow-web:$TAG" mediaflow-web:local || true

step "第 2 步：先起基础设施（数据库 / Redis）并等健康"
# 为什么必须有这一步：迁移用一次性容器跑（--no-deps 不连带起依赖），
# 若 postgres 还没起来，容器内会解析不到服务名（实测报 getaddrinfo EAI_AGAIN postgres）。
docker compose --env-file .env.docker up -d --wait postgres redis || die "基础设施启动失败"

step "第 2b 步：数据库迁移（失败即中止，不影响已运行服务）"
docker compose --env-file .env.docker run --rm --no-deps api node dist/database/cli.js migrate || die "迁移失败，已中止部署"

step "第 3 步：启动/更新服务"
docker compose --env-file .env.docker up -d || die "compose up 失败"

step "第 4 步：健康校验"
sleep 8
for service in api worker web; do
  state=$(docker compose --env-file .env.docker ps --format '{{.Service}} {{.State}} {{.Status}}' | awk -v s="$service" '$1==s {print $2" "$3" "$4}' || true)
  echo "  $service: ${state:-未知}"
done
code=$(curl -s -o /dev/null -w '%{http_code}' http://127.0.0.1:4300/api/health || echo 000)
[ "$code" = "200" ] || die "健康检查未通过（HTTP $code）—— 回滚：bash scripts/rollback-docker.sh"
echo "  健康检查通过（HTTP 200）"

step "第 5 步：记录镜像 tag（供回滚）"
if [ -f "$STATE_DIR/last-good-tag" ]; then cp "$STATE_DIR/last-good-tag" "$STATE_DIR/previous-tag"; fi
echo "$TAG" > "$STATE_DIR/last-good-tag"
echo "  last-good=$TAG；previous=$(cat "$STATE_DIR/previous-tag" 2>/dev/null || echo '（首次部署）')"

echo
echo "✓ 容器化部署完成：$TAG"
echo "  站点（宿主端口）：api http://127.0.0.1:4300/api ｜ web http://127.0.0.1:3300"
echo "  回滚：bash scripts/rollback-docker.sh"
