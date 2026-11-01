# T1 Web 已知缺口：部分实现、未实现与未解难点

> 索引：[docs/index.md](index.md) · 更新：2026-10-31（第 4 轮：独立 HTTP API 收口 + 输入/状态/清理修复）
>
> 本文只覆盖 **Web T1 程序化接口**；其他能力与运行环境不在本文范围。
>
> 口径：
>
> - **verified（覆盖路径）**：只在报告覆盖的路径上通过，不代表完整实现。
> - **partial**：工具有，但能力或证据有明确边界。
> - **unsupported**：没有对应工具/能力，必须如实上报，不能拿相邻能力冒充。
>
> 运行时是否 `available/unavailable/unsupported` 以 `browser_capabilities` 的**实际返回**为准；静态台账、docs 与 manifest 都只是开发事实。

## P0 截图更新（2026-11-01）

当前默认暂存、显式持久：persist:boolean=false；out/persist:true/非空env任一才持久，env非法不回退；其余含legacy无cwd均插件暂存，dispose清理。file新增pathKind/persistence/root/ephemeral，持久相对/暂存绝对；capabilities.observed只含persistence/relativePath|null。14/14、142/142（[最终报告](../tests/acceptance/runs/capture-p0-2026-11-01T05-52-05-302Z-104057/report.json)），tmp不可写真实失败/SIGKILL仍NOT_RUN；下方115项为历史。

本文其余第4轮实例/工具数/验收计数为历史快照，现行16工具状态见 [status.md](status.md)。P0权威契约为 [capture-p0.md](capture-p0.md)：截图增加连续scale1–4（1.11合法）、文档CSS region、相对out、PNG CRC/尺寸拒绝、≤16M全量均匀/透明统计、安全0600/no-clobber落盘与附件metadata比较；不是T3判断。真实Chromium+fake ctx三次各13/13、115/115（[报告](../tests/acceptance/runs/capture-p0-2026-11-01T04-58-32-550Z-66980/report.json)），T1回归22/22、324/324（[报告](../tests/acceptance/runs/2026-11-01T04-59-29-531Z-68121/run-report.json)）。仍未验证：真实宿主P0重载/provider视觉、瞬时布局影响；canvas源位图限制与本地TOCTOU边界仍在。原始PNG落盘不等于独立JSONL证据包。

## 0. 一分钟结论

- **T1 五项主功能已全部有实现**：
  - JS 执行、CSSOM：verified（覆盖路径）。
  - 原生事件、网络抓包：partial（边界见 §1）。
  - **独立 HTTP API：已实现**（`browser_http_request`，契约见 [t1-http-request.md](t1-http-request.md)），P22 95/95 覆盖路径通过；**真实 Agent 会话内调用仍 NOT_RUN**。
- 工具面 8 → **9 个**；`web.t1.http-request` 由 `unsupported` 变为 `available`；`web.t1.viewport-control`、`web.t1.browser-extras` 仍为 `unsupported`。
- 本轮落地契约裁决四项：`browser_state` 错误归属与时效（`error/errorAt/errorActionId/errorTarget`）、`runtime-faults:208` 清理竞态（实现有界重试 + 测试 waitFor）、Chrome 可执行文件解析、`browser_input` 的 `commands`/`unmodifiedText`/`pointerType:pen` 页面级真值（pen 修前被 CDP 拒绝，已修）。
- T1 的主要难点仍是：**跨工作区 Cookie/存储隔离、完整网络沙箱、独立证据包、输入完整性、provider 图像可见性、结构化错误码、帧选择**，以及 Chrome 与 DSH 平台依赖。page/URL/viewport/租约已按工作区隔离。
- 当前实例：**3080 仍是本轮改动前的构建（8 工具，无 `errorAt`/pen 修复）**，需用户重启后才加载本轮终版；新代码已在**隔离实例**加载并通过真实宿主回归（见 §5）。

## 1. T1 工具级状态与缺口

| 能力 / 工具 | 状态 | 已做到 | 缺口（为什么不能当完整能力） |
| --- | --- | --- | --- |
| 导航 · `browser_navigate` | verified（覆盖路径） | URL/DNS/Document 重定向校验、`NAV_FAILED`、错误页检测、最终 URL 校验 | **不保证加载完成**（`Page.navigate` 在 commit 返回）；没有等待元素/等待网络空闲等条件等待；子资源不经过导航策略；只支持 http/https |
| JS 执行 · `browser_eval` | verified（覆盖路径） | 主世界表达式、Promise、可序列化值、`undefined`、错误栈与行列信息 | **无 frame 选择**；受页面同源策略约束；大对象/类实例只能靠可序列化投影；不是 DOM 操作 API |
| 原生事件 · `browser_input` | partial | CDP 真实 mouse/wheel/key/text；`modifiers`（数组或位掩码）、`virtualKeyCode`、`autoRepeat`、`location`、`isKeypad`；**本轮修好 `pointerType:pen`**（原实现传数字 1/2 被 CDP 拒绝为 INTERNAL，现按 `mouse|pen` 字符串派发，页面可读回 `PointerEvent.pointerType==="pen"`）；整批先校验后派发 | **无焦点管理工具、无 M3 高层动作**；`applied` 只是数量；`commands`（`selectAll` 已由页面 selection 读数验证）与 `unmodifiedText` 的**特有效果不可观察**，按 `INCONCLUSIVE/platform-no-visible-effect` 记录；无 IME/组合输入保证；无触屏/触控笔真实目标 |
| 网络抓包 · `browser_network` | partial | CDP Network 事件、响应状态、`loadingFailed`、URL 脱敏、有界 300 条、跨 session BUSY | **无请求/响应头与正文**；**无拦截/改写/Mock/限速**；WebSocket/SSE 帧不做内容解析；不是 HAR/证据包；记录从运行时启动开始 |
| 独立 HTTP · `browser_http_request` | verified（P22 覆盖路径；真实 Agent 会话 NOT_RUN） | Host 侧 node:http/https：默认 GET、5s 总超时（上限 20s）、64 KiB 保留上限（上限 1 MiB）、默认不跟随重定向（上限 5 跳）；每跳复用目标策略；HTTPS→HTTP 降级拒绝；无 cookie jar、危险头零派发；响应 headers 小写→string[]、敏感头 `["***"]`、URL 脱敏；utf8/base64、bodyBytes/bodyTruncated、不自动解压；`HTTP_TIMEOUT/HTTP_FAILED/HTTP_REDIRECT_LIMIT`；不启动 Chromium、不占租约、不进页面队列、不写页面 error | 不是完整网络沙箱（无 DNS pinning/代理隔离/全局配额）；不保证目标业务授权；正文与未知业务头仍可能敏感；**未在真实 Agent 会话内调用过**；HTTPS 降级用例仅在探针内用自签名证书 |
| CSSOM · `browser_computed_style` | verified（覆盖路径） | 选择器首匹配元素的指定/完整 computedStyle；`TARGET_NOT_FOUND` 错误对象 | **只读 computedStyle**；**只取首个匹配**；无伪元素、iframe、Shadow DOM 目标；无布局盒模型/CSS 规则列表 |
| 截图 · `browser_screenshot` | partial（P0采集覆盖路径通过，provider/宿主待验） | PNG/base64/hash/附件兼容；连续scale、文档CSS region、尺寸/CRC/均匀统计、安全相对路径落盘；capture与capabilities.observed，证据见上方P0更新 | 不自动按元素/整页推导region；无像素差异或视觉判定；canvas内部位图不会新增细节；附件metadata不自证provider可见性；C13不排除瞬时布局影响，TOCTOU非完整隔离 |
| 运行态 · `browser_state` | verified（覆盖路径） | 运行/关闭、`document.title`（含 SPA 刷新）、视口、`seq`、owner/单租约、脱敏 URL/activity/error；本轮新增 `errorAt/errorActionId/errorTarget`，成功的页面/网络操作清空错误，诊断与 HTTP 不清；诊断不夺 owner | 错误归属只在页面/网络操作层（导航守卫异步错误 `errorActionId=null`）；`url` 是脱敏值，真实地址只在认证 GUI 的 `ui.address`；不提供 DOM/网络细节 |
| 能力发现 · `browser_capabilities` | partial | 9 个 T1 三态、`unsupported` 项、`limits.httpRequest`、owner 冲突时页面类 `unavailable`、HTTP 恒 `available` | 是**声明**不是行为证明；台账/测试/工具面变更可能短暂不同步；不能替代实际调用验证 |

## 2. T1 未实现的扩展能力

- **Agent 视口控制**（`web.t1.viewport-control`）：没有视口工具；视口预设只在面板（默认 1280×800、DPR 1，面板 200–4096）。属 T1 扩展，不在本轮功能范围。
- **浏览器扩展操作**（`web.t1.browser-extras`）：无下载/上传/Cookie 导出/多标签/frame 目标选择。
- **M3 高层动作**：无按选择器点击/输入、条件等待、拖拽等封装，只有原始事件注入。
- **焦点管理工具**：仍没有独立焦点工具；用 Tab/Shift+Tab 或页面内 JS，并以页面读回为准。

## 3. T1 尚未解决的缺陷 / 风险

| 项 | 现状 | 影响 | 备注 |
| --- | --- | --- | --- |
| provider 图像可见性 | 截图工具能返回合法 attachment，但**没有正式验收**证明 provider 一定把 image block 交给视觉模型 | 不能宣称“截图被视觉模型看到了”；只能宣称“工具返回了合法 attachment” | 需 provider 侧专项验收；HTTP、P21、PNG hash 都不覆盖 |
| 真实 Agent 会话内第九工具 | 隔离宿主 `apply()` 加载成功、HTTP 路由与输入回归 22/22；但**没有真实 Agent 会话调用过 `browser_http_request`** | 只能宣称“工具已注册、宿主可加载、P22/P21 覆盖”，不能宣称“真实会话可用” | 3080 仍是旧构建；重启 3080 后在新会话调用一次即可补证 |
| 结构化 `info.code` | DSH 只对 `HarnessError` 实例写结构化错误码；该类不由 tools 包公开导出，插件也没有依赖/peer | 工具错误只能靠 `[CODE]` 前缀 + 返回字段，不能用宿主结构化错误码 | 平台依赖，需公开 API 或批准 peer 依赖；见 [t1-issues-and-solutions.md](t1-issues-and-solutions.md) §3.3 |
| `browser_state.error` 过期 | 本轮已修：错误四字段 + 成功操作清空 + 时间/目标/action 归属；诊断与 HTTP 不清 | 读到错误时仍需看 `errorAt` 判断新旧；导航守卫异步错误没有 actionId | 契约见 [t1-http-request.md](t1-http-request.md) §9.1 |
| `runtime-faults:208` flake | 本轮已修：实现 `rm` 有界重试（5×50ms，失败记日志与 `cleanupError`）+ 测试 `waitFor` 3s；连跑 3 次 16/16 | 后续复跑仍可能遇到环境型 DNS 失败（本机 fake-ip 把 `.invalid` 解析成 `198.18.0.28`，测试已用注入 `resolve` 固定） | 契约见 §9.2 |
| 地址栏草稿被 shell 对话框取消 | DSH Web shell 登录/onboarding 对话框异步挂载时 Modal `autoFocus` 抢焦点，blur 按设计取消草稿 | 面板刚打开第一次输入可能丢草稿；这是交互风险，不只是测试脚本问题 | 验收脚本已硬化；**产品侧未改**（会涉及行为/视觉评审） |
| Chrome 解析缓存不失效 | 解析结果按 `DSH_UI_TESTING_CHROME` 值缓存；PATH 变化或二进制被删不会自动重解析 | 极端部署变更后需重启插件/宿主 | 本轮新增的已知边界 |
| HTTPS→HTTP 降级用例 | 仅探针内临时接受自签名证书（`NODE_TLS_REJECT_UNAUTHORIZED=0`，立即恢复） | 生产代码未降低 TLS 校验；可信 CA 路径未单独验 | 测试环境限制 |

## 4. T1 技术难点与依赖

- **跨工作区 Cookie/存储隔离**：已按 DSH 工作区隔离 page/URL/viewport/history/网络缓冲/队列/租约，但同一 Chromium/profile 下 Cookie、localStorage、IndexedDB、cache 仍共享；真实 Agent exec 身份链与两个 GUI 工作区已在隔离 3081 验收（见 workspace-isolation.md），provider 图像可见性仍 NOT_RUN。
- **完整网络沙箱**：只拦 Document 导航并校验 DNS；子资源、页面 `fetch`、WebSocket 不受策略约束；独立 HTTP 也只做每次派发的目标校验，不做 DNS pinning/代理隔离。也防不住 DNS rebinding 时序。
- **独立证据包**：当前证据依赖会话日志 + render 文本 + `tests/acceptance/evidence/` 整理件，不落 JSONL/独立文件包；落盘涉及 workspace 写入、清理与隐私授权。
- **输入完整性**：`commands`/`unmodifiedText` 在部分平台没有页面可见效果；IME/组合输入、触屏/触控笔、焦点管理都没有行为级保证；`pointerType:pen` 只证明事件类型，不证明物理触控笔/压感/触屏。
- **网络观察的价值边界**：为了隐私不采正文/头；接口断言必须用独立 HTTP API，不靠扩张网络抓包。
- **provider 可见性在宿主侧**：插件能证明“返回合法 image block”，不能证明 provider/VLM 一定消费；需要真实 provider 专项测试。
- **frame 选择**：当前只有主页面上下文；跨 iframe/跨源 frame 的 eval/输入/CSSOM 都需要额外 target 模型。
- **平台依赖**：Chrome 解析已改为 env → 既有 `/opt` → PATH（无 macOS 之外的额外猜测），spawn/启动超时映射为 `UNSUPPORTED`/`CDP_TIMEOUT`/`CDP_DISCONNECTED`；`Connection.requestRejection`、attachments 等宿主 API 仍没有 `engines.dsh` 约束，DSH 升级可能影响 T1。
- **测试基础设施**：本机 fake-ip DNS 会让 `.invalid` 解析到 `198.18.0.28`，DNS 失败路径必须用注入 `resolve` 测；GUI 验收需要处理 shell 对话框抢焦点。

## 5. 当前 T1 实例与验证状态

| 实例 | 状态 | 说明 |
| --- | --- | --- |
| 3080（用户主实例） | **旧构建**：pid `247914`，19:36:05 启动（本轮改动前） | 仍有 8 个工具、无 `errorAt`、无 pen 修复；本轮新代码需重启后才生效。不要用 3080 的旧行为判断本轮实现 |
| 隔离宿主（本轮临时 `DSH_HOME`，端口 3081） | **已完成回归后停止**（端口释放） | 用工作区内**复制**的 web profile（不软链真实 profile）加载工作区代码；`verify-3081` **22/22 PASS、exit=0**（[报告](../tests/acceptance/runs/host-3081-1793452433416/report.json)），证明真实宿主可加载 9 工具插件、HTTP 鉴权/地址/输入回归未退化 |

- 本轮主机侧验收（Lead 独立复跑）：`run.mjs` **22/22 组、303/303 必需项、0 failed/skip、exit=0**，报告 [runs/2026-10-31T13-08-56-816Z-277736](../tests/acceptance/runs/2026-10-31T13-08-56-816Z-277736/run-report.json)（执行者独立跑同版本为 [13-06-46-778Z-275714](../tests/acceptance/runs/2026-10-31T13-06-46-778Z-275714/run-report.json)）。1 条 advisory finding：`P20-unmodifiedText-inconclusive`。
- 分组：P1 10、P2 11、P3 6、P4 3、P5 5、P6 7、P7 6、P8 10、P9 7、P10 5、P11 13、P12 6、P13 12、P14 7、P15 14、P16 12、P17 5、P18 1、P19 17、P20 28、P21 23、**P22 95**。
- 故障注入：`runtime-faults.test.mjs` **16/16、exit=0**（Lead 复跑 1 次；执行者连跑 3 次均 16/16）。
- 结构检查：`check-skill.mjs` **23/23**、`check-skill-registry.mjs` **17/17**，均 exit=0。
- `tests/acceptance/runs/` 被 `.gitignore` 忽略；可审查证据在 `tests/acceptance/evidence/` 与报告路径。

## 6. 汇报纪律（T1 相关）

- 不要把 `browser_eval` 里的 `fetch` 当独立 HTTP API；接口契约用 `browser_http_request`。
- 不要把 `ok:true` 当 HTTP 2xx；404/500 是正常返回，业务结论看 `status`。
- 不要把 single-owner-lease 当跨工作区 Cookie/存储隔离；它只防同工作区并发写。
- 不要把 Document 拦截或独立 HTTP 的目标校验当完整网络沙箱。
- 不要把 fake-ctx 验收、P21 校验器或隔离宿主 `apply()` 加载当真实 Agent 会话验收。
- 不要把 `browser_state.url` 的脱敏值当真实地址；真实地址只在认证 GUI 的 `ui.address`。
- 不要把 3081 的 HTTP/GUI 证据当 provider 图像可见性。
- 不要把截图返回成功当界面验收通过。
- 不要把 `unmodifiedText` 的 INCONCLUSIVE 写成“已验证”。

## 7. 建议处理顺序（建议，不是承诺）

1. **重启 3080 后的真实会话补证**：在新 Agent 会话调用一次 `browser_http_request`、确认 9 工具可见与 `errorAt`/pen 生效。
2. **provider 图像可见性专项**：需要 provider/VLM 侧证据，单独验收。
3. **T1 稳定性剩余**：GUI 地址栏与 shell 对话框的交互风险（产品侧需视觉/行为评审）；frame-push 半开连接回收（既有缺口，本轮未改）。
4. **T1 安全/隔离**：跨工作区 Cookie/存储隔离、完整网络沙箱、独立证据包（按授权与成本排期，见 [t1-issues-and-solutions.md](t1-issues-and-solutions.md) §3.2）。
5. **平台适配**：Chrome 解析缓存的失效策略、DSH `engines.dsh`/兼容矩阵。

## 8. 证据与相关文档

- 独立 HTTP 契约与本轮四项裁决：[t1-http-request.md](t1-http-request.md)
- 能力台账：[skills/ui-testing/knowledge/web/t1-capability-ledger.md](../skills/ui-testing/knowledge/web/t1-capability-ledger.md)
- 现行契约与验收状态：[t1-m0-m2-contract.md](t1-m0-m2-contract.md)
- 缺陷解决状态与决策记录：[t1-issues-and-solutions.md](t1-issues-and-solutions.md)
- 当前实现/生效方式：[status.md](status.md)
- 怎么验证：[verification.md](verification.md)