# Web T1 · 能力与验收台账

> 开发事实记录，不是运行时可用性声明。先确认当前 Agent 注册表，再读 browser_capabilities 实际 available/unavailable/unsupported。静态 implemented-not-verified/partial/verified 不可直接当作 available。
> 2026-10-31 收口轮：新增第 9 个工具 `browser_http_request`（独立 HTTP 请求，`web.t1.http-request`），并补 `browser_state` 错误时效、Chrome 解析、`pointerType:pen` 映射与 P22/P20 验收；契约见仓库 docs/t1-http-request.md。**本轮实现与验收状态以仓库 runs/ 报告为准**：P22 通过前 http-request 只算 implemented-not-verified，真实宿主第九工具的注册/调用仍需单独证据（不能拿 P21 校验器或旧 3081 报告冒充）。

## P0采集验收（2026-11-01）

**T1随机flake校正**：同一行为实现仅persist描述不同，`tests/acceptance/runs/2026-11-01T05-49-22-590Z-100191/run-report.json`为22/22、324/324、exit0；最终文案代码复跑 `tests/acceptance/runs/2026-11-01T05-59-53-185Z-105978/run-report.json`为21 PASS/1 FAIL、323/324通过、1 failed、exit1。唯一失败P21-host-output-contract→“失败网络条目（loadingFailed）可快照且无undefined字段”，actual仅3条成功记录；`tests/acceptance/runs/2026-11-01T04-30-43-916Z-53146/run-report.json`基线同项失败。Lead归类既有环境随机flake、非P0回归，但不能写PASS或全绿。验收需串行，仍可能复现。T2最终代码 `tests/acceptance/runs/2026-11-01T06-01-14-788Z-107358/run-report.json`为37/38+1 NOT_RUN、260/260、exit0；capture05-52-05仍14/14、142/142。

**当前默认暂存修订**：persist:boolean默认false；out/persist:true/非空env任一触发persistent（env绝对有效根优先，否则cwd；路径relative/ephemeral=false）；其余含legacy无cwd写实例级staging（absolute/root=staging/ephemeral=true），dispose清理。file含pathKind/persistence/root/ephemeral；observed仅persistence/relativePath|null，不暴露绝对路径。持久无根root_unknown；暂存失败file=null+既有capture_file_unavailable，不新增词。

Lead串行最终 **14/14、142/142、0失败、exit0**：`tests/acceptance/runs/capture-p0-2026-11-01T05-52-05-302Z-104057/report.json`；T1 `tests/acceptance/runs/2026-11-01T05-49-22-590Z-100191/run-report.json` **22/22、324/324**；T2 `tests/acceptance/runs/2026-11-01T05-50-44-987Z-101531/run-report.json` **37/38+1 NOT_RUN、260/260**。C14共23项、C1增加2项；unit26/26/faults16/16由Lead交接，Skill/registry待文档后复核。tmp不可写真实失败、SIGKILL残留、宿主/provider仍NOT_RUN。以下115/117为修订前历史。

**最终Lead独立串行复跑**：两次13/13、117/117、0 failed、exit0，报告 `tests/acceptance/runs/capture-p0-2026-11-01T05-15-01-055Z-85097/report.json`、`tests/acceptance/runs/capture-p0-2026-11-01T05-15-05-476Z-85616/report.json`；T1 `tests/acceptance/runs/2026-11-01T05-15-09-827Z-86138/run-report.json` 22/22、324/324；T2 `tests/acceptance/runs/2026-11-01T05-17-06-786Z-87684/run-report.json` 37/38+1 NOT_RUN、260/260。其它检查26/26单测、16/16 faults、25/25 skill、17/17 registry，均exit0（Lead交接）。当时必需项117，当前暂存修订必需项142，保留历史不外推默认路径。

权威接口见仓库docs/capture-p0.md；只增强既有browser_screenshot，不新增工具，当前总数16（T1九个+T2七个）。执行者真实Chromium+fake ctx三次各13/13 probes、115/115 requiredChecks、0 failedChecks、exit0：

- `tests/acceptance/runs/capture-p0-2026-11-01T04-57-34-532Z-65733/report.json`
- `tests/acceptance/runs/capture-p0-2026-11-01T04-58-28-002Z-66463/report.json`
- `tests/acceptance/runs/capture-p0-2026-11-01T04-58-32-550Z-66980/report.json`

公开maxDelta增量后 `tests/acceptance/runs/capture-p0-2026-11-01T05-09-04-665Z-79630/report.json` **13/13、117/117、0 failed、exit0**；checked=false时null，checked=true为相对首像素最大通道差，白页0/内容页255；此前115项为增量前报告。

主回归 `tests/acceptance/runs/2026-11-01T04-59-29-531Z-68121/run-report.json` 22/22、324/324、exit0。执行者交接：P0单测26/26、T2 37/38+1 NOT_RUN/260/260、runtime-faults16/16、check-skill25/25。默认1280×800、scale2=2560×1600、101×50@1.11=112×56；headless=true/source=userAgent；CRC/hash/0600/no-clobber与文档坐标通过。C13 scroll/viewport/red/green/fixed rect前后完全不变，仅限本页本版本未观测到持久变化。

P0真实宿主重载/新会话及provider视觉/最终图像尺寸仍NOT_RUN；canvas/WebGL内部源位图限制、瞬时LBI与本地TOCTOU边界不因报告消失。附件compare='attachment-metadata'缺字段不能推断相同；原始PNG落盘不等于完整证据包。

## 现行能力

| ID | 工具 | 工程状态 | 契约与验收边界 |
| --- | --- | --- | --- |
| web.t1.navigate | browser_navigate | verified（报告覆盖路径） | P2/P19 正负例：errorText/NAV_FAILED、loopback、策略与 Document 重定向；不保证加载完成 |
| web.t1.runtime-evaluate | browser_eval | verified（报告覆盖路径） | P3：主世界可序列化值、Promise、undefined、EVAL_ERROR 描述/栈/details；无 frame 选择 |
| web.t1.input | browser_input | partial | P5/P17/P20：点击/text 副作用、面板同锁；N2 的 modifiers（数组或 CDP 位掩码）、key 的 virtualKeyCode/autoRepeat/unmodifiedText/commands/location/isKeypad、mouse 的 buttons/pointerType；**本轮补页面真值**：`pointerType:'pen'` 已按 CDP 字符串枚举派发并读回 `PointerEvent.pointerType==="pen"`（修前数字 1/2 会被 CDP 拒绝为 INTERNAL）；`commands` 以 selection 读数对照、`unmodifiedText` 以 beforeinput/最终 value 对照，平台无可见效果时记 INCONCLUSIVE/platform-no-visible-effect。applied 仍是数量，无焦点管理工具与 M3 高层动作 |
| web.t1.network-observe | browser_network | partial | P6/P15：响应与 loadingFailed、URL 脱敏、其他 owner BUSY、不启动；无头/正文；Map/timer 细节专项待最终汇总 |
| web.t1.cssom | browser_computed_style | verified（报告覆盖路径） | P4：首匹配 5 属性、完整样式、TARGET_NOT_FOUND error 对象；无伪元素/iframe/Shadow DOM 目标 |
| web.t1.screenshot | browser_screenshot | partial（P0覆盖路径verified，宿主/provider待验） | 当前P0 C1–C14为14/14、142/142，115/117见上方历史；persist默认false，默认staging/absolute/dispose清理，out/persist:true/非空env触发persistent/relative；file四新字段及observed无绝对路径；连续scale1–4、文档region/out、CRC/尺寸/全量均匀统计、JSON mapping、0600/no-clobber、delivery metadata与封闭warnings；原始base64/hash兼容，provider/真实宿主P0仍NOT_RUN |
| web.t1.runtime-state | browser_state | verified（报告覆盖路径） | P1/P2/P15：诊断不夺 owner、document.title/SPA 刷新、连接与关闭状态；本轮新增 `errorAt/errorActionId/errorTarget`（成功的页面/网络操作清空错误，诊断与 HTTP 不清），读到错误先看 `errorAt` 判新旧 |
| web.t1.capability-discovery | browser_capabilities | partial | P1/P14/P15：能力发现工具（第 8 个；本轮工具面 9 项）、不启动/不占租约、三态枚举与 unsupported；web.t1.http-request 报 available + limits.httpRequest；P0 C11通过capture/limits.capture、observed首次null/仅真实截图、不启动 |
| web.t1.http-request | browser_http_request | verified（P22 覆盖路径；真实 Agent 会话 NOT_RUN） | 契约 docs/t1-http-request.md；P22 95/95、P21 23/23：Host 独立 HTTP(S)，不启动 Chromium/不占租约/不进页面队列；默认 GET、5s 总超时（上限 20s）、64 KiB 保留上限（上限 1 MiB）、默认不跟随重定向（上限 5 跳）；每跳复用 validateTarget（HTTPS→HTTP 降级拒绝）；禁 Host/content-length/transfer-encoding/connection/cookie/accept-encoding 等头、无 cookie jar；响应 headers 小写→string[]、utf8/base64、bodyBytes/bodyTruncated、脱敏；新错误码 HTTP_TIMEOUT/HTTP_FAILED/HTTP_REDIRECT_LIMIT；P22 通过前不标 verified |
| web.t1.viewport-control | 无 | unsupported | Agent 无视口工具；默认 1280×800/DPR1，面板 200–4096 |
| web.t1.browser-extras | 无 | unsupported | 无下载/上传/Cookie 导出/多标签/frame 选择 |

## 所有权、错误与证据

按 DSH 工作区 page 隔离：同一时刻一个 Chromium/profile，每工作区独立 page/URL/viewport/history/网络缓冲/串行队列/lease；Cookie/localStorage/cache 共享，不是安全隔离。exec 身份先解析到工作区（exec.agent.session.header.cwd → sessions → persistence；workspaceRegistry 精确 realpath），同工作区 lease 15s idle/进行中保持、其他 session BUSY；不同工作区互不影响；缺身份走 legacy，disposed 只释放对应 owner。state/capabilities 可诊断并带 scope；页面工具与面板同工作区同串行队列；CDP 已发出后 abort 在队列内关闭该 page 才放锁。`browser_http_request` 是独立分支：不 ensure/run/claim/touchAgent、不建 page/entry、不写页面 error、不回到页面队列；仅复用 action 证据、错误包装与 lossless 投影。

所有工具返回并 render actionId/sessionId/startedAt/finishedAt/target/args 摘要。返回值在 Host 侧统一做 lossless JSON 投影后才交给宿主：`undefined` 属性缺省（`browser_eval` 的 undefined 结果没有 `value` 字段）、非有限数字转 `null`、`attachment` 投影为 `{attachmentId,mediaType,bytes,width,height,name}`；否则宿主 `snapshotJsonValue` 会以 `INVALID_TOOL_OUTPUT: value is not lossless JSON` 拒绝整次调用。工具失败 BrowserError 带 code/category/retryable/details 与 [CODE] 证据消息；eval/style 操作失败返回 error 对象；HTTP 保留 error 字符串并加分类字段。核心码见 [操作契约](../../references/contracts/operation.md)。

目标允许 loopback；默认阻断 RFC1918（DSH_UI_TESTING_ALLOW_PRIVATE=1 可开放）、metadata/unspecified/multicast/credentials/已配置 DSH_WEB_URL origin。Document 拦截与 DNS 校验仍不构成子资源/页面 fetch/WebSocket 的完整网络沙箱，存在 rebinding/时序风险。URL 脱敏不覆盖所有业务敏感内容。

## 历史证据（仅供追溯）

M0–M2 前历史套件最初 P1–P10 为 10 组/61 项，随后帧管线扩为 P1–P13、13 组/92 项；两次均有 P2 标题恒空与不可达导航静默成功两处失败，exit=1。旧 check-skill 为 19/19、check-skill-registry 为 17/17；旧截图 PNG/viewport 正常但 render 未显示图像；旧网络 token 未脱敏。详见仓库 docs/t1-infrastructure-audit.md 与 tests/acceptance/evidence/ 的历史记录。

这些计数与 F1–F9 是历史快照。旧主验收 19/19 组、149/149 项（报告 `tests/acceptance/runs/2026-10-31T04-59-24-426Z-79195/run-report.json`）已被新套件取代：`node tests/acceptance/run.mjs`，generatedAt `2026-10-31T09:11:49.006Z`，报告在仓库 `tests/acceptance/runs/2026-10-31T09-11-49-006Z-151626/run-report.json`，21/21 组、196/196 必需项、0 failed/skip/finding、exit=0（新增 P20 输入修饰键/功能键、P21 宿主 lossless JSON 契约）。环境 Node v22.23.3/Linux，真实 Chromium + sandbox-fallback wrapper、fake Cordis ctx。P17 证明 1s 内 ABORTED、关闭旧浏览器后返回、重新懒启动及面板队列；P18 启动失败无 profile 遗留；Lead 汇报 cleanup leftoverProfile/PID=0。结构检查 check-skill 23/23、exit=0。主 3080 不动，真实宿主本轮用 3081 隔离实例；不得把 fake 附件保存/render 通过等同 provider 图像可见。

## 未验证与未实现

真实 Agent screenshot/provider 图像可见性仍 NOT_RUN；本轮新增的 `browser_http_request` 在**真实宿主 Agent 会话**中的注册/调用尚未验证（P22 为 fake ctx + 本地网络；P21 为真实宿主校验器；隔离实例 HTTP 回归只证明 apply() 加载，不等于工具调用）。本轮 P22/P20 具体计数与结论以仓库 `tests/acceptance/runs/` 报告为准，报告未覆盖的路径不得推定通过。

T2已实现（验收与构建范围见T2台账）；T3/T4、下载/上传/Cookie 导出/多标签/frame 级目标、Agent 视口工具、跨工作区 Cookie/localStorage/IndexedDB/cache 隔离、M3 高层输入、完整网络沙箱、独立 JSONL 证据包仍未实现。面板 WS/HTTP 预览与 metrics 不构成 T3/T4 证据。真实 Agent exec 身份链与两个 GUI 工作区的 3081 证据见 docs/workspace-isolation.md。

## 变更日志

- 2026-11-01（P0）：按上方三份真实报告同步连续scale/region/out、capture/observed、八错误/八warnings与安全落盘；保留partial的provider/真实宿主/瞬时布局/TOCTOU边界，不把采集升级为T3。

- 2026-10-31（收口轮）：工具面 8→9，新增 `browser_http_request`（独立 HTTP API）；`browser_state` 增错误归属字段并改成功操作清空语义；Chrome 惰性解析；`pointerType:pen` 映射修正；P20 补 commands/unmodifiedText/pen 页面真值。旧的「独立 HTTP 客户端 unsupported」表述废止。
- 2026-10-31：保留旧 T1 与帧管线验收为历史来源；M0–M2 按 Lead 契约同步为待验收，避免沿用旧 verified 或旧失败作为当前结论。
