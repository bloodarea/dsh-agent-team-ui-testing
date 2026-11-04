# 能力贯通手册（T1 / T2 / T3 / T4 / P0 怎么组合用）

> 工具面 **35 个**：T1 10 + T2 7 + T3 6 + 网络 P0 7 + 动态 T4 5。
> 本文是**选路 + 组合配方**；单层细节见 `references/tiers/*.md`，动画调试全流程见 `references/scenarios/visual-motion.md`。

## 0. 先探能力，别假设

```text
browser_capabilities {}
```

按实测三态选路（`available` / `unavailable` / `unsupported`），**不要拿文档或 manifest 当运行态证据**。能力报告本身不启动浏览器、不占租约、不产证据；它自己抛错时也不能当结论。

## 1. 五层速查：谁负责什么、给什么证据、不能冒充什么

| 层 | 工具数 | 回答什么 | 唯一可信证据 | 不能证明 |
| --- | --- | --- | --- | --- |
| **T1 程序化** | 10 | 地址/标题/运行时错误、JS 值、计算样式、原始输入、独立 HTTP、共享视口、预览网络 | `browser_state`、`browser_eval` 返回值、`computed_style`、`http_request` 的 status/headers/body | 像素正确性、动画流畅性、语义可访问性 |
| **T2 结构化** | 7 | 元素是什么（role/name）、能不能点、点了有没有派发、表单填对没 | `snapshot` 的 AX 树、`node_state` 回读、`dispatch` 证据、页面真值 | `dispatched:true` ≠ 业务生效；ref 只在本 workspace Runtime 有效 |
| **T3 静态视觉** | 6 | 像素差异、颜色/区域/遮挡/溢出/截断、基线回归、图像内定位 | `vision_compare` 的差异图+比值+阈值、`vision_check` 的 verdict、`vision_find` 候选 | 时长/流畅度/闪烁；`vision_act` 的 `dispatched` 只是派发 |
| **T4 动态行为** | 5 | 帧序列、间隔/抖动、冻结、闪烁、轨迹、过渡、跨域关联 | 帧 `sourceTimestamp`+hash+`integrity`、`motion_analyze` 的 verdict+metrics | 技术身份（CSS/Canvas/WebGL/video）、属性值、语义命名 |
| **P0 网络** | 7 | 请求/响应/时序/依赖/重试、WS/SSE、拦截/重放/Mock、证据包 | `network_events` 时间轴、`detail` 的 body 三态、`trace` 的显式因果 | 页面**语义**因果；脱敏头不能做 header-verified 身份 |

**跨层铁律**：每层只对自己的证据形式负责；**低层的"动作成功"不能升级成高层的"结果正确"**。

## 2. 选路决策树

```text
断言是"某个值/状态"？            → T1（eval / state / computed_style / http_request）
断言是"元素语义 or 交互发生"？     → T2（snapshot → 动作 → node_state/wait_for 回读）
断言是"像素/颜色/布局正确"？       → T3（vision_image/compare/check；有基线用 check 回归）
断言是"时间/运动/过渡/闪/卡"？     → T4（dynamic_session → motion_analyze）
断言是"网络请求/响应/时序/重试"？   → P0（network_session → events → detail → trace）
断言是"A 导致 B"？                → 跨层：correlate + 独立旁证；只有 explicit/redirect/initiator 才叫因果
```

同一断言要多种证据时**分别记账**，不做加权平均。

## 3. 八个贯通配方（可直接照抄）

### R1 · 按钮点了没反应

```text
1. browser_snapshot                → 拿 ref（用 role/name 确认是对的那个）
2. browser_click { ref }           → 记 dispatch 证据（dispatched:true 只证明派发）
3. browser_state / browser_eval    → 页面状态变没变
4. browser_network { limit:50 }    → 有没有发请求、请求成没成（limit 别给太小，会被自身流量挤出窗口）
5. 若 NOT_INTERACTABLE             → 记 FAIL；用 T3 vision_image 给遮挡/隐藏的成因证据，不硬点、不改坐标
```

判据：`NOT_INTERACTABLE` 本身即缺陷结论；`dispatched:true` 而状态未变 → 走 R2。

### R2 · "提交后列表应该刷新"

```text
P0: browser_network_session { action:"start" }
P0: browser_network_trace { action:"begin-step", name:"submit" }
T2: browser_snapshot → browser_click / browser_fill_form
P0: browser_network_trace { action:"end-step" }
P0: browser_network_events { filter:{ stepId, status:200 } }   → 请求与载荷
T2: browser_wait_for { textGone:"提交中" } 或 state 条件        → DOM 终态
T3: browser_vision_check 基线回归                                → 渲染终态
```

判据：**请求 200 + DOM 终态 + 渲染终态**三份证据分别成立；缺一项写"部分验证"，不要合成一个 PASS。

### R3 · "动画该 300ms 且流畅"

```text
0. browser_navigate 与 browser_dynamic_session{start} 同批下发（Agent 往返 ~11.7s，否则错过窗口）
1. T4 motion_analyze { type:"transition" }                     → 起止时刻与稳定判定
2. T4 motion_analyze { type:"jank", expectedIntervalMs:16.7 }   → 间隔分布/p95/max
3. T4 motion_observe { region, includeImages:true }             → 只看动画本体（避免读到页面自述文字）
```

判据：`transition` 答"从哪到哪、用了多久"；`jank` 答"间隔是否超预期"。**采样没覆盖到写 INCONCLUSIVE**。

### R4 · "闪一下就没了"

```text
T4 dynamic_session { config:{ source:"screenshot-loop", sampleIntervalMs:50 } }  # 静止页面也出帧
T4 motion_analyze { type:"flicker" }    # 需 A→B→A 三帧 + changeRatio≥0.2 + brightnessDelta≥64
```

判据：未检出时，若采样间隔 > 目标闪烁时长 → **必须写"采样不足"**，不许写"没有闪烁"。

### R5 · "点了按钮但画面好像没变"

```text
T4 dynamic_session{start}（同批下发）→ 点击 →
T4 motion_analyze { type:"region-change", thresholds:{minArea:300} }   → 有变化吗、变在哪
T4 motion_observe { region:<变化区>, includeImages:true }              → 看那块变成什么
T3 browser_vision_compare { before, after, region }                    → 需要精确像素/颜色时
```

判据：能区分三种情况——**真的没变**（无区域）／**变了但很小**（区域 <minArea）／**变了、我没注意到**（区域明确）。

### R6 · "错误横幅是因为那个 500 吗"

```text
P0: events filter status>=500 → 拿 traceId/时间
T4: dynamic_session{start} + 复现动作 → 抓横幅出现时刻（region-change）
T4: browser_dynamic_correlate { directions:["network->visual"] }
```

判据：`explicit/redirect/initiator` → 可写**因果**；只有 `observed` → 写**关联**；页面 `ui.cause` 是**声明**，须独立旁证。

### R7 · 端到端回归（下单/登录/发布）

```text
T1: browser_http_request 直接验契约（status/headers/body/幂等键）
T2: 走一遍真实交互（ref + dispatch + 回读）
P0: 全程采集，network_evidence 导出 JSONL/HAR 留证
T3: 关键节点 vision_check 基线回归
T4: 骨架屏/加载态/过渡用 motion_analyze 判时序
```

判据：契约、交互、网络、渲染、时序**五份证据分列**；任何一层 NOT_RUN 都要写进结论。

### R8 · "页面卡/白屏/像挂了"

```text
T4 motion_analyze { type:"freeze", expectation:"<可核验的应动声明>" }  → 冻结区间
T4 motion_analyze { type:"jank", expectedIntervalMs:16.7 }             → 掉帧程度
P0 network_events { view:"timeline" }                                  → 资源是否排队/失败
T1 browser_eval 读 window.onerror / 未捕获异常；browser_state.error
```

判据：`freeze` 必须给可核验 expectation（如"这里应每 16ms 有帧"），否则 INCONCLUSIVE。

## 4. 升级与降级（回退链）

| 场景 | 允许的回退 | 禁止 |
| --- | --- | --- |
| T2 找不到元素语义 | T3 `vision_find`（template/color）拿候选 → T3 `vision_act` 派发 | 拿"看起来像"的坐标硬点；声称 `dispatched` 等于点中 |
| T2 `UNSUPPORTED`（contenteditable/number/date/file） | T1 `browser_input` + 读回，注明证据强度不同 | 假装 T2 成功 |
| T2 `NOT_INTERACTABLE` | 记 FAIL + T3 给成因 | force click / 改坐标 / 换相似节点凑 PASS |
| T4 预算超时 | 用 `frameIds`/`window` **抽帧**后重跑 | 抬 `algorithmBudgetMs` 掩盖；用单帧代替时序 |
| T4 采样不足 | 写 INCONCLUSIVE | 写"无闪烁/无卡顿" |
| P0 头被脱敏 | 只能 `observed` + 独立旁证 | 声称 `header-verified` |
| 某层 unsupported | `BLOCKED` + 写明缺哪项 | 用别的层的近似证据顶替 |

## 5. 证据合成（跨层不串味）

| 层 | 结论必须带 |
| --- | --- |
| T1 | actionId、`state.running`、返回值原文（JS 值标 page-eval）、`http_request` 的 status/headers 摘要 |
| T2 | `snapshotId`/`digest`、`targets[].resolved`、`dispatch`、动作前后 `node_state` |
| T3 | source（live/product/baseline）、尺寸、差异比值/阈值、productId 或基线 revision、落盘路径与 sha256 |
| T4 | `dynamicSessionId`/`motionSessionId`、窗口或 `frameIds`、`verdict`+`resolvedThresholds`+`integrity`、`roiSha256` |
| P0 | `networkSessionId`、`seq`/`requestId`、body 三态（captured/empty/unavailable）、脱敏记录、导出路径 |

**权威序**：DOM/AX 回读 > 像素证据 > 页面自述（`ui.*` 声明）。页面自己写的不算独立证据。

## 6. 跨层错误码速查

| 错误 | 层 | 含义与动作 |
| --- | --- | --- |
| `BUSY` | 页面操作 | 其他 owner 持租约；等待，不轰炸重试 |
| `VIEWPORT_CONFLICT` | T1 viewport | `expectedRevision` CAS 失败、patch 零应用；重读再改 |
| `REF_STALE` | T2 | 导航/刷新/新快照导致；重新 `snapshot` |
| `TARGET_NOT_UNIQUE` / `TARGET_NOT_FOUND` | T2 / T4 control | 用 ref 或更精确 selector；不要取第一个 |
| `NOT_INTERACTABLE` | T2 | hidden/disabled/covered/零面积/运动中 → 记 FAIL，T3 给成因 |
| `WAIT_TIMEOUT` | T2 | 条件未满足（page 不关闭）；不缩小预算掩盖 |
| `UNSUPPORTED` | T2 / T4 | 控件/适配器不支持；走回退链并标注强度 |
| `DYNAMIC_SESSION_NOT_ACTIVE` | T4 | 会话已停/到期，`extend` 不复活 → 重新 `start` |
| `DYNAMIC_LIMIT_EXCEEDED{sessionCapMs}` | T4 | 累计 300000ms 到顶 → 收新会话 |
| `DYNAMIC_CONTROL_CONFLICT` | T4 | 页面代次/目标变了 → 重新定位，别覆盖 |
| `BLOCKED(dynamic-timeout)` | T4 | 帧太多解码超 5s → **抽帧** |
| `VISION_STALE_IMAGE` / `VISION_HIT_MISMATCH` | T3 act | 图过期/命中不一致 → 重新采图，零派发 |
| `NET_BODY_UNAVAILABLE` | P0 | body 没采到 → 如实标注，不伪造空体 |

## 7. 租约与并发（最容易踩）

- 一个 **workspace 一个 page**；人类与 Agent 共用同一队列。**页面操作**（T1 viewport set / 截图 / T2 动作 / T3 act / P0 session start）需要 single-owner-lease；**只读**（T1 state/eval、T2 snapshot、T3 分析、T4 status/observe/analyze/correlate、P0 events）不占租约。
- `browser_capabilities` **不启动浏览器**；`browser_dynamic_session{status}`、`browser_network_session{status}` 也不启动。
- 动作状态未知时**先查状态再重试**；提交/删除/支付类操作不得盲重放。
- 不同 workspace 的 URL/viewport 独立，但 Cookie/存储共享——**不得声称跨工作区安全隔离**。

## 8. 反模式（见到就是错）

1. 把 `dispatched:true` / `applied:N` 写成"功能正常"。
2. 用 `browser_screenshot` 的"看起来对"代替 T3 像素结论。
3. 用 `browser_eval` 读 DOM/CSS 冒充 T2 语义树或 T3 像素。
4. 用单帧截图 / `browser_state.seq` 冒充 T4 时序。
5. 用整页截图"理解动画"（页面可能把答案画在画面上）。
6. 把时间邻近写成因果（`temporal` 默认不返回）。
7. 采样没覆盖就断言"无闪烁/无卡顿"。
8. 为了变绿缩小 `WAIT_TIMEOUT` 预算、抬 `algorithmBudgetMs`、放宽阈值。
9. 跨 workspace / 跨 scope 聚合证据。
10. 把页面 `ui.cause`/`causeOpId` 的自述当独立证据。
11. 同一断言混用多层证据并取"最好的那个"结论。
12. 未跑或证据不全却写"已验证"。

## 9. 已知不可用（如实 BLOCKED/UNSUPPORTED）

- iframe/OOPIF 内部、closed shadow、contenteditable 编辑器、原生 `select` popup、拖拽、上传/下载、Cookie 导出。
- 多标签页 / 跨窗口（SSO 弹窗）流程。
- T4 的 media 适配器（视频 seek/stall）、WebGPU 真实渲染、16ms 闪白采样覆盖。
- P0 的 OOPIF/HTTPS/service worker 覆盖、`header-verified` 身份（关联头脱敏）。
- 需要面板认证的路由（如 `close`/`dispose` 恢复）。

## 10. 结果要求

按层分别记录：**执行的 / 状态符合预期的 / 样式符合预期的 / 视觉已验证的 / 动态已验证的 / 网络已验证的 / 未验证的**。任何一层未跑写 `NOT_RUN`；能力不足写 `BLOCKED`；部分证据不足写 `INCONCLUSIVE`。不能把某个 T1 断言通过写成整个功能或整个 GUI 通过。