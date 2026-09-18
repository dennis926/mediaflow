#!/usr/bin/env bash
# 部署前预检：把"生产必须成立的开关与权限"变成可执行断言。
#
# 用法：
#   bash scripts/preflight.sh          # 常规检查（关键项失败即退出非 0）
#   bash scripts/preflight.sh --strict # 发布门禁（更严格，含密钥与依赖）
#
# 退出码：0 = 通过；1 = 有关键项失败（部署必须中止）。
set -uo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
ENV_FILE="${ENV_FILE:-$ROOT/.env}"
STRICT=0
[[ "${1:-}" == "--strict" ]] && STRICT=1

FAIL=0
WARN=0
pass() { printf '  \033[32m✓\033[0m %s\n' "$1"; }
fail() { printf '  \033[31m✗ %s\033[0m\n' "$1"; FAIL=$((FAIL + 1)); }
warn() { printf '  \033[33m! %s\033[0m\n' "$1"; WARN=$((WARN + 1)); }

echo "== MediaFlow 部署预检（$(date '+%F %T')） =="

echo "-- 1. 敏感文件权限"
if [[ ! -f "$ENV_FILE" ]]; then
  fail "缺少 $ENV_FILE"
else
  perm="$(stat -c '%a' "$ENV_FILE")"
  if [[ "$perm" == "600" ]]; then pass ".env 权限 600"; else fail ".env 权限为 $perm（必须 600）"; fi
fi
for f in /var/log/mediaflow-api.log /var/log/mediaflow-web.log; do
  [[ -f "$f" ]] || continue
  perm="$(stat -c '%a' "$f")"
  [[ "$perm" =~ ^6[04]0$ ]] && pass "$f 权限 $perm" || fail "$f 权限为 $perm（应为 640）"
done
while IFS= read -r bf; do
  perm="$(stat -c '%a' "$bf")"
  [[ "$perm" == "600" ]] || fail "备份文件 $bf 权限为 $perm（应为 600）"
done < <(find /www/backup/mediaflow -maxdepth 1 -type f -name '*.sql*' 2>/dev/null)

echo "-- 2. 生产必开开关"
grep -q '^AUTH_ENFORCED=true' "$ENV_FILE" && pass "AUTH_ENFORCED=true" || fail "AUTH_ENFORCED 必须为 true（否则无令牌可访问接口）"
grep -q '^PUBLISH_WORKER_ENABLED=true' "$ENV_FILE" && pass "PUBLISH_WORKER_ENABLED=true" || fail "PUBLISH_WORKER_ENABLED 必须为 true，否则发布任务不会被执行"
if grep -qE '^SETTINGS_ENCRYPTION_KEY=.+' "$ENV_FILE"; then
  pass "SETTINGS_ENCRYPTION_KEY 已设置"
else
  if [[ $STRICT == 1 ]]; then fail "SETTINGS_ENCRYPTION_KEY 为空（密钥类配置将回退 JWT_SECRET）"; else warn "SETTINGS_ENCRYPTION_KEY 为空（阶段 A 任务 7 修复前属已知项）"; fi
fi

echo "-- 3. 单实例约束（发布 Worker 只能有一个消费者进程）"
consumers="$(redis-cli XINFO CONSUMERS mediaflow:publish:tasks publish-workers 2>/dev/null | grep -c '^name' || true)"
if [[ "${consumers:-0}" -le 1 ]]; then pass "队列消费者数 $consumers"; else warn "队列消费者数 $consumers（多实例部署需确认无重复消费）"; fi

echo "-- 4. 服务与健康"
systemctl is-active --quiet mediaflow-api && pass "mediaflow-api 运行中" || fail "mediaflow-api 未运行"
systemctl is-active --quiet mediaflow-web && pass "mediaflow-web 运行中" || fail "mediaflow-web 未运行"
code="$(curl -s -o /dev/null -w '%{http_code}' -m 10 https://auto.liangyijianye.cn/api/health || echo 000)"
[[ "$code" == "200" ]] && pass "健康接口 200" || fail "健康接口返回 $code"

echo "-- 5. 配置一致性"
maxmb="$(PGPASSWORD="${DB_PASSWORD:-mediaflow_dev}" psql -h 127.0.0.1 -U mediaflow -d mediaflow -t -A -c \
  "SELECT COALESCE((SELECT value FROM system_settings WHERE key='MEDIA_MAX_FILE_MB' AND value <> ''), '50')" 2>/dev/null || echo 50)"
# 代码里的常量是表达式（如 2048 * 1024 * 1024），用 node 求值后再比较
ceiling_expr="$(grep -oE 'UPLOAD_CEILING_BYTES = [0-9_ *]+' "$ROOT/apps/api/src/modules/media/media.controller.ts" | sed 's/.*= //')"
ceiling_mb="$(( $(node -e "process.stdout.write(String(Math.round((${ceiling_expr:-0})/1024/1024)))") ))"
pass "MEDIA_MAX_FILE_MB=${maxmb}M / 代码硬上限 ${ceiling_mb}M"
[[ "$ceiling_mb" -gt "$maxmb" ]] && warn "代码硬上限高于配置业务上限（大文件会先占内存/磁盘再被拒）"

if [[ $STRICT == 1 ]]; then
  echo "-- 6. 依赖漏洞（严格模式）"
  if (cd "$ROOT" && pnpm audit --prod --audit-level=high >/dev/null 2>&1); then pass "无 high 及以上漏洞"; else fail "存在 high/critical 依赖漏洞，见 pnpm audit --prod"; fi
fi

echo
echo "== 结果：关键失败 $FAIL 项，提示 $WARN 项 =="
[[ $FAIL -eq 0 ]] || exit 1
exit 0
