#!/bin/bash
# MediaFlow 数据库每日备份（保留 14 天）。2026-09-17 新增：此前该库不在任何备份任务中。
set -euo pipefail
BACKUP_DIR=/www/backup/mediaflow
KEEP_DAYS=14
STAMP=$(date +%F_%H%M)
FILE="$BACKUP_DIR/mediaflow_${STAMP}.sql.gz"
TMP=$(mktemp /tmp/mediaflow_backup_XXXX.sql)
trap 'rm -f "$TMP"' EXIT
mkdir -p "$BACKUP_DIR"
export PGPASSWORD="${DB_PASSWORD:-mediaflow_dev}"

# 先导出为明文临时文件，校验通过后再压缩，避免写出坏备份
pg_dump -h 127.0.0.1 -U mediaflow -d mediaflow --no-owner --format=plain > "$TMP"

TABLE_COUNT=$(grep -c '^CREATE TABLE' "$TMP" || true)
COPY_COUNT=$(grep -c '^COPY ' "$TMP" || true)
if [ "$TABLE_COUNT" -lt 15 ] || [ "$COPY_COUNT" -lt 10 ]; then
  echo "备份校验失败（表=$TABLE_COUNT 数据段=$COPY_COUNT）：未生成有效备份" >&2
  exit 1
fi

gzip -9 -c "$TMP" > "$FILE"
find "$BACKUP_DIR" -name 'mediaflow_*.sql.gz' -mtime +"$KEEP_DAYS" -delete
echo "备份完成：$FILE（表 $TABLE_COUNT 张 / 数据段 $COPY_COUNT 个 / $(du -h "$FILE" | cut -f1)）"
