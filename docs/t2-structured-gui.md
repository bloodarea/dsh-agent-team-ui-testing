# 结构化 GUI

T2 用无障碍树与 DOM 做可靠的元素定位与可信输入。七个工具：`browser_snapshot`、`browser_click`、`browser_type`、`browser_scroll`、`browser_fill_form`、`browser_node_state`、`browser_wait_for`。

## 工作流

```text
browser_snapshot { depth:12, maxNodes:500 }
browser_click    { ref:"e12" }
browser_type     { ref:"e15", text:"hello", submit:true }
browser_wait_for { text:"已保存" }
```

`browser_snapshot` 返回 `snapshotId`、`digest`、压缩后的 `tree` 与 `refs`。`refs` 只包含树中显示的有效项；`generic` 包装节点不分配 ref，需要读它的状态时请用显式 `selector`。

## Ref 协议

- ref 形如 `e12`，按快照单调分配，**永不复用**。
- 主框架跨文档导航、刷新、历史前进后退、执行上下文丢失都会让 ref 失效，此时返回 `REF_STALE`，重新 snapshot 即可。
- ref 表按工作区隔离，跨快照按 `(documentEpoch, backendNodeId)` 复用。
- 也可以直接用唯一 `selector`；命中多个返回 `TARGET_NOT_UNIQUE`。

## 动作与可操作性

派发前统一做：滚动进视口 → 两帧稳定 → 命中校验（含 open shadow 的 composed 命中）→ 通过后才用 CDP 派发真实输入。

| 工具 | 行为 |
| --- | --- |
| `browser_click` | 左/右/中键，`clickCount` 1–2，`modifiers` ≤4 |
| `browser_type` | 仅原生文本输入与 `textarea`；`replace` 默认替换，`submit` 默认不提交 |
| `browser_scroll` | `direction` 与 `to` 恰一；**不自动滚入视口**，目标必须在视口内且稳定 |
| `browser_fill_form` | 1–20 个字段，整批预检后逐项执行；失败停止但不回滚，`details` 给出 `applied`/`failedIndex` |
| `browser_node_state` | 读取可见/启用/只读/勾选/展开/焦点/bbox/hitTarget；可编辑值恒脱敏 |
| `browser_wait_for` | 文本出现/消失，或节点状态（visible/enabled/checked/valueEquals）；超时抛 `WAIT_TIMEOUT` |

`browser_fill_form` 的字段类型：`textbox`、`checkbox`、`radio`（只接受 `true`）、`combobox`（按 `option.value` 精确匹配，不打开原生下拉）、`slider`（须在 min/max 内且符合 step）。`combobox`/`slider` 走原生 setter（`eventSource:"dom-control"`），**不能声称 `isTrusted`**。

## 证据

每次调用（成功或失败）都带 `evidence.version=1`：

```text
provenance / targets / before / after / dispatch / networkDelta / escalation / incomplete
```

- 成功时证据在结果里，失败时在 `BrowserError.details.evidence`。
- 输入文本与可编辑控件的 value **永不回显**。
- `dispatched:true` 只表示输入已派发，不表示业务目标已达成。

## 错误

| 错误码 | 含义 |
| --- | --- |
| `REF_STALE` | ref 所属快照或文档失效 |
| `TARGET_NOT_UNIQUE` | selector 命中多个元素 |
| `NOT_INTERACTABLE` | 隐藏/禁用/零面积/离屏/被遮挡/持续运动；`details.reason` 说明原因 |
| `WAIT_TIMEOUT` | 等待超时，页面不关闭 |
| `INVALID_ARGUMENT` | 参数非法或条件互斥 |
| `BUSY` | 工作区页面被其他 owner 占用 |

只读的 `snapshot`/`node_state`/`wait_for` 同样受 BUSY 限制。

## 边界

- 语义来源是主框架的无障碍树；跨 iframe 定位不在范围内。
- 快照树是压缩投影：`nodeCount` 与 `digest` 会随构建变化，跨版本差异不算回归。
- 视觉缺陷（颜色、遮挡、像素差异）不属 T2，请升级到 [静态视觉](t3-vision.md)。
- 面板的「选择元素」见 [选元素加入聊天框](element-picker.md)：在预览中悬浮框选页面元素，点击把节点信息追加到聊天框；v1 只选主帧。
