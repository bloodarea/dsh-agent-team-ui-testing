# T1 Web 缺陷与未解难题：解决状态总表

> 索引：[docs/index.md](index.md) · 起草：2026-10-31 · 最近更新：2026-10-31（第 4 轮：独立 HTTP API 收口 + 输入/状态/清理修复）
>
> 本文原先是对「已实测缺陷 + 未解难题」的**方案评估**。M0–M2 已按当时的推荐路线实施并验收，因此现在按**已解决 / 部分解决 / 未解决**重排，每条给出解决方式与证据。实施前的现象描述、代码片段和估算已由实现取代；完整契约、字段与残余风险见 [t1-m0-m2-contract.md](t1-m0-m2-contract.md)，历史审计见 [t1-infrastructure-audit.md](t1-infrastructure-audit.md)。
>
> **2026-10-31 第 2 轮**：解决 N2 输入功能键/修饰键与真实 Agent 会话内工具验证，并修复真实宿主阻断级缺陷（非 lossless JSON 被拒）。
>
> **2026-10-31 第 4 轮（本轮）**：补齐 T1 第五项主功能「独立 HTTP API」（`browser_http_request`，契约 [t1-http-request.md](t1-http-request.md)），并解决 `browser_state` 错误时效、`runtime-faults:208` 清理竞态、Chrome 可执行文件解析、`pointerType:pen` 映射与 `commands`/`unmodifiedText` 页面级断言。真实宿主第九工具的真实 Agent 会话调用与 provider 图像可见性仍 NOT_RUN。

## 0. 当前结论

- 主验收（本轮，Lead 独立复跑）：**22/22 组、303/303 必需项、0 failed/skip、exit=0**，1 条 advisory finding（[报告](../tests/acceptance/runs/2026-10-31T13-08-56-816Z-277736/run-report.json)）；执行者同版本独立跑 [13-06-46-778Z-275714](../tests/acceptance/runs/2026-10-31T13-06-46-778Z-275714/run-report.json)。新增 **P22 独立 HTTP 95/95**、P20 扩到 28 项、P21 扩到 23 项（9 工具 + `output.schema` 白名单）。
- 故障注入：**16/16、exit=0**（Lead 复跑；执行者连跑 3 次均 16/16；`:208` 清理竞态已修）。
- Skill 一致性：`check-skill.mjs` 23/23、`check-skill-registry.mjs` 17/17。
- 真实宿主：3081 隔离实例**重启到终版**并完成 Lead 独立终验（pid <pid>，index `fe870ee1…a38b3` / client `f03a1c2d…681edf`，`loadedBuildMatchesWorkspace=true`、`editedAfterStart={}`）：`verify-3081.mjs` **22/22 PASS、exit=0**、GUI `address-history-3081.mjs` **276/276 PASS、exit=0**（硬化后连续 3 次 + B1/G1 专项各 12/12）；`/navigate` 响应内 `ui.history` 新鲜（`observations.navigateResponseHistory={available:true,index:1,length:2,canGoForward:false}`）；Lead 主验收 run.mjs 21/21（196/196，runs/2026-10-31T10-45-41-877Z-211748）、runtime-faults 16/16、check-skill 23/23、registry 17/17；验收期间 3080 未重启，交付后用户已于 19:36:05 重启（pid <pid>）并确认 `ui.version=1`（见 [status.md](status.md) / [t1-known-gaps.md](t1-known-gaps.md)）。
- 隔离宿主（第 4 轮）：工作区内复制的 web profile + 临时 `DSH_HOME` 加载本轮代码，`verify-3081` **22/22 PASS、exit=0**（[报告](../tests/acceptance/runs/host-3081-1793452433416/report.json)），证明真实宿主可加载 9 工具插件且 HTTP/输入/鉴权未退化；实例验证后停止、临时目录已删。
- 真实 Agent 会话（3080，旧构建）：8 个工具可调用；**第九工具 `browser_http_request` 没有在真实 Agent 会话里调用过**，需重启 3080 后补证。
- 仍未验证：真实 3080 会话内的第九工具调用（需重启 3080）；provider 是否真的把截图 image block 交给视觉模型（**NOT_RUN**）。

## 1. 已解决（M0–M2）

| ID | 原问题 | 解决方式 | 实现位置 | 证据 |
| --- | --- | --- | --- | --- |
| F3 | 不可达地址仍返回 `ok:true`，页面停在 `chrome-error://` | `Page.navigate` 检查 `errorText`；导航后校验 `location.href` 与最终 URL；Document 请求被 `Fetch` 拦截并复检，命中拦截回到 `about:blank` 并抛 `NAV_FAILED` | `Runtime.navigate()`、`validateTarget()` | P2、P19 |
| F9 | 错误只有裸字符串/裸 `Error`，无法重试或上报 | 统一 `BrowserError(code/category/retryable/details)`：工具失败抛错（消息带 `[CODE]` 与 action 证据），`eval`/`computed_style` 操作失败返回 `{ok:false,error:{…}}`，HTTP 保留 `error` 字符串并新增 `code/category/retryable` 兄弟字段 | `browser-safety.js`、工具包装器、HTTP handler | P10、P2/P3/P4、P16 |
| F2 | `browser_state.title` 恒空（取的是 `frame.name`） | 标题改读 `document.title`：`load`/`DOMContentLoaded` 事件刷新、`navigate()` 后刷新、`browser_state` 工具执行前刷新；面板 `/state` 走 250ms 节流的异步刷新，不阻塞响应 | `Runtime.refreshTitle()`、`refreshTitleSoon()` | P2（含 SPA 改标题）、3081 |
| F4 | eval 异常只剩 `"Uncaught"` | 取 `exceptionDetails.exception.description`（含栈），附 `url/line/column`；返回 `EVAL_ERROR` 对象 | `Runtime.evaluate()` | P3、3081 |
| F5a | 网络记录原样返回 URL，凭据泄漏 | 网络条目、`state.url/error/activity`、错误消息统一过 `redactUrl()`；query 敏感键、userinfo、hash 打码，条目带 `redacted:true` | `redactUrl()`/`redactText()` | P6（fixture token 不再出现） |
| F5b | 导航只校验 scheme，可访问内网/元数据/DSH 自身 | 允许 http/https + loopback；默认阻断 RFC1918（`DSH_UI_TESTING_ALLOW_PRIVATE=1` 放开）、`169.254/16`、`0.0.0.0`、组播/链路本地、带凭据 URL、DSH 自身 origin；DNS 解析校验 + Document 重定向校验 + 弹窗 target 拦截 | `validateTarget()`、`blockedAddress()`、`Target.setAutoAttach` 守卫 | P19、3081 |
| F8/F16 | 无工作区隔离，插件内共享一个 page；跨工作区并发互相改页面 | **第 5 轮**：同一时刻一个 Chromium/profile，按 DSH 工作区独立 page（URL/viewport/history/网络缓冲/队列/租约）；身份链 exec header.cwd→sessions→persistence→workspaceRegistry exact realpath；HTTP/WS scope（sessionId / recent→runtimeId binding / legacy）；同工作区 single-owner-lease 15s、BUSY，跨工作区独立；scope 证据/lossless；严格 owner-only；8 page/10min 回收 | `BrowserHost`、`RuntimeRegistry`、scope 解析、`frame-push` dispatcher、`Runtime.claim/run`、`apply()` | `workspace-isolation.test.mjs` 77/77；`workspace-isolation-3081` 17/17；`gui-workspace-3081` 45/45；`address-history-3081` 278/278；P9/P15/P17 适配同工作区 |
| F1 | 无 capability API，Agent 只能试调用 | 新增第 8 个工具 `browser_capabilities`：`runtime`（running/browser/transport/isolation/attachments）+ 8 个 T1 能力三态 + T2–T4/HTTP 客户端 `unsupported` + `limits`；其他会话持有租约时页面类能力标 `unavailable`，诊断类仍 `available` | `browser_capabilities` 工具 | P1、P14、P15 |
| N3 | 无取消、无跨 Agent 锁，长任务卡 30s | `Cdp.send` 接收 `signal` 并在 settle 时清 timer/listener；`exec.signal` 全链路转发；所有写操作（含面板 `/input`）走同一串行队列；已派发命令被取消/超时时**先关浏览器再放锁**，后续调用可懒启动 | `Cdp.send()`、`Runtime.run()` | P17、runtime-faults |
| N4 | CDP 30s 定时器不 clear；`loadingFailed` 未处理 | 定时器随 pending 条目一起清理；`Network.loadingFailed` 记录 `failed/errorText`；`requests` Map 与 `network` 都有上限；关闭时清理；启动失败回收进程与 profile | `Cdp`、`Runtime.#onEvent`、`Runtime.close()` | runtime-faults、P8、P18 |
| F10 | 调试视图地址栏只记录"用户输入过的网址"，不跟运行时真实地址；页面自主导航/重定向/参数/SPA 后仍显示旧值；刷新/后退/前进用本地输入历史，会跳到别页 | 新增 HTTP 专用 `uiState()`（`ui.version/runtimeId/revision/address/history`，只有已认证同源 GUI 可见，fail closed），`state()`/`browser_state` 保持脱敏；新增 `POST /reload`（`Page.reload`）与 `POST /history`（`Page.getNavigationHistory`+`Page.navigateToHistoryEntry`），三者 `runtime.run()` 串行且 `agent:false`，先装主框架提交等待器再 send、10s 超时 `CDP_TIMEOUT`；主框架 `Page.navigatedWithinDocument` 同步 + 合并元数据刷新（250ms single-flight）+ metadata generation 防旧结果；客户端删除本地历史、单一 `acceptRemote`、地址草稿状态机、按钮由真实 `ui.history` 驱动、旧 Host legacy 降级 | `Runtime.uiState()/reload()/historyMove()/#onEvent`、`apply()` 的 HTTP 投影与受保护路由、`client.js` 的 `DebugView` | 主机侧真实 Chromium 44 项（pushState/replaceState/hash、真实 back/forward、reload 不新增历史、redirect 最终地址、frame 两分支同形 ui、close 清空、`/navigate`/`/history` 响应内 history 新鲜）；3081 authenticated `ui.version=1` + 鉴权/不泄漏 32 项；GUI 端到端 `address-history-3081.mjs` **276/276 PASS、exit=0**（[Lead 终验报告](../tests/acceptance/runs/address-history-2026-10-31T11-18-49-001Z-243848/report.json)；硬化连跑 3 次 276/276 + B1/G1 专项各 12/12） |
| N6 | 「改好了」无法证明；3080 未加载插件 | 主验收重写为必需断言（旧 finding 改为断言，现 21 组 196 项）；故障注入单测 16 项；验收写独立 `runs/<时间>-<pid>/`；3081 隔离实例重启后实测；本轮再加 P20/P21 两组 | `tests/acceptance/**`、`verify-3081.mjs` | 见 §0 |

| F11 | T1 第五项主功能「独立 HTTP API」未实现，接口断言只能靠页面 fetch | 新增第 9 个工具 `browser_http_request`：Host 侧 `node:http/https` 独立客户端，独立 dispatch 分支（不 ensure/run/claim/touchAgent、不建 profile、不写页面 error）；默认 GET/5s/64KiB、默认不跟随重定向；每跳复用 `validateTarget`、HTTPS→HTTP 降级拒绝、危险头/Cookie 零派发、无 cookie jar、跨 origin 清头、敏感头 `["***"]`、body 截断/utf8-base64、`HTTP_TIMEOUT/HTTP_FAILED/HTTP_REDIRECT_LIMIT`；capabilities 9 项 + `limits.httpRequest` | `HttpClient`、`browser_http_request`、`browser_capabilities`；`docs/t1-http-request.md` | P22 95/95；P21 23/23（含 9 个 output.schema 白名单）；P14 9 项 |
| F12 | `browser_state.error` 可能过期且无归属 | 错误投影改为 `error/errorAt/errorActionId/errorTarget`；成功的页面/网络操作清空，诊断与独立 HTTP 不清，BUSY/参数预检不覆盖 owner 错误；导航守卫异步错误 `errorActionId=null` 且防退役 CDP 覆写 | `Runtime.setError/clearError`、`run()`、工具包装器 | P2/P10/P19 + §9.1 验收顺序 |
| F13 | `runtime-faults:208` 清理竞态（旧 profile 已删除断言偶发失败） | 实现侧 `rm` 有界重试（5×50ms，失败记日志 + `cleanupError`）；测试侧旧 PID 消失后 `waitFor(!pathExists,3s)`；其余断言不变 | `Runtime.#removeProfileDir`、`runtime-faults.test.mjs` | 连跑 3 次 16/16、exit=0 |
| F14 | Chrome 路径只认 `DSH_UI_TESTING_CHROME` 或 `/opt/google/chrome/chrome` | 惰性解析：显式 env 权威（坏值不回退；空串/NUL/相对路径 `INVALID_ARGUMENT`）→ `/opt` → PATH 顺序（命令名只按 PATH）；缺失 `UNSUPPORTED`、启动超时 `CDP_TIMEOUT`、早退 `CDP_DISCONNECTED`；解析结果按 env 缓存（PATH/二进制删除不失效为已知边界） | `resolveChromeExecutable()`、`Runtime.#start` | P18 + 主机侧探针 |
| F15 | `pointerType:pen` 只有 schema+透传；实际传数字被 CDP 拒绝为 `INTERNAL` | `normalizePointerType` 返回 CDP 字符串 `mouse/pen`（整数 1/2 兼容归一）；P20 用 `PointerEvent.pointerType` 页面真值验证；`commands:['selectAll']` 用 selection 读数验证；`unmodifiedText` 特有作用不可观察记 INCONCLUSIVE | `normalizePointerType`、P20 页面真值探针 | 修前 INTERNAL 复现；修后 pen PASS、selectAll PASS、unmodifiedText INCONCLUSIVE |

## 2. 部分解决（有明确残余）

| ID | 原问题 | 已做到 | 残余 / 未验证 |
| --- | --- | --- | --- |
| N1 | 截图 Agent 不可见、无证据 id | 每次调用返回并 render `actionId/sessionId/startedAt/finishedAt/target/args`；截图带 `capturedAt/sha256/attachmentId/imageDelivery`；有 `ctx.attachments` 时 `saveImage` 并 render image block，无服务时明确 `base64-fallback`；返回值按 lossless JSON 投影（见 §4） | 真实 provider 是否把 image block 交给视觉模型 **NOT_RUN**（本轮只证明到「返回值能过宿主校验」）；修复前真实会话里截图调用整体失败，已修但**修复后未在 3080 新会话复验**（需重启 3080，用户本轮选择不重启）；不落独立证据包（仍靠会话日志 + render 文本） |
| F5 | 目标范围硬限制 | URL/DNS/Document/弹窗目标都已校验 | 子资源请求不经过策略（不是网络沙箱）；DNS rebinding 与校验后重解析无法完全消除；`file:`/`chrome:` 由 scheme 校验阻断，未做 Chromium 级策略 |
| F8/F16 | 工作区隔离 | page/URL/viewport/history/网络缓冲/队列/租约按 DSH 工作区隔离；同工作区 `BUSY` | Cookie/localStorage/IndexedDB/cache 在同一 profile 内共享，不是安全边界；真实 Agent exec 身份链仍 NOT_RUN（HTTP session 链已验） |
| 帧推流半开连接回收（既有，不在本轮范围） | 无 Close 帧的粗暴断开（页面被杀/卡死）会让服务端 socket 停在 `CLOSE-WAIT`，frame-push 仍计数该 client，直到 `POST /close` 或插件卸载；`MAX_CLIENTS=8` 时极端情况下多次崩溃可占满槽位 | 正常 GUI reload 会回收（私有实例实测 1→0）；本轮已确认 3081 上 `host.clients` 非 0 是外部 viewer 假象 | `frame-push.js` 只监听 `error`/`close`，无心跳/超时；本轮未改（mtime 11:52、sha `e1faf6f6…2230c`）。建议后续按 `end`/`close` 或心跳超时单独修 |

## 3. 未解决项的分类结果（2026-10-31 第二轮）

原 §3 是一张「未解决」平表；本轮按**是否属于 T1**逐项归档，避免把产品决策、平台依赖和 T2–T4 混进 T1 待办。

### 3.1 属于 T1 且已解决

| ID | 问题 | 解决方式 | 实现位置 | 证据 |
| --- | --- | --- | --- | --- |
| N2 | `browser_input` 无功能键/组合键（第 4 轮补页面真值） | 事件 schema 扩展：`modifiers`（`['alt','ctrl','meta','shift']` 或 CDP 位掩码 0–15，Alt=1/Ctrl=2/Meta=4/Shift=8）、`virtualKeyCode`、`autoRepeat`、`unmodifiedText`、`commands`、`location`、`isKeypad`、mouse 的 `buttons/modifiers/pointerType`、wheel 的 `modifiers`；整批先归一校验再派发，非法参数在启动 Chromium 之前抛 `INVALID_ARGUMENT`（不派发半截事件）；老式最小调用保持可用 | `normalizeModifiers()`、`prepareInputEvent()`、`pointerType` 映射、`Runtime.input()`、`browser_input` schema | P20 28/28（Tab/Shift+Tab、Ctrl+A、位掩码、`repeat`、`location/isKeypad`、mouse/wheel 修饰键、5 类非法输入零派发 + `commands` selection、`unmodifiedText` 对照、`pointerType:pen` 页面真值）；3081 真实宿主 22/22 |
| — | 真实 Agent 会话内的工具调用 | 在本会话（3080，真实 DSH Agent 会话 + 真实工具注册表）逐个实测 8 个工具：`browser_capabilities` 报告 8 项 T1 `available`、`attachments:true`、`isolation:single-owner-lease`；navigate/eval/computed_style/input/state 返回正常 | 无代码改动（验证项） | 会话内真实调用；同时暴露了下面的 lossless 阻断 |

### 3.2 明确不属于 T1（本轮不解决，附依据）

| 项 | 为什么不属于 T1 | 依据 |
| --- | --- | --- |
| N5 帧管线逐帧 ACK/ABR/跨机基准 | 帧管线只服务**面板预览**与 `/metrics`，8 个 `browser_*` 工具无任何帧调用；帧序列分析属 T4 | [capability-tiers.md](capability-tiers.md) T1=程序化接口、T4=动态视觉；`index.js` 中帧相关只出现在导入/构造/metrics/close/attach（无工具路径）；[status.md](status.md) §还没做 |
| 跨工作区 Cookie/存储隔离（B/C/D） | 第 5 轮已实现 page/URL/viewport/租约按 DSH 工作区隔离；Cookie/localStorage/IndexedDB/cache 仍共享（明确非目标），完整登录态隔离需独立 BrowserContext/Chromium | [workspace-isolation.md](workspace-isolation.md)；[t1-m0-m2-contract.md](t1-m0-m2-contract.md) |
| 独立证据包（JSONL/文件） | 决策记录已选「会话日志 + render 文本，不落独立证据包」；落盘涉及 workspace 根与清理授权 | 本文 §5 决策记录；AGENTS.md 授权与安全 |
| T2/T3/T4 | 分层定义即 T2=结构化 GUI/T3=静态视觉/T4=动态视觉，与 T1 并列；capabilities 必须如实标 `unsupported` | [capability-tiers.md](capability-tiers.md)；[t1-m0-m2-contract.md](t1-m0-m2-contract.md) 工具面；[status.md](status.md) |
| 多标签页/下载/上传/Cookie 导出/iframe 目标选择 | 契约第 9 行明确列为不实现；弹窗只做「暂停→封网→关闭」，不是多 target 支持 | [t1-m0-m2-contract.md](t1-m0-m2-contract.md)「工具与运行态」「目标与网络边界」 |

### 3.3 平台依赖：T1 代码范围内不可解

| 项 | 结论 | 证据 |
| --- | --- | --- |
| 错误码进入 DSH 结构化 `info.code` | 插件侧无法打通，属依赖边界/平台议题，需用户批准改打包形态 | ① 宿主只对 `HarnessError` 实例写结构化 code：`@deepseek-ai/dsh-tools` `lib/index.js:2709-2717` `errorInfo()` = `error instanceof HarnessError ? {name, code} : undefined`；② `HarnessError` 不由 tools 包再导出（同文件 `:3810` 导出列表只有 `ToolNotFoundError/ToolOutputError/ToolArgsError/JsonSchemaError/CodeRunFailedError`）；③ 实测从插件目录 `import('@deepseek-ai/dsh-llm' / 'dsh-tools' / 'dsh-util-values')` 全部 `ERR_MODULE_NOT_FOUND`，插件 `package.json` 无 `dependencies/peerDependencies`；④ `@deepseek-ai/dsh-llm` 也不在 `~/.dsh/profiles/web/node_modules`（`dsh-util-values` 在，但插件按 realpath 解析绕过该目录）；⑤ 自造同形类不满足 `instanceof`，因此当前只能靠 `[CODE]` 前缀 + 返回字段 |

## 4. 实施中新发现并已修复

这些是实施与只读审查中发现、且已有回归覆盖的缺陷：

| 缺陷 | 影响 | 修复 | 证据 |
| --- | --- | --- | --- |
| **（第 4 轮）参数 schema 越界关键字不被宿主接受** | 原 `browser_input.modifiers` 参数 schema 带 `minimum/maximum`，虽在旧宿主未触发失败，但宿主 `assertSupportedJsonSchema` 并不接受这些关键字；新增第九工具时按宿主白名单重写并顺带收紧既有 schema（运行时范围校验不变，16 仍 `INVALID_ARGUMENT`）。同时确认宿主只对 `output.schema` 做白名单校验、参数 schema 只要求 lossless | 按真实 `@deepseek-ai/dsh-tools` 源码重写注册 schema；P21 用真实 `assertSupportedJsonSchema` 断言 9 个 `output.schema`，参数 schema 断言 lossless（子集为 advisory） | P21 23/23；P22 95/95 |
| **（第 4 轮）隔离宿主 profile 指错风险** | 早期 `/tmp/dsh-iso/profiles/web` 是指向**真实** `~/.dsh/profiles/web` 的 symlink，直接启动会写入/复用用户真实 profile | 改为工作区内复制 profile + 软链依赖目录，验证后停止实例并删除临时 `DSH_HOME`；已记录到 [verification.md](verification.md) | 复制的 profile 启动成功、`verify-3081` 22/22，且未触碰真实 profile 写入 |
| **（本轮，真实宿主阻断级）工具返回含 `undefined` 属性 → 宿主 `INVALID_TOOL_OUTPUT`** | 真实 3080 会话实测：`browser_screenshot`、`browser_network{limit:3}`、`browser_eval`（返回 `undefined` 或页面抛错）直接报 `tool "…" returned invalid output: value is not lossless JSON`。等于截图、网络抓包、eval 错误分类在真实会话里**全都传不出去**，而 fake-ctx 验收照样全绿 | 宿主校验器为 `@deepseek-ai/dsh-tools` `lib/index.js:2672-2681` `snapshotToolValue()` → `@deepseek-ai/dsh-util-values` `snapshotJsonValue()`（实测：含 `undefined`、非有限数字、`-0`、稀疏数组、类实例均判非法）。在唯一返回边界 `register()` 加 `losslessJson()` 投影（剔除 `undefined`、非有限数字/`-0`→`null`、类实例/Error 转纯对象），并修源头：args 摘要不再产生 `length: undefined`、eval `value:undefined` 缺省、错误 details 用 `null`、网络条目的 `method/type/at` 不再 undefined、截图 `attachment` 用 `projectAttachment()` 纯 JSON 投影且缺省即缺省 | P21 19/19（**用真实 `@deepseek-ai/dsh-util-values@0.2.1-rc.5`** 校验 8 工具返回值与 render content，覆盖 eval-undefined、eval 抛错、数字参数、无附件截图、loadingFailed 条目、类实例附件）；3081 真实宿主（本轮终版 22/22） |
| 弹窗/secondary target 绕过导航策略 | `window.open()` 可加载被阻断的 Document | browser 级 `Target.setAutoAttach(waitForDebuggerOnStart)`，新页面先装 `Fetch` fail-all 再 resume 并关闭，避免 `window.open` 挂住原页 | P19（被阻断 origin 的 Document 请求计数为 0，原页仍可导航） |
| HTTP 200 后响应截断被记成成功 | `responseReceived` 提前删除跟踪，`loadingFailed` 找不到条目 | 保留跟踪到 `loadingFinished`/`loadingFailed`，失败时原地更新同一对象 | P19（`status:200` + `failed:true` + `errorText`） |
| CDP `ws.send` 同步抛错后连接仍可复用 | 坏传输被 `ensure` 永久复用；重启会遗留旧进程/profile | 发送失败即关闭 CDP；`CDP_DISCONNECTED` 也触发 Runtime 清理；`ensure` 先回收旧资源再启动 | runtime-faults |
| 取消/超时关闭后失败证据丢 target | `close()` 清空 url，失败日志里 `target:""` | 入队时快照 `target`，失败优先用快照 | P17 |
| abort-close 后已排队操作丢所有权 | 其他会话可在空窗插入 | `activeOwner` 预约 + 入队/成功时重新 `claim` | runtime-faults |
| `/state` 若同步刷新标题会阻塞面板 | Agent 操作期间面板状态停更 | `/state` 改为 250ms 节流异步刷新，响应立即返回；本轮同一入口扩展为合并刷新 title/url/history（single-flight + generation 守卫，不占写队列/租约） | 3081（title/SPA 仍可见） |
| GUI 验收脚本偶发（环境/脚本，非实现缺陷） | 此前 Lead 复跑 255/260：B1 首次面板提交用了旧地址、G1 blur 未取消草稿；一度被判为脚本时序问题 | 根因：隔离实例 DSH Web shell 的登录/onboarding 对话框异步挂载时 Modal `autoFocus` 抢走面板地址栏焦点（终验报告 `environment.dialogsDismissed=2`）。脚本硬化：交互前清理 shell 对话框、强制 blur→focus 循环、草稿稳定性门 + 提交恢复链（`focusStealRetries`/`enterFallback` 计数）、B1 navigate 统计窗口边界、G1 失败自证；未放宽断言、未改实现 | 硬化后连续 3 次 276/276（11:11:06/11:11:49/11:12:31）+ B1/G1 专项各 12/12 + Lead 终验 276/276（runs/address-history-2026-10-31T11-18-49-001Z-243848），无未解释项 |
| 刷新/后退/前进把 CDP ACK 当"已提交" | 慢加载时立刻读回旧 URL/旧历史，地址栏闪回并用错方向禁用 | 发送前安装一次性主框架提交等待器（reload 等 `frameNavigated`；history 等 `frameNavigated`/主框架 `navigatedWithinDocument`），提交后重读真实 URL/标题/历史再响应；10s 无提交 `CDP_TIMEOUT`，timer/listener 清理 | 主机侧真实 Chromium 44 项；3081 verify-3081 22/22 |
| `/navigate` 返回时 `ui.history` 仍是旧值/不可用 | 面板提交成功后要等下一次 500ms 轮询才拿到可用的后退/前进状态；改为依赖异步 `refreshMetadataSoon` 时，`/navigate` 响应里的 history 可能是旧投影 | 写路径同步刷新：`/navigate` 在返回前并发读取 title+history（不额外增加串行往返），三个写入口都刷新后才响应；跨文档提交瞬间 `Page.getNavigationHistory` 的瞬时 "Not attached to an active page" 按 0/0/5/10/20ms 有界重试，超时才退化为 `available:false` | 主机侧 44 项检查（`/navigate`/`/history` 响应内 `ui.history.available===true`）；主验收 21/21 连续两轮 |
| `/state` 与 `/frame` 两路快照乱序可覆盖新地址 | 面板地址被迟到响应拉回旧值 | Host：`revision` 单调递增 + `runtimeId`；client：单一 `acceptRemote` 按 runtimeId+revision 排序、丢弃退役 runtime、轮询请求带 requestGeneration、提交前递增 | 主机侧 44 项；GUI `address-history-3081.mjs` 276/276 PASS（含延迟注入旧响应不回退；硬化后连续 3 次 + Lead 终验） |
| 原始地址可能泄漏进工具值/日志/metrics | 真实 URL 的 query/hash 进 `browser_state`、网络记录或 WS 头 | 原始地址只存在于 HTTP 专用 `uiState()`；`state()`/网络/`/metrics`/WS 头保持脱敏；未认证、伪造 Origin、服务缺失均只回脱敏 state（fail closed） | run.mjs token 断言仍 PASS；3081 三态未认证检查 |

## 5. 决策记录（原「需要你拍板」的 7 项）

| 决策 | 当时选项 | 实际选择 |
| --- | --- | --- |
| 隔离模型 | A 租约 / B 多进程 / C 多 target / D 多 context | **A**，只防并发写入，不做状态隔离 |
| 错误契约 | 抛错 / 统一 envelope / 混用 | **混用**：工具失败抛 `BrowserError`，操作失败返回 `error` 对象，HTTP 保留字符串 + 兄弟字段 |
| 能力发现 | 塞进 `browser_state` / 新工具 | **新工具** `browser_capabilities`（工具面 7→8） |
| 截图 | 进上下文 / 只落引用 | **两者兼有**：有附件服务时 image block，否则 base64 文本；provider 可见性待验 |
| 目标范围 | 全放开 / 只放 loopback / 可配置 | **loopback 允许**，RFC1918 默认阻断（环境变量放开），元数据与 DSH 自身恒阻断 |
| 证据持久化 | 会话日志 / 独立 JSONL | **会话日志 + render 文本**，不落独立证据包 |
| 优先级 | 先做扎实 T1 / 先开 T2 | **先做扎实 T1**（M0–M2），T2 未开 |

## 6. 生效方式与复跑

- Host 侧（`index.js`、`browser-safety.js`、`package.json`、`skills/**`）改动**必须重启 DSH**；`client.js` 热更新。本轮 3081 已重启到**终版**（pid <pid>，18:36:21；index `fe870ee1…a38b3` / client `f03a1c2d…681edf`，`loadedBuildMatchesWorkspace=true`、`editedAfterStart={}`）并完成 Lead 独立终验：verify-3081 22/22 + GUI 276/276（硬化后连续 3 次 + B1/G1 专项各 12/12）；**3080 已由用户于 19:36:05 重启**（pid <pid>，`ui.version=1` 已验证），legacy 降级只适用于重启前旧 Host（历史状态）；3081 验收完成后已停止。
- 复跑：

```bash
node tests/acceptance/run.mjs                          # 22 组 / 303 项必需检查（含 P22 HTTP 95 项）
node --test tests/acceptance/runtime-faults.test.mjs   # 16 项故障注入（rm 竞态已修；DNS 用注入 resolve 固定）
node tests/acceptance/check-skill.mjs                  # 23 项
node tests/acceptance/check-skill-registry.mjs         # 17 项
node tests/acceptance/verify-3081.mjs                  # 真实隔离宿主 22 项（不重启实例，且必须直接运行）
node tests/acceptance/address-history-3081.mjs         # 真实隔离宿主 GUI：地址栏/刷新/后退前进（不重启实例）
```

- `verify-3081.mjs` 是**顶层直接执行**的脚本：不允许 `import()`/`node -e "import(...)"` 之类的"语法检查"，否则会真实驱动 3081（导航、改标题、`finally` 关浏览器）。现已加 import 守卫，非直接运行会直接抛错。
- `runtime-faults.test.mjs:208` 的 SIGKILL 后 `rm` 竞态已在第 4 轮修复（实现有界重试 + 测试 waitFor）；本机 fake-ip 会把 `does-not-exist.invalid` 解析到 `198.18.0.28`，DNS 失败用例用注入 `resolve` 保持确定性。

## 7. 不建议做的事（保持）

- 不引入 Playwright / Puppeteer / WebRTC 解决当前问题；现有 CDP 通道够用。
- 不把 `/metrics` 当页面证据；它是面板预览诊断。
- 不在 T1 里偷偷实现 T2/T3/T4 的工具名；能力发现必须如实标 `unsupported`。
- 不改已冻结的面板视觉/文案；隔离方案不要靠新增会话选择器绕过 UI 评审。
- 不把「验收脚本能落盘」当成「插件有证据记录」；两者不是一回事。
- 不用「租约」冒充「登录态隔离」：page/URL/viewport/租约按工作区隔离，但 Cookie/localStorage/cache 仍共享。
- 不把 fake-ctx 验收当真实宿主验收：宿主在 `snapshotToolValue()` 上还有一道「lossless JSON」关卡（详见 §4）；新增工具或改返回体必须过 P21，并且 `output.schema` 要过宿主白名单（`assertSupportedJsonSchema`）。
- 不把 P22/P21/隔离宿主 `apply()` 加载当「真实 Agent 会话内验证」：第九工具仍需重启 3080 后在新会话调用一次。
- 不把「页面 `fetch` 成功」当独立 HTTP 断言；`ok:true` 也不等于 HTTP 2xx。
