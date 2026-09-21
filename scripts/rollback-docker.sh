#!/usr/bin/env bash
# MediaFlow 一键回滚（B0.9）：切回上一版镜像 tag 并重启容器
#
# 用法：
#   bash scripts/rollback-docker.sh                 # 回滚到 .deploy/previous-tag
#   bash scripts/rollback-docker.sh <tag>           # 回滚到指定 tag
#
# 镜像 tag 由 deploy-docker.sh 记录。回滚**不动数据库**：迁移已经应用过就保持应用状态
# （迁移都是向后兼容的增量；如需回滚迁移，用 docker compose --env-file .env.docker run --rm api node dist/database/cli.js migrate:revert）
set -Eeuo pipefail
cd "$(dirname "$0")/.."
STATE_DIR=".deploy"

TARGET="${1:-$(cat "$STATE_DIR/previous-tag" 2>/dev/null || true)}"
[ -n "$TARGET" ] || { echo "✗ 没有可回滚的 tag（.deploy/previous-tag 不存在）：请显式指定 tag" >&2; exit 1; }
CURRENT="$(cat "$STATE_DIR/last-good-tag" 2>/dev/null || echo '（未知）')"

echo "== 回滚：$CURRENT → $TARGET =="
export MEDIAFLOW_TAG="$TARGET"
if ! docker image inspect "mediaflow-api:$TARGET" >/dev/null 2>&1; then
  echo "  本地没有 mediaflow-api:$TARGET 镜像，尝试构建该 tag（若是历史提交，请先 git checkout 对应提交）"
  docker compose --env-file .env.docker build || { echo "✗ 构建失败，无法回滚" >&2; exit 1; }
fi

docker compose --env-file .env.docker up -d
sleep 8
code=$(curl -s -o /dev/null -w '%{http_code}' http://127.0.0.1:4300/api/health || echo 000)
if [ "$code" != "200" ]; then
  echo "✗ 回滚后健康检查未通过（HTTP $code）" >&2
  exit 1
fi
echo "$TARGET" > "$STATE_DIR/last-good-tag"
echo "  previous-tag 保持为 $CURRENT（可再切回去）"
echo "✓ 已回滚到 $TARGET，健康检查通过"
