# 磁盘管理手册（B0.1 沉淀）

> 2026-09-19 首次系统整理。触发原因：磁盘一度到 **76%**，OpsMonitor 告警阈值 80% 逼近。

## 一、这台服务器上磁盘被谁占了（2026-09-19 实测）

| 位置 | 大小 | 性质 | 是否可清理 |
| --- | --- | --- | --- |
| `/var/backups/site-backup-manager/` | 17G → 7.4G | **另一个项目**（bf.hons.fun）的每日加密备份 | 可，但必须走它自己的保留策略（见第三节） |
| `/root/migrate/` | 3.7G → 0.6G | 2026-09-02 服务器迁移归档 | 大归档可删（站点已运行且有每日备份），小归档保留 |
| `/www/wwwroot/ziliao/restore_tmp/` | 2.4G → 0 | 恢复操作的临时目录 | 可删（真实内容在 `/www/wwwroot/ziliao`，且该目录本就不参与备份） |
| `/root/.cache/` | 3.1G → 1.2G | pip/uv/pnpm/npm/Rust 下载缓存 | 可删（可重建）；**保留** `ms-playwright`、`puppeteer` |
| `/root/.hermes-web-ui/coding-agent/` | 1.8G | Hermes Studio 编码助手数据 | **未清理**（可能含会话记录，需本人确认） |
| `/var/lib/snapd/` | 2.1G → 1.1G | snap 修订与下载缓存 | 可删 disabled 修订与 cache；**保留** gnome 基础 snap |
| `/var/log/journal/` | 412M → 200M | systemd 日志 | 可 vacuum，建议设 `SystemMaxUse=200M` |
| `/var/cache/apt/` | 604M → 0 | 包缓存 | `apt-get clean` |
| mediaflow 自身 | **~4M** | 备份 0.6M + dist 备份 2.7M + 日志 0.5M + 上传临时 0.3M | 无需清理（保留策略都在生效） |
| `/swapfile` | 4G | 系统交换文件 | **不可删** |

**结论**：这台机器的磁盘压力主要来自**同机其它项目与开发缓存**，不是 MediaFlow。

## 二、日常巡检与清理

```bash
df -h /                                     # 一眼看使用率
du -xh --max-depth=1 / | sort -rh | head    # 顶层大头
du -xh --max-depth=2 /var /root /www 2>/dev/null | sort -rh | head -20
find / -xdev -type f -size +300M -printf '%s %p\n' 2>/dev/null | sort -rn | head   # 大文件
```

一次性清理脚本（**默认 dry-run**，逐条打印将删除的内容）：
```bash
bash /root/.hermes/workspace/b0_1_disk_cleanup.sh            # 预览
bash /root/.hermes/workspace/b0_1_disk_cleanup.sh --apply    # 执行（写日志 b0_1_cleanup.log）
```
脚本内置保护：检测 site-backup 是否在跑（有锁/有进程则跳过 A 组）、逐组释放量核对、全程留日志。

**清理前必做的完整性校验**（脚本外的独立步骤，本次已执行）：
```bash
python3 /root/.hermes/workspace/b0_1_verify_backup.py
```
它做两件事：①比对该项目自己的 `.sha256` 旁文件；②用项目自身配置里的口令做 `gpg 解密 → zstd -t`
明文流完整性测试（口令只在内存/管道传递，不打印不落盘）。**校验不过就不删任何备份。**

## 三、site-backup-manager 的保留策略（30 天 → 建议 7 天）

**为什么**：该项目 `retention_days` 默认 30，且清理只在"备份成功的当次"执行。
按 ~1G/天 计算，本地稳态占用约 **30G** —— 会反复把磁盘推到 80% 告警线。

### 方式一：界面修改（推荐）
1. 打开 **bf.hons.fun**（site-backup-manager 面板）并登录。
2. 进入设置/配置页，找到 **保留天数（retention_days）**，当前 30。
3. 改为 **7** 并保存（界面允许 1-90）。
4. 观察 3 天：确认每天 03:30 的备份仍成功（面板任务记录/日志），且旧文件被自动清理。

### 方式二：SSH 命令行（界面不可用时）
保留值存放在加密配置 `config.enc` 里，**不要手工编辑该文件**；用项目自身的 API 改写：

```bash
python3 - <<'PY'
import sys
sys.path.insert(0, '/opt/site-backup-manager')
import backup_core as bc

cfg = bc.load_config()
print('修改前 retention_days =', cfg.get('retention_days'))
cfg['retention_days'] = 7
bc.save_config(cfg)
print('修改后 retention_days =', bc.load_config().get('retention_days'))
PY
```
改完无需重启（每次备份运行都会重新加载配置）；但它自己的清理是"按任务"执行的，
所以 7 天以上的旧文件要等**下一次成功备份**时才会被删。

### 手动清理边界（本次做法，供下次参考）
保留 **最近 7 天 + 每月最早一份**；删除时**必须同时删除对应的 `.sha256` 旁文件**
（只删归档会留下孤儿旁文件，容易让人误以为归档还在）。本项目历史上也遗留过 1 个孤儿旁文件。

## 四、监控口径说明（重要）

- `df` 的"已用百分比"用 **bavail**（不含系统保留块）；
- 程序里若用 `statfs.bfree` 计算，会**偏低**几个百分点（本次实测 71.9% vs df 76%）。
- MediaFlow 的 OpsMonitor 已改为使用 `bavail`，与 `df` 对齐（B0.2）。
- 阈值：`MONITOR_DISK_USED_PERCENT` 默认 80，可在「设置 → 运行监控」调整。

## 五、下次磁盘告警时的处置顺序

1. `df -h /` 确认是否真的紧张（<10% 可用再动手）。
2. 按第一节的表定位大头（先看 `/var/backups/*` 与 `/root/.cache`）。
3. 备份类：先跑完整性校验（`b0_1_verify_backup.py`），再按"最近 7 天 + 每月一份"清理，并同步删 `.sha256`。
4. 缓存类：pip/uv/npm/pnpm/apt/journal 直接清，浏览器缓存（playwright/puppeteer）保留。
5. 清理后复查：`df -h /`、相关服务 `systemctl is-active`、mediaflow `/api/health` = 200。
