# Web T2 · 结构化 GUI 能力台账

> 工程状态记录，**不是运行时可用性声明**。先确认注册表里确有 T2 工具，再读 `browser_capabilities` 的实际三态与真实调用结果。

## 工具与状态

| 能力 | 工具 | 状态 | 边界 |
| --- | --- | --- | --- |
| web.t2.snapshot | browser_snapshot | verified | AX 树压缩投影；`refs` 只含显示项；`generic` 不分配 ref |
| web.t2.click | browser_click | verified | 滚动进视口 + 两帧稳定 + 命中校验后派发 CDP 真实事件 |
| web.t2.type | browser_type | verified | 仅原生文本输入与 textarea；不回显输入；`submit` 默认不提交 |
| web.t2.scroll | browser_scroll | verified | 不自动滚入视口；目标须在视口内且稳定，否则零派发 |
| web.t2.fill_form | browser_fill_form | verified | 1–20 字段；combobox/slider 走原生 setter（`dom-control`） |
| web.t2.node_state | browser_node_state | verified | 可编辑 value 恒脱敏；hidden/disabled 不影响读取 |
| web.t2.wait_for | browser_wait_for | verified | 三类条件互斥；超时 `WAIT_TIMEOUT`，页面不关闭 |

聚合项：`web.t2.structured-dom`。

## 证据与错误

- `evidence.version=1`：`provenance/targets/before/after/dispatch/networkDelta/escalation/incomplete`。
- `REF_STALE`（重新 snapshot）、`TARGET_NOT_UNIQUE`（改用 ref）、`NOT_INTERACTABLE`（`details.reason`）、`WAIT_TIMEOUT`。
- 派发成功不等于业务断言通过；两者分开记录。

## 未覆盖

- 跨 iframe 定位、closed shadow 内部的 ref 细分。
- provider 图像可见性；视觉缺陷判断（升级 T3）。
