#!/usr/bin/env bash
# 部署前预检：把"生产必须成立的开关与权限"变成可执行断言。
#
# 用法：
#   bash scripts/preflight.sh                    # 常规检查（关键项失败即退出非 0）
#   bash scripts/preflight.sh --strict           # 发布门禁（额外做依赖漏洞门禁）
#   bash scripts/preflight.sh --config-only      # 只校验配置与代码约束（不起服务、不连库，CI 可用）
#   bash scripts/preflight.sh --config-only --strict
#
# 退出码：0 = 通过；1 = 有关键项失败（部署必须中止）。
set -uo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
ENV_FILE="${ENV_FILE:-$ROOT/.env}"
STRICT=0
CONFIG_ONLY=0
for arg in "$@"; do
  case "$arg" in
    --strict) STRICT=1 ;;
    --config-only) CONFIG_ONLY=1 ;;
    *) echo "未知参数：$arg"; exit 2 ;;
  esac
done

FAIL=0
WARN=0
pass() { printf '  \033[32m✓\033[0m %s\n' "$1"; }
fail() { printf '  \033[31m✗ %s\033[0m\n' "$1"; FAIL=$((FAIL + 1)); }
warn() { printf '  \033[33m! %s\033[0m\n' "$1"; WARN=$((WARN + 1)); }

echo "== MediaFlow 部署预检（$(date '+%F %T')，模式：$( [[ $CONFIG_ONLY == 1 ]] && echo '仅配置' || echo '完整' )$( [[ $STRICT == 1 ]] && echo ' + 严格' )） =="

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

echo "-- 2. 生产必开开关与密钥质量"
grep -q '^AUTH_ENFORCED=true' "$ENV_FILE" && pass "AUTH_ENFORCED=true" || fail "AUTH_ENFORCED 必须为 true（否则无令牌可访问接口）"
grep -q '^PUBLISH_WORKER_ENABLED=true' "$ENV_FILE" && pass "PUBLISH_WORKER_ENABLED=true" || fail "PUBLISH_WORKER_ENABLED 必须为 true，否则发布任务不会被执行"

# 密钥类断言只比对「长度 + sha256 前 12 位指纹」，绝不回显密钥值本身。
settings_key="$(sed -n 's/^SETTINGS_ENCRYPTION_KEY=//p' "$ENV_FILE")"
jwt_secret="$(sed -n 's/^JWT_SECRET=//p' "$ENV_FILE")"
fingerprint() { printf '%s' "$1" | sha256sum | cut -c1-12; }
# 历史泄露值（2026-09-19 任务 8b 已轮换，禁止再出现）
LEAKED_JWT_FP='9d87f6490bc0'

if [[ ${#settings_key} -ge 32 ]]; then
  pass "SETTINGS_ENCRYPTION_KEY 已设置且长度 ${#settings_key}（≥32，指纹 $(fingerprint "$settings_key")）"
else
  fail "SETTINGS_ENCRYPTION_KEY 长度 ${#settings_key}（必须 ≥32，且不得回退 JWT_SECRET）"
fi
if [[ ${#jwt_secret} -ge 48 ]]; then
  pass "JWT_SECRET 长度 ${#jwt_secret}（≥48，指纹 $(fingerprint "$jwt_secret")）"
else
  fail "JWT_SECRET 长度 ${#jwt_secret}（必须 ≥48，否则启动会被拒绝）"
fi
if [[ "$(fingerprint "$jwt_secret")" == "$LEAKED_JWT_FP" ]]; then
  fail "JWT_SECRET 仍是 2026-09-19 泄露的那把密钥（指纹 $LEAKED_JWT_FP），必须轮换"
else
  pass "JWT_SECRET 非历史泄露值（已轮换）"
fi
if [[ -n "$jwt_secret" && "$jwt_secret" == "$settings_key" ]]; then
  fail "JWT_SECRET 与 SETTINGS_ENCRYPTION_KEY 相同（签名密钥与加密密钥必须分离）"
else
  pass "签名密钥与加密密钥相互独立"
fi

if [[ $CONFIG_ONLY == 1 ]]; then
  echo "-- 3/4. 运行时检查（单实例、服务与健康）——仅配置模式下跳过"
else
  echo "-- 3. 单实例约束（发布 Worker 只能有一个**在跑**的消费者）"
  # 口径说明：消费者记录会随进程退出而残留（应用下次启动会自行清理，见 PublishWorker.pruneIdleConsumers）；
  # 残留记录 pending=0 且长时间 idle，不会重复消费。只有 pending>0 或近 120 秒内仍在拉取的消费者才算"真的在跑"。
  # 若把残留也算作并发，会出现"预检拦住重启、而重启恰好是清理残留的手段"的死锁（2026-09-21 实测遇到）。
  # 用 --json 解析，避免逐行文本解析错位。
  consumer_stats="$(redis-cli --json XINFO CONSUMERS mediaflow:publish:tasks publish-workers 2>/dev/null | python3 -c "
import json,sys
try:
    rows=json.load(sys.stdin)
except Exception:
    print('0 0'); raise SystemExit
active=stale=0
for entry in rows:
    if isinstance(entry, dict):
        pending=int(entry.get('pending',0)); idle=int(entry.get('idle',10**9))
    else:
        data=dict(zip(entry[0::2], entry[1::2])); pending=int(data.get('pending',0)); idle=int(data.get('idle',10**9))
    if pending>0 or idle<120000: active+=1
    else: stale+=1
print(active, stale)
" 2>/dev/null || echo "0 0")"
  active_consumers="${consumer_stats%% *}"
  stale_consumers="${consumer_stats##* }"
  if [[ "${active_consumers:-0}" -le 1 ]]; then
    pass "在跑的消费者 ${active_consumers} 个（≤1，单实例约束）"
  elif [[ $STRICT == 1 ]]; then
    fail "有 ${active_consumers} 个消费者正在拉取队列（要求 ≤1，避免重复消费）"
  else
    warn "有 ${active_consumers} 个消费者正在拉取队列（多实例部署需确认无重复消费）"
  fi
  if [[ "${stale_consumers:-0}" -gt 0 ]]; then
    warn "存在 ${stale_consumers} 个残留消费者记录（pending=0，不会重复消费；重启 API 会自行清理）"
  fi

  echo "-- 4. 服务与健康"
  systemctl is-active --quiet mediaflow-api && pass "mediaflow-api 运行中" || fail "mediaflow-api 未运行"
  systemctl is-active --quiet mediaflow-web && pass "mediaflow-web 运行中" || fail "mediaflow-web 未运行"
  code="$(curl -s -o /dev/null -w '%{http_code}' -m 10 https://auto.liangyijianye.cn/api/health || echo 000)"
  [[ "$code" == "200" ]] && pass "健康接口 200" || fail "健康接口返回 $code"
fi

echo "-- 5. 配置一致性（上传上限）"
if [[ $CONFIG_ONLY == 0 ]]; then
  media_max_mb="$(PGPASSWORD="${DB_PASSWORD:-mediaflow_dev}" psql -h 127.0.0.1 -U mediaflow -d mediaflow -t -A -c \
    "SELECT COALESCE((SELECT value FROM system_settings WHERE key='MEDIA_MAX_FILE_MB' AND value <> ''), '50')" 2>/dev/null || echo 50)"
  env_media_mb="$(sed -n 's/^MEDIA_MAX_FILE_MB=//p' "$ENV_FILE")"
  if [[ -n "$env_media_mb" && -n "$media_max_mb" && "$env_media_mb" != "$media_max_mb" ]]; then
    fail "MEDIA_MAX_FILE_MB 不一致：.env=${env_media_mb} 数据库=${media_max_mb}（数据库优先，需对齐）"
  else
    pass "MEDIA_MAX_FILE_MB=${media_max_mb}M（环境变量与数据库配置一致）"
  fi
else
  env_media_mb="$(sed -n 's/^MEDIA_MAX_FILE_MB=//p' "$ENV_FILE")"
  [[ -n "$env_media_mb" ]] && pass "MEDIA_MAX_FILE_MB=${env_media_mb}M（仅配置模式不做数据库比对）" || warn "未设置 MEDIA_MAX_FILE_MB（使用默认值）"
fi
# 任务 4 起上传改为磁盘暂存：代码里不应再有 GB 级静态硬上限
if grep -q 'UPLOAD_CEILING_BYTES' "$ROOT/apps/api/src/modules/media/media.controller.ts" 2>/dev/null; then
  fail "media.controller.ts 仍存在静态上传上限常量（应改为按配置动态限制）"
else
  pass "上传未使用静态硬上限（按 MEDIA_MAX_FILE_MB 动态限制）"
fi
if grep -q 'diskStorage' "$ROOT/apps/api/src/modules/media/media-upload.interceptor.ts" 2>/dev/null; then
  pass "上传走磁盘暂存（非内存）"
else
  fail "上传未使用 diskStorage（可能又退回内存缓冲）"
fi
# 失败路径必须清临时文件：2026-09-19 修复的漏点，防止回归
if grep -q 'discardTempFile' "$ROOT/apps/api/src/modules/media/media-upload.interceptor.ts" 2>/dev/null; then
  pass "上传失败会清理临时文件"
else
  fail "上传拦截器未清理失败路径的临时文件（会持续堆积垃圾文件）"
fi

echo "-- 6. 关键依赖下限（防止被回退到有漏洞的版本）"
nodemailer_version="$(node -e "try{process.stdout.write(JSON.parse(require('fs').readFileSync(require.resolve('nodemailer/package.json',{paths:['apps/api']}),'utf8')).version)}catch(e){process.stdout.write('0.0.0')}" 2>/dev/null)"
if [[ "$(printf '%s\n%s\n' "9.1.1" "$nodemailer_version" | sort -V | head -1)" == "9.1.1" ]]; then
  pass "nodemailer $nodemailer_version（≥9.1.1）"
else
  fail "nodemailer $nodemailer_version 低于 9.1.1（含多个已修复漏洞）"
fi

if [[ $STRICT == 1 ]]; then
  echo "-- 7. 依赖漏洞（严格模式）"
  if (cd "$ROOT" && pnpm audit --prod --audit-level=high >/dev/null 2>&1); then pass "无 high 及以上漏洞"; else fail "存在 high/critical 依赖漏洞，见 pnpm audit --prod"; fi
fi

echo
echo "== 结果：关键失败 $FAIL 项，提示 $WARN 项 =="
[[ $FAIL -eq 0 ]] || exit 1
exit 0
