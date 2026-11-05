# 判定门禁（Verdict Gate）：从证据到结论的强制映射

> 触发时机：任何 case 准备写 `PASS` / `FAIL` / `BLOCKED` / `INCONCLUSIVE`，以及整份报告提交之前。
> 本文件只讲流程与检查项；字段模板见 [`report-template.md`](report-template.md)，合成正反例见 [`verdict-examples.md`](verdict-examples.md)。

## 1. 五元组：每条断言必须成形

| 字段 | 含义 | 必须可核对的内容 |
| --- | --- | --- |
| `expected_contract` | 这条断言依据的验收条件 | 契约来源（题目/需求原文、接口文档、页面声明）+ 目标对象 + 可测的通过条件。**没有来源就不许判 PASS/FAIL**，只能写观察 + `UNKNOWN`。 |
| `observation` | 实际看到的原始事实 | 数值、文本、响应原文、像素差、帧间隔、DOM 读数。写事实，不写"大概/似乎/应该是"。 |
| `evidence_ids` | 支撑 observation 的动作证据 | `actionId`/`sessionId`、`productId`、`dynamicSessionId`+`frameIds`、`networkSessionId`+`seq`/`requestId`；截图另附 `sha256`。 |
| `counterexamples` | 与断言相反或被排除的观察 | 每一条都要回答两个问题：它是否真的与本断言冲突；若不冲突，凭什么排除（时间窗、对象、契约、阈值）。 |
| `verdict` | `PASS` / `FAIL` / `BLOCKED` / `INCONCLUSIVE` / `NOT_RUN` | 只能由前四项推出，并写一句理由。 |

三条硬规则：

1. **对象同一性**：`observation` 与 `expected_contract` 必须指向同一个页面、元素、区域和时间窗；指向另一个对象不算同一条断言。
2. **无 evidence 不判定**：没有 `evidence_ids` 的 observation 只是印象，不能作为 PASS 或 FAIL 的依据。
3. **未执行 = `NOT_RUN`**：不能计入"通过"，也不能被"部分覆盖"吸收。

## 2. 提交前 6 项交叉校验

任一项未消解，**不得 PASS**；可以改判 `FAIL`、降级 `INCONCLUSIVE`，或回去补证据。

| # | 校验 | 典型不通过表现 | 处置 |
| --- | --- | --- | --- |
| 1 | **verdict ↔ observation** | `PASS` 的 observation 里含未解释的异常词：重复、重放、旧值、未变化、白色、闪烁、错位、回退、0 项、无去重、409、冲突、失败、超时 | 逐词复核：若属实且违反 `expected_contract` → 改 `FAIL`；若契约允许 → 在 `expected_contract` 写明来源并在 `counterexamples` 解释 |
| 2 | **verdict ↔ 缺陷清单** | 缺陷清单里有条目没有对应 `FAIL`，或 `PASS` 的 case 被写进缺陷清单 | 每条缺陷必须映射到至少一个 `FAIL`（或明确写"不构成缺陷"+ 依据）；同一现象不可同时是 PASS 和缺陷 |
| 3 | **observation ↔ evidence** | 关键断言没有 evidence URI；或证据内容展示的不是被断言的状态（换了区域/时刻/页面） | 补采同一对象同一时刻的证据；截图要给内容特征（区域/文本/像素），不能只看文件名 |
| 4 | **数字 ↔ 来源** | 报告里的金额/数量/耗时来自 UI 文案或推算，而不是响应体或测量记录 | 每个数字标注来源字段与工具调用；无法取得服务端真值时写"UI 值"，不得反推服务端字段 |
| 5 | **limitation ↔ status** | 写了"无法验证 X"，该 case 仍判 `PASS` | 只能 `BLOCKED` 或标 `coverage:"partial"`，并在 `evidence_state` 说明缺什么 |
| 6 | **截图 ↔ 文件名/声明** | 声明的页面/登录态/视口与截图内容不一致 | 以内容为准修正声明；文件名与截图内容对不上就换名或重采，不许保留"名不副实"的证据 |

补充：`ok:true`、`dispatched:true`、`applied:N`、`verdict:INCONCLUSIVE` 本身都不是断言结论，它们只能出现在 observation 里。

## 3. 反例触发词：出现就要复核，但不能凭词判 FAIL

以下词出现在 observation 或页面文本里时，**触发一次复核**（而不是直接定性）：

```text
重复 / 重放 / 重连 / 旧状态 / 旧值 / 未变化 / 无变化 / 白色 / 闪烁 / 错位 / 遮挡
回退 / 0 项 / 空列表 / 无去重 / 409 / 冲突 / 失败 / 超时 / 重试 / 丢帧 / 截断
```

复核要回答三问：

1. 这个现象发生在**哪个对象与时间窗**？是否就是本断言的对象？
2. 契约是否**明确允许**它（例如最终一致、幂等重放、设计上的装饰动画）？来源在哪？
3. 若契约不允许，它对**用户可见结果**有什么影响？能否复现？

三问都能落到证据上才写结论；落不到就写"待确认"并降级，不要用"看起来是设计"补齐。

## 4. 正例 / 反例 / 未知：三种处置

| 情形 | 处置 | 禁止 |
| --- | --- | --- |
| **正例**：证据覆盖契约要求的全部关键点，反例已被解释或排除 | `PASS` + `evidence_ids` + 反例处置说明 | 只写"看起来正常" |
| **反例**：证据明确违反契约，且可复现/可定位 | `FAIL` + 缺陷条目 + 最小复现步骤 | 继续找 PASS"翻案"、换目标/换阈值凑通过 |
| **未知**：契约不明、证据不足、能力缺失、对象身份不确定 | 观察 + `UNKNOWN`/`INCONCLUSIVE`/`BLOCKED`；写清缺什么 | 用个人印象建立产品规约；把未知写成 PASS |

契约不明时的标准写法：`expected_contract: 未提供，无法判定是否符合预期` + `observation` 原文 + `verdict: INCONCLUSIVE` + `limitation: needs-contract`。

## 5. 合成示例（模式，不是任何靶机的答案）

**例 A：证据在手却判 PASS（必须被拦住）**

```text
expected_contract: 列表项在重复提交后不得出现重复条目
observation:       列表出现 2 条同 id 条目；请求日志显示同一 payload 发送 2 次
evidence_ids:      networkSessionId=n1 seq=12,13；snapshotId=s3 digest=…
counterexamples:   —
verdict:           FAIL  ← 第 1 项校验（observation 含"重复"）与第 2 项（缺陷清单映射）同时成立
```

**例 B：现象存在但契约允许（应判 PASS + 解释，不误伤）**

```text
expected_contract: 契约文档 §x：断线重连后服务端允许重放最近 N 条事件；UI 按 eventId 去重
observation:       重连请求携带游标；界面事件条数与首次加载一致，无重复渲染
evidence_ids:      networkSessionId=…（reconnect 请求 + SSE eventId 序列）、截图 sha256=…
counterexamples:   "重复投递"出现在网络层 → 被 UI eventId 去重吸收，页面无重复条目
verdict:           PASS（在 counterexamples 写明"重复投递被去重，契约允许"）
```

**例 C：契约不明（不猜）**

```text
expected_contract: 未提供
observation:       两个视图的同一数值相差 1，5s 后一致
evidence_ids:      两次读取的时间戳与各自读数
counterexamples:   契约未写收敛窗口
verdict:           INCONCLUSIVE（limitation: needs-contract；不写"未同步=缺陷"）
```

## 6. 报告级终检（提交前对着清单打勾）

- [ ] 每个 `PASS` 都有 `evidence_ids`，且证据内容与断言对象一致。
- [ ] 每个缺陷条目都能映射到至少一个 `FAIL`；没有"PASS + 缺陷"共存。
- [ ] 所有异常词都已复核并留处置说明。
- [ ] 所有数字都有来源；没有从 UI 文案反推服务端字段。
- [ ] 写了"无法验证"的 case 没有被判 `PASS`。
- [ ] 截图文件名、声明、内容三者一致（页面/登录态/视口）。
- [ ] 替代路径已声明 coverage（见 [`reporting.md`](reporting.md)）。
- [ ] 未执行项标 `NOT_RUN`，未写成通过。