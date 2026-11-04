# Web T1 · 能力台账

> 工程状态记录，**不是运行时可用性声明**。先确认当前 Agent 注册表，再读 `browser_capabilities` 的实际 `available/unavailable/unsupported` 与真实调用结果。

## 工具与状态

| 能力 | 工具 | 状态 | 边界 |
| --- | --- | --- | --- |
| web.t1.navigate | browser_navigate | verified | 仅 HTTP(S)；校验目标/DNS/最终 URL 与 `errorText`；不保证 load complete |
| web.t1.eval | browser_eval | verified | 顶层主世界、可序列化值；页面异常返回 error 对象 |
| web.t1.screenshot | browser_screenshot | verified | scale 0.1–4（省略跟随 `view.scale`）、canvas CSS region、PNG 校验、默认暂存 |
| web.t1.input | browser_input | verified | 原始鼠标/滚轮/键盘事件；`applied` 只是数组长度，不证明生效 |
| web.t1.network | browser_network | verified | 元数据环形缓冲（默认 50、上限 300）；深度抓包见网络 P0 七工具 |
| web.t1.computed-style | browser_computed_style | verified | 首个匹配元素；不证明视觉结果 |
| web.t1.http-request | browser_http_request | verified | Host 独立 HTTP(S)，不启动浏览器、不占租约；`ok:true` 不等于 2xx；无 cookie jar |
| web.t1.viewport | browser_viewport | verified | `get` 只读缓存诊断；`set` 页面操作（队列 + 租约 + CAS） |
| web.t1.state | browser_state | verified | 诊断信息，不保证新鲜；不启动浏览器 |
| web.t1.capability-discovery | browser_capabilities | verified | 三态与 limits 报告；诊断调用不启动浏览器、不建目录 |

## 证据与错误

- 统一 envelope：`actionId/sessionId/startedAt/finishedAt/target/args/scope`；失败抛 `BrowserError` 并在 `details` 带证据。
- 结构化错误：`INVALID_ARGUMENT`、`BUSY`、`ABORTED`、`CDP_TIMEOUT`、`CDP_DISCONNECTED`、`UNSUPPORTED`、`RUNTIME_LIMIT`。
- 截图无附件服务时走 base64-fallback，并如实标注降级。

## 未覆盖

- 多标签/窗口、frame 级目标、上传下载、Cookie 导出。
- 跨工作区登录态隔离（Cookie 与存储由 Chromium profile 共享）。
- provider 图像可见性：返回附件不等于模型以原始分辨率看到图像。
