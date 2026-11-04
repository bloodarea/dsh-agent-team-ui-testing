# WEB-T4 动态视觉靶机（`/web-t4-visual.html`）

> 状态：**T4 准备资产**。本页只用于证明“动态视觉靶机 + 真值 API + 验收证据”可复现；
> **T4 能力仍未实现**（工具面仍 30，`web.t4.dynamic-vision` 仍 `unsupported`，不注册任何
> `browser_motion_*` / T4 工具）。冻结口径见 [t4-prep-contract.md](t4-prep-contract.md) §1。
>
> 实现：`web-t4-visual.html`（内联 CSS/JS）+ `t4-visual-route.mjs`（路由）+ `t4-visual-media.webm`
> （生成的 3 s WebM）。验收：`tests/acceptance/t4-visual-fixtures.mjs`。

## 1. 路由

| 方法 | 路径 | 行为 |
| --- | --- | --- |
| GET | `/web-t4-visual.html` | 页面（`text/html; charset=utf-8`，`no-store`，`x-fixture: dsh-ui-testing`） |
| GET | `/t4/visual/t4-visual-media.webm` | 3 s 媒体资产（`video/webm`，二进制；`sendFile`） |
| GET | `/t4/visual/*` 其他路径 | 404 JSON（`not-found`）；目录穿越/子目录一律拒绝 |
| 非 GET | 上述路径 | 405 JSON + `allow: GET` |
| 其他路径 | — | `handleT4VisualRoute` 返回 `false`，由 `server.mjs` 继续 404 |

路由由 `server.mjs` 已接好的入口调用；`disposeT4Visual(state)` 只清理本 fixture 的服务器侧计数，
页面内的 rAF / 媒体元素随浏览器关闭释放，服务器侧**没有 `setInterval`**。

## 2. 页面结构（稳定 id）

2×2 四卡布局；`#t4v-title` 文本固定为 `DSH T4 动态视觉靶机`。

| 区域 | id / 选择器 | 说明 |
| --- | --- | --- |
| 标题 | `#t4v-title`、`#t4v-subtitle`、`#t4v-status` | 状态行显示 `scenario/paused/t/ frame/ops/events/media` |
| CSS 卡 | `#t4v-panel-css[data-panel=css]` | 渲染目标 `#t4v-css-orb` |
| Canvas2D 卡 | `#t4v-panel-canvas2d[data-panel=canvas2d]` | `<canvas id="t4v-canvas2d" width="240" height="160">`，2D context |
| WebGL 卡 | `#t4v-panel-webgl[data-panel=webgl]` | `<canvas id="t4v-canvas-webgl" width="240" height="160">`，优先 WebGL2 |
| 媒体卡 | `#t4v-panel-media[data-panel=media]` | `<video id="t4v-video" muted playsinline>` |
| 控制 | `#t4v-pause`、`#t4v-resume`、`#t4v-reset`、`#t4v-scenario-select`、`#t4v-seek`（range 0–3000）、`#t4v-seek-value`、`#t4v-step-back`、`#t4v-step-forward` | 真实按钮/选择器；步进 ±50 ms |
| 状态同步 | `body[data-t4v-scenario]`、`body[data-t4v-paused]`、`body[data-t4v-ready]`、`body[data-t4v-media-fallback]` | 场景、暂停、就绪、媒体 fallback |

每卡另有 `data-panel` 真值行（`#t4v-css-truth` / `#t4v-canvas2d-truth` / `#t4v-webgl-truth` /
`#t4v-media-truth`），只用于截图可读性，不是断言来源。

## 3. 冻结真值 API：`window.__t4.visual`

```js
{
  version: 1,
  fixture: 'web-t4-visual',
  truth: {
    durationMs: 3000,
    seed: 20261104,
    panels: ['css', 'canvas2d', 'webgl', 'media'],
    css: { periodMs: 1200, animatedProps: ['transform', 'opacity'] },
    canvas2d: { width: 240, height: 160, particles: 24, checksum: 'fnv1a32-rgba' },
    webgl: { width: 240, height: 160, api: 'webgl2' },       // 或 'webgl' / 'unavailable'
    media: {
      asset: '/t4/visual/t4-visual-media.webm',
      durationMs: 3000,                                      // 逻辑时长；实际 asset 约 3.038 s
      checkpoints: [
        { ms: 500, dominant: 'r' },
        { ms: 1500, dominant: 'g' },
        { ms: 2500, dominant: 'b' }
      ],
      fallback: null                                         // 或 'canvas-capture-stream' + fallbackReason
    }
  },
  clock: { nowMs, paused, rate: 1, frame, startedAtWallMs, lastTickWallMs },
  panels: {
    css: { panel: 'css', timeMs, transform: { translateX, scale }, opacity,
           animationCount, animations: [{ id, currentTimeMs, playState }] },
    canvas2d: { panel: 'canvas2d', timeMs, frames, draws, particle0: { x, y },
                checksum, frozen, flash },
    webgl: { panel: 'webgl', timeMs, frames, checksum,
             contextType: 'webgl2' | 'webgl' | 'none',
             renderer: string | null,
             webgpu: { available: boolean, reason: string | null } },
    media: { panel: 'media', durationMs, currentTimeMs, paused, readyState,
             frameCount, sample: { r, g, b }, stalled, frozen }
  },
  scenario: 'normal' | 'flash' | 'freeze' | 'jank' | 'media-stall',
  ops: [{ opId, kind: 'click' | 'seek' | 'scenario' | 'pause' | 'resume',
          target, atMs, atWallMs, detail }],
  events: [{ seq, kind: 'clock' | 'draw' | 'anomaly' | 'control' | 'media' | 'visibility',
             panel, atMs, atWallMs, causeOpId, detail }],
  timeline: [{ seq, domain: 'operation' | 'visual', kind, target, panel,
               atMs, atWallMs, causeOpId, detail }],
  anomalies: { flashFrames: [], frozenAtMs: null, jankFrames: [], mediaStalled: false },
  controls: { pause, resume, reset, seek, setScenario, state, samplePanel }
}
```

方法（`browser_eval` 可 `await`）：

- `__t4.visual.state()`：深拷贝快照（函数省略；timeline 按 `atWallMs,seq` 排序）。
- `__t4.visual.setPaused(bool)`：暂停/恢复；记录 `pause`/`resume` op 与 `control` visual 事件。
- `__t4.visual.seek(ms)`：`0..3000`，**隐含暂停**；同步 CSS `currentTime`、Canvas/WebGL 重绘一次、
  视频 `pause()` + `currentTime = ms/1000`；返回 `{ok, nowMs, paused}`。
- `__t4.visual.setScenario(name)`：重置 t=0、清空 anomalies/账本、重装视频，按场景自动运行；
  返回 `{ok, scenario, paused}`。
- `__t4.visual.reset()`：回到 `normal` + t=0。
- `__t4.visual.samplePanel(name)`：该面板真值深拷贝（含 checksum）。

真实按钮点击同样写入 `ops`/`timeline`：点 `#t4v-pause` 会产生 `kind:'click', target:'t4v-pause'`
的 op，并产生 `domain:'visual', kind:'control', causeOpId:<opId>` 的事件。

## 4. checksum 算法

- 固定 **FNV-1a 32-bit over RGBA 字节**：`hash = 0x811c9dc5`；对 `ImageData.data`（宽×高×4，
  按行序、R/G/B/A）逐字节 `hash ^= byte; hash = Math.imul(hash, 0x01000193) >>> 0`；
  以 8 位小写十六进制字符串返回。
- Canvas2D：每帧 `getImageData(0,0,240,160)` 后计算。
- WebGL：每帧 `readPixels(0,0,240,160, RGBA, UNSIGNED_BYTE)` 后计算。
- 跨进程/跨 GPU 不要求像素 hash 相同（ANGLE/SwiftShader 栅格差异）；验收只断言
  **同一运行内同 t 相等、不同 t 不等**，以及颜色主导通道。

## 5. 场景定义

| 场景 | 行为 |
| --- | --- |
| `normal` | 四块都动；无异常。 |
| `flash` | 逻辑时钟进入 `[640, 656)` ms 时 Canvas2D 画整帧纯白一次；`flash=true` 仅该帧，`anomalies.flashFrames` 记录对应 `frames`。正常区间不闪白。若 rAF 步长跨过 16 ms 窗口，仍补一帧白（仅连续运行路径；`seek` 精确落点）。 |
| `freeze` | Canvas2D 在 `t>=800 ms` 后停止重绘（`frozen=true`、`frames/draws/checksum` 不变）；逻辑时钟与 CSS 继续；`anomalies.frozenAtMs=800`。 |
| `jank` | Canvas2D 每 3 帧丢 1 帧（不重绘）；`anomalies.jankFrames` 记录被跳过的 `clock.frame`；时钟继续。 |
| `media-stall` | 视频在 `currentTime>=1.2 s` 后暂停且不再推进（`stalled=true`、`anomalies.mediaStalled=true`）；其他面板继续。 |
| 切换 | 重置 t=0、清空 anomalies/ops/events/timeline、重装视频到 0；按场景自动运行。入口支持 `?scenario=<name>`（未知值保持 `normal`），等价于先 `setScenario(name)`。 |

## 6. 确定性、时间与容差

- 逻辑时钟只由 `requestAnimationFrame` 推进：`dt = min(now-last, 50)`，`paused` 时不推进；
  `clock.nowMs`/`panels.*.timeMs` 为整数毫秒（向下取整）。
- `paused` 时四块全冻结：CSS 动画 `pause()` 且 `currentTime = t`；Canvas/WebGL 不重绘；
  视频 `pause()`；媒体采样不更新。
- 同一 `t + scenario + paused` 在同一运行内得到相同逻辑真值与 Canvas2D/WebGL checksum；
  不同 `t` 不同（freeze 场景的 Canvas 除外）。
- 时间容差：媒体时长 `3000 ± 150 ms`（本机实际 `3038 ms`，Chrome 以最后一个 block 时间戳为准）；
  暂停后 250–400 ms 内视频 `currentTime` 漂移 `< 80 ms`；颜色主导通道相对次高通道 `>= 12`；
  运行推进断言用 `> before + 100 ms` 等宽松下界，不写死帧率。
- CSS 真值从 `getComputedStyle(#t4v-css-orb)` 与 `getAnimations()` 读回，不用手写状态冒充；
  动画为真实 Web Animations API（`orb.animate(...)`，id `t4v-css-orb-anim`）。
- Canvas2D 24 粒子由固定 seed `20261104` 的 mulberry32 初始化，位置是 `t` 的纯函数；每帧全量重绘。
- WebGL 着色器以 `u_time = t/1000` 输出确定性图案；`contextType` 如实（优先 webgl2）；
  `renderer` 取 `WEBGL_debug_renderer_info`，取不到为 `null`；`navigator.gpu` 存在时
  `requestAdapter()` 失败也如实 `available:false` + reason，不伪造 WebGPU 画面。
- 动态媒体使用真实 `<video>` 的 `play/pause/currentTime`；每帧（或每 2 帧）`drawImage` 到
  32×18 离屏 canvas 取平均 RGB；`requestVideoFrameCallback` 可用时累计 `frameCount`。

## 7. 媒体资产 provenance

| 项 | 值 |
| --- | --- |
| 文件 | `tests/ui_test_fixture/t4-visual-media.webm` |
| 生成脚本 | `tests/ui_test_fixture/tools/make-t4-media.mjs` |
| 命令 | `flock /tmp/dsh-t4-browser.lock node tests/ui_test_fixture/tools/make-t4-media.mjs` |
| 编码 | VP8，320×180，30 fps，3050 ms 采集；Matroska `Duration` 补写为 3000 ms |
| 画面 | 0–1 s 纯红、1–2 s 纯绿、2–3 s 纯蓝；48×60 白色方块在 3 s 内从左到右移动 |
| bytes | 25656 |
| sha256 | `4164be70f07f4d0c739cec8880b62a5f62dc2be8ddcc1572a3f7c2fa8b2f6b97` |

生成方式：本机无 ffmpeg；脚本启动隔离的 headless Chromium，用 `canvas.captureStream(30)` +
`MediaRecorder`（`video/webm;codecs=vp8`）录制，再把 `Segment/Info/Duration`（float64）插入
Chrome 的 live WebM 输出（Chrome 的 MediaRecorder 不写 Duration，`<video>.duration` 会是
`Infinity`）。脚本会打印实际 sha256；**重新生成不保证逐字节相同**（编码器/时间戳），但画面语义
确定。仓库提交的资产以上表 sha256 为准。

页面通过 `fetch('/t4/visual/t4-visual-media.webm')` 取回同源字节并转成 blob URL 再交给 `<video>`：
`sendFile` 不实现 Range，而 MediaRecorder 产出的 WebM 没有 Cues，直接渐进播放时
`seekable` 可能只有 `[0,0]`；blob 全量缓冲后 `seekable=[0,3]`，`seek(500/1500/2500)` 才能稳定
命中红/绿/蓝。这仍是真实 `<video>` 的 `play/pause/currentTime`，不是伪造采样。

## 8. 限制与 NOT_RUN 口径

- 本页是**靶机**，不实现 T4 能力：没有帧序列、录屏、运动轨迹、连续视觉判断工具；
  截图/像素 checksum 只服务本 fixture 的真值，不构成 T4 能力上线。
- WebGL 在无头 Chromium 上走 ANGLE/SwiftShader；`renderer` 字符串是本机事实，不保证跨平台。
  若环境 `contextType='none'`，验收套件把 WebGL 检查记 **NOT_RUN**，不写 PASS。
- WebGPU：本机 headless 的 `navigator.gpu` 存在但 `requestAdapter()` 返回 `null`，页面如实
  `available:false`；不渲染/不伪造 WebGPU 画面。
- 媒体 fallback：若资产不可用，页面会切到 `canvas.captureStream` 并在
  `truth.media.fallback='canvas-capture-stream'` 披露；此时依赖视频 seek 的检查（play/pause/seek、
  media-stall）必须记 **NOT_RUN**，不得声称测过视频 seek。当前提交资产可用，本次验收无此分支。
- 跨进程像素 hash 不承诺一致；只做同运行内相等/不等与颜色主导通道断言。
- 页面截图证据：`tests/acceptance/t4-visual-fixtures.mjs` 落盘 `t4-visual-full.png`（1280×800）
  与 `t4-visual-panels.png`（两卡区域）；真实宿主（3080/3081）未在本准备任务中重启或操作。

## 9. 验收命令与证据

```bash
flock /tmp/dsh-t4-browser.lock node tests/acceptance/t4-visual-fixtures.mjs
```

- 退出码：`0` 全部必需检查通过；`1` 至少一条必需检查失败；`2` 套件无法运行/超时，或存在
  required NOT_RUN（证据不完整，不冒充通过）。
- 证据目录：`tests/acceptance/runs/<ISO>-<pid>/`，含 `run-report.json`、`run.log` 与 PNG。
- 本机最后一次通过：12 probes / **74 required checks 全通过** / 0 failed / 0 NOT_RUN / 2 PNG /
  `exit 0`，报告
  [`tests/acceptance/runs/2026-11-03T16-42-52-506Z-190220/run-report.json`](../acceptance/runs/2026-11-03T16-42-52-506Z-190220/run-report.json)。
