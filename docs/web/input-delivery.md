# 输入送达校验

`browser_click` 与 `browser_input` 区分 CDP 派发和页面送达。`dispatched:true` 与 `applied:N` 描述派发。送达由页面侧的 `delivery` 字段报告。

目前覆盖 **`browser_click`**（`evidence.dispatch.delivery`）与 **`browser_input`**（返回值 `delivery`）两条派发路径。`browser_type` 的焦点点击走同一条 `browser_click` 校验，并另有输入值读回；T2 滚轮（`browser_scroll` 的 wheel 分支）**暂未**做送达校验。

## 校验方式

1. **派发前**在目标文档注入一次性捕获探针（`pointerdown/mousedown/pointerup/mouseup/click/keydown/keyup/input/wheel/mousemove`），记录页面观察到的事件类型。最终读取会清理探针，另有 5 秒超时清理。
2. **派发后**读回探针，按这批输入应有的 DOM 事件判定是否送达（点击要求 press 与 release 两半都到，键盘批次检查相应的 `keydown` 或 `keyup`，滚轮要求 `wheel`）。若首读缺少预期事件，保留探针约 180ms 后再读一次，给忙页面时间处理剩余事件。
3. **未送达**时重新前置页面并**重试一次**；仍零观察则自动重建文档重放一次（见下节）。最终仍未送达则抛 `INPUT_NOT_DELIVERED`，附 `attempts`、`seen`（页面观察到的事件）、点位（结构化点击）和排查提示。
4. **探针无法安装或读取**时，结论标为「未验证」（`verified:false, delivered:null`）。导航替换文档时，探针也可能随旧文档消失。

## 结果字段

| 位置 | 字段 |
| --- | --- |
| `browser_click` | `evidence.dispatch.delivery = { verified, delivered, attempts, seen, recovery? }` |
| `browser_input` | 返回值 `delivery = { verified, delivered, attempts, seen, missing?, recovery? }` |
| 失败时 | `INPUT_NOT_DELIVERED`，`details.attempts` / `details.seen` / `details.point` / `details.hint` |

- `verified:false` 表示无法取得页面侧证据（没有探针），`delivered:null` 表示不声称送达与否。
- 纯文本和纯鼠标移动批次正常派发，返回 `verified:false, delivered:null`。纯文本依赖已有焦点，可读回目标控件的值确认写入。

## 前置页面（`activate`）

为保持目标页的合成与输入，`Runtime.activate()` 发出 `Page.bringToFront`。调用方可以等待命令完成。

- 同一页面的并发调用共享一次尚未完成的 `bringToFront`。
- 上一次调用完成后，下次会重新请求前置。新建标签、用户切换或弹窗都可能改变前台目标。
- 页面操作等到拿到该页的执行队列后才请求前置，避免排队时被另一个标签抢先切走。面板心跳和新页面启动仍独立请求前置。

前置失败本身不再作为失败依据——`INPUT_NOT_DELIVERED` 才是判据：页面没收到就是没收到，不猜原因。

`Page.bringToFront` 返回成功不等于输入会被投到该页面。实测存在这样的情况：某个页面 target 的 DOM、截图与 `elementFromPoint` 都正常，`visibilityState` 自报 `visible`，但绕过插件直接连 CDP 派发 `Input.*` 也收不到任何事件，而同一浏览器里另一个 target 能收到。这种状态说明目标文档已不再接收该浏览器的合成输入，与这个页面是否自报可见无关。

## 自动恢复（文档重建）

`browser_click` 与 `browser_input` 在**页面一个事件都没观察到**时，会自动重建该文档并重放一次这批输入，而不是直接失败：

1. 先按原样派发，页面未观察到时重新前置再试一次。
2. 仍然零观察，则记录当前 URL → 导航到 `about:blank` → 导航回原 URL → 等新文档 `readyState === 'complete'`。
3. 在新文档重新装探针并重放**这一次**手势，结论写进 `delivery.recovery = 'document-recycled'`。

只对「零观察」重建是有意的：页面什么都没收到，说明副作用没有发生，重放不会造成两次点击。任何**部分送达**（例如只到 press 没到 release）都不会重放，直接按失败处理。

代价与边界：

- 重建等于重新加载该页，页面状态（表单内容、SPA 路由、滚动位置）会丢失；旧 `ref` 随之失效，需要重新快照。
- 重建失败（离屏不可访问的地址、`about:blank`、错误页、回不到原 URL）时不谎报成功：仍抛 `INPUT_NOT_DELIVERED`。
- 重放点仍是原手势的坐标与参数，不重新解析元素；新文档若布局不同，可能点到别处。

自动重建后仍失败的处置顺序：

1. 用 `browser_tabs` 确认当前选择确实指向要操作的那一页。
2. `browser_tabs open` 开新标签，在新标签里操作（新文档从创建起就接收输入）。
3. 仍不稳定时重开浏览器（面板的显示模式切换会重启 Chromium）。

不要依据 `visibilityState` 或 `hasFocus()` 判断输入是否可达：两者在失败现场都可能是正常值。

面板转发的人工点击与 Agent 走同一条派发与恢复路径。送达失败时面板提示「页面没有收到这次输入（已在后台自动重试），请重新加载该页后再试」。

## 边界

- 探针只证明「页面观察到了事件」，不证明业务生效（弹窗是否关闭、请求是否发出仍要看 `nodeAfter`、`networkDelta` 或截图）。
- 面板转发的人工点击与 Agent 走同一条派发与校验路径。
- 送达校验不改变队列与租约语义：仍在同一次页面操作、同一个单写租约内完成。
- 首次读到全部预期事件时立即清理探针。缺少预期事件时才等待约 180ms。
