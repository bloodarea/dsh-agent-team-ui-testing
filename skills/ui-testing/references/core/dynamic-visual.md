# 动态视觉与时间诊断：三层分离 + 采样真实性

> 用 T4（`browser_dynamic_session` / `motion_observe` / `motion_analyze`）判断"时间上的异常"，用 T3 判断"某一帧的像素事实"。
> 判定终检见 [`verdict-gate.md`](verdict-gate.md)；断言字段精确形状见 [`tool-routing-and-limits.md`](tool-routing-and-limits.md) §2。

## 1. 三层必须分开记

| 层 | 回答的问题 | 证据来源 | 不能外推 |
| --- | --- | --- | --- |
| **① 声明层**：CSS 关键帧/动画声明 | 页面声称动画怎么动、动多久、透明度/位移怎么变 | `browser_eval` 读 `document.getAnimations()`/`getComputedStyle`（T1），或样式表文本 | 声明 ≠ 实际渲染；声明里出现的异常值不自动等于用户看到的异常 |
| **② 采样层**：浏览器真实产出的帧 | 采样窗口内实际出现了哪些帧、间隔多少、有没有丢帧 | T4 帧证据：`sourceTimestamp`、`seq`、`encodedSha256`/`rgbaSha256`、`integrity`、帧 `mapping` | 采样到的是**采样规格下的**序列，不是连续真实时间轴 |
| **③ 效果层**：用户可见结果 | 这块区域在某一帧/某个区间到底变成什么样 | `motion_observe {includeImages:true, region}`（crop-on-delivery PNG）+ T3 `vision_compare` 精确像素 | 单帧好看 ≠ 时序正确；一张图不能证明"没闪" |

三层各自记账；**只凭声明层判缺陷、只凭效果层判时序、只凭采样层判机制，都是越界**。

## 2. 采样真实性：先写采样规格，再写结论

每次 T4 结论必须同时记录：

| 要记录的事实 | 从哪来 |
| --- | --- |
| 请求的采样间隔 | `dynamic_session config.sampleIntervalMs`（仅 `screenshot-loop`，50–1000ms）或 `source`（`screencast` 是 damage 驱动，无固定间隔） |
| 实测间隔分布 | `motion_analyze`（`jank`）的 `metrics.p50/p95/min/max/mean` 与 `intervals[]`（每对帧的 `intervalMs`、`ratioToExpected`、`suspected`、`cause`） |
| 采集机制 | `screencast`（共享预览 JPEG，`precise:false`，静止页无帧）/ `screenshot-loop`（PNG，`precise:true`，单飞按间隔采样） |
| 丢失与缺口 | `integrity`：`dropped/evicted/truncated/ackFailures/gaps`；`coverage.maxAdjacentIntervalMs/missingSourceTimestamps/samplingFailures/decodeFailures` |
| 时钟可信度 | 帧 `sourceTimestamp` 缺失只能为 `null`（不得用接收时刻补）；`limitations` 出现 `intervals-from-received-mono` 时，间隔只能写"近似" |
| 校准与预算 | `recalibrateAfterMs=10000`（长会话时钟会重校准）；单次分析 5000ms 算法预算 |

换算规则：

- 采样间隔 < 目标异常时长，才谈得上"能看见"。例：目标是 16ms 级瞬时变化，而实测 p50 是 160ms → **必然可能漏**。
- `screencast` 是 damage 驱动：页面静止时没有新帧，"没有帧"不等于"画面正常"，也不等于"冻结"。
- `jank` 的 `expectedIntervalMs` 是**你声明的期望间隔**（如 16.7ms），不是面板/预览的刷新间隔，也不是实测值。用错了会把工具上限写成页面卡顿。
- `suspected` 且 `cause:"capture-gap"` 表示是**采集跳号**造成的长间隔，不能算页面掉帧；全部分析都落在 `capture-gap` 时结论应写"采集不足"。

## 3. 低采样率/覆盖不足：只准写 INSUFFICIENT_TEMPORAL_RESOLUTION

以下情况**不得写"无闪烁/无卡顿/未发生"**：

- 采样间隔大于目标异常的可能时长（低分辨率采样）；
- 采样窗口没覆盖到异常可能发生的时刻（开始采集晚于页面动作，或动作晚于窗口）；
- 关键帧被淘汰/丢弃/截断，或首末帧之间有明显缺口；
- 时钟不可比（`missing-time`）或解码失败导致部分帧不可用。

写法（报告级标签，不是工具错误码——工具没有返回这个错误码）：

```text
verdict: INCONCLUSIVE
reasons/limitation: INSUFFICIENT_TEMPORAL_RESOLUTION
detail: 请求间隔 80ms、实测 p50 163ms（约 6fps）；目标变化窗口约 60ms，
        采样最多覆盖 1/2 帧，无法排除"发生过但未被采到"
```

正确表述是"**采样窗口内未观察到** X"，而不是"**没有** X"。

## 4. WebGL / Canvas 的假设树：事实与根因分栏

像素不变或像素异常**只是观察**；机制是推断。先列事实，再列候选，再写对照实验能排除哪些。

| 候选机制 | 支持它的事实（用什么工具取） | 反对它的事实 |
| --- | --- | --- |
| 上下文丢失 | `browser_eval` 读 `canvas.getContext('webgl2'|'webgl').isContextLost()`、监听 `webglcontextlost` 事件、控制台错误 | 上下文正常且 rAF 在推进 |
| 每帧未清屏导致累积 | `screenshot-loop` 精确帧：既有形状保留、新形状叠加，区域面积/像素随时间单调增加；区域位置相对稳定 | 帧间只有整体位移/重绘、无残影层；区域在帧间归零 |
| 停止渲染（rAF 停了） | 帧 `frame-diff` 无变化 + 页面 rAF 计数（`browser_eval` 埋点）停滞 | rAF 活跃但像素不变（说明是"画了但没变化"） |
| 同色覆盖 | 像素颜色与背景一致、区域边界存在但不可见（T3 `vision_find` color/components） | 区域颜色与背景不同 |
| 被遮挡 | T2 `node_state` 的 `hitTarget/coveredBy`、T3 基线/对比 | 无遮挡元素、z-order 正常 |
| `preserveDrawingBuffer` 相关取图差异 | 对比 `browser_screenshot`（合成结果）与页面 `canvas.toDataURL()`（需 `browser_eval`）是否一致 | 两者一致 |
| 软件渲染（SwiftShader 等） | 环境信息：GPU/渲染后端/headless 标志（`browser_eval` 读 `navigator.gpu` 或调试信息；`browser_capabilities` 的运行态） | 同一环境下多次复现且与硬件环境结果一致 |
| 内容本身不变（设计静态） | 声明层显示无动画；或动画只作用于其他区域 | 有声明但渲染没跟上 |
| 只在特定时序/尺寸出现 | 多窗口/多尺寸对照（T4 `window`/`frameIds` 抽帧） | 全窗口都复现 |

写法要求：

- **观察栏**只写可复现事实（帧 id、时间窗、区域、像素统计、读数）。
- **根因栏**写候选 + 当前支持/反对证据 + 还需什么才能排除；**不得**把某个候选（如"缺 clear"、"没渲染"）直接写成结论。
- **环境栏**单列（headless/软件 GPU/DPR/scale/视口尺寸）。环境不同不能互换结论；"仅在软件渲染下出现"本身是待核实项，不是已定责。

## 5. 标准取证管线（与 visual-motion.md 一致）

```text
1) browser_navigate 与 dynamic_session{start} 同批下发（往返 ~11.7s，晚一步就丢窗口）
2) motion_analyze {type:"region-change"} 定位"哪里在动"（帧图像像素 bbox）
3) motion_observe {includeImages:true, region} 只看那块的 PNG
4) motion_analyze 七类断言按问题选；耗时用 frameIds/window 抽帧压下来
5) 需要机制对照：motion_control{adapterId:"waapi", targetIds} 暂停/seek → 再看同一区域 → restore
6) 需要因果：dynamic_correlate（explicit/redirect/initiator 才算 confirmed-causal）
```

补充约束：

- `targetIds` 来自 T2（DOM/选择器/animation id）；T4 不做 DOM 定位，也不证明元素身份。
- 整页截图"看动画"会读到页面自述的状态行（读数面板/调试叠加层），等于读答案；用 `region` 裁剪，并只把裁剪后的像素当证据。
- `screencast` 不接受 `region`/`scale≠1`/显式 png（`DYNAMIC_SOURCE_UNAVAILABLE`）；要精确像素就换 `screenshot-loop`。
- `motion_observe` 的 `region` 是帧图像像素（整数），且必须与 `includeImages:true` 同用；`roiSha256` 只证明裁剪后像素，不能当整帧 hash。

## 6. 合成正例 / 反例

**正例：静态内容 + 声明证据 = 不判缺陷**

```text
声明层：页面上有 canvas，无 CSS 动画，只有一次初始绘制
采样层：3s 内 frame-diff 无变化、无丢帧、p95 与请求间隔一致
效果层：区域像素与初始帧一致
结论：PASS（"内容不变"是设计）；不写"未渲染"，也不写"缺 clear"
```

**反例：把采样不足写成"没有异常"**

```text
请求 sampleIntervalMs=100；实测 p50=110ms；目标是一个 80ms 的瞬时变化
错误写法：未检出闪烁 → "无闪烁"
正确写法：INCONCLUSIVE + INSUFFICIENT_TEMPORAL_RESOLUTION（采样分辨率不足）
```

**反例：把"像素不变"写成"未渲染"**

```text
观察：区域 3s 内像素恒定，但 rAF 计数在涨、上下文中未捕获异常
错误写法：动画未渲染 → FAIL（机制错）
正确写法：观察"像素恒定"；候选机制列 3–4 条（停帧/同色覆盖/内容本身不变/累积但被覆盖），
         逐条写仍需什么证据；verdict 由断言（例如"应出现可见变化"）与契约决定，
         机制列为待排除项，不写成已定责
```