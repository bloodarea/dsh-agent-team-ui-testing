# 网络调试

网络能力分两层：轻量的 `browser_network`（T1，只读元数据列表）与 P0-B 的七个 `browser_network_*` 工具（采集、时序、分析、链路、控制、证据、订阅）。两层并存，语义不互相顶替。

## 七个工具

| 工具 | 作用 |
| --- | --- |
| `browser_network_session` | `start`/`stop`/`status`/`reset`；**唯一会懒启动采集的动作** |
| `browser_network_events` | 列表、时间线、聚合、过滤、检索与游标 |
| `browser_network_detail` | 单个请求/WS/SSE 的完整详情 |
| `browser_network_trace` | 业务步骤窗口、对象提取、显式关联与因果 |
| `browser_network_control` | 限速、离线、拦截、hold、重放、mock |
| `browser_network_evidence` | JSONL/HAR 导出、导入、索引、检索、完整性 |
| `browser_network_subscribe` | 多 Agent 独立游标 poll/ack |

`status`、`events`、`detail`、`trace`、`evidence`、`subscribe` 的只读动作**不启动浏览器**；只有 `session.start` 与需要 page 的 `control` 动作会懒启动。

## 采集

```text
browser_network_session { action:"start", config:{ captureBodies:true, captureWebSocket:true } }
browser_navigate / browser_click / 页面自身请求   # 产生真实流量
browser_network_events { view:"timeline", limit:50 }
browser_network_detail { seq }
browser_network_session { action:"stop" }
```

- 覆盖：HTTP/HTTPS 请求与响应、WebSocket 双向帧、SSE 事件、同页 same-origin iframe 与 dedicated worker。
- 同名 `start` 幂等（`changed:false`）；运行中换名返回 `NET_SESSION_ACTIVE`。
- 配额由 `maxEvents`/`maxBodyBytes`/`maxTotalBytes`/`maxWsFrames` 控制，淘汰与截断一律计数，可在 `integrity` 中查。
- `sessionId` 省略时使用当前 scope 的当前会话；无会话时只读工具返回空并置 `session:null`。
- `status`/`start`/`stop`/`reset` 回传 `activeSessionId` 与 `bufferedEvents`：后者是会话启动前观察到的候选缓冲，不会被 `browser_network_events` 当作会话事件返回。
- 每个标签页一个采集会话；会话与证据块都带 `attribution:{scopeId,runtimeId,tabId}`（见「会话归属」）。

## Body 三态与原因码

`browser_network_detail` 的 `body.request`/`body.response` 固定三态：

| 状态 | 含义 |
| --- | --- |
| `captured` | 有内容可读（`available:true`） |
| `empty` | 合法空体（HEAD/204/304/GET 无 postData 等），`bytes:0`，不伪造内容 |
| `unavailable` | 读不到（失败/缓存/重定向中途/已淘汰/未捕获） |

`unavailable` 时 `available:false`，并给出原因：

| 字段 | 语义 |
| --- | --- |
| `reason` | 兼容字段，固定 `"NET_BODY_UNAVAILABLE"` |
| `reasonCode` | 稳定原因码：`not-captured` / `cdp-no-resource` / `cdp-evicted` / `cdp-timeout` / `cdp-invalid-params` / `cdp-disconnected` / `cdp-error` / `cdp-unknown` |
| `reasonDetail` | 可选、单行、≤160 字节、脱敏（URL userinfo/敏感 query、敏感字段值、控制字符）；不回显 CDP 错误全文 |

- `captureBodies:false`：从未尝试读取 → `reasonCode:"not-captured"`（不是 CDP 错误）；detail 仍返回 `available:false`，**绝不补抓**。
- 请求体与响应体分别记录原因；本地配额淘汰 body 后读为 `cdp-evicted`；无法归类的错误稳定回落 `cdp-unknown`，不猜测。
- `empty` 语义保持不变；`reasonCode`/`reasonDetail` 的加入不改变三态判定，也不触发重试或二次读取。

## 会话归属

- 每个 Runtime（= 每个 scope 的每个标签页）一个采集 store；`browser_network_session` 的 `status`/`start`/`stop`/`reset` 结果与各工具 `evidence` 块回传 `attribution:{scopeId,runtimeId,tabId}`。
- 主标签 `tabId="primary"`，子标签用其 view/tab id；缺失字段为 `null`，**不从 `cdpSessionId`/`targetId` 反推**。
- 切换 selectedTab 后，网络工具操作该标签自己的会话；不同标签 attribution 不同且稳定。**不做跨标签/跨 scope 聚合**，也不把两个标签的事件合并进同一会话。
- `status` 另提供 `activeSessionId` 与 `bufferedEvents`，用于区分「没有会话」与「有会话但本页没有事件」。

## 状态一致性

- 当前实现未复现「`status.session=null` 但 events 仍有数据」的现场：store 在会话边界同时清空事件 ring，events wrapper 还有「无会话不得返回事件窗口」的防御（返回空并明示 `session:null`）。
- 因此该现象的根因按 **UNKNOWN** 记录，不写「已修复」；显式传 `sessionId` 时仍要求会话存在，否则 `NET_SESSION_NOT_FOUND`。

## 时序与分析

- 事件带单调 `seq` 与统一时间轴；`view:"timeline"` 把 http/ws/sse/marker 混排。
- `view:"aggregate"` 必须给 `groupBy`；`aggregate` 的合法指标是固定白名单 `count`｜`bytes`｜`duration`｜`p50`｜`p95`｜`failures`，给其它字符串返回 `NET_INVALID_ARGUMENT`（并回带 `allowed` 列表）；`search` 命中正文/WS/SSE 时只回**脱敏预览片段**。
- 游标不透明，`cursor` 与 `sinceSeq` 二选一；指向已淘汰 seq 时返回 `gap`。

## 业务链路

`browser_network_trace` 提供步骤窗口与对象提取：

- `begin-step` / `end-step` / `mark` 建立窗口。窗口有 **wallMs 与 seq 两个边界**：一个事件属于该步骤必须同时落在 `[fromWallMs, toWallMs]` 与 `[fromSeq, toSeq]` 内。只看 wallMs 会把"步骤开始前就已入库、但其 response/finish 阶段时间戳更晚"的事件误算进下一步，因此 `stepId` 过滤与派生归属都以 seq 边界为准。
- `objectRules` 声明要提取的业务对象；不做隐式猜测。
- `correlationRules` 声明关联字段；`basis` 只有 `explicit`/`redirect`/`initiator` 才算因果，`temporal` 只是时间邻近（默认过滤，需 `includeTemporal:true`）。
- `link` 建立 seq 与证据的显式关联，重复调用幂等。

## 控制

| 动作 | 说明 |
| --- | --- |
| `throttle` | CDP 网络条件（Kbps 按 1024 bit/s，0 表示不限速），与 `offline` 组合 |
| `offline` | 断网开关 |
| `intercept-add/remove/clear/list` | 规则最多 32 条，按顺序先命中先生效，同 id 冲突 |
| `hold` / `resume` | 挂起与放行，hold 上限 64，超时自动放行并计数 |
| `replay` | 重放已记录请求 |
| `mock` | 直接返回指定状态/头/正文 |
| `reset` | 恢复网络条件、清规则、放行 held；**不关闭导航守卫** |

`behavior.kind` 支持 `block`/`fail`/`modify-request`/`fulfill`/`delay`/`hold`；`modify-response` 在本构建不可用——`responseModification` 固定为 `false`（不做 CDP 能力探测），尝试该 kind 会如实报不支持。

## 证据

- **JSONL** 是保真格式：每行一条标准化事件，包含 seq 空洞。
- **HAR** 只保证 1.2 子集，未知数值用 `-1`。
- 导出只写持久根内（`DSH_UI_TESTING_CAPTURE_DIR`，否则工作区），返回相对路径；无可用根返回 `NET_OUTPUT_ROOT_UNKNOWN`，不退避到临时目录。
- 导入生成 `state:"snapshot"` 的离线会话：可分析、可再导出，**不可** control/replay。
- `integrity.complete=true` 只在 dropped/evicted/truncated 全为 0 且无 gap 时成立。

## 订阅

多 Agent 各自持有游标：`create` → `poll` → `ack` → `close`。每 scope 最多 16 个订阅、pin 1000 条；ack 前不丢只限 pin 预算内，超出给 `gap`/`dropped` 计数，绝不静默。他人订阅返回 `NET_SUBSCRIPTION_FORBIDDEN`。

## 限制

- OOPIF 为部分覆盖；shared/service worker 不采集；GUI 内部标签页可打开真人触发的 `target=_blank`（child Runtime 有独立网络缓冲），Agent 网络工具默认操作当前会话 selectedTab（无选择 primary），多标签见 [multi-tab.md](multi-tab.md)；自动/未授权 popup 仍阻断，不做跨 scope 聚合。
- HTTPS 未独立验收，能力报告标记 `limits.network.https:"mechanism-identical"`。
- 不做 MITM、不装 CA、不读 TLS 密钥；限速是 CDP 网络条件模拟，不是真实链路整形。
- 多标签之间只共享浏览器 profile，不共享网络会话；attribution 按标签独立，不聚合。
- 脱敏是默认规则集，不是通用密钥检测器；正文与头可能仍含敏感信息。
