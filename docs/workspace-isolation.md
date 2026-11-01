# 按 DSH 工作区隔离调试实例

> 索引：[docs/index.md](index.md) · 2026-10-31 设计定稿，实施中

## 决定

调试实例按 **DSH 工作区** 隔离，而不是按插件进程共享一套页面：

- 同一时刻最多一个 headless Chromium（共享临时 profile）；最后一个 page 关闭后 Host 可退出，下次懒重启。临时 profile 在 Host 退出时删除，不承诺 Cookie 持久化。
- 每个工作区拥有独立的 **page target**，以及独立的 URL/title/history、viewport、帧源、网络缓冲、串行队列、single-owner-lease、错误与 metrics。
- **不做** Cookie/localStorage/IndexedDB/cache/service worker 隔离：同一 profile 下这些仍共享，这是本轮明确的范围（用户选择“每工作区独立 page，仅隔离 URL/viewport/租约”），不是安全边界。
- 不改已冻结的视觉、文案、布局；面板只改数据绑定。
- 验收以**隔离 3081 宿主**为准，不重启、不操作 3080。

## BrowserHost 所有权状态机

共享 Chromium 下不能沿用“不是第一个 page 就是 popup”的判断（旧实现见 `index.js:650-681`）。BrowserHost 必须维护：

- `ownedTargets: targetId → {runtime, generation}`；
- `pendingCreates`（`Target.createTarget` 已发出、targetId 尚未返回）；
- `autoAttached: sessionId → targetId`；
- `closingTargets`；
- Host 的 `generation` 与 `closingPromise`。

规则：

1. create 前登记 pending；create 返回 targetId 之前先到的 `Target.attachedToTarget` 必须暂存并保持 paused，**不能**判 popup。
2. 拿到 targetId 后标记 owned，再 `Runtime.runIfWaitingForDebugger`、detach browser 自动附加 session；随后按 targetId 精确从 `/json/list` 找 `webSocketDebuggerUrl`（有界重试）建立 page-level WS。
3. 只有既非 owned、也非 pending 的 page target 才走弹窗拦截（Fetch fail-all → resume → 关闭）。
4. pending 失败/超时必须有界结算暂存事件；不能无限 paused，也不能把未知 target 放开联网。
5. `Target.createTarget` 的 Host 管理命令拥有自己的有界生命周期；caller abort 不能直接丢弃后到的响应。拿到 targetId 后若 caller 已取消，关闭这个确切 target。
6. 初始 `about:blank` target 只分配一次并计入 8 页预算；后续一律精确 targetId，禁止 `find(type === 'page')` 取第一个。
7. `targetId`、autoattach `sessionId`、`Page.screencastFrame.params.sessionId` 是三种不同身份；ACK 仍在对应 page WS 上发。
8. page close/reopen 产生新 target、新 page CDP、新 generation；事件、metadata、DNS/Fetch 回调必须绑定具体 cdp/generation，旧结果不得写入新页面。Fetch 成功支路也要检查 `this.cdp === capturedCdp`。
9. Host 零页退出必须同时看 creating/reservations，避免 A 关最后一页时误杀 B 正在创建的 page。
10. Host close 与 ensure 互斥、分代；不复用 closing Host。

## 身份链

### Agent 工具

1. `exec.agent.session.header.cwd`（Agent 的正式公开句柄）优先；回退 `ctx.sessions.get(exec.agent.id).header.cwd`。
2. `header.cwd` 是会话创建时的绝对目录，**不是**当前 working directory；不从 `process.cwd()` 或 shell cwd 推断。
3. subagent 继承父会话的 `cwd`，因此归属同一工作区。
4. 没有 live session 时，用 `ctx.sessionPersistence.stat(id).header` 只读元数据；`undefined` 才是确定不存在，存储异常不能当缺失；解析要有界并传 signal。
5. `ctx.workspaceRegistry.resolveByPath(cwd)` 把 canonical cwd 映射到稳定 `workspace.id`；精确 realpath 相等，不按父目录归属。

解析顺序：

```text
workspace:<workspace.id>     可信 session/registry 命中（主键）
path:<sha256(canonical cwd)> 目录存在但未注册工作区（降级）
session:<sha256(session id)> cwd 缺失/目录失效且无成员可救回（降级，不跨 session 合并）
recent                       显式请求“最近使用”；无记录时回落到 unassigned:owner
unassigned:owner             显式无会话/无工作区；独立实例
legacy:default               旧协议（无 scope 版本）专用，绝不读取工作区实例
```

- 显式给出但未知的 session id：`SCOPE_NOT_FOUND`，不得静默降级到 legacy/recent。
- 存储/registry 故障：`SCOPE_UNAVAILABLE`，不得当作“不存在”；timeout/abort 是 503/ABORTED，绝不能映射 404。
- 对外只暴露 opaque `id`（hash）与可选 `workspaceId`，**不暴露绝对路径**。
- canonical path 使用 `fs.realpath`；ENOENT 可按 membership 救回/降级；EACCES/EIO 等不能当未注册目录。

### GUI

- 右侧栏页签是 session-scoped，直接使用标准 prop `sessionId`。
- 中央 `main` 是 root-scoped，没有 Session binding：
  - `MoreRow` 在 `layout.selectPanel(ID)` 前用全局 `useSessions` 找 `retainedBy.mainView > 0` 的 session 并记住 id；
  - `DebugView` 在 main 里读取这个记忆值；
  - 无法确定时发送显式 `recent`，拿到 Host binding 后固定。
  - 语义是“打开面板时固定工作区”，不持续跟随之后的其他会话；重新打开才更新。
- `useSessions` 仍 loading 或多个候选时暂停写请求，不猜第一个工作区；不因 `blank=true` 当作无会话。

### recent 固定绑定

`recent` 不能每个请求重新解析（否则 WS 固定 A、后续 `/input` 可能跑到 B）。首次 `/state`/`/ensure` 解析 recent/unassigned 时创建/取 **cold entry**（不启动 Chrome），并在响应 `ui.runtimeId` 返回稳定 binding。之后该面板所有 HTTP 使用：

```text
X-UI-Testing-Scope-Binding: <runtimeId>
```

WS 使用 `binding=<runtimeId>&scopeVersion=1`。Host 只接受命中已存在 entry 的 binding（owner-only；未知 404），不接受任意 cwd/runtimeKey。显式 session 仍以 sessionId 为稳定身份。recent 只由真实交互/成功操作更新，不由 state/frame/metrics 轮询更新，且排除 legacy/已退役 entry。

## 请求协议

保留所有现有路径与 body 字段；新增 scope 标识：

| 通道 | 字段 |
| --- | --- |
| HTTP | `X-UI-Testing-Scope-Version: 1` + `X-UI-Testing-Session-Id: <sid>`；或 `X-UI-Testing-Scope: recent\|unassigned`；固定后 `X-UI-Testing-Scope-Binding: <runtimeId>` |
| WS | `/plugins/ui-testing/frames?scopeVersion=1&sessionId=<sid>`；或 `scope=recent\|unassigned`；或 `binding=<runtimeId>` |

- 同一请求同时给出不同 identity 值：400 `SCOPE_INVALID`。
- 无 `scopeVersion`：`legacy:default`，只服务旧客户端/旧回归；新客户端不得声称隔离成功。
- Host 只把 session id 当查找引用，不接受客户端传 cwd/runtimeKey 任意寻址。
- 认证（scoped 请求与 WS）：必须 `connection.admit(req)` 成功，且 `peer.id === connection.browserPeer.id`；缺 admit/browserPeer、抛错、无 peer 一律 401/503。**不能**退化成“requestRejection 通过即可”。旧无 scope 协议可只用 requestRejection 兼容。
- 鉴权必须在 scope 解析、registry 创建、origin 记录等任何副作用之前；失败零副作用。
- 所有 scoped 读写/帧 fail closed；`state` 轮询不启动 Chrome。

## 运行时模型

```text
Plugin apply
├─ BrowserHost（惰性，同一时刻最多一个 Chromium）
│   ├─ browserCdp：createTarget / closeTarget / autoattach / 弹窗拦截
│   ├─ owned/pending/autoattach/closing 状态机
│   └─ createPage(signal) → 精确 target 的 page-level CDP
└─ RuntimeRegistry
    ├─ legacy:default          （旧协议）
    ├─ workspace:<id> / path:<hash> / session:<hash> / unassigned:owner
    │   └─ Runtime：page + FrameSource + network + queue + lease + viewport + error + runtimeId
    └─ 每页独立 metrics；frame pusher 按 scope 分流
```

- 同 key 创建 single-flight；page reservation 在 await 创建前计入上限。
- `state`/`capabilities` 不启动 Chrome；`browser_http_request` 不创建 page。
- 每个 Runtime 的 viewer 来自“可见”的 WS 连接或 metrics 心跳 TTL（约 15s）；`state`/`frame` 轮询不续 viewer，也不续 idle。
- 生命周期（用户选择同时启用）：
  - 懒启动；
  - 最多 **8** 个 page 实例（含 legacy/unassigned；含 cold entry 的 page 预算）；
  - 空闲 **10 分钟** 回收：仅当无操作、无有效 lease、无可见 viewer、无 in-flight 时；
  - 满额且无可回收 → `RUNTIME_LIMIT`（503，retryable）；
  - `/close` 只关闭选中 scope；
  - 最后 page 关闭且无 pending create 后关闭 BrowserHost；Host 退出删除临时 profile；
  - 插件卸载等待 all close/dispose promise。
- 关闭语义：
  - shared page：只 close target、停止 screencast/WS、清空该实例 URL/title/history/network/lease/error；之后可重新 ensure；
  - 私有 `new Runtime(log)`：保持原语义，close 杀进程/删 profile，供 runtime-faults 恢复测试；
  - 并发 close 返回同一个 closingPromise。
- lease 仍按 sessionId，只在同工作区内互斥；`agent/disposed` 只释放对应 session 的租约，不关闭工作区实例。
- `origins` 是 DSH 自身 origin 的 denylist，由 Host 全局共享（各实例取 global ∪ local），不是“访问过的站点”；`browser_http_request` 保持独立、无 cookie jar，scope 只进证据。

## HTTP 路由

所有现有端点保持路径/字段，新增 scope 投影：

| 端点 | scoped 行为 |
| --- | --- |
| `GET /state`, `GET /frame` | 返回选中实例；无 scope → legacy；`state`/`ui` 带 `scope`；cold entry 返回冷投影，不启动 Chrome |
| `POST /ensure`, `/navigate`, `/reload`, `/history`, `/viewport`, `/input`, `/eval`, `/screenshot` | 在选中实例上执行 |
| `POST /close` | 只关闭选中实例 |
| `GET/POST /metrics` | scoped 返回该实例；无 scope 只返回 legacy 冷投影，不聚合其他 scope |
| `GET(Upgrade) /frames` | 单 upgrade dispatcher：auth → scope/binding resolve → entry pusher；hello/meta 带 `scopeId/runtimeId` |

- `ui` 增加 `scope`；`browser_state` 增加 `scope`；所有工具的 render evidence 增加 scope。
- 错误体保留 `{ok:false,error,code,category,retryable,details}`。
- 新错误码：`SCOPE_INVALID`（400/input）、`SCOPE_NOT_FOUND`（404/scope）、`SCOPE_UNAVAILABLE`（503/scope）、`SCOPE_FORBIDDEN`（403/authorization）、`RUNTIME_LIMIT`（503/resource）。

### 帧流

把现有单 source transport 提取为**不注册路由**的 `createFramePusher(source, options)`，保留编码、clients、背压、flush、source 订阅与统计；Host 只注册一次异步 upgrade dispatcher。101 只在 auth/scope/容量都成功后发送；await 期间 socket 已 end/error 要有界处理并保留 head；失败释放 pin；entry dispose 不卸载全局 route。每 entry 独立 maxClients/全局 socket 上限/统计。

## 客户端

- 所有 fetch（`/state`、`/frame`、`/metrics`、POST、screenshot seed 回退）与 WS 使用同一不可变 scope/binding 快照。
- 右栏用 `props.useTabInfo().tab.visible`：不可见时关闭 WS、停止 frame/state 轮询、停止 metrics 上报（不关闭 page、不卸载组件）；可见时重建。main 按挂载/`document.visibilityState` 处理。
- scope 或 binding 变化时：关闭旧 WS/轮询、Abort 旧请求、清空 blob/seq/epoch/草稿/retired runtime/metrics，重建 transport 与 state 轮询；A→B→A 不能被单一 retired id 错丢。
- 不改 CSS、文案、图标、布局；不新增工作区标签/切换器。
- 旧 Host（无 scope 支持）只能按 legacy 显示，不能声称隔离成功；不新增可见文案。

## 验收

### fake ctx / 单 apply

- 同一 apply、同一 Host PID/profile 下两个不同 targetId；A/B 不同 URL/title/viewport/history；A 独有 nonce 请求不进 B network；A 关闭不影响 B；B 继续产生帧。
- 两页各自持续 screencast/ACK 不串；各自 `innerWidth/innerHeight`、截图尺寸、DOM/JS 全局、scroll、focus/input 目标正确；reload/back/forward 只影响本 page。
- 同工作区两个 session 共享同一 runtimeId；A1 持 lease 时 A2 BUSY，B 成功。
- 并发慢 eval A/B 均成功；A abort/CDP 断线/targetDestroyed 只回收 A，B 继续；A 重开后旧帧/ACK/metadata 不复活。
- A 的 Fetch Document 阻断不挂住 B；B 导航不写 A error/network；popup `window.open` 在任一 page 仍被拦截且不误杀 owned page。
- 帧/WS/metrics 按 scope 不串；A→B→A、迟到响应、WS 重连 + poll 回退不串。
- `state` 轮询不续 idle/viewer；隐藏/粗断 WS 不永久占额；viewer TTL 生效；上限触发 `RUNTIME_LIMIT`；同 key 并发 ensure 只开一个 page；并发 cold ensure + close 最后页、第 9 页申请受控。
- 身份矩阵：realpath alias 同 key、未注册 path、缺 cwd session、无 live stat、stat 异常 503、未知 sid 404、缺 scope legacy、非 owner/伪造 Origin 拒绝且零副作用、recent 固定 binding。
- 9 工具返回 `scope` 且仍是 lossless JSON；P21 截图/attachment、P22 HTTP 继续通过。
- 旧无 scope 回归仍走 legacy；M2 同工作区 BUSY/匿名共享断言保留，新增跨工作区并发。
- **不**断言 Cookie/localStorage/IndexedDB/cache 隔离；可加“同源 localStorage 共享”观察证明范围诚实。
- P8 `/close` 的“进程/profile 消失”只在该 apply 最后一个 page/私有 Runtime 场景断言；共享 A/B 场景改为 A target 消失、B target/CDP/PID/profile 仍在。

### 真实 3081

- 用独立 `DSH_HOME` 加载工作区代码；以 listener PID/启动时间/source hash 证明加载版本。
- 通过真实 Session Controller/GUI 创建两个注册工作区与 session，经真实 props 发 HTTP/WS；仅 curl 手写 header 不算 GUI 绑定证据。若无法创建第二工作区，必须明确降级证据，不能声称已验证。
- 两个工作区各调用 `browser_state`/`browser_navigate`/`browser_eval`/`browser_network`，验证 `exec` 身份链。
- 并发 A/B 由单个协调脚本发起；结果与报告落 `tests/acceptance/runs/`。
- 记录 1/2/8 page 的 RSS/启动/持续 screencast 观察；8 是 page 数，不承诺固定内存。
- 3080 不重启；交付后告知用户 3080 需要重启才加载新代码。

## 已知风险 / 非目标

- Cookie/localStorage/IndexedDB/cache/service worker/同源广播共享；同源登录态可跨工作区看到，不是安全隔离边界。
- 一个 Chromium 是共享故障域：Host 崩溃会使所有 page disconnected；这是接受的风险。
- 工作区删除没有公开事件：靠请求时解析与定期 `list()` 对账；旧实例自然 idle 回收，不迁移状态。
- 无 Close 帧的粗暴 WS 断开仍是既有泄漏风险；viewer TTL 是兜底，不修完整协议。
- `uiSession.current` 是 private，不采用；main 面板靠 MoreRow 捕获 + recent binding。
- root main 在真实 shell 的切换/空白/重连时序、双附加后 detach、多页后台 screencast 活跃性仍需 GUI/3081 实测。
- 资源上限 8/10 分钟为本轮经验值，未做大规模 RSS 压测。
## 本轮实测（2026-10-31）

- `workspace-isolation.test.mjs` **77/77 PASS、exit=0**（真实 Chromium + fake ctx）：`tests/acceptance/runs/workspace-isolation-1793458647378/report.json`。
- 主验收 `run.mjs` **22/22 组、303/303、exit=0**：`tests/acceptance/runs/2026-10-31T14-53-20-005Z-352423/run-report.json`；`runtime-faults` 16/16、`check-skill` 23/23、`check-skill-registry` 17/17。
- 隔离 3081（`/tmp/dsh-utb-home`，listener pid **357498**，22:57:39 启动；`env -u DISPLAY -u WAYLAND_DISPLAY`）：
  - `workspace-isolation-3081` **17/17 PASS、exit=0**：`tests/acceptance/runs/host-3081-workspace-1793458998884/report.json`；`loadedBuildMatchesWorkspace=true`、`editedAfterStart={}`；scoped WS 在真实 headless Chrome 页面内带 cookie 完成，A/B hello runtimeId 不串。
  - `gui-workspace-3081` **45/45 PASS、exit=0**：`tests/acceptance/runs/gui-workspace-2026-10-31T15-33-53-964Z-381563/report.json`；两个真实注册工作区/会话 A/B，main 与右栏 scope/WS/frame 不串，隐藏右栏停播。
  - legacy `verify-3081` **22/22 PASS、exit=0**：`tests/acceptance/runs/host-3081-1793458887176/report.json`。
- 地址/历史回归 `address-history-3081` **278/278 PASS、exit=0**：`tests/acceptance/runs/address-history-2026-10-31T15-34-45-025Z-382205/report.json`（main 面板与 hostFetch 同 session scope，A→B 不串；`addressSyncMiss=0`）。
- 未验证：真实 Agent 会话内的 `exec.agent.session.header.cwd` 工具调用（HTTP session 链已验）；provider 图像可见性仍 NOT_RUN。
- 观察/限制：同源 localStorage 跨工作区共享（明确非目标）；headless 只对前台 page 出 screencast，Host 在 viewer/metrics/操作时 `Page.bringToFront`（300ms 节流），多面板同时预览会轮转、页面 `visibilityState` 跟随。
