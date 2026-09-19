#!/usr/bin/env bash
# MediaFlow 部署脚本：**断言通过才部署**。
#
# 设计原则：任何关键断言失败 → 立即中止，且不重启任何服务（服务保持当前状态，绝不让坏配置上线）。
#
# 用法：
#   bash scripts/deploy.sh                 # 断言 + 构建 + 重启 + 健康校验
#   bash scripts/deploy.sh --check-only    # 只跑断言（部署演练/巡检用）
#   bash scripts/deploy.sh --with-migrate  # 额外执行数据库迁移
#   bash scripts/deploy.sh --api           # 只重建 API（前端不动）
#
# 退出码：0 = 成功；1 = 断言失败或步骤失败（均已中止，未留下半成品）。
set -uo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

CHECK_ONLY=0
WITH_MIGRATE=0
API_ONLY=0
for arg in "$@"; do
  case "$arg" in
    --check-only) CHECK_ONLY=1 ;;
    --with-migrate) WITH_MIGRATE=1 ;;
    --api) API_ONLY=1 ;;
    *) echo "未知参数：$arg"; exit 2 ;;
  esac
done

say() { printf '\n\033[1m== %s ==\033[0m\n' "$1"; }
ok() { printf '  \033[32m✓\033[0m %s\n' "$1"; }
bad() { printf '  \033[31m✗ %s\033[0m\n' "$1"; }

say "第 0 步：断言（失败即中止，不重启服务）"
if ! bash scripts/preflight.sh --strict; then
  bad "预检未通过 —— 已中止部署，服务保持当前运行状态（未重启）"
  exit 1
fi
ok "断言全部通过"

if [[ $CHECK_ONLY == 1 ]]; then
  echo
  ok "--check-only：断言通过，未做任何变更"
  exit 0
fi

say "第 1 步：安装依赖与构建共享包"
export NODE_ENV=development
pnpm install --frozen-lockfile || { bad "依赖安装失败"; exit 1; }
pnpm build:packages || { bad "共享包构建失败"; exit 1; }
ok "依赖与共享包就绪"

say "第 2 步：构建后端"
export NODE_ENV=production
pnpm --filter @mediaflow/api run build || { bad "API 构建失败（未重启服务，旧版本继续运行）"; exit 1; }
ok "API 构建完成"

if [[ $API_ONLY != 1 ]]; then
  say "第 3 步：构建前端（PC）"
  pnpm --filter @mediaflow/web run build || { bad "Web 构建失败"; exit 1; }
  ok "Web 构建完成"

  say "第 4 步：构建并发布 H5"
  pnpm --filter @mediaflow/h5 run build || { bad "H5 构建失败"; exit 1; }
  H5_TARGET=/www/wwwroot/auto.liangyijianye.cn/h5
  [[ -d "$H5_TARGET" ]] || { bad "H5 目标目录不存在：$H5_TARGET"; exit 1; }
  # 先清掉上一版带 hash 的产物：否则每次发布都会累积旧 bundle（磁盘白占 + 可能被缓存命中旧版）
  rm -rf "$H5_TARGET"/assets "$H5_TARGET"/index.html
  cp -r apps/h5/dist/. "$H5_TARGET"/ || { bad "H5 发布失败"; exit 1; }
  ok "H5 已发布到 $H5_TARGET（已清理上一版产物，当前 $(find "$H5_TARGET"/assets -type f | wc -l) 个资源文件）"
fi

if [[ $WITH_MIGRATE == 1 ]]; then
  say "第 4b 步：数据库迁移"
  pnpm migrate || { bad "迁移失败"; exit 1; }
  ok "迁移完成"
fi

say "第 5 步：重启服务"
systemctl restart mediaflow-api || { bad "mediaflow-api 重启失败"; exit 1; }
[[ $API_ONLY == 1 ]] || systemctl restart mediaflow-web
ok "服务已重启"

say "第 6 步：健康校验（失败则指出回滚方式）"
health_code=000
for _ in $(seq 1 12); do
  sleep 2
  health_code="$(curl -s -o /dev/null -w '%{http_code}' -m 5 http://127.0.0.1:4000/api/health || echo 000)"
  [[ "$health_code" == "200" ]] && break
done
public_code="$(curl -s -o /dev/null -w '%{http_code}' -m 10 https://auto.liangyijianye.cn/api/health || echo 000)"
if [[ "$health_code" == "200" && "$public_code" == "200" ]]; then
  ok "健康检查通过（本机 $health_code / 公网 $public_code）"
else
  bad "健康检查失败（本机 $health_code / 公网 $public_code）"
  printf '  回滚：git checkout <上一个提交> && pnpm --filter @mediaflow/api run build && systemctl restart mediaflow-api\n'
  printf '  密钥/配置类回滚见 docs/RUNBOOK-密钥轮换.md 的 9 步回滚手册\n'
  exit 1
fi

echo
ok "部署完成：$(date '+%F %T')"
