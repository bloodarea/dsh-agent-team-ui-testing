# 输入送达校验

合成的鼠标/键盘事件经 CDP `Input.*` 派发到页面后，**CDP 接受消息不等于页面收到了 DOM 事件**。历史上这一点被静默吞掉：`browser_click` / `browser_input` 返回 `dispatched:true / applied:N`，页面侧却一个事件都没有，外部表现为「点了没反应」，而且所有取证读数（截图、DOM、`elementFromPoint`）都正常，极易被误判为「网站防自动化」。

目前覆盖 **`browser_click`**（`evidence.dispatch.delivery`）与 **`browser_input`**（返回值 `delivery`）两条派发路径。`browser_type` 的焦点点击走同一条 `browser_click` 校验，并另有输入值读回；T2 滚轮（`browser_scroll` 的 wheel 分支）**暂未**做送达校验。

## 校验方式

1. **派发前**在目标文档注入一次性捕获探针（`pointerdown/mousedown/pointerup/mouseup/click/keydown/keyup/input/wheel/mousemove`），记录页面真实观察到的事件类型；探针带 5 秒自清理定时器，读取时立即移除，不向应用命名空间留下长期痕迹。
2. **派发后**读回探针，按这批输入应有的 DOM 事件判定是否送达（点击要求 press 与 release 两半都到；键盘批次要求 `keydown`/`keyup`；滚轮要求 `wheel`）。
3. **未送达**时重新前置页面并**重试一次**；仍未送达则抛 `INPUT_NOT_DELIVERED`，附 `attempts`、`seen`（页面实际看到的事件）、点位与排查提示，而不是报成功。
4. **探针无法安装**（页面拒绝执行、文档已替换）时不判失败，结论标为「未验证」：`verified:false, delivered:null`。宁可不声称，也不伪造结论。
5. **忙页面不算未送达**：首读为空时再等约 180ms 复读一次，避免把主线程只有几帧每秒的页面误判成「没收到」。

## 结果字段

| 位置 | 字段 |
| --- | --- |
| `browser_click` | `evidence.dispatch.delivery = { verified, delivered, attempts, seen }` |
| `browser_input` | 返回值 `delivery = { verified, delivered, attempts, seen, missing? }` |
| 失败时 | `INPUT_NOT_DELIVERED`，`details.attempts` / `details.seen` / `details.point` / `details.hint` |

- `verified:false` 表示无法取得页面侧证据（没有探针），`delivered:null` 表示不声称送达与否。
- 纯文本批次（只有 `insertText`）**不做**送达判定：没有焦点时它本来就不产生 DOM 事件，判成失败会误报。

## 前置页面（`activate`）

输入要落在当前浏览器窗口的前台目标上。`Runtime.activate()` 现在：

- **可 await**：返回 `Page.bringToFront` 的 Promise，调用方可以等它落地；
- **合并而不是跳过**：同一时刻的并发调用共享同一次 `bringToFront`（旧实现用 300ms 节流直接 `return`，调用方会以为已经前置）；
- **不做「已在前台」缓存**：前台归属还会被运行时之外的动作改变（Chromium 会前置新建的标签、用户会点别的标签、弹窗会抢前台），任何缓存都会过期，而被跳过的恰好是输入依赖的那一次。实测在抖音 primary 上，一个过期的「已在前台」判断让页面停留在后台，`Page.bringToFront` 一次都没发出去；
- 面板心跳与页面刚启动时的调用保持 fire-and-forget（失败不抛给调用方），输入路径则在送达校验失败后重试一次前置。

前置失败本身不再作为失败依据——`INPUT_NOT_DELIVERED` 才是判据：页面没收到就是没收到，不猜原因。

## 边界

- 探针只证明「页面观察到了事件」，不证明业务生效（弹窗是否关闭、请求是否发出仍要看 `nodeAfter`、`networkDelta` 或截图）。
- 面板转发的人工点击与 Agent 走同一条派发与校验路径。
- 送达校验不改变队列与租约语义：仍在同一次页面操作、同一个单写租约内完成。
- 多一层 `Runtime.evaluate` 往返，单次点击增加个位数毫秒；未发送输入的操作不受影响。
