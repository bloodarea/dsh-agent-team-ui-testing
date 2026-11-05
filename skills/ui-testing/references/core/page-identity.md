# 页面 / 对象 / 上下文身份门禁（Page Identity Gate）

> 触发时机：任何 case 的第一个动作之前；任何导航、新标签、`window.open`、`target=_blank`、iframe 交互之后；以及每次换 case 重新开始取证之前。
> 目的：阻止"题指向 A 页、实际在 B 页，却用 B 页的证据写 A 页 PASS"。

## 1. 动作前先记录 expected，动作后回读 actual

| 维度 | expected（动作前写下） | actual（回读来源） |
| --- | --- | --- |
| 任务对象 | 题目要求的页面/区域/控件语义 | `browser_snapshot` 的 heading/tree 文本、`browser_state.title` |
| URL | 目标 URL（可含查询串语义） | `browser_state.url`、`browser_tabs list` 的 `url` |
| 标题 / 关键 heading | 页面自报身份（用于区分同站不同页） | `browser_state.title`、AX heading |
| 关键元素 | 该页面唯一的结构锚点（如带 id/aria-label 的主容器） | `browser_node_state` / `snapshot` 的 role+name |
| 视口 / DPR | 断言依赖的宽高（响应式/窄屏题必记） | `browser_viewport {action:"set"}` 的 `view/observed` 读回（`get` 只是缓存） |
| 标签 | 应操作的 tab | `browser_tabs current`（selectedTab）；`browser_tabs list` 看全部 |
| frame | 主 frame 还是边界叶子 | `snapshot.coverage.frame`；iframe 只有叶子、无内部 ref |
| 登录态 | 期望的账号/角色 | 页面可见身份元素、`browser_eval` 读应用状态（不是 Cookie 导出，本插件没有该能力） |

**最低成本组合**（不必每次都用全套）：

```text
browser_state {}                      # url/title/viewport/running（不启动、不占租约）
browser_snapshot { maxNodes: 60 }     # 只看 heading 与关键容器，确认"这是哪一页"
browser_tabs current {}               # 确认本会话 selectedTab（多标签时必做）
```

## 2. 不一致时的处置

| 情形 | 处置 |
| --- | --- |
| URL/标题是目标页，但关键元素不存在 | 页面可能还没加载完或渲染失败：`wait_for` 等条件、看 `browser_state.error`，仍不成立 → `BLOCKED`（附错误与截图） |
| URL 不是目标页 | 回到目标页（重新 `navigate` 或 `browser_tabs select`）后再取证；**已经采到的证据作废，不得跨页复用** |
| 同站、导航相同、样式相同，但对象不同 | 用页面级标识（heading/主容器/URL 语义）区分，不能用"导航看起来对"或控件同名推断 |
| 登录态/角色不符 | 不伪造登录；记 `BLOCKED(permission/login-state)`，或用授权提供的账号重新进入 |
| 视口/DPR 与断言要求不符 | 先 `browser_viewport set` 到断言要求的尺寸并读回，再采证据；截图尺寸不能反推视口 |
| 页面在你取证过程中自己导航/刷新 | 回读 `browser_state.url/title`；T2 的 ref 会 `REF_STALE`，必须重新快照 |

硬规则：**同一 case 的所有 evidence 必须来自同一个页面身份实例**。如果中途换过页/换过标签，要么重新取证，要么在 `coverage` 写 `partial` 并说明。

## 3. 同站共享导航陷阱

现代站点常把 header/侧栏做成跨页面组件，于是"导航条一样、配色一样、连面包屑都一样"并不能证明页面正确。可用的判别锚点（按强度从高到低）：

1. URL 的路径/查询串语义（最接近"身份"的证据，但不是唯一依据）；
2. 页面唯一的 heading/主容器 id 或 `aria-label`；
3. 只在该页面存在的业务控件与数据（例如某页独有的表格列、表单字段）；
4. 从上一页跳转过来的动作证据（`dispatch` + 网络请求 + 到达后标题变化）。

反例（必须拦住）：用上一个页面的 `snapshotId` 里的 ref 点击"新页面"的同名按钮——ref 属于旧页面身份，能生效也不代表你在新页面。

## 4. 新标签 / 弹窗归属

- 每个 DSH 工作区是**页面组**：primary + 最多 3 个 child tab（每 workspace 4，全局 8）。每个 tab 有独立 URL/viewport/网络缓冲/ref 表/租约。
- **Agent 工具默认只操作当前会话的 selectedTab**；`browser_tabs` 的 `list/current/select/open/close` 是唯一的标签管理入口。`list/current` 只读，`select` 需要同 workspace 且目标未被其他 owner 占用（否则 `BUSY`）。
- 真人 GUI 触发的 `target=_blank`/`window.open` 可能被接管为同工作区 child page；**自动/未授权 popup 仍被目标策略阻断**。工具不会自动把新标签设为 selectedTab——先 `browser_tabs list` 看它是否存在、再 `select`。
- `browser_tabs open` 自建标签**不是**原生新页：它是替代路径，必须按 [`reporting.md`](reporting.md) 写明"替代了什么、仍缺哪条原始断言"（例如 opener 关系、焦点归属、postMessage 时序都无法由此证明）。
- child tab 被关闭或 idle 回收后，旧 selection 进入 `pendingReset`：下一次页面工具会 `TARGET_NOT_FOUND(reason:selected-tab-closed, fallbackTabId:primary)` 且**零派发**；用 `browser_tabs current` 或 `select` 明确确认后再继续，别把这次失败当成"元素不存在"。
- 不要跨 tab 聚合网络/帧/标注证据：`browser_network_*` 按 page 绑定，切换 selectedTab 就是切换采集目标。

## 5. 合成正例 / 反例

**正例：先证身份再判定**

```text
expected: url=/orders 且 heading="订单详情" 且主容器 #order-detail 存在；视口 1024×768
actual:   browser_tabs current → tab=primary；browser_state.url=/orders/…；snapshot heading="订单详情"、#order-detail 存在；viewport set 读回 width=1024
→ 身份通过，开始采证据
```

**反例：用错页面也能"看起来通过"**

```text
expected: 结算页运费显示 0
actual:   截图来自另一个页面的"运费"文案区（同站、同导航）
判定:     第 6 项校验（截图↔声明）不通过；必须回目标页重采，不得 PASS
```

**反例：同名控件不等于同一对象**

```text
expected: 控制台页的"刷新"按钮
actual:   列表页也有同名"刷新"按钮，ref 可用、点击成功
判定:     页面身份不符 → 回目标页或 BLOCKED；不许用列表页的结果写控制台页的结论
```

## 6. 与其他门禁的关系

- 身份通过才进入动作与取证；身份失败只产出 `BLOCKED`，不产出 `PASS`/`FAIL`（除非失败本身就是被测断言，例如"应跳转而没跳"）。
- 身份记录放进 `observation`（或报告的对象字段），与 `evidence_ids` 一起提交；没有身份记录的 PASS 按第 6 项校验不通过处理。
- 判定终检见 [`verdict-gate.md`](verdict-gate.md)；报告字段见 [`report-template.md`](report-template.md)。