# 多标签页（P0-E）

页面组按 **(workspace, provider, 团队根)** 分组：同一个团队根（Lead 与它的成员）共享同一组页；不同独立会话、不同团队根即使同在一个 workspace，也各有自己的一组，互相看不见、也不能互相写。每组有一个稳定的 primary 槽位 + child 标签；primary 是每个根各一个槽，child 的**最多 3 个**是跨 root 合计的（不是每个根各 3 个），全局同时 live 上限 8。每个标签是一个独立 Runtime，拥有自己的 page、URL/history、view、标注、网络缓冲、T2 ref 表、串行队列和 single-owner lease；Cookie/localStorage/缓存仍由同一个 Chromium profile 共享，**不是登录态隔离**。

## 身份与选择

| 概念 | 行为 |
| --- | --- |
| workspace | 由 DSH 会话/workspace registry 决定；客户端不能靠路径重分组 |
| tab | 不透明 id；primary 固定为 `primary`，child 也有独立 `runtimeId` |
| 团队根（root） | 由宿主原生 identity 决定：Team 内是 `membership.root.id`，独立会话是它自己。页面组与权限都按 root 划分，**不由 workspace、cwd 或 parent 链推断** |
| Agent workSelection | 每个**真实执行会话**（`exec.agent.id`）独立保存的**写**目标；未显式选择时默认指向它**自己已拥有**的页（自己拥有 primary 就是 primary），没有任何自有页时保持**未绑定**（写操作返回 `TARGET_NOT_BOUND`，须先 `open`）。写工具只用它 |
| Agent observationSelection | 同一会话的**只读**目标，由 `select{mode:"observe"}` 显式设置；读工具优先用它，未设置时回退到 workSelection。观察不会改 workSelection，也不 claim 写租约 |
| GUI active | 每个调试面板独立；GUI 切标签不改变 Agent selection，Agent 改 selection 也不自动切 GUI |
| binding | HTTP/WS 用 `X-UI-Testing-Scope-Binding: <runtimeId>` 直接指定某个标签 |

跨 workspace 的 tab id、binding 或 WS scope 都会被拒绝；不能借 tab id 读取其他 workspace。

面板自己的视图不受 Agent 的标签选择影响：session 作用域的 GUI 请求带 `X-UI-Testing-Scope-Tab: primary`（WS 用 `&tab=primary`），Host 见到它就跳过 Agent 的 `selectedTab` 解析，始终渲染本 workspace 的 primary。不带该提示的调用仍是"跟随该会话选中的标签"（工具与旧客户端行为不变）。

## browser_tabs

唯一的 P0-E 管理工具（第 36 个工具）；其他 35 个工具的参数 schema 不变，调用默认走当前会话自己的选择（写用 workSelection，读优先 observationSelection）。

```jsonc
{
  "action": "list | current | select | open | close | wait | acquire | release | transfer",
  "tabId": "select/open?/close/wait/acquire/release/transfer 使用；close 省略=当前标签",
  "mode": "仅 select：work（默认）| observe",
  "kind": "仅 wait：primary | tab",
  "source": "仅 wait：primary | gui-popup | agent-open",
  "timeoutMs": "仅 wait（等待预算）| acquire（等待安全边界的预算）：0–30000，默认 5000",
  "pollMs": "仅 wait：50–1000，默认 100",
  "expectedControlRevision": "仅 acquire/release/transfer：必填，CAS 期望的 controlRevision",
  "expectedOwnershipRevision": "仅 transfer：必填，CAS 期望的 ownershipRevision",
  "toSessionId": "仅 transfer：本 root 内有效成员 SessionId（提交前重取原生 roster 校验）"
}
```

字段按 action 归类，**非所属 action 的字段会被拒绝**（`INVALID_ARGUMENT`），不会被静默忽略：例如 `list` 只接受 `action`，带上 `tabId` 或 `timeoutMs` 都是参数错误。

| action | 行为 |
| --- | --- |
| `list` | 只读列出当前 workspace 的标签与生命周期字段（见下表），并附带 `notices`、`recentClosed` 与调用者 selection；不启动 Chromium、不取 lease |
| `current` | 只读确认当前会话的选择（返回 `workSelection` 与 `observationSelection`，`selection` 是 work 的兼容投影）；若有 pendingReset，报告 primary 与 resetReason 并确认复位 |
| `select` | 只改**调用者自己**的选择，不 claim 租约、不 activate。`mode:"work"`（默认）要求本会话可写该页（owner/controller）或本 root 的 Lead 可管理它；`mode:"observe"` 只要同 root 可读。跨 root 的目标一律 not-found 语义；被拒绝时不改变调用者已有选择 |
| `open` | 新建 about:blank child 并选择（同时写入 work/observation 两个选择）；不要求先有 popup |
| `close` | 走长期权属判定（owner 或当前 controller；本 root 的 Lead 也可以）；省略 tabId 关闭当前标签；关闭/退休记入 `recentClosed` |
| `wait` | 纯 Host 内存轮询：等待**调用开始后新出现**的标签；超时抛 `WAIT_TIMEOUT`（`details` 含 `elapsedMs/polls/condition`） |
| `acquire` | 仅本 root 的 Lead：先关门（`owned → draining`，controller 不变），等当前操作到达安全边界（有界、可取消，**不中断**在途操作），再提交 `controller=Lead`、`controlRevision+1`。超时返回 `BUSY` 并撤销 draining，取消返回 `ABORTED`，两者都不会留下后台接管 |
| `release` | 仅本 root 的 Lead：把控制权还给 owner（`controlRevision+1`，owner 不变）。相同当前版本的重复调用返回 `changed:false` |
| `transfer` | 仅本 root 的 Lead：把 owner+controller 一起转给本 root 的有效 roster 成员（`ownershipRevision` 与 `controlRevision` 各 +1，`creatorSessionId` 保留）。目标不是成员/成员失效返回 `TAB_FORBIDDEN` |

`list` 的每个标签在既有 `tabId/runtimeId/kind/title/url/status/selected/busy/owner/reset` 之外新增：

| 字段 | 语义 |
| --- | --- |
| `source` | `primary`（稳定槽位）/ `gui-popup`（真人 `target=_blank`/`window.open` 接管或 GUI `+`）/ `agent-open`（`browser_tabs.open`） |
| `parentTabId` | popup 的 opener 标签 id（`primary` 或来源 child）；primary 为 `null` |
| `openEventId` | 真人 popup 的 open 事件 id；`agent-open`/GUI `+`/primary 为 `null` |
| `createdAt` / `lastUsedAt` | 入口创建与最近使用的时间戳（epoch ms）；页面工具调用会刷新 `lastUsedAt` |
| `idleRemainingMs` | 距 idle 回收剩余的毫秒数，按 `registry.idleMs` 计算（下限 0） |
| `manageable` | **兼容字段**：当前 Agent 会话是否未被其他会话的短租约占用。它不表达 ACL，不要用它推导权限——看 `permissions` |
| `accessVersion` | 访问投影版本（当前 `1`） |
| `rootSessionId` / `creatorSessionId` / `ownerSessionId` / `controllerSessionId` | 长期归属与控制权；`creator` 是审计字段，转交后保留 |
| `ownershipRevision` / `controlRevision` / `accessState` | 归属与控制的 CAS 版本、控制状态（`owned`/`draining`/`lead-controlled`/`retired`） |
| `permissions` | `{read,write,close,manage}`，由调用者身份对该页现算；`write` 表示当前可直接派发，Lead 需要先接管时 `write:false`、`manage:true` |

`busy` / `owner` 仍是**短租约**投影（`owner` 只表示"谁最近在写"），与长期归属/控制是两件事：页面归属不会因为 15 秒、思考、断线或 inactive 而改变。

`list` 同时返回两个本 workspace 的有界投影（各最多 8 条）：

- `notices`：被策略阻断的 popup，`{id, reason, parentTabId, parentRuntimeId, openEventId, at}`。用于区分"click 成功但策略阻断"与"确实没有新页"。
- `recentClosed`：最近关闭/退休的标签，`{tabId, kind, reason, at}`，`reason` 为 `closed`（显式关闭或外部关闭）、`idle`（idle 回收）、`evicted`（LRU/容量淘汰）。

`wait` 的语义：

- 不带 `tabId`：只匹配**调用开始后**新出现的标签（调用时已存在的标签不会被当作命中）；`initializing` 的 popup 要等 ready 后才算出现。
- 带 `tabId`：等待该 id 存在；调用时已存在则立即命中。
- `kind`/`source` 可叠加过滤；`timeoutMs:0` 只采样一次。
- 不启动 Chromium、不取/续 lease、不刷新 idle 计时；命中返回 `{matched:true, matchedTab, elapsedMs, polls, condition}`。统一结果元数据里的 `tab:{id,runtimeId,selectionRevision}` 仍是调用所路由标签，命中的新标签在 `matchedTab`。

错误码：
- `TAB_NOT_FOUND`：跨 root 或跨 workspace 的目标统一用这个码，**不回显**对方的 id/URL/标题，不泄露存在性；
- `TAB_FORBIDDEN`：能看见的本 root 目标但当前角色/归属不允许（例如成员写队友的页、transfer 目标不是成员）；
- `TAB_CONTROL_CHANGED`：controller 不匹配、正在 `draining`、或 `expectedControlRevision` 过期——读 current 后重新决策，**不要当 BUSY 自动重放**；
- `TAB_OWNERSHIP_STALE`：`expectedOwnershipRevision` 不匹配；
- `TAB_IDENTITY_UNAVAILABLE`：当前调用者的身份/成员关系无法证明（不自动降级成"独立会话"）；
- `TAB_LIMIT`：容量；
- `BUSY`：**只表示短暂忙**（页面队列被占、接管等待超时），不是权限答案；
- `WAIT_TIMEOUT`、`INVALID_ARGUMENT`（含"非所属 action 的字段"）。
匿名调用 select/open/close 返回 `UNSUPPORTED`（`agent-session-required`）。结果统一附带 `tab:{id,runtimeId,selectionRevision}`；管理动作另附 `changed` 与 `control`（最终 controller/版本），被自动接管执行的写操作附 `autoAcquired:true`。

## BUSY 与并发

- **15 秒 lease 只表示"短暂忙"，不决定权限**：谁能写由 root → 角色 → controller/版本决定。只读观察不占写租约（同一时间别人仍可写该页），写操作之间仍按 tab 串行。
- **BUSY 按 tab 计**：Agent A 在 tab1 工作不阻止 Agent B 在 tab2；同一 tab 上另一会话正在执行写操作时，后到的写才返回 `BUSY`。
- **两 root 互不阻塞**：不同独立会话/团队根在同一个 workspace 各有自己的页，各自 select `primary` 都成功，谁也不会把对方挤成 BUSY。
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
- child 关闭被 Agent lease 挡住时（GUI 与 Agent 同时操作），面板会提示「标签正被 Agent 操作；稍后再关闭」；其他拒绝（绑定失效、Host 找不到该运行时）提示「关闭标签失败，请稍后重试」，关闭请求不再静默成功。
- **面板按 runtime id 寻址当前标签**：active 标签是 child 时，`/state`、`/frame`、`/close`、`/tabs` 都带 `scope-binding` = 该标签的 runtimeId（primary 同理），Host 用这个 id 解析到**该标签自己的** entry（primary 或 child），不借用 Agent session 的 selectedTab，也不把 child 的 binding 当成 primary 的 workspace key。`scope=recent` 与 binding 都直接命中已存在的 entry，不会为同一 workspace 再造一个 Runtime。绑定必须命中真实 entry：`/close` 命中不到返回 404 `SCOPE_NOT_FOUND`（不返回假成功）；`/tabs.open` 解析不到所属 primary 也报 `SCOPE_NOT_FOUND`，只有真的到容量上限才是 `TAB_LIMIT`。
- 4/8 容量与 per-tab lease 同样约束 GUI：第 5 个标签/tab 返回 `TAB_LIMIT` 并在本地提示。

## 容量与来源

| 限制 | 值 |
| --- | --- |
| primary 槽 | 每个 (workspace, provider, 团队根) 一个 |
| 每个 (workspace, provider) 的 child 标签 | 最多 3（**跨 root 合计**，不按 root 各给 3） |
| 每 workspace 的乘积预算 | (workspace, provider) 4 页；当前实现强制的是上面两条 child/primary 规则 + 全局 8，完整的预留与合计算法在后续容量切片重写（`browser_capabilities.tabs.maxTabsPerWorkspace:4` 报的是该预算值） |
| 全局同时 live pages + 创建预留 | 8（沿用原 profile 上限，跨 provider、跨 root 一个数） |
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
- 有头模式在 POSIX 宿主上需要 `DISPLAY` 或 `WAYLAND_DISPLAY`，否则返回 `DISPLAY_UNAVAILABLE` 并保持无头；Windows 宿主自带窗口系统，不需要这两个变量（任务栏/Alt-Tab 隐藏走 `WS_EX_TOOLWINDOW`，依赖系统 `powershell.exe`，不可用时退化为离屏位置）。设置 `DSH_UI_TESTING_HEADED_VISIBLE=1` 可让有头窗口正常显示（调试/手动登录用）；未安装 `xdotool` 时（仅 Linux/X11）退化为离屏位置，不保证从任务栏隐藏。
- 有头不等于通过站点反自动化：Cloudflare / Turnstile 等仍可能挑战甚至拒绝自动化浏览器；需要人工交互时设 `DSH_UI_TESTING_HEADED_VISIBLE=1` 显示窗口再完成挑战，且不承诺一定通过。

## 能力发现

`browser_capabilities` 的 `tabs` 段报告版本、工具、`actions`（九个动作）、`maxTabsPerWorkspace:4`、`maxChildTabs:3`、`maxGlobalPages:8`、`idleMs`、`noticesLimit:8`、`closedHistoryLimit:8`、`busyScope`、`keepalive` 说明与当前 selectedTab/views；`limits.tabs` 提供同一组限额与生命周期字段。读取 capabilities 不启动 Chromium、不取 lease，也不会为陌生 root 创建持久 entry。

## 边界（NOT）

- 不提供跨 workspace / 跨团队根选页（跨 root 的目标一律 not-found 语义，不回显对方 id/URL/标题）；不把 profile 隔离伪装成登录态隔离；notices/recentClosed 不跨 workspace 聚合。
- 不做跨 tab 的缓存/网络/标注聚合，也不把其他 Agent 的 selectedTab 暴露给 list。
- `wait` 只观察宿主内存中的标签表，不订阅浏览器事件；被浏览器自身拦截（未产生 target）的 popup 不会有 notice，表现为"click 成功但无新标签"。
- 前台/可见性可能影响后台帧率；P0-E 不承诺 CPU/GPU/profile 隔离。
- **观察不切前台，但后台页的帧新鲜度不保证**：只读工具既不占写租约、也不调用 `activate()`（不切前台、不改 `visibilityState`、不打断别人的写）。代价是**有头模式**下当前前台不是该页时，Chromium 可能不合成它，截图/预览可能拿到旧帧；无法保证实时帧时应按 `OBSERVATION_UNAVAILABLE` 处理（该码已定义，尚未在全部观察路径接线）。
- **GUI 面板侧没有 Principal，也没有接管入口**：面板能 list/open/close 与预览，但 `acquire/release/transfer` 只有 Agent 工具面可用；面板仍只靠同源浏览器认证，不能证明它代表哪个会话。
- **证据归属未按 root 隔离**：`browser_network*`、T3 产品/基线、T4 动态会话仍按 workspace/session 归属，跨 root 共享同一采集器与存储，不能当作 root 隔离的证据。
- **DevTools 直连地址仍会投影**：受管页可能仍返回 `127.0.0.1:<port>/devtools/...` 直连地址，该通道不受本页描述的权限模型约束。
- 刷新/断线恢复、多面板并发、真实跨浏览器 SSO、idle/LRU 极端与 T3/T4 全矩阵仍按各套件 NOT_RUN 报告，不能由本页推断通过。
