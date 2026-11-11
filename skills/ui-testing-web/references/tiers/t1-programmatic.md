# T1 · 程序化接口（M0–M2）

T1 共 10 个工具（含独立 HTTP `browser_http_request` 与共享视口 `browser_viewport`）。注册表决定可调用名字，`browser_capabilities` 报真实运行态三态；静态工程状态不能当 available。详细返回见 [操作契约](../contracts/operation.md)。

| 操作 | 工具 | 关键边界 |
| --- | --- | --- |
| 导航 | browser_navigate | errorText/最终 URL/目标与 DNS/Document 重定向校验，不保证 load complete |
| JS | browser_eval | 顶层主世界，可序列化值；页面异常 error 对象含描述/栈/位置 |
| 截图 | browser_screenshot | P0：显式 scale 0.1–4（省略时跟随共享 view.scale，cold 1）、region画布CSS px、includeAnnotations?:boolean=false、out相对.png；true 按同一 region/scale 叠加 Host 已接受的六形状，不含草稿/工具栏，证据 capture.annotations；默认截图与 T3/T4 原始源不含面板标注；PNG CRC/尺寸/全量均匀统计、JSON mapping、安全落盘与附件metadata证据；保留base64/附件fallback；provider另验，无T3分析 |
| 共享视口 | browser_viewport | `action:"get"`=只读缓存诊断（不启动/不发 CDP/不占租约，`stale` 明示）；`action:"set"`=页面操作（宽高才发 metrics override，scale-only 不改页面几何）；`x/y` 为文档 CSS 滚动位置实测，宽高 200–4096 整数，scale 0.1–2（也是省略 scale 的截图默认密度），`expectedRevision` → `VIEWPORT_CONFLICT` 零应用 |
| 输入 | browser_input | applied 是数量，不证明生效；支持 modifiers（数组或 CDP 位掩码）、key 的 virtualKeyCode/autoRepeat 等、mouse 的 buttons/pointerType。**有按键状态机**：`keyDown` 记位、`keyUp` 清位，按住 Shift 后其它事件自动带位（要复现"没带位"的坏行为用 `synthesizeModifiers:false`）；`mouse` 给 `deltaX/deltaY` 就是相对移动（虚拟光标，clamp 在视口内）；返回 `held` 可核对残留按键，导航会清空。无焦点管理工具与高层动作 |
| 网络（旧工具） | browser_network | 响应与 loadingFailed 元数据、URL 脱敏、有界 300 条；**无头/正文**；其他 owner BUSY。深度采集/控制看下一条 |
| 网络（P0 七工具） | browser_network_session · events · detail · trace · control · evidence · subscribe | `action` 必填；HTTP/HTTPS 请求响应与头/体（按需、配额截断、读不到 `available:false`）、WebSocket 双向帧、SSE、same-origin iframe/OOPIF/Worker、统一时间轴与分析聚合、业务步骤链路、拦截/限速/断连/重放/Mock、JSONL+HAR 与多 Agent 独立订阅；只读/诊断不启动浏览器，`session.start` 与需 page 的 `control` 才懒启动；`G1.5` partial（same-origin iframe + dedicated worker 已实证；OOPIF partial；shared/service worker 不采集）、HTTPS 未独立验收（`limits.network.https="mechanism-identical"`）、`responseModification` 条件支持、真实宿主上的行为需单独证据|
| CSSOM | browser_computed_style | 首匹配，未命中 error 对象；无伪元素/iframe/Shadow DOM 内部定位 |
| 状态 | browser_state | document.title 刷新与 owner 诊断，不启动/不占租约；error/errorAt/errorActionId/errorTarget 由成功页面操作清空 |
| 独立 HTTP | browser_http_request | Host HTTP(S) 客户端：不启动浏览器/不占租约；默认 GET、5s 总超时、64KiB 保留上限、不跟随重定向；每跳复验目标、无 cookie jar、新错误码 HTTP_TIMEOUT/HTTP_FAILED/HTTP_REDIRECT_LIMIT；`ok:true` 非 2xx |
| 能力 | browser_capabilities | 实际 available/unavailable/unsupported 与原因限制，不启动/不占租约；按段报 T1/T2（7+1）/T3（6+1）/network（7+1，聚合 `web.network.p0`，含必报标量 `limits.network.https:"mechanism-identical"` 与并列的 `responseModification` 实测值），并报 `limits.structuredGui`、`vision`/`limits.vision`、`network`/`limits.network`、`dynamic`/`limits.dynamic` |

同一时刻一个无头 Chromium/profile；每个 DSH 工作区一个 page。single-owner-lease 按工作区，15s idle、进行中保持、缺 exec 走 legacy、disposed 只释放对应 owner。页面操作与 network（含 network P0 的 session/control 变更）受同工作区租约，network P0 只读/离线动作不加租约；state/capabilities 可诊断。同工作区页面工具与面板同串行队列；已发 CDP 命令后 abort 先关闭该 page 再放锁，后续可懒启动。Cookie/存储共享，非安全隔离。

默认视口1280×800/受控DSF1，共享视口由 `browser_viewport` 读写；P0 scale不改viewport/DSF，输出round(css×scale)且≤16M像素。region为画布坐标（O=0时同文档），T2 bbox/输入为视口坐标，按scroll转换。页面DPR读取失败null、headlessSource依据product/userAgent；capture JSON mapping不返回函数。persist:boolean默认false；默认staging（包括legacy无cwd）绝对路径/0600/no-clobber/dispose清理，out/persist:true/非空env才persistent相对路径；file含pathKind/persistence/root/ephemeral，observed不含绝对路径；持久无根报root_unknown、tmp失败仅warning。安全规则见 [安全边界](../core/safety.md)；observed不启动、只代表上次真实截图。页面工具可懒启动，network/state/capabilities 不启动。CDP 超时、断连和取消有分类错误，pending timers 清理；close 清空网络/请求/URL/标题/帧并清进程/profile。

安全策略见 [安全边界](../core/safety.md)：loopback 允许，RFC1918 默认阻断，可显式环境变量开放；Document/DNS/最终 URL 校验不等于对子资源/页面 fetch/WebSocket 的完整网络沙箱，仍有 rebinding 风险。

所有工具 action 元数据进入 render；操作成功与断言分离。网络元数据不证明完整接口契约（接口契约用 `browser_http_request`），CSSOM 不证明视觉，原始截图可见不等于已得到 T3/T4 结论。元素语义与元素级交互优先走 T2（`browser_snapshot`/`browser_click`/`browser_type`/`browser_fill_form`/`browser_wait_for`，见 [T2 表](t2-structured.md)）；下载/上传/Cookie 导出、多 target/frame（iframe 内部）选择仍不支持；运行态以 `browser_capabilities` 与实际调用为准。
