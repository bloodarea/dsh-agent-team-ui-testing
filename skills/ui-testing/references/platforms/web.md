# Web 平台操作指南（M0–M2 + T2）

Web 已有 **22 个工具**：T1 9 个（含独立 HTTP 请求 `browser_http_request`）+ T2 7 个（`browser_snapshot`、`browser_click`、`browser_type`、`browser_scroll`、`browser_fill_form`、`browser_node_state`、`browser_wait_for`）+ T3 6 个（`browser_vision_image`、`browser_vision_find`、`browser_vision_compare`、`browser_vision_act`、`browser_vision_baseline`、`browser_vision_check`）。T3 静态视觉已进程内验收（56/56 criteria、389/389 required）并在 3080 真实宿主会话完成六工具冒烟，**T4 动态视觉仍未实现**；provider 图像可见性仍未验证（记录 `tests/acceptance/evidence/t3-real-host-2026-11-01.md`）。按当前注册表与 `browser_capabilities` 实际三态选路，不把文档或 manifest 当运行态证明。工具映射见 [T1 表](../tiers/t1-programmatic.md) 与 [T2 表](../tiers/t2-structured.md)，返回见 [操作契约](../contracts/operation.md)。

同一时刻最多一个无头 Chromium/profile；每个 DSH 工作区一个 page，默认 1280×800/DPR1。single-owner-lease 按工作区：空闲 15s、进行中保持、缺 exec 走 legacy、disposed 只释放对应 owner；同工作区其他 session 页面/network/T2 BUSY，不同工作区独立。面板与 Agent 在同一工作区同 page/串行队列；Cookie/localStorage/cache 共享，不是安全隔离。state/capabilities 不启动、不占租约。

导航检查 errorText/最终 URL，不保证加载完成；标题从 document.title 刷新。目标/DNS/Document 重定向校验允许 loopback，阻断默认私网、metadata/unspecified/multicast/credentials/已配置宿主 origin。它不是子资源/页面 fetch/WebSocket 的完整网络沙箱，仍有 rebinding 风险。详细环境变量与风险见 [安全边界](../core/safety.md)。

网络记录响应/失败元数据、URL 脱敏、有界，close 清空；无头/正文。截图保留 base64 与时间/hash/附件 ID，可选附件 image block，无服务 base64-fallback 文本；provider 图像可见性另验，不提供 T3 差异分析。所有工具有 action 元数据并 render。P0 screenshot可选连续scale1–4、文档CSS region、相对.png out，新增capture v1（CRC/尺寸/全量均匀统计/JSON mapping/file/delivery/warnings）；DSF固定1，输出round(css×scale)，最多16M像素；输入/T2 bbox为视口CSS px，转换按scroll。能力capture/limits.capture不启动，observed仅真实截图。新增persist:boolean=false；默认实例级staging绝对路径、dispose清理，out/persist:true/非空env才persistent相对路径。file含pathKind/persistence/root/ephemeral，observed只persistence/relativePath|null；legacy默认暂存、持久无根root_unknown，暂存失败仅既有warning。安全规则见 [安全边界](../core/safety.md)，当前P0暂存修订14/14、142/142报告见 [T1台账](../../knowledge/web/t1-capability-ledger.md)；真实宿主P0重载/provider仍NOT_RUN。

**T2 路径**：`browser_snapshot` 拿 `snapshotId/digest/tree/refs` → 用 `ref`（或主文档唯一 `selector`）执行 click/type/scroll/fill_form → 用 `browser_node_state`/`browser_wait_for` 读回并断言。ref 在同一 Runtime 内单调不复用、新快照不自动失效、LRU 2000，跨文档导航/刷新/历史前进后退/关闭即 `REF_STALE`；所有 T2 失败抛 `BrowserError`；无 force/JS click 逃生。T2 工程状态 **verified**（优化构建套件 37/38 通过、必需检查 **260/260**，报告 `tests/acceptance/runs/2026-11-01T03-41-31-025Z-39784/run-report.json`；唯一 notRun 为 C38 套件边界；真实宿主 14/14 记录属优化前构建，优化后待定向复验），详见 [T2 层](../tiers/t2-structured.md) 与 [T2 台账](../../knowledge/web/t2-capability-ledger.md)。

面板 screencast 的 WS 优先/HTTP 回退、metrics 都是预览诊断，不是 Agent 页面证据；内部 HTTP 路由不是 Agent API，不可绕过工具。

须验证：22 工具注册面/诊断不启动、标题/导航/错误、租约/anonymous/disposed/BUSY、面板队列与取消关闭、目标/DNS/Document 重定向、网络失败/脱敏/资源界限、action render、截图附件/fallback/provider、独立 HTTP 的预算/重定向/阻断/取消/零派发、T2 的快照/ref 生命周期/唯一 selector/可信动作/表单/滚动/等待/错误码/证据。实测状态见两个台账，未跑写 NOT_RUN。没有 Agent 视口设置、下载/上传/Cookie 导出、多 target/frame 选择或 T3–T4。
