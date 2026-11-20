# 输入送达校验

`browser_click` 与 `browser_input` 区分 CDP 派发和页面送达。`dispatched:true` 与 `applied:N` 描述派发。送达由页面侧的 `delivery` 字段报告。

目前覆盖 **`browser_click`**（`evidence.dispatch.delivery`）与 **`browser_input`**（返回值 `delivery`）两条派发路径。`browser_type` 的焦点点击走同一条 `browser_click` 校验，并另有输入值读回；T2 滚轮（`browser_scroll` 的 wheel 分支）**暂未**做送达校验。

## 校验方式

1. **派发前**在目标文档注入一次性捕获探针，记录可信的指针、鼠标、按键、文本和滚轮事件类型。最终读取会清理探针，另有 5 秒超时清理。
2. **派发后**读回探针，按这批输入应有的 DOM 事件判定是否送达（点击要求 press 与 release 两半都到，键盘批次检查相应的 `keydown` 或 `keyup`，滚轮要求 `wheel`）。若首读缺少预期事件，保留探针约 180ms 后再读一次，给忙页面时间处理剩余事件。
3. **零送达**时可在同一文档重新前置并重试一次。结构化点击的准备性移动可以单独出现。观察到部分手势，或原始输入批次含 `text` / `char` 时，直接返回当前送达结果。仍缺少预期事件则抛 `INPUT_NOT_DELIVERED`。
4. **首轮探针无法安装或读取**时，结论标为「未验证」（`verified:false, delivered:null`）。导航替换文档时，探针也可能随旧文档消失。

## 结果字段

| 位置 | 字段 |
| --- | --- |
| `browser_click` | `evidence.dispatch.delivery = { verified, delivered, attempts, seen, recovery? }` |
| `browser_input` | 返回值 `delivery = { verified, delivered, attempts, seen, missing?, recovery? }` |
| 失败时 | `INPUT_NOT_DELIVERED`，`details.attempts` / `details.seen` / `details.missing` / `details.point`（结构化点击） / `details.hint` |

- `verified:false` 表示无法取得页面侧证据（没有探针），`delivered:null` 表示不声称送达与否。
- 纯文本和纯鼠标移动批次正常派发，返回 `verified:false, delivered:null`。纯文本依赖已有焦点，可读回目标控件的值确认写入。

## 前置页面（`activate`）

为保持目标页的合成与输入，`Runtime.activate()` 发出 `Page.bringToFront`。调用方可以等待命令完成。

- 同一页面的并发调用共享一次尚未完成的 `bringToFront`。
- 上一次调用完成后，下次会重新请求前置。新建标签、用户切换或弹窗都可能改变前台目标。
- 页面操作等到拿到该页的执行队列后才请求前置，避免排队时被另一个标签抢先切走。面板心跳和新页面启动也会请求前置。Linux 隐藏有头模式需要先确认 X11 窗口的隐藏和焦点提示，才会发出前置请求。详见[有头运行配置](browser-runtime.md#无头与有头模式)。

前置失败本身不再作为失败依据——`INPUT_NOT_DELIVERED` 才是判据：页面没收到就是没收到，不猜原因。

`Page.bringToFront` 返回成功不等于输入会被投到该页面。实测存在这样的情况：某个页面 target 的 DOM、截图与 `elementFromPoint` 都正常，`visibilityState` 自报 `visible`，但绕过插件直接连 CDP 派发 `Input.*` 也收不到任何事件，而同一浏览器里另一个 target 能收到。这种状态说明目标文档已不再接收该浏览器的合成输入，与这个页面是否自报可见无关。

## 失败与文档恢复

**有头模式及包含滚轮的输入批次保留当前文档。** 若当前文档的重试仍失败，Host 抛出 `INPUT_NOT_DELIVERED`，保留该页的表单与滚动状态。面板转发走相同规则，提示「页面未收到完整输入，请检查当前标签的状态」。

无头模式下，符合重试条件的非滚轮手势在两次派发后均零观察时，仍可执行一次文档恢复。Host 先导航到 `about:blank`，再返回原 URL 并在新文档重新装探针和派发。送达结果的 `delivery.recovery` 为 `document-recycled`。

- 文档恢复会重新加载页面。表单内容、SPA 状态、滚动位置可能丢失，旧 `ref` 会失效。
- 恢复使用原手势坐标。布局变化会改变坐标命中的元素。
- 收到 `INPUT_NOT_DELIVERED` 后，用 `browser_tabs` 和 `browser_snapshot` 核对目标与页面状态。`visibilityState` 和 `hasFocus()` 只描述页面状态，输入送达需用页面侧证据判断。

## 边界

- 探针只证明「页面观察到了事件」，不证明业务生效（弹窗是否关闭、请求是否发出仍要看 `nodeAfter`、`networkDelta` 或截图）。
- 面板转发的人工点击与 Agent 走同一条派发与校验路径。
- 送达校验不改变队列与租约语义：仍在同一次页面操作、同一个单写租约内完成。
- 首次读到全部预期事件时立即清理探针。缺少预期事件时才等待约 180ms。
