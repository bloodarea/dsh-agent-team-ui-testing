# 报告与覆盖声明：让每条结论可复核

> 目标：任何人只看报告就能复现证据链，并知道**哪些断言真的验证过、哪些只是替代路径**。
> 字段模板（JSON 与 Markdown 同源）见 [`report-template.md`](report-template.md)；判定门禁见 [`verdict-gate.md`](verdict-gate.md)。

## 1. 每个 case 必备字段

| 字段 | 取值 | 含义与要求 |
| --- | --- | --- |
| `case_id` | 稳定短 id | 与题目/任务编号可对应；额外发现另起 id，不与必考项复用 |
| `expected_contract` | 文本 + `source` | 验收条件 + **契约来源**（题目原文/接口文档/页面声明）；没有来源就写"未提供"，此时不判 PASS/FAIL |
| `observation` | 事实文本/数值/读数 | 只写实际看到的；时间戳、对象、区域都要能定位 |
| `counterexamples` | 数组 | 每条写"现象 + 为何不影响本判定（或改判依据）"；空数组要显式写 `[]` |
| `verdict` | `PASS` / `FAIL` / `BLOCKED` / `INCONCLUSIVE` / `NOT_RUN` | 只能由证据推出；`NOT_RUN` 不计入通过 |
| `coverage` | `full` / `partial` / `blocked` | 本 case 的**验证范围**完成度（见 §2）；与 verdict 独立 |
| `evidence_state` | `complete` / `partial` / `missing` | 证据**是否取得并可复核**（见 §3） |
| `evidence_ids` | 数组 | 动作级 id：`actionId`/`sessionId`/`productId`/`dynamicSessionId`+`frameIds`/`networkSessionId`+`seq`；截图另附 `sha256` |
| `attribution` | `{layer, kind, confidence}` | 归因：层（T1/T2/T3/T4/P0/ENV）+ 类别 + 置信度（`CONFIRMED`/`PROBABLE`/`HYPOTHESIS`/`UNKNOWN`） |
| `limitations` | 数组 | 明确写出"无法验证 X"；写了就**不能**该 case 判 PASS |

常见 `attribution.kind`：`MODEL_REASONING`（读题/对象选择/证据到结论映射）、`SKILL_GUIDANCE`（流程缺失导致可复发）、`TOOL_CAPABILITY`（缺接口/生命周期/证据）、`ENVIRONMENT`（headless/软件渲染/无设备）、`TEST_DESIGN_OR_SPEC`（契约未明）、`UNKNOWN`。

## 2. `coverage` 三态（覆盖范围，不是结论）

| 值 | 判定条件 | 报告写法 |
| --- | --- | --- |
| `full` | 契约要求的**每一项**断言都由**原生路径**证据覆盖 | 逐项列 evidence_id；可给 PASS/FAIL |
| `partial` | 有替代路径、或某子项缺证据、或只覆盖部分视图/尺寸/时序 | 必须写"替代了什么、仍缺哪条原始断言"（见 §4）；verdict 最多 `PASS(partial)` 并在 limitation 注明，或 `INCONCLUSIVE` |
| `blocked` | 关键路径完全不可用（能力/权限/环境） | verdict=`BLOCKED` + 阻断证据（见 §5） |

`coverage=full` 与 `verdict=PASS` 同时成立才算"完整通过"；`partial` 的 PASS 必须显式降级表述。

## 3. `evidence_state` 三态（证据是否到手）

- `complete`：关键断言都有可复核证据（内容/字段/像素/帧），且未截断。
- `partial`：有证据但缺项（例如只有 UI 文本没有响应体、只有单帧没有时序、截图被截断/掉帧）。
- `missing`：关键证据未取得（工具失败、配额、能力缺失）。此时结论必须是 `BLOCKED`/`INCONCLUSIVE`，并写缺什么。

## 4. 替代路径：必须声明"替代了什么、还缺什么"

| 替代路径 | 可以证明 | 仍缺的原始断言 | 写法 |
| --- | --- | --- | --- |
| `browser_tabs open` 自建标签 | 目标页面在新标签里的渲染/交互 | 原生的 `target=_blank`/`opener` 关系、焦点归属、postMessage 时序、触发动作与源页面 | `coverage:"partial"`，`limitation:["native-popup-not-observed"]` |
| `browser_http_request` 独立请求 | 接口契约（status/headers/body） | 页面是否真的发了同一请求（Cookie/凭据/时序/CORS 差异） | 写"接口契约已验证；页面链路未验证" |
| T3 `vision_act` 手工坐标 | 该坐标命中的顶层元素被点击 | 业务控件身份、可信派发语义 | `INCONCLUSIVE` 依赖；不能写"T2 交互已覆盖" |
| `browser_eval` 读/写页面值 | 页面内存状态 | 用户可见渲染、真实输入事件、网络副作用 | 不得写成"交互验证通过" |
| 手工构造 DOM/类名 | 布局假设 | 真实用户路径 | 只作成因线索，不作断言证据 |

规则：替代路径**不能**把 `coverage` 抬高到 `full`；写了替代就必须写缺项，缺项与 verdict 一致（`verdict-gate.md` 第 5 项校验）。

## 5. `BLOCKED` 的必附四件套

1. **尝试过的动作**（工具名 + 关键参数 + 时间）；
2. **错误码/错误摘要**（`[CODE]` + `details` 关键字段）；
3. **最小复现输入**（URL/选择器/帧窗口/请求，能让人再跑一次）；
4. **已完成的替代验证范围**（做了什么、覆盖到哪、为什么仍不构成原断言证据）。

缺任一项的 `BLOCKED` 视为证据不足，不能计入"受限通过"。

## 6. 额外发现：先与必考/缺陷清单去重

- 新发现的 id 不得复用必考项 id；内容与已有条目**同一现象/同一根因**时，写"已计入 case X"，不单列新发现（重复计数会稀释可信度）。
- 去重判据：同一页面对象 + 同一现象 + 同一时间窗 = 同一条；不同对象/不同契约 = 可以单列。
- 额外发现也要走五元组与 6 项校验，不能因为是"额外"就跳过证据。

## 7. 数字与截图的一致性

- **数字**：金额/数量/耗时/比例必须来自响应体、帧 `sourceTimestamp`、`comparison.metrics`、DOM 读数等可指认来源；UI 文案只能标为"UI 显示值"，不能反推服务端字段。
- **截图**：文件名/声明/内容三者一致。报告里写清 `sha256`、`capturedAt`、页面身份（url/title）、视口与 `scale`（`scaleSource:"view"` 还是 `"explicit"`）、`persist/out` 与否。暂存路径不能当持久引用。
- **帧**：写 `dynamicSessionId`/`motionSessionId`、`window` 或 `frameIds`、`verdict`+`resolvedThresholds`、`integrity`（dropped/evicted/truncated）、`roiSha256` 或交付方式。
- **网络**：写 `networkSessionId`、`seq`/`requestId`、body 三态、脱敏说明、导出相对路径。
- **T2**：写 `snapshotId`/`digest`（minted provenance）、`targets[].resolved`、`dispatch`、动作前后 `node_state`。

## 8. 报告结构（与模板同源）

```text
1. 任务与目标（task_ref / target / 授权范围 / 环境：headless-无头、GPU、视口、DPR）
2. 结果概览（pass/fail/blocked/inconclusive/not_run 计数；coverage 分布）
3. 逐 case（§1 字段 + 证据引用 + 判定理由）
4. 缺陷清单（每条映射到 case；同现象去重）
5. 覆盖与限制（替代路径、未覆盖断言、环境限制）
6. 附件索引（截图/帧/JSONL/HAR 的相对路径 + hash）
```

## 9. 提交前自检

- [ ] 每个 PASS/FAIL 都有 `evidence_ids` 与判定理由。
- [ ] 每个 `partial`/`blocked` 都写了缺项，且 verdict 与 limitation 一致。
- [ ] 缺陷清单与 case 一一对应，没有重复计分的同现象条目。
- [ ] 所有数字有来源；所有截图名与内容一致。
- [ ] 未执行项标 `NOT_RUN`；`INCONCLUSIVE`/`BLOCKED` 原样保留，没有为了好看降级成 PASS。
- [ ] 环境信息单列，没有把环境差异写成产品缺陷。