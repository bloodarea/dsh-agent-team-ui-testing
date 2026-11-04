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
- **`region` 只交付该矩形**（帧图像像素，PNG，需配合 `includeImages`）：用于「只看动画那一块」，避免把整页内容喂给 Agent；不带 `region` 时原样交付整帧 JPEG 且不解码。
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

- 40 条动态行为门槛当前为 8 通过 / 20 部分 / 12 未运行 / 0 失败。未运行项包括 close/dispose 恢复、WebGPU 渲染、媒体 seek/stall、header 校验身份与长连接稳定性，**不能当作已通过**。
- 16 ms 级闪白可能采样不到；采样覆盖不足不等于「无闪烁」。
- 页面账本证据依赖页面自述，属 `page-declared`，需要独立旁证才能当因果。
- 关联头在采集侧默认脱敏，因此 header 身份不能独立核验。
