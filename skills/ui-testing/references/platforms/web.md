# Web 平台操作指南（M0–M2 + T2）

Web 已有 **35 个工具**：T1 10 个（含独立 HTTP `browser_http_request` 与共享视口 `browser_viewport`）+ T2 7 个 + T3 6 个 + 网络 P0 7 个 + T4 5 个，工具名见各层表格与 [工具参考](../../../../docs/tools.md)。T3/T4 已实现，其中 T4 的 40 条门槛尚未全覆盖；provider 图像可见性未验证。按当前注册表与 `browser_capabilities` 实际三态选路，不把文档或 manifest 当运行态证明。

同一时刻最多一个无头 Chromium/profile；每个 DSH 工作区一个 page，默认共享视口 1280×800@100%/DPR1（`browser_viewport` 可改宽高/X-Y/显示比例；比例不改页面 CSS 视口与 DPR）。single-owner-lease 按工作区：空闲 15s、进行中保持、缺 exec 走 legacy、disposed 只释放对应 owner；同工作区其他 session 页面/network/T2 BUSY，不同工作区独立。面板与 Agent 在同一工作区同 page/串行队列；Cookie/localStorage/cache 共享，不是安全隔离。state/capabilities 不启动、不占租约。

导航检查 errorText/最终 URL，不保证加载完成；标题从 document.title 刷新。目标/DNS/Document 重定向校验允许 loopback，阻断默认私网、metadata/unspecified/multicast/credentials/已配置宿主 origin。它不是子资源/页面 fetch/WebSocket 的完整网络沙箱，仍有 rebinding 风险。详细环境变量与风险见 [安全边界](../core/safety.md)。

网络记录响应/失败元数据、URL 脱敏、有界，close 清空；无头/正文。截图保留 base64 与时间/hash/附件 ID，可选附件 image block，无服务 base64-fallback 文本；provider 图像可见性另验，不提供 T3 差异分析。所有工具有 action 元数据并 render。P0 screenshot可选显式scale 0.1–4（省略时跟随共享view.scale）、canvas CSS region（O=0与文档相同；O≠0白底合成）、相对.png out，新增capture v1（CRC/尺寸/全量均匀统计/JSON mapping/file/delivery/warnings）；DSF固定1，输出round(css×scale)，最多16M像素；输入/T2 bbox为视口CSS px，转换按scroll。能力capture/limits.capture不启动，observed仅真实截图。新增persist:boolean=false；默认实例级staging绝对路径、dispose清理，out/persist:true/非空env才persistent相对路径。file含pathKind/persistence/root/ephemeral，observed只persistence/relativePath|null；legacy默认暂存、持久无根root_unknown，暂存失败仅既有warning。安全规则见 [安全边界](../core/safety.md)，

**T2 路径**：`browser_snapshot` 拿 `snapshotId/digest/tree/refs` → 用 `ref`（或主文档唯一 `selector`）执行 click/type/scroll/fill_form → 用 `browser_node_state`/`browser_wait_for` 读回并断言。ref 在同一 Runtime 内单调不复用、新快照不自动失效、LRU 2000，跨文档导航/刷新/历史前进后退/关闭即 `REF_STALE`；所有 T2 失败抛 `BrowserError`；无 force/JS click 逃生。，详见 [T2 层](../tiers/t2-structured.md) 与 [T2 台账](../../knowledge/web/t2-capability-ledger.md)。

**网络 P0 路径（第 8 轮）**：`browser_network_session`（`status` 只诊断、`start` 才懒启动）→ 用 T2/T1 或页面自身产生真实流量 → `browser_network_events`（summary/timeline/aggregate + filter/search/groupBy）→ `browser_network_detail`（按需 requestId/seq 取头/正文/timing/redirects/WS/SSE，读不到就是 `available:false`）→ `browser_network_trace`（步骤窗口、对象传递、跨请求关联、因果；`basis:"temporal"` 不等于因果）→ `browser_network_evidence`（JSONL/HAR 导出、索引、link、integrity）或 `browser_network_subscribe`（多 Agent 各自游标 poll/ack）。控制类 `browser_network_control`（throttle/offline/intercept/hold/replay/mock）需要 page，会懒启动并走该工作区队列与租约；`Fetch.enable` 仍只有一份配置，与既有 Document 导航守卫共用 dispatcher。**只读动作不启动浏览器、默认脱敏、body 读不到不伪造**；子目标按 R1-21：same-origin iframe 与 dedicated worker 已实证，OOPIF partial 未单独验证，shared/service worker 不采集（`subTargets.service_worker="not-collected"`）。

面板 screencast 的 WS 优先/HTTP 回退、metrics 都是预览诊断，不是 Agent 页面证据；内部 HTTP 路由不是 Agent API，不可绕过工具。

须验证：35 工具注册面/诊断不启动、标题/导航/错误、租约/anonymous/disposed/BUSY、面板队列与取消关闭、目标/DNS/Document 重定向、网络失败/脱敏/资源界限、action render、截图附件/fallback/provider、独立 HTTP 的预算/重定向/阻断/取消/零派发、T2 的快照/ref 生命周期/唯一 selector/可信动作/表单/滚动/等待/错误码/证据、network P0 的 7 工具注册/三态/限额、事件 schema 与时间轴、body 三态不伪造、脱敏、配额与 integrity、拦截/限速/重放/Mock 与导航守卫共存、JSONL/HAR 往返、订阅隔离与 pin/gap。没有 Agent 视口设置、下载/上传/Cookie 导出、多 target/frame 选择、popup/多标签采集；T4 的 media 适配器、WebGPU 真实渲染、16ms 闪白采样覆盖仍未验证。
