# T1 运行时：内嵌无头 Chromium

> 索引：[docs/index.md](index.md) · 2026-10-31 实现

采用"可选实现方式 2"：Host 起一个**真正的无头 Chromium**，用 CDP 驱动；画面通过 `Page.startScreencast` 的 JPEG 帧回到面板，用户输入反过来经 CDP 派发。窗口从不显示，因此**不会抢焦点**。

## 结构

```text
Host (index.js)                         Client (client.js)
├─ spawn chrome --headless=new          ├─ 每 80ms 轮询 GET /frame
├─ CDP over WebSocket                   ├─ <img> 渲染 JPEG 帧（object-fit: contain）
├─ Page.startScreencast → 最新一帧       ├─ 指针/滚轮/键盘 → POST /input
├─ Network.enable → 请求环形缓冲         ├─ 地址/刷新 → POST /navigate
├─ Runtime.evaluate / DOM / CSS         └─ 状态栏读 /state（mode + activity）
└─ HTTP 路由 /plugins/ui-testing/*
```

## HTTP 接口（同源，走应用自身鉴权）

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| POST | `/plugins/ui-testing/ensure` | 启动浏览器；可选 `{url}` 直接打开 |
| POST | `/plugins/ui-testing/navigate` | `{url}`，仅 http/https |
| POST | `/plugins/ui-testing/viewport` | `{width,height}`（Emulation.setDeviceMetricsOverride） |
| POST | `/plugins/ui-testing/input` | `{events:[…]}`，mouse / wheel / key / text |
| POST | `/plugins/ui-testing/eval` | `{expression}` → `{ok,value,type}` |
| POST | `/plugins/ui-testing/screenshot` | → `{image: base64 PNG}` |
| POST | `/plugins/ui-testing/close` | 关闭浏览器并清理临时 profile |
| GET | `/plugins/ui-testing/frame?since=N` | 无新帧时 `{pending:true}`，否则 `{seq,image,state}` |
| GET | `/plugins/ui-testing/state` | `{mode,activity,url,title,viewport,seq,running}` |

## Agent 工具

`browser_navigate`、`browser_eval`、`browser_screenshot`、`browser_input`、`browser_network`、`browser_computed_style`、`browser_state`。

工具执行时会把 `activity` 置为该动作、`mode` 置为 `agent`（15 秒保持），状态栏随之显示"Agent 操作中"和具体动作。

## 焦点与接管

- 浏览器以 `--headless=new` 启动，无窗口、无输入注入到桌面 → 不会抢焦点。
- 用户在面板里点击/滚轮/打字 → `POST /input` → CDP 派发，宿主把 `mode` 记为 `human`（4 秒）。
- 剪贴板、文件选择、权限弹窗、跨窗口行为都未实现。

## 状态栏指标的含义

- **FPS**：screencast **帧到达率**（每秒收到多少张新帧）。目标页静止时不发新帧 → 显示 `0 FPS`，这是正常的，不是卡死。
- **ms**：**端到端延迟**，从帧的采集时刻（`metadata.timestamp` / 截图的 `capturedAt`）到客户端收到并准备渲染。
  - JPEG 帧：本机实测 9–30 ms
  - 首帧 PNG 种子（页面静止时用一次性截图补齐）：100 ms 量级，因为要编码整屏 PNG
- 只统计"新鲜帧"（采集距今 < 3 秒）：页面静止时最早那帧可能是几十秒前的，不能当延迟。
- 这两项都**不是**宿主页面自身的渲染帧率，也不是目标页的真实 FPS——目标页的真实渲染节奏只能靠 T4 的动画采样测。

## 已知限制

- 帧是 JPEG 轮询（约 12fps 上限、80ms 间隔），不是 WebRTC；高动态页面会掉帧。
- 键盘只转发可打印字符与少量控制键（Backspace/Enter/Tab/Esc/方向键/Delete），修饰键组合留给宿主。
- 输入事件会先到达宿主页面，因此宿主里若有模态遮罩会吞掉点击。
- 没有下载、上传、Cookie 导出、多标签页、跨源隔离。
- Host 半边改动需要重启 DSH；Client 半边热更新。
