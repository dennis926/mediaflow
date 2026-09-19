#!/usr/bin/env bash
# 密钥轮换后 24 小时观察：健康 + 密钥/解密/AI 错误扫描，异常立即标记 ALERT。
set -uo pipefail
LOG=/root/.hermes/workspace/mediaflow_key_rotation_watch.log
API_LOG=/var/log/mediaflow-api.log
STAMP=$(date '+%F %T')
HEALTH=$(curl -s -o /dev/null -w '%{http_code}' --max-time 8 http://127.0.0.1:4000/api/health || echo 000)
PUBLIC=$(curl -s -o /dev/null -w '%{http_code}' --max-time 10 https://auto.liangyijianye.cn/api/health || echo 000)
# 近 35 分钟日志窗口内的关键错误（观察期每 30 分钟执行一次）
ERRORS=$(tail -400 "$API_LOG" 2>/dev/null | grep -E '\[ERROR\]|UnhandledPromiseRejection|解密失败|SETTINGS_ENCRYPTION_KEY 必须配置|AI 调用失败|ECONNREFUSED|Cannot decrypt' | grep -vc 'AI 提供方已就绪' || true)
AI_LINES=$(tail -400 "$API_LOG" 2>/dev/null | grep -c 'AI' || true)
API_STATE=$(systemctl is-active mediaflow-api 2>/dev/null || echo unknown)
LINE="$STAMP | health=$HEALTH public=$PUBLIC api=$API_STATE | 密钥/解密/AI错误计数=$ERRORS | 日志中 AI 相关行=$AI_LINES"
if [ "$HEALTH" != "200" ] || [ "$PUBLIC" != "200" ] || [ "$ERRORS" != "0" ]; then
  echo "$LINE | ⚠ ALERT：需要人工介入（密钥轮换后异常）" >> "$LOG"
  echo "⚠ MediaFlow 密钥轮换后异常：$LINE"
else
  echo "$LINE" >> "$LOG"   # 正常时只写日志，不打扰
fi
