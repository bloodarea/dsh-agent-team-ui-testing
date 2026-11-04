# 代码结构

> 索引：[docs/index.md](index.md)

```text
package.json          DSH bundle 清单：dsh.bundle.patch + dsh.client（platform: web）；files 含 index.js/client.js/frame-*/browser-safety.js/capture-p0.js/**network-p0.js**/vision-t3.js/vision-baseline.js/**dynamic-t4.js**/cordis.patch.yml/locale/icon/skills
cordis.patch.yml      插入一行 plugin：id = ui-testing-browser
index.js              Host 半边：BrowserHost（单 Chromium/profile、多 page）、按 DSH 工作区的 RuntimeRegistry、租约/串行队列、scoped HTTP 路由、独立 HTTP 客户端、35 工具（10 T1 + 7 T2 + 6 T3 + 7 network + 5 T4）、每 Runtime 的权威共享 view（宽高/x/y/canvasX/Y/比例/来源/版本 + 实时观测）、**P0-D 面板标注文档（`annotations` 存储 + `POST /annotations` 唯一写面 + `state/ui` 只读投影 + documentKey 轮换）**与内置 Skill；并承担网络全事件采集（Runtime 级 Network/Fetch 订阅、按需 body、子目标 setAutoAttach）、screencast 帧源协调与 T4 动态会话/控制/关联，以及 browser_capabilities.network 与 .dynamic 报告
browser-safety.js     BrowserError/CDP、错误分类（含 REF_STALE/TARGET_NOT_UNIQUE/NOT_INTERACTABLE/WAIT_TIMEOUT、T3 的 VISION_* 码与网络 P0 的 NET_* 码）、取消/定时器清理、URL 脱敏与目标/DNS 校验
network-p0.js         P0 网络纯 JS 核心：事件/会话存储、标准化与有界配额、分析与统计、业务链路窗口、拦截/限速/重放规则、JSONL/HAR 导入导出与证据索引、订阅游标（零 npm 依赖，不直接持有 CDP）
capture-p0.js         P0 采集基础设施：PNG 结构/CRC/解码、全量均匀/透明统计、尺寸校验、纯 JSON 映射投影、安全路径与原子 no-clobber 写入
vision-t3.js          T3 纯算法：PNG RGBA 编解码、crop/resize/预处理/标注、analysis/Sobel、yiq-v1 diff、识别/模板、几何映射、参数校验、VisionProductStore
vision-baseline.js    T3 受管基线：scopeHash 根、不可变 revision、head 规范 JSON、CAS 提交/墓碑、只读 list/get、故障注入点
dynamic-t4.js         T4 纯核心（零 CDP/零依赖/零 fs）：DynamicFrameStore（有界帧存储、淘汰、dropped/evicted/gaps、encoded/rgba 双 hash）、DynamicEventLog 与逻辑/墙钟时间锚点、七类确定性运动原语、runMotionAssertions、correlateDynamic 六向关联与候选预算诊断、baseline JPEG 解码与 region 裁剪
frame-source.js       Host 帧缓存：最新帧/元数据/捕获统计（与传输、UI 解耦）
frame-push.js         Host 同源 WebSocket 推帧：单 upgrade dispatcher、按 scope 绑定 pusher、握手、合并推送、背压丢帧、鉴权、清理
client.js             全部 UI（React，无 JSX，用 h()）；内含 UI-free 的 createFrameTransport；共享 view 的采纳/草稿/滚轮/fit/painted-rect 坐标映射/帧几何屏障；P0-D 标注模式（入口/横栏、SVG 画布坐标层、模式总闸与生命周期）
locale/{en,zh}.json   插件显示名与描述
icon.svg              插件图标
skills/ui-testing/    内置 Skill（SKILL.md + references/examples/templates/knowledge/manifests）
tests/ui_test_exam/   插件自身能力的对照测试靶机（20 处预设缺陷），见该目录 README
tests/ui_test_fixture/ 自建授权本地靶机（确定性断言值），供验收脚本使用；含 WEB-T4 靶机 `web-t4-visual.html` / `web-t4-network.html`（T4 已实现，见 t4-dynamic-behavior.md / t4-implementation-contract.md）
tests/acceptance/     真实验收脚本：fake ctx 驱动 index.js、帧推送/轮询、能力台账检查、Skill 注册检查；含 T4 靶机验收 `t4-visual-fixtures.mjs` / `t4-network-fixtures.mjs` 与 T4 实现验收 `t4-dynamic.mjs`（40 条 DV/DN/DC）
reference/            本地参考资产（Skill 模板包 v1.1）**不入库**：已进 .gitignore，见 skill-authoring.md
docs/                 项目记忆（本目录）；按工作区隔离的契约见 workspace-isolation.md
```

## T2 结构化 GUI 在 index.js 内的职责

- **Snapshot/Ref 引擎**：`Accessibility.getFullAXTree` 建语义树并按规则压缩/截断；给可解析 Element 分配单调 `eN`，ref 表按 Runtime 隔离、2000 项 LRU、跨快照按 `(documentEpoch, backendNodeId)` 复用；跨文档提交/上下文丢失/close 清空。
- **目标解析与 actionability**：`ref`/唯一 `selector` → `DOM.resolveNode` + 身份复验 → 单次 `Runtime.callFunctionOn` 读 NodeState（可见/启用/可编辑/checked/expanded/focused/bbox/hit-test，含 open shadow 的 composed 命中）→ 自动滚动 + 稳定性确认 → CDP 真实输入派发。
- **证据**：统一 `evidence.version=1` 结构（provenance/targets/before/after/dispatch/networkDelta/escalation/incomplete），成功放结果、失败放 `BrowserError.details`；输入文本与可编辑 value 永不回显。
- **能力报告**：`browser_capabilities` 报 T1/T2/T3/network/T4 各段工具项（注册表共 35 工具）、`web.t1.viewport`、`web.t2.*`、`web.t3.*`、`web.network.*`、`web.t4.*` 与 `viewport/limits.viewport`、`limits.structuredGui/limits.vision/limits.network/limits.dynamic`、`dynamic` 段（tools/sources/adapters/correlation/limits/observed）。

## T3 静态视觉职责

权威契约见 [t3-vision.md](t3-vision.md)。Host 层只做注册、队列/租约、live 采集与 CDP 现场安全校验；纯算法与基线存储分别在 `vision-t3.js`、`vision-baseline.js`。

- **六工具**：`image`（source→crop→resize→preprocess→analysis/recognize→annotations→编码交付）、`find`（color/components/edges/template）、`compare`（YIQ diff/相似度/区域高亮/mask）、`act`（截图坐标的 CDP 输入）、`baseline`（list/get/create/update/delete）、`check`（回归 + 六类缺陷）。
- **源图**：只接受 `live`（P0 原始截图，`file:null`）/`product`（每 scope 的 `VisionProductStore`，16 张/128MiB/32MiB/16M px，重启失效）/`baseline`；不接受任意路径/base64。product store 与页面生命周期分离，page 导航/关闭后仍可离线分析，但 `act` 资格失效。
- **act 六步**：现场 layout/scroll/visualViewport 复验 → 同矩形重采样并比对原始 PNG 解码 RGBA hash → 视口校验 → `DOM.getNodeForLocation`（文档 CSS 整数，仅命中校验取整）+ connected/disabled/inert（composed 祖先）+ 两帧稳定 → CDP `Input.dispatchMouseEvent`（连续坐标，finally 释放）→ 单次 after product；失败一律零派发。
- **基线**：`<持久根>/output/vision-baselines/<scopeHash>/<name>/{images,heads}`；只 create/update mkdir；`link` no-clobber 为提交点；HEAD 为连续 revision + 父 hash 链；delete 为墓碑；读取校验 PNG hash/元数据，损坏报 READ_FAILED。
- **缺陷**：只消费调用方显式、带 provenance 的 facts（`trusted:false`），不重查 DOM；required 缺事实 → INCONCLUSIVE/BLOCKED，advisory 最多 WARN。
- **能力报告**：`browser_capabilities.vision`（version/algorithmVersion=`t3-v1`/tools/sourceKinds/limits/observed）与 `web.t3.*`；诊断调用不启动浏览器、不建目录、不生成 product。

## P0 采集职责

权威契约见 [capture-p0.md](capture-p0.md)/[canvas-viewport.md](canvas-viewport.md)。Runtime 做单次 CDP 截图与环境读回；O=0 时是旧文档 clip 单次 PNG（不重编码），O≠0 时先截 canvas∩content 页面帧、再白底合成（重编码，`capture.canvas.composite=true`），工具层编排 PNG 校验、尺寸拒绝、`capture.version=1`、文件发布和附件元数据比较；算法与同步文件操作委托 `capture-p0.js`。公开 mapping 经纯 JSON 投影，不返回函数。`browser_capabilities.capture/limits.capture` 不启动浏览器，observed 仅来自所属 Runtime 上次真实截图；PNG证据与JPEG预览分离。默认文件写插件实例级暂存，dispose清理；out/persist:true/非空env才持久到env或cwd根。file用pathKind/persistence/root/ephemeral区分；仅staging返回绝对路径，observed只保留persistence与relativePath（暂存为null）。当前 C1–C15 共 **15/15、162/162**（画布轮 [报告](../tests/acceptance/runs/capture-p0-2026-11-01T20-18-32-415Z-768943/report.json)）；此前 14/14、142/142 与下方 115 项为历史。P0 三次进程内真实 Chromium 验收各 13/13、115/115（[报告](../tests/acceptance/runs/capture-p0-2026-11-01T04-58-32-550Z-66980/report.json)），宿主重载/provider 仍 NOT_RUN。

## P0 网络职责

权威契约见 [network-p0.md](network-p0.md)。分工：`index.js` 只做 Runtime 级 CDP 采集（`Network.*` 全事件、`Fetch` 单一 dispatcher、按需 `getRequestPostData/getResponseBody`、`Target.setAutoAttach` 子目标）、7 个工具的注册/队列/租约/懒启动与 `browser_capabilities.network`；事件模型、配额/背压、分析、链路、规则、导入导出与订阅游标等纯逻辑在 `network-p0.js`（零 npm 依赖、不持有 CDP 句柄，可单测）。

- **采集范围**：HTTP/HTTPS 请求与响应（头/体按需，配额截断）、WebSocket 双向帧、SSE 事件、同主 page 的 same-process iframe / OOPIF / dedicated·shared·service worker（**G1.5 为 partial**：popup 仍被既有目标策略阻断，不采 popup、不跨 scope 聚合）、生命周期状态机、重定向链（`hop` 递增）、initiator。
- **事件与证据**：`NET_PROTOCOL_VERSION=1` 标准化事件入环形缓冲（`maxEvents/maxBodyBytes/maxTotalBytes/maxWsFrames`），淘汰/丢弃/截断一律计数并可查 `integrity`；JSONL 为保真格式、HAR 只保证 1.2 子集（未知数值用 `-1`）。默认脱敏（URL 敏感 query、敏感头、JSON/form 敏感字段 → `***`），原值不进事件/证据/错误。
- **控制**：`Fetch.enable` 只有一份配置，Document 导航守卫与用户规则共用单一 dispatcher，每个 paused 请求恰好一次终结；`session.stop/reset` 逐条终结 held 请求但**不 `Fetch.disable`**。
- **能力报告**：`browser_capabilities.network` 报 `version/tools/session/limits/observed` 与 `web.network.*` 三态；`limits.network` 里 **`https = "mechanism-identical"` 与 `responseModification` 并列**（前者固定口径、后者按 Chrome 实测支持与否报 `true|false`）；诊断调用不启动浏览器、不建目录、不生成证据文件。
- **未验证**：网络 P0 的 `control`/`replay`/证据/订阅真宿主行为与 provider/长连接稳定性未验（2026-11-02 真实宿主已冒烟 `session`/`events`/`detail`，[证据](../tests/acceptance/evidence/viewport-real-host-2026-11-02.md)）；HTTPS 子项与 `modify-response` 子项按 [network-p0.md](network-p0.md) §10 记 NOT_RUN。

## 共享视口职责

权威契约见 [viewport-control.md](viewport-control.md)（P0-C 共享视口）与 [canvas-viewport.md](canvas-viewport.md)（P0-D 混合画布，独立验收）。

- **Host（`index.js`）**：`VIEW_PRESETS`/`VIEW_LIMITS` 常量；`Runtime.view` 与 `get viewport()` 别名、`observed`、`viewMeta` 与 `viewOriginId`；`viewProjection/observedProjection/viewMeta/viewSnapshot` 纯 JSON 投影；`#readViewMetrics`（`Page.getLayoutMetrics` css* 字段 + DPR 读回）、`#scrollViewTo`（instant scrollTo）、`#waitTwoFrames`、`#settleViewObservation`（两帧 + 有界稳定采样）；`refreshViewObservation(Soon)` 的合并/节流/single-flight 后台观测与 `#commitObservedPosition`（只回显 x/y，`source:'page'`）；`applyView`（队列内 CAS → ensure → 条件 override → 条件 scroll → 提交；`canvasX/canvasY` 的 S_target/clamp/O、保留旧 O、返回 offset/content）；legacy `applyViewport` 保持旧 round/clamp；`/viewport` 双形状路由与 `ui.view/viewMeta/observed` 投影；`browser_viewport` 注册（`readOnly(args)`/`preflight(args)` 让 get 走缓存诊断、预检零 CDP）；`browser_capabilities.viewport`/`limits.viewport`（含 canvas）；`ui.canvas` 投影；截图与 T3 live 的默认比例解析；`Runtime.screenshot({canvas:true})` 合成 seed。
- **`capture-p0.js`**：`scaleMin=0.1`、`minOutputPixels=1`、`hasPositiveOutputSize()`、`encodePngRgba/intersectRects/composeCanvasImage`；mapping 仍是纯 JSON（canvas/contentRect/blank 透传，逐轴比例由 Host 用真实 PNG 尺寸补上）。
- **`vision-t3.js`**：`validateSource` 保留"省略 scale"，范围下界 0.1；由 Host 在调用内用冻结的 `view.scale` 解析；canvas mappingAfterCrop、负 region 语法、blank act 零派发。
- **`browser-safety.js`**：`VIEWPORT_CONFLICT`（state / retryable）。
- **Client（`client.js`）**：`ViewLimits`/`WHEEL_STEPS`（10/100/1 与 5/10/1，Alt 优先）、`paintedRect()` 与 `frameWheelDelta()` 纯几何、`viewOf()/viewCompanionsOf()` 解析 `ui.view`、`acceptView/adoptView/syncViewDrafts/clearCaughtUpDrafts`（草稿保护、外部变更取消 fit）、`queueViewPatch/flushViewPatch`（120ms 合并、按字段 patch、v1 带 `expectedRevision`、旧 Host 走 legacy 体）、`frameGeometry/geometryMatches/inputGeomReady`（≤250ms best-effort 屏障）、指针/滚轮/拖拽映射与释放，以及尺寸栏 X/Y 输入与 flex-wrap。
- **帧（画布 v2 起改）**：`frame-source.js`/`frame-push.js` 新增 `scrollX/scrollY`（metadata 优先，缺失用采集时实测 S）；O=0 仍沿用旧 250ms best-effort 屏障，O≠0 改用 fail-closed 并可用 `/screenshot {canvas:true}` seed 恢复。

## P0-D 标注职责（`client.js` + `index.js`）

权威契约见 [annotation-p0d.md](annotation-p0d.md)。标注是 P0-D 的一个切片：**v1 为纯客户端视图层**；**v2（2026-11-02 第二轮）增加 Host 只读投影**，让 Agent 能读到标注用于定位问题——工具面仍 30，截图/T3 语义与目标页 DOM/CSS 不变。

- **入口/横栏**：工具栏地址栏与尺寸调整之间的“标注”按钮（画笔图标）；独立 `.utb-annot-bar` 横栏含七工具（圆形/矩形/线段/箭头/画笔/文字/**橡皮擦**）、填充/外框、颜色、粗细与最右的**清除画布**按钮。打开面板即进入标注模式，再次点击退出。
- **模式总闸**：`annotRef` 与 React state 同步；进入前结束页面拖动、清 pan/zoom 意图、`panMode=false`；所有 `img`/overlay 的 pointer/wheel/keydown 处理器与 `sendEvents` 在模式内统一拦截，页面零派发；地址/导航/刷新/更多/环境选择/尺寸入口禁用，已展开尺寸栏控件全禁用。
- **SVG 画布层**：z-index 2（文字编辑器 z3），覆盖未平移的 `paintedRect`，`viewBox=Cx Cy W H`、`preserveAspectRatio=none`；几何以画布 CSS px 存储，映射见契约 §3；负 C/blank 可绘制，letterbox 不起笔；模式外 `pointer-events:none`、不占 Tab，标注仍可见。
- **绘制/擦除/清除（`client.js`）**：活动手势与点数组放 ref（rAF 更新独立草稿），提交后进入已完成列表；普通帧刷新保留；**导航（documentKey 轮换）清空**；样式在起笔时快照；橡皮擦按 `Path2D`/段距/文字 `getBBox()` 命中（`r=max(线宽/2,6)` 画布 px，每次只删最上层一个）；清除画布清空已完成+草稿/编辑并立即发布空文档（保留模式与样式）。
- **面板交互（v4，2026-11-03）**：标注栏 `填充|外框` 与尺寸栏 `拖拽|适应窗口|默认` 均为 `div.utb-seg` 分页选择器（单一真源 + 恰好一个 `aria-pressed`，`data-utb-annot-seg` / `data-utb-panfit`）；`annotStyleMode` 驱动 fill/stroke 二选一；`sizingRef` 让尺寸调整模式挡住标注入口（`data-utb-annot-entry`）；`ENV_DEFAULTS` 决定初始化与切环境的默认尺寸（只发 width/height）；标注栏非 passive wheel 监听驱动 `data-utb-annot-field=width` 的粗细步进（±1/Shift ±5/Alt ±1）。
- **保留与隔离（v3，2026-11-02 第三轮）**：`client.js` 在 `acceptRemote` 里按 `D=(scope.id,runtimeId,documentKey,pageGeneration,documentEpoch)` **水合 `ui.annotations`**（同 D 只采纳更大 revision，render gate 遮旧 scope 列表）；scope/卸载/切页签**不再发 release/空文档**；卸载把未确认内容交给模块级 **retained queue** 立即 flush；发布者身份用 `sessionStorage`（key=版本前缀+scope.id+runtimeId+surface）复用 `{panelId, lastAllocatedClientRevision}` 并保持单调；ACK/409/重试/回调全部按 mount generation+scopeEpoch+D 归属，迟到的旧工作区回包不改当前状态。文档仍按 Runtime（=工作区）在 Host 侧一份，导航换文档。
- **Agent 可见面（`index.js`）**：`Runtime` 存“最近接受的面板标注文档”（软限额 128 shapes/512 点每笔/8192 点/200 字符/64KiB、确定性裁剪）；唯一写面为仅认证 scoped `POST /plugins/ui-testing/annotations`（262144 字节有界读取、严格校验、409 `annotation-context-stale`、clientRevision 幂等与 panel 水位）；`state().annotations`（→ `browser_state.annotations`）与认证 `ui.annotations`/`ui.annotationContext` 同源；documentKey 在导航/同文档 URL/close/CDP 断连时轮换并清空；`browser_capabilities.annotations`/`limits.annotations` 声明读取方式与限额（不新增工具）。
- **验收**：`tests/acceptance/viewport-gui.mjs` 的 V15（v1）与 V16（v2）、`tests/acceptance/viewport.mjs` 的 A1–A5 探针（隔离 DSH + 无头 Chrome/真实 Host，真实 CDP 输入、零派发计数、data/SVG/屏幕三方几何、证据 PNG）。

## client.js 内部结构

1. `CSS` 常量 + 图标
2. `createFrameTransport()` —— 与 UI 无关的传输层：WS 优先、`/frame` 80ms 轮询回退、重连、帧元数据、实测统计
3. `DebugView` 组件 —— 顶部环境栏 / 工具栏（标注入口、尺寸调整）/ 标注栏 / 尺寸栏 / 预览区（含标注 SVG 层）/ 底部状态栏；只消费 transport 的帧与状态；按右侧栏 `sessionId` 或 main 的 MoreRow 捕获 + `recent→runtimeId` binding 固定 scope，隐藏时停播
4. `apply(ctx)` —— 面板、菜单行、右栏页签注册

`DebugView` 与 `MoreRow` 各自渲染一份 `<style>`（原因见 [dsh-integration.md](dsh-integration.md)）。

**2026-11-02 标注模式（P0-D 客户端切片）**：新增工具栏入口与标注横栏、SVG 画布坐标绘制层、模式互斥总闸、文字编辑与生命周期清理；只改 `client.js`，Host 无需重启，**需刷新面板**加载新 bundle。契约 [annotation-p0d.md](annotation-p0d.md)。

**第 8 轮（网络 P0）`client.js` 未动**：网络能力只走 Agent 工具与 HTTP 路由，面板样式/文案/布局保持冻结；因此该轮不需要前端热更新，只有 Host 侧变更需要重启 DSH。

**第 9 轮（共享视口）+ 画布 v2 `client.js` 有改动**：尺寸栏新增 X/Y、五个数值框滚轮、fit 本地显示偏好、painted rect 坐标映射与帧几何屏障、导航链不再隐式 POST 本地尺寸、窄面板 flex-wrap；画布 v2 让 X/Y 绑定 canvasX/Y、裁剪盒+白底合成、输入 `q→p=q+O`、blank 零派发、拖拽写 canvas（空白 overlay）、seed 刷新与 fail-closed。用户明确要求的界面变更；其余视觉/文案/布局仍按冻结约定处理。
