# 多标签页（P0-E）

一个 DSH workspace 是一个**页面组**：一个稳定的 primary 槽位 + 最多 3 个 child 标签，共 4 个标签。每个标签是一个独立 Runtime，拥有自己的 page、URL/history、view、标注、网络缓冲、T2 ref 表、串行队列和 single-owner lease；Cookie/localStorage/缓存仍由同一个 Chromium profile 共享，**不是登录态隔离**。

## 身份与选择

| 概念 | 行为 |
| --- | --- |
| workspace | 由 DSH 会话/workspace registry 决定；客户端不能靠路径重分组 |
| tab | 不透明 id；primary 固定为 `primary`，child 也有独立 `runtimeId` |
| Agent selection | 每个**真实执行会话**（`exec.agent.id`）独立保存 selectedTab；未显式选择时默认 primary |
| GUI active | 每个调试面板独立；GUI 切标签不改变 Agent selection，Agent 改 selection 也不自动切 GUI |
| binding | HTTP/WS 用 `X-UI-Testing-Scope-Binding: <runtimeId>` 直接指定某个标签 |

跨 workspace 的 tab id、binding 或 WS scope 都会被拒绝；不能借 tab id 读取其他 workspace。

面板自己的视图不受 Agent 的标签选择影响：session 作用域的 GUI 请求带 `X-UI-Testing-Scope-Tab: primary`（WS 用 `&tab=primary`），Host 见到它就跳过 Agent 的 `selectedTab` 解析，始终渲染本 workspace 的 primary。不带该提示的调用仍是"跟随该会话选中的标签"（工具与旧客户端行为不变）。

## browser_tabs

唯一的 P0-E 管理工具（第 36 个工具）；旧 35 个工具的参数 schema 不变，调用默认走当前会话的 selectedTab。

```json
{
  "action": "list | current | select | open | close | wait",
  "tabId": "可选；select/wait 使用；close 省略表示当前标签",
  "kind": "仅 wait：primary | tab",
  "source": "仅 wait：primary | gui-popup | agent-open",
  "timeoutMs": "仅 wait：0–30000，默认 5000",
  "pollMs": "仅 wait：50–1000，默认 100"
}
```

| action | 行为 |
| --- | --- |
| `list` | 只读列出当前 workspace 的标签与生命周期字段（见下表），并附带 `notices`、`recentClosed` 与调用者 selection；不启动 Chromium、不取 lease |
| `current` | 只读确认当前会话的 selectedTab；若有 pendingReset，报告 primary 与 resetReason 并确认复位 |
| `select` | 校验 tab 属于同 workspace，原子 claim 后选择；目标被其他 owner 占用返回 `BUSY`，旧 selection 不变 |
| `open` | 新建 about:blank child 并选择；不要求先有 popup |
| `close` | 仅允许关闭当前会话持有有效 lease 的标签；省略 tabId 关闭当前标签；关闭/退休记入 `recentClosed` |
| `wait` | 纯 Host 内存轮询：等待**调用开始后新出现**的标签；超时抛 `WAIT_TIMEOUT`（`details` 含 `elapsedMs/polls/condition`） |

`list` 的每个标签在既有 `tabId/runtimeId/kind/title/url/status/selected/busy/owner/reset` 之外新增：

| 字段 | 语义 |
| --- | --- |
| `source` | `primary`（稳定槽位）/ `gui-popup`（真人 `target=_blank`/`window.open` 接管或 GUI `+`）/ `agent-open`（`browser_tabs.open`） |
| `parentTabId` | popup 的 opener 标签 id（`primary` 或来源 child）；primary 为 `null` |
| `openEventId` | 真人 popup 的 open 事件 id；`agent-open`/GUI `+`/primary 为 `null` |
| `createdAt` / `lastUsedAt` | 入口创建与最近使用的时间戳（epoch ms）；页面工具调用会刷新 `lastUsedAt` |
| `idleRemainingMs` | 距 idle 回收剩余的毫秒数，按 `registry.idleMs` 计算（下限 0） |
| `manageable` | 当前 Agent 会话是否可操作该标签（未被其他会话占用）；`close` 仍需本人有效 lease 且无在途操作 |

`list` 同时返回两个本 workspace 的有界投影（各最多 8 条）：

- `notices`：被策略阻断的 popup，`{id, reason, parentTabId, parentRuntimeId, openEventId, at}`。用于区分"click 成功但策略阻断"与"确实没有新页"。
- `recentClosed`：最近关闭/退休的标签，`{tabId, kind, reason, at}`，`reason` 为 `closed`（显式关闭或外部关闭）、`idle`（idle 回收）、`evicted`（LRU/容量淘汰）。

`wait` 的语义：

- 不带 `tabId`：只匹配**调用开始后**新出现的标签（调用时已存在的标签不会被当作命中）；`initializing` 的 popup 要等 ready 后才算出现。
- 带 `tabId`：等待该 id 存在；调用时已存在则立即命中。
- `kind`/`source` 可叠加过滤；`timeoutMs:0` 只采样一次。
- 不启动 Chromium、不取/续 lease、不刷新 idle 计时；命中返回 `{matched:true, matchedTab, elapsedMs, polls, condition}`。统一结果元数据里的 `tab:{id,runtimeId,selectionRevision}` 仍是调用所路由标签，命中的新标签在 `matchedTab`。

错误码：`TAB_NOT_FOUND`、`TAB_LIMIT`、`TAB_FORBIDDEN`、`BUSY`、`WAIT_TIMEOUT`、`INVALID_ARGUMENT`；匿名调用 select/open/close 返回 `UNSUPPORTED`（`agent-session-required`）。结果统一附带 `tab:{id,runtimeId,selectionRevision}`。

## BUSY 与并发

- **BUSY 按 tab 计**：Agent A 在 tab1 工作不阻止 Agent B 在 tab2；同一 tab 的不同 owner 才返回 BUSY（含 15s idle lease）。
- 每个 tab 独立队列；Registry 的额度/元数据锁不是全局页面队列。
- GUI 可以预览 Agent 占用的 tab（`/state`、`/frame`）；真实输入/导航等页面写返回 409 `BUSY`。GUI 可切换到其他 tab，预览帧继续。
- 左下闲忙/FPS/ms 只来自 **GUI active tab** 的 `/state`，不做 workspace 聚合；Agent 在别的 tab 忙不影响当前显示。
- 关闭/idle 退休 child 时，仍指向该 child 的 Agent selection 进入 `pendingReset`；下一次普通页面工具先返回 `TARGET_NOT_FOUND(reason:selected-tab-closed,fallbackTabId:primary)` 且零派发，需 `browser_tabs.current` 或 `select` 明确确认。旧 Runtime 的在途操作不会重放到 primary。
- primary close 只让 primary 变 cold，不级联 child；child close 只回收该 tab。

## GUI 面板

- 地址栏下方有内部标签栏，由工具栏「标注」左侧的开关控制显隐；**单标签也占行**（默认显示）。标签栏最右是 `+` 新建空白标签；工具栏（地址栏行）不常驻 `+`。
- 显隐开关（`data-utb-tabs-toggle`，aria-pressed）只作用于标签栏本身，页面/tabs/active 保留；隐藏时栏内的 `+` 一并隐藏，需要新建标签时先打开标签栏。开关行为与标签数量无关。
- 新标签创建后成为 GUI active；地址、预览、输入、标注、尺寸、DevTools、网络和左下状态跟随 active。
- 标签有标题、active 指示和关闭按钮（aria-label）；关闭 child 后回 primary 或最后可用标签；Host views 移除会同步 UI。
- **关闭最后一个（primary）标签 = 进入空态**：标签条里不再有任何标签，只保留 `+`；地址栏为空、预览回到默认空态。primary 槽位在 Host 侧变冷态（仍保留 runtimeId/binding），Agent 侧 `browser_tabs.close primary` 语义相同。空态下点 `+` 会新建一个空白标签并选中它。
- **空态会跨刷新/面板重挂载保持**：面板挂载时的 seed 截图（`/screenshot`）只读取已运行页面，不会为冷态 primary 启动页面；只有用户显式导航或点 `+` 才会重新产生页面。
- child 关闭被 Agent lease 挡住时（GUI 与 Agent 同时操作），面板会提示「标签正被 Agent 操作；稍后再关闭」，不再静默失败。
- 4/8 容量与 per-tab lease 同样约束 GUI：第 5 个标签/tab 返回 `TAB_LIMIT` 并在本地提示。

## 容量与来源

| 限制 | 值 |
| --- | --- |
| 每 workspace 标签 | primary + 3 child = 4 |
| 全局同时 live pages + 创建预留 | 8（沿用原 profile 上限） |
| Agent lease idle | 15s（活动操作继续续期） |
| 标签 idle 回收（child 与 primary 页） | 600000ms（10 分钟）；可用环境变量 `DSH_UI_TESTING_IDLE_MS` 覆盖，当前值见 `browser_capabilities.tabs.idleMs` |
| blocked popup notices / 关闭审计 | 各最多 8 条/workspace |

标签来源：真人 `target=_blank` / `window.open` 的受控接管、GUI `+`、Agent `browser_tabs.open`。自动/未授权/无真人来源/非法目标/超容量 popup 仍阻断（见 [网络调试](network-p0.md) 的准入边界）；显式 `browser_tabs.open` 创建常量 about:blank，不需要先制造 popup。

空白首发弹窗（策略 A）：真人点击产生的 popup，如果原始 target 与 intent 都是空白/脚本窗口（`about:blank`/`data:`/`blob:`/`javascript:`），Host 会先接管并等待它的首个文档变成允许的 HTTP(S) 页面（最长 4s）；最终文档必须通过地址校验，否则仍以 `target-forbidden` 阻断并关闭该 target。这样兼容常见的 `window.open()` 后再 `location.href` 的站点写法，同时不放开自动弹窗或非法目标。

## 生命周期与可观察性

- 每个标签的 idle 计时按最近一次页面工具/页面写操作刷新（`keepalive.refreshOnPageTools`）；`browser_tabs.list`、`browser_tabs.wait`、`browser_capabilities` 不刷新也不启动 Chromium。
- 关闭分三类并记入 `recentClosed`：显式/外部关闭 `closed`、idle 回收 `idle`、全局容量 LRU 淘汰 `evicted`。被回收 tab 上的 Agent selection 仍按 pendingReset 语义处理（下一次页面工具零派发报 `TARGET_NOT_FOUND`，需 `browser_tabs.current` 或 `select` 确认）。
- 被策略阻断的 popup 只进入 `notices`（按 workspace 隔离，不跨 workspace 聚合），不创建 tab；`openEventId` 用于把 notice 与具体点击/新页事件对上。
- `wait` 可在不启动浏览器的前提下等待 GUI 真人弹窗或另一会话新建的标签，`source:'gui-popup'` 可区分真人 popup 与 `agent-open`。

## Web 视图运行模式（无头 / 有头）

- 工具栏“Web 视图”环境选择器的左侧有 **无头 / 有头** 分段选择器，仅 Web 视图显示；默认 **无头**。
- **有头** = 同一个共享 Chromium 以**离屏窗口**启动，并在 Linux/X11 上尽力用 `xdotool windowunmap` 从窗口管理器/任务栏/Alt-Tab 隐藏（`ui.display.window="offscreen"`、`ui.display.hidden=true`）；默认**无可见窗口、不抢焦点**。浏览器的进程本身仍出现在系统进程列表里（无法在不使用特权手段的情况下隐藏进程）。持久 profile（默认 `$DSH_HOME/ui-testing/headed-profile`，可用 `DSH_UI_TESTING_PROFILE_DIR` 覆盖）保留登录态 / 站点 Cookie；无头模式仍使用每次启动的临时 profile。
- 切换模式会**关闭共享 Chromium 及其所有页面**（运行模式是整个插件共享的，跨 workspace）。切换成功后需要重新打开页面；面板会提示并回到空态。
- 有头模式需要 `DISPLAY` 或 `WAYLAND_DISPLAY`，否则返回 `DISPLAY_UNAVAILABLE` 并保持无头。设置 `DSH_UI_TESTING_HEADED_VISIBLE=1` 可让有头窗口正常显示（调试/手动登录用）；未安装 `xdotool` 时退化为离屏位置，不保证从任务栏隐藏。
- 有头不等于通过站点反自动化：Cloudflare / Turnstile 等仍可能挑战甚至拒绝自动化浏览器；需要人工交互时设 `DSH_UI_TESTING_HEADED_VISIBLE=1` 显示窗口再完成挑战，且不承诺一定通过。

## 能力发现

`browser_capabilities` 的 `tabs` 段报告版本、工具、`actions`（含 `wait`）、`maxTabsPerWorkspace:4`、`maxChildTabs:3`、`maxGlobalPages:8`、`idleMs`、`noticesLimit:8`、`closedHistoryLimit:8`、`keepalive` 说明与当前 selectedTab/views；`limits.tabs` 提供同一组限额与生命周期字段。读取 capabilities 不启动 Chromium、不取 lease。

## 边界（NOT）

- 不提供跨 workspace 选页；不把 profile 隔离伪装成登录态隔离；notices/recentClosed 不跨 workspace 聚合。
- 不做跨 tab 的缓存/网络/标注聚合，也不把其他 Agent 的 selectedTab 暴露给 list。
- `wait` 只观察宿主内存中的标签表，不订阅浏览器事件；被浏览器自身拦截（未产生 target）的 popup 不会有 notice，表现为"click 成功但无新标签"。
- 前台/可见性可能影响后台帧率；P0-E 不承诺 CPU/GPU/profile 隔离。
- 刷新/断线恢复、多面板并发、真实跨浏览器 SSO、idle/LRU 极端与 T3/T4 全矩阵仍按各套件 NOT_RUN 报告，不能由本页推断通过。
