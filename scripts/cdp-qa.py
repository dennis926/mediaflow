"""Minimal Chrome DevTools Protocol driver (no Playwright needed).

Usage: python3 cdp_qa.py <command-json-file>
Drives a headless Chrome started with --remote-debugging-port=9222 to open pages,
run JavaScript, and capture screenshots for visual QA.
"""

from __future__ import annotations

import asyncio
import base64
import json
import sys
import urllib.request

import websockets

DEBUG_URL = "http://127.0.0.1:9222"


def browser_ws_url() -> str:
    """Prefer an existing page target; fall back to the browser endpoint to create one."""
    with urllib.request.urlopen(f"{DEBUG_URL}/json/list", timeout=10) as response:
        targets = json.load(response)
    for target in targets:
        if target.get("type") == "page" and target.get("webSocketDebuggerUrl"):
            return target["webSocketDebuggerUrl"]

    with urllib.request.urlopen(f"{DEBUG_URL}/json/version", timeout=10) as response:
        browser_url = json.load(response)["webSocketDebuggerUrl"]
    request = urllib.request.Request(
        f"{DEBUG_URL}/json/new?about:blank",
        method="PUT",
    )
    with urllib.request.urlopen(request, timeout=10) as response:
        created = json.load(response)
    return created.get("webSocketDebuggerUrl") or browser_url


class Cdp:
    def __init__(self, ws) -> None:  # noqa: ANN001
        self.ws = ws
        self.counter = 0
        self.network_log: list[str] = []
        self.errors: list[str] = []

    async def call(self, method: str, **params):  # noqa: ANN201
        self.counter += 1
        message_id = self.counter
        await self.ws.send(json.dumps({"id": message_id, "method": method, "params": params}))
        while True:
            raw = json.loads(await asyncio.wait_for(self.ws.recv(), timeout=30))
            if raw.get("id") == message_id:
                if "error" in raw:
                    raise RuntimeError(f"{method} failed: {raw['error']}")
                return raw.get("result", {})
            self.record_event(raw)

    def record_event(self, raw: dict) -> None:  # noqa: ANN001
        method = raw.get("method", "")
        params = raw.get("params", {})
        if method == "Network.responseReceived":
            response = params.get("response", {})
            url = response.get("url", "")
            if "/api/" in url:
                self.network_log.append(f"{response.get('status')} {url.split('?')[0].replace('http://127.0.0.1:3000','')}")
            elif response.get("status", 0) >= 400:
                self.network_log.append(f"{response.get('status')} {url[:110]}")
        elif method == "Runtime.exceptionThrown":
            detail = params.get("exceptionDetails", {})
            self.errors.append(f"{detail.get('text')} {str(detail.get('exception', {}).get('description', ''))[:200]}")
        elif method == "Runtime.consoleAPICalled" and params.get("type") in {"error", "warning"}:
            args = " ".join(str(a.get("value", a.get("description", "")))[:160] for a in params.get("args", []))
            self.errors.append(f"[{params.get('type')}] {args}")

    async def evaluate(self, expression: str):  # noqa: ANN201
        result = await self.call(
            "Runtime.evaluate",
            expression=expression,
            awaitPromise=True,
            returnByValue=True,
        )
        return result.get("result", {}).get("value")

    async def goto(self, url: str, settle_ms: int = 2500) -> None:
        await self.call("Page.navigate", url=url)
        await asyncio.sleep(settle_ms / 1000)

    async def screenshot(self, path: str) -> str:
        result = await self.call("Page.captureScreenshot", format="png", captureBeyondViewport=True)
        data = base64.b64decode(result["data"])
        with open(path, "wb") as handle:
            handle.write(data)
        return path


JS_HELPERS = """
window.__mfSet = (selector, value) => {
  const el = document.querySelector(selector);
  if (!el) return 'missing:' + selector;
  const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
  setter.call(el, value);
  el.dispatchEvent(new Event('input', { bubbles: true }));
  el.dispatchEvent(new Event('change', { bubbles: true }));
  return 'ok';
};
true;
"""


async def main() -> int:
    commands = json.load(open(sys.argv[1], encoding="utf-8"))
    async with websockets.connect(browser_ws_url(), max_size=40 * 1024 * 1024) as ws:
        cdp = Cdp(ws)
        await cdp.call("Page.enable")
        await cdp.call("Runtime.enable")
        await cdp.call("Emulation.setDeviceMetricsOverride", width=1440, height=1000, deviceScaleFactor=1, mobile=False)
        report = []
        for step in commands:
            action = step.get("action")
            if action == "metrics":
                await cdp.call(
                    "Emulation.setDeviceMetricsOverride",
                    width=step["width"],
                    height=step["height"],
                    deviceScaleFactor=step.get("scale", 1),
                    mobile=step.get("mobile", True),
                )
                await asyncio.sleep(1.0)
                report.append({
                    "step": step.get("name", "metrics"),
                    "value": f"{step['width']}x{step['height']} innerWidth={await cdp.evaluate('innerWidth')}",
                })
            elif action == "goto":
                await cdp.goto(step["url"], step.get("settleMs", 2500))
                await cdp.evaluate(JS_HELPERS)
                report.append({"step": step.get("name", step["url"]), "url": await cdp.evaluate("location.href")})
            elif action == "eval":
                value = await cdp.evaluate(step["js"])
                report.append({"step": step.get("name", "eval"), "value": value})
            elif action == "screenshot":
                path = await cdp.screenshot(step["path"])
                report.append({"step": step.get("name", "screenshot"), "path": path})
            elif action == "setfiles":
                doc = await cdp.call("DOM.getDocument", depth=1)
                node = await cdp.call("DOM.querySelector", nodeId=doc["root"]["nodeId"], selector=step["selector"])
                if not node.get("nodeId"):
                    report.append({"step": step.get("name"), "error": "selector not found"})
                else:
                    await cdp.call("DOM.setFileInputFiles", files=step["files"], nodeId=node["nodeId"])
                    report.append({"step": step.get("name"), "value": f"set {len(step['files'])} file(s)"})
            elif action == "sleep":
                await asyncio.sleep(step["seconds"])
            elif action == "prescript":
                await cdp.call("Page.addScriptToEvaluateOnNewDocument", source=step["source"])
                report.append({"step": step.get("name", "prescript"), "value": "injected"})
            elif action == "errors":
                value = cdp.errors[-20:]
                report.append({"step": step.get("name", "errors"), "errors": value or "none"})
            elif action == "network":
                await cdp.call("Network.enable")
                await cdp.goto(step["url"], step.get("settleMs", 4000))
                await asyncio.sleep(step.get("seconds", 3))
                report.append({"step": step.get("name", "network"), "responses": cdp.network_log[-40:]})
        print(json.dumps(report, ensure_ascii=False, indent=1))
    return 0


if __name__ == "__main__":
    raise SystemExit(asyncio.run(main()))
