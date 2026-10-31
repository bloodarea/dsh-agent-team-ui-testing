# 操作返回与错误契约（M0–M2）

所有工具返回并 render camelCase `actionId/sessionId/startedAt/finishedAt/target/args`；args 是摘要。工具执行失败的 message 也包含证据。没有自动 assertion_status、独立 JSONL 或侧效回滚；执行成功与断言通过由 Agent 分开记录。

| 工具 | 业务成功字段 | 操作失败/边界 |
| --- | --- | --- |
| `browser_navigate` | `{ok:true,url}` | 检查 errorText/最终 URL；不保证 load complete；失败抛 BrowserError |
| `browser_eval` | `{ok:true,value,type}` | 页面异常 `{ok:false,error:{code,category,retryable,message,details}}`，含描述/栈/位置 |
| `browser_screenshot` | `{viewport,bytes,image,capturedAt,sha256,attachmentId}` | PNG base64 保留；附件 image block 或 base64-fallback 文本；provider 可见性另验 |
| `browser_input` | `{ok:true,applied}` | applied 是数组长度，不证明识别/生效；未知 kind 仍可能跳过；modifiers 支持字符串数组或 CDP 位掩码（Alt=1/Ctrl=2/Meta=4/Shift=8） |
| `browser_network` | `{entries:[…]}` | 响应及 loadingFailed、URL 脱敏、记录有界；其他 owner 返回 BUSY |
| `browser_computed_style` | `{ok:true,style}` | 未命中返回 error 对象；非法 selector/页面异常按实际分类错误处理 |
| `browser_state` | mode/activity/url/title/viewport/seq/running/error 与 owner 诊断 | 不启动、不占租约；标题从 document.title 刷新 |
| `browser_capabilities` | runtime/capabilities/limits 等真实诊断 | available/unavailable/unsupported，不启动、不占租约 |

工具执行失败抛 BrowserError，字段 `code/category/retryable/details`，message 含 `[CODE]` 与 action 证据。关键 codes：NAV_FAILED、CDP_TIMEOUT、CDP_DISCONNECTED、TARGET_NOT_FOUND、EVAL_ERROR、BUSY、ABORTED、INVALID_ARGUMENT、UNSUPPORTED、INTERNAL。不能保证 DSH 自定义 info.code 的持久化，故 message 与 render 仍必需。

HTTP 内部路由保留 `{ok:false,error:"字符串"}`，增加同级 code/category/retryable；不要混淆为 Agent 的操作 error 对象。

CDP 超时/断连/取消可能已发生网页副作用，retryable 不等于可盲重试。signal 在 CDP 已发出后取消，队列内先关闭浏览器再放锁；后续可懒启动，旧页内存态可能已丢失，须检查应用持久状态。网络/state/capabilities 不启动；state/capabilities 不申请租约；network 与页面工具受 single-owner-lease 限制。

computed_style 只取首个匹配元素；properties 缺省返回全部样式，序列化可能省略 undefined 属性，不证明像素或遮挡。输入 schema 已在 N2 扩展 modifiers/virtualKeyCode 等字段；非法修饰键名/类型/越界掩码与非法 `key.type` 抛 `INVALID_ARGUMENT`，且校验发生在启动浏览器与派发之前。焦点仍无专门工具，只能用 key Tab/Shift+Tab 或页面内 JS，并以页面读回为准。
