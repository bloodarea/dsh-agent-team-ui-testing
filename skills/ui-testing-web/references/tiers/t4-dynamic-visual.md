# T4 · 动态行为

**实现状态：已实现并注册 5 个工具。** 44 条门槛中 12 条通过、20 条部分通过、12 条未运行，未运行项不得写成通过。权威契约：[能力分层与接口 · Chrome T4](../../../../docs/capability-tiers.md#web-chrome-t4)。

## 能用什么

| 能力 | 工具 | 说明 |
| --- | --- | --- |
| 连续帧采集 / 续约 | `browser_dynamic_session` | `source:"screencast"` 共享预览 JPEG 流（唯一协调器、唯一 ACK、有界存储、dropped/evicted 计数）；`source:"screenshot-loop"` PNG 精确采样（50–1000ms，单飞，真实采样区间） |
| 时间轴查询 | `browser_motion_observe` | 帧/事件只读查询、`fresh` 显式采样、**`region` crop-on-delivery（只看动画那一块）**；只读不 ensure、不续租 |
| 运动分析 | `browser_motion_analyze` | `frame-diff` / `region-change` / `flicker` / `freeze` / `jank` / `trajectory` / `transition`，确定性阈值 + `resolvedThresholds` + limitations |
| 时间控制 | `browser_motion_control` | WAAPI `pause/resume/seek/rate/restore`，逐目标回读，`restoreToken`，部分应用与恢复状态如实报告 |
| 事件关联 | `browser_dynamic_correlate` | 六向关联，`explicit/redirect/initiator`=confirmed-causal，`observed`=关联，`temporal` 默认过滤，输出 pairs/unresolved/suppressedTemporal/integrity |

动态网络（DN）继续复用 7 个 `browser_network_*`（HTTP/WS/SSE/轮询/重放/证据/订阅），**没有第二套抓包 API**。

## 怎么用（最短路径）

```text
1) browser_dynamic_session { action:"start", config:{ captureVisual:true, source:"screencast", durationMs:3000 } }
   → { dynamicSessionId, motionSessionId }
2) 执行被测动作（browser_click / 页面 __t4 方法 / 导航）
3) browser_motion_observe { motionSessionId, sinceSeq:0, limit:50 }        # 帧元数据 + 事件
4) browser_motion_analyze { motionSessionId, window:{fromMs,toMs},
     assertions:[{ id:"a1", type:"jank", expectedIntervalMs:16, thresholds:{ intervalFactor:2 } }] }
   → verdict/exitCode/summary；证据不足是 INCONCLUSIVE/BLOCKED，不是 PASS
5) 需要精确像素：另起 source:"screenshot-loop"（PNG，precise=true）再 analyze
6) 需要控制：browser_motion_control { motionSessionId, action:"pause", adapterId:"waapi", targetIds:["#t4v-css-orb"] }
   然后 action:"restore" + restoreToken 复原
7) 需要关联：先 browser_network_session start，再
   browser_dynamic_correlate { dynamicSessionId, motionSessionId, networkSessionId, directions:["network-visual"] }
8) 分析耗时较长：browser_dynamic_session { action:"extend", durationMs:30000 }   # 续约（单次≤60000、累计≤300000ms，仅 running 有效）
9) browser_dynamic_session { action:"stop" }   # 尽力恢复本会话控制字段
```

## 三条铁律（详版方法论见 `references/scenarios/visual-motion.md`）

1. **不要用整页截图"理解动画"**：页面常把状态行（形如 `t=…ms tx=… opacity=…` 的读数）画在画面上，整页图等于泄漏答案；且整帧 JPEG 体积通常是裁剪区域 PNG 的十倍以上。先 `region-change` 定位 bbox → 再 `observe {region}` 只看这块。
2. **算力靠抽帧不靠 region**：JPEG 必须整帧解码；176 帧全序列 **20.5s→BLOCKED**，抽 6 帧 **883ms**。
3. **采样没覆盖 ≠ 没有异常**：16ms 闪白抓不到即报"采样不足"，不写"无闪烁"。

## 判读规则（必须遵守）

- 帧证据：`sourceTimestamp` 是原始 CDP 秒（缺失为 `null`，**不得**用接收时刻填充）；`encodedSha256` 与 `rgbaSha256` 分列，编码字节不同 ≠ 画面变化；`dropped/evicted/ackFailures/gaps/truncated` 必须计数并看。
- 精度：`screencast` 是 JPEG（`precise=false`，`limitations` 含 `jpeg-compression-noise`），只做粗粒度亮度/变化率判定；精确像素/颜色等值只用 `screenshot-loop` 的 PNG。解码失败 → `INCONCLUSIVE(decoder-unavailable)`。
- 负结论门槛：`flicker` 需要 A→B→A 三帧；`freeze` 需要可核验的「预期应动」声明 + 独立推进旁证 + ≥3 次像素复核；`jank` 的 `expectedIntervalMs` 必须显式给（不是面板 40ms 预览间隔）。**采样没覆盖到 ≠ 没有异常**。
- 会话生命周期：`durationMs` 默认 3000、硬上限 60000。Agent 一次工具往返约 11.7s，**多步取证必须显式给 `durationMs` 或用 `extend` 续约**；`extend` 仅对 `running` 有效（已停会话返回 `DYNAMIC_SESSION_NOT_ACTIVE`，不复活），累计 ≤300000ms，不放大帧/字节/算法预算。用 `deadlineMs`/`cumulativeMs` 判断剩余时间。
- 控制：只对已声明目标；`restore` 只还原本会话改过的字段；页面代次/目标变化 → `DYNAMIC_CONTROL_CONFLICT`，不覆盖外部新状态；不擅自暂停被测应用。
- 关联：无共同 ID 或协议父端点不得判因果；同 trace/幂等键只证明同组；页面 `ui.cause`/`causeOpId` 是声明证据，需独立旁证（真实 response/WS 事件、DOM 回读、帧像素）才可升级；跨 scope / documentEpoch 不合并。

## 未验证（不得写成可用）



## 不要再用旧说法

- T4 的 screencast/screenshot-loop 两种帧源均不含面板标注；`browser_screenshot {includeAnnotations:true}` 只生成带 Host 已接受标注文档的静态截图，不影响 T4 采帧。
- 单张 `browser_screenshot`（含带标注截图）、T3 的 before/after 两帧、面板 `/metrics` 与 `browser_eval` 读页面状态都**不是** T4 帧序列证据。
