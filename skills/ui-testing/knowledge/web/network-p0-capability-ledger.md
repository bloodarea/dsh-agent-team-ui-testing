# Web 网络 P0 · 能力台账

> 工程状态记录，**不是运行时可用性声明**。先确认注册表里确有 7 个 `browser_network_*` 工具，再读 `browser_capabilities` 的三态与 `network` 段限额。

## 工具与状态

| 能力 | 工具 | 状态 | 边界 |
| --- | --- | --- | --- |
| web.network.session | browser_network_session | verified | 唯一懒启动动作；同名 start 幂等；reset 只清内存 |
| web.network.events | browser_network_events | verified | 只读；timeline/aggregate 视图；检索命中只回脱敏预览 |
| web.network.detail | browser_network_detail | verified | body 三态；读不到即 `available:false`，不伪造 |
| web.network.trace | browser_network_trace | verified | Host 内存操作；显式 link 与派生的 stepId 并存 |
| web.network.control | browser_network_control | verified | 规则 ≤32、hold ≤64；reset 不关闭导航守卫 |
| web.network.evidence | browser_network_evidence | verified | JSONL 保真、HAR 1.2 子集；只写持久根 |
| web.network.subscribe | browser_network_subscribe | verified | 每 scope ≤16 订阅、pin 1000 条；超出给 gap 计数 |
| web.network.p0 | （聚合） | verified | 采集/时序/分析/链路/控制/证据六类 |

## 能力边界

- `G1.5` 为 **partial**：same-origin iframe 与 dedicated worker 已覆盖；OOPIF 部分覆盖；shared/service worker 不采集；popup 不采集。
- HTTPS 未独立验收：`limits.network.https = "mechanism-identical"`。
- `responseModification` 视 Chrome 实测能力，不支持时如实报告。
- 不做 MITM、不装 CA、不读 TLS 密钥；限速是 CDP 网络条件模拟。
- 默认脱敏是规则集，不是通用密钥检测器。

## 未覆盖

- 真实宿主上的 control/replay/证据/订阅行为与长连接稳定性。
- 跨 scope 聚合、多标签/窗口工具。
