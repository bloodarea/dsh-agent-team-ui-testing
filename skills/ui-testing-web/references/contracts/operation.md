# 操作返回与错误契约（M0–M2）

所有工具返回并 render camelCase `actionId/sessionId/startedAt/finishedAt/target/args`；args 是摘要。工具执行失败的 message 也包含证据。没有自动 assertion_status、独立 JSONL 或侧效回滚；执行成功与断言通过由 Agent 分开记录。

| 工具 | 业务成功字段 | 操作失败/边界 |
| --- | --- | --- |
| `browser_navigate` | `{ok:true,url}` | 检查 errorText/最终 URL；不保证 load complete；失败抛 BrowserError |
| `browser_eval` | `{ok:true,value,type}` | 页面异常 `{ok:false,error:{code,category,retryable,message,details}}`，含描述/栈/位置 |
| `browser_screenshot` | `{viewport,bytes,image,capturedAt,sha256,attachmentId,capture}` | 可选显式scale 0.1–4（省略时跟随共享view.scale）/region画布CSS/includeAnnotations?:boolean=false/persist:boolean=false/out持久根相对.png；true 按同一 region/scale 叠加 Host 已接受的六种面板形状，不含草稿/工具栏，capture.annotations 记录文档证据；默认截图及 T3/T4 原始源不含面板标注；默认staging，out/persist:true/非空env才persistent；file含pathKind/persistence/root/ephemeral，dispose清理暂存；CRC/尺寸/全量均匀统计/JSON映射/安全文件/附件metadata进入capture v1；保留base64/附件fallback，provider另验 |
| `browser_input` | `{ok:true,applied}` | applied 是数组长度，不证明识别/生效；未知 kind 仍可能跳过；modifiers 支持字符串数组或 CDP 位掩码（Alt=1/Ctrl=2/Meta=4/Shift=8） |
| `browser_network` | `{entries:[…]}` | 响应及 loadingFailed、URL 脱敏、记录有界；其他 owner 返回 BUSY |
| `browser_viewport` | `{ok,running,view,observed,viewMeta}`（get）/ `{ok,requested,before,view,observed,viewMeta,applied,settled,clamped,overrideApplied,appliedFields}`（set） | get 只读缓存诊断（不 ensure/不发 CDP/不进队列/不占租约）；set 走预检 → 串行队列 → 懒启动 + 租约；`expectedRevision` 冲突抛 `VIEWPORT_CONFLICT`（HTTP 409）且 patch 零应用；`x/y` 是文档 CSS 滚动位置、`scale` 0.1–2 且为默认截图密度；不改 DPR/页面 zoom |
| `browser_computed_style` | `{ok:true,style}` | 未命中返回 error 对象；非法 selector/页面异常按实际分类错误处理 |
| `browser_state` | mode/activity/url/title/viewport/seq/running/error 与 owner 诊断；错误四字段 error/errorAt/errorActionId/errorTarget | 不启动、不占租约；标题从 document.title 刷新；成功的页面/网络操作清空错误，诊断与 HTTP 不清 |
| `browser_http_request` | `{ok:true,method,url,status,statusText,headers,contentType,encoding,body,bodyBytes,bodyTruncated,redirects,timings}` | 独立 HTTP(S)：`ok:true` 仅表示取得响应（非 2xx 也成功返回）；默认不跟随重定向、5s/64KiB 预算、无 cookie jar；不启动 Chromium、不占租约；失败抛分类错误 |
| `browser_capabilities` | runtime/capabilities/limits 等真实诊断 | available/unavailable/unsupported，不启动/不建目录/不产 product/不生成证据文件、不占租约；按段报 T1/T2（7+1）/T3（6+1）/network（7+1，聚合 `web.network.p0`），并报 `limits.structuredGui`、`vision`/`limits.vision`、`network`/`limits.network`、`dynamic`/`limits.dynamic`（T4 五工具段 + 聚合 + 旧别名）；自身抛错时不得当作能力结论 |
| `browser_snapshot` | `{ok:true,snapshotId,digest,tree,refs,nodeCount,truncated,truncationReasons,coverage}` + evidence | 主 frame AX 快照；`scope`/`maxNodes`(1–2000)/`depth`(0–32)/`boxes`；采集中文档代次变化抛 `REF_STALE` |
| `browser_click` | `{ok:true,dispatched,button,clickCount,point}` + evidence | `ref`/`selector` 恰一；滚动+两帧稳定+命中校验后 CDP 鼠标事件；hidden/covered → `NOT_INTERACTABLE`（`details.escalation:"T3"`），无 force |
| `browser_type` | `{ok:true,dispatched,insertedCharacters,replaced,submitted}` + evidence | 原生文本 input 与 textarea；`replace`/`submit`；不回显文本；contenteditable 等抛 `UNSUPPORTED` |
| `browser_scroll` | `{ok:true,dispatched,requested,scrollBefore,scrollAfter,moved}` + evidence | `direction` 与 `to` 恰一（`to` 禁 `amount`）；`amount` 默认 400；到边界 `moved:false` 仍成功 |
| `browser_fill_form` | `{ok:true,applied,fields:[{index,type,changed,nodeBefore,nodeAfter,eventSource}]}` + evidence | 1–20 项，`type`=textbox/checkbox/radio/combobox/slider；整批预检后执行，失败不回滚（`details.applied/failedIndex/fields`） |
| `browser_node_state` | `{ok:true,node:NodeState}` + evidence | 现场读取；hidden/disabled/readonly/covered 也能读；可编辑 `value` 恒 null + `valueRedacted:true` |
| `browser_wait_for` | `{ok:true,matched,elapsedMs,polls,condition,node}` + evidence | text / textGone / 目标 state 三类互斥；`timeoutMs`(默认 5000，上限 30000)/`pollMs`(默认 100)；超时抛 `WAIT_TIMEOUT`，page 不关闭 |
| `browser_network_session` | `{ok:true,changed,session{id,name,state,config,counters,integrity},sessions,limits}` + evidence | `action` 必填（start/stop/status/reset）；**唯一网络懒启动动作**；同名 start 幂等、不同名运行中 `NET_SESSION_ACTIVE`；`status`/`reset` 不启动浏览器；reset 清内存并关闭本 scope 订阅 |
| `browser_network_events` | `{ok:true,view,fromSeq,toSeq,total,returned,dropped,evicted,truncated,cursor{next},events[],groups[],integrity}` + evidence | 只读不启动；`view`=summary/full/timeline/aggregate；`limit` 1–200；`cursor` 与 `sinceSeq` 二选一；命中已淘汰 seq 返回 `gap`；search 只回脱敏预览 |
| `browser_network_detail` | 详情对象（request/response/headers/body/timing/redirects/initiator/dependencies/ws/sse/correlation/business/hops）+ evidence | `requestId`/`seq` 恰一；body 三态 `captured\|empty\|unavailable`，读不到就 `available:false` 不伪造；不 ensure/不重试；找不到 `NET_EVENT_NOT_FOUND` |
| `browser_network_trace` | 步骤/对象/状态/因果/证据查询结果 + evidence | `action` 必填（begin-step/end-step/mark/link/window/query/reset），全是内存操作不启动浏览器；窗口归属按 wallMs 派生 `stepId` 且不改写事件；`includeTemporal` 默认 false |
| `browser_network_control` | `{ok:true,action,state,规则/held/replay/mock 摘要}` + evidence | `action` 必填；需要 page 的动作懒启动；throttle+offline 组合状态（Kbps=1024bit/s）；规则≤32、hold≤64、超时 `NET_CONTROL_TIMEOUT` 计数；reset 不 `Fetch.disable`，导航守卫保留 |
| `browser_network_evidence` | `{ok:true,index/文件/检索结果/integrity}` + evidence | `action` 必填（export/import/index/search/link/integrity/clear/list）；JSONL 保真、HAR 只保证 1.2 子集；只回相对路径且限持久根；离线会话不可 control（`NET_CONTROL_UNAVAILABLE`）；全部动作不启动浏览器 |
| `browser_network_subscribe` | `{ok:true,subscription,cursor,ackedSeq,counters{delivered,pending,pinned,dropped},events,gap}` + evidence | `action` 必填（create/poll/ack/close/list）；owner-only、每 scope 订阅上限 16、pin 1000；游标不得回退、ack 不得越过已交付；只会产生 gap/dropped 计数，不阻塞采集 |

工具执行失败抛 BrowserError，字段 `code/category/retryable/details`，message 含 `[CODE]` 与 action 证据。关键 codes：NAV_FAILED、CDP_TIMEOUT、CDP_DISCONNECTED、TARGET_NOT_FOUND、EVAL_ERROR、BUSY、ABORTED、INVALID_ARGUMENT、UNSUPPORTED、INTERNAL；独立 HTTP 另有 HTTP_TIMEOUT、HTTP_FAILED、HTTP_REDIRECT_LIMIT（DNS 仍 NAV_FAILED）。 网络 P0 的新失败一律 `NET_*`（SESSION_NOT_FOUND/SESSION_ACTIVE/EVENT_NOT_FOUND/BODY_UNAVAILABLE/QUOTA_EXCEEDED/RULE_INVALID/RULE_CONFLICT/CONTROL_UNAVAILABLE/EXPORT_FAILED/IMPORT_FAILED/HAR_INVALID/SUBSCRIPTION_NOT_FOUND/SUBSCRIPTION_FORBIDDEN/INTEGRITY_FAILED/SCOPE_FORBIDDEN/CONTROL_TIMEOUT/INVALID_ARGUMENT/OUTPUT_ROOT_UNKNOWN/OUTPUT_PATH_INVALID/OUTPUT_WRITE_FAILED），不降级 INTERNAL；BUSY/ABORTED/CDP_*/RUNTIME_LIMIT 按原码透传并在 evidence 注明。不能保证 DSH 自定义 info.code 的持久化，故 message 与 render 仍必需。

**T2 的错误形状与 T1 legacy 不同**：`REF_STALE`/`TARGET_NOT_FOUND`/`TARGET_NOT_UNIQUE`/`NOT_INTERACTABLE`/`WAIT_TIMEOUT`/`INVALID_ARGUMENT` **全部抛错**（不返回 `{ok:false,error}`），`details.evidence` 必带 version=1 evidence；`NOT_INTERACTABLE` 的 `details.reason` 取值 hidden/disabled/readonly/inert/detached/zero-area/outside-viewport/unstable/covered/not-editable/type-mismatch/focus-mismatch/value-mismatch/not-scrollable，hidden 与 covered 另带 `details.escalation:"T3"`；`WAIT_TIMEOUT` 为 `timeout`/`retryable=true`，`details` 含 `elapsedMs/polls/condition`，**不关闭 page**、不走取消清理分支；`REF_STALE` 表示 ref 未知/被 LRU 淘汰/文档代次改变/节点被替换，必须重新 `browser_snapshot`。

面板内部 HTTP 路由保留 `{ok:false,error:"字符串"}`，增加同级 code/category/retryable；不要混淆为 Agent 的操作 error 对象。

独立 HTTP 的额外约束：`ok:true` 不等于 2xx；`headers` 为小写头名→非空 `string[]`；`encoding` 为 utf8/base64（非文本/压缩/截断在多字节码点中间走 base64，且不自动解压）；`bodyBytes` 是保留的原始实体字节；`bodyTruncated:true` 时不能断言完整响应；重定向默认不跟随，显式开启后每跳复验目标、HTTPS→HTTP 降级拒绝、跨 origin 清空调用方头；不写页面 error、不建立全局串行队列。

CDP 超时/断连/取消可能已发生网页副作用，retryable 不等于可盲重试。signal 在 CDP 已发出后取消，队列内先关闭该工作区 page 再放锁；后续可懒启动，旧页内存态可能已丢失，须检查应用持久状态。网络/state/capabilities 不启动；state/capabilities 不申请租约；network、页面工具与全部 T2 工具受该工作区 single-owner-lease 限制（只读的 snapshot/node_state/wait_for 也要先拿租约）。

P0截图失败抛BrowserError：CAPTURE_FAILED（capture/true）；INVALID_PNG/CAPTURE_SIZE_MISMATCH/CAPTURE_UPSCALED（capture/false）；CAPTURE_TOO_LARGE（resource/false）；OUTPUT_PATH_INVALID（input/false）；OUTPUT_EXISTS（output/false）；OUTPUT_WRITE_FAILED（output/true）。ABORTED/CDP_TIMEOUT/CDP_DISCONNECTED原码透传；UP只是尺寸保守拒绝，混合偏差为SIZE_MISMATCH。相同out不覆盖，重试换名；合法纯色只warn不失败。完整参数、八warnings与安全写入见 [证据契约](evidence.md)、[安全边界](../core/safety.md)；

computed_style 只取首个匹配元素；properties 缺省返回全部样式，序列化可能省略 undefined 属性，不证明像素或遮挡。输入 schema 已在 N2 扩展 modifiers/virtualKeyCode 等字段；非法修饰键名/类型/越界掩码与非法 `key.type` 抛 `INVALID_ARGUMENT`，且校验发生在启动浏览器与派发之前。焦点仍无专门工具，只能用 key Tab/Shift+Tab 或页面内 JS，并以页面读回为准。
