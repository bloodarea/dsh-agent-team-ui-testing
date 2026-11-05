# 网络与状态不变量：把请求、UI 与最终资源对齐

> 用 P0（`browser_network_*`）与 T2/T1 回读一起回答两类问题：**这次动作发了什么、成了没有**，以及**多个视图是否自洽**。
> 判定规则仍归 [`verdict-gate.md`](verdict-gate.md)；字段模板见 [`report-template.md`](report-template.md)。

## 1. 先建时间线：实体 ID 优先，不用 UI 文案

以**业务实体 ID**（响应体里的订单号/资源 id/幂等键）+ `seq` + `requestId` + 时间戳重建链路：

```text
network_session start
network_trace begin-step {name:"checkout"}      # 可选：把动作与请求归到同一步
（T2 执行真实交互）
network_events { view:"summary" | "timeline", filter:{ stepId, method, status } }
network_detail { requestId, include:["request","response","body","timing"] }
network_trace { action:"query" }
```

要点：

- `phase` 区分 `request → redirect → response → data → finished | failed`：**"请求已发"不等于"响应成功"，"响应 200"不等于"页面已渲染"**。渲染状态要另用 DOM 回读（T2）/像素（T3）证明。
- 业务 id 以**响应体/服务端记录**为准；UI 里显示的编号只能作为交叉核对，不能反过来当服务端字段。
- 同一实体在多个请求里出现时，用 id 串起来（如"创建 → 支付 → 查询详情"），并记录各自时间戳；不要用"页面看起来更新了"代替顺序证据。
- body 读不到时（`body.state:"unavailable"`、`available:false`）只写原因码与已取得的部分；**不要用 UI 文本反推报文**，也不要伪造空体（`empty` 与 `unavailable` 不是一回事）。

## 2. SSE：契约优先，不要假定"重复=缺陷"

需要记录的事实（能取到就写，取不到写缺失）：

| 事实 | 来源 | 备注 |
| --- | --- | --- |
| `eventName` / `eventId` / `retryMs` | `network_detail` 的 `sse` / 事件 `sse` 字段 | `eventId` 是应用层语义，本工具只原样记录 |
| 事件顺序与单调性 | 事件 `seq` + `sse.eventId` 序列 | 记录是否回退/重复/缺口 |
| 重连请求形态 | 重连时的请求 URL/方法/头（头可能被脱敏） | 若 `Last-Event-ID` 等头被脱敏，**只能写"重连请求已发生、头不可见"** |
| 服务端重放 | 重连后事件序列 | 重放 N 条是常见契约，不等于缺陷 |
| UI 渲染结果 | T2 `snapshot`/`node_state`/文本、条数 | 与网络事件条数分开记 |

判定顺序（**契约优先**）：

1. 应用契约是否要求"重连后去重/按 `eventId` 幂等"？有来源 → 按契约判。
2. 契约没写？只写观察：网络层重复 N 条、UI 条数 M 条；判 `INCONCLUSIVE(needs-contract)`，不写"重复投递就是缺陷"。
3. 契约要求去重而 UI 出现重复条目/重复计数 → 第 1 项校验（observation 含"重复/无去重"）触发，判 `FAIL` 并给证据。
4. UI 去重但网络重复 → 在 `counterexamples` 写明"网络层重放被 UI 去重吸收"，可作为 PASS 的正当解释（同时记录曾被排除的反例）。

## 3. 跨标签 / 多视图不变量：逐项核对，实时性由契约决定

同一业务资源的多个视图（徽标、列表行、汇总卡、金额字段、状态标签、详情页）是**不同视图**，不是同一个断言。核对清单：

| 视图 | 要核对什么 | 可能的差异来源 |
| --- | --- | --- |
| 徽标/计数 | 数量与资源集合是否一致 | 缓存、事件推送延迟、乐观更新 |
| 列表 | 条目 id 集合、顺序、分页边界 | 新事件未到、排序策略 |
| 汇总/合计 | 求和来源字段、舍入 | 前后端各自计算、币种/精度 |
| 金额/数量字段 | 每个字段的**服务端来源**（响应字段） | UI 用本地公式重算 |
| 状态标签 | 与服务端最终状态字段一致 | 轮询间隔、乐观状态 |

规则：

- **逐视图分别记录**读取时间与数值；跨视图差异不等于缺陷。
- "是否必须实时同步"由**契约**决定：契约写最终一致/允许延迟，就按收敛窗口判；契约未写 → 只写观察 + `INCONCLUSIVE`。
- 一个视图 PASS 不能代表另一个视图 PASS；同一 case 里多视图要拆成多条 assertion（或一条 assertion 里逐项列明）。
- 标签页之间不共享网络缓冲/帧证据：不要跨 tab 聚合。

## 4. 409 / 2xx / 最终状态三方核对

冲突类响应（`409`）和普通成功（`2xx`）都要三方对齐，不能只看 toast：

| 证据 | 检查点 |
| --- | --- |
| 服务端响应 | `status`、错误体/冲突原因、幂等键、是否有部分写入 |
| UI 提示 | 提示文案与时序（出现/消失）、是否为"成功"样式 |
| 最终资源 | 重新 `network_detail`/`browser_http_request` 读同一资源，或 T2 回读页面终态 |

典型判定：

- 409 + 明确冲突提示 + 资源保持原值 → 正常冲突处理（不是缺陷）；把"冲突提示"写进 `counterexamples` 并解释。
- 409 但 UI 显示成功 / 资源被部分写入 / 无任何提示 → `FAIL`（附三方证据）。
- 2xx 但页面终态与响应不一致 → 先判"渲染/状态未对齐"，定位到具体字段再定性；不要用响应 200 单独写 PASS。
- 最终读回与 UI 不一致且无法排除缓存 → `INCONCLUSIVE` + 写清读取时间差。

## 5. 与门禁的接合

- 第 1 项校验的异常词表里，`重复 / 重放 / 旧状态 / 未变化 / 409 / 冲突 / 0 项 / 无去重 / 超时` 大多来自本文件；出现即复核，不能凭词判 FAIL。
- 第 4 项校验（数字↔来源）在本文件最常踩：金额/数量必须来自响应字段或独立 HTTP 的同一资源读取；UI 文案反推一律不算。
- `NET_BODY_UNAVAILABLE`、`NET_EVENT_NOT_FOUND`、`NET_QUOTA_EXCEEDED` 等失败码的允许动作见 [`tool-routing-and-limits.md`](tool-routing-and-limits.md) §7。

## 6. 合成示例

**例 A：正常重放（应 PASS）**

```text
契约：断线重连允许重放未确认事件；UI 按 eventId 去重
观察：重连后服务端重放 3 条 eventId（与断线前最后 3 条相同）；UI 条目数不变、无重复渲染
证据：network_events(seq 区间) + 重连请求记录 + T2 snapshot 前后条数
结论：PASS；counterexamples 写"网络层重复投递已由 UI 去重吸收（契约允许）"
```

**例 B：正常延迟同步（应 PASS 或 INCONCLUSIVE，不误判）**

```text
契约：列表页缓存 5s，徽标依赖事件推送（最终一致）
观察：操作后 t=0 列表旧值，t+3s 列表更新，徽标在 t+5s 更新
证据：三次读取的时间戳与数值
结论：若契约写明收敛窗口 ≥5s → PASS；未写 → INCONCLUSIVE(needs-contract)
```

**例 C：真实缺陷（应 FAIL）**

```text
契约：同一资源在列表与详情页的金额必须一致（同一服务端字段）
观察：详情页显示 A，列表显示 B；两次读取间隔 <1s；响应体字段只支持 A
证据：network_detail 响应字段 + 两处 T2 node_state 文本
结论：FAIL（observation 数字与响应字段冲突，第 4 项校验通过但第 1 项触发复核后定性）
```