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

## 共享视口验收（2026-11-01，第 10 个 T1 工具）

**已实现并通过进程内 Lead/执行者验收（verified，覆盖路径）**：新增工具 `browser_viewport`（能力 `web.t1.viewport`，工具面 29 → 30 = 10 T1 + 7 T2 + 6 T3 + 7 network），契约见仓库 `docs/viewport-control.md`（2026-11-01 Lead 冻结）。每个工作区 Runtime 一份权威 `view={version,mode,x,y,width,height,scale,source,revision}`（文档 CSS px）；面板与 Agent 读写同一对象，顶层 `viewport={width,height}` 只是别名。

- **范围**：`x/y` 是页面顶层滚动位置（`Page.getLayoutMetrics` 的 cssLayoutViewport 实测回读，不是窗口位置/缓存页面值，页面自主滚动会以 `source=page`、`revision+1` 回显）；`width/height` 整数 200–4096，只有宽高变化才发 `Emulation.setDeviceMetricsOverride({deviceScaleFactor:1,mobile:false})`；`mode` 由宽高精确匹配派生（wide 1920×1080 / landscape 1024×768 / tablet 768×1024 / phone 393×852，否则 custom），`set mode` 与 width/height 互斥；`scale` 0.1–2（10–200%）是 Host 权威显示比例，也是省略 scale 的截图默认密度，**不是 DPR、不是页面 zoom、不做设备模拟**。
- **get/set 分类**：`get` 是只读缓存诊断（不接受其他字段；不 ensure、不发 CDP、不进队列、不占租约、不改 recent/error；可读他人租约下的缓存，`viewMeta.stale` 明示不新鲜）；`set` 是页面操作（纯预检 → 串行队列 → 懒启动 + single-owner-lease，scale-only 也算页面操作）。`expectedRevision` 在队列内复查，冲突抛 `VIEWPORT_CONFLICT`（HTTP 409），patch 零应用且不覆盖 page `lastError`。
- **HTTP 双形状**：`POST /viewport` 同时接受 legacy `{width,height}`（保持 Number/round/clamp 与旧 `viewport` 返回）与 v1 `{version:1,...patch,expectedRevision?,originId?}`（与工具同严格校验）；`/state`、`/frame`、ensure/navigate/reload/history 与 `browser_state` 都附加安全 `ui.view/ui.viewMeta/ui.observed`。
- **截图与 T3**：`browser_screenshot` 显式 `scale` 0.1–4，省略时在调用内解析为当前 `view.scale`（cold 为 1）；`capture.request` 增 `scaleSource`/`viewRevision`，`mapping` 增逐轴 `cssPerPixel` 与 `scrollAtCapture`；两轴期望像素 <1 时提前 `INVALID_ARGUMENT(empty-output-dimensions)`。T3 的 `Source.live` 省略 scale 时跟随本次调用冻结的 `view.scale`，`act` 再采样沿用原采集比例。
- **面板**：尺寸栏新增 X/Y（aria-label `视口 X 坐标（像素）` / `视口 Y 坐标（像素）`），五个数值框支持滚轮（X/Y/W/H 10，Shift 100，Alt 1；比例 5/10/1，Alt 优先；Ctrl/Meta 被面板吞掉且不走 number 原生步进），120ms 合并，fit 只是本地显示偏好（不发布），坐标映射用 painted rect（object-fit contain + naturalWidth/Height，不乘宿主 DPR）。

**验收（同一最终代码；计数以 Lead 终验报告为准）**：

- Host：`node tests/acceptance/viewport.mjs` → **probes 11/11、requiredChecks 107/107、failedChecks 0、findings 1（info）、exit 0**（连跑两次同结果），报告 `tests/acceptance/runs/viewport-2026-11-01T16-13-39-758Z-559039/report.json`、`tests/acceptance/runs/viewport-2026-11-01T16-13-53-771Z-559488/report.json`。覆盖 V1 注册面、V2 冷启动诊断零启动、V3 预设/部分 patch/同值不增 revision/两 scope/非法参数零 CDP、V4 scale-only 布局不变与 override 计数、V5 x/y 实测与 clamp/单轴、H4b 页面滚动回显、V6 CAS+BUSY、V7 legacy/v1 HTTP、V8 默认与显式截图比例、V9 T3 live 缺省比例、V10 lossless JSON 与关闭清理。
- GUI（隔离 DSH + 无头 Chrome，连跑两次同结果）：`node tests/acceptance/viewport-gui.mjs` → **73/73 PASS、0 FAIL、5 NOT_RUN、exit 0**，报告 `tests/acceptance/runs/viewport-gui-2026-11-01T16-09-04-966Z-554236/run-report.json`、`tests/acceptance/runs/viewport-gui-2026-11-01T16-10-07-443Z-555424/run-report.json`；证据 `tests/acceptance/evidence/viewport-gui-2026-11-01T16-09-04-966Z/`（4 PNG + SUMMARY）。
- 回归同一时点：T1 `run.mjs` **23/23、349/349、exit 0**（`tests/acceptance/runs/2026-11-01T16-00-44-334Z-546478/run-report.json`）；`capture-p0.mjs` **14/14、142/142、exit 0**（`tests/acceptance/runs/capture-p0-2026-11-01T15-40-32-906Z-519432/report.json`）；`runtime-faults` **16/16**（交接）。**全量回归已由 Lead 独立终验跑完（终版代码，2026-11-01 16:19–16:45，串行单驱动者，全部 exit 0）**：viewport 11/11 probes + 107/107 required；GUI 73/73 PASS + 0 FAIL + 5 NOT_RUN；run.mjs 23/23 + 349/349（P21 flake 未复现）；capture-p0 14/14 + 142/142；t2-structured 37/38 + 1 NOT_RUN（C38 套件边界）+ 261/261；t3-vision 56/56 + 391/391 + notApplicable 3；network-p0 52/52 + 266/266 + 8 NOT_RUN；network-chain 12/12 + 49 + 1 NOT_RUN；workspace-isolation 77/77；runtime-faults 16/16；check-skill 30/30；check-skill-registry 19/19。
- **5 条 GUI NOT_RUN（原样保留，不算通过）**：V7.10 agent 归因（GUI 只能走 HTTP v1，Host 记为 source=gui；归因由 Host H2 覆盖）、V8.5 letterbox 零派发（实测帧无 band）、V10.4 旧 Host 降级（套件只起新 Host）、V10.5 expectedRevision 冲突（Host H5 覆盖）、V10.6 宽高变更几何屏障只到 best-effort（≤250ms，帧协议未扩展，记 partial）。
- **仍未验证**：**真实宿主 3080（pid <pid>）未重启**，30 工具与 `ui.view`、`browser_viewport` 的真实 Agent 会话调用均 **NOT_RUN**；隔离 DSH GUI 是验收证据，不能冒充 3080。H9 screencast ACK/帧递增时序未单独实测。`expandViewPatch` 带 `mode` 时丢弃同传 `x/y/scale` 的偏差已由 task-7 修复（只改透传 + viewport.mjs V3 增 6 项断言，不改 UI/API 语义），修复后 Host 套件为 11/11、107/107。

## 现行能力

| ID | 工具 | 工程状态 | 契约与验收边界 |
| --- | --- | --- | --- |
| web.t1.navigate | browser_navigate | verified（报告覆盖路径） | P2/P19 正负例：errorText/NAV_FAILED、loopback、策略与 Document 重定向；不保证加载完成 |
| web.t1.runtime-evaluate | browser_eval | verified（报告覆盖路径） | P3：主世界可序列化值、Promise、undefined、EVAL_ERROR 描述/栈/details；无 frame 选择 |
| web.t1.input | browser_input | partial | P5/P17/P20：点击/text 副作用、面板同锁；N2 的 modifiers（数组或 CDP 位掩码）、key 的 virtualKeyCode/autoRepeat/unmodifiedText/commands/location/isKeypad、mouse 的 buttons/pointerType；**本轮补页面真值**：`pointerType:'pen'` 已按 CDP 字符串枚举派发并读回 `PointerEvent.pointerType==="pen"`（修前数字 1/2 会被 CDP 拒绝为 INTERNAL）；`commands` 以 selection 读数对照、`unmodifiedText` 以 beforeinput/最终 value 对照，平台无可见效果时记 INCONCLUSIVE/platform-no-visible-effect。applied 仍是数量，无焦点管理工具与 M3 高层动作 |
| web.t1.network-observe | browser_network | partial | P6/P15：响应与 loadingFailed、URL 脱敏、其他 owner BUSY、不启动；无头/正文；Map/timer 细节专项待最终汇总 |
| web.t1.cssom | browser_computed_style | verified（报告覆盖路径） | P4：首匹配 5 属性、完整样式、TARGET_NOT_FOUND error 对象；无伪元素/iframe/Shadow DOM 目标 |
| web.t1.screenshot | browser_screenshot | partial（P0覆盖路径verified，宿主/provider待验） | 当前P0 C1–C14为14/14、142/142，115/117见上方历史；persist默认false，默认staging/absolute/dispose清理，out/persist:true/非空env触发persistent/relative；file四新字段及observed无绝对路径；显式scale 0.1–4（省略时跟随共享view.scale，cold为1；两轴<1提前INVALID_ARGUMENT）、文档region/out、CRC/尺寸/全量均匀统计、JSON mapping、0600/no-clobber、delivery metadata与封闭warnings；原始base64/hash兼容，provider/真实宿主P0仍NOT_RUN |
| web.t1.runtime-state | browser_state | verified（报告覆盖路径） | P1/P2/P15：诊断不夺 owner、document.title/SPA 刷新、连接与关闭状态；本轮新增 `errorAt/errorActionId/errorTarget`（成功的页面/网络操作清空错误，诊断与 HTTP 不清），读到错误先看 `errorAt` 判新旧 |
| web.t1.capability-discovery | browser_capabilities | partial | P1/P14/P15：能力发现工具（第 8 个；本轮工具面 10 个 T1 / 总 30）、不启动/不占租约、三态枚举与 unsupported；web.t1.http-request 报 available + limits.httpRequest，web.t1.viewport 报 available（get 只读 / set 页面操作，其他 owner 持租约时 set BUSY、get 仍可读）；P0 C11通过capture/limits.capture、observed首次null/仅真实截图、不启动；本轮新增 viewport 段与 limits.viewport（比例 0.1–2、预设、stale/settle、dsf=1），capture 报 defaultScaleSource=view.scale、scaleRange 0.1–4 |
| web.t1.http-request | browser_http_request | verified（P22 覆盖路径；真实 Agent 会话 NOT_RUN） | 契约 docs/t1-http-request.md；P22 95/95、P21 23/23：Host 独立 HTTP(S)，不启动 Chromium/不占租约/不进页面队列；默认 GET、5s 总超时（上限 20s）、64 KiB 保留上限（上限 1 MiB）、默认不跟随重定向（上限 5 跳）；每跳复用 validateTarget（HTTPS→HTTP 降级拒绝）；禁 Host/content-length/transfer-encoding/connection/cookie/accept-encoding 等头、无 cookie jar；响应 headers 小写→string[]、utf8/base64、bodyBytes/bodyTruncated、脱敏；新错误码 HTTP_TIMEOUT/HTTP_FAILED/HTTP_REDIRECT_LIMIT；P22 通过前不标 verified |
| web.t1.viewport | browser_viewport | verified（覆盖路径；5 条 GUI 子项与真实宿主 NOT_RUN） | 共享视口 get/set：get 只读缓存诊断（不启动/不占租约/stale 明示），set 页面操作（宽高才发 metrics override，scale-only 不改页面几何）；x/y 为文档 CSS 滚动位置实测回读，scale 0.1–2 且是省略 scale 的截图默认密度；expectedRevision → VIEWPORT_CONFLICT(409) 零应用。验收：viewport.mjs 11/11 probes、107/107 requiredChecks、exit 0；viewport-gui.mjs 73/73 PASS、5 NOT_RUN、exit 0。详见上方「共享视口验收」 |
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

T2已实现（验收与构建范围见T2台账）；T3 已实现并验收；网络 P0 七工具已实现并验收；共享视口（browser_viewport）已实现并通过进程内 + 隔离 GUI 验收，但真实宿主未重启（NOT_RUN）。T4、下载/上传/Cookie 导出/多标签/frame 级目标、跨工作区 Cookie/localStorage/IndexedDB/cache 隔离、M3 高层输入、完整网络沙箱、独立 JSONL 证据包仍未实现。面板 WS/HTTP 预览与 metrics 不构成 T3/T4 证据。真实 Agent exec 身份链与两个 GUI 工作区的 3081 证据见 docs/workspace-isolation.md。

## 变更日志

- 2026-11-01（共享视口）：工具面 29→30，新增第 10 个 T1 工具 `browser_viewport`（`web.t1.viewport`）；scale 0.1–2 为 Host 权威显示比例与默认截图密度、显式截图 0.1–4、fit 仅本地、get 只读 / set 页面操作、expectedRevision CAS → VIEWPORT_CONFLICT(409)、帧协议未扩展；验收 viewport.mjs 11/11、107/107、exit 0 与 viewport-gui.mjs 73/73 PASS / 5 NOT_RUN / exit 0；真实宿主 30 工具与 ui.view 仍 NOT_RUN。

- 2026-11-01（P0）：按上方三份真实报告同步连续scale/region/out、capture/observed、八错误/八warnings与安全落盘；保留partial的provider/真实宿主/瞬时布局/TOCTOU边界，不把采集升级为T3。

- 2026-10-31（收口轮）：工具面 8→9，新增 `browser_http_request`（独立 HTTP API）；`browser_state` 增错误归属字段并改成功操作清空语义；Chrome 惰性解析；`pointerType:pen` 映射修正；P20 补 commands/unmodifiedText/pen 页面真值。旧的「独立 HTTP 客户端 unsupported」表述废止。
- 2026-10-31：保留旧 T1 与帧管线验收为历史来源；M0–M2 按 Lead 契约同步为待验收，避免沿用旧 verified 或旧失败作为当前结论。
