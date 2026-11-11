# 视觉与动态场景调试手册（T3 静态 / T4 时序）

> 面向**没有上下文**的 Agent：照本文管线走就能调动画，不必先读源码。
> 权威契约 [docs/t4-dynamic-behavior.md](../../../../docs/t4-dynamic-behavior.md)、实现冻结 [docs/t4-dynamic-behavior.md](../../../../docs/t4-dynamic-behavior.md)。

## 0. 先选层，别用错工具

| 你要回答的问题 | 用哪层 |
| --- | --- |
| 元素在哪、能不能点、点了没反应 | T2（`browser_snapshot` / `node_state` / `click`） |
| 改前改后两张图差在哪、颜色对不对、有没有被遮挡 | T3（`browser_vision_image` / `compare`） |
| **动画顺不顺、闪不闪、卡不卡、冻结多久、过渡多长、动的是哪块** | **T4** |
| **这次点击/请求是不是导致了画面变化** | **T4 `dynamic_correlate`** + P0 网络 |

单张截图、`browser_state.seq`、面板 `/metrics` **都不是** T4 帧证据。

## 1. 三条铁律（都是踩过的坑）

**① 不要用整页截图"理解动画"。**

页面经常把答案直接画在画面上——例如把 `t=…ms tx=… opacity=…`、`rgb=…,…,…` 这类状态行写进面板。拿整页图去"看动画"，等于**读答案**而不是看运动，结论不可信；而且浪费：整帧 JPEG 体积通常是裁剪区域 PNG 的十倍以上。



**② 算力靠抽帧，不靠 `region`。**

JPEG 必须**整帧解码**，`region` 只缩小比较范围与输出噪声，**不降低解码成本**。实测：同一批帧 176 帧全帧分析 **20.5s → `BLOCKED(dynamic-timeout)`**；抽 6 帧只要 **883ms**（快 23×）。所以：

- 耗时不够 → 减 `frameIds` / 收窄 `window`；
- token / 带宽不够 → 用 `region` 裁剪。

**③ 采样没覆盖 ≠ 没有异常。**

16ms 级闪白在 damage 驱动的 screencast 里可能一帧都抓不到。这时只能报 **`INCONCLUSIVE`（采样不足）**，**绝不许写"无闪烁/无卡顿"**。

## 2. 标准管线（6 步）

### Step 0 · 打开页面并立刻开始采集

Agent 一次工具往返实测约 **11.7s**。若先 `navigate`、下一轮再 `start`，观察窗口可能已经过去（很多动画 3s 就停）。**把 `browser_navigate` 与 `browser_dynamic_session{action:"start"}` 放在同一批下发**——实测可压到导航完成后 **6–21ms** 即开始采集。

```text
browser_navigate { url }
browser_dynamic_session { action:"start",
  config:{ captureVisual:true, source:"screencast", durationMs:60000 } }
```

- `screencast`：共享预览流、JPEG、**damage 驱动**（页面不动就没帧），适合"看动的东西"。
- `screenshot-loop`：PNG、`precise:true`、**按间隔采样**（50–1000ms），页面静止也能出帧，适合"精确像素/颜色等值"。
- 不够长用 `action:"extend", durationMs`（单次 ≤60000、累计 ≤300000ms，仅 `running` 有效）。

### Step 1 · 定位动画区域（两种来源，任选）

**A. 纯像素（推荐，不需要 DOM）**

```text
browser_motion_analyze { motionSessionId, frameIds:[<少量帧>],
  assertions:[{ id:"where", type:"region-change",
                thresholds:{ pixelThreshold:0.1, changeRatio:0.005, minArea:300 } }] }
```

返回 `regions[]`：`{region:{x,y,width,height}, area}` —— "哪块在动"，坐标是**帧图像像素**。

**B. DOM 辅助（需要精确到元素时）**

```text
browser_snapshot / browser_node_state → 元素 bbox（CSS px）
换算：imagePx = (cssPx − originCss) × cssPerPixel     # 见帧的 mapping
```

### Step 2 · 收窄 + 抽帧（把成本压下来）

```text
browser_motion_analyze { motionSessionId,
  frameIds:[<6–10 个跨时间点的 frameId>],        // 关键：别用全序列
  assertions:[{ id:"in-panel", type:"frame-diff", region:{x,y,width,height} }] }
```

- 帧要**跨时间分布**（如 t≈250 / 1500 / 2700ms），否则看不出运动方向。
- 每个断言都回 `resolvedThresholds` / `sampleCount` / `limitations` —— 判读要看这些，不要只看 `verdict`。

### Step 3 · 判定（七类断言，按问题选）

| 你的问题 | 断言 | 必给参数 | 通过条件 |
| --- | --- | --- | --- |
| 两块/两帧差多少 | `frame-diff` | — | 未达 `changeRatio` → PASS |
| 哪里变了、面积多大 | `region-change` | — | 未检出区域 → PASS |
| 闪一下又回来 | `flicker` | — | A→B→A 三帧 + `changeRatio≥0.2` + `brightnessDelta≥64` 才算检出 |
| 卡住/冻结 | `freeze` | **`expectation`** | 必须给可核验"预期应动"声明 + 独立推进旁证 + ≥3 次复核 |
| 掉帧/卡顿 | `jank` | **`expectedIntervalMs`** | 间隔 > `expectedIntervalMs × intervalFactor` 为怀疑 |
| 目标往哪走、是否连续 | `trajectory` | **`query`**（color/template） | 唯一且连续 → PASS；歧义 → INCONCLUSIVE |
| 过渡从哪开始、多长 | `transition` | — | 首次越阈值 + 连续 `stableSamples` 次稳定 → PASS |

### Step 4 · 只看那一块（crop-on-delivery）

```text
browser_motion_observe { motionSessionId, frameIds:[...], includeImages:true,
  region:{x,y,width,height} }        // 只交付这块；不带 region 则整帧 JPEG
```

- 带 `region` → 返回**裁剪后 PNG**（`mediaType:"image/png"`、尺寸=region），并附 `crop:{region, sourceSha256, sourceDimensions, sourceEncoding, roiSha256, outputBytes}`。
- `roiSha256` 是**裁剪后像素**的 hash，与整帧 `encodedSha256` **不是一回事**，别互相冒充。
- 越界 / 只给 `region` 不给 `includeImages` → `DYNAMIC_INVALID_ARGUMENT`（不静默 clamp）。
- 解码失败不抛错：该帧不给图 + `crop.failed:true` + `incomplete:["crop-unavailable"]`。
- 需要遮挡（游标/水印）才用 `analyze` 的 `masks`；`observe` 不带 masks。

### Step 5 · 消融实验（把"相关"变成"因果"）

```text
browser_motion_control { motionSessionId, action:"pause",
  adapterId:"waapi", targetIds:["<selector 或 animation.id>"] }
→ observe { region } 看哪块停了 / 哪块还在动
→ browser_motion_control { action:"restore", restoreToken }
```

- `targetIds` 来自 **T2**（DOM selector / animation id）——T4 只做像素观测，不做 DOM 定位。
- 会话到期或 `reset` 会尽力恢复（`restoreStatus` / `restores[]`），但**显式 `restore` 才可预期**。
- 只有 `pause/seek` 后**画面区域真的变化/停止**，才能说"这块由这个适配器驱动"。

### Step 6 · 跨域关联

```text
browser_network_session { action:"start" }            # 需要网络侧时
browser_dynamic_correlate { dynamicSessionId, motionSessionId, networkSessionId,
  directions:["operation->visual","network->visual"] }
```

- `explicit` / `redirect` / `initiator` 才是 **confirmed-causal**；`observed` 只是关联；`temporal` 默认**不返回**。
- 页面 `ui.cause` / `causeOpId` 是**声明证据**，须另有独立旁证（真实 response/WS 事件、DOM 回读、帧像素）才能升级。
- 没有共同 ID 或协议父端点 → 只能 `unresolved`。别把"时间挨得近"写成因果。

## 3. 判读红线

| 情况 | 必须报 |
| --- | --- |
| 缺帧、解码失败、时钟不可比、几何不兼容 | `INCONCLUSIVE` / `BLOCKED` + `reasons` / `incomplete` |
| 采样窗口内没出现异常 | "采样不足"，**不是** "无异常" |
| 帧被淘汰/丢帧/截断 | 看 `dropped/evicted/truncated/gaps/ackFailures` 并写进结论 |
| 只有 JPEG 帧 | `precise:false` + `limitations:["jpeg-compression-noise"]`；精确等值改用 `screenshot-loop` |
| 关联只有 `observed` | 写"关联"，**不写"因果"** |

## 4. 常见失败与恢复

| 现象 | 原因 | 怎么做 |
| --- | --- | --- |
| `BLOCKED(dynamic-timeout)` + `budget-exhausted` | 帧太多，纯 JS 解码超 5s | 用 `frameIds` 抽 6–10 帧，或收窄 `window` |
| `regionsTruncated:true` | JPEG 噪声碎出上百小区 | 提高 `minArea`（≥300），或先用 `region` 收窄 |
| `issues:["no-damage-frames"]`、`captured:0` | 页面静止（damage 驱动） | 换 `source:"screenshot-loop"`，或先让页面动起来 |
| `DYNAMIC_SESSION_NOT_ACTIVE` | 会话已到期/已停，`extend` 不复活 | 重新 `start`（`durationMs` 给足） |
| `DYNAMIC_CONTROL_CONFLICT` | 页面代次/目标变了，或外部改了同一字段 | 重新定位目标，别强行覆盖 |
| `DYNAMIC_LIMIT_EXCEEDED{sessionCapMs}` | 累计会话时长到 300000ms | 收新会话 |
| `crop.failed` / `crop-unavailable` | 该帧解码失败 | 跳过该帧；结论用其它帧，否则 `INCONCLUSIVE` |

## 5. 成本参考（实测，1024×768）

| 操作 | 耗时 / 体积 |
| --- | --- |
| 6 帧 `region-change` | **883ms** |
| 176 帧 `frame-diff` 全序列 | **20.5s → BLOCKED** |
| 整帧 JPEG 交付 | **61,824 B/帧** |
| 裁 243×139 交付 PNG | **4,198 B/帧（14.7× 缩小）** |
| screencast 采集密度 | 实测相邻帧 ~16ms；60s 会话 3517 帧、`ackFailures:0` |

## 6. 交付要求

每次 T4 结论至少带：`dynamicSessionId` / `motionSessionId`、时间窗口或 `frameIds`、`verdict` 与 `resolvedThresholds`、`integrity`（含 dropped/evicted/truncated）、证据引用（frameId / `roiSha256` / 图片路径或交付方式）。**

## 7. T3 静态侧的边界（本节保留）

`browser_screenshot` 可保留 PNG base64 并经可选附件服务 render image block；缺服务为 base64-fallback 文本，provider 可见性需另验。P0 截图支持显式 `scale` 0.1–4（省略跟随共享 `view.scale`）/ 画布 CSS `region` / PNG 校验；`includeAnnotations?:boolean=false` 为 true 时按相同 region/scale 叠加 Host 已接受的六种面板形状，不含未提交草稿/工具栏，证据见 `capture.annotations`。默认截图、T3 原始源及 T4 两种帧源不含面板标注；`persist` 默认 false（暂存，dispose 清理），`out`/`persist:true`/非空 env 才持久。`file.pathKind`/`persistence`/`root`/`ephemeral` 必须随证据记录，`observed` 不含绝对路径；**暂存不能当持久引用**。原始图像可见性不等于像素差异/基线阈值/VLM 管线；不能把"截图动作成功"判成视觉 PASS。定量视觉条件缺证据时一律 `BLOCKED`/`INCONCLUSIVE`。