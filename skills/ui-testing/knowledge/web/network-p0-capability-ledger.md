# Web 网络 P0 · 能力台账

> 开发事实记录，**不是运行时可用性声明**。先确认当前 Agent 注册表里确有 7 个 `browser_network_*` 工具，再读 `browser_capabilities` 的实际 `available/unavailable/unsupported` 与 `network` 段限额。静态状态（`verified` / `partial` / `implemented-not-verified` / `unsupported`）不能直接当作 available。
>
> 契约与验收依据：仓库 `docs/network-p0.md`（§2 七工具、§4 事件 schema/配额/完整性、§5 分析、§6 链路、§7 控制、§8 证据/安全/隔离、§9 靶机、§10 验收 C1–C52、§13 R1 裁决）。实现：`index.js`（CDP 采集/注册/租约）+ `network-p0.js`（事件/会话/分析/链路/控制/证据/订阅纯 JS 核心），错误码在 `browser-safety.js`。历史台账见 [t1-capability-ledger.md](t1-capability-ledger.md)、[t2-capability-ledger.md](t2-capability-ledger.md)（保持不改）。

**当前口径**：工具面 **22 → 29**（+7 network）。（**2026-11-04 更新：已到 35 = 10 T1 + 7 T2 + 6 T3 + 7 network + 5 T4**。）这 7 个是**纯新增**，不属于契约 §1.2「旧 22 工具保持不变」；旧工具的加法式增强只有两处——`browser_screenshot` 证据新增 `capture.networkWindow`（`capture.version` 仍 **1**）、T2 动作与网络事件加 mark 关联（`networkDelta` 仍在），`browser_network` 仍是 300 条元数据环形缓冲、T3 未改。

**验收状态（Lead 独立串行复跑，同一最终代码，2026-11-01 12:27）**：

```text
node tests/acceptance/network-p0.mjs
→ tests/acceptance/runs/2026-11-01T12-27-48-770Z-370586/run-report.json
  criteriaTotal 52 / covered 52 / passed 52 / failed 0 / notRun 0
  requiredChecks 266 / failedChecks 0 / notRunChecks 8 / exit 0
  单测 unitRunners: network-p0.test.mjs ok（43/43，node --test tests/network-p0.test.mjs）
非回归（同一时点串行）：T1 run.mjs 23/23、347/347、exit 0（12-39-01-545Z-382567）
  T2 t2-structured.mjs 37/38 + 1 NOT_RUN、261/261、exit 0（12-40-39-213Z-384724）
  T3 t3-vision.mjs 56/56、391/391、notApplicable 3、exit 0（12-43-30-666Z-391625）
  capture-p0.mjs 14/14、142/142、exit 0（capture-p0-2026-11-01T12-42-03-957Z-388489）
  runtime-faults 16/16、workspace-isolation 77/77、check-skill 27/27、check-skill-registry 19/19
```

据此 7 个 `browser_network_*` 与聚合 `web.network.p0`、G1.1–G6.9（C1–C49）与 C50–C52 技术不变量记 **verified**，**唯一例外是 `G1.5` 记 `partial`**。**8 条 NOT_RUN 逐条列出、不算 PASS**：C1 HTTPS 独立验证、C2 二进制 body、C5 service worker 采集、C20 单样本 p95、C35 被淘汰 body 三态、C37 `modify-response`、C52 外部四套件（由上面四份非回归报告代证）、C52 真实宿主。**真实宿主重启后的网络冒烟仍未验证**（3080 pid <pid>，17:24:28 启动，早于本轮变更），进程内套件不能替代它。

## 逐工具状态

| ID | 工具 | 工程状态 | 契约要点 / 已知边界 | 验收指针 |
| --- | --- | --- | --- | --- |
| web.network.session | `browser_network_session` | verified | `action` 必填（start/stop/status/reset）；**唯一网络懒启动动作**；同名 start 幂等 `changed:false`、不同名运行中 `NET_SESSION_ACTIVE`；`status`/`reset` 不启动浏览器；`reset` 只清内存（磁盘证据不动）并关闭本 scope 订阅；`config` 仅 `start` 生效（captureBodies/captureWebSocket/captureSse/captureWorkers、maxEvents/maxBodyBytes/maxTotalBytes/maxWsFrames、businessStatusPath、maskRules≤16） | C6 会话管理、C34 启停控制、C50 注册面/能力 |
| web.network.events | `browser_network_events` | verified | 只读不启动；`view`=summary/full/timeline/aggregate；`limit` 1–200；`cursor` 与 `sinceSeq` 二选一、指向已淘汰 seq 返回 `gap`；filter/search/groupBy/aggregate；search 只回脱敏预览片段 | C10 标准化、C11 时间轴、C24 筛选/检索/聚合 |
| web.network.detail | `browser_network_detail` | verified | `requestId`/`seq` 恰一；`include` 默认除 body 外全部；body 三态 `captured\|empty\|unavailable`（读不到 `available:false`，不伪造、不重试、不 ensure）；`hops` 支持逐跳；找不到 `NET_EVENT_NOT_FOUND` | C2 内容捕获、C7 生命周期、C8 重定向链、C9 initiator、C35 按需详情 |
| web.network.trace | `browser_network_trace` | verified | `action` 必填（begin-step/end-step/mark/link/window/query/reset），全部内存操作不启动浏览器；窗口按 wallMs 派生 `stepId`（`basis:"temporal"`）不改写事件；`stepIds` 显式链接与派生 `stepId` 并存；`includeTemporal` 默认 false | C17 请求↔步骤、C26–C32 链路与因果 |
| web.network.control | `browser_network_control` | verified | `action` 必填；需 page 的动作懒启动；throttle+offline 组合状态（Kbps=1024bit/s）；规则≤32、hold≤64、超时 `NET_CONTROL_TIMEOUT` 计数；`reset` 恢复条件并放行 held，但**不 `Fetch.disable`**（Document 导航守卫保留）；`modify-response` 仅 Chrome 实测支持时可用 | C21 错误注入、C36–C40 控制 |
| web.network.evidence | `browser_network_evidence` | verified | `action` 必填（export/import/index/search/link/integrity/clear/list）；JSONL 保真、HAR 只保证 1.2 子集（未知数值 `-1`）；只回相对路径且限持久根；离线会话可分析不可 control（`NET_CONTROL_UNAVAILABLE`）；全部动作不启动浏览器 | C41–C44 持久化/证据 |
| web.network.subscribe | `browser_network_subscribe` | verified | `action` 必填（create/poll/ack/close/list）；owner-only、每 scope 订阅上限 16、pin 1000；游标不得回退、ack 不得越过已交付；落后只产生 gap/dropped 计数，不阻塞采集、不动他人 pin | C49 多 Agent 订阅 |
| web.network.p0 | （聚合） | verified | 聚合能力：采集→时序→分析→链路→控制→证据→订阅七段；只读不加租约，session/control 变更走该工作区队列与 single-owner-lease（其他 owner 占用 `BUSY`）；`G1.5` partial、HTTPS 未独立验收、`responseModification` 条件支持 | C50 工具面/能力、C51 安全/隔离、C52 非回归 |

## 逐条能力状态（G1.1–G6.9，映射 docs/network-p0.md §10 的 C 号）

| 能力 | 状态 | 说明 / 边界 | C 号 |
| --- | --- | --- | --- |
| G1.1 HTTP/HTTPS 捕获 | verified | HTTP 请求/响应/完成与失败事件、url/method/status/resourceType 与页面真值一致（HTTP 子项 B 类实证）；**HTTPS 子项 NOT_RUN**（无本地 TLS 靶机、未配 CA），能力报 `https:"mechanism-identical"` | C1 |
| G1.2 内容捕获 | verified | **C2 的「二进制 body base64」子项 NOT_RUN**（靶机无二进制路由，不伪造断言）； 请求体（JSON/form）与响应体（JSON/text/gzip 解压后）可读；二进制 base64；读不到 `NET_BODY_UNAVAILABLE` 不伪造；配额截断计数 | C2 |
| G1.3 WebSocket | verified | 握手、`server-push-1`、echo 双向帧、关闭；方向/opcode/payload；帧上限计数 | C3 |
| G1.4 SSE | verified | `/n/sse` 三条事件（eventName/eventId/data）；关流后 EventSource error 不崩；只用 `eventSourceMessageReceived`，不从响应体重复解析 | C4 |
| G1.5 iframe/OOPIF/Worker | **partial** | 已实证：**same-origin iframe** 与 **dedicated worker**（page 级 `Target.setAutoAttach` 对象 filter、先装 listener 再 `Network.enable` 再 `runIfWaitingForDebugger`）。**service worker 子项 NOT_RUN**（R1-21：attach 会在启动时暂停它并破坏 `serviceWorker.register()`/`controller`，采集不得改变页面语义）；**shared worker 不采集**（本构建 page 级 attach 未附加）；**OOPIF 未单独验证**（能力报 `oopif:'partial'`）；**popup 继续被既有目标策略阻断**，不采 popup、不跨 scope 聚合。能力报 `subTargets={workers:'page-attached',shared_worker:'not-collected',service_worker:'not-collected',oopif:'partial',partial:true,reason}` | C5 |
| G1.6 会话管理 | verified | start 幂等、stop 幂等、status 不启动浏览器、不同名冲突、reset 清空、seq 单调、保留最近 4 个会话摘要 | C6 |
| G1.7 生命周期 | verified | request→response→finished 顺序与终态；loadingFailed 只 failed；redirect 链顺序；无重复 finished | C7 |
| G1.8 重定向链 | verified | `/n/redirect/1→2→final` 的 redirect 事件与最终 URL；`hops` 逐跳可 detail；链长 ≤20、无循环 | C8 |
| G1.9 发起源 | verified | `initiator.type` 用 `"script"`（不假设 `"fetch"`）、url 指向页面、父链、栈 ≤10；不假设 `initiator.requestId` 一定存在 | C9 |
| G2.1 标准化 | verified | `NET_PROTOCOL_VERSION=1` 字段/类型/枚举、ts 三时间（wall/monotonic/requestTimeMs）、summary/full 投影；入店后脱敏且不可变 | C10 |
| G2.2 统一时间轴 | verified | http/ws/sse/marker 混排按 monotonicMs 升序；desc 只影响返回顺序；fromSeq/toSeq 准确 | C11 |
| G2.3 时间戳/耗时 | verified | ttfb/total 与 `/n/slow` 实测一致（容差）；缺失为 null 不给 0；wallMs 用该 target 首个 wallTime 锚点推算（禁止逐条 `Date.now()`） | C12 |
| G2.4 并发/时序关联 | verified | `/n/slow` 制造的重叠窗口、seq 顺序与完成顺序、聚合正确；不伪造因果 | C13 |
| G2.5 GUI↔网络 | verified | T2 动作 mark（actionId）与新增事件的时间关联；`evidence.networkDelta` 仍在；basis=temporal | C14 |
| G2.6 页面状态↔网络 | verified | navigate/reload 后 documentURL/navId/loaderId 变化、state mark、事件归属正确 | C15 |
| G2.7 截图↔网络 | verified | `browser_screenshot` 证据含 `networkWindow`（frameTimeMs/captureEndMs/fromSeq/toSeq/nearest），`toSeq` 用 highWater 不含调用后新事件、`nearest` 可为 null；原 capture 字段不变 | C16 |
| G2.8 请求↔步骤 | verified | begin/end-step 窗口内事件按 wallMs 归入；跨窗口归最早匹配；不写回事件 | C17 |
| G3.1 参数解析 | verified | query 重复键、JSON/form/multipart/text、parseError；`/n/echo` 各形态与 header 上限 | C18 |
| G3.2 状态码 | verified | HTTP status+statusClass；业务码默认路径与显式 path；无业务码 null，不猜语义 | C19 |
| G3.3 性能统计 | verified | **C20 的「样本<2 时 p95=max」子项 NOT_RUN**（U 类已在 `tests/network-p0.test.mjs` 覆盖）； aggregate count/bytes/min/max/avg/p50/p95/failures；样本<2 时 p95=max；incomplete 传播 | C20 |
| G3.4 错误/异常 | verified | 500、offline、fail 规则、blocked、canceled、timeout 识别；cors 只标 suspect | C21 |
| G3.5 重试/重复 | verified | `/n/flaky` 首 503 后 200 标 retry；连续同请求标 duplicate；轮询键忽略 volatile query；窗口/阈值边界 | C22 |
| G3.6 关联标识 | verified | traceparent/x-request-id/body traceId 提取为每会话 HMAC 的公开 hash；同链路分组；导出不含原值 | C23 |
| G3.7 筛选/检索/聚合 | verified | method/status/statusClass/type/urlIncludes/failed/kind/step/时间/耗时过滤；search 命中与脱敏预览；groupBy/aggregate 上限 | C24 |
| G3.8 依赖关系 | verified | initiator 父子、redirect 链、same-url；detail 只回直接边；不做 temporal 因果 | C25 |
| G4.1 跨步骤记录 | verified | 两步窗口分别统计；重叠不重复计数；步骤上限 200 | C26 |
| G4.2 对象提取/传递 | verified | url-query/url-path/header/json-body/ws/sse 规则；propagate 在后续 URL/header/body 命中（`basis:"observed"`）；无命中不报 | C27 |
| G4.3 跨请求关联 | verified | 同 correlation hash 分组；detail.correlation 同组数；不跨 scope | C28 |
| G4.4 业务状态变化 | verified | businessCode/HTTP status 变化产生 states（`basis:"observed"`）；无变化不产生 | C29 |
| G4.5 窗口管理 | verified | begin 默认 now、end 默认 now、显式 window、重复 begin/end、window 查询、重叠窗口归属 | C30 |
| G4.6 异步/轮询 | verified | `#net-poll-start` 三次识别 polling 间隔（method+origin+path+bodyHash 键）；end-step 后标 asyncAfterClose；不自动停页面定时器 | C31 |
| G4.7 因果元数据 | verified | explicit link / redirect / initiator 三种 basis；temporal 默认不回报；不写错 basis | C32 |
| G4.8 证据关联 | verified | link seq↔evidenceId 幂等；trace.query/detail 返回 evidenceIds；截图与 T2 actionId 关联 | C33 |
| G5.1 启停控制 | verified | start→请求→stop→再请求；reset 后 counters 归零；stop 不关页面 | C34 |
| G5.2 按需详情 | verified | **C35 的「已捕获但被配额淘汰的 body 三态」子项 NOT_RUN**（U 类覆盖）； 默认不读 body；include body 读取；已捕获/未捕获/已淘汰三态；不伪造 | C35 |
| G5.3 拦截 | verified | block 使请求 failed(BlockedByClient)；fail 规则 errorText；命中计数；Document 导航守卫仍生效（单一 dispatcher，每请求恰好一次终结） | C36 |
| G5.4 请求/响应修改 | verified | **C37 的 `modify-response` 子项 NOT_RUN**（能力报 `responseModification=false`，CDP 不支持 `Fetch.continueResponse`）； `modify-request` 改 header/url 被服务端回显、`fulfill` 返回给定状态/体；`modify-response` 仅在 Chrome 实测支持时断言，否则**子项 NOT_RUN** | C37 |
| G5.5 延迟/带宽 | verified | throttle latency 使 `/n/json` 耗时显著增加；Kbps 影响大 body；reset 恢复 | C38 |
| G5.6 断连/故障 | verified | offline 请求失败事件；恢复后成功；不杀 page | C39 |
| G5.7 重放/Mock | verified | replay via page 用服务端命中计数 + 新 CDP 请求双证；via http 不带 Cookie；mock 返回指定响应且原记录不变 | C40 |
| G6.1 缓存/持久化 | verified | JSONL 落盘 0600/无覆盖/原子；会话 config/meta 完整；暂存 vs 持久路径规则；异常根不回退 | C41 |
| G6.2 HAR/JSONL | verified | JSONL 保真往返（含 seq 空洞、`complete:false`）；HAR 1.2 必填字段与 `-1` 约定；HAR 往返只断言 HTTP 条目；坏行/坏 HAR 错误码 | C42 |
| G6.3 证据索引/检索 | verified | index/list/search 覆盖内存与文件；路径越界拒绝；`deleteFiles` 只删本 scope | C43 |
| G6.4 截图证据关联 | verified | 截图 `networkWindow` 与 `evidence.link` 双向；detail.evidenceIds；无证据为 `[]` | C44 |
| G6.5 脱敏 | verified | URL token/authorization/x-net-token/set-cookie/body 字段/WS/SSE 全程 `***`；导出/检索/错误无原值；maskRules 追加不关闭默认 | C45 |
| G6.6 权限/会话隔离 | verified | 两个 workspace scope 各自会话互不可见；跨 scope sessionId → `NET_SCOPE_FORBIDDEN`；离线会话不可 control | C46 |
| G6.7 配额/背压 | verified | maxEvents 淘汰、maxBodyBytes 截断、maxTotalBytes 淘汰 body、subscription/held/规则/步骤超限错误；全部计数公开 | C47 |
| G6.8 完整性 | verified | `complete` 条件、gaps/issues 枚举、cdp-disconnected、导入 partial、订阅 overflow；不允许 `complete:true` 同时丢数 | C48 |
| G6.9 多 Agent 订阅 | verified | 同 scope 两 agent 独立 create/poll/ack；A ack 不影响 B；B poll 不重复；跨 agent poll FORBIDDEN；pin/gap 计数 | C49 |

## 技术不变量

| 不变量 | 状态 | 说明 | C 号 |
| --- | --- | --- | --- |
| 工具面/能力报告 | verified | 注册表 29 工具、7 个新工具 schema 与 `action` 必填、`browser_capabilities.network` 段与 7 项 `web.network.*` + 聚合 `web.network.p0`、诊断不启动浏览器、旧 22 工具行为不变 | C50 |
| 安全与隔离 | verified | 默认脱敏、路径限制、owner-only 订阅、控制需租约/只读不占、无绝对路径泄漏、无跨 scope 泄漏、新失败为 `NET_*`（平台码按 R1-5 注明） | C51 |
| 非回归 | verified | T1 `run.mjs` 23/23、347/347；T2 `t2-structured.mjs` 37/38+1 NOT_RUN、261/261；T3 `t3-vision.mjs` 56/56、391/391；`capture-p0.mjs` 14/14、142/142（均 exit 0）；`node --check`/`git diff --check` 干净。**C52 的真实宿主子项 NOT_RUN**（3080 未重启） | C52 |

## 明确未验证 / 不承诺

- **真实宿主**：3080（pid <pid>，17:24:28 启动）早于本轮 `index.js`/`network-p0.js` 变更，未加载网络 P0；重启后 7 个网络工具的真实会话冒烟、provider 与长连接稳定性 **NOT_RUN**。进程内套件（52/52、266/266）通过不等于真实宿主已验证。
- **报告内 8 条 NOT_RUN 的完整清单**（与 `run-report.json` 的 `notRun` 一一对应）：C1 HTTPS、C2 二进制 body、C5 service worker、C20 单样本 p95、C35 淘汰 body 三态、C37 `modify-response`、C52 外部四套件（由 T1/T2/T3/capture-p0 报告代证）、C52 真实宿主。
- **HTTPS**：无本地 TLS 靶机、未配置自定义 CA，机制同一但未独立验收；能力报告必报标量 `capabilities.network.limits.network.https = "mechanism-identical"`（与 `responseModification` 并列，不得写 `true`/`verified`）。
- **`responseModification`**：条件支持；Chrome 不支持 `Fetch.continueResponse` 时 C37 的 `modify-response` 子项记 NOT_RUN。
- **`G1.5` partial**：popup 被既有目标策略阻断，多标签/popup 采集、跨 scope 聚合都不是本能力；shared/service worker 归属不明时拒采。
- 不做 MITM/不装 CA/不读 TLS 密钥；不做真实网络限速（只模拟 CDP 网络条件）；HAR 只有 1.2 子集，WS/SSE 保真由 JSONL 断言；脱敏不是通用秘密检测器。
- 时间相邻关系只能标 `basis:"temporal"`，不是因果；CDP 帧不证明 TCP 分片无损。
