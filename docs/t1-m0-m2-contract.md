# T1 M0–M2 实现契约与验收记录

> 索引：[index.md](index.md) · 更新于 2026-10-31（第 4 轮：独立 HTTP API 收口 + 输入/状态/清理修复）· 当前阶段：主机侧 `run.mjs` **22/22 组、303/303 必需项、0 failed/skip、exit=0**（Lead 独立复跑，报告 `runs/2026-10-31T13-08-56-816Z-277736/run-report.json`）；故障注入 16/16（连跑 3 次）；隔离宿主 `verify-3081` **22/22 PASS、exit=0**（报告 `runs/host-3081-1793452433416/report.json`）；真实 Agent 会话内第九工具调用与 provider 图像可见性 NOT_RUN。**第 9 轮 / P0-D 混合画布现状**：工具面 30；共享视口 `viewport.mjs` **14/14、166/166**、GUI `viewport-gui.mjs` **142/142 PASS/5 NOT_RUN**（V12 拖拽 + V13 画布）、截图 `capture-p0` **15/15、162/162**、T3 **56/56、415/415**；`run.mjs` 等全量回归以 [status.md](status.md)「Lead 独立终验」为准。见下方「共享视口契约摘要」与 [canvas-viewport.md](canvas-viewport.md)。

> **T2 说明（2026-11-01）**：第 6 轮已实现 Web T2 结构化 GUI（工具面 9 → 16），本文保留 T1 M0–M2 契约与历史验收，不重写。T2 契约见 [t2-structured-gui.md](t2-structured-gui.md)，现行能力/验收以 [status.md](status.md) 与运行注册表为准。
>
> **第 9 轮共享视口（2026-11-01）见 [viewport-control.md](viewport-control.md)**：新增第 10 个 T1 工具 `browser_viewport`（能力 `web.t1.viewport`，工具面 29 → 30），本文的 T1 工具语义**除两处有意变更外不变**：① `browser_screenshot` 省略 `scale` 时不再固定为 1，而是跟随共享 `view.scale`（显式 scale 合法范围 1–4 → 0.1–4）；② T3 `Source.live` 同规则（`act` 沿用原采集比例）。其余 T1 工具的参数/返回/错误码不变，`browser_state` 只**新增**安全 `view` 字段。
>
> **第 8 轮网络 P0（2026-11-01）见 [network-p0.md](network-p0.md)**：新增 7 个 `browser_network_*`（工具面 22 → 29，本文的 T1 九工具参数/返回/语义不变），网络采集/分析/链路/控制/证据/订阅的现行契约与验收口径以该文为准，本文不重写。

本文是 [t1-issues-and-solutions.md](t1-issues-and-solutions.md) 推荐 M0–M2 的现行契约（该文已按「已解决/部分解决/未解决」重排）。旧审计见 [t1-infrastructure-audit.md](t1-infrastructure-audit.md)，其中旧工具数量、缺陷和运行实例状态仅代表历史快照。新结果必须附实际命令与输出后才能标为通过，不以本契约或静态 manifest 代替实测。

## 工具与运行态

工具面为 **10 个 T1 工具**（全插件 30 个）：`browser_navigate`、`browser_eval`、`browser_screenshot`、`browser_input`、`browser_network`、`browser_computed_style`、`browser_http_request`（第 4 轮新增，独立 HTTP API）、`browser_viewport`（第 9 轮新增，共享视口 get/set）、`browser_state`、`browser_capabilities`。`browser_input` 的 schema 已扩展（N2：`modifiers`／`virtualKeyCode`／`autoRepeat`／`unmodifiedText`／`commands`／`location`／`isKeypad`，mouse 的 `buttons`／`modifiers`／`pointerType`，wheel 的 `modifiers`；见下「输入事件契约」）；`browser_state` 增错误归属字段；其余工具输入不变。T4、浏览器扩展操作（下载/上传/Cookie 导出/多标签/frame 选择）仍未实现；Agent 视口工具已由 `browser_viewport` 实现（契约见 [viewport-control.md](viewport-control.md)）；独立 HTTP 的完整契约见 [t1-http-request.md](t1-http-request.md)。

- 注册表决定当前 Agent 能调用哪些名字；`browser_capabilities` 根据调用方 session 与 active/idle owner 报告 `available / unavailable / unsupported`、原因与限制，不能直接回显静态 manifest。其他 owner 占用时页面/network 标 `unavailable`、reason `BUSY`，诊断工具仍 `available`。未启动的 T1 可声明 `available`（按需懒启动，constraint 明示启动可能失败）；`running/transport` 单独反映真实连接，不将未启动当不支持。附件服务状态与截图 fallback 另报限制。
- `browser_state` / `browser_capabilities` 是诊断调用，不懒启动、不申请页面所有权；已有浏览器的标题从 `document.title` 刷新。`running:false` 不等于不支持。
- 5 个页面工具可懒启动；`browser_network` 不启动，但须通过租约检查。导航检查 `Page.navigate.errorText` 与最终 URL；成功不保证 load complete，业务就绪仍需另查。

## 共享视口契约摘要（`browser_viewport`，第 9 轮）

完整契约（数据模型、观测节流、坐标映射、截图比例、错误与验收）见 [viewport-control.md](viewport-control.md)；这里只列对 T1 契约有影响的部分。

- **一份权威 view**：每工作区 Runtime 持 `view={version:1,mode,x,y,canvasX,canvasY,width,height,scale,source,revision}`（文档 CSS px；canvasX/Y 为画布原点，x/y 为真实滚动）。`x/y` 是页面顶层滚动位置（`Page.getLayoutMetrics` 实测），`width/height` 整数 200–4096，`mode` 由宽高派生，`scale` 0.1–2（10–200%），`source=default/gui/agent/page`，`revision` 只在内容变化时递增。顶层 `viewport={width,height}` 是别名。`browser_state` 与认证 GUI 的 `ui.view` 是同一数据的投影。
- **get 只读 / set 页面操作**：`get` 只读缓存诊断（不 ensure、不发 CDP、不进队列、不占租约、不改 recent/error，可读他人租约下的缓存并明示 `stale`）；`set` 至少一个 view 字段（`mode` 与 width/height 互斥，`mode` 展开宽高后同传的 x/y/scale 仍生效），走队列内 CAS → 懒启动 + 租约，只有宽高变化才发 `Emulation.setDeviceMetricsOverride`，scale-only / x/y-only 不改 CSS 视口、DPR 或页面 zoom。
- **CAS**：`expectedRevision` 在队列内复查，冲突抛 `VIEWPORT_CONFLICT`（state / retryable，HTTP **409**），patch 零应用、返回最新 view、不覆盖 page `lastError`；不自动重放。
- **HTTP 兼容**：`POST /viewport` 同时接受 legacy `{width,height}`（原 Number/round/clamp 与 `viewport` 返回，保留 x/y/scale）与 v1 `{version:1,...}`（与工具同严格校验）；`/state`、`/frame`、ensure/navigate/reload/history 都附带 `ui.view/ui.viewMeta/ui.observed`。
- **对其他工具的影响（仅这两处）**：`browser_screenshot` 省略 `scale` → 当前 `view.scale`（cold 1），显式 scale 0.1–4；T3 所有 `Source.live` 省略 `scale` → 本次调用冻结的 `view.scale`。T2 bbox/输入坐标、`browser_input` 的 wheel 单位仍是 CSS，不乘 `view.scale`；其余 T1 工具参数/返回/错误码未变。
- **能力报告**：`browser_capabilities` 新增 `viewport` 段与 `limits.viewport`，工具表 30 项；其他 owner 持租约时 `web.t1.viewport` 与页面类一起 `unavailable`+BUSY（reason 注明 get 仍可只读诊断），诊断工具与 `browser_http_request` 仍 available。

验收（同一最终代码，执行者/Lead）：`tests/acceptance/viewport.mjs` **14/14 probes、166/166 requiredChecks、exit 0**（画布 v2；[19-50-26](../tests/acceptance/runs/viewport-2026-11-01T20-18-41-148Z-769923/report.json)）；隔离 DSH GUI `tests/acceptance/viewport-gui.mjs` **142/142 PASS、5 NOT_RUN、exit 0**（[20-07-15](../tests/acceptance/runs/viewport-gui-2026-11-01T20-07-15-023Z-753710/run-report.json)）；`capture-p0.mjs` **15/15、162/162**（[19-51-08](../tests/acceptance/runs/capture-p0-2026-11-01T20-18-32-415Z-768943/report.json)）；`t3-vision.mjs` **56/56、415/415**（[19-37-29](../tests/acceptance/runs/2026-11-01T20-18-56-169Z-770336/run-report.json)）；`runtime-faults` 16/16。**真实宿主 3080 于 2026-11-02 11:15 重启并加载画布 v2**：画布 Host 面已实测（[证据](../tests/acceptance/evidence/canvas-realhost-2026-11-02.md)）；画布前构建的复验见 [viewport-real-host-2026-11-02.md](../tests/acceptance/evidence/viewport-real-host-2026-11-02.md)。**面板画布交互与需 GUI 认证的路由仍 NOT_RUN**。T2/network/workspace/check-skill 全量回归由 Lead 终验复跑。

## 输入事件契约（N2，已实现）

`browser_input` 仍是 `{events: Event[]}`，`events` 必填，单个事件 `kind` 必填（`mouse|wheel|key|text`），其余字段可选，老式最小调用（`{kind:'mouse',type:'mousePressed',x,y,button,clickCount}` / `{kind:'key',type:'keyDown',key,code}`）保持可用。

- `modifiers`：字符串数组 `['alt','ctrl','meta','shift']` 或 CDP 位掩码整数 0–15（Alt=1、Ctrl=2、Meta=4、Shift=8）；两种形态都归一成位掩码传给 `Input.dispatchKeyEvent`/`Input.dispatchMouseEvent`。非法名字、非法类型、越界值一律 `INVALID_ARGUMENT`。
- key 事件全部透传：`key`、`code`、`text`、`virtualKeyCode`（→ `windowsVirtualKeyCode`）、`autoRepeat`、`unmodifiedText`、`commands`、`location`、`isKeypad`、`modifiers`；`type` 允许 `keyDown|keyUp|rawKeyDown|char`。
- mouse 事件透传 `type`、`x`、`y`、`button`、`buttons`、`clickCount`、`modifiers`、`pointerType`（`mouse|pen`）；wheel 透传 `deltaX/deltaY` 与 `modifiers`；text 仍走 `Input.insertText`。
- **整批先校验再派发**：参数不合法时在启动 Chromium / 派发任何事件之前抛错，不会留下"半批事件"。
- 已实测的页面真值（P20）：Tab 前进、Shift+Tab 反向、Ctrl+A 的 `ctrlKey/key/keyCode=65`、位掩码 2|8、`autoRepeat→e.repeat`、Numpad 的 `location=3`、mouse/wheel 的修饰键；`commands`/`unmodifiedText`/`pointerType:pen` 只有 schema 与透传，**无页面级行为断言（未验证）**。

## 所有权、队列与取消

`single-owner-lease` 只限制同工作区所有权；页面隔离按 DSH 工作区（每工作区独立 page/URL/viewport/history/网络缓冲/队列/租约）。同一时刻一个 Chromium/profile；Cookie/localStorage/cache 共享，不是安全隔离。完整契约见 [workspace-isolation.md](workspace-isolation.md)。

- `exec.agent?.id` 为 sessionId；先读 `exec.agent.session.header.cwd` / `ctx.sessions` / `ctx.sessionPersistence.stat`，再经 `workspaceRegistry.resolveByPath` 精确映射工作区。缺失 exec/agent 走 `legacy:default`；显式未知 session 返回 `SCOPE_NOT_FOUND`。
- 空闲租约 15s，进行中的操作保持租约，结束后重新计空闲窗口。其他会话的页面调用及 `browser_network` 返回 retryable `BUSY`；`browser_state` / `browser_capabilities` 仍可诊断。
- `agent/disposed` 只释放对应 owner；同工作区面板与 Agent 进入该工作区的串行队列，避免与该工作区 Agent 命令交错；不同工作区互不影响。租约不保证面板操作后页面内容仍符合 Agent 的先前观察，也不隔离 Cookie/存储。
- `exec.signal` 支持取消。若 CDP 命令已经发出，在串行队列内关闭当前浏览器后才放锁，避免未结束的旧命令与下一操作交错；后续调用可重新懒启动。取消不回滚已发生的网页副作用，重试前先核对应用状态。
- pending CDP 命令的定时器在完成、失败、取消、断连时清理；网络请求 Map/记录有界。`responseReceived` 后保留请求映射直到 `loadingFinished/loadingFailed`，因此已收到 200 响应但正文传输随后截断也标记 failed；响应头到达不等于完整响应接收成功。
- 关闭清空网络/帧/URL/标题等运行态并回收进程与 profile；CDP 断连后旧 proc/profile 也须回收，不能仅清掉连接引用。以上追加路径已由主验收（第 4 轮 22 组 303 项）与 16 项故障注入覆盖。

## 错误契约

工具执行失败抛 `BrowserError`，含 `code/category/retryable/details`，message 使用 `[CODE]` 前缀并含该次 action 的证据摘要。不能假定 DSH 必然把自定义字段写入结构化 `info.code`。

页面 eval 异常、style 元素未命中等操作失败返回 `{ok:false,error:{code,category,retryable,message,details}}`；eval 保留异常描述/栈和位置。HTTP 错误保留兼容的 `{ok:false,error:"字符串"}`，新增同级 `code/category/retryable`。

| code | 含义 |
| --- | --- |
| `NAV_FAILED` | 导航 net error、错误页或最终目标失败 |
| `CDP_TIMEOUT` | CDP 命令超时 |
| `CDP_DISCONNECTED` | CDP 连接断开 |
| `TARGET_NOT_FOUND` | 样式选择器未命中 |
| `EVAL_ERROR` | 页面 JavaScript 异常 |
| `BUSY` | 其他 owner 持有页面租约 |
| `ABORTED` | 调用被取消 |
| `INVALID_ARGUMENT` | 参数或目标不合法 |
| `UNSUPPORTED` | 能力未实现 |
| `INTERNAL` | 未分类内部失败 |
| `HTTP_TIMEOUT` | 独立 HTTP 总截止时间到期（不是 CDP 超时，不触发关浏览器） |
| `HTTP_FAILED` | 独立 HTTP 传输/TLS/协议/头超限/正文异常中断 |
| `HTTP_REDIRECT_LIMIT` | 显式重定向预算不足，被超限跳零派发 |

`retryable:true` 仅是重试提示，不代表有副作用的操作可以盲目重放。操作成功与 Agent 的 `PASS/FAIL/BLOCKED/INCONCLUSIVE/NOT_RUN` 断言分开记录。

### 返回值必须是 lossless JSON（真实宿主硬约束）

宿主在 `@deepseek-ai/dsh-tools` `lib/index.js:2672-2681` 用 `snapshotToolValue()` → `@deepseek-ai/dsh-util-values` `snapshotJsonValue()` 校验工具返回值，**含 `undefined` 属性、非有限数字、`-0`、稀疏数组、类实例的对象会被判非法**，整次调用以 `INVALID_TOOL_OUTPUT`（`value is not lossless JSON`）失败——即使业务逻辑完全正确。fake-ctx 验收不跑这一步，只有真实 Agent 会话才会暴露。

- 现行实现：`register()` 包装器是唯一返回边界，成功值与错误 `details` 都过 `losslessJson()` 投影（剔除 `undefined`、非有限数字/`-0`→`null`、`Error`/类实例转纯对象），截图附件用 `projectAttachment()` 投影为纯 JSON（`attachmentId/mediaType/bytes/width/height/name/originalDimensions`）。
- 源头同时修好：args 摘要不再产生 `length: undefined`，`browser_eval` 页面值为 `undefined` 时省略 `value`，错误 details 的位置字段用 `null`，网络条目的 `method/type/at` 不再 undefined。
- 回归：P21 用**真实** `@deepseek-ai/dsh-util-values@0.2.1-rc.5`（按 `DSH_ROOT` + package.json exports 解析）断言 9 工具返回值与 render content，并用真实 `@deepseek-ai/dsh-tools` 的 `assertSupportedJsonSchema` 断言 9 个 `output.schema` 落在宿主白名单子集；参数 schema 另验 lossless。新增工具/改返回体必须过 P21。

### 结构化 `info.code` 暂不可达

宿主只对 `HarnessError` 实例写结构化 code（`errorInfo()`，`lib/index.js:2709-2717`），而该类型既不由 tools 包再导出，插件按自身 realpath 也解析不到（`dsh-llm` 不在 profile `node_modules`，插件无依赖声明）。因此现行契约只保证 `[CODE]` 前缀 + 返回字段，**不承诺** `info.code`。详见 [t1-issues-and-solutions.md](t1-issues-and-solutions.md) §3.3。

## 目标与网络边界

Host 校验 HTTP(S) 目标、DNS 解析结果与最终 URL；Document Fetch 拦截继续校验导航/重定向文档请求。默认允许 loopback，阻断 RFC1918（`DSH_UI_TESTING_ALLOW_PRIVATE=1` 显式开放）、metadata/link-local、unspecified、multicast、带凭据 URL，以及配置了 `DSH_WEB_URL` 时的 DSH 自身 origin。

额外 page/popup 不成为可操作 target：先通过 autoattach 暂停，安装 Fetch fail-all 后才 resume/close，防止弹窗在接管前访问被阻断目标；这不是多 target 支持。本轮追加实现（popup fail-all、200 后截断、断连回收）已由最终主验收与 16 项故障注入单测覆盖。

这不是完整网络沙箱：主页面子资源、页面内 fetch/WebSocket 等不因 Document 拦截而获得同等目标隔离；DNS 校验与浏览器连接之间仍有 rebinding/时序风险。未设置 `DSH_WEB_URL` 时不能承诺识别所有宿主 origin。目标放行不构成用户授权。

网络 URL 脱敏后记录；包括敏感 query、凭据与 fragment 等规则覆盖的字段。脱敏是尽力处理，路径、页面内容及未知业务字段仍可能敏感；不提供请求/响应头或正文。

## 每次调用的证据与截图

所有工具返回并 render `actionId/sessionId/startedAt/finishedAt/target/args`（args 为摘要）；失败 message 也包含证据摘要。camelCase 字段是现行契约，不存在自动 `assertion_status` 或独立 JSONL 证据包。

截图继续返回 PNG base64 `image`，新增 `capturedAt/sha256/attachmentId` 元数据。可用时调用可选 `ctx.attachments.saveImage` 并 render image block；无附件服务时 render 明确的 `base64-fallback` 文本。不能把附件 ID 当宿主文件路径，也不能仅凭附件保存成功断言 provider 已显示图像。真实模型可见性与 provider 视觉支持须单独验收。原始截图/可见附件不意味着 T3 像素差异或视觉分析管线已实现。**后续 P0（2026-11-01）**已增加 clip、连续scale1–4、PNG结构/尺寸/均匀统计、安全落盘和capture证据；**2026-11-02 画布 v2 起 region 为 canvas CSS（O=0 等同文档），O≠0 由白底合成并披露 composite**；此前无裁剪表述仅代表历史，权威接口见 [capture-p0.md](capture-p0.md)。后续默认暂存修订：persist默认false；只有out/persist:true/非空env才持久到env或cwd根，默认与legacy均用插件暂存，dispose清理。file增加pathKind/persistence/root/ephemeral；持久相对路径、暂存绝对路径，observed不含绝对路径。修订后14/14、142/142（[报告](../tests/acceptance/runs/capture-p0-2026-11-01T05-52-05-302Z-104057/report.json)），tmp不可写真实场景/SIGKILL清理NOT_RUN；下方数字保留历史。P0真实Chromium+fake ctx三次各13/13、115/115（[报告](../tests/acceptance/runs/capture-p0-2026-11-01T04-58-32-550Z-66980/report.json)），T1回归22/22、324/324（[报告](../tests/acceptance/runs/2026-11-01T04-59-29-531Z-68121/run-report.json)）；P0真实宿主重载/provider仍NOT_RUN，历史计数不改写。

证据字段必须进入 render 内容，因为工具 value 本身不保证进入 durable 事件。`/metrics` 仍只是面板预览诊断，不是页面断言证据。

## GUI 地址栏与导航历史（2026-10-31 实现契约）

用户报告的缺陷是"地址栏只记录输入历史，不跟运行时真实地址；刷新/后退/前进用本地列表，会跳到别的页"。本轮按"完整对齐真实浏览器"实现，规则如下（端点与事件细节见 [runtime-t1.md](runtime-t1.md)）。

- **原始地址与工具投影隔离**：`state()` 仍是固定脱敏投影，`browser_state` 直接返回它；新增 HTTP 专用 `uiState()`：`ui:{version:1,runtimeId,revision,address,history{available,index,length,canGoBack,canGoForward}}`。`address` 为主框架真实 `location.href`（含 query/hash，未脱敏），`history` 只是 CDP 历史的聚合投影，不暴露 entries/entryId/title。每次 HTTP 快照 `revision+1`（从 0 起），`runtimeId` 在一次 Host 插件生命周期内固定；停止时 `address=''`、history 全禁用、`index:-1`、`length:0`，但 `revision` 继续递增。
- **鉴权（fail closed）**：只有 `ctx.get('connection')` 存在、`requestRejection(req)` 明确返回 `undefined` 的已认证同源 GUI 才拿到 `uiState()`；服务缺失、抛错、401/403（含 DSH Host/Origin fence）一律只回既有脱敏 `state()`，老 GET/ensure/navigate 保持兼容。`/reload`、`/history` 必须鉴权：未认证 401/403，错误体 `{ok:false,error,code:'UNSUPPORTED',category:'capability',retryable:false}`，不写页面 `lastError`；UI state 响应 `Cache-Control: no-store`，不加宽泛 CORS。
- **三个写入口**：`POST /navigate`（沿用原语义）、`POST /reload {}`（`Page.reload({ignoreCache:false})`，不读客户端 URL，未运行 `TARGET_NOT_FOUND` 不懒启动）、`POST /history {direction:'back'|'forward'}`（队列内 `Page.getNavigationHistory()` → `currentIndex±1` 的 `entries[i].id` → `Page.navigateToHistoryEntry({entryId})`；越界 `moved:false` 零派发，非法 direction `INVALID_ARGUMENT` 零派发）。三者整体包在 `runtime.run()`，UI 调用 `agent:false`（串行但不占租约，不因 Agent owner 禁用按钮）。
- **提交语义**：CDP ACK 不是提交。发送前安装一次性主框架等待器（reload 等 `frameNavigated`；history 等 `frameNavigated` 或主框架 `navigatedWithinDocument`），提交后重读 URL/标题/历史再响应；10s 无提交 `CDP_TIMEOUT`（沿用 `run()` 超时先关浏览器再放锁），断连/取消沿用既有分类；listener/timer 清理。
- **三个写入口都在写路径同步刷新 title+history**：`/navigate` 在 `Page.navigate` 提交并校验最终 URL 后、返回前刷新（title 与 history 并发发起，不额外增加一次串行往返），所以 `/navigate` 响应里的 `ui.history` 已是新值，客户端不必等下一次 500ms 轮询。跨文档提交瞬间 `Page.getNavigationHistory` 可能返回瞬时错误 "Not attached to an active page"（新 renderer 尚未 attach），写路径按 0/0/5/10/20ms 有界重试后才退化为 `available:false`；`CDP_TIMEOUT`/`CDP_DISCONNECTED`/`ABORTED` 不重试、按既有分类抛出。
- **同步**：`Page.getFrameTree()` 记主 `frame.id`；主 `frameNavigated` 更新 url（含 `urlFragment`）、清标题、递增 metadata generation；`Page.navigatedWithinDocument` 只认主帧（覆盖 pushState/replaceState/hash/popstate，子 iframe 不污染地址）。`/state` 与 `/frame` 共同调用合并的 `refreshMetadataSoon()`：250ms 节流 + single-flight，不占写队列/租约、不懒启动；读取捕获 cdp 与 generation，过期结果丢弃并标脏，防旧结果跨 close/导航覆写。
- **客户端状态机**：删除本地 history/index 作为导航依据；地址栏只是编辑草稿（focused/dirty/editVersion/pending）。所有 `/state`、`/frame`、导航响应走单一 `acceptRemote(state)`（v1 按 runtimeId+revision 排序、轮询带 requestGeneration、退役 runtime 迟到响应丢弃）。聚焦编辑中不被轮询覆盖；Esc/blur 取消草稿；提交中可继续编辑且成功响应不覆盖新草稿；失败保留输入直到下次编辑/Esc/blur。三个按钮禁用由真实 `ui` 状态驱动（`pending`/未运行/history 不可用/方向不可用），不以 Agent owner 额外禁用。"在默认浏览器中打开"用 `ui.address` 且仅 HTTP(S)。
- **旧 Host 降级（不含视觉变化）**：响应无 `ui`（未重启的 Host 或未认证投影）→ 地址只显示脱敏 `remote.url`（绝不反向当原 URL），刷新/后退/前进禁用、不发新指令、不用 `Page.navigate` 模拟；用户显式编辑并提交仍走 ensure→viewport→navigate；单次网络失败保留最后快照，不立即降级；新 Host 重启后自动升级 v1。
- **范围**：仅单 Runtime/单主 page；不做多标签、跨 session 历史、历史条目列表、popup 接管、DOM history shim；不改样式/文案/图标/间距/布局。

验收边界：Host 主机侧（fake ctx + 真实 Chromium）与 3081 真实宿主的 HTTP 投影见本节证据行；GUI 端到端（无头 Chrome 打开 3081 面板断言 `.utb-addr.value`/按钮 disabled）由 `tests/acceptance/address-history-3081.mjs` 覆盖，执行结果以该脚本报告为准。

## 独立 HTTP API 与第 4 轮收口（2026-10-31）

工具 `browser_http_request`（能力 `web.t1.http-request`）是 Host 侧独立 HTTP(S) 客户端，完整字段、安全边界、错误表与 P22 断言见 [t1-http-request.md](t1-http-request.md)。要点：

- **独立分支**：不 `ensure/run/claim/touchAgent`，不建 profile，不读写页面 URL/title/error/activity/网络缓冲，不进页面串行队列；`browser_capabilities` 报文仍 `running:false`、HTTP 恒 available。插件卸载会取消在飞请求。
- **参数与返回**：默认 GET、`timeoutMs` 5000（上限 20000，总截止覆盖 DNS/连接/每跳/头/正文）、`maxBytes` 65536（上限 1048576）、`followRedirects:false`、`maxRedirects:0`（上限 5）。`ok:true` 只代表取得响应，404/500 正常返回；`headers` 小写→非空 `string[]`；敏感头 `["***"]`；`encoding` utf8/base64；`bodyBytes` 为保留原始实体字节；`bodyTruncated` 标记截断；不自动解压（发送 `accept-encoding: identity`）。
- **目标策略**：每次派发（含每一跳重定向）复用 `validateTarget`（scheme/DNS/loopback/RFC1918/allowPrivate/DSH origin）；HTTPS→HTTP 降级拒绝；`host/content-length/transfer-encoding/connection/cookie/accept-encoding/proxy-*/sec-*` 等头零派发拒绝；无 cookie jar；跨 origin 重定向清空全部调用方头；`Location`/`Content-Location` 等 URL 头脱敏。
- **错误**：新增 `HTTP_TIMEOUT`（timeout/retryable，不触发关浏览器）、`HTTP_FAILED`（network/retryable）、`HTTP_REDIRECT_LIMIT`（network/不可重试）；DNS 失败保留 `NAV_FAILED`；取消为 `ABORTED`。错误 details 带 `operation/url/phase/redirects/status`，不含正文/头值。
- **注册 schema**：真实宿主 `ToolRuntime.register()` 只对 `output.schema` 调 `assertSupportedJsonSchema`（白名单：`type/oneOf/properties/required/additionalProperties(boolean)/items/enum/const` + 注解 `description/title/default/examples`）；参数 schema 另需 lossless。越界关键字（`minLength/minimum/pattern/...`）在注册期直接失败，故所有长度/范围/模式边界都在执行时校验。
- **四项收口裁决**（细则见 t1-http-request.md §9）：① `browser_state` 增 `errorAt/errorActionId/errorTarget`，成功的页面/网络操作清空，诊断与 HTTP 不清；② `runtime-faults:208` 实现侧 `rm` 有界重试（5×50ms，失败记日志 + `cleanupError`）+ 测试侧 `waitFor` 3s；③ Chrome 解析 env→`/opt/google/chrome/chrome`→PATH（命令名只按 PATH），缺失 `UNSUPPORTED`、启动超时 `CDP_TIMEOUT`、早退 `CDP_DISCONNECTED`；④ P20 页面真值：`commands:['selectAll']` 以 selection 读数验证、`unmodifiedText` 特有作用不可观察记 `INCONCLUSIVE`、`pointerType:pen` 按 CDP 字符串派发并读回 `PointerEvent.pointerType`。

## 隔离验收与当前记录

主实例 **3080** 在实施/验收期间不重启、不操作；真实宿主验收以用户指定的 **3081 隔离实例**为准（本轮与用户确认：只重启 3081）。交付后用户已于 19:36:05 重启 3080（pid <pid>）并确认 `ui.version=1`，见 [status.md](status.md)。Host 与 bundled skill 更新须由隔离实例重新加载；文档保存不代表运行实例已生效。本轮（第 4 轮）做独立 HTTP API、`browser_state` 错误归属、Chrome 解析、`runtime-faults:208` 清理竞态与 `pointerType:pen` 映射；多 target、帧升级、UI 变更仍不做。

| 项目 | 当前验收状态 | 必需证据 |
| --- | --- | --- |
| 9 工具（第 9 轮起为 10 T1 / 总 30）、skill 与 manifest 一致 | PASS（结构与 fake ctx 注册）；隔离宿主 `apply()` 完整执行（`verify-3081` 22/22）；P1 断注册面恰好 9 个、P14 报 9 项 T1（http-request available）；**真实 Agent 会话（3080）仍是旧构建的 8 工具，第九工具的真实会话调用 NOT_RUN** | P1/P14/P21；check-skill 23/23、check-skill-registry 17/17；runs/2026-10-31T13-08-56-816Z-277736 |
| 导航失败、标题、eval/style/HTTP 错误分类 | PASS（覆盖路径） | P2/P3/P4/P10：含 SPA 标题、NAV_FAILED、操作 error 对象、HTTP 兼容分类 |
| URL 脱敏、loadingFailed、关闭资源 | PASS（覆盖路径）；Map/timer/断连恢复由单测覆盖 | P6/P8/P18；runtime-faults 16/16；启动失败清理与正常关闭 |
| BUSY、anonymous、disposed | PASS；15s 到期/进行中续持/排队取消由单测覆盖 | P9/P15：两 session、所有页面/network 工具、诊断不夺 owner；runtime-faults 16/16 |
| 面板串行、取消关闭后再放锁 | PASS（覆盖路径） | P17：1s 内 ABORTED、返回前关闭、后续懒启动 |
| 地址/DNS/Document 重定向策略 | PASS（覆盖路径） | P19：loopback、file/metadata/RFC1918/credentials/宿主 origin、Document metadata 重定向 |
| action render 与截图 attachment/fallback | PASS（fake 附件服务 + 真实宿主 PNG）；真实 provider 仍待验 | P16：9 工具 envelope、hash/时间、无服务 fallback、saveImage+image block |
| **返回值 lossless JSON + 注册 schema（真实宿主硬约束）** | **PASS**：9 工具返回值与 render content 全部过真实校验器；9 个 `output.schema` 过真实 `assertSupportedJsonSchema` | P21 **23/23**（校验器取自 `@deepseek-ai/dsh-util-values@0.2.1-rc.5`，`assertSupportedJsonSchema` 取自 `@deepseek-ai/dsh-tools`，按 `DSH_ROOT` 解析） |
| **N2 输入事件与页面真值** | **PASS（覆盖路径）**：modifiers/功能键、`pointerType:pen`、`commands` 页面读数；`unmodifiedText` 特有作用 INCONCLUSIVE（advisory，未折成 PASS） | P20 **28/28**；3081 verify-3081（本轮 22/22）中的 Shift+Tab 焦点反向、老式 mouse、非法 modifiers→500 `INVALID_ARGUMENT` |
| 3081 真实宿主 HTTP 集成与 authenticated GUI shell | **PASS 22/22、exit=0**（终版 pid <pid>）：authenticated `ui.version=1`、停止态 `address=''`/history 不可用、未认证/伪造 Origin 无 `ui`、`/reload`/`/history` 未认证 401/403、地址跟随真实目标 URL | [verify-3081 报告](../tests/acceptance/runs/host-3081-1793443392549/report.json)：注入 shell、single-owner runtime、title/SPA/eval stack、**Shift+Tab/老式 mouse/非法 modifiers**、NAV_FAILED、metadata/自身 origin、PNG/close + 本轮认证/UI 投影检查 |
| **GUI 地址栏/刷新/后退前进对齐真实浏览器** | **PASS**：GUI 端到端 **276/276、exit=0**（硬化后连续 3 次 + Lead 终验）（A–K 场景：冷启动/自主导航/redirect/pushState/hash/真实 back-forward/刷新/草稿与延迟注入/WS 回退/raw 隔离/legacy 降级）；Host 主机侧真实 Chromium 44 项 PASS（含 `/navigate`/`/history` 响应内 history 新鲜）；3081 authenticated `ui.version=1` 与鉴权/不泄漏 32 项 PASS | [Lead 终验报告](../tests/acceptance/runs/address-history-2026-10-31T11-18-49-001Z-243848/report.json)（276/276）；硬化连跑 [11-11-06](../tests/acceptance/runs/address-history-2026-10-31T11-11-06-542Z-233857/report.json)/[11-11-49](../tests/acceptance/runs/address-history-2026-10-31T11-11-49-052Z-235193/report.json)/[11-12-31](../tests/acceptance/runs/address-history-2026-10-31T11-12-31-087Z-236053/report.json)；B1/G1 专项 [12/12](../tests/acceptance/runs/address-history-2026-10-31T11-13-57-368Z-237117/report.json)/[12/12](../tests/acceptance/runs/address-history-2026-10-31T11-15-23-028Z-240144/report.json)；主机侧为 /tmp 自测脚本（未入库） |
| popup fail-all、200 后截断、断连旧 proc/profile 回收 | PASS | P19（popup 0 请求、200 后截断 failed/errorText）；runtime-faults（断连回收）；P17（失败 target 保留） |
| **独立 HTTP API（P22）** | **PASS（覆盖路径）**：P22 **95/95**，0 finding；覆盖默认/echo/500/404/默认不跟随/显式跟随+每跳复验/超限/方法规则/超时/取消/阻断与重定向阻断零派发/非法参数零副作用/截断与字节/无 cookie jar/脱敏/未启动零 Chromium/跨租约独立/真实 lossless/卸载与头超限 | P22（`tests/acceptance/http-request.mjs`）；runs/2026-10-31T13-08-56-816Z-277736 |
| `browser_state` 错误归属与时效 | PASS（P2/P10/P19 未因语义变化改断言）：`errorAt/errorActionId/errorTarget`；成功页面/网络操作清空，诊断与 HTTP 不清，BUSY/预检不覆盖 | P2/P10/P19 + 主机侧探针；见 t1-http-request.md §9.1 |
| `runtime-faults:208` 清理竞态 | PASS：实现 `rm` 有界重试 + 测试 `waitFor` 3s；连跑 3 次 16/16、exit=0 | `node --test tests/acceptance/runtime-faults.test.mjs` |
| Chrome 可执行文件解析 | PASS（覆盖路径）：env 权威（坏值不回退）、`/opt` 优先、PATH 顺序、缺失 `UNSUPPORTED`、启动超时 `CDP_TIMEOUT`；解析缓存不随 PATH/二进制删除失效（已知边界） | P18 + 主机侧探针（P1/P21 同版本） |
| 真实 Agent 会话内第九工具 / provider 图像可见性 | NOT_RUN | 需要重启 3080 后的新会话；fake-ctx/P21/隔离宿主 `apply()` 不能冒充 |

最终主验收（Lead 独立复跑，无并行 Chromium）：`node tests/acceptance/run.mjs` **22/22 组、303/303 必需项，0 failed/skip、exit=0**，1 条 advisory finding（`P20-unmodifiedText-inconclusive`）。报告：[run-report.json](../tests/acceptance/runs/2026-10-31T13-08-56-816Z-277736/run-report.json)（真实 Chromium，fake Cordis ctx）；执行者同版本独立跑为 [13-06-46-778Z-275714](../tests/acceptance/runs/2026-10-31T13-06-46-778Z-275714/run-report.json)。故障注入 `node --test tests/acceptance/runtime-faults.test.mjs` **16/16、exit=0**（执行者连跑 3 次均 16/16；`:208` 的 rm 竞态已按 §9.2 双侧修复）；`check-skill.mjs` **23/23**、`check-skill-registry.mjs` **17/17**，均 exit=0。上一轮 21/21 组、196/196 项的主验收（[runs/2026-10-31T10-45-41-877Z-211748](../tests/acceptance/runs/2026-10-31T10-45-41-877Z-211748/run-report.json)）保留为历史记录。

真实宿主验证（第 4 轮，Lead 用隔离 `DSH_HOME` 重启临时 3081 实例后跑）：`node tests/acceptance/verify-3081.mjs` **22/22 PASS、exit=0**，报告 [host-3081-1793452433416](../tests/acceptance/runs/host-3081-1793452433416/report.json)。隔离宿主的 profile 是工作区内**复制**件（`node_modules` 软链到真实 web profile 的依赖目录），**不是**指向真实 profile 的 symlink；验证后已停止实例并删除临时 `DSH_HOME`。上一轮的 14/14/22/22 报告（[host-3081-1793438111836](../tests/acceptance/runs/host-3081-1793438111836/report.json)、[host-3081-1793443392549](../tests/acceptance/runs/host-3081-1793443392549/report.json)）保留为历史。本轮 3081 已重启到**终版**并完成验收：pid <pid>（18:36:21），loaded build = 工作区终版（index `fe870ee1…a38b3` / client `f03a1c2d…681edf`，``editedAfterStart={}``）；`verify-3081` **22/22 PASS、exit=0**（[报告](../tests/acceptance/runs/host-3081-1793445523902/report.json)），GUI `address-history-3081` **276/276 PASS、exit=0**（[报告](../tests/acceptance/runs/address-history-2026-10-31T11-18-49-001Z-243848/report.json)）。此前 GUI 脚本偶发（Lead 复跑 255/260：B1 首次面板提交用了旧地址、G1 blur 未取消草稿）的根因是**环境/脚本，不是实现缺陷**：隔离实例 DSH Web shell 的账号登录/onboarding 对话框异步挂载时，Modal 的 `autoFocus` 关闭按钮抢走面板地址栏焦点（终验报告 `environment.dialogsDismissed=2`）。脚本硬化：交互前清理 shell 对话框、强制 blur→focus 循环、草稿稳定性门 + 提交恢复链（`focusStealRetries`/`enterFallback` 计数）、B1 navigate 统计窗口边界、G1 失败自证；未放宽断言、未改实现；硬化后无未解释项。authenticated `/state` 的 `ui.version=1`、停止态 `address=''`/history 不可用、未认证/伪造 Origin 无 `ui`、`/reload` 与 `/history` 未认证 401/403 均在其中。`/navigate` 返回时 history 曾为旧投影的问题已改为写路径同步刷新（见上节），并在终版 3081 上用 24 项复核确认 `ui.history` 新鲜（`available:true,index:1,length:2`）。

本轮已确认：`/tmp/dsh-iso/profiles/web` 曾是指向**真实** `~/.dsh/profiles/web` 的 symlink，不能当隔离 profile 使用（本轮改为工作区内复制的 profile）。`host.clients` 的非 0 观测是外部 viewer 假象（用户 3080 浏览器 08:34、旧 headless `/tmp/chrome-iso2` 09:09 起连到 3081；正常 reload 会回收为 0）。**既有缺口（不在本轮修复范围）**：无 WebSocket Close 帧的粗暴断开会让服务端 socket 停在 `CLOSE-WAIT`、frame-push 不回收（`MAX_CLIENTS=8`）；`frame-push.js` 本轮未改（sha256 `e1faf6f6…2230c`）。

authenticated GUI HTML 含 `__DSH_BOOT__`；真实插件通过 loopback 导航、document.title/SPA 刷新、**Shift+Tab 把焦点从 #name 反向移到 #inc**、老式最小 mouse 仍能点、非法 modifiers 返回 500 `INVALID_ARGUMENT`、HTTP eval 字符串错误及分类/栈、PNG、NAV_FAILED、metadata/自身 origin 拦截和 close。此结果证明真实 DSH HTTP 集成、注入 shell 与新输入契约在真实宿主生效；真实 Agent/provider 视图仍 **NOT_RUN**。

以上结果取代历史 13 组/92 项与 M0–M2 的 19 组/154 项中对应路径的旧结论（历史原始记录不改写）。本轮只证明报告覆盖的本机路径，不证明完整网络沙箱、默认非沙箱 Chromium、provider 实际图像可见，也不证明 `commands`/`unmodifiedText`/`pointerType:pen` 的页面级行为。
