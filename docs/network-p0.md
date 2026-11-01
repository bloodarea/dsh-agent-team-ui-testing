# P0 网络基础设施（WEB-P0 Network）权威契约

> 索引：[docs/index.md](index.md) · 状态：[status.md](status.md) · 实现：`network-p0.js` + `index.js` · 验收：`tests/acceptance/network-p0.mjs` + `tests/network-p0.test.mjs`
>
> 本文是本轮**唯一权威接口契约**。代码、Skill、README 与验收断言冲突时以本文为准；实现必须先改本文再改代码（Lead 裁决）。文中 `C1–C52` 是验收条件编号，验收套件报告里的 `criteria` 号可直接对回本文 §10。

## 1. 范围与非目标

### 1.1 目标

为 Web 调试链路提供「业务链路追踪引擎 + 动态网络调试抓包」，并为 WEB-T4 的动态视觉/时序提供网络侧时序证据；同时增强 T1（程序化）的 `browser_network` 与 T2（结构化 GUI）的动作—网络关联能力。

- 采集：HTTP/HTTPS 请求与响应内容、WebSocket 双向消息、SSE 事件、IFEAME/OOPIF/Worker 子目标、生命周期、重定向链、initiator（发起源）。
- 时序：标准化事件、统一时间轴、时间戳/耗时、并发关联、GUI 动作与页面状态关联、截图帧时间同步、业务步骤关联。
- 分析：参数解析、HTTP/业务状态码、性能统计、错误/异常、重试/重复、关联标识、筛选检索聚合、依赖关系。
- 链路：跨步骤记录、业务对象提取/传递、跨请求关联、状态变化、时间窗口、异步/轮询、因果元数据、证据关联。
- 控制：启停、按需详情、拦截、请求/响应修改、延迟/带宽、断连/故障、重放/Mock。
- 证据与安全：缓存/持久化、JSONL/HAR 导入导出、索引检索、截图关联、脱敏、权限/会话隔离、配额/背压、完整性/丢事件检测、多 Agent 共享采集与独立订阅。

### 1.2 冻结决策（不可由实现自行放宽）

1. **工具面 22 → 29**：新增 7 个 `browser_network_*`（§2）；旧 22 个工具的**参数/返回/语义不变**（`browser_network`、`browser_screenshot`、T2 七工具、`browser_capabilities` 均只做加法）。
2. **零 npm 依赖、纯 JavaScript**（Node 内置模块 + 仓库既有模块）。不引入 playwright/puppeteer/mitmproxy/ws 等。
3. **真实 CDP**：采集走插件自己的无头 Chromium；不装 CA、不做 MITM 代理、不读 TLS 密钥。
4. **诊断/离线只读不启动浏览器**：`session.status/reset`、`events`、`detail`、`trace` 的只读动作、`evidence.*`、`subscribe.*` 不启动 Chromium。`session.start` 与需要 `page` 的 `control` 动作才懒启动。
5. **默认脱敏**：URL 敏感 query、敏感头（`authorization`/`cookie`/`set-cookie`/`x-api-key`/`x-auth-token`/`x-net-token`/`proxy-authorization`）、JSON/form 体敏感字段一律 `***`；原值不进事件/证据/日志/错误消息。body 内容脱敏规则见 §8.4。
6. **错误一律 `NET_*` + category/retryable**（§2.9），不降级 `INTERNAL`；`ok:true` 只表示调用完成，不代表证据完整或断言通过。
7. **按 scope 隔离**：采集会话、事件库、订阅、证据文件都属于一个 Runtime（DSH 工作区 scope）。跨 scope 不可读、不可控制；Cookie/存储仍按 Chromium profile 共享（与既有 `workspace-isolation.md` 一致，不声称登录态隔离）。
8. **G1.5 为 partial**：覆盖同一主 page 的 same-process iframe、OOPIF（跨源 iframe）、dedicated/shared/service worker；**popup 继续被既有目标策略阻断**（`index.js` `#blockPopup`），不采 popup、不跨 scope 聚合、不新增标签页/窗口操作工具。能力报告与台账必须写 partial 与理由。
9. **不伪造**：读不到的 body 返回 `available:false`；丢失/淘汰/截断必须计数；时间相邻关系只能标 `basis:"temporal"`，不得冒充因果。
10. **界面冻结**：`client.js` 的样式/文案/布局本轮不动；本能力只走 Agent 工具与 HTTP 路由。

### 1.3 非目标

- 不做 Web T4 动态视觉/帧序列推理；网络时间轴只提供数据与证据。
- 不做多标签页操作、popup 接管、下载/上传、Cookie 导出、TLS/证书代理。
- 不做跨 workspace 的网络聚合、跨机器共享、真实网络限速（只模拟 CDP 网络条件）。
- HAR 只保证 1.2 子集（§8.2），不承诺浏览器 DevTools 全量字段或 Chrome 专有字段。

## 2. 工具面（7 个新工具）

所有工具的公共约定：

- 参数对象一律拒绝未知字段（`additionalProperties:false`）；字符串长度、数组长度、数值范围在执行期校验，超限 `INVALID_ARGUMENT`，配额超限 `NET_QUOTA_EXCEEDED`。
- 成功返回 `{ ok:true, ... }`；失败抛 `BrowserError`（`code/category/retryable/message/details`），消息不回显敏感原值。
- 每次调用（成功或抛错）带证据块 `evidence`：`{version:1, operation, sessionId, fromSeq, toSeq, counters, integrity, redaction, truncated}`；细节见 §8.6。
- `sessionId` 省略时用当前 scope 的「当前会话」：运行中优先，否则最近一次已停止会话；无会话时只读工具返回空并置 `session:null`（不抛错），需要数据的动作（detail/trace 等）抛 `NET_SESSION_NOT_FOUND`。
- 只读动作不加页面租约；`session.start/stop/reset` 与 `control` 动作走 `runtime.run()`（串行队列 + single-owner-lease），其他会话持有会话时返回 `BUSY`（与 T2/T3 一致）。

### 2.1 `browser_network_session`

启停/查询采集会话。**唯一的网络懒启动动作**（`start`）。

```jsonc
// 参数
{
  "action": "start|stop|status|reset",   // 必填
  "name": "default",                     // 可选，≤64 字节，默认 default
  "config": {                             // 可选，仅 start 生效；其余 action 携带即拒绝
    "captureBodies": true, "captureWebSocket": true, "captureSse": true, "captureWorkers": true,
    "maxEvents": 5000, "maxBodyBytes": 262144, "maxTotalBytes": 8388608, "maxWsFrames": 2000
  }
}
```

- `start`：运行中且 `name` 相同 → 幂等返回 `changed:false`；运行中且 `name` 不同 → `NET_SESSION_ACTIVE`。停止状态 → 新建会话（保留最近 4 个会话元数据）。启动需 page（懒启动），失败按既有启动错误分类。
- `stop`：幂等；停止采集但保留事件与 body 供读取；`control` 状态恢复为正常网络（§7.6）。
- `status`：返回当前会话 + 最近 4 个会话摘要 + 活动订阅数；不启动浏览器。
- `reset`：清空当前 scope 的事件/body/步骤/订阅/链接（不删除已导出的磁盘文件）；不启动浏览器；需要确认式参数 `confirm:true`？——**不需要**：reset 只清内存，磁盘证据不动，默认允许。

返回（`start`/`status`）：

```jsonc
{ "ok": true, "changed": true,
  "session": { "id": "net-<8hex>", "name": "default", "state": "running|stopped|snapshot",
    "startedAt": 1760000000000, "stoppedAt": null, "config": { /* 生效值 */ },
    "counters": { "events": 12, "http": 9, "ws": 1, "sse": 1, "markers": 1,
      "bodies": 4, "bodiesUnavailable": 1, "bytes": 1234,
      "evicted": 0, "dropped": 0, "bodyEvicted": 0, "truncated": 0, "wsFrames": 2,
      "subscribers": 0 },
    "integrity": { "complete": true, "dropped": 0, "evicted": 0, "truncated": 0 } },
  "sessions": [ { "id": "...", "name": "...", "state": "stopped", "startedAt": 1, "stoppedAt": 2,
    "counters": { "events": 3 }, "retained": true } ],
  "limits": { "maxEvents": 20000, "maxBodyBytes": 1048576, "maxTotalBytes": 33554432,
    "maxWsFrames": 20000, "subscriptionMax": 16, "subscriptionPin": 1000, "holdTimeoutMs": 30000 },
  "evidence": { "version": 1, "operation": "session.status", "sessionId": "net-...", "truncated": false } }
```

### 2.2 `browser_network_events`

读取/筛选/检索/聚合事件。只读，不启动浏览器。

```jsonc
{
  "sessionId": "net-...",        // 可选
  "sinceSeq": 0, "untilSeq": null, "cursor": null, "limit": 50, // limit 1–200，默认 50
  "order": "asc|desc", "view": "summary|full|timeline|aggregate",
  "filter": { "method": "GET|POST|array", "status": 200, "statusClass": "2xx|4xx",
    "resourceType": "Fetch|Document|XHR|WebSocket|EventSource", "urlIncludes": "≤256",
    "failed": false, "kind": "http|ws|sse|marker", "phase": "request|response|finished|failed|redirect|ws-send|ws-receive|sse-message|mark",
    "targetId": "…", "stepId": "step-1", "sinceMs": 1760000000000, "untilMs": null,
    "minDurationMs": 100, "maxDurationMs": null },
  "search": { "text": "≤256", "in": ["url","body","headers","ws","sse"], "caseSensitive": false },
  "groupBy": "url|method|status|statusClass|resourceType|host|kind|step",
  "aggregate": ["count","bytes","duration","p50","p95","failures"]
}
```

- `filter` 各字段可给标量或数组（OR 语义）；`search.in` 默认 `["url"]`；`search` 命中 body/ws/sse 时只返回脱敏后的预览片段（`match:{field,preview}`），不回显原值。
- `view:"timeline"` 返回统一时间轴（http/ws/sse/marker 混排，按 `ts.monotonicMs` 排序，`desc` 只影响返回顺序）。`view:"aggregate"` 必须给 `groupBy`（缺省 `url`），返回 `groups:[{key,count,bytes,durationMs:{min,max,avg,p50,p95},failures,statuses}]`。
- `view:"summary"`/`"timeline"` 的事件字段：`seq/ts{wallMs,monotonicMs}/kind/phase/requestId/method/url/status/statusText/resourceType/mimeType/durationMs/size{encoded,decoded}/failed/errorText/targetId/frameId/stepId/redirect?/mark?`。
- `view:"full"` 追加 `headers{request,response}`（脱敏）、`timing`、`initiator`、`correlation`、`business`、`ws`/`sse` 摘要、`redaction`。

返回：

```jsonc
{ "ok": true, "sessionId": "net-...", "view": "summary",
  "fromSeq": 1, "toSeq": 12, "total": 12, "returned": 3,
  "dropped": 0, "evicted": 0, "truncated": false,
  "cursor": { "next": "eyJ2IjoxLCJzZXEiOjEzfQ" },   // 末尾为 null
  "events": [ { "seq": 1, "kind": "http", "phase": "request", "requestId": "1000.1",
    "method": "GET", "url": "http://127.0.0.1:PORT/n/json?from=page&n=1", "status": null,
    "resourceType": "Fetch", "ts": { "wallMs": 1760000000000, "monotonicMs": 1234.5 },
    "durationMs": null, "size": { "encoded": null, "decoded": null }, "failed": false,
    "errorText": null, "targetId": "…", "frameId": "…", "stepId": null } ],
  "groups": [], "integrity": { "complete": true, "dropped": 0, "evicted": 0, "truncated": 0 },
  "evidence": { "version": 1, "operation": "events", "sessionId": "net-...", "fromSeq": 1,
    "toSeq": 12, "truncated": false } }
```

- `cursor` 不透明（base64url 的 `{v:1,seq}`），与 `sinceSeq` 二选一；`cursor` 优先。`sinceSeq`/`cursor` 指向已淘汰 seq 时返回 `gap:{from,to,dropped}` 并照常返回现存事件。
- 事件上限由会话 `maxEvents` 环形缓冲决定；`evicted` 是历史淘汰数（会话累计）。单次响应上限 200 条，超出置 `truncated:true` 并给 `cursor.next`。

### 2.3 `browser_network_detail`

按 requestId 或事件 seq 读取一条请求/一条 WS/SSE 连接的完整详情；body 按需读取。

```jsonc
{
  "sessionId": "net-...",
  "requestId": "1000.1",       // 与 seq 二选一（恰好一个）
  "seq": 7,
  "include": ["request","response","headers","body","timing","redirects","initiator",
              "ws","sse","correlation","dependencies","business","events"], // 默认除 body 外全部
  "maxBodyBytes": 262144       // 1024–1048576
}
```

- `request`/`response`：`request` 行（method/url/headers/query/postData 类型）、`response` 行（status/statusText/mimeType/headers/fromCache/protocol/remoteIP）。
- `body`：`requestBody`/`responseBody`：`{available,encoding:"utf8|base64",bytes,truncated,redacted:"fields|none",source:"captured|unavailable",data}`。body **只在采集完成（`loadingFinished`）后由采集器异步补抓一次**；`detail` 是纯只读动作，不为此启动 CDP、不重试、不从旧缓冲区补读。失败/缓存命中/重定向中途/已淘汰的请求 → `available:false, reason:"NET_BODY_UNAVAILABLE"`（缓存命中可能只有元数据），**不伪造空体**。二进制按 base64，`data` 受 `maxBodyBytes` 截断并标 `truncated`；`maxTotalBytes` 淘汰后同 `available:false` + `bodyEvicted` 计数。
- `timing`：`{requestTime,responseTime,ttfbMs,totalMs,dnsMs,connectMs,sslMs,sendMs,waitMs,receiveMs,serverTiming?}`（缺项 null，不给 0 冒充）。
- `redirects`：`[{requestId,url,status,location}]`（沿同一 requestId 的 `redirectResponse` 链）。
- `initiator`：`{type,url,line,column,requestId,stack:[{functionName,url,line,column}]}`（栈最多 10 帧）。
- `dependencies`：`{parents:[{requestId,url,relation:"initiator|redirect|same-url|temporal"}], children:[…]}`。
- `ws`：`{url,protocol,handshake,openedAt,closedAt,frames:[{seq,direction:"send|receive",opcode,payload,payloadTruncated,wallMs}],counts}`（帧受 `maxWsFrames` 与单帧 `wsPayloadBytes=65536` 限制）。
- `sse`：`{url,events:[{seq,eventName,eventId,data,wallMs}],counts}`（单条 `data` ≤ 65536 字节）。
- `correlation`：`{ids:[{name,value,source:{kind,header|query|jsonPath,seq} }]}`（值脱敏）。
- `business`：`{statusCode:200, businessCode:0, businessCodePath:"code", objects:[{name,value,source:{seq,from,path}}]}`。
- `events`：该 requestId 的生命周期事件列表（summary，最多 50）。

返回失败：找不到 requestId/seq → `NET_EVENT_NOT_FOUND`；body 明确要求但不可得 → 不抛错，`available:false`。

### 2.4 `browser_network_trace`

业务步骤、对象提取、跨请求关联、状态与证据。只读 query/window 不启动浏览器；begin/end/mark/link 是 Host 侧内存操作（不启动浏览器）。

```jsonc
{
  "sessionId": "net-...",
  "action": "begin-step|end-step|mark|link|window|query|reset",
  "stepId": "step-1", "name": "提交订单", "labels": { "case": "checkout" },
  "window": { "fromWallMs": 1760000000000, "toWallMs": 1760000001000 },
  "objectRules": [ { "from": "url-query|url-path|header|json-body|ws|sse",
                     "key": "orderId", "path": "data.order.id", "name": "orderId",
                     "propagate": true } ],
  "correlationRules": [ { "from": "header|url-query|json-body", "key": "x-request-id",
                          "path": null, "name": "requestId" } ],
  "businessStatusPath": "code",
  "mark": { "kind": "note|action|state|evidence", "text": "≤256", "actionId": "…",
            "tool": "browser_click", "stepId": "step-1" },
  "link": { "seq": 7, "requestId": null, "stepId": "step-1", "evidenceId": "…" },
  "query": { "stepId": null, "sinceMs": null, "limit": 50 }
}
```

- `begin-step`：开窗（`window.fromWallMs` 默认 now）；`labels` ≤16 个字符串键值；自动应用默认 `correlationRules`（`traceparent`/`x-request-id`/`x-trace-id`/`request-id` 头，body 的 `traceId`/`requestId`）与默认 `objectRules`（无；对象提取只按显式规则，避免猜测）。同名步骤再次 begin → `NET_RULE_CONFLICT`。
- `end-step`：关窗（`toWallMs` 默认 now）；重复 end 幂等。步骤窗口内的事件在查询时按时间归入（`basis:"temporal"`），不得改写事件本身。
- `mark`：写一条 `kind:"marker"` 事件（`phase:"mark"`，`mark` 字段），并可选绑定 `stepId`/`actionId`；`actionId` 与 T2 证据的 actionId 一致。
- `link`：把事件（`seq`/`requestId`）连到步骤（`stepId`）或证据（`evidenceId`），写链接索引；重复 link 幂等。
- `window`：返回当前步骤窗口集合与每次查询的窗口统计。
- `query`：返回步骤列表 + 每步：`{id,name,state,window,counters{events,http,ws,sse,failures},objects[{name,value,source:{seq,requestId,from,path}}],states[{atWallMs,seq,from,to,basis}],evidence[{evidenceId,seqs,kind}],causality[{seq,parentSeq,basis:"explicit|redirect|initiator|temporal"}]}`；`limit` 截断并标 `truncated`。
- `reset`：清步骤/对象/状态/链接（不动事件）。
- 业务对象传递（G4.2）：`propagate:true` 的对象值若出现在后续请求的 URL/header/body，关联到第一条携带它的请求（`basis:"observed"`），不猜测相似值。

### 2.5 `browser_network_control`

拦截/改写/限速/断连/重放/Mock。需要 page 的动作自行懒启动（懒启动不改变 `session.status` 的会话状态）。

```jsonc
{
  "sessionId": "net-...",
  "action": "throttle|offline|intercept-add|intercept-remove|intercept-clear|intercept-list|hold|resume|replay|mock|reset",
  "throttle": { "latencyMs": 0, "downloadKbps": 0, "uploadKbps": 0 },
  "offline": true,
  "rule": { "id": "rule-1",
    "pattern": { "urlPattern": "*", "resourceType": "Fetch", "method": "GET" },
    "behavior": { "kind": "block|fail|modify-request|fulfill|delay|hold",
      "headers": { "x-debug": "1" }, "body": "≤65536", "status": 200,
      "delayMs": 1000, "fromRequestId": "1000.1" } },
  "ruleId": "rule-1",
  "requestId": "1000.1", "seq": null,
  "then": { "kind": "continue|fulfill|fail", "headers": {}, "body": "≤65536",
            "status": 200, "errorReason": "Aborted" },
  "replay": { "count": 1, "via": "page|http" },
  "mock": { "status": 200, "headers": {}, "body": "≤65536" },
  "confirm": true
}
```

- `throttle`：`latencyMs 0–60000`、`downloadKbps/uploadKbps 0–1000000`（0 表示不限速）；映射 `Network.emulateNetworkConditions`（`offline:false`，`downloadThroughput=Kbps*1024/8`）。`reset` 恢复 `offline:false,latency:0,throughput:-1`。
- `offline`：`offline:true|false`；断连时请求失败由页面/CORS 表现，事件照常记录。throttle 与 offline 是**组合状态**：实现保存 `{offline,latencyMs,downloadKbps,uploadKbps}` 后统一发 `Network.emulateNetworkConditions`，`throttle` 不得隐式取消已设 offline，`offline` 不得清空已设限速。`downloadKbps/uploadKbps` 单位 = 1024 bit/s（Kibps），实现换算 `bytesPerSecond = Kbps*1024/8`，测试读取 CDP 实参。
- `intercept-add`：规则 `id` 缺省生成 `rule-<n>`；**同一 id 已存在** → `NET_RULE_CONFLICT`；`urlPattern` 用 CDP `urlPattern` 语法（`*`/`?`）；`behavior.kind`：`block`（`Fetch.failRequest BlockedByClient`）、`fail`（可给 `errorReason`，默认 `Aborted`）、`modify-request`（`Fetch.continueRequest` 覆盖 url/headers/postData）、`fulfill`（`Fetch.fulfillRequest`，可 `fromRequestId` 复用已存响应）、`delay`（先 `delayMs` 再 continue）、`hold`（暂停，`resume` 前最多挂起 `holdTimeoutMs=30000`，超时自动 continue 并计数）。规则按添加顺序匹配，先命中先生效；最多 32 条。
- `intercept-remove`：按 `id`；不存在 → `NET_RULE_INVALID`。`intercept-clear` 清全部并恢复网络。`intercept-list` 返回规则与命中计数。
- `hold`/`resume`：`hold` 需要已存在 `behavior.kind:"hold"` 规则（可 `ruleId` 限定）；`resume` 按 `requestId`（或全部）执行 `then`，默认 `continue`。held 上限 64，超限 `NET_QUOTA_EXCEEDED`。
- `replay`：从已存事件（`requestId`/`seq`）重放；`via:"page"`（默认，页面内 `fetch`，同源带 Cookie）或 `http`（Host 独立客户端，无 Cookie，目标校验同 `browser_http_request`）；`count 1–10`；重放产生的请求照常采集并标 `mark.kind:"replay"`。
- `mock`：为已存请求注册一次性 `fulfill` 规则（响应体来自参数或 `fromRequestId`）；不修改原请求记录。
- `reset`：恢复网络条件（offline:false/latency:0/throughput:-1）、清规则、resume 全部 held；不删除事件；**不得 `Fetch.disable`**（否则破坏既有 Document 导航守卫），只恢复为「仅导航守卫」的 Enabled 配置。
- 与既有导航守卫共存：`Fetch.enable` 只能有一份配置；实现必须合并「既有 Document 导航拦截 patterns」与「活动规则 patterns」，Document 请求先走既有守卫语义，再走规则。禁止为拦截能力关闭导航守卫。

### 2.6 `browser_network_evidence`

JSONL/HAR 导入导出、索引、检索、链接与完整性。只读动作不启动浏览器；导入/导出不启动浏览器。

```jsonc
{
  "sessionId": "net-...",
  "action": "export|import|index|search|link|integrity|clear|list",
  "format": "jsonl|har|auto",           // auto 按 out/ file 扩展名，缺省 jsonl
  "out": "output/network/demo.jsonl",   // 工作区相对路径；必须在持久根内（见 §8.1）
  "persist": false,                     // 与 out 同义（有 out 即持久）
  "includeBodies": false,
  "file": "output/network/demo.har",    // import：相对路径，限制在持久根内
  "data": null,                          // import：内联 JSONL/HAR 文本 ≤8MiB（与 file 二选一）
  "query": { "text": "≤256", "urlIncludes": "≤256", "status": 500, "stepId": "…", "seqs": [1,2] },
  "link": { "seq": 7, "evidenceId": "…" },
  "deleteFiles": false
}
```

- `export`：从当前会话或指定会话导出。`format:"jsonl"` 写 meta 行 + 事件行（§8.1）；`format:"har"` 写 HAR 1.2 子集（§8.2）。`includeBodies:false`（默认）不写 body，只写大小/`content.size`；`includeBodies:true` 时 body 受已捕获配额与 `maxBodyBytes` 限制。
- `import`：解析 JSONL/HAR → 新建离线会话（`state:"snapshot"`、`source:{file|data,format}`、`snapshot:true`）。离线会话可 `events/detail/trace/evidence` 分析、可再导出；**不可 `control`/`replay`/`mock` 到页面**（`NET_CONTROL_UNAVAILABLE`）。HAR 结构非法 → `NET_HAR_INVALID`；JSONL 坏行 → 跳过并计数 `skippedLines`，全部不可解析 → `NET_IMPORT_FAILED`。
- `index`：返回证据索引 `{version:1, sessions:[…], files:[{relativePath,format,bytes,sessionId,createdAt,integrity}], entries:{events,requests,steps}, links:[…]}`。
- `search`：在内存会话与已导出文件元数据中检索，返回 `{results:[{sessionId,seq,url,method,status,wallMs,stepId,file?}], truncated}`；不读回敏感值。
- `link`：`{seq,evidenceId}` → 证据链接（同一 seq 可多证据；幂等）。
- `integrity`：`{complete,dropped,evicted,truncated,bodyEvicted,gaps:[{from,to,count}],issues:["events-evicted","subscriber-overflow",…]}`；`complete` 仅当 dropped/evicted/truncated 全为 0 且无 gap。
- `clear`：清内存会话/索引/链接；`deleteFiles:true` 才删除本 scope 已导出的证据文件（仍在持久根内、逐文件 no-clobber 语义下删除）。
- `list`：列本 scope 已导出的证据文件（相对路径、格式、字节、会话、完整性）。

### 2.7 `browser_network_subscribe`

多 Agent 共享同一采集会话、各自独立订阅游标。

```jsonc
{
  "sessionId": "net-...",
  "action": "create|poll|ack|close|list",
  "subscriptionId": "sub-…",
  "cursor": null, "afterSeq": null,
  "limit": 50,                        // 1–200
  "kinds": ["http","ws","sse","marker"],
  "ackSeq": 9
}
```

- `create`：订阅者 = 调用方 agent 会话（`exec.agent` 身份）；每个 scope 最多 16 个活动订阅；返回 `{id,createdAt,cursor:{next},ackedSeq,counters:{delivered,pending,pinned,dropped}}`。
- `poll`：从订阅游标（或显式 `cursor`/`afterSeq`）取事件；**ack 前不丢**：环缓冲淘汰前先 pin 至多 `subscriptionPin=1000` 条；pin 预算耗尽时该订阅返回 `gap:{from,to,dropped}` 并累计 `dropped`（绝不静默丢），**不淘汰其它订阅已 pin 的事件**；采集本身不因单个订阅落后而停止（背压只体现为 pin/dropped 计数与 integrity issue）。每个订阅独立投递，不与其它订阅共享游标。
- `ack`：推进 `ackedSeq` 并释放对应 pin；`ackSeq` 小于当前 ack → `NET_RULE_INVALID`。
- `close`：幂等；`list`：仅列调用方自己的订阅；他人的订阅 `NET_SUBSCRIPTION_FORBIDDEN`。
- 订阅不阻塞采集（背压只体现为 pin 计数与 gap 计数）。

### 2.8 `browser_network`（旧工具，保持不变）

保持 T1 语义：`{limit}` → `{entries:[{url,method,type,status,failed?,errorText?,at}]}`，仅最近 300 条、URL 脱敏。新能力全部在 7 个新工具里，不改变旧形状。`browser_capabilities` 对旧工具的描述不变（可增加一行指向新工具）。

### 2.9 错误码（browser-safety.js TAXONOMY）

| code | category | retryable | 触发 |
| --- | --- | --- | --- |
| `NET_SESSION_NOT_FOUND` | scope | false | 指定/默认会话不存在 |
| `NET_SESSION_ACTIVE` | concurrency | false | start 时另一个不同名会话运行中 |
| `NET_EVENT_NOT_FOUND` | action | false | requestId/seq 不存在（含已淘汰） |
| `NET_BODY_UNAVAILABLE` | network | true | 请求在 CDP 缓冲中已不可读 |
| `NET_QUOTA_EXCEEDED` | resource | false | 配额/订阅/held 上限 |
| `NET_RULE_INVALID` | input | false | 规则/参数/ack 非法 |
| `NET_RULE_CONFLICT` | concurrency | false | 规则 id/步骤名重复 |
| `NET_CONTROL_UNAVAILABLE` | capability | false | 无 CDP/page、离线会话不可控制 |
| `NET_EXPORT_FAILED` | output | true | 导出/落盘失败 |
| `NET_IMPORT_FAILED` | input | false | 导入不可解析 |
| `NET_HAR_INVALID` | input | false | HAR 结构非法 |
| `NET_SUBSCRIPTION_NOT_FOUND` | scope | false | 订阅不存在 |
| `NET_SUBSCRIPTION_FORBIDDEN` | authorization | false | 非订阅 owner |
| `NET_INTEGRITY_FAILED` | integrity | false | 证据完整性校验失败（如导入声明与内容不符） |
| `NET_SCOPE_FORBIDDEN` | authorization | false | 跨 scope 访问 |
| `NET_CONTROL_TIMEOUT` | timeout | true | hold 超时自动 continue 的告警（不抛错，计数） |

## 3. 采集架构

### 3.1 CDP 映射（每 Runtime 一个 page target）

| 能力 | CDP | 落库动作 |
| --- | --- | --- |
| 请求开始 | `Network.requestWillBeSent`（含 `redirectResponse`、`initiator`、`frameId`、`loaderId`、`type`、`timestamp`、`wallTime`） | 新事件 `phase:"request"`；redirect 先写 `phase:"redirect"` 并串链 |
| 请求头补全 | `Network.requestWillBeSentExtraInfo` | 合入该 requestId 的 `request.headers`；不另发事件（可发 `phase:"extra-info"` 可选） |
| 响应开始 | `Network.responseReceived`（`response.timing`、`status`、`mimeType`、`fromCache`、`protocol`、`remoteIPAddress`） | `phase:"response"`；写入 timing 骨架 |
| 响应头补全 | `Network.responseReceivedExtraInfo`（`headers`、`headersText`、`statusCode`） | 合入 `response.headers` |
| 数据传输 | `Network.dataReceived`（`dataLength`、`encodedDataLength`） | 更新 sizes 与 `dataChunks` 计数（不逐 chunk 建事件） |
| 完成/失败 | `Network.loadingFinished` / `Network.loadingFailed`（`errorText`、`blockedReason`、`canceled`） | `phase:"finished"`/`"failed"`；失败事件入依赖与错误分析 |
| 缓存命中 | `Network.requestServedFromCache` | 事件标记 `fromCache` |
| 响应体 | `Network.getResponseBody`（`base64Encoded`） | 完成时异步补抓（可关）；受配额截断 |
| 请求体 | `Network.getRequestPostData` | POST 有体时补抓；失败记 `bodiesUnavailable` |
| WebSocket | `Network.webSocketCreated` / `webSocketWillSendHandshakeRequest` / `webSocketHandshakeResponseReceived` / `webSocketFrameSent` / `webSocketFrameReceived` / `webSocketFrameError` / `webSocketClosed` | WS 连接实体 + 每条帧事件（双向，`direction`） |
| SSE | `Network.eventSourceMessageReceived`（`eventName`、`eventId`、`data`、`timestamp`） | 每条消息一条 `kind:"sse"` 事件 |
| 子目标 | page 连接 `Target.setAutoAttach{autoAttach:true,waitForDebuggerOnStart:true,flatten:true,filter:[worker,iframe]}` → `Target.attachedToTarget`（**shared/service worker 不 attach，实测边界见 §13 R1-21**） | 子会话 `Network.enable` + `Runtime.runIfWaitingForDebugger`；子会话事件带 `targetId/cdpSessionId`；`detachedFromTarget`/页面关闭清理 |

### 3.2 生命周期状态机（http 请求）

```text
request ──redirectResponse──> redirect ──> request(新 URL，同 requestId)
   │                                             │
   ├──responseReceived──> response ──loadingFinished──> finished
   │                          └────loadingFailed──────> failed
   └──loadingFailed（无响应）────────────────────────> failed
```

- 同一 `requestId` 的 redirect 链最多 20 跳（`redirectChain` 上限；超出保留前 20 并标 `truncated`）。
- `finished` 与 `failed` 互斥；重复事件按 CDP 顺序处理，后到覆盖 `phase` 的终态。
- 事件 `seq` 是**会话内**单调（从 1 开始，`start` 新会话重新计数）；`ts.wallMs` 取 CDP `wallTime*1000`（缺失回退 `Date.now()`），`ts.monotonicMs` 取进程单调时钟，`ts.cdpSeconds` 保留原始 `timestamp`。三者同存，不互相换算。

### 3.3 页面/文档/动作关联

- 每个事件带 `documentURL`（脱敏）+ `loaderId` + `frameId` + `targetId`；主 frame 导航时记录 `navId`（自增）并写入后续事件。
- **GUI 动作关联**（G2.5）：每个页面工具（T2/T3 live/T1 navigate/input 等）执行前后向采集器写 `mark{kind:"tool",tool,actionId}`；事件查询可按 `mark` 邻近窗口关联（`basis:"temporal"`），`actionId` 与工具 envelope 的 actionId 一致。
- **页面状态关联**（G2.6）：`browser_state`/`uiState` 的 revision 与 URL/title 变化写 `mark{kind:"state",revision,url,title}`（脱敏）；事件时间轴可回放页面状态切换。
- **截图同步**（G2.7）：`browser_screenshot` 成功后，证据加 `networkWindow:{sessionId,fromSeq,toSeq,frameTimeMs,nearest:{seq,requestId,url,method,status,deltaMs}|null}`：`frameTimeMs` 为截图调用开始时间（`Date.now()`），`nearest` 是时间轴最近事件（|deltaMs| 最小），`fromSeq/toSeq` 覆盖 `frameTimeMs±250ms` 内事件（至少 5 条、至多 50 条）。只加字段，不改既有 `capture.version=1` 结构。
- **业务步骤关联**（G2.8/G4.1）：`trace.begin-step/end-step` 的窗口按时间归入事件（`stepId` 为查询期派生，不写回事件）；`trace.link` 为显式关联（`basis:"explicit"`）。

### 3.4 与既有实现的关系

- `index.js` 现有 `this.requests/this.network`（300 条）与 `#t2NetworkSeq` 保持原样：`browser_network`、P6/P21 与 T2 `networkDelta` 的断言不受影响。新采集器是与旧缓冲并行的有界账本（默认 5000 事件），由 `session.start` 开启；未开启时新采集器只保留「最近 200 条事件」的候选缓冲，`session.start` 后晋升为正式会话（候选事件带 `preSession:true` 并可查，保证「先导航再 start 也能看到起始请求」）。
- **启动语义**：`session.start` 调 `runtime.run()` → `ensure()`（懒启动）→ 记录会话起点；`stop` 只停采集不关页面。页面关闭/导航不自动停止会话（事件继续入库），CDP 断线时 `integrity.issues` 加 `cdp-disconnected` 并自动停止。

## 4. 事件模型、存储与配额

### 4.1 事件 schema（`NET_PROTOCOL_VERSION=1`）

```jsonc
{
  "seq": 1, "sessionId": "net-…",
  "ts": { "wallMs": 1760000000000, "monotonicMs": 1234.5, "cdpSeconds": 12345.678 },
  "kind": "http|ws|sse|marker", "phase": "request|redirect|response|data|finished|failed|extra-info|ws-created|ws-handshake|ws-send|ws-receive|ws-error|ws-closed|sse-message|mark|step-begin|step-end|evidence-link|control",
  "requestId": "1000.1", "parentRequestId": null,
  "targetId": "…", "cdpSessionId": null, "frameId": "…", "loaderId": "…", "navId": 1,
  "documentURL": "http://127.0.0.1:PORT/web-network.html", "url": "http://…/n/json?from=page&n=1",
  "method": "GET", "resourceType": "Fetch", "protocol": "http/1.1", "fromCache": false,
  "status": 200, "statusText": "OK", "mimeType": "application/json",
  "redirect": { "from": "http://…/n/redirect/1", "to": "http://…/n/redirect/2", "status": 302 },
  "initiator": { "type": "script", "url": "http://…/web-network.html", "line": 1, "column": 2,
    "requestId": null, "stack": [ { "functionName": "…", "url": "…", "line": 1, "column": 2 } ] },
  "timing": { "sendMs": 0.1, "waitMs": 2.3, "receiveMs": 0.4, "ttfbMs": 2.3, "totalMs": 2.8,
    "dnsMs": null, "connectMs": null, "sslMs": null },
  "sizes": { "requestBody": 0, "responseBody": 0, "requestHeaders": 0, "responseHeaders": 0,
    "encoded": 0, "decoded": 0 },
  "failed": false, "errorText": null, "blockedReason": null, "canceled": false,
  "ws": null, "sse": null, "mark": null,
  "correlationIds": [ { "name": "x-request-id", "value": "***" } ],
  "business": { "statusCode": 200, "businessCode": null, "businessCodePath": null },
  "stepId": null, "evidenceIds": [],
  "redaction": { "applied": ["url"], "body": "none" },
  "preSession": false
}
```

- `kind:"http"` 事件含 request/response/finished/failed/redirect/extra-info 阶段；`kind:"ws"` 只含连接与帧；`kind:"sse"` 每条消息一条；`kind:"marker"` 含 mark/step/evidence-link/control。
- **摘要事件**（`view:"summary"`）只取 §2.2 列出的字段；**完整事件**保留全部字段但 header/body 不内联（走 detail）。
- 事件入店时脱敏：`url`/`documentURL`/header 值/`correlationIds.value`/`business.objects.value`；原值不落库、不进 evidence、不进错误消息。`redaction.applied` 记录字段名。
- 不可变：事件入店后不改写（`response`/`finished` 是**新事件**，不是 patch 旧事件）；查询按 requestId 聚合最新状态。
- **内部请求键** = `(targetId, cdpSessionId, requestId)`：CDP `requestId` 只在单个 target/session 内唯一，重定向沿用同一 id。跨 target（OOPIF/worker）可能重复，事件实体一律用内部键关联，`detail` 对外的 `requestId` 仅在该 target 内解释；跨 target 同 id 需同时传 `seq`（或由会话内唯一 seq 定位）。

### 4.2 会话与存储

- 每个 Runtime 一个 `NetworkStore`（scope 隔离）。会话 `id` = `net-<8hex>`；保留最近 4 个会话（淘汰最旧会话的**事件数据**，保留摘要并标 `retained:false`）。
- 环形缓冲：`maxEvents`（默认 5000，上限 20000）、`maxBodyBytes`（默认 262144，上限 1 MiB）、`maxTotalBytes`（默认 8 MiB，上限 32 MiB）、`maxWsFrames`（默认 2000，上限 20000）。
- 候选缓冲晋升：无活动会话（含 `stop` 之后）期间，新事件进入固定 200 条候选缓冲（`preSession:true`）；下一次 `start` **会**把这些候选事件晋升进新会话（重新分配 seq、保留原时间），因此 restart 后 `counters.events` 可能非 0，`counters.preSession` 给出其中候选晋升数；要求计数器从 0 开始的调用方必须先 `reset`。C34 的断言按 `events === preSession` 或无候选时 0。
- 淘汰策略：超出 `maxEvents` 淘汰最旧事件并累计 `evicted`（不可用于 `detail`，查 → `NET_EVENT_NOT_FOUND`）；body 超出 `maxTotalBytes` 淘汰最旧 body 并累计 `bodyEvicted`（事件保留，body 标 `available:false`）。**未启动会话的候选缓冲固定 200 条**，不计入正式配额。
- 背压：`dropped` 只统计入店阶段被拒（配额/订阅 pin/held/规则匹配表满）；`evicted/bodyEvicted/truncated` 独立统计。四者相加不等于事件总数，契约不要求守恒，但必须可解释。
- `maxEvents` 淘汰不阻塞采集；订阅 pin 见 §8.7。
- 候选缓冲与会话数据在 `runtime.close()`/`dispose()` 时清空；导出的磁盘证据不删（除非 `evidence.clear deleteFiles:true`）。

### 4.3 完整性（G6.8）

`integrity = {complete, dropped, evicted, truncated, bodyEvicted, gaps:[], issues:[]}`：

- `complete` 仅当 `dropped=0 && evicted=0 && truncated=0 && bodyEvicted=0 && gaps 为空 && 无 `import-partial`/`cdp-disconnected` issue`。
- `gaps` 只在**外部导入**或**订阅 pin 溢出**时出现（内部 seq 恒连续，缺号只可能来自淘汰，已由 `evicted` 表达）。
- `issues` 枚举：`events-evicted`、`events-dropped`、`bodies-evicted`、`bodies-truncated`、`body-unavailable`、`subscriber-overflow`、`held-overflow`、`cdp-disconnected`、`import-partial`、`capture-disabled:websocket` 等。
- 每个工具证据块都带 `integrity`；验收断言「有丢时必须 complete:false 且 issue 可解释」，禁止 `complete:true` + 丢数。

## 5. 分析能力

### 5.1 参数解析（G3.1）

- URL：`queryString` 解析为 `[{name,value}]`，重复键保序；`url` 保留脱敏后的完整串。
- 请求体：按 `content-type` 分派 JSON / `application/x-www-form-urlencoded` / `multipart/form-data`（只解析字段名与大小，文件内容不入库）/ 文本；`postData` 标记 `kind` 与 `parseError`（不抛错）。
- 响应体：JSON / 文本 / 二进制；解析失败标 `parseError`，不阻断。
- 头：最多 64 条，单值 ≤1024 字节，超出截断并计数。

### 5.2 状态码与业务状态码（G3.2）

- HTTP status 原值 + `statusClass`（`1xx–5xx`）。
- 业务状态码：默认在 JSON 响应体按 `["code","status","errno","bizCode","error.code"]` 顺序查找**数值**（不存在则 null）；`trace.businessStatusPath` 或 `session.config.businessStatusPath` 可覆盖。业务码写入事件 `business.businessCode` 与 `detail.business`。**不猜测**字符串映射，不给业务语义（成功/失败由调用方判断）。

### 5.3 耗时与性能统计（G3.3）

- 单请求：`ttfbMs = response.timing.wait`（CDP 秒→ms）；`totalMs = loadingFinished - requestWillBeSent`（CDP 单调）；`dns/connect/ssl/send/wait/receive` 各段。缺项 null。
- 聚合（`events view:"aggregate"`）：`count/bytes/durationMs{min,max,avg,p50,p95}/failures/statuses`；p50/p95 用有序数组线性插值（样本 <2 时等于 max）；分组上限 100，超出 `truncated:true`。
- 统计只基于**已入库事件**；`integrity.complete=false` 时结果标注 `incomplete:true`（不假装完整）。

### 5.4 错误与异常（G3.4）

自动识别并写入 `analysis`（detail/aggregate 可见）：`loading-failed`（`errorText/blockedReason`）、`http-error`（4xx/5xx）、`timeout`（`Failed to fetch`/`net::ERR_TIMED_OUT`）、`cors`（`ERR_FAILED` + 无响应 + `Access-Control` 缺失无法单凭事件判定 → 只在 `errorText` 含 `CORS` 时标 `cors-suspect`，不冒充确定）、`aborted`（`canceled:true`）、`retry-storm`（§5.5）。`analysis` 只基于可观测事实，`confidence:"observed"`。

### 5.5 重试/重复识别（G3.5）

- 重复键：`method + sanitizedUrl(去 query 顺序? 保留原串) + bodyHash`（body hash 用脱敏前 body 的 sha256 前 16 位，仅内存）。
- `retry`：同一键在 `retryWindowMs=10000` 内 ≥2 次且前次 failed 或 5xx；`duplicate`：同键同窗口成功重复；`polling`：同键间隔近似（±30% 或固定）连续 ≥3 次且间隔 ≤ pollWindowMs=5000（见 §6.6）。
- 标记为 `analysis.pattern:"retry|duplicate|polling"` + `groupKey`；不做自动重发。

### 5.6 跨请求关联标识（G3.6）

- 默认规则（`correlationRules` 可覆盖/追加）：头 `traceparent`（取 trace-id 段）、`x-request-id`、`x-trace-id`、`request-id`、`x-correlation-id`；URL query 同名键；JSON body 的 `traceId`/`requestId`。
- 值为脱敏后的稳定摘要？**关系需要原值**：关联标识保留原值会泄密。折中：存 `valueHash`（sha256 前 12 位）+ 脱敏显示值；同 `valueHash` 即同一链路。导出/HAR 不含原值。测试用固定 token 验证 hash 关联与脱敏显示。

### 5.7 筛选/检索/聚合（G3.7）

- 见 §2.2 `filter/search/groupBy/aggregate`；全部在内存索引上执行（URL 索引、状态索引、时间索引、stepId 索引）；不扫磁盘。
- 检索 `text` 命中 URL（含 query 脱敏后）、body（脱敏后预览）、header 名、ws/sse payload 预览；返回 `match:{field,preview≤120}`。

### 5.8 依赖关系（G3.8）

- 边：`initiator.requestId`（父请求 → 子请求，`relation:"initiator"`）、redirect 链（`relation:"redirect"`）、同 URL 重复（`relation:"same-url"`）、步骤窗口内时间相邻（`relation:"temporal"`，仅 detail 可选展示，不参与因果）。
- `detail.dependencies` 返回直接父/子（上限 50）；不递归展开，避免图爆炸。

## 6. 业务链路

### 6.1 步骤（G4.1/G4.5）

- `trace.begin-step {name,labels,window?}` → `step-N`；窗口 `{fromWallMs,toWallMs|null}`。
- `end-step` 关窗；`window` 查询所有窗口；`query` 汇总。
- 窗口内事件在查询期按 `ts.wallMs` 归入（`basis:"temporal"`）；跨窗口事件归最早匹配窗口；窗口可重叠（步骤可嵌套），每步独立统计。
- 步骤上限 200（`NET_QUOTA_EXCEEDED`），关闭步骤可被新步骤复用 id？不——id 单调生成，不接受外部指定重复。

### 6.2 业务对象（G4.2/G4.3）

- 只按显式 `objectRules` 提取，来源 `url-query|url-path|header|json-body|ws|sse`。
- `propagate:true`：对象值（比较脱敏前值，内存内）在后续请求的 URL/header/body 中出现 → 记录 `propagation:{fromSeq,toSeq,where:"url|header|body"}`；未出现不报。
- 跨请求关联：相同 `correlationId` hash 的事件分组；`detail.correlation` 返回该请求的 id 列表与同组请求数。
- 不猜测语义（订单号/用户号由调用方命名）。

### 6.3 业务状态变化（G4.4）

- `states`：同一步骤/对象的事件序列中，`business.businessCode` 或 HTTP status 变化时记录 `{atWallMs,seq,from,to,field,basis:"observed"}`；不改写事件。
- 只记录**观察到的变化**；无变化不产生记录。

### 6.4 异步与轮询（G4.6）

- `polling` 通过 §5.5 识别；`async`：步骤 `end-step` 之后仍出现的同键请求 → `afterStep:true` 并在步骤 `counters` 标 `asyncAfterClose`。
- `trace.query` 返回 `polling:[{groupKey,count,intervalMs,firstSeq,lastSeq}]` 与 `async:[{seq,stepId,delayMs}]`。

### 6.5 因果元数据（G4.7）

- `causality:[{seq,parentSeq,basis:"explicit|redirect|initiator|temporal"}]`；`explicit` 来自 `trace.link`，`redirect/initiator` 来自 CDP，`temporal` 只在明确请求时（`includeTemporal:true`，默认 false）返回。**不得**把 temporal 写成因果。

### 6.6 证据关联（G4.8）

- `trace.link {seq,evidenceId}`、`evidence.link {seq,evidenceId}`、截图 `networkWindow`、T2 动作 envelope 的 `actionId` 都进入链接索引；`trace.query`/`detail` 返回 `evidenceIds`。
- 证据 ID 不透明字符串（≤128），不校验存在性（由调用方保证），但记录 `linkedAt`。

## 7. 控制能力

### 7.1 启停（G5.1）

见 §2.1：`session.start/stop/reset/status`；`control.reset` 只恢复网络条件与规则，不停会话。

### 7.2 按需详情（G5.2）

见 §2.3：详情按需读 body；body 读不到不伪造；`include` 控制读多少（默认不读 body，避免隐式大 IO）。

### 7.3 拦截与修改（G5.3/G5.4）

- 规则见 §2.5；实现基于 `Fetch` 域，`Fetch.enable` 单配置合并既有 Document 守卫；`requestPaused` 分流顺序：① popup/导航守卫（既有语义，优先级最高）→ ② 活动规则（按添加顺序）→ ③ 默认 continue。
- `modify-request` 只改请求（url/headers/postData）；`fulfill` 直接返回响应（P0 的**响应修改正例**：替换响应状态/头/体，覆盖 G5.4）。`behavior.kind:"modify-response"` 是**可选能力**：只有本机 Chrome 实测 `Fetch.continueResponse` 可用且能改响应头/状态时才声明；不支持则能力报告 `limits.network.responseModification=false`，C37 的该子项记 NOT_RUN/unsupported，**不得用实现自报代替实测**。P0 验收必过子项是 `modify-request` + `fulfill`。
- 规则命中计数、`paused` 状态、`held` 列表进 `intercept-list`；页面关闭/`stop` 时自动恢复并清空 held（先 continue 避免挂死）。

### 7.4 延迟/带宽（G5.5）

`throttle` 见 §2.5；`Network.emulateNetworkConditions` 作用当前 page（子目标共享）；能力报告 `limits.network.throttle=true`。恢复值 `offline:false,latency:0,downloadThroughput:-1,uploadThroughput:-1`。

### 7.5 断连/故障注入（G5.6）

`offline:true/false`；`behavior.kind:"fail"` 可按规则让指定请求失败；`block` 按规则阻断。失败事件照常采集（`failed:true` + `errorText`），页面表现由浏览器决定，不做断言承诺。

### 7.6 重放/Mock（G5.7）

- `replay`：`via:"page"` 页面内 `fetch`（同源 Cookie；跨域按 CORS 规则）；`via:"http"` Host 独立客户端（无 Cookie，目标校验复用 `browser_http_request` 的 DNS/私网规则）；重放请求带 `mark{kind:"replay",fromSeq}`。
- `mock`：一次性 `fulfill` 规则（来源参数或已存条目），不修改原请求；`fromRequestId` 需同 scope 已存响应。
- 重放/Mock 产生的流量**照常采集**（G5.7 与 G1 不冲突）；不递归重放（重放事件标记 `mark.kind:"replay"`，不含在重放选择中）。

## 8. 证据、安全与隔离

### 8.1 持久化与 JSONL（G6.1/G6.2）

- 根：`DSH_UI_TESTING_CAPTURE_DIR` 优先，否则调用方工作区 `cwd`（持久）。**证据导出不写暂存**：无可用持久根（env 非法且 cwd 不可用）→ `NET_OUTPUT_ROOT_UNKNOWN`，不退避、不写临时目录。目录：`<root>/output/network/<scopeHash>/`。
- 文件：`<name>-<sessionId>-<timestamp>.<jsonl|har>`；0600、原子写、no-clobber；返回 `file:{pathKind:"persist",persistence:"root",relativePath,bytes,format,events,integrity}`，**只回相对路径，绝不回绝对路径**。`out` 必须是持久根内相对路径；绝对路径/`..`/越界符号链接 → `NET_OUTPUT_PATH_INVALID`。
- JSONL：**每行一条标准化事件**（不套 `type` 外壳）。`seq:0` 保留给会话元数据 marker：`{seq:0,kind:"marker",phase:"session-meta",session:{...},config:{...},limits:{...},createdAt:…}`；证据链接为 `{kind:"marker",phase:"evidence-link",...}`。导入：必须存在 seq 0 的 session-meta marker 且 `version=1`；坏行累计 `skippedLines` 并保留 seq 空洞（`gaps`）；重复 seq 保留首条并计 `duplicates`；**不重排编号**，缺失即 `complete:false`。
- `includeBodies` 默认 false；true 时 body 以 `body:{encoding,data}` 内联，受 `maxBodyBytes` 与 `maxTotalBytes`。

### 8.2 HAR 1.2 子集（G6.2）

导出/导入字段（缺省可空，不伪造）：

```text
log.version="1.2", log.creator{name,version}, log.pages[{startedDateTime,id,title,pageTimings}]
log.entries[{pageref,startedDateTime,time,
  request{method,url,httpVersion,headers[],queryString[],cookies[],headersSize,bodySize,postData?{mimeType,text}},
  response{status,statusText,httpVersion,headers[],cookies[],content{size,mimeType,text?,encoding?},redirectURL,headersSize,bodySize},
  cache{},timings{blocked,dns,connect,send,wait,receive,ssl}, serverIPAddress?, connection?}]
```

- **扩展字段**（非标准，可选）：WS 条目可带 `_webSocketMessages:[{type:"send|receive",time,opcode,data}]`；SSE 条目可带 `_eventSourceMessages:[{eventName,eventId,data,time}]`；条目可带 `_dsh:{seq,phase,kind,targetId,frameId,stepId}`。导入忽略未知字段；**JSONL 是保真格式**，HAR 往返只保证 HTTP 条目字段（WS/SSE 需扩展字段才保真，缺失即不承诺）。
- 导入：先尝试 HAR（有 `log.entries` 数组），否则 JSONL；两者都不合法 → `NET_HAR_INVALID`/`NET_IMPORT_FAILED`。导入不校验 `timings` 全字段；缺失记为 null。
- 导出再导入必须事件数/URL/状态/重定向链一致（验收 C 项断言）；C42 的 HAR 往返只对 HTTP 条目断言，WS/SSE 保真由 JSONL 断言。

### 8.3 索引与检索（G6.3）

`evidence.index/search/list` 见 §2.6；索引在内存 + 导出文件元数据（不解析大文件内容）；检索返回摘要与文件相对路径。

### 8.4 脱敏（G6.5）

- URL：`browser-safety.redactUrl`（敏感 query 键、userinfo、hash）。
- 头：敏感键值完全替换 `***`；`set-cookie` 只保留属性名（值 `***`）。
- body：`application/json` 按字段名 `/(token|secret|password|passwd|authorization|cookie|api[-_]?key|session|credential)/i` 替换值为 `"***"`；urlencoded 同规则；multipart 只保留字段名与大小；二进制不解析、标 `bodyRedaction:"none"`。
- 关联标识：存 hash + 脱敏显示值（§5.6）。
- WS/SSE 负载：文本按 JSON/urlencoded 规则脱敏；二进制 base64 不解析。
- 脱敏在**入店时**执行，导出/检索/错误一律用已脱敏数据；`redaction.applied` 列出字段名（不含原值）。允许调用方 `config.maskRules` 追加（后缀匹配键名，≤16 条）——**不允许**关闭默认规则。

### 8.5 权限与会话隔离（G6.6）

- 采集数据属于 scope；跨 scope 的 `sessionId`/`requestId`/文件路径一律返回**不泄漏存在性**的 `NET_SESSION_NOT_FOUND`/`NET_EVENT_NOT_FOUND`/`NET_OUTPUT_PATH_INVALID`（R1 裁决：不使用 `NET_SCOPE_FORBIDDEN` 区分“别处存在”，避免侧信道；该码保留给显式 scope 身份不匹配的非 id 路径，默认不可达）。
- 会话变更（start/stop/reset）与 `control` 走 owner lease：其他会话持有会话时 `BUSY`。
- 只读查询（events/detail/trace/evidence/subscribe）不占租约，但只能读**本 scope**；同一 scope 内多 agent 共享采集（G6.9），订阅按 agent 隔离（他人订阅不可 poll/ack/close）。
- 证据文件路径必须落在本 scope 持久根内（`..`、绝对路径、符号链接越界 → `OUTPUT_PATH_INVALID`）。

### 8.6 证据块

每个工具返回/抛错带：

```jsonc
"evidence": { "version": 1, "operation": "events", "sessionId": "net-…",
  "fromSeq": 1, "toSeq": 12, "counters": { "events": 12 }, 
  "integrity": { "complete": true, "dropped": 0, "evicted": 0, "truncated": 0 },
  "redaction": { "applied": ["url","authorization"], "body": "fields" },
  "truncated": false, "incomplete": [] }
```

`ok:true` 不等于 `complete:true`；`complete` 只在无丢/无截断时为 true。

### 8.7 配额与背压（G6.7）/ 多订阅（G6.9）

见 §4.2/§2.7：maxEvents/maxBodyBytes/maxTotalBytes/maxWsFrames；订阅 pin 1000、订阅数 16、poll/ack 上限 200；held 64；规则 32；步骤 200；导入 64 MiB。超限 `NET_QUOTA_EXCEEDED` 或如实计数（订阅/held）。**任何限额都必须在 capabilities/limits 中公开**。

### 8.8 能力报告

`browser_capabilities` 增：

```jsonc
{ "network": { "version": 1, "tools": ["browser_network_session", ...7],
    "session": { "id": "net-…", "state": "running", "counters": {...}, "integrity": {...} },
    "limits": { "maxEvents": 20000, "maxBodyBytes": 1048576, "maxTotalBytes": 33554432,
      "maxWsFrames": 20000, "subscriptionMax": 16, "subscriptionPin": 1000,
      "eventPageLimit": 200, "holdTimeoutMs": 30000,
      "network": { "capture": true, "bodies": true, "websocket": true, "sse": true,
        "workers": true, "interception": true, "responseModification": true|false,
        "throttle": true, "offline": true, "replay": true, "mock": true,
        "har": true, "jsonl": true, "subscriptions": true } },
    "observed": { "lastCallAt": 1760000000000, "lastOperation": "events" } } }
```

- 每项 `web.network.session/events/detail/trace/control/evidence/subscribe` 与聚合 `web.network.p0` 报 `available|unavailable|unsupported`；其他会话持有租约时 `control`/`session` 变更报 `unavailable(BUSY)`，只读仍 `available`；会话未启动时 `session.start` `available`（懒启动，constraint 说明可能失败）。
- 诊断调用不启动浏览器、不建目录、不生成证据文件；`observed` 只来自真实调用。

## 9. 靶机（`tests/ui_test_fixture`）

路由/真值以 [tests/ui_test_fixture/README.md §NET](../tests/ui_test_fixture/README.md) 为逐字真值表（含 21 条 `/n/*` 路由、`window.__net` 结构、10 条易误断言）。契约层冻结以下名字（不得改名）：

- HTTP：`/n/json`、`/n/echo`（POST/PUT：JSON、urlencoded、multipart、text）、`/n/status/404`、`/n/status/500`、`/n/slow?ms=`、`/n/redirect/1`→`/n/redirect/2`→`/n/final`、`/n/gzip`、`/n/chunked`、`/n/large?bytes=`、`/n/poll?n=`、`/n/flaky?key=`（首 503 后 200、`reset=1` 清态）、`/n/token?token=`、`/n/cors`、`/n/worker.js`、`/n/worker-data`、`/n/iframe.html`、`/n/iframe-data`。
- 长连接：`/n/sse`（3 条固定事件后关闭，客户端必报 1 次 error）、`/n/ws`（upgrade；echo 文本帧 + open 后 10ms 推 `server-push-1`）。
- 页面：`/web-network.html`（18 个固定 id 按钮 + `window.__net`）、`/web-network-frame.html`（`window.__netFrame`）。
- 真值注意：`/n/large` 总字节 = `bytes+10`；`/n/echo` 的 multipart boundary 不可逐字断言；gzip 页面侧自动解压；`#net-500` 的 fetch 正常 resolve；WS `received[0]` 是 `server-push-1`；轮询 `seq` 会被其他点击插入。

## 10. 验收条件（C1–C52）

验收套件 `tests/acceptance/network-p0.mjs`；每条 criterion 至少 3 个 required 检查（`B` = 真实插件 + 真实 Chromium；`U` = 纯算法/FS 单元，合并在 `tests/network-p0.test.mjs`）。报告必须逐条给出 `criteria` 号、required/failed/notRun。**不得用实现自报 `ok:true` 代替页面/CDP 真值**（真值来自 `window.__net`、fixture 响应、导出的 JSONL/HAR 与 CDP 事件）。

| 编号 | 需求 | 验收要点（B/U） |
| --- | --- | --- |
| C1 | G1.1 HTTP/HTTPS 捕获 | B：`/n/json`、`/n/slow`、`/n/status/404`、重定向、POST 各自产生 request/response/finished 或 failed 事件；url/method/status/resourceType 与页面真值一致。**HTTPS 子项记 NOT_RUN**（无本地 TLS 靶机、Chromium 未配置自定义 CA），能力报告 `https:"mechanism-identical"`，不得写已验（见 R1-18）。 |
| C2 | G1.2 内容捕获 | B：请求体（JSON/form）与响应体（JSON/text/gzip 解压后）内容可读；二进制 base64；未捕获时 `NET_BODY_UNAVAILABLE` 不伪造；配额截断计数 |
| C3 | G1.3 WebSocket | B：`/n/ws` 握手、`server-push-1`、echo 双向帧、关闭；方向/opcode/payload 正确；帧上限计数 |
| C4 | G1.4 SSE | B：`/n/sse` 3 条消息（eventName/eventId/data）；关流后 EventSource error 不崩；每条一条 sse 事件 |
| C5 | G1.5 iframe/OOPIF/Worker（partial） | B：same-origin iframe + dedicated worker 必测；OOPIF 尝试（无独立 target 则 NOT_RUN）；shared/service worker 按 R1-21 记 NOT_RUN + 原因；targetId/frameId 可区分；popup 仍被阻断；能力 partial（R1-18/R1-21） |
| C6 | G1.6 会话管理 | B：start 幂等/changed:false、stop 幂等、status 不启动浏览器、start 不同名冲突、reset 清空、连续采集 seq 单调 |
| C7 | G1.7 生命周期 | B：request→response→finished 顺序与终态；loadingFailed 只 failed；redirect 链事件顺序；无重复 finished |
| C8 | G1.8 重定向链 | B：`/n/redirect/1→2→final` 的 redirect 事件 from/to/status 与最终 URL；`hops` 可按 hopId 分别 detail；链长 ≤20；无循环（R1-10） |
| C9 | G1.9 发起源 | B：initiator.type=script/fetch、url 指向页面、requestId 父链（页面 fetch 的父请求）；栈 ≤10 |
| C10 | G2.1 标准化 | U：schema 字段/类型/枚举/ts 三时间、summary/full 投影；B：事件入店后脱敏且不可变 |
| C11 | G2.2 统一时间轴 | B：http/ws/sse/marker 混排按 monotonicMs 升序；desc 只影响顺序；fromSeq/toSeq 准确 |
| C12 | G2.3 时间戳/耗时 | B：ttfb/total 与 `/n/slow` 实测延迟一致（容差）；timing 缺失为 null；wall 按 target 锚点推算、monotonic 同存（R1-11） |
| C13 | G2.4 并发/时序关联 | B：`#net-parallel` 3 并发事件重叠窗口、seq 顺序与完成顺序；聚合统计正确；无伪因果 |
| C14 | G2.5 GUI↔网络 | B：`browser_click #net-fetch-json` 的 actionId mark 与新增事件时间关联；T2 evidence.networkDelta 仍存在且新增事件可见；basis=temporal |
| C15 | G2.6 页面状态↔网络 | B：navigate/reload 后 documentURL/navId/loaderId 变化；state mark 出现；事件归属正确 |
| C16 | G2.7 截图↔网络 | B：`browser_screenshot` 证据含 networkWindow（frameTimeMs/captureEndMs/fromSeq/toSeq/nearest），窗口用 highWater 不纳入调用后新事件，nearest 可为 null；原 capture 字段不变（R1-16） |
| C17 | G2.8 请求↔步骤 | B：begin/end-step 窗口内事件按 wallMs 归入；跨窗口归最早匹配；不写回事件 |
| C18 | G3.1 参数解析 | U：query 重复键/JSON/form/multipart/text/parseError；B：/n/echo 各形态与 header 上限 |
| C19 | G3.2 状态码 | B/U：HTTP status+statusClass；业务码默认路径与显式 path；无业务码为 null；不猜语义 |
| C20 | G3.3 性能统计 | B/U：aggregate count/bytes/min/max/avg/p50/p95/failures；样本<2 时 p95=max；incomplete 传播 |
| C21 | G3.4 错误/异常 | B：/n/status/500、offline、fail 规则、blocked、canceled、timeout 识别；cors 仅 suspect |
| C22 | G3.5 重试/重复 | B：`#net-flaky` 首 503 后 200 标 retry；连续同请求标 duplicate；轮询键忽略 volatile query（R1-17）；窗口/阈值边界 |
| C23 | G3.6 关联标识 | B/U：traceparent/x-request-id/body traceId 提取为 hash；同链路分组；导出不含原值 |
| C24 | G3.7 筛选/检索/聚合 | B/U：method/status/statusClass/type/urlIncludes/failed/kind/step/时间/耗时过滤；search 命中与脱敏预览；groupBy/aggregate 上限 |
| C25 | G3.8 依赖关系 | B/U：initiator 父子、redirect 链、same-url；detail 只回直接边；不做 temporal 因果 |
| C26 | G4.1 跨步骤记录 | B：两步窗口内事件分别统计；窗口重叠不重复计数；步骤上限 |
| C27 | G4.2 对象提取/传递 | U/B：url-query/url-path/header/json-body/ws/sse 规则；propagate 在后续 URL/header/body 命中；无命中不报 |
| C28 | G4.3 跨请求关联 | B/U：同 correlation hash 的请求分组；detail.correlation 同组数；不跨 scope |
| C29 | G4.4 业务状态变化 | U/B：businessCode/HTTP status 变化产生 states；无变化不产生；basis=observed |
| C30 | G4.5 窗口管理 | U：begin 默认 now、end 默认 now、显式 window、重复 begin/end、window 查询、重叠窗口归属 |
| C31 | G4.6 异步/轮询 | B：`#net-poll-start` 3 次识别 polling 间隔（method+path+bodyHash 键）；end-step 后请求标 asyncAfterClose；不自动停页面定时器 |
| C32 | G4.7 因果元数据 | U/B：explicit link、redirect、initiator 三种 basis；temporal 默认不返回；不得写错 basis |
| C33 | G4.8 证据关联 | B/U：link seq↔evidenceId 幂等；trace.query/detail 返回 evidenceIds；截图/T2 actionId 关联 |
| C34 | G5.1 启停控制 | B：start→请求→stop→再请求（后续不入会话，候选缓冲或新会话）；reset 后 counters 归零；stop 不关页面 |
| C35 | G5.2 按需详情 | B：默认不读 body；include body 读取；已捕获/未捕获/已淘汰三态；不伪造 |
| C36 | G5.3 拦截 | B：block 规则使请求 failed(BlockedByClient)；fail 规则 errorText；命中计数；Document 导航守卫仍生效 |
| C37 | G5.4 请求/响应修改 | B：modify-request 改 header/url 被服务端回显；fulfill 返回给定状态/体；modify-response 仅实测支持才断言，否则 NOT_RUN（R1-7/R1-18） |
| C38 | G5.5 延迟/带宽 | B：throttle latency 使 /n/json 耗时显著增加；Kbps 影响大 body 传输；reset 恢复 |
| C39 | G5.6 断连/故障 | B：offline 时请求失败事件；恢复后成功；异常不杀 page |
| C40 | G5.7 重放/Mock | B：replay via page 由服务端命中计数 + 新 CDP 请求双证；via http 不带 Cookie；mock 返回指定响应且原记录不变（R1-17） |
| C41 | G6.1 缓存/持久化 | B/U：JSONL 落盘 0600/无覆盖/原子；会话 config/meta 完整；暂存 vs 持久路径规则；异常根不回退 |
| C42 | G6.2 HAR/JSONL | U/B：JSONL 保真往返（含 seq 空洞）；HAR 1.2 必填字段与 -1 约定、HAR 往返只断言 HTTP 条目；includeBodies；坏行/坏 HAR 错误码（R1-3/R1-14） |
| C43 | G6.3 证据索引/检索 | B/U：index/list/search 文件与内存证据；路径越界拒绝；deleteFiles 只删本 scope |
| C44 | G6.4 截图证据关联 | B：截图 networkWindow 与 evidence.link 双向；detail.evidenceIds；无证据为 [] |
| C45 | G6.5 脱敏 | B/U：URL token/authorization/x-net-token/set-cookie/body 字段/WS/SSE 全程 `***`；导出/检索/错误无原值；maskRules 追加不关闭默认 |
| C46 | G6.6 权限/会话隔离 | B：两个 workspace scope 各自会话互不可见；跨 scope sessionId/requestId → 不泄漏存在性的 NOT_FOUND（R1 裁决，不用 SCOPE_FORBIDDEN 区分）；offline 会话不可 control |
| C47 | G6.7 配额/背压 | U/B：maxEvents 淘汰计数、maxBodyBytes 截断、maxTotalBytes 淘汰 body、subscription/held/规则/步骤超限错误；不静默 |
| C48 | G6.8 完整性 | U/B：complete 条件、gaps/issue 枚举、cdp-disconnected、导入 partial、订阅 overflow；无“complete:true+丢数” |
| C49 | G6.9 多 Agent 订阅 | B：同 scope 两 agent 独立 create/poll/ack；A ack 前进不影响 B；B poll 不重复；跨 agent poll FORBIDDEN；pin/gap 计数 |
| C50 | 技术不变量：工具面/能力 | B：注册表 29 工具、7 个新工具 schema/required、capabilities.network 段与 7 项 web.network.*、诊断不启动、旧 22 工具行为不变 |
| C51 | 技术不变量：安全/隔离 | B/U：默认脱敏、路径限制、owner-only 订阅、控制需租约/只读不占、无绝对路径泄漏、无跨 scope 泄漏、新工具失败为 NET_*（平台码例外按 R1-5 注明） |
| C52 | 技术不变量：非回归 | B：T1 `run.mjs` 22 组不回归、T2 `t2-structured.mjs` 不回归、T3 `t3-vision.mjs` 不回归、capture-p0 不回归、`node --check`/`git diff --check` 通过 |

## 11. 切片、写入范围与依赖

| 切片 | 交付 | 写入范围 | 负责人 | 依赖 |
| --- | --- | --- | --- | --- |
| NET-CONTRACT | 本文 | `docs/network-p0.md` | advisor/Lead | — |
| NET-CORE | `network-p0.js`、`index.js`、`browser-safety.js`、`package.json` | 同左 | executor-core | 本文 §2/§4 |
| NET-FIXTURES | `/n/*` 路由、`web-network*.html`、真值表 | `tests/ui_test_fixture/**` | executor | — |
| NET-ACCEPT | 验收 C1–C52、单测、harness/run/milestone 工具面 29 | `tests/**`（除 fixture） | executor-accept | CORE/FIXTURES |
| NET-DOCS | 状态/架构/README/Skill/manifest | `docs/**`（本文除外）、`README*`、`skills/**` | executor-docs | CORE/ACCEPT |
| NET-VERIFY | Lead 独立串行复跑 + 证据记录 | `docs/status.md` 验收段、`tests/acceptance/evidence/**` | Lead | 全部 |

参考仓库映射（只借鉴模型/算法，不引入代码依赖）：

- **playwright** `server/har/harTracer.ts`/`server/network.ts`：HAR entry 构造、`timings`、redirect 与 request 生命周期状态；`Route`/interception 模型 → §2.5 规则形状。
- **devtools-frontend** `panels/network/`（`NetworkLogView`/`NetworkDataGridNode`/`EventSourceMessagesView`/HAR writer）：筛选/分组/时间轴视图、SSE 消息视图、HAR 1.2 导出字段。
- **mitmproxy** `flow.py`/`addons/`/`websocket.py`：统一 flow 模型、拦截/改写决策、WS 双向消息、filter 表达式 → §4 事件模型与 §2.5 控制。
- **jaeger** span/trace 模型：步骤/因果/父子关系 → §6.5（只借鉴关系类型，不引入 OpenTracing API）。
- **opentelemetry-js** context propagation：`traceparent` 关联 → §5.6。
- **bruno** request collections/replay/mock：重放与 Mock 的参数形状 → §2.5。
- 仓库既有：`capture-p0.md`（持久化/原子写/错误口径）、`t2-structured-gui.md §5`（evidence.version=1）、`workspace-isolation.md`（scope 隔离）。

## 12. 限额、安全与非目标汇总

- 数值限额见 §2.1/§4.2/§8.7（上限与默认值必须同时在 capabilities.limits 公开）。
- 安全：不装 CA/不做 MITM；不读任意文件；不导出 Cookie 原值；不把敏感值写日志/错误/证据；路径越界拒绝；跨 scope 拒绝；订阅 owner-only。
- 运行环境：真实 headless Chromium；无 Chromium → 采集工具 `CDP_*`/`NET_CONTROL_UNAVAILABLE`，只读工具仍可用（空/已存证据）。
- 未验证/不承诺：popup 采集、跨 scope 聚合、T4 动态视觉、真实网络限速精度、HAR 全字段、`modify-response` 在 CDP 不支持时的行为（如实报 unsupported/NOT_RUN）。
- 生效方式：新增 `network-p0.js` 与 `index.js`/`browser-safety.js`/`package.json` 变更需**重启 DSH**；`client.js` 未动，无需前端热更新。真实宿主复验属 Lead 最终验收，进程内套件通过不等于真实宿主已验。
## 13. 顾问 review 裁决（R1，2026-11-01，Lead）

本节是 §1–§12 的**补充裁决**，与正文同等权威；冲突处以本节为准，实现/验收必须按此对齐。未列入的 review 项视为记录性建议，不强制。

- **R1-1 事件身份与字段**：事件里的 `sessionId` 是采集会话 ID（与工具参数同名），CDP 子会话是 `cdpSessionId`（主 page 为 null）。`timing` 字段单位为毫秒：`sendMs/waitMs/receiveMs/ttfbMs/totalMs/dnsMs/connectMs/sslMs`，另附 `requestTimeMs/responseTimeMs`（CDP 原始秒×1000，用于精确重算）。`failed` 是 summary 布尔；full/detail 另带 `failure:{errorText,errorCode,blockedReason,canceled}`。`stepIds` 是显式链接数组（可多个），`stepId` 是查询期按窗口派生的单个归属；两者语义不同、可并存。`redaction:{applied:[字段名],rules:[规则名],body:"fields|none|omitted"}`。
- **R1-2 订阅有界保证**：`subscriptionPin` 是**硬上限**；已投递未 ack 的事件不会被淘汰至 pin 上限之外；超出时该订阅得到 `gap/dropped` 计数（绝不静默）。契约的「ack 前不丢」限定在 pin 预算内；采集不为单个落后订阅停摆。`poll` 的 `cursor/afterSeq` **不得低于当前已投递水位**（回退 → `NET_RULE_INVALID`，防重复投递）；`ack` 只能确认已交付边界（`ackSeq > deliveredSeq` → `NET_RULE_INVALID`）。`session.reset` 会关闭本 scope 全部订阅并在返回里报 `subscriptionsClosed`，不得静默删他人 pin。
- **R1-3 JSONL 保真**：每行都是标准化事件（§8.1），meta/链接用 marker 事件表达，不套 `type` 外壳；导入保留 seq 空洞并置 `complete:false`，不重排序。
- **R1-4 文件路径**：证据导出只回相对路径；无持久根 → `NET_OUTPUT_ROOT_UNKNOWN`；不允许暂存目录导出、不允许绝对路径入参、不允许 `..`/越界符号链接。
- **R1-5 新工具错误口径**：新 7 工具的参数/状态/配额/证据/导入导出错误一律 `NET_*`（新增 `NET_INVALID_ARGUMENT`、`NET_OUTPUT_ROOT_UNKNOWN`、`NET_OUTPUT_PATH_INVALID`、`NET_OUTPUT_WRITE_FAILED`）。平台级既有码仅在下列情形透传并在 evidence 注明：`BUSY`（owner 冲突，保持 capabilities 一致的 reason）、`ABORTED`（调用方取消）、`CDP_*`（浏览器/CDP 断连/超时）、`RUNTIME_LIMIT`。旧 22 工具保持原码。
- **R1-6 子目标附加**：`Target.setAutoAttach.filter` 用对象数组 `[{type:"worker",exclude:false},{type:"shared_worker",exclude:false},{type:"service_worker",exclude:false},{type:"iframe",exclude:false}]` + 排除兜底，禁止字符串列表。顺序固定：**先装 listener → 再 `Network.enable` → 再 `Runtime.runIfWaitingForDebugger`**；对子会话递归 `setAutoAttach`（嵌套 worker）。初始化失败/取消必须 `runIfWaitingForDebugger` + `detachFromTarget`（或关闭页面）避免 worker 冻结。shared/service worker 的最终口径以 **R1-21** 为准（本 build 不采集，见下）；归属不明一律拒采并计 `incomplete`/coverage partial，不得按 URL 猜。
- **R1-7 响应修改**：见 §2.5 修订——P0 以 `modify-request` + `fulfill` 为正例；`modify-response` 只在 Chrome 152 实测 `Fetch.continueResponse` 可改响应头/状态时声明，能力报告 `limits.network.responseModification` 如实；C37 子项不支持则 NOT_RUN。
- **R1-8 Fetch 分派**：Document 守卫与用户规则共用单一 dispatcher，每个 paused 请求恰好一个终结（continue/fail/fulfill），禁止守卫 continue 后规则再 continue。`modify-request` 改 URL 后必须重新做目标/DNS/导航安全校验（复用 `validateTarget`）。`fulfill` 必须剥离 hop-by-hop 头、重算/移除 `content-length`、对给定已解码 body 去掉 `content-encoding`。`stop`/`reset`/页面关闭/abort 必须把 held 请求逐一终结并释放，且**不 `Fetch.disable`**。
- **R1-9 内容与哈希**：二进制 body/WS/SSE 默认不内联（`payloadOmitted:true`，`available:true` 元数据可读）；文本按 §8.4 脱敏；无法安全解析的文本同样 omitted。关联标识用**每会话随机 HMAC-SHA256 的 12 hex**（公开 `valueHash`，另存内部 `contentHash` 区分）；重复/重试键用**未脱敏 URL 的独立 hash**（`urlHash`），不得用脱敏 URL 判等。session 关闭清零 HMAC 密钥。
- **R1-10 重定向与 hop**：内部请求键 = `(targetId, cdpSessionId, rawRequestId, hop)`；`hop` 从 0 递增。对外的 `requestId` 是 `rawRequestId`，detail 返回值带 `hops:[{hopId,url,status,seq}]`；`redirect.from/to` 是 URL，另给 `fromSeq/toSeq`。C8 必须能分别 detail 三跳。
- **R1-11 时间与 body 状态**：CDP `Network.Response.timing` 的毫秒字段以 `requestTime`（秒）为基准；`dnsMs=dnsEnd-dnsStart`、`connectMs=connectEnd-connectStart`、`sslMs=sslEnd-sslStart`、`sendMs=sendEnd-sendStart`、`waitMs=receiveHeadersStart-sendEnd`、`receiveMs=receiveHeadersEnd-receiveHeadersStart`、`ttfbMs=receiveHeadersStart`、`totalMs=responseTime-requestTime`（全为负/缺失 → null）。事件 `wallMs` 用**该 target 首次 `requestWillBeSent.wallTime` 锚点 + (eventTs-anchorTs)×1000** 推算，锚点缺失才回退 `Date.now()`；禁止每条事件各自 `Date.now()`。body 三态：`captured|empty|unavailable`；GET 无 postData、HEAD/204/304 合法空体记 `empty`，不调用 `getRequestPostData`；redirect 中间跳/failed/cache 可 `unavailable`，不计入 `bodiesUnavailable` 失败（计数单独 `bodyEmpty`）。detail 只用已捕获数据，不 ensure/不重试。
- **R1-12 WS/SSE**：`opcode=1` 的 `payloadData` 是 UTF-8 文本；其它 opcode 通常是 base64，按 opcode 解码后计算字节；截断按 UTF-8 码点安全，标 `payloadTruncated` 并与会话 `truncated` 一致。SSE 只用 `eventSourceMessageReceived`，流结束后不得再从响应体重复解析。分别统计连接/帧/消息；CDP 帧不证明 TCP 分片无损，契约不声称 CDP 之前无丢包。
- **R1-13 网络条件**：throttle/offline 组合状态 + 每 target 下发并汇报失败（不假装「子目标共享」）；Kbps = 1024 bit/s（Kibps），实现换算与测试读实参；`reset` 后恢复 `offline:false,latency:0,throughput:-1`。
- **R1-14 HAR 有效性**：导出条目必须含 `startedDateTime/time/request{method,url,httpVersion,headers,queryString,cookies,headersSize,bodySize}/response{status,statusText,httpVersion,headers,cookies,content{size,mimeType}/redirectURL,headersSize,bodySize}/cache/timings{send,wait,receive}`；未知数值用 `-1`（HAR 约定），不得用 null 冒充；`ssl` 不得与 `connect` 重复相加。扩展字段 `_networkP0:{seq,kind,phase,targetId,frameId,stepId,hopId}` + `_webSocketMessages`/`_eventSourceMessages`；导入未知字段忽略。JSONL 才是保真格式；C42 的 HAR 往返只断言 HTTP 条目，WS/SSE 保真由 JSONL 断言。
- **R1-15 配额口径**：`maxTotalBytes` 计 body + header 值 + 事件 JSON（近似字节，估算函数固定并公开）+ 订阅 pin + 候选缓冲；四会话摘要与索引内存不计入但公开为 `retained` 元数据。候选缓冲晋升时**重新分配 seq**（保留原 wall/monotonic）并计入 `maxEvents`，不得绕过。`gaps` 必须包含「因配额拒收的新事件」的 seq 洞；仅 `evicted` 总数不满足连续性检查。索引随淘汰删除。
- **R1-16 截图时间窗**：`networkWindow.frameTimeMs` = 截图调用开始墙钟，`captureEndMs` = 调用结束；`toSeq` 是该时刻会话 highWater（不包含调用开始后新产生的事件）；`fromSeq` 是 `[startMs-250, captureEndMs+50]` 内最早现存事件，候选不足时按实际返回（不强制 5 条）；`nearest` 只从现存事件选，可为 null；无会话时各字段为 null/空数组，截图不得为证据启动采集。
- **R1-17 验收假设修正**：initiator.type 用 `"script"`（页面 fetch/XHR 的常见值；不断言 `"fetch"`），不假设 `initiator.requestId` 一定存在；并发/时序正例用 `/n/slow?ms=` 制造真正重叠；轮询识别键 = `method + origin+path + bodyHash`（`/n/poll?n=` 的 query 不计入键），step 内连续区间 + 间隔相似度；replay 的页面 fetch 不经 fixture 封装，`__net.requests` 不增，改用 fixture 服务端命中计数 + 新 CDP 请求事件双证。
- **R1-21 子目标采集边界（实测收口）**：`iframe`（含 OOPIF）与 `dedicated worker` 通过 page 级 `setAutoAttach` 采集，事件带 `targetId/cdpSessionId`、`attribution:"page-attached"`。**shared_worker / service_worker 不采集**：本 build 的 page 级 attach 对 shared_worker 不生效；而 attach `service_worker`（页面级或浏览器级）会因 `waitForDebuggerOnStart` 在开跑前暂停它，实测破坏页面 `serviceWorker.register()`/`controller`——违反「采集不得改变页面语义」，故拒绝并如实降级。`capabilities.network.limits.network.subTargets` 必须写 `{workers:"page-attached", shared_worker:"not-collected", service_worker:"not-collected", oopif:"partial", partial:true, reason:"…"}`；C5 的 shared/service worker 子项记 NOT_RUN 并附原因，不得伪造 PASS，也不得为采集而改写页面语义。
- **R1-22 patterns 暴露**：§5.5 的 `retry|duplicate|polling` 除 `trace.query` 外，`browser_network_events` 的 `view:"aggregate"` 返回 `patterns:{retry:[{groupKey,count,seqs}],duplicate:[…],polling:[…]}`；`browser_network_detail` 对单请求返回 `analysis:{pattern,groupKey}`。C22 用 events.aggregate 断言，不依赖 trace。
- **R1-18 C5/C1/C37 边界**：C5 除 same-origin iframe + dedicated worker 外，须尝试 OOPIF（`localhost` vs `127.0.0.1` 跨站）与 shared/service worker；环境不具备（headless 未隔离/注册失败）→ 对应子项 NOT_RUN 并附环境原因，能力记 partial，不得整条 PASS 冒充全量。C1 HTTPS 子项 NOT_RUN（无本地 TLS 靶机），能力 `https:"mechanism-identical"`。C37 `modify-response` 不支持则 NOT_RUN。C1–C52 每条的 required 子项固定 3–8 条，报告逐条列 criteria/required/failed/NOT_RUN。
- **R1-19 参数封闭**：§2 各工具的 action 枚举、必填/互斥字段、`additionalProperties:false`、数值范围按本文执行；`session` 工具不接受 `sessionId`；`config` 增加 `businessStatusPath?`、`maskRules?≤16`；`trace` 增加 `includeTemporal?:boolean`（默认 false）与外部 `stepId`（必须唯一，不可复用）；`basis` 枚举按上下文：因果 `explicit|redirect|initiator|temporal`，对象传播 `observed`，状态 `observed`。`mark` 至少含 `{kind,text,tool,actionId,stepId,revision,title,url,wallMs}`（可空）。
- **R1-20 §9/§11 补强**：§9 以 `tests/ui_test_fixture/README.md §NET` 为逐字真值；另在 §9 末尾附「冻结路由→状态/字节要点」与「按钮→`__net` 字段」摘要（见下）。§11 参考文件具体为：`playwright/packages/playwright-core/src/server/har/harTracer.ts`、`playwright/packages/playwright-core/src/server/network.ts`、`devtools-frontend/front_end/panels/network/NetworkLogView.ts`、`.../EventSourceMessagesView.ts`、`.../NetworkDataGridNode.ts`、`mitmproxy/mitmproxy/flow.py`、`.../addons/intercept.py`、`.../websocket.py`、`opentelemetry-js/packages/opentelemetry-core/src/trace/W3CTraceContextPropagator.ts`、`jaeger/model/adjuster/`、`bruno/packages/bruno-common`（mock/replay 规则）。
- **§9 冻结摘要**：`/n/json` 200 JSON `{message:"net-fixture-ok",items:[1,2,3],query}`；`/n/echo` 回显 method/parsed body/headers 白名单；`/n/status/404|500` JSON 错误；`/n/slow?ms=` 封顶 5000；`/n/redirect/1→2→/n/final` 302×2 + `{landed:true}`；`/n/gzip` `content-encoding:gzip`；`/n/chunked` 3 段无 content-length；`/n/large?bytes=` 总字节 `bytes+10`；`/n/sse` 10/30/60ms 三条事件后关闭（客户端必 1 次 error）；`/n/ws` echo + 10ms 后 `server-push-1`；`/n/poll?n=` `{poll:n}`；`/n/flaky?key=` 首 503 后 200（`reset=1`）；`/n/token?token=`；`/n/cors` 全套 CORS 头 + OPTIONS 204；`/n/worker.js|worker-data|iframe.html|iframe-data`；`/web-network.html` 18 个固定 id 按钮 + `window.__net{requests,ws{sent,received,opens,closes},sse{events,errors,stops},poll{values,stops},worker{started,done},iframe{done},byTrigger,summary()}`；`/web-network-frame.html` `window.__netFrame`。

## 14. 业务链路端到端场景（追加，2026-11-01）

用户场景：多页面路由「商品选择 → 商品详情 → 下单 → 结算 → 我的订单」的整条网络请求链路。新增独立场景靶机与验收（**不并入 C1–C52**，单独 suite `acceptance-network-chain`）：

- 靶机：`/shop/products.html` → `/shop/product.html` → `/shop/order.html` → `/shop/checkout.html` → `/shop/orders.html`（真实全页导航，固定 `runId=chain-1`），API `/api/shop/*`（products/detail/orders/checkout/status/list，幂等，JSON `code:0`，请求与响应带 `x-correlation-id: trace-shop-chain-1`；checkout 页 3 次同 URL status 轮询；`#shop-spa-route` 做 pushState + 1 次 status）。真值表见 `tests/ui_test_fixture/README.md §SHOP`。
- 验收：`node tests/acceptance/network-chain.mjs`（S1–S12：会话连续性、flow+5 阶段步、请求/响应体、关联标识、业务对象与传播、轮询、导航/SPA 边界、截图时间窗、JSONL 导出、完整性、旧工具不回归、chain-report）；报告 `run-report.json` + `run.log` + `chain-report.md`。
- Lead 独立复跑：**12/12 criteria、49 requiredChecks、0 failed、1 NOT_RUN、exit 0**（`tests/acceptance/runs/2026-11-01T13-12-50-370Z-416332/`）；一次会话跨 5 次全页导航共 26 个请求、142 条事件、总耗时 178ms、失败 0、orderId `ORD-chain-1-1`，flow 步提取 orderId/productId/runId 且 orderId 传播 ≥1，`x-correlation-id` 同组 `sameGroup≥5`，轮询被识别，截图 `networkWindow` 覆盖阶段请求，JSONL 0600 相对路径导出。
- **边界（如实）**：① 引擎不自动推断业务步骤/对象，步骤由调用方 `begin-step/end-step` 显式开窗；跨阶段对象传播需用覆盖全链路的 flow 步（阶段步的 propagation 只在各自窗口内）。② 步骤之间是**重叠时间窗**关系，不是父子树/阶段依赖图；因果仅 `explicit|redirect|initiator|temporal`。③ 页面在拿到响应后**立即整页跳转**时，CDP 响应体缓冲可能先失效（`S3-post-body-race`，POST order 响应体 `NET_BODY_UNAVAILABLE`；请求体与同链路 GET 响应体可读），建议跳转前完成关键响应读取或以同链路 GET 复核。④ SPA pushState 后事件 `documentURL` 跟随浏览器当前 URL，但服务端路由不存在（`/shop/checkout/step2` 直连 404），没有独立的 route-change 网络事件；阶段归属仍靠步骤窗口。⑤ 长链路需显式提高配额（如 maxEvents=20000/maxTotalBytes=32MiB）并在链末导出 JSONL；默认 5000 事件/8MiB 会淘汰并计数。
