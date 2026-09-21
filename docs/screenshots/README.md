# 界面截图（视觉核验留档）

| 文件 | 内容 | 拍摄时间 |
| --- | --- | --- |
| `workspaces-page-20260921.png` | 工作区管理页：工作区列表（状态标签）、「默认工作区」的状态与生命周期卡片、新建工作区、数据导出面板（含"7 天后自动删除"提示）、成员表格 | 2026-09-21 |
| `workspaces-delete-dialog-20260921.png` | 删除工作区确认框：最后一个工作区的红字警告 + 勾选确认 + 名称二次确认（确认按钮为禁用态）+ 底部"永久清除请联系管理员" | 2026-09-21 |
| `workspaces-archive-dialog-20260921.png` | 归档工作区确认框：说明"可逆、不删数据" | 2026-09-21 |

## 复现方式

1. 起无头浏览器（CDP 驱动脚本已在仓库内：`scripts/cdp-qa.py`；沙箱参数见 `docs/INVENTORY-生产配置.md`）：
   ```bash
   chrome --headless=new --no-sandbox --disable-gpu --disable-dev-shm-usage --hide-scrollbars \
     --js-flags=--max-old-space-size=448 --renderer-process-limit=1 \
     --remote-debugging-port=9222 --user-data-dir=/tmp/chrome-qa about:blank &
   ```
2. 用 API 登录取得令牌：`POST /api/auth/login`（生产管理员账号）。
3. 按 `workspaces-ui-steps.json` 执行（令牌位置已用占位符替换）：
   ```bash
   python3 scripts/cdp-qa.py docs/screenshots/workspaces-ui-steps.json
   ```
   该步骤会打开 `/workspaces`、打开两个确认框并截图，最后输出控制台错误（本次为 `none`）。

**安全约定**：截图仅含内部界面，**未发布到公网目录**；步骤文件中的令牌已替换为占位符，不落库任何凭据。
