# 代码结构

> 索引：[docs/index.md](index.md)

```text
package.json          DSH bundle 清单：dsh.bundle.patch + dsh.client（platform: web）；files 含 index.js/client.js/frame-*/browser-safety.js/capture-p0.js/**network-p0.js**/vision-t3.js/vision-baseline.js/cordis.patch.yml/locale/icon/skills
cordis.patch.yml      插入一行 plugin：id = ui-testing-browser
index.js              Host 半边：BrowserHost（单 Chromium/profile、多 page）、按 DSH 工作区的 RuntimeRegistry、租约/串行队列、scoped HTTP 路由、独立 HTTP 客户端、29 工具（9 T1 + 7 T2 + 6 T3 + 7 network）与内置 Skill；并承担网络全事件采集（Runtime 级 Network/Fetch 订阅、按需 body、子目标 setAutoAttach）与 browser_capabilities.network 报告
browser-safety.js     BrowserError/CDP、错误分类（含 REF_STALE/TARGET_NOT_UNIQUE/NOT_INTERACTABLE/WAIT_TIMEOUT、T3 的 VISION_* 码与网络 P0 的 NET_* 码）、取消/定时器清理、URL 脱敏与目标/DNS 校验
network-p0.js         P0 网络纯 JS 核心：事件/会话存储、标准化与有界配额、分析与统计、业务链路窗口、拦截/限速/重放规则、JSONL/HAR 导入导出与证据索引、订阅游标（零 npm 依赖，不直接持有 CDP）
capture-p0.js         P0 采集基础设施：PNG 结构/CRC/解码、全量均匀/透明统计、尺寸校验、纯 JSON 映射投影、安全路径与原子 no-clobber 写入
vision-t3.js          T3 纯算法：PNG RGBA 编解码、crop/resize/预处理/标注、analysis/Sobel、yiq-v1 diff、识别/模板、几何映射、参数校验、VisionProductStore
vision-baseline.js    T3 受管基线：scopeHash 根、不可变 revision、head 规范 JSON、CAS 提交/墓碑、只读 list/get、故障注入点
frame-source.js       Host 帧缓存：最新帧/元数据/捕获统计（与传输、UI 解耦）
frame-push.js         Host 同源 WebSocket 推帧：单 upgrade dispatcher、按 scope 绑定 pusher、握手、合并推送、背压丢帧、鉴权、清理
client.js             全部 UI（React，无 JSX，用 h()）；内含 UI-free 的 createFrameTransport
locale/{en,zh}.json   插件显示名与描述
icon.svg              插件图标
skills/ui-testing/    内置 Skill（SKILL.md + references/examples/templates/knowledge/manifests）
tests/ui_test_exam/   插件自身能力的对照测试靶机（20 处预设缺陷），见该目录 README
tests/ui_test_fixture/ 自建授权本地靶机（确定性断言值），供验收脚本使用
tests/acceptance/     真实验收脚本：fake ctx 驱动 index.js、帧推送/轮询、能力台账检查、Skill 注册检查
reference/            本地参考资产（Skill 模板包 v1.1）**不入库**：已进 .gitignore，见 skill-authoring.md
docs/                 项目记忆（本目录）；按工作区隔离的契约见 workspace-isolation.md
```

## T2 结构化 GUI 在 index.js 内的职责

- **Snapshot/Ref 引擎**：`Accessibility.getFullAXTree` 建语义树并按规则压缩/截断；给可解析 Element 分配单调 `eN`，ref 表按 Runtime 隔离、2000 项 LRU、跨快照按 `(documentEpoch, backendNodeId)` 复用；跨文档提交/上下文丢失/close 清空。
- **目标解析与 actionability**：`ref`/唯一 `selector` → `DOM.resolveNode` + 身份复验 → 单次 `Runtime.callFunctionOn` 读 NodeState（可见/启用/可编辑/checked/expanded/focused/bbox/hit-test，含 open shadow 的 composed 命中）→ 自动滚动 + 稳定性确认 → CDP 真实输入派发。
- **证据**：统一 `evidence.version=1` 结构（provenance/targets/before/after/dispatch/networkDelta/escalation/incomplete），成功放结果、失败放 `BrowserError.details`；输入文本与可编辑 value 永不回显。
- **能力报告**：`browser_capabilities` 报 T2/T3/network 各段工具项（注册表共 29 工具）、`web.t2.*`、`web.t3.*`、`web.network.*` 与 `limits.structuredGui/limits.vision/limits.network`，T4 仍 `unsupported`。

## T3 静态视觉职责

权威契约见 [t3-vision.md](t3-vision.md)。Host 层只做注册、队列/租约、live 采集与 CDP 现场安全校验；纯算法与基线存储分别在 `vision-t3.js`、`vision-baseline.js`。

- **六工具**：`image`（source→crop→resize→preprocess→analysis/recognize→annotations→编码交付）、`find`（color/components/edges/template）、`compare`（YIQ diff/相似度/区域高亮/mask）、`act`（截图坐标的 CDP 输入）、`baseline`（list/get/create/update/delete）、`check`（回归 + 六类缺陷）。
- **源图**：只接受 `live`（P0 原始截图，`file:null`）/`product`（每 scope 的 `VisionProductStore`，16 张/128MiB/32MiB/16M px，重启失效）/`baseline`；不接受任意路径/base64。product store 与页面生命周期分离，page 导航/关闭后仍可离线分析，但 `act` 资格失效。
- **act 六步**：现场 layout/scroll/visualViewport 复验 → 同矩形重采样并比对原始 PNG 解码 RGBA hash → 视口校验 → `DOM.getNodeForLocation`（文档 CSS 整数，仅命中校验取整）+ connected/disabled/inert（composed 祖先）+ 两帧稳定 → CDP `Input.dispatchMouseEvent`（连续坐标，finally 释放）→ 单次 after product；失败一律零派发。
- **基线**：`<持久根>/output/vision-baselines/<scopeHash>/<name>/{images,heads}`；只 create/update mkdir；`link` no-clobber 为提交点；HEAD 为连续 revision + 父 hash 链；delete 为墓碑；读取校验 PNG hash/元数据，损坏报 READ_FAILED。
- **缺陷**：只消费调用方显式、带 provenance 的 facts（`trusted:false`），不重查 DOM；required 缺事实 → INCONCLUSIVE/BLOCKED，advisory 最多 WARN。
- **能力报告**：`browser_capabilities.vision`（version/algorithmVersion=`t3-v1`/tools/sourceKinds/limits/observed）与 `web.t3.*`；诊断调用不启动浏览器、不建目录、不生成 product。

## P0 采集职责

权威契约见 [capture-p0.md](capture-p0.md)。Runtime 只做单次 CDP 文档 clip 截图与环境读回，工具层编排 PNG 校验、尺寸拒绝、`capture.version=1`、文件发布和附件元数据比较；算法与同步文件操作委托 `capture-p0.js`。公开 mapping 经纯 JSON 投影，不返回函数。`browser_capabilities.capture/limits.capture` 不启动浏览器，observed 仅来自所属 Runtime 上次真实截图；PNG证据与JPEG预览分离。默认文件写插件实例级暂存，dispose清理；out/persist:true/非空env才持久到env或cwd根。file用pathKind/persistence/root/ephemeral区分；仅staging返回绝对路径，observed只保留persistence与relativePath（暂存为null）。当前C1–C14共14/14、142/142（[最终报告](../tests/acceptance/runs/capture-p0-2026-11-01T05-52-05-302Z-104057/report.json)）；下方115项为修订前历史。P0 三次进程内真实 Chromium 验收各 13/13、115/115（[报告](../tests/acceptance/runs/capture-p0-2026-11-01T04-58-32-550Z-66980/report.json)），宿主重载/provider 仍 NOT_RUN。

## P0 网络职责

权威契约见 [network-p0.md](network-p0.md)。分工：`index.js` 只做 Runtime 级 CDP 采集（`Network.*` 全事件、`Fetch` 单一 dispatcher、按需 `getRequestPostData/getResponseBody`、`Target.setAutoAttach` 子目标）、7 个工具的注册/队列/租约/懒启动与 `browser_capabilities.network`；事件模型、配额/背压、分析、链路、规则、导入导出与订阅游标等纯逻辑在 `network-p0.js`（零 npm 依赖、不持有 CDP 句柄，可单测）。

- **采集范围**：HTTP/HTTPS 请求与响应（头/体按需，配额截断）、WebSocket 双向帧、SSE 事件、同主 page 的 same-process iframe / OOPIF / dedicated·shared·service worker（**G1.5 为 partial**：popup 仍被既有目标策略阻断，不采 popup、不跨 scope 聚合）、生命周期状态机、重定向链（`hop` 递增）、initiator。
- **事件与证据**：`NET_PROTOCOL_VERSION=1` 标准化事件入环形缓冲（`maxEvents/maxBodyBytes/maxTotalBytes/maxWsFrames`），淘汰/丢弃/截断一律计数并可查 `integrity`；JSONL 为保真格式、HAR 只保证 1.2 子集（未知数值用 `-1`）。默认脱敏（URL 敏感 query、敏感头、JSON/form 敏感字段 → `***`），原值不进事件/证据/错误。
- **控制**：`Fetch.enable` 只有一份配置，Document 导航守卫与用户规则共用单一 dispatcher，每个 paused 请求恰好一次终结；`session.stop/reset` 逐条终结 held 请求但**不 `Fetch.disable`**。
- **能力报告**：`browser_capabilities.network` 报 `version/tools/session/limits/observed` 与 `web.network.*` 三态；`limits.network` 里 **`https = "mechanism-identical"` 与 `responseModification` 并列**（前者固定口径、后者按 Chrome 实测支持与否报 `true|false`）；诊断调用不启动浏览器、不建目录、不生成证据文件。
- **未验证**：真实宿主重启后的网络采集冒烟与 provider/长连接稳定性未验；HTTPS 子项与 `modify-response` 子项按 [network-p0.md](network-p0.md) §10 记 NOT_RUN。

## client.js 内部结构

1. `CSS` 常量 + 图标
2. `createFrameTransport()` —— 与 UI 无关的传输层：WS 优先、`/frame` 80ms 轮询回退、重连、帧元数据、实测统计
3. `DebugView` 组件 —— 顶部环境栏 / 工具栏 / 尺寸栏 / 预览区 / 底部状态栏；只消费 transport 的帧与状态；按右侧栏 `sessionId` 或 main 的 MoreRow 捕获 + `recent→runtimeId` binding 固定 scope，隐藏时停播
4. `apply(ctx)` —— 面板、菜单行、右栏页签注册

`DebugView` 与 `MoreRow` 各自渲染一份 `<style>`（原因见 [dsh-integration.md](dsh-integration.md)）。

**第 8 轮（网络 P0）`client.js` 未动**：网络能力只走 Agent 工具与 HTTP 路由，面板样式/文案/布局保持冻结；因此本轮不需要前端热更新，只有 Host 侧变更需要重启 DSH。
