# T1/T2 Web 插件验收

套件通过真实插件注册的 **16 个** `browser_*` 工具（9 个 T1 + 7 个 T2）与 HTTP handler，驱动插件自己的无头 Chromium 和仓库 loopback 靶机。进程归属通过 `/proc/<pid>/stat` 的父 PID 精确绑定当前测试 Node，profile 仅从这些进程登记；清理不会把并行运行的其他 DSH/验收 Chromium 算入本次。测试不操作用户 3080/3081 实例。M0–M2 的失败必须影响退出码；旧的缺能力、未脱敏、无隔离、无分类 finding 已改为必需断言。

## 运行

```bash
node tests/acceptance/run.mjs              # T1 主验收（P1–P22，含 16 工具注册面/能力/证据/宿主契约）
node tests/acceptance/capture-p0.mjs       # P0 截图基础设施验收（C1–C14，真实Chromium/像素真值/默认暂存+显式持久）
node tests/acceptance/t2-structured.mjs    # T2 结构化验收（docs/t2-structured-gui.md §9 的 38 条，C1–C38）
node tests/acceptance/workspace-isolation.test.mjs
node --test tests/acceptance/runtime-faults.test.mjs
node tests/acceptance/check-skill.mjs
node tests/acceptance/check-skill-registry.mjs
# 真实 3081（需先重启到本轮代码；显式指定隔离 home）
DSH_3081_HOME=/tmp/dsh-utb-home node tests/acceptance/workspace-isolation-3081.mjs
DSH_3081_HOME=/tmp/dsh-utb-home node tests/acceptance/gui-workspace-3081.mjs
DSH_3081_HOME=/tmp/dsh-utb-home node tests/acceptance/address-history-3081.mjs
```

两套验收各自生成 `tests/acceptance/runs/<ISO时间>-<pid>/`，包含报告、日志、PNG 和脱敏网络记录。`t2-structured.mjs` 的报告是 `run-report.json`（每个 probe 带 `criteria` 号，可直接对上 §9 的编号），日志是同目录 `run.log`。已有 `evidence/` 是历史证据，默认不覆盖。退出码（两套一致）：0 表示所有必需项通过，1 表示断言失败，2 表示套件无法运行。`t2-structured.mjs` 支持 `DSH_T2_ONLY="C9,C13"` 只跑指定 probe（调试用，报告仍标出被跳过的 probe），总超时默认 900 秒，可用 `DSH_T2_TIMEOUT_MS` 覆盖。`runtime-faults.test.mjs` 使用 Node 原生测试器，失败退出非零。

Chromium 默认 `/opt/google/chrome/chrome`（两套套件相同）；显式 `DSH_UI_TESTING_CHROME=/path/to/chrome` 可覆盖。默认探活失败后仅使用本目录 `chrome-wrapper.sh` 增加测试环境 flag，并在报告中保留失败原因。主验收总超时默认 240 秒（`DSH_ACCEPTANCE_TIMEOUT_MS`），T2 套件默认 900 秒（`DSH_T2_TIMEOUT_MS`）。两套套件都只清理本次运行自己创建的 Chromium 进程、临时 profile 与 fixture（按 `/proc/<pid>/stat` 父 PID 精确归属），不触碰用户 3080/3081 实例；T2 套件收到 SIGINT/SIGTERM 时会写 partial 报告（标 `interrupted`）并清理后以 exit 2 退出。Skill registry 检查使用已安装 DSH 的真实 Cordis/SkillRegistry，可用 `DSH_ROOT` 覆盖路径；宿主包缺失时会明确 SKIP。

## 测试职责

| 文件 | 内容 |
| --- | --- |
| [harness.mjs](harness.mjs) | 加载真实 `apply(ctx)`，捕获注册工具、HTTP/WS 路由；透传 `exec.agent.id`/`exec.signal`，收集错误分类与 render content；模拟 optional attachments 与 `agent/disposed` 事件。 |
| [run.mjs](run.mjs) | P1–P13 主浏览器与帧管线回归，并集成 M0–M2、P20、P21 与 P22 探针；P1/P14/P16/P21 断言 16 工具面（9 T1 + 7 T2）。 |
| [capture-p0.mjs](capture-p0.mjs) | **P0 截图基础设施验收**：C1–C14覆盖默认暂存/显式持久与生命周期，以及默认/scale/region/小数 scale/文档坐标+滚动/帧管线/空白识别/安全写入/参数与结构化错误/附件对比/能力探测/清理与可重复性/`captureBeyondViewport` 布局稳定性；断言全部是 PNG 像素真值（`capture-p0.js` 独立解码）与文件事实。 |
| [t2-structured.mjs](t2-structured.mjs) | **Web T2 验收套件**：按 `docs/t2-structured-gui.md` §9 的 38 条编号条件组织 C1–C38（snapshot/ref/selector/click/type/scroll/fill_form/node_state/wait_for/证据/错误/lease/隔离），真值为 `window.__t2` 的真实 DOM 事件与靶机 DOM。 |
| [workspace-isolation.test.mjs](workspace-isolation.test.mjs) | 按 DSH 工作区 page 隔离：同 apply 一 Chromium 多 target、scope 身份链、URL/viewport/history/network 独立、同工作区 BUSY/跨工作区并发、close/abort/CDP 断线、scoped WS/frame/metrics、recent binding、owner-only、8 page/idle/viewer TTL、popup/Document 阻断。 |
| [workspace-isolation-3081.mjs](workspace-isolation-3081.mjs) | 真实 3081：注册 workspace session scope、scoped HTTP/WS（真实 headless Chrome 页面内带 cookie）、A/B frame/close/recent binding、loaded build/PID/home 证据。 |
| [gui-workspace-3081.mjs](gui-workspace-3081.mjs) | 真实 3081 GUI：创建两个注册工作区/会话，main MoreRow 捕获与右栏 session scope、A/B/A 请求/WS/frame 不串、隐藏右栏停播。 |
| [address-history-3081.mjs](address-history-3081.mjs) | 真实 3081 GUI 地址/历史回归（scope 取自 main 面板当前 session，与 hostFetch 同一 runtime）。 |
| [milestone-probes.mjs](milestone-probes.mjs) | P14–P19 能力发现（16 工具、七项 `web.t2.*` + `structured-dom` available、T3/T4 unsupported、`limits.structuredGui`）、lease、证据 envelope（含 7 个 T2 工具的 envelope + `evidence.version=1`）、截图附件/回退、取消/面板同锁、启动失败与目标策略。 |
| [input-modifiers.mjs](input-modifiers.mjs) | P20 `browser_input` 功能键与修饰键：Tab/Shift+Tab 焦点、Ctrl+A 标志、`virtualKeyCode`→`e.keyCode`、位掩码/`autoRepeat`/mouse/wheel、老式最小调用、非法参数拒绝；真值为页面内捕获的 DOM 事件（经 `browser_eval` 读回）。 |
| [host-contract.mjs](host-contract.mjs) | P21 宿主输出契约：按 `DSH_ROOT` 从 DSH 安装目录解析真实 `@deepseek-ai/dsh-util-values`，用 `snapshotJsonValue`/`isJsonValue` 断言 16 工具（9 T1 + 7 T2）返回值与 render content 为 lossless JSON（含 eval `undefined`/抛错、数字参数 args、无附件截图、失败网络条目、类实例附件的投影、T2 成功值/证据与 `TARGET_NOT_FOUND` 抛错详情）。解析不到真实包时退回内联等价校验器并记 finding，不静默冒充。 |
| [runtime-faults.test.mjs](runtime-faults.test.mjs) | CDP 故障注入和 Runtime 边界；使用 fake WebSocket、受控时钟与 fake CDP，避免等待真实 30 秒超时。 |
| [http-request.mjs](http-request.mjs) | P22 独立 HTTP 请求：临时回环服务器、`http.request` 派发 spy、逐跳目标复验、字节/截断/压缩、脱敏与真实 lossless 校验；不启动 Chromium。 |
| [check-skill.mjs](check-skill.mjs) | 16 工具与 Skill、台账（T1 台账必需、T2 台账为 INFO 直到 skill owner 落地）、manifest 一致性（tier=T1 或 T1+T2；T3/T4 必须 unsupported；T2 声明转必需当 manifest 已声明 T1+T2）；错误、lease、截图回退契约。 |
| [check-skill-registry.mjs](check-skill-registry.mjs) | 真实 Cordis 注册、加载、resourceBase、render 和 dispose。 |
| [real-browser-ws.mjs](real-browser-ws.mjs) | 可选隔离 DSH 的真实 GUI 帧管线回归。 |

## 主验收探针

| ID | 必需行为 |
| --- | --- |
| P1 | 恰好 16 工具（9 T1 + 7 T2）、required 与 `docs/runtime-t1.md` + `docs/t2-structured-gui.md` §2.2 一致、schema、HTTP 路由、owner 诊断、未启动时 capability 可用。 |
| P2 | loopback 导航成功；state URL/title 与页面一致；SPA 改标题可读；file 拒绝、不可达 `NAV_FAILED`、失败恢复。 |
| P3 | 按值 JS/Promise/undefined；页面异常返回 `EVAL_ERROR` 对象及消息、stack、details。 |
| P4 | CSS 精确值、全集；缺失元素返回 `TARGET_NOT_FOUND` 操作失败。 |
| P5 | 原生点击的 counter 副作用、文本输入与提交结果。 |
| P6 | 完成/失败网络元数据；token 脱敏与 redacted 标记；state 不泄露 token。 |
| P7 | 保留 PNG base64；魔数、bytes、IHDR 尺寸；本次运行目录截图落盘。 |
| P8 | close 等待进程退出、删除 profile、清空状态/网络/帧；幂等 close、全新 profile 重启。 |
| P9 | 独立 apply 实例进程隔离；同工作区不同 session 受 single-owner-lease 约束，不同工作区 page 独立。 |
| P10 | throw/操作失败/HTTP 均有 code/category/retryable；HTTP error 保持字符串；BrowserError 消息有 `[CODE]` 与 action 证据。 |
| P11–P13 | WS hello/二进制帧、epoch/seq、鉴权/loopback、metrics、轮询回退、close 清理。 |
| P14 | capability 实际服务探测、16 工具声明、七项 `web.t2.*` 与 `web.t2.structured-dom` available、T3/T4 unsupported、`limits.structuredGui` 限额；可跨会话诊断。 |
| P15 | 同工作区两会话仅一个拿 lease；6 个页面/网络工具拒绝其他 owner；diagnostic 不夺租约；disposed 匹配释放；未知 exec 走 legacy；跨工作区并发不受该租约影响。 |
| P16 | 16 工具（含 7 个 T2，T2 额外要求 `evidence.version=1` 与 targets/incomplete/truncated/networkDelta/before/after）成功返回和 durable 文本均有 actionId/sessionId/startedAt/finishedAt/target/args；actionId 唯一；截图 hash/time/attachmentId；有服务 render image attachment、无服务明确 base64-fallback 并保留图片。 |
| P17 | signal 取消 1 秒内 `ABORTED`；返回前关闭旧浏览器、释放 owner；后续懒启动；长 eval 与面板输入/后续工具不交错。HTTP body 异步解析不规定其与工具的先后入队顺序。 |
| P18 | `/bin/false` 注入启动失败；明确 BrowserError，无新增 profile 残留。 |
| P19 | 工具及 HTTP 阻断 scheme/metadata/RFC1918/credentials/DSH 自身；合法 loopback 重定向成功，metadata 重定向失败；HTTP 200 后截断更新 failed/errorText 且不重复条目；window.open 的 secondary target 向被阻断 origin 发出 Document 请求计数为 0，原页仍可导航。 |
| P20 | Tab 焦点前进（#inc→#name）、Shift+Tab 焦点回退；`commands:['selectAll']` 页面真值 selection 0/6（无 commands 对照 3/3）、`unmodifiedText` 只断言可见输入语义（特有作用不可观察记 INCONCLUSIVE）、`pointerType:'pen'` 页面 `PointerEvent.pointerType==='pen'` 与 mouse 对照；Ctrl+A 的 keydown `ctrlKey=true`/`key='a'`；`virtualKeyCode` 决定 `e.keyCode`（Tab=9/A=65）；整数位掩码 10 等价 ctrl+shift；`autoRepeat`→`e.repeat`；`location`/`isKeypad`（数字键盘 `e.location=3`、左 Shift `e.location=1`）；mouse/wheel 修饰键生效且点击副作用保持；老式最小 key/mouse 调用仍工作；非法修饰键名/类型/越界掩码/非法 `key.type`/非法 `pointerType` 抛 `INVALID_ARGUMENT` 且不向页面派发事件；schema 声明全部新字段。 |
| P21 | 真实宿主校验器（`@deepseek-ai/dsh-util-values`，版本随安装走）对 16 工具成功值 + render content 断言 lossless JSON；用真实 `@deepseek-ai/dsh-tools` 的 `assertSupportedJsonSchema` 断言 16 个 `output.schema`（参数 schema 只要求 lossless + object/required，子集合规为提示性）；`browser_eval` 页面值 undefined、页面抛错（EVAL_ERROR 值）、`browser_network` 数字参数 args、无附件服务截图、loadingFailed 网络条目、工具抛错 details、附件类实例投影均可快照且无 `undefined` 属性；校验器解析失败时用内联等价实现并记 finding。 |
| P22 | 独立 `browser_http_request`：默认 GET/5s/64KiB、`ok:true≠2xx`、headers 小写→string[]、默认不跟随/显式跟随每跳复验、方法规则、超时/取消、阻断目标与重定向阻断零派发（`http.request` spy）、非法参数零副作用、正文截断/字节/base64/压缩、无 cookie jar、脱敏、证据 target 为初始 URL、真实 lossless、未启动/关闭态、卸载 ABORTED。 |

## T2 结构化验收探针（`t2-structured.mjs`，对应 `docs/t2-structured-gui.md` §9）

2026-11-01 优化轮（契约 §3.1.1 冗余文本压缩、§4.3「不自动滚入视口 + hint + 两帧稳定性」、§9.4/§9.25/§9.26）的用例已并入 C4/C6/C25/C26；靶机新节点见 `tests/ui_test_fixture/README.md` §T2.10。

每个 probe 的 `id`/`criteria` 直接对应 §9 的编号条件；报告里 38 条逐条可读。真值来自靶机 `window.__t2`（真实 DOM 事件的 `isTrusted`/修饰键）、DOM 读回与 `tests/ui_test_fixture/README.md` §T2 的契约值，不信工具自报的 "applied"。

| ID | §9 | 覆盖 |
| --- | --- | --- |
| C1-registration | 1 | 16 工具注册面、§2.2 required、未知字段/目标冲突 INVALID_ARGUMENT、纯参数失败不启动 Chromium |
| C2-cold-capabilities | 2 | 仅 state/capabilities 即可读事实、七项 `web.t2.*`+`structured-dom` available、T3/T4 unsupported、description 含 T1/T2、`limits.structuredGui` |
| C3-workspace-isolation | 3 | 两个 workspace 的 page/ref/lease 独立：A 的 ref 在 B 为 REF_STALE 且不影响 A |
| C4-semantic-snapshot | 4 | 标题/40 项列表/表格/同名 Save（3 个：2 个内容命名 + 1 个 aria-label owner）/顺序、refs 与树一一对应、display:none 与 aria-hidden 排除；**冗余文本压缩正负例**（嵌套同 role/同名冗余行不再输出、aria-label owner 与子文本都保留、分片文本 `Alpha Beta Gamma` 顺序与空格、同名 sibling 各留一份、长名 256 vs 子文本 475 保留更完整子表示、generic 文本区只留一份、相邻捕获 tree/digest 相同） |
| C5-stable-digest | 5 | 连续捕获 tree/digest 相同、`sha256(tree).slice(0,16)`、snapshotId 递增、ref 复用与 minted provenance；digest 定义仍是 sha256(最终 tree)，压缩算法等**跨构建**变化导致的 digest 变化不算回归 |
| C6-snapshot-limits | 6 | 默认=显式、maxNodes/depth/treeBytes 截断标记与 reasons（treeBytes 用 800 个互异 ~220 字节节点确定性逼近 >131072，不依赖重复文本层）、业务 JSON ≤524288、非法范围 INVALID_ARGUMENT |
| C7-boxes | 7 | `boxes=false` 无 box/bbox=null；`boxes=true` 与 `getBoundingClientRect` 误差 ≤0.02 且无聚焦/滚动副作用 |
| C8-scope | 8 | scope 只输出子树、根深度 0、空/冲突/0 命中/多命中/未知 ref 报错、scoped 快照不废掉其他 ref |
| C9-ref-retention | 9 | 第二次快照后旧 ref 仍点击原节点、新节点拿更大编号、旧编号不变 |
| C10-lru | 10 | 2200 节点注入 + 多 scope 快照把注册表推到 2000 上限：淘汰 ref REF_STALE、仍在窗口内可用、重新发现编号更大 |
| C11-navigation-invalidation | 11 | 跨文档导航/reload/history commit 清 refs；pushState/hash 不清；snapshotId 与 ref 编号不重置 |
| C12-node-identity | 12 | DOM 移动原节点仍可点；同 id/同名新对象替换后 REF_STALE 且 counter 不增 |
| C13-unique-selector | 13 | 唯一 selector 可点、0 命中 TARGET_NOT_FOUND、多匹配（含隐藏副本）TARGET_NOT_UNIQUE、非法 CSS/ref 形状 INVALID_ARGUMENT |
| C14-trusted-click | 14 | counter+1、pointerdown/mousedown/mouseup/click 全 `isTrusted`、双击两 click 一 dblclick、右键 contextmenu、ctrl 修饰、toggle 与 node_state 读回 |
| C15-hidden-disabled | 15 | hidden/disabled/disabled fieldset/inert/零面积 NOT_INTERACTABLE + reason、hidden 升级 T3、node_state 仍可读、零事件 |
| C16-covered-motion | 16 | 覆盖目标 NOT_INTERACTABLE(reason=covered, T3)、pointer-events:none、持续运动 unstable、无 force 逃生参数 |
| C17-offscreen | 17 | 离屏节点自动滚入视口、before/after scroll 真值、现场 bbox 与 getBoundingClientRect 一致、命中该节点 |
| C18-text-input | 18 | replace/append/clear、textarea 换行、单行换行 INVALID_ARGUMENT、页面 input 事件真值、结果不回显原文 |
| C19-edit-limits | 19 | readonly NOT_INTERACTABLE(readonly)、contenteditable UNSUPPORTED、beforeinput 取消 value-mismatch、焦点被抢 focus-mismatch |
| C20-enter | 20 | submit=false 不派发；submit=true 派发 Enter(keyCode 13, isTrusted) 并触发真实提交；业务字段最小 |
| C21-form-text-boolean | 21 | 6 字段批量写入、per-field 顺序/eventSource、已满足复选框 changed=false 且零 click、提交 JSON 核对 |
| C22-combobox-slider | 22 | 单选 cn、多选 [a,c]、slider 70、eventSource=dom-control 且页面 `isTrusted=false`、非法选项/类型/范围/step 预检拒绝 |
| C23-form-precheck | 23 | 后项越界/重复目标/0 命中/多匹配/控件不符/空 fields/21 项 → 零派发、applied=0、failedIndex |
| C24-form-partial-failure | 24 | 首项 input 监听移除下一字段 → REF_STALE、applied=1/failedIndex=1、首项副作用保留、无回滚 |
| C25-directional-scroll | 25 | 文档四方向、默认 amount=400、`#t2-scroll-box` 上下滚动真值、边界 moved=false 仍成功；**离屏/运动负例**：离屏目标的 `direction` 零派发 `NOT_INTERACTABLE(outside-viewport)`（`dispatch.started=false/eventCount=0`、页面与元素 scroll 不变、details.hint 存在且不含 selector），随后无目标滚文档 + 重读 node_state + 重试成功；`#t2-moving` → `unstable` 零派发 |
| C26-to-scroll | 26 | to=bottom/top 达真实端点、eventSource=dom-scroll、direction+to / to+amount / 缺方向 / 越界拒绝；`to` 也不绕过视口/命中预条件（离屏 `to=bottom` 零派发 outside-viewport + hint；`#t2-moving` 的 `to=bottom` → unstable 零派发） |
| C27-node-state | 27 | 完整 NodeState、selected/checked/expanded/readonly/disabled/required/inViewport、aria-hidden 的 DOM 可见性、长文本与 value 脱敏 |
| C28-wait-success | 28 | 异步文字、textGone、state 单项与 AND、polls/elapsedMs 真实、不产生新 snapshot/ref |
| C29-wait-negative | 29 | WAIT_TIMEOUT details 完整且页面不关、timeout=0 只一次、混条件/越界/空 state/multi-match/ref 移除 REF_STALE |
| C30-wait-cancel | 30 | poll 中 abort 1s 内 ABORTED（不伪装 WAIT_TIMEOUT）、旧 refs 失效、页面仍可驱动 |
| C31-form-cancel | 31 | 批处理中途 abort → ABORTED 保留 applied/dispatch、后项未写入、不宣称回滚 |
| C32-lease | 32 | 七工具在其他 owner 下全 BUSY、capabilities unavailable+BUSY、state/HTTP 仍可用、无关 disposed 不释放、owner disposed 释放 |
| C33-success-evidence | 33 | 七工具 envelope + version=1 evidence + targets/identity/identity 标志/before-after/dispatch/networkDelta + render 证据 + minted provenance + selector 不原文回显 |
| C34-failure-evidence | 34 | 六码 BrowserError（category/retryable/[CODE]/details.evidence）、hidden/covered 升级 T3、失败不关页面 |
| C35-network-redaction | 35 | networkDelta seq 窗口/≤20 条/dropped、输入哨兵不泄露、value=null+valueRedacted、URL 脱敏、evidence ≤262144 |
| C36-shadow-frame | 36 | open shadow 的 AX ref 可信点击、`__t2.shadow` 深层 isTrusted、CSS 不穿透、iframe 仅边界、closed shadow 无 ref |
| C37-t1-host-regression | 37 | 进程内部分：16 工具成功值 + render 全部 lossless、T1 9 工具 surface 未放宽；其余回归由 run.mjs / runtime-faults / workspace-isolation / check-skill 单独执行 |
| C38-real-host | 38 | **NOT_RUN**：需隔离 DSH 重新加载终版并在真实 Agent 会话执行（fake ctx 不能代替） |

## P0 截图验收与截图落盘隔离

`capture-p0.mjs` 使用与主验收相同的 fake-ctx harness 和真实无头 Chromium，靶机是 `tests/ui_test_fixture/capture-p0.html`（固定几何/颜色）与 `blank.html`（纯白），真值表见 `tests/ui_test_fixture/README.md` §P0。

**默认暂存、显式持久**：persist:boolean默认false。只有out/persist:true/非空DSH_UI_TESTING_CAPTURE_DIR才持久到env（绝对非法不回退）或cwd根；其它含legacy无cwd默认插件实例级`<tmp>/dsh-ui-testing-capture-*`暂存，绝对路径、0600/no-clobber、dispose清理。file含pathKind/persistence/root/ephemeral，持久路径相对；observed.file仅persistence/relativePath|null，不暴露暂存绝对路径。真实tmp不可写/SIGKILL残留未验。harness设置env表示“持久到测试临时根”，不是生产默认模式；验收绝不写仓库，因此：

- `harness.mjs` 在模块初始化时若 `DSH_UI_TESTING_CAPTURE_DIR` 未设置，就用 `mkdtemp(<tmpdir>/dsh-ui-testing-capture-)` 建临时根、写进该 env，并在进程 `exit` 时 best-effort 删除；导出 `CAPTURE_TMP_ROOT` / `captureTempRoot()` 供测试断言。
- `capture-p0.mjs` 在 import harness **之前**建立自己的 run 专属根（`<tmpdir>/dsh-ui-testing-capture-p0-*`），因此 `captureTempRoot()` 返回 `undefined`；该脚本在 C12 断言临时根、本次 Chromium 子进程与 profile 都被删除，并断言本次运行没有在仓库里创建 `output/`。
- 每个 run 独立 capture 根 + 独立 Chromium profile，所以同一脚本可连续重复运行，没有状态残留。env覆盖根必须绝对路径；相对值报OUTPUT_PATH_INVALID，不回落cwd。

当前默认暂存修订Lead串行复跑 **14/14 probes、142/142 requiredChecks、0 failed、exit0**（[最终报告](runs/capture-p0-2026-11-01T05-52-05-302Z-104057/report.json)）；T1 **22/22、324/324**（[报告](runs/2026-11-01T05-49-22-590Z-100191/run-report.json)）；T2 **37/38+1 NOT_RUN、260/260**（[报告](runs/2026-11-01T05-50-44-987Z-101531/run-report.json)）。C1–C14，新增C14共23项覆盖staging/legacy/persist/out/env/pathKind/dispose/能力不泄露绝对路径，C1增加2项。unit26/26、faults16/16由Lead交接；Skill/registry在文档后复核。

T1随机flake须如实并列：上方05-49-22为22/22、324/324、exit0；最终文案代码[05-59-53](runs/2026-11-01T05-59-53-185Z-105978/run-report.json)为 **21 PASS/1 FAIL、323/324通过/1失败、exit1**。两次行为实现相同，仅persist描述字符串不同。唯一失败P21-host-output-contract→“失败网络条目（loadingFailed）可快照且无undefined字段”，actual仅3条成功条目，与[04-30-43基线](runs/2026-11-01T04-30-43-916Z-53146/run-report.json)同项。Lead归类既有环境随机flake，非P0引入；不得把失败写PASS。验收需串行，串行也可能复现。T2最终代码[06-01-14](runs/2026-11-01T06-01-14-788Z-107358/run-report.json)仍37/38+1 NOT_RUN、260/260、exit0。

修订前历史：Lead独立串行复跑P0两次均 **13/13 probes、117/117 requiredChecks、0 failedChecks、exit0**（[05-15-01](runs/capture-p0-2026-11-01T05-15-01-055Z-85097/report.json)、[05-15-05](runs/capture-p0-2026-11-01T05-15-05-476Z-85616/report.json)）；T1 **22/22、324/324**（[报告](runs/2026-11-01T05-15-09-827Z-86138/run-report.json)），T2 **37/38+1 NOT_RUN、260/260**（[报告](runs/2026-11-01T05-17-06-786Z-87684/run-report.json)）。P0单测26/26、runtime-faults16/16、check-skill25/25、registry17/17由Lead交接，均exit0；仓库无output/与PNG残留。P21既有loadingFailed flake会随机复现，当前两次报告须并列（见下文），不能据单次通过判其消失；验收须串行执行，避免并发浏览器干扰页面时序。

以下为执行者增量前历史：三次连续运行各 **13/13 probes、115/115 requiredChecks、0 failedChecks、exit 0**：[首轮](runs/capture-p0-2026-11-01T04-57-34-532Z-65733/report.json)、[第二轮](runs/capture-p0-2026-11-01T04-58-28-002Z-66463/report.json)、[第三轮](runs/capture-p0-2026-11-01T04-58-32-550Z-66980/report.json)。C1–C13覆盖默认1280×800、scale2=2560×1600、101×50@1.11=112×56、纯色/条纹像素、文档坐标与滚动、PNG CRC/尺寸/hash/0600、安全路径/no-clobber、参数错误、附件metadata、冷启动capabilities、重复清理及截图前后布局。主回归 **22/22、324/324、exit0**：[报告](runs/2026-11-01T04-59-29-531Z-68121/run-report.json)。

公开maxDelta增量后复跑 **13/13、117/117、0 failed、exit0**（[报告](runs/capture-p0-2026-11-01T05-09-04-665Z-79630/report.json)），新增白页maxDelta=0/内容页255两条断言；前三份115项报告是增量前证据。

C6的 `/frame` HTTP响应是application/json，image字段为base64 JPEG，以JPEG魔数及解码尺寸验证，不声称HTTP Content-Type=image/jpeg。C13的scroll/视口/红块/绿块/fixed rect前后完全相同，仅说明本fixture/版本未观察到持久布局变化，不能排除瞬时LBI。附件比较只依据metadata，缺字段不推断一致；provider视觉及P0真实宿主重载仍NOT_RUN，canvas源分辨率限制与本地TOCTOU边界仍在。权威契约见 [capture-p0.md](../../docs/capture-p0.md)。

## 故障注入覆盖

- CDP resolve、协议错误、abort、timeout、disconnect、同步发送失败都清空 pending、清除 timer 和 abort listener。
- 已关闭或预取消命令不派发；同步发送失败会关闭 CDP。
- 真实 Chromium 的 CDP 断开后，ensure 先回收旧进程/profile，再启动新实例并恢复 owner。
- lease 在 15 秒 idle 后可转交；操作进行中越过 expiry 不失效，完成后重新计算 idle 窗口。
- 排队中取消不执行其 action，也不提前解锁正在进行的操作。
- 派发后的取消/超时完成关闭后，才允许下一队列操作；无响应 stopScreencast 的清理受 200ms 超时约束。
- owner A1 取消清 lease 后，已排队 A2 的 reservation 仍拒绝 B；A2 执行前重新 claim，完成后可正常 release。
- CDP navigation errorText、最终目标被禁时回到 about:blank。
- literal IPv4/IPv6、DNS localhost、域名解析失败、private 显式 opt-in 与 metadata 恒拒绝。

## 实测范围

Host 截图的 attachment image block 和 base64 fallback 都有断言；真实 provider 是否把图片交给视觉模型仍需宿主会话验证。工作区隔离测试不宣称 Cookie/localStorage/cache 隔离（同 profile 共享）；T2 套件不宣称覆盖 provider 视觉、T3 视觉判定、T4 动画/拖拽时序、跨帧/closed shadow 内部动作，§9.38 的真实宿主证据记为 NOT_RUN；测试也不宣称覆盖 provider 视觉效果、所有子资源网络沙箱、DNS rebinding、宿主/操作系统级按键语义（如 macOS 专有快捷键、IME 组字）或冻结面板视觉；P20 只断言 Chromium 渲染器实际产生的 DOM 事件与焦点变化。目标策略的 DNS 检查使用真实解析，Chromium Document 重定向使用真实本地 HTTP server；最终目标校验另以 fake CDP 注入验证。宿主侧 `snapshotToolValue` → `snapshotJsonValue` 的值快照由 P21 用真实校验器覆盖；但 fake Cordis ctx 仍不等同完整宿主会话（`tools/result` 物化、provider 呈现、会话持久化不在本套件内）。
