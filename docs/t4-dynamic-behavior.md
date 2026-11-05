# 动态行为

T4 用**帧序列与时间戳**判断动画、过渡、拖拽与时间相关行为。五个工具：`browser_dynamic_session`、`browser_motion_observe`、`browser_motion_analyze`、`browser_motion_control`、`browser_dynamic_correlate`。

## 会话

```text
browser_dynamic_session { action:"start", config:{ captureVisual:true, source:"screencast", durationMs:3000 } }
```

- `source:"screencast"` 复用面板预览的 JPEG 流（不额外起流，不打断预览）；`source:"screenshot-loop"` 用 PNG 精确采样，提供真实采样区间但 `sourceTimestamp:null`。
- `captureVisual:false` + `networkSessionId` 建立**纯网络关联视图**：不启动采集、不采帧。
- `action` 支持 `start`/`stop`/`status`/`reset`/`extend`。
- `extend` 只对 `running` 会话生效：单次 ≤ 60000 ms，自 `startedAt` 累计 ≤ 300000 ms；`stopped`/`retained` 返回 `DYNAMIC_SESSION_NOT_ACTIVE`，**不会复活会话**。
- `fresh:true` 与幂等 `start` **不续期**；`stop`/`reset` 会尽力恢复本 scope 的全部未结控制。
- start/status/extend/stop 的 `session.sampling` 给出**实测采样**（见下文「采样真实性」），不是把请求值当结果。

## 采样真实性（TOOL-P1-03）

每个会话（start/status/extend/stop、`browser_motion_observe` 顶层、`evidence.dynamic.sampling`）都返回同一块 `sampling`：

| 字段 | 含义 |
| --- | --- |
| `mechanism` | `screenshot-loop` / `screencast` / `network-only`（`captureVisual:false` 无像素采样） |
| `cadence` | `host-scheduled`（screenshot-loop 定时循环） / `damage-driven`（screencast 按页面损伤出帧） / `none` |
| `requested.intervalMs` / `requested.source` | 只是**请求值**：screenshot-loop 为 `setInterval(host)`；screencast 为 `null`（无目标周期） |
| `measured.frames` / `measured.intervals` | 有效采样点数与间隔数 |
| `measured.p50Ms` / `p95Ms` / `minMs` / `maxMs` / `meanMs` | 实测间隔统计（毫秒） |
| `measured.windowMs` / `effectiveFps` / `measured.from` | 采样跨度、由实测间隔推导的真实 fps、时间基准（`loop-tick-start` / `frame-timeline`；两者都来自已存帧记录，与 `browser_motion_observe` 返回的帧集合同源） |
| `counters` | `sampled`（screenshot-loop=tick 采样数，screencast=收到帧数）/ `dropped` / `evicted` / `samplingFailures` |
| `limitations` | 数据不足、采样窗口有界、缺时间戳等如实标注 |

- screenshot-loop 用**已存帧上的循环 tick 起点**（`receivedMonoMs`）实测间隔：与 `browser_motion_observe` 返回的帧集合同源，`measured.frames/intervals/p50Ms` 可与该次 observe 的帧逐一核对。单飞；错过的 tick 只计入 `samplingFailures`，不伪造帧/间隔；内部仍保留有界 tick 轨迹（最多 240 个）供诊断，但不参与 `measured` 统计。
- screencast 同样用**已存帧**的 `timelineMs` 间隔（与 observe 同源）；这是 damage-driven，**间隔不均匀**，不等于渲染帧周期。
- 数据不足时统计字段为 `null`（不是 `0`），并带 limitation；**实际 fps 以 `measured` 为准，`requested` 不能当保证**。采样统计窗口有界（最多 240 个已存帧），超出带 `sampling-window-bounded`；缺时间戳带 `frames-missing-tick-start` / `frames-missing-timeline`。
- 低采样/无采样**不得证明“无异常”或“未发生”**：闪烁分析在实测中位间隔粗于断言窗口，或完全没有可测时间基准时返回 `INCONCLUSIVE(insufficient-temporal-resolution)`；freeze/jank/transition 只在 `metrics.sampling` 与 `limitations` 披露，不改 PASS/FAIL 语义。

## 帧与完整性

| 预算 | 默认 | 上限 |
| --- | --- | --- |
| 会话时长 | 3000 ms | 60000 ms |
| 保留帧 | 180 | 300 |
| 帧字节 | 32 MiB | 64 MiB |
| 单帧像素 / 字节 | 4M px / 8 MiB | — |
| 事件 | 5000 | 20000 |

帧存储有界：淘汰、丢弃与空档全部计数（`dropped`/`evicted`/`gaps`），不会静默丢证据。每帧保留原始 `sourceTimestamp`（缺失记 `null`，不伪填），编码 hash 与 RGBA hash 分列。

## 观测

```text
browser_motion_observe { motionSessionId, sinceSeq:0, limit:50 }
browser_motion_observe { motionSessionId, includeImages:true, region:{x,y,width,height} }
```

- 只读：不 ensure、不续租、不启动浏览器。
- `cursor`/`sinceSeq`/`window`/`frameIds` 互斥；`includeImages` 最多 3 帧。
- **`region` 只交付该矩形**（帧图像像素 `image-px`，PNG，需配合 `includeImages`）：用于「只看动画那一块」，避免把整页内容喂给 Agent；不带 `region` 时原样交付整帧 JPEG 且不解码。注册 JSON schema 已列出 `region`（`x/y/width/height` 非负整数，`width/height ≥ 1`），与 handler 行为一致。
- 顶层返回 `sampling`（与会话块同一结构），并在 `evidence.dynamic.sampling` 内附同一块；即使会话已停止、帧被淘汰，也能读到实测采样节奏。
- 越界、负值、零面积，或给了 `region` 没给 `includeImages` → `DYNAMIC_INVALID_ARGUMENT`，不 clamp、不静默忽略。

## 分析

`browser_motion_analyze` 支持七类断言：

| 断言 | 判断内容 |
| --- | --- |
| `frame-diff` | 两帧像素差异 |
| `region-change` | 指定区域变化 |
| `flicker` | 闪烁 |
| `freeze` | 冻结 |
| `jank` | 采样间隔异常 |
| `trajectory` | 轨迹 |
| `transition` | 过渡过程 |

- 离线执行，不采新帧；单次最多 20 条断言。
- 结论优先级 `FAIL > BLOCKED > INCONCLUSIVE > WARN > PASS`；`exitCode` 为 1/2/0。
- 预算耗尽或超时如实返回 `BLOCKED(dynamic-timeout)`，并给出 `budgetUsedMs`/`budgetSplitMs`。
- 采样没覆盖不等于没有异常；`complete:false` 会带可读原因（缺失时间戳、空档、解码失败等）。
- flicker/freeze/jank/transition 的 `metrics.sampling` 给出实测间隔；采样不足时附 `limitations:["sampling-coarser-than-assertion-window"]`，**不改变 PASS/FAIL 语义**。
- `flicker` 的阴性结论只有在实测中位间隔 ≤ 断言窗口（`maxDurationMs`，默认 100 ms）且时间基准可用时才成立；否则 `INCONCLUSIVE(insufficient-temporal-resolution)`（完全无时间基准时同样如此，`metrics.sampling.insufficientReason="no-interval"`）。`flicker-too-long` / `brightness-below-threshold` 的 PASS 语义不变。
- 断言规格可发现：`browser_capabilities.dynamic.assertions` 直接投影纯核心导出的 `MOTION_ASSERTION_SCHEMA`（七类的 `allowed`/`required`/字段类型、枚举、`thresholds.allowed/defaults`、`maxAssertions`、`idPattern`）；`dynamic.sampling` 说明 requested/measured 语义，顶层 `limitations` 明示低采样声明。

## 控制

`browser_motion_control` 对 WAAPI 动画做真实时间轴控制：

```text
{ motionSessionId, action:"pause", adapterId:"waapi", targetIds:["#orb"] }
{ motionSessionId, action:"seek",  timeMs:500 }
{ motionSessionId, action:"rate",  rate:0.5 }
{ motionSessionId, action:"restore", restoreToken }
```

- `targetIds` ≤ 20；支持 `waapi-N`、动画 id 与 CSS selector；多匹配 `TARGET_AMBIGUOUS`，未知 `TARGET_NOT_FOUND`。
- 逐目标回读 `before`/`after`，返回 `applied`/`failedIndex`/`restoreStatus`。
- `restore` 使用 `restoreToken`；若外部已改动则报 conflict，不覆盖。
- **不承诺「冻结整个浏览器」**；像素证据仍以 `observe`/`analyze` 为准。
- media 适配器当前不可用，能力报告如实标注。

## 关联

`browser_dynamic_correlate` 在帧与网络事件之间做六向关联：

```text
operation→visual  operation→network  network→visual
visual→network    network→network    visual→visual
```

- 只有 `explicit`/`redirect`/`initiator` 算 confirmed-causal；`observed` 只是关联；`temporal` 默认过滤，需 `includeTemporal:true`。
- 没有共同 ID 时不判因果，只进 `observed`/`temporal`/`unresolved`。
- 候选预算 `maxCandidateCompares=40000`；同域候选先按时间窗预筛。超出预算如实返回 `candidate-budget-exhausted` 与 `truncated:true`。
- `verdict` 固定 `INCONCLUSIVE(no-assertion)`：关联结果本身不构成断言通过。

## 推荐流程

```text
navigate + dynamic_session start（同批下发）
→ motion_observe 定位帧
→ motion_analyze 跑断言
→ motion_observe {region, includeImages} 只看目标区域
→ motion_control 消融验证
→ dynamic_correlate 与网络时序对齐
```

## 限制

- 动态行为验收（DV/DN/DC 三组，跑在真实无头 Chromium 上）中仍有 NOT_RUN/PARTIAL 子项：close/dispose 恢复、WebGPU 渲染、媒体 seek/stall、header 身份、长连接稳定性等，**不能当作已通过**；`NOT_RUN` 不是 `PASS`。
- 16 ms 级闪白可能采样不到；**低采样/无采样不得写成「无闪烁」或「未发生」**——阴性结论只在实测中位间隔覆盖断言窗口时成立，否则必须报 `INCONCLUSIVE(insufficient-temporal-resolution)`/`BLOCKED`。
- 采样率是实测值而非承诺：screenshot-loop 为 host-scheduled（单飞，受抓图耗时限制），screencast 为 damage-driven（间隔不均匀、可能大段无帧）；`sampling.requested.intervalMs` 只是请求，实际 fps 以 `sampling.measured` 为准。
- 采样统计窗口有界（最多 240 个已存帧）；需要更长窗口时按段多次查询，不能把截断窗口当全程。
- 页面账本证据依赖页面自述，属 `page-declared`，需要独立旁证才能当因果。
- 关联头在采集侧默认脱敏，因此 header 身份不能独立核验。
