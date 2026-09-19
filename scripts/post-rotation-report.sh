#!/usr/bin/env bash
# 密钥轮换 24 小时观察期汇总（供 cron 报告任务使用）。
set -uo pipefail
ROOT=/www/wwwroot/mediaflow
LOG=/root/.hermes/workspace/mediaflow_key_rotation_watch.log
echo "== 观察期记录统计 =="
echo "记录条数: $(wc -l < "$LOG" 2>/dev/null || echo 0)"
echo "异常条数: $(grep -c 'ALERT' "$LOG" 2>/dev/null || echo 0)"
echo "时间范围: $(head -1 "$LOG" 2>/dev/null | cut -d'|' -f1) → $(tail -1 "$LOG" 2>/dev/null | cut -d'|' -f1)"
echo "最近 3 条:"; tail -3 "$LOG" 2>/dev/null
echo
echo "== 当前状态 =="
echo "API 健康(本机): $(curl -s -o /dev/null -w '%{http_code}' --max-time 8 http://127.0.0.1:4000/api/health)"
echo "API 健康(公网): $(curl -s -o /dev/null -w '%{http_code}' --max-time 10 https://auto.liangyijianye.cn/api/health)"
echo "服务状态: $(systemctl is-active mediaflow-api mediaflow-web | tr '\n' ' ')"
echo
echo "== 密钥与解密核对 =="
cd "$ROOT/apps/api" && node scripts/verify-settings-key.cjs 2>&1
echo
echo "== 日志中的密钥/解密/AI 错误（全部历史） =="
echo "错误行数: $(grep -cE '\[ERROR\]|UnhandledPromiseRejection|解密失败|SETTINGS_ENCRYPTION_KEY 必须配置|AI 调用失败|Cannot decrypt' /var/log/mediaflow-api.log 2>/dev/null || echo 0)"
grep -E '\[ERROR\]|SETTINGS_ENCRYPTION_KEY 必须配置|Cannot decrypt' /var/log/mediaflow-api.log 2>/dev/null | tail -5
echo
echo "== AI 调用与用量（近 24 小时） =="
PGPASSWORD=mediaflow_dev psql -h 127.0.0.1 -U mediaflow -d mediaflow -t -A -c \
  "SELECT '调用 '||count(*)||' 次，失败 '||count(*) FILTER (WHERE status <> 'success')||' 次' FROM ai_generations WHERE created_at > now() - interval '24 hours';"
echo
echo "== 待办提醒 =="
echo "· 旧密钥(指纹 9d87f6490bc0)销毁日期应为 2026-10-19（30 天后）"
echo "· 新密钥需已存入独立密钥管理系统；/root/.mediaflow-secrets/settings-encryption-key-2026-09-19.txt 应在完成外部保管后删除"
