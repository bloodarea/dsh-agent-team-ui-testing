# Web T4 动态行为观测、分析与调试准备契约

> 2026-11-04 · T4-prep-1 → **T4 已实现（2026-11-04，工具面 30 → 35）**。
> **本文仍是权威契约**；字段级实现冻结见 [t4-implementation-contract.md](t4-implementation-contract.md)，验收见
> [tests/acceptance/t4-dynamic.mjs](../tests/acceptance/t4-dynamic.mjs) 与 [status.md](status.md) 的「WEB-T4 实现」段。
> 五个工具已真实注册；真实 3080 宿主加载与 provider 图像可见性仍 NOT_RUN。
> 准备靶机通过不等于 T4 实现通过，也不等于真实宿主已加载；三个账本分别记账。

关联权威来源：[分层标准](capability-tiers.md)、[网络 P0](network-p0.md)、[采集 P0](capture-p0.md)、[共享视口](viewport-control.md)、[T3](t3-vision.md)、[架构](architecture.md)、[运行时](runtime-t1.md)。
靶机侧必须对齐 Lead 冻结的 [T4 准备靶机契约 §0–§3](../tests/ui_test_fixture/t4-prep-contract.md)；本文引用其 API，不复制实现。
当前技能边界见 [T4 技能参考](../skills/ui-testing/references/tiers/t4-dynamic-visual.md)。

## 1. 状态、定位与三个组成部分

### 1.1 当前状态与本轮边界

- 当前工具数：**35 = T1 10 + T2 7 + T3 6 + 网络 P0 7 + T4 5**（本文写作时为 30；T4 实现轮注册了 §7 的五个工具）。
- [Host 注册与能力报告](../index.js) 现在报告 `web.t4.dynamic-behavior = available` 与五条逐工具可用性；旧 `web.t4.dynamic-vision` 作为聚合别名保留（`aliasOf`），不再是 unsupported。
- 连续帧存储、时间轴控制、运动分析、动态事件关联现在都可被 Agent 调用；能力状态以真实注册与真实调用为准。
- §7 中五个名字已按本文 schema 注册，字段级冻结见实现契约；静态文档仍不能替代运行时能力发现。
- 既有分层表使用“T4 动态视觉调试”名称；本文提出的 T4 目标扩展为 Web 动态行为层，未在本轮改名既有能力 ID。
- 本轮只新增本文；索引、状态、README 与技能的同步由 Lead 持有，不以文档通用规则扩大写入范围。
- 文档保存不需重启或刷新。本轮不操作 3080/3081，不启动浏览器，不做 git 提交。
- 后续 Host/schema/bundled Skill 实现生效需要宿主加载新构建，必须另行授权与取证；本契约不授权重启。

### 1.2 定义

**动态视觉调试（Dynamic Visual Debugging，DV）**：观测画面随时间的变化，记录帧与控制，分析运动、闪烁、冻结、卡顿及区域变化，以可复核的时序证据验证断言。

**动态网络调试（Dynamic Network Debugging，DN）**：采集通信随时间的生命周期，追踪请求、响应、WS、SSE、重试与业务状态，分析并验证通信行为。首版范围是浏览器应用层。

**动态事件关联（Dynamic Event Correlation，DC）**：在操作、视觉、网络事件间建立有证据来源的有向关系，区分已证实因果、关联推断与单纯时间邻近。

DV 与 DN 可独立工作；DC 不要求两者同时采集。三者共享统一时间轴、操作记录、证据引用与完整性报告。
“独立”指模块职责和启停独立，不是另起浏览器、另建工作区或绕过既有 owner 租约。
网络 P0 已提供 DN 的主要基础；T4 的新增工作集中在帧证据、跨域标识与可解释关系查询。

### 1.3 能力覆盖与非目标

能观察**所有正常显示在浏览器画面中的动态效果**是视觉层目标，覆盖 DOM/CSS/JS/SVG、Canvas 2D、WebGL、WebGPU 与动态媒体。
该目标指浏览器合成输出的像素可观测性，受真实采样率、可见范围、编码、GPU/浏览器支持与缺帧限制。
它不保证捕获每个渲染帧，不保证隐藏页、离屏内容、受保护媒体或未成功渲染的画面可得。

- DOM/CSS/SVG 结构、动画对象、Canvas 绘制命令、GPU 资源与 3D 场景节点是不同层次的证据。
- 深层内部对象、绘制命令与场景图只经对应渲染技术的显式适配器提供；默认只做像素与时序。
- 不承诺 VLM、OCR、语义识别、自动读文字或理解 3D 场景；不新增这些服务或依赖。
- DN 不替代 TCP/IP 抓包、链路层诊断、TLS 解密或服务端内部追踪；不保证后端调用栈、事务或队列链路。
- 不新增多标签/popup 操作、跨 scope 聚合、下载上传、Cookie 导出；不借此扩大 T2 可操作范围。

## 2. 统一时间轴与事件模型

### 2.1 时钟来源、单位与校准

统一显示时间采用所属动态会话的 `timelineMs`，单位毫秒；原始时钟必须保留，不覆写 P0 事件时间。
Host 单调时钟是接收与排序的共同参照，起点在动态会话创建时冻结；墙钟只用于展示和与外部账本对照。
跨进程、跨 target 与跨文档的时间必须经明确锚点映射，不能直接相减。

| 来源 | 保留字段与真实性 | 映射/限制 |
| --- | --- | --- |
| Host 单调时钟 | `receivedMonoMs`、操作 begin/end | 表示 Host 收到或派发的时刻，不冒充浏览器渲染时刻 |
| `Page.screencastFrame.metadata.timestamp` | 原始 `sourceTimestamp`、单位秒、来源类型 | 按 CDP 时间类型核验为 epoch 秒后换算墙钟，再映射 Host；缺失为 null，不能用接收时刻伪填 |
| 页面 `performance.timeOrigin` + `performance.now()` | `pageOriginMs`、`pageNowMs`、`documentEpoch` | 同文档高分辨率相对时钟；新文档重新校准，隐私量化粒度如实报告 |
| CDP Network `timestamp/wallTime` | 保留 P0 `ts.cdpSeconds/wallMs/monotonicMs` | 按 [P0 R1-11](network-p0.md) 的每 target 首请求锚点换算；不能逐条 `Date.now()` |
| `Date.now()`、fixture `atWallMs` | `wallMs`、`wallSource` | 可跳变的墙钟，只作账本关联；不能单独用于精确耗时或因果排序 |
| fixture `atMs`、媒体时间 | `logicalMs`、`mediaTimeMs` | 逻辑/媒体轴，可 pause/seek/rate；不等于真实流逝时间 |

校准采用 Host 单调时钟包围一次页面读数：记录 `sendMonoMs/receiveMonoMs`，以中点为估计，半 RTT 为不确定度下界。
每次校准记录 `clockId/anchorId/offsetMs/uncertaintyMs/resolutionMs/calibratedAtMonoMs`；多个样本选最小 RTT，保留样本数与最大偏差。
默认最多 5 个校准样本；初次、主文档切换、墙钟跳变或超过 10s 的采集区段边界触发重新校准。
校准本身可能扰动页面，必须写 operation 事件；不能以高频校准掩盖时钟问题。
默认精确时序断言要求 `uncertaintyMs <= 10`，可在断言中显式收紧/放宽；实际生效值进入证据。
缺锚点、源时间回退、负延迟或偏差超限时，保留原始事件，标 `clock-uncertain`，时序结论降为 `INCONCLUSIVE`。
两个事件时间区间 `[t-u,t+u]` 重叠时不能宣称先后，除非存在独立的显式顺序证据。
同一数值时间的稳定输出按 `(timelineMs, receiveSeq, eventId)` 排序；该排序只是展示顺序。

### 2.2 事件信封草案 `DynamicEventV1`

下列字段为后续 T4 投影，不替换 `NET_PROTOCOL_VERSION=1`、`capture.version=1` 或 `evidence.vision.version=1`。
全部公开值须为 lossless JSON；未知值用 null，不使用函数、Buffer、非有限数字或默认值伪装观测。

```text
DynamicEventV1 = {
  version:1, eventId, dynamicSessionId, seq,
  domain:"operation"|"visual"|"network"|"control"|"marker",
  kind, phase,
  scopeId, runtimeId, pageGeneration, documentEpoch, runGeneration:null|integer,
  targetId:null|string, cdpSessionId:null|string, documentFrameId:null|string,
  ts:{timelineMs:null|number, sourceTimestamp:null|number, sourceClock,
      receivedMonoMs, wallMs:null|number, logicalMs:null|number,
      anchorId:null|string, uncertaintyMs:null|number, resolutionMs:null|number},
  ids:{actionId:null|string, opId:null|string, frameId:null|string,
       traceIdHash:null|string, requestKey:null|RequestKey},
  sourceRef:{networkSessionId:null|string, networkSeq:null|integer,
             visualSessionId:null|string, frameSeq:null|integer},
  provenance:{producer, sourceKind, adapterId:null|string, adapterVersion:null|string,
              trust:"host-observed"|"cdp-observed"|"page-declared"|"caller-declared",
              evidenceIds:[], rawHash:null|string},
  payload:{}, incomplete:[], truncated:false
}
RequestKey = {networkSessionId,targetId,cdpSessionId,requestId,hopId}
```

`payload` 按 domain 使用封闭 schema：operation 为派发摘要/结果；visual 为帧或原语指标引用；network 只引用 P0 序号/阶段；control 为请求/实际/恢复记录。
不得把完整 body、所有像素或自由页面对象塞进信封；原始证据独立有界存储，以 hash 与 ID 引用。
同一请求的 request/response/finished 是不同不可变事件；补抓正文以证据修订记录表达，不回写历史帧时间。

### 2.3 ID 域与 provenance

| 标识 | 唯一域与禁止混淆 |
| --- | --- |
| `dynamicSessionId/eventId` | Host 创建的不透明随机 ID，绑定 scope；seq 仅会话内单调，重启不恢复 |
| `actionId` | 既有工具 envelope 的动作身份；不等于 Agent 生命周期 `sessionId` |
| `opId` | 页面业务操作或适配器操作身份；需 `producer + documentEpoch` 命名空间，不能与 actionId 直接判等 |
| `ids.frameId` | **T4 视觉采样帧 ID**，唯一域 `(scope,dynamicSessionId,frameSeq)`；与 P0 的 CDP `frameId` 无关 |
| `documentFrameId` | P0 `frameId` 原样投影后的浏览器文档 frame 身份，不改 P0 字段名或原值 |
| `requestId` | CDP rawRequestId 仅 target/session 内有意义；必须携带 RequestKey 与 hopId，不能全局 join |
| fixture `requestId` | `t4-req-*` 为应用自编请求号，通过头或账本映射 CDP RequestKey；不能当 CDP requestId |
| `traceIdHash` | 复用 P0 每会话 HMAC 摘要及原始字段来源；不同会话摘要不能直接判等 |
| `documentEpoch` | 主文档/上下文代次，来自 Runtime；fixture reset 另记 runGeneration，不假装导航 |

页面 `causeOpId`、`ui.cause` 与调用者 link 是声明证据，必须标记 producer/trust。
Host 自己记录的输入派发能证明“发出了什么”；页面账本能证明“页面声称接收了什么”；像素能证明“采样时画面是什么”。
三者可互相核验，不能互相替代。适配器的控制回读也不自动升级为业务正确性证明。
对同一 `actionId→opId` 的映射需可信派发范围、目标身份、页面接收记录与唯一匹配；只有时间窗则保留 temporal。

### 2.4 有界存储、量化与完整性

以下是待实施的保守默认/硬上限；实现前需实测内存与 CPU，调整必须先修契约与能力 limits。

| 资源 | 默认 / 硬上限 | 超限处理 |
| --- | --- | --- |
| 动态会话 | 同 scope 1 个活动，保留 4 个摘要 | 活动冲突拒绝，旧摘要可无数据但写 retained:false |
| 采集区段 | 3000ms / **60000ms**（2026-11-04 起；此前 10000ms）；`running` 时可用 `extend` 显式续约，累计总时长 ≤ **300000ms**；停止后可另起区段 | 到界自动 stop，不能伪装取消后仍在采集。放宽度只为让 Agent 往返（实测 ~11.7s）不必然跨过到期点。**续约只能显式 `extend`**，`fresh`/幂等 start 都不续期；帧/字节/算法/10000ms 重校准间隔都不随时长放大 |
| 帧数/编码字节 | 180 / 300 帧；32 / 64 MiB | 淘汰最旧未 pin 帧并计 evicted，不能无限排队 |
| 单帧 | 4M 像素、8 MiB 编码 | 分配/解码前拒绝或计 dropped，不暗中缩图 |
| 事件 | 5000 / 20000 条 | 缺口范围与 dropped/evicted 分列 |
| 算法工作集/预算 | 256 MiB / 单调用 5000ms CPU 墙钟 | 分块检查取消、让出事件循环，超时无假结论 |
| 查询/配对 | 每页 200；每查询候选比较 **40000**（同域先按 |Δt|≤before+after 预筛再计，见 §5.3） | 游标/截断或资源错误，禁止无界笛卡尔积 |
| 结果证据 | 256 KiB、最多 100 个区域 | required 依据丢失则 INCONCLUSIVE，不能静默裁成 PASS |

`integrity={complete,captured,retained,dropped,evicted,truncated,ackFailures,gaps,issues,coverage}`。
`coverage` 至少含 source、区段、最大相邻采样间隔、源时间缺失数、采样/解码失败数与渲染适配器可用性。
`complete` 只表示请求的采集记录在约定边界内无已知丢失；**不表示已收齐浏览器全部合成帧**。
浏览器未发帧、协议未暴露的丢帧数量记 unknown，不能由本地 seq 连续断言为零。
时间/位置/颜色展示可舍入，断言使用未舍入有限数；输出记录量化粒度、ROI、scale、阈值与算法版本。
帧数据、索引与 pin 同 scope，淘汰同时删除悬空索引；读取跨 scope ID 与未知 ID 同样 NOT_FOUND，不泄漏存在性。
默认帧在内存，dispose 清理；本草案不提供任意路径输入、帧文件导入或视频文件导出。
若后续加入持久帧包，必须另定清单/hash/原子 no-clobber/持久根规则，不借 P0 HAR 承诺帧序列保真。

## 3. 动态视觉计划

### 3.1 帧源选择与证据入口

| 帧源候选 | 计划用途 | 真实性与取舍 |
| --- | --- | --- |
| `Page.startScreencast` + `Page.screencastFrame` | 首选连续观测源，协议支持时选 PNG | damage 驱动，无固定 FPS 保证；保留 metadata.timestamp、原始编码/hash、接收时刻及 ACK |
| 有界 `Page.captureScreenshot` 循环 | 显式低频采样或关键状态复核 | 调用 begin/end 是采样区间，不能伪造精确呈现时刻；记录实际间隔，成本/扰动另测 |
| `HeadlessExperimental.beginFrame` | 仅研究候选，首版不依赖 | 实验域/构建支持不稳，可能改变调度；未探测/未实测一律 unsupported |
| 面板 JPEG 最新帧缓存 | 保持既有预览用途 | **不得作为 T4 帧序列证据**；最新帧覆盖、合并和背压已丢失历史 |

未来可复用**CDP 原始事件入口**，不能复用“面板已经显示”的结果作为证据。
现有预览 JPEG 质量 72、最大 1600×1200、40ms 推送合并与 80ms 轮询均只是预览参数，不能成为 T4 采样承诺。
需要同 page 单一 screencast 协调器，避免两个模块分别 start/stop 改坏预览；模式冲突应显式拒绝或协商，并记录恢复。
T4 sink 在 latest-frame 覆盖前取得引用，以有界队列保留；每个 CDP 帧恰好尝试 ACK 一次，失败单独计数。
ACK 不等待算法、磁盘、Agent 或面板消费者；队列满即计 dropped，不靠拖延 ACK 隐性冻结浏览器出帧。
帧处理在队列外按不可变快照分析，生命周期/租约变更由 Runtime 串行处理，禁止长采集占住所有动作。

帧证据需含 `frameId/sourceTimestamp/receivedMonoMs/encoding/sha256/dimensions/mapping/provenance`。
PNG 解码、CRC、尺寸与预算遵循 [采集 P0](capture-p0.md)；PNG 不可用时不悄悄改 JPEG。
显式 JPEG 模式仅允许非精确像素分析，记录压缩与误差阈值；不把 JPEG 噪声当闪烁、颜色精确值或冻结解除。
编码 hash 相等与 RGBA hash 相等分开；不同压缩字节不必然意味着画面变了。
没有源时间戳的帧仍可查看，但精确间隔断言受限；接收时刻不得写进 sourceTimestamp。

### 3.2 每帧坐标与几何变化

- 每帧冻结真实 viewport、scroll、visualViewport、DPR、view revision、canvas offset 与实际输出尺寸。
- `view.scale` 是显示/默认截图密度，不是页面 zoom；动态采集显式固定 scale，不能随面板比例中途变更。
- 复用 [共享视口 §3/§7](viewport-control.md) 与 [P0 画布语义](capture-p0.md)：O=C−S、blank 无 DOM 对象。
- 原始页面帧与 canvas 合成帧分开标 source/mapping；面板标注 overlay 不冒充页面像素。
- ROI 采用每帧 mapping；尺寸/scroll/zoom/offset 改变时切 segment，或判 mapping-incompatible，禁止默默 resize/align。
- 帧分析不隐式产生 T3 actionable product；不能把旧动态帧直接送进坐标输入绕过 T3 新鲜度与命中复验。

### 3.3 渲染技术适配器边界

| 技术 | 默认可观测层 | 可选适配器 / 控制与限制 |
| --- | --- | --- |
| DOM/CSS/SVG | 合成像素、几何/样式显式读数 | WAAPI `getAnimations/currentTime/playState` + CDP Animation；不保证 JS timer、SVG SMIL 全被同一控制器暂停 |
| JS 驱动动画 | 合成像素及采样间隔 | 页面自愿提供逻辑时钟/状态适配器；不 monkey-patch 全局 rAF/Date/timer 冒充通用暂停 |
| Canvas 2D | canvas 最终画面 | 可选逻辑时钟/对象/像素校验适配器；不默认截获每条 draw 调用 |
| WebGL/WebGPU | 浏览器成功合成的画面 | 可选 GPU/引擎适配器；场景节点/命令缓冲不从像素反推；WebGPU 未支持时如实拒绝 |
| 动态媒体 | 视频最终画面与可观察媒体状态 | HTMLMediaElement、`requestVideoFrameCallback` 的 mediaTime/presentedFrames；解码帧回调不等于面板显示 |

适配器注册需明确 id/version/字段/时钟/支持动作/副作用/恢复能力；数据始终保留 page-declared 来源。
像素取证与适配器取证可在不同时间完成，必须报告两者时间差，不拼成伪原子快照。
视频受编码、解码、关键帧与 seek 完成事件影响；await `seeked`/可用帧再读回，requestedTime 不等于 currentTime。
媒体 fallback 为 canvas-capture-stream 时，必须按冻结靶机披露，不宣称验证了文件视频 seek。

### 3.4 分析原语、阈值与结论

首版使用确定性算法，不生成语义标签。每个原语返回输入帧 ID、时间区间、ROI/mask、有效样本数、实际阈值和限制。
T3 的 `yiq-v1` 可作为相邻帧像素差基础；不得改变 T3 默认阈值，T4 单独记录 `algorithmVersion:t4-draft-v1`。

| 原语 | 草案定义与阈值 | 必需证据 / 不足处理 |
| --- | --- | --- |
| 帧差 | 相邻可比帧 D/C，pixelThreshold 默认 0.1，changeRatio 默认 0.01 | 分母 C>0、双帧 hash、原始间隔；全 mask 拒绝，不给相似度 1 |
| 区域变化 | 8 邻接差异区域，minArea 默认 4px，最多 100 | bbox/area 与 frameId；不是 DOM 元素身份或文字内容 |
| 闪烁 | A→B→A，B 与两侧 changeRatio≥0.2，两侧差≤0.01，B 持续≤100ms | 至少三帧、亮度变化默认≥64/255；缺中间帧不能证明“无闪烁” |
| 冻结 | 预期应动的 ROI 连续≥500ms diffRatio≤0.001 | 至少 3 个实际像素样本，参考区或适配器时钟仍推进；damage 不出帧本身不足 |
| 卡顿 | 在显式目标周期 expectedIntervalMs 下，采样间隔>2倍周期计疑似 | 实际间隔分布/p50/p95/max、缺帧与 ACK 指标；采集抖动仅为采集异常 |
| 轨迹 | 显式颜色/模板候选的质心序列，maxStep 默认 80px | 每帧分数、匹配代价、mapping；多候选或遮挡标 unresolved，不自动换对象 |
| 过渡时长 | ROI 首次越 changeRatio 到连续 3 样本≤stableRatio(0.001) | 起止均为采样区间、报告不确定度；不把采样终点当业务完成时刻 |

`expectedIntervalMs` 无通用默认：必须由断言或适配器给定；不能把 40ms 预览推送间隔当页面目标帧周期。
阈值须通过 normal/异常正负例校准，返回 resolvedThresholds；不因单一靶机变绿反向挑阈值。
“无异常”要求覆盖满足断言的最短事件持续时间与采样间隔；例如 `[640,656)` 的闪白未采到即证据不足。
降低采样率、截断、源时钟缺失或未知丢帧影响 required 判断时，返回 `INCONCLUSIVE`/`BLOCKED`，不能 PASS。
正常静态区域或用户主动暂停不能判为冻结；一个相邻帧间隔变大不能直接判页面卡顿。
截图成功、帧数增加、调用已派发、fixture anomalies 非空都不是 T4 分析验收通过。

### 3.5 时间轴控制、副作用与恢复

控制严格区分**证据回放游标**与**真实页面时间轴**：前者仅选已存帧，不改页面；后者会改变被测应用，必须产生 control/op 事件。
首版真实页面控制仅适配已声明目标，不提供“冻结整个浏览器”承诺。

| 动作 | 条件与返回 | 恢复边界 |
| --- | --- | --- |
| pause/resume | 支持目标的 WAAPI/媒体/页面时钟；读回 playState/currentTime/rate | 保存原状态，恢复原先运行/暂停状态，不一律 play |
| seek | 仅支持目标，有限时间范围，媒体需等 seeked | 保存原时间；定时器、请求与业务状态不随 seek 自动回滚 |
| rate | 仅支持目标，草案 `[0.1,4]`，逐目标读回 | 保存并恢复原 playbackRate；不能更改 Host/网络时钟 |
| restore | 使用本会话 restoreToken，复验文档/目标身份 | 目标过期拒绝，不定位同名替代节点；部分恢复逐项报告 |

纯参数/适配器/范围/文档身份整批预检通过后才执行；失败可能部分生效，返回 applied/failedIndex/restoreStatus。
成功、失败、stop、取消、断连、dispose 均尽力恢复当前会话修改过的目标；保留恢复失败与最后观测值。

**retained 会话的控制义务（2026-11-04 裁决；见 [实施契约](t4-implementation-contract.md) §3.1/§3.3/§5）**：

- 视觉会话到界自动 stop 后仍是 `retained`，其 `motion_control` 仍可作用（只要 `pageGeneration/documentEpoch` 与当前页一致），**这会重新形成 pending 恢复义务**。
- **显式 scope `stop`/`reset`/`dispose` 覆盖本 scope 全部未结控制**：`running`、`stopped`、`retained`，以及帧数据已淘汰但仍有控制记录的会话，不能只处理 current/active。
- deadline 自动 stop 只收尾**本会话**；显式 stop 不得因 `state==='stopped'` 跳过恢复。
- 同一目标被多个会话改过时，按**成功写入时间的反序**解开可证明的本 Host 控制链；外部改动仍判 conflict、不覆盖。
- `reset` **先尽力恢复再清理**：`restoreStatus.status:"not-needed"` 仅当零义务；逐会话 `restores[]` + 顶层汇总，`cleared`=实际清除数、`resetCompleted`=是否完成。恢复失败抛 `DYNAMIC_RESTORE_FAILED`，仅冲突抛 `DYNAMIC_CONTROL_CONFLICT`，details 保留 `restoreStatus`/`restores`/`cleared`/`resetCompleted:false`/`evidence.dynamic`，**保留未结身份/before/lastWritten/token，不盲清**；`BUSY/ABORTED/CDP_*` 原码优先。
恢复只还原本会话的控制字段，不撤销已发请求、事件监听器副作用、服务端状态、声音或用户输入。
与外部修改冲突时不覆盖新状态，报 control-conflict；无可靠恢复能力的适配器须事前显式声明不可恢复并拒绝默认控制。
默认只读观测可进行；真实控制由调用者显式 action 请求授权，不因“分析卡顿”自动暂停应用。

## 4. 动态网络计划：复用 P0 与新增缺口

### 4.1 七工具职责保持

| 已注册工具 | T4 复用内容 | T4 仍需补齐的契约 |
| --- | --- | --- |
| `browser_network_session` | HTTP/WS/SSE 采集、启停、配额 | 与动态会话弱绑定，不隐式随 DV 启停，不重置别人的会话 |
| `browser_network_events` | timeline/filter/aggregate/patterns | 保持原事件；DC 通过 sourceRef 投影合并，不改 ts/seq |
| `browser_network_detail` | 头/体/timing/initiator/hops | 为错误→UI 提供状态与已捕获内容；不可得仍三态，不补抓 |
| `browser_network_trace` | 步骤、mark/link、对象与因果词表 | actionId↔opId/frame 区间桥接放 DC 索引，旧参数不暗增自由字段 |
| `browser_network_control` | throttle/offline/intercept/replay/mock | 注入事件纳入统一轴；保留导航守卫及 reset，不自动重放写请求 |
| `browser_network_evidence` | JSONL/HAR、脱敏、链接、integrity | JSONL 网络保真；不声称 HAR 保留视觉帧与整个 DC 图 |
| `browser_network_subscribe` | 多 Agent 游标、pin/gap | DC 消费需自己的订阅；不能替他人 ack 或阻塞采集 |

### 4.2 首版增量

1. **操作桥接**：工具 actionId、fixture/适配器 opId、P0 mark 与视觉 frame 窗口分列。现有 mark 邻近关联仍 temporal。
2. **跨域查询**：在同 scope 的独立网络/视觉存储上建立外部关系索引；任一模块未启动可单域返回并列 unresolved。
3. **错误→UI 传导**：请求/响应错误、页面错误处理记录、UI 状态 transition 与真实画面分别取证。
4. **异步来源区分**：WS、SSE、轮询竞争同一状态时保留每个候选，只有实际 `ui.cause` 能指向消费来源。
5. **可解释重复/重试**：复用 P0 pattern；相同 idempotencyKey/trace 证明分组，不自动证明一次请求引发另一次。
6. **更强覆盖**：冻结 T4 网络页补齐错误 banner、重试、远程 WS 更新、SSE/轮询竞争与慢请求的页面数据。

`CART_REJECTED/ORDER_REJECTED` 是 fixture 字符串业务码；P0 默认业务码只提取数值，不能要求其自动把这些字符串填成 businessCode。
字符串错误从已捕获响应 body、页面 errors 与可见错误文字独立校验；body 不可得时报告缺失，不能伪造。
HTTP 500 可正常 fetch resolve；HTTP/传输错误、页面错误展示与业务失败是不同事实。
慢请求只记录 duration/响应传播，除非显式超时阈值，不把 ≥700ms 自动写成 FAIL。
DN 层观测 WS/SSE 应用消息，不承诺 TCP 分片、重传、网络设备或服务端内部 span。
P0 G1.5 partial、OOPIF 未单独验证、shared/service worker not-collected、HTTPS 未独立验收等限制继续有效。

## 5. 动态事件关联（Dynamic Event Correlation）

### 5.1 关系等级与既有词表

本节的 grade 只解释证据强度，不新增或改写 P0 basis 枚举。

| `basis` | `grade` | 可说什么 / 前提 |
| --- | --- | --- |
| `explicit` | `confirmed-causal`（已证实因果） | 可审计的显式有向链接；须标 linkage producer、端点、方向与验证范围；调用者单方 link 只证明“显式声明了链接” |
| `redirect` | `confirmed-causal` | CDP 同请求/hop 的 redirectResponse、fromSeq/toSeq；不从 URL 相似推断 |
| `initiator` | `confirmed-causal` | CDP 给出可定位父请求的 initiator.requestId/端点；仅 script 栈存在不足以建立父边 |
| `observed` | `observed-association`（关联推断） | 相同业务对象/hash、状态传播或像素轨迹等观测关联；不是因果 |
| `temporal` | `temporal-proximity`（单纯时间邻近） | 只在时间窗相交/相邻；**默认不返回**，仅 `includeTemporal:true` 返回且不得写成因果 |

`explicit` 的“已证实”始终限定为所列 provenance 支持的链接范围；人工/页面声明不能变成 Host 独立验证的业务因果。
若声明未经核验，保留为 unresolved 的 declaredLink；已有 P0 trace.link 显式边可引用，但附 caller-declared 限制。
同 trace/hash 只表示共组；共同 ID 是因果必要的端点约束之一，不是充分条件。
无共同 ID 或协议明确的父子端点，不得判因果；高 confidence 不能把 observed/temporal 升级。

### 5.2 六向问题、证据与可达等级（对应参考图 3）

| 方向 | Agent 能解决的问题 | 必须提供的证据 | 可达到的等级与不足处理 |
| --- | --- | --- | --- |
| 操作→视觉 | 点暂停是否使目标画面停止？seek 是否改变对应区域？ | actionId/可信派发记录；唯一 opId；visual.events.causeOpId；目标读回及对应帧/ROI | 验证的操作接收→状态应用显式链为 explicit/confirmed-causal；实际像素变化只证明观测结果。只有前后差为 observed，无 ID 仅 temporal |
| 操作→网络 | 一次加购发了哪些请求？是否重复提交？ | actionId↔opId 桥、ops.requestIds、x-op-id/x-request-id 与 CDP RequestKey 对应、服务端 ledger | 已核验 op→request 显式桥为 explicit/confirmed-causal；同 trace 为 observed；P0 action mark 时间窗单独仅 temporal |
| 网络→视觉 | 哪次 500 导致错误 banner？购物车更新来自 WS、SSE 还是轮询？ | 响应/WS/SSE 事件 ID、ui.cause、from/to、错误码、目标状态读回与采样帧 | 经过独立核验的消费事件→UI transition 为 explicit/confirmed-causal；画面与 transition 对齐为 observed；响应和帧重叠只 temporal |
| 视觉→网络 | 看到错误后重试发了什么？订单卡片触发的取消请求是哪条？ | 可见状态/帧证据、后续真实操作 actionId/opId、retry/cancel requestIds、trace 与幂等键 | UI 状态→操作→请求每条显式桥齐全才逐边 explicit/confirmed-causal；相同 trace/幂等键仅 observed；像素本身不发请求，缺桥保留 unresolved |
| 网络→网络 | 重试/重复/重定向从哪里来？哪个请求发起后续请求？ | P0 RequestKey/hop；redirect/initiator 端点，或显式 retryFrom/链接；pattern/同键作为辅助 | CDP redirect/initiator 或已核验 explicit 为 confirmed-causal；重复键、同 trace、失败后同 key 成功仅 observed；窗口相邻仅 temporal |
| 视觉→视觉 | CSS 与 Canvas 是否同步？冻结只发生在哪块？过渡是否引发下一过渡？ | 双区域帧与时间误差、共同 op/逻辑时钟、显式 transition parent 链或适配器状态链 | 真实 parent/child 显式链才 explicit/confirmed-causal；共同 clock/op 或轨迹为 observed；两个区域同时变色仅 temporal |

网络页 `ui.cause` 是页面声明的显式消费端点，截图是可见结果；网络事件与服务端 ledger 是交叉证据，不证明服务端内部执行链。
视觉页目前提供 `causeOpId`，没有冻结的 visual→visual parent 字段；不能凭共同 causeOpId 虚构两视觉事件互为因果。
网络页没有冻结 retryFrom 或“视觉状态→retry op”的完整父边，重试因果首版上限按现有字段为 observed，后续适配器另定。
六向“数据可用”与“引擎已产出正确关系”必须分别验收。

### 5.3 算法草案

1. 锁定查询 highWater：记录视觉/网络/操作三个存储的上界与各自 integrity，随后只读不可变快照。
2. 校验 scope/runtime/pageGeneration/documentEpoch/target 归属。默认不跨文档连接；明确导航链仅允许有端点证明的边。
3. 规范 ID：CDP RequestKey 与应用 requestId 分开；对 op/trace/frame 建命名空间与已验证映射。
4. 优先取协议 redirect/initiator 与显式有向链接，再取共同业务标识/状态传播 observed；不按时间先猜父边。
5. 候选窗口默认前 250ms、后 1000ms，调用者可显式设置至各 5000ms；包括双方时钟误差，窗口只限候选不证因果。**同域方向（visual→visual、network→network）先按该窗口预筛、只有窗口内配对才消耗候选比较预算**（`maxCandidateCompares` 40000，2026-11-04 裁决），跨域方向保持完整枚举；`suppressedTemporal` 走同一预筛路径。
6. 一个事件多个同级候选时全部保留，写 candidateIds/ambiguity；除非有唯一键，不挑“最近的”当唯一根因。
7. 关系 confidence 为可解释类别 `direct|supported|weak|unknown`，附 reasons；不是统计概率，不跨等级排序冒充真实性。
8. 缺端点、缺帧、过期 ID、时钟歧义、来源未核验均进入 unresolved；截断或配额耗尽不能丢掉反例后给 PASS。
9. 对已证实链逐边给证据，混合等级链的总体不强于最弱边；不默认做因果传递闭包，不从循环推根因。
10. 最后按 includeTemporal 过滤，默认不返回 temporal pairs；被过滤计 suppressedTemporal，不把它们混入 causality。

### 5.4 输出 schema 草案

```text
CorrelationResult = {
  version:1, algorithmVersion:"dc-draft-v1", dynamicSessionId,
  window:{fromMs,toMs,beforeMs,afterMs}, highWater:{operation,visual,network},
  pairs:[{id, direction, fromEventId, toEventId,
    basis:"explicit"|"redirect"|"initiator"|"observed"|"temporal",
    grade:"confirmed-causal"|"observed-association"|"temporal-proximity",
    confidence:"direct"|"supported"|"weak"|"unknown", reasons:[],
    joinKeys:[], evidenceIds:[], provenance:[], limitations:[],
    timeDeltaMs:null|number, uncertaintyMs:null|number,
    candidateIds:[], ambiguous:false}],
  unresolved:[{eventId,reason,candidateIds:[],declaredLink:null|object,evidenceIds:[]}],
  suppressedTemporal:integer, integrity:{operation,visual,network,complete},
  incomplete:[], truncated:false, cursor:{next:null|string},
  verdict:{status:"PASS"|"WARN"|"FAIL"|"INCONCLUSIVE"|"BLOCKED",reason}
}
```

无断言的 query 固定 `INCONCLUSIVE(reason=no-assertion)`；查询成功不等于业务关系正确。
`evidenceIds` 必须能追到帧 hash、工具 action、P0 seq/hop 或 adapter 声明；不存在的链接标 unverifiable，不能伪造证据。
未启动网络时 `integrity.network=null` 且列 `network-not-collected`；不能给空集配 complete:true 暗示“没有请求”。

### 5.5 反误判规则

- request 与 frame 的时间窗口重叠最多 temporal；截图 `networkWindow.nearest` 也遵守此规则。
- 窗口内“零请求”只在采集已启动、范围覆盖且完整时成立；preSession/晚 start/丢失时不是零请求证明。
- 相同 URL、文本、坐标、checksum 或被脱敏为 `***` 不能用作业务身份；不同 HMAC 会话的摘要不可跨会话 join。
- 事件缺少 target/文档身份时不按 URL 补归属；scope、documentEpoch 不一致不能合并成一条无边界时间轴。
- 重复发送不等于重复业务副作用，需幂等键、deduped 与 server state；重试模式不等于用户执行了重试操作。
- WS/SSE/poll 的同一状态值不能都写成 UI 根因；竞态需实际 consumer 记录，无法区分则 unresolved。
- 页面主动 pause、场景切换、网络注入、seek 与分析采样扰动均列控制事件，排除“应用自然故障”的误报。
- 单帧/两帧不证明连续动画；正常静止不等于冻结；静默/缺帧不等于没有闪烁。

## 6. 冻结靶机与 API 映射

逐字段权威来源是 [冻结靶机契约](../tests/ui_test_fixture/t4-prep-contract.md)，以下只说明 T4 如何消费。
靶机为 `http://127.0.0.1:<port>`，port 由 fixture server 的 port=0 实际返回；不得用 3080/3081 代入。

| 入口/字段 | T4 对齐方式 |
| --- | --- |
| `/web-t4-visual.html`、`window.__t4.visual.version/truth` | 固定 version=1、durationMs=3000、seed=20261104、四 panels；不要求 WebGPU 一定可用 |
| `visual.clock` | nowMs/paused/rate/frame 与 startedAtWallMs/lastTickWallMs 分列逻辑轴和墙钟，不能作为原始帧时刻 |
| `visual.panels` | CSS 读真实样式/动画；Canvas/WebGL checksum 是 FNV-1a RGBA 真值；媒体 sample/frameCount 是适配器旁证 |
| `visual.ops/events/timeline` | opId/causeOpId 提供操作→视觉声明，seq 与 atMs/atWallMs 带来源；timeline 的墙钟排序不证明因果 |
| `visual.anomalies` | flashFrames/frozenAtMs/jankFrames/mediaStalled 为验收 oracle；分析器默认不能读 oracle 后自证识别 |
| `visual.state()/setPaused()/seek()/setScenario()/reset()/samplePanel()` | 只在授权 fixture 取真值或设置前置条件；seek 隐含暂停，场景切换重置；不当作已实现 T4 工具 |
| `/web-t4-network.html`、`window.__t4.net` | 单页电商，runId=t4-run-1、traceId=t4-trace-1；不同于既有 `/shop/*` MPA |
| `net.ops/requests/responses` | opId/requestIds 与头 x-request-id/x-trace-id/x-op-id/x-idempotency-key 做应用→CDP 桥 |
| `net.ui/errors` | key/from/to/cause.kind/cause.id 和 errors.requestId 对齐消费来源，独立核对真实 DOM/画面 |
| `net.ws/sse/polls` | 保存实际应用消息与消费来源；ui 幂等 transition 不能按三种来源重复计算 |
| `/api/t4/ledger?runId=t4-run-1` | 用独立 `browser_http_request` 取测试服务端账本；它只证明 fixture 收到请求，不是服务端内部追踪 |

场景名字/时间范围保持冻结：visual 的 normal/flash/freeze/jank/media-stall；network 的 normal/no-ws/no-sse/poll-off/dup/fail-cart/fail-order/slow-order。
visual 的 flash `[640,656)`、freeze ≥800ms、media-stall≈1.2s 是逻辑真值；真实采集能否覆盖需另外量化。
WebGL 仅同运行内同 t checksum 相等/不同 t 不等，不要求跨机器 GPU hash 相同。
WebGPU 不可用记录 false/reason，不以 WebGL 画面假充 WebGPU；SVG/独立 JS 驱动适配器仍需未来专项靶机。
媒体 fallback 时文件 seek 子项 NOT_RUN；主导色按冻结检查点 500/1500/2500ms 的 r/g/b 与显式容差。
网络 WS 会远程加购，检查 cart 用动作前后增量；正常初始取样不能一律假设 count=0。
订单 pending→paid→fulfilled 与 SSE/轮询时序保持冻结；cancelled 不允许被过期消息回写早先状态。
reset 会复用固定 op/request/trace 值，必须提升 DC 内 runGeneration 或开始新动态会话，防止与 reset 前 ID 碰撞。
已有 [fixture §NET/§SHOP](../tests/ui_test_fixture/README.md) 仍作 P0 回归入口，T4 新页不修改其既有真值。

## 7. 工具面（已按本文 schema 注册）

### 7.1 数量、公共 schema 与执行边界

新增 **5 个**：一个共享动态会话工具、三个 DV 观测/控制/分析工具、一个 DC 查询工具；DN 复用 P0 七工具，无第二套网络抓包 API。
工具面已按 **30→35** 落地（2026-11-04）；计数以真实注册为准，能力状态不得先于实现声明。
命名沿 `browser_*` 风格，`browser_dynamic_session`、`browser_motion_*` 与 `browser_dynamic_correlate` 是建议，不占用当前注册表。

根 schema 均为 `{type:object,additionalProperties:false,properties,required}`；下面列尽根字段和条件约束。
数值、字符串、数组边界与条件必填在执行期完整校验；不假设宿主支持所有 JSON Schema 关键字。
公共 `motionSessionId` 是视觉会话，`dynamicSessionId` 是关联视图，`networkSessionId` 指 P0 采集会话；不复用 envelope.sessionId。
`Rect={x,y,width,height}` 为有限 canvas CSS 矩形，宽高≥1；`Window={fromMs,toMs}` 为同动态轴的有限数且 from≤to。
`Ids` 为同 scope 不透明 ID 数组，最多 200、不重复；单 ID ≤128 字节；拒绝路径、base64 与 arbitrary JS 参数。
页面 start/stop/reset/control 走现有 Runtime 队列与 owner；采集 callback 不嵌套申请队列，分析不阻塞可信输入。
已存帧 observe/analyze/DC 只读不 ensure、不续租；fresh 观察是显式页面动作；不得把旧 T3 离线租约语义改掉。

### 7.2 工具参数/返回草案

| 未注册工具 / required | 封闭参数字段与条件 | 业务返回（均另附 envelope + evidence.dynamic） |
| --- | --- | --- |
| `browser_dynamic_session` / action | `action:start\|stop\|status\|reset\|extend`、`name?`、`config?`、`durationMs?`(仅extend)；name≤64字节仅start；config仅start，字段见下；**extend 只接受 action+durationMs**（带 name/config → 参数错误）；stop/status/reset/extend 作用本 scope 当前动态会话 | `{ok,changed,extended?,session,sessions,limits,integrity,restoreStatus}`；session含 dynamicSessionId/motionSessionId 与 **deadlineMs/cumulativeMs**；status/extend 不启动、不占租约；reset 先尽力恢复再清理（见 §3.5）；reset 不删持久文件 |
| `browser_motion_observe` / motionSessionId | `motionSessionId`、`fresh?:false`、`sinceSeq?`、`cursor?`、`limit?:50`、`window?`、`frameIds?`、`includeImages?:false`；cursor/sinceSeq互斥，frameIds与窗口/游标互斥；fresh只允许活动当前页，禁止混历史过滤 | `{ok,frames,events,fromSeq,toSeq,cursor,integrity}`；frames默认元数据/受管引用；includeImages最多选3帧，附原图hash/尺寸/附件交付事实，不默认落盘；fresh单次返回真实采样区间 |
| `browser_motion_control` / motionSessionId, action | `motionSessionId`、`action:pause\|resume\|seek\|rate\|restore`、`adapterId?`、`targetIds?`、`timeMs?`、`rate?`、`restoreToken?`；非restore必给adapterId/targetIds≤20；seek才给timeMs；rate才给rate；restore仅给token | `{ok,requested,applied,targets,before,after,restoreToken,restoreStatus,sideEffects}`；逐目标回读，部分失败保留 applied |
| `browser_motion_analyze` / motionSessionId, assertions | `motionSessionId`、`window?`、`frameIds?`、`assertions`；window/frameIds二选一；断言1–20、id唯一，每条封闭形状见下 | `{ok,results,summary,verdict,exitCode,integrity}`；离线不采新帧，缺证据返回INCONCLUSIVE/BLOCKED |
| `browser_dynamic_correlate` / dynamicSessionId | `dynamicSessionId`、`motionSessionId?`、`networkSessionId?`、`window?`、`directions?`、`eventIds?`、`includeTemporal?:false`、`beforeMs?:250`、`afterMs?:1000`、`limit?:50`、`cursor?`；方向只能六向，limit1–200 | `{ok,...CorrelationResult}`；首查须给至少一个来源ID，dynamicSessionId须是已有本scope动态会话；游标固定查询快照 |

`config`：`captureVisual?:true`、`networkSessionId?`、`source?`、`encoding?:png`、`durationMs?:3000`（上限 60000）、`maxFrames?:180`、`maxBytes?:33554432`、`region?:Rect`、`scale?:1`、`sampleIntervalMs?`。
captureVisual=true 时 source 必填且枚举 screencast/screenshot-loop；encoding枚举png/jpeg；scale `[0.1,2]` 且满足单帧预算；sampleIntervalMs仅screenshot-loop必给，整数 `[50,1000]`。
captureVisual=false 时只允许networkSessionId与captureVisual，networkSessionId必给且须是本scope已有P0会话；创建纯网络关联视图，不ensure/采帧/启动网络，motionSessionId=null。
视觉采集与网络引用可同时启用，networkSessionId不触发P0 start；start总返回dynamicSessionId，只有视觉启用才分配motionSessionId。
有视觉控制的start/stop/reset仍按页面操作；纯网络视图start/stop/reset仅Host内存串行与scope检查，不占页面租约；绝不停止或reset其引用的P0会话。
跨调用duration由内部有界任务计时，start立即返回；stop关闭本sink并恢复本会话修改；status只读缓存，不宣称实时页面状态。

**会话续约 `extend`（2026-11-04 用户批准；此前版本明确「不加 extend」已失效）**：

- 语义：`durationMs` 是**本次追加的毫秒数**（整数 `[1,60000]`），不是新的总时长；成功恒 `changed:true`、`extended:true`。
- 适用状态：**仅 `running`**。对 `stopped`/`retained` 调用 → `DYNAMIC_SESSION_NOT_ACTIVE`（会话仍在但已离开活动窗口；区别于 `DYNAMIC_SESSION_NOT_FOUND` 的「没有这个会话/跨 scope」）。**不得复活会话、不得重装 sink、不得产生跨段空档。**
- 累计上限：自 `startedAt` 起总时长 ≤ `sessionCapMs=300000`（5min）；超出 → `DYNAMIC_LIMIT_EXCEEDED`，`details={limit:"sessionCapMs",max:300000,actual}`，且**拒绝零副作用**（当前 deadline 不变）。单次仍 ≤ `durationMsHard=60000`。
- 只重挂内部到期定时器（先清旧定时器，禁止双触发）；**不放大**帧/字节/算法/校准任何预算，`recalibrateAfterMs` 仍 10000，`timeMs`/分析阈值 0–10000 不变。
- 纯 Host 内存操作：不 ensure、不占页面租约、不发 CDP、无页面动作；与 `status` 同属内存类。
- 可审计：每次成功追加 `DynamicEventV1{domain:"operation",kind:"session.extend",phase:"end",payload:{extendMs,previousDeadlineMs,newDeadlineMs,cumulativeMs}}`；最终到期 stop 的 `reason` 仍 `duration`，payload 带最终 `cumulativeMs`。
- 幂等：连续两次相同 extend 是两次独立续约（各自计量与事件）；重复 `start`（同 name+config）仍幂等且**不续期**。
- 动机：Agent 一次工具往返实测约 11.7s，短会话无法支撑多步取证；`extend` 让调用方在需要时显式保持会话存活，而不是无限抬高超时上限。

`Assertion={id,type,region?,masks?,thresholds?,expectedIntervalMs?,query?,expectation?}`；id非空且≤64字节，region为整数PixelRect，masks使用T3封闭{id,region}形状且≤64。
expectation仅freeze必给：`{motionExpected:true,sourceEventId,referenceEventIds}`，引用同scope/同段已有的预期运动声明与至少一个独立推进旁证；无法核验来源时INCONCLUSIVE，不凭布尔值自证。
query仅trajectory必给：`{method:"color",color:RGB,tolerance?:16,minArea?:4,maxResults?:20}` 或 `{method:"template",productId,minScore?:0.95,stride?:1,maxResults?:20}`。
模板只用同scope已有不可变受管product；颜色/分数/步幅/个数边界沿T3同名参数，productId不接受路径；query不开放语义名称。
thresholds根键及默认值按下表选择，拒绝不适用字段；ratio∈[0,1]、brightnessDelta∈[0,255]、时间∈[0,10000]、minArea正整数、maxStep有限正数。

| type | 允许thresholds键（默认） | 额外条件 |
| --- | --- | --- |
| frame-diff | pixelThreshold(0.1)、changeRatio(0.01) | 比较实际相邻帧，不补帧 |
| region-change | pixelThreshold(0.1)、changeRatio(0.01)、minArea(4) | 最多100区域，未输出区域不改变总分母 |
| flicker | pixelThreshold(0.1)、changeRatio(0.2)、stableRatio(0.01)、brightnessDelta(64)、maxDurationMs(100) | 至少三帧，不能以未采到为阴性 |
| freeze | pixelThreshold(0.1)、stableRatio(0.001)、minDurationMs(500) | 显式预期运动及独立推进旁证须可用 |
| jank | intervalFactor(2) | expectedIntervalMs必给且>0；intervalFactor范围[1,10] |
| trajectory | maxStep(80) | query必给，遮挡/多候选不自动换对象 |
| transition | pixelThreshold(0.1)、changeRatio(0.01)、stableRatio(0.001)、stableSamples(3) | stableSamples整数[2,20]；报告采样区间 |

expectedIntervalMs只对jank适用；query只对trajectory适用；阈值定义与证据不足降级沿§3.4，实际枚举名以上表为准。
判定采用 FAIL > BLOCKED > INCONCLUSIVE > WARN > PASS；exitCode 1/2/0 语义沿T3；不调用process.exit。

### 7.3 错误与能力报告草案

以下 `DYNAMIC_*` **尚未注册**；既有平台 `BUSY/ABORTED/CDP_*/RUNTIME_LIMIT` 与 P0 `NET_*` 原码透传，不重包吞掉。

| 草案错误 | category / retryable | 触发 / 副作用证据 |
| --- | --- | --- |
| `DYNAMIC_INVALID_ARGUMENT` | input / false | 未知字段/边界/互斥/身份格式错误；纯预检零启动/控制 |
| `DYNAMIC_SESSION_NOT_FOUND` / `DYNAMIC_EVENT_NOT_FOUND` | scope / false | 未知、淘汰或跨scope ID，同形返回 |
| `DYNAMIC_SESSION_ACTIVE` | concurrency / false | 同scope冲突会话；同名同配置start可幂等 |
| `DYNAMIC_SOURCE_UNAVAILABLE` | capability / false | 帧源/编码/适配器/目标不支持；不得偷偷回退 |
| `DYNAMIC_CLOCK_UNCERTAIN` | evidence / false | 精确时序调用无可靠映射；保留原事件与偏差 |
| `DYNAMIC_LIMIT_EXCEEDED` / `DYNAMIC_TIMEOUT` | resource / false；timeout / true | 分配/候选/CPU预算超限；不交付虚假半成品 |
| `DYNAMIC_CONTROL_CONFLICT` / `DYNAMIC_RESTORE_FAILED` | state / false | 页面代次/目标变化/外部修改；报告部分应用与恢复状态 |
| `DYNAMIC_MAPPING_INCOMPATIBLE` | evidence / false | ROI跨不兼容几何段；不自动配准 |

缺帧等可解释的断言证据不足优先返回 INCONCLUSIVE，不一律抛错；协议/输入/资源错误抛 BrowserError 并附动态证据。
`evidence.dynamic={version,operation,provenance,sessionIds,highWater,clockAnchors,integrity,control,redaction,incomplete,truncated}`。
错误不回显页面自由文本、token、绝对证据根或原始系统栈；帧可能含敏感数据，采集与导出不得自动分享。

未来 `browser_capabilities` 可加 `dynamic={version,tools,visual,networkReuse,correlation,limits,observed}` 与相应 `web.t4.*` 项。
声明与实际观测分离；observed 初始 null，只来自真实调用，不以查询触发 ensure、校准、截图、建目录或生成 session。
帧源/编码/适配器逐项报告 supported/unsupported 与理由；BUSY按动作分类；不把未启动状态写unsupported。
当前继续报告旧 `web.t4.dynamic-vision` unsupported；未来是否保留聚合兼容项、扩展为 dynamic-behavior 由 Lead 统一裁决。

## 8. 验收门槛草案（40 条）

### 8.1 记号、运行与报告

`B` = 真实插件 + 真实无头 Chromium；`U` = 纯逻辑/存储/schema 校验；`NOT_RUN` = 当前未执行，不计通过。
下表“类别”是执行方式；本文件写作时 40 条全为 NOT_RUN，**实现后的逐条 PASS/PARTIAL/FAIL/NOT_RUN 以 [status.md](status.md)「WEB-T4 实现」段与 `tests/acceptance/runs/*/run-report.json` 为准**。
`V` = `http://127.0.0.1:<port>/web-t4-visual.html`；`N` = `http://127.0.0.1:<port>/web-t4-network.html`。
`P` = `http://127.0.0.1:<port>/web-network.html`；`O` = 同源 `/web-network-oopif.html`；`S` = 同源 `/shop/products.html?runId=chain-1`。
表中 U 的 URL 表示数据来源/重放基准，纯逻辑测试不需打开浏览器；不能因为 B 不可运行就用 U 顶替。
每行必须保留 expected/actual、环境/构建指纹、参数、阈值、evidenceIds/hash、失败原因与未运行子项。

准备阶段仅用当前已注册工具和 fixture 真值验证**靶机数据可用性**，分别运行视觉/网络 fixture 套件。
未来 T4 实现阶段再用新工具验证采集、控制、算法与 DC；不能用 `browser_eval` 读 anomalies/cause 后宣称引擎通过。
按 [冻结靶机 §0](../tests/ui_test_fixture/t4-prep-contract.md) 单驱动串行，运行命令必须有 `flock /tmp/dsh-t4-browser.lock`。
报告与 PNG 写各次 `tests/acceptance/runs/<ISO>-<pid>/`，写明真假宿主边界；本任务不运行这些命令。
0=必需项通过；1=必需项失败；2=套件无法运行。NOT_RUN逐项给理由，不能算PASS；Lead独立复跑后才收口。

### 8.2 DV：动态视觉 16 条

| 编号 | 类别 / 状态 | 靶机 URL | 期望证据 | 失败判据 |
| --- | --- | --- | --- | --- |
| DV01 | B / NOT_RUN | V | 四卡/title、version=1、媒体来源、无跨源请求；当前capabilities=unsupported/30 | 靶机冒充能力上线、缺来源或出现外网依赖 |
| DV02 | B / NOT_RUN | V | CSS WAAPI对象与真实transform/opacity随t变化；SVG/独立JS子项另记NOT_RUN | 手写状态冒充样式、把未覆盖SVG/JS写通过 |
| DV03 | B / NOT_RUN | V | Canvas2D 24粒子、RGBA checksum与真实重绘frames/draws，300/900ms正负例 | draw次数代替像素、同t不可重复或不同t不变化 |
| DV04 | B / NOT_RUN | V | WebGL contextType/renderer、同运行checksum、WebGPU available/reason | 伪造WebGPU、跨GPU固定hash；无context不披露 |
| DV05 | B / NOT_RUN | V | 视频readyState、3s±0.15、500/1500/2500主导色、frameCount与fallback | fallback假称文件seek、未解码却有假sample |
| DV06 | B / NOT_RUN | V | pause/seek/resume实际回读，seek300→900→300确定性，漂移容差 | 把requested当actual、暂停后canvas仍重绘 |
| DV07 | B / NOT_RUN | V | T4独立帧sink、sourceTimestamp/编码/hash、metadata与原图证据 | 面板latest-frame或/metrics冒充T4帧序列 |
| DV08 | B+U / NOT_RUN | V | ACK恰好一次、慢消费者/预算压力下dropped/evicted/gaps与有限内存 | 等算法才ACK、无限排队、丢数仍complete |
| DV09 | U+B / NOT_RUN | V | 两帧YIQ分母/masks/区域与normal负例；全mask显式拒绝 | 分母为零返回相似度1、尺寸不合偷偷resize |
| DV10 | B / NOT_RUN | V?scenario=flash | `[640,656)`真值正例、≥3帧A→B→A与normal负例/覆盖间隔 | 未采到闪白写无闪烁、用oracle代替分析输出 |
| DV11 | B / NOT_RUN | V?scenario=freeze | ≥800ms Canvas冻结，CSS/逻辑轴仍动，≥500ms三次像素复核 | 静态/主动pause判冻结、无样本仅无damage就FAIL |
| DV12 | B / NOT_RUN | V?scenario=jank | 已知目标周期、间隔分布、jankFrames旁证、采集丢帧分离 | 用预览40ms当目标FPS、Host拥塞直接判页面卡顿 |
| DV13 | B / NOT_RUN | V?scenario=media-stall | ≈1.2s媒体停滞、400ms后漂移<80ms、其他区域变化 | 缓冲/解码/控制原因混为同一故障、缺媒体样本仍PASS |
| DV14 | U+B / NOT_RUN | V | 轨迹候选/分数、双区域变化/过渡区间、歧义与mapping分段 | 跳到相似粒子、滚动/尺寸改变后仍给确定轨迹 |
| DV15 | B+U / NOT_RUN | V | pause/seek/rate/restoreToken、副作用与失败/取消恢复记录 | 擅自控制、不恢复原暂停/rate、部分应用未披露 |
| DV16 | U+B / NOT_RUN | V | 时间锚点/偏差、几何scale/scroll/O、源时间缺失/跳变负例 | Date.now伪造呈现时刻、量化/缺帧后仍精确PASS |

### 8.3 DN：动态网络 12 条

| 编号 | 类别 / 状态 | 靶机 URL | 期望证据 | 失败判据 |
| --- | --- | --- | --- | --- |
| DN01 | B / NOT_RUN | N | 导航前P0 start、初始cart GET、WS握手/帧与页面账本 | 用网络总数断言业务数、未启动却称无请求 |
| DN02 | B / NOT_RUN | N | 可信加购action/op、POST后GET、CDP RequestKey↔应用requestId、ledger | 原始requestId跨域硬等、仅同trace就判操作因果 |
| DN03 | B / NOT_RUN | N | WS远程加购基线与加购增量、cart count/revision、ui.cause | 假设count绝对1、重复transition或漏WS来源 |
| DN04 | B / NOT_RUN | N?scenario=dup | 同key两POST、deduped/duplicate与server仅加1、UI一次变化 | 把两请求等同两次业务加购、无ledger就判幂等 |
| DN05 | B / NOT_RUN | N | orders POST、SSE至少2事件、3次poll、UI实际consumer与最终状态 | SSE/poll重复计算UI变化、相同状态误判多因果 |
| DN06 | B / NOT_RUN | N | WS cart-updated方向/内容、页面ui cause=ws与真实画面 | 收到消息即称可见更新，无状态/画面证据 |
| DN07 | B / NOT_RUN | N?scenario=fail-cart | 500、CART_REJECTED响应/页面errors、可见banner及cause请求 | HTTP500当fetch抛错、字符串硬填P0数值businessCode |
| DN08 | B / NOT_RUN | N?scenario=fail-order | 500→retry点击→同幂等key成功、retried、错误消失/订单状态 | 自动重放代替真实retry、假装已有retryFrom显式父边 |
| DN09 | B / NOT_RUN | N?scenario=slow-order | duration≥700ms容差、800ms延迟真值、最终UI更新 | 固定sleep采空、未设业务阈值却把慢自动判失败 |
| DN10 | B+U / NOT_RUN | N、P | begin/end/query、同trace组≥3、temporal默认过滤、P0正文三态/脱敏 | 时间窗写因果、unavailable伪空体、导出泄露原值 |
| DN11 | B / NOT_RUN | N | reset前后server/page账本、revision起点、runGeneration、SSE/WS关闭 | reset旧消息污染新轮、固定ID复用串链 |
| DN12 | B+U / NOT_RUN | P、O、S、N | P0 C1–C52/链路回归证据与partial/HTTPS/worker限制逐项披露 | 准备靶机通过充当P0全量/真实宿主通过 |

### 8.4 DC：动态事件关联 12 条

| 编号 | 类别 / 状态 | 靶机 URL | 期望证据 | 失败判据 |
| --- | --- | --- | --- | --- |
| DC01 | B+U / NOT_RUN | V | 操作→视觉：pause action↔op↔causeOpId及实际状态/帧 | 页面声明未核验却称Host证实，只有两帧就判因果 |
| DC02 | B+U / NOT_RUN | N | 操作→网络：action/op/requestIds/头/ledger逐端点链接 | P0mark邻近当explicit、CDP与应用请求号混淆 |
| DC03 | B+U / NOT_RUN | N?scenario=fail-cart | 网络→视觉：500响应→ui.error cause→可见banner，分边等级 | 响应与帧重叠直接confirmed-causal |
| DC04 | B+U / NOT_RUN | N?scenario=fail-order | 视觉→网络：错误画面、重试操作、新请求与同key；缺状态父桥列observed/unresolved | 像素自动导致请求、虚构未冻结父字段 |
| DC05 | B+U / NOT_RUN | N、P | 网络→网络：redirect/可用initiator正例；retry/duplicate observed负例 | script栈无父ID仍给initiator边，同trace升因果 |
| DC06 | B+U / NOT_RUN | V | 视觉→视觉：同步区域observed、只有已核验显式parent才confirmed；当前无parent子项NOT_RUN | 共同clock/causeOpId变成两个视觉事件互为因果 |
| DC07 | U / NOT_RUN | V、N | basis↔grade穷举、默认无temporal、includeTemporal仅回时间邻近 | 高confidence升等级、temporal混入因果结论 |
| DC08 | U+B / NOT_RUN | V、N | 同时并发候选、SSE/poll竞争、模糊ID；candidateIds/unresolved/reasons | 选择最近事件当唯一根因、丢掉竞争候选 |
| DC09 | U+B / NOT_RUN | V、N、S | scope/target/hop/documentEpoch/runGeneration/HMAC命名空间负例 | 跨scope聚合、不同会话hash硬等、导航/reset串链 |
| DC10 | U+B / NOT_RUN | V、N | 缺帧/正文/端点/偏差超限/截断传播，所有关系可追evidenceIds | 缺失证据伪造、partial仍required PASS |
| DC11 | U+B / NOT_RUN | V、N | 查询highWater、游标稳定、候选预算、无采集时null来源；纯查询无启动 | 查询改变采集/续租、晚到数据污染快照、无界join |
| DC12 | B+U / NOT_RUN | V、N | 准备阶段capabilities仍unsupported/30；未来35须另验schema/错误/旧30回归；真实宿主单列NOT_RUN | 草案被注册、fixture验收冒充T4实现/3080通过 |

## 9. 风险、假设与未决问题

| 风险/未决 | 当前决定 | 后续解除条件 |
| --- | --- | --- |
| screencast丢帧与源时间保真 | 保留原始时间/ACK/缺口；不保证每渲染帧 | 真实Chromium源时间校验、短闪覆盖与负载实验 |
| 预览和T4共用CDP入口 | 单协调器草案，不消费面板缓存 | 明确编码/尺寸冲突策略、预览恢复及多sink验收 |
| PNG编码与CPU/内存 | 零新增运行时依赖；先有界PNG | 实测Chromium格式、4M像素预算与解码工作集 |
| WebGPU/headless/GPU差异 | 像素目标不等于特定GPU可用 | 能力探测与真实WebGPU专项靶机；不可用NOT_RUN |
| 视频编码/seek/fallback | requested与actual分离，不保证帧精确seek | 资产provenance、seeked/rVFC及容差实测 |
| 动画控制副作用 | 仅声明适配器，保存/回读/恢复 | 取消、断连、外部修改、导航/目标替换负例 |
| 跨时钟偏差/墙钟跳变 | 锚点+不确定度、偏差过大降级 | 多target/文档的校准与扰动预算数据 |
| GPU/字体/JPEG像素不确定 | 同运行断言，阈值与编码公开 | 正负样本校准，禁止跨进程固定GPU hash |
| WS/SSE长期稳定性 | 短确定性fixture不推长期稳定 | 长连接断线/重连/背压/关闭专项，不隐性扩scope |
| visual→network / visual→visual父桥不足 | 现冻结字段只够部分observed关系 | 后续适配器契约显式补父边，不能本轮改fixture |
| 纯网络独立DC会话入口 | dynamic_session captureVisual=false显式引用已有P0会话，不开页/采帧 | 验证生命周期与P0独立；若改为单独工具，数量须重新裁决 |
| 新能力ID与旧T4名称 | 旧ID继续unsupported，草案不落注册 | Lead同步分层/README/Skill/manifest后另定兼容项 |
| 真实宿主/provider未验 | 本轮均NOT_RUN，不碰3080/3081 | 授权后的实际工具调用/可见性证据，隔离套件不能替代 |

假设：复用现有无头 Chromium、Node 内置模块、scope身份、owner租约、导航守卫与lossless JSON；不引入第二套浏览器驱动。
本文件没有运行验证，没有新证据路径或通过计数；上表解除条件均是后续任务，不因本文完成而自动满足。

## 10. 与现有契约的关系及实施交接

- [网络 P0](network-p0.md) 继续权威定义七工具/事件/配额/脱敏；遇正文与补充裁决差异，以其 §13 为准。
- basis 沿用 `explicit|redirect|initiator|observed|temporal`，P0 的对象/状态 observed 与 causality 语义不变。
- [采集 P0](capture-p0.md) 单帧、networkWindow、附件/file规则不变；截图时间窗不升级为帧呈现时刻或网络因果。
- [共享视口](viewport-control.md) get缓存/set页面操作、CAS、scale与DPR区别不变；T4不能把后台采样塞进只读诊断。
- [T3](t3-vision.md) 六工具/产品/坐标输入/yiq-v1/基线保持；T4只可显式复用静态算法，不扩大其连续性证明。
- [运行时](runtime-t1.md) 的面板预览、latest-frame与metrics继续用于预览诊断，不能被当作T4验收证据。
- [冻结靶机](../tests/ui_test_fixture/t4-prep-contract.md) 定义数据与可用性；本文定义未来采集/控制/分析/关联层，冲突先报Lead，不静默改字段。

后续建议按“帧源/有界存储 → 只读时间轴 → 适配器控制 → 原语分析 → DC → 独立验收/真实宿主”建立依赖。
每个切片先冻结schema与限额，再落代码；新增工具名/数量、错误注册、能力报告与文档同步属于另一次实施任务。
准备靶机、T4 实现、进程内验收与真实宿主验证分别记账，互不顶替；实现轮结论见 [status.md](status.md)。
