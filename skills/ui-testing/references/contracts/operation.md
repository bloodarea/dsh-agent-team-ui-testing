# 操作返回与错误契约（M0–M2）

所有工具返回并 render camelCase `actionId/sessionId/startedAt/finishedAt/target/args`；args 是摘要。工具执行失败的 message 也包含证据。没有自动 assertion_status、独立 JSONL 或侧效回滚；执行成功与断言通过由 Agent 分开记录。

| 工具 | 业务成功字段 | 操作失败/边界 |
| --- | --- | --- |
| `browser_navigate` | `{ok:true,url}` | 检查 errorText/最终 URL；不保证 load complete；失败抛 BrowserError |
| `browser_eval` | `{ok:true,value,type}` | 页面异常 `{ok:false,error:{code,category,retryable,message,details}}`，含描述/栈/位置 |
| `browser_screenshot` | `{viewport,bytes,image,capturedAt,sha256,attachmentId,capture}` | 可选scale连续1–4/region文档CSS/persist:boolean=false/out持久根相对.png；默认staging，out/persist:true/非空env才persistent；file含pathKind/persistence/root/ephemeral，dispose清理暂存；CRC/尺寸/全量均匀统计/JSON映射/安全文件/附件metadata进入capture v1；保留base64/附件fallback，provider另验 |
| `browser_input` | `{ok:true,applied}` | applied 是数组长度，不证明识别/生效；未知 kind 仍可能跳过；modifiers 支持字符串数组或 CDP 位掩码（Alt=1/Ctrl=2/Meta=4/Shift=8） |
| `browser_network` | `{entries:[…]}` | 响应及 loadingFailed、URL 脱敏、记录有界；其他 owner 返回 BUSY |
| `browser_computed_style` | `{ok:true,style}` | 未命中返回 error 对象；非法 selector/页面异常按实际分类错误处理 |
| `browser_state` | mode/activity/url/title/viewport/seq/running/error 与 owner 诊断；错误四字段 error/errorAt/errorActionId/errorTarget | 不启动、不占租约；标题从 document.title 刷新；成功的页面/网络操作清空错误，诊断与 HTTP 不清 |
| `browser_http_request` | `{ok:true,method,url,status,statusText,headers,contentType,encoding,body,bodyBytes,bodyTruncated,redirects,timings}` | 独立 HTTP(S)：`ok:true` 仅表示取得响应（非 2xx 也成功返回）；默认不跟随重定向、5s/64KiB 预算、无 cookie jar；不启动 Chromium、不占租约；失败抛分类错误 |
| `browser_capabilities` | runtime/capabilities/limits 等真实诊断 | available/unavailable/unsupported，不启动、不占租约；16 项（9 T1 + 7 T2）与 `limits.structuredGui`；自身抛错时不得当作能力结论 |
| `browser_snapshot` | `{ok:true,snapshotId,digest,tree,refs,nodeCount,truncated,truncationReasons,coverage}` + evidence | 主 frame AX 快照；`scope`/`maxNodes`(1–2000)/`depth`(0–32)/`boxes`；采集中文档代次变化抛 `REF_STALE` |
| `browser_click` | `{ok:true,dispatched,button,clickCount,point}` + evidence | `ref`/`selector` 恰一；滚动+两帧稳定+命中校验后 CDP 鼠标事件；hidden/covered → `NOT_INTERACTABLE`（`details.escalation:"T3"`），无 force |
| `browser_type` | `{ok:true,dispatched,insertedCharacters,replaced,submitted}` + evidence | 原生文本 input 与 textarea；`replace`/`submit`；不回显文本；contenteditable 等抛 `UNSUPPORTED` |
| `browser_scroll` | `{ok:true,dispatched,requested,scrollBefore,scrollAfter,moved}` + evidence | `direction` 与 `to` 恰一（`to` 禁 `amount`）；`amount` 默认 400；到边界 `moved:false` 仍成功 |
| `browser_fill_form` | `{ok:true,applied,fields:[{index,type,changed,nodeBefore,nodeAfter,eventSource}]}` + evidence | 1–20 项，`type`=textbox/checkbox/radio/combobox/slider；整批预检后执行，失败不回滚（`details.applied/failedIndex/fields`） |
| `browser_node_state` | `{ok:true,node:NodeState}` + evidence | 现场读取；hidden/disabled/readonly/covered 也能读；可编辑 `value` 恒 null + `valueRedacted:true` |
| `browser_wait_for` | `{ok:true,matched,elapsedMs,polls,condition,node}` + evidence | text / textGone / 目标 state 三类互斥；`timeoutMs`(默认 5000，上限 30000)/`pollMs`(默认 100)；超时抛 `WAIT_TIMEOUT`，page 不关闭 |

工具执行失败抛 BrowserError，字段 `code/category/retryable/details`，message 含 `[CODE]` 与 action 证据。关键 codes：NAV_FAILED、CDP_TIMEOUT、CDP_DISCONNECTED、TARGET_NOT_FOUND、EVAL_ERROR、BUSY、ABORTED、INVALID_ARGUMENT、UNSUPPORTED、INTERNAL；独立 HTTP 另有 HTTP_TIMEOUT、HTTP_FAILED、HTTP_REDIRECT_LIMIT（DNS 仍 NAV_FAILED）。不能保证 DSH 自定义 info.code 的持久化，故 message 与 render 仍必需。

**T2 的错误形状与 T1 legacy 不同**：`REF_STALE`/`TARGET_NOT_FOUND`/`TARGET_NOT_UNIQUE`/`NOT_INTERACTABLE`/`WAIT_TIMEOUT`/`INVALID_ARGUMENT` **全部抛错**（不返回 `{ok:false,error}`），`details.evidence` 必带 version=1 evidence；`NOT_INTERACTABLE` 的 `details.reason` 取值 hidden/disabled/readonly/inert/detached/zero-area/outside-viewport/unstable/covered/not-editable/type-mismatch/focus-mismatch/value-mismatch/not-scrollable，hidden 与 covered 另带 `details.escalation:"T3"`；`WAIT_TIMEOUT` 为 `timeout`/`retryable=true`，`details` 含 `elapsedMs/polls/condition`，**不关闭 page**、不走取消清理分支；`REF_STALE` 表示 ref 未知/被 LRU 淘汰/文档代次改变/节点被替换，必须重新 `browser_snapshot`。

面板内部 HTTP 路由保留 `{ok:false,error:"字符串"}`，增加同级 code/category/retryable；不要混淆为 Agent 的操作 error 对象。

独立 HTTP 的额外约束：`ok:true` 不等于 2xx；`headers` 为小写头名→非空 `string[]`；`encoding` 为 utf8/base64（非文本/压缩/截断在多字节码点中间走 base64，且不自动解压）；`bodyBytes` 是保留的原始实体字节；`bodyTruncated:true` 时不能断言完整响应；重定向默认不跟随，显式开启后每跳复验目标、HTTPS→HTTP 降级拒绝、跨 origin 清空调用方头；不写页面 error、不建立全局串行队列。

CDP 超时/断连/取消可能已发生网页副作用，retryable 不等于可盲重试。signal 在 CDP 已发出后取消，队列内先关闭该工作区 page 再放锁；后续可懒启动，旧页内存态可能已丢失，须检查应用持久状态。网络/state/capabilities 不启动；state/capabilities 不申请租约；network、页面工具与全部 T2 工具受该工作区 single-owner-lease 限制（只读的 snapshot/node_state/wait_for 也要先拿租约）。

P0截图失败抛BrowserError：CAPTURE_FAILED（capture/true）；INVALID_PNG/CAPTURE_SIZE_MISMATCH/CAPTURE_UPSCALED（capture/false）；CAPTURE_TOO_LARGE（resource/false）；OUTPUT_PATH_INVALID（input/false）；OUTPUT_EXISTS（output/false）；OUTPUT_WRITE_FAILED（output/true）。ABORTED/CDP_TIMEOUT/CDP_DISCONNECTED原码透传；UP只是尺寸保守拒绝，混合偏差为SIZE_MISMATCH。相同out不覆盖，重试换名；合法纯色只warn不失败。完整参数、八warnings与安全写入见 [证据契约](evidence.md)、[安全边界](../core/safety.md)；P0三次13/13、115/115报告见 [T1台账](../../knowledge/web/t1-capability-ledger.md)，真实宿主P0加载/provider仍NOT_RUN。

computed_style 只取首个匹配元素；properties 缺省返回全部样式，序列化可能省略 undefined 属性，不证明像素或遮挡。输入 schema 已在 N2 扩展 modifiers/virtualKeyCode 等字段；非法修饰键名/类型/越界掩码与非法 `key.type` 抛 `INVALID_ARGUMENT`，且校验发生在启动浏览器与派发之前。焦点仍无专门工具，只能用 key Tab/Shift+Tab 或页面内 JS，并以页面读回为准。
