# 报告模板：机器可读 JSON 与 Markdown 同源

> 同一份结果输出两个视图：`report.json`（机器可读、可 diff）与 `REPORT.md`（人读）。
> 字段语义见 [`reporting.md`](reporting.md)；判定规则见 [`verdict-gate.md`](verdict-gate.md)。**两处字段名必须完全一致**，Markdown 只是同一对象的表格化投影。

## 1. JSON 骨架

```json
{
  "schema": "dsh-ui-testing/report-v1",
  "task": {
    "task_ref": "任务/题目来源的稳定引用（不含答案）",
    "objective": "被测目标与授权范围",
    "target": { "url": "…", "title": "…", "heading": "…" },
    "environment": {
      "runtime": "headless-chromium | headed",
      "gpu": "hardware | software(SwiftShader) | unknown",
      "viewport": { "width": 1280, "height": 800, "scale": 1, "dpr": 1 },
      "tab": "primary",
      "notes": []
    }
  },
  "summary": {
    "cases": 0,
    "pass": 0, "fail": 0, "blocked": 0, "inconclusive": 0, "not_run": 0,
    "coverage": { "full": 0, "partial": 0, "blocked": 0 }
  },
  "cases": [
    {
      "case_id": "case-01",
      "assertion": "这条断言问什么（一句话）",
      "expected_contract": { "text": "验收条件", "source": "契约来源或 \"未提供\"" },
      "observation": "实际事实（含对象/时间/数值）",
      "evidence_ids": ["actionId 或 sessionId 等"],
      "evidence_state": "complete | partial | missing",
      "counterexamples": [ { "observation": "反例现象", "disposition": "为何不影响本判定" } ],
      "coverage": "full | partial | blocked",
      "coverage_gaps": ["替代路径仍缺的原始断言"],
      "verdict": "PASS | FAIL | BLOCKED | INCONCLUSIVE | NOT_RUN",
      "reason": "判定理由（一段话）",
      "attribution": {
        "layer": "T1 | T2 | T3 | T4 | P0 | ENV",
        "kind": "MODEL_REASONING | SKILL_GUIDANCE | TOOL_CAPABILITY | ENVIRONMENT | TEST_DESIGN_OR_SPEC | UNKNOWN",
        "confidence": "CONFIRMED | PROBABLE | HYPOTHESIS | UNKNOWN"
      },
      "limitations": []
    }
  ],
  "findings": [
    { "finding_id": "F-01", "case_id": "case-01", "summary": "缺陷一句话", "severity": "high | medium | low", "duplicate_of": null }
  ],
  "alternative_paths": [
    { "case_id": "case-01", "path": "browser_tabs.open 自建标签", "replaces": "原生 target=_blank 流程", "missing_assertions": ["opener 关系", "焦点归属"] }
  ],
  "blocked": [
    { "case_id": "case-01", "attempts": [], "error": "[CODE] 摘要", "minimal_repro": "可复跑输入", "alternative_verified": [] }
  ],
  "evidence_index": [
    { "kind": "screenshot | frame | network-jsonl | network-har | product", "path": "相对路径", "sha256": "…", "captured_at": "ISO8601", "page": { "url": "…", "title": "…" } }
  ]
}
```

## 2. 字段规则（两视图都要满足）

| 字段 | 规则 |
| --- | --- |
| `expected_contract.source` | 必须有来源；没有就写 `"未提供"`，此时 `verdict` 只能是 `INCONCLUSIVE`/`UNKNOWN`，不得 PASS/FAIL |
| `evidence_ids` | PASS/FAIL 至少 1 条；`observation` 每个关键数字都要能在证据里找到出处 |
| `counterexamples` | 出现异常词（重复/旧值/未变化/白色/闪烁/409/冲突/超时/0 项…）就必须有处置条目 |
| `coverage` | `partial` 必须有非空 `coverage_gaps`；`blocked` 还要有 `blocked` 段四件套 |
| `coverage ↔ verdict` | 写了 `limitation`（无法验证 X）就不能 PASS |
| `findings` ↔ `cases` | 每条 finding 至少映射一个 `FAIL`；重复现象用 `duplicate_of` 指向首条，不重复计数 |
| `summary` | 由 `cases` 自动汇总，手写数字必须与逐项一致 |
| `evidence_index.path` | 只写持久根内的**相对**路径；暂存绝对路径不得入索引（会被当持久引用） |
| `environment` | 单列，不写进 `observation`；软件 GPU/headless 只作环境说明，不单独构成缺陷理由 |

## 3. Markdown 投影（同源，不另写结论）

````markdown
# UI 测试报告

环境：headless-chromium / software(SwiftShader) / 1280×800 @1 / primary
目标：<url> — <title>

## 概览
| cases | pass | fail | blocked | inconclusive | not_run | coverage(full/partial/blocked) |
|---|---|---|---|---|---|---|
| 3 | 1 | 1 | 0 | 1 | 0 | 1/2/0 |

## case-01 · <断言>
- 预期契约：<text>（来源：<source>）
- 观察：<observation>
- 证据：<evidence_ids>（evidence_state=complete）
- 反例处置：<counterexamples>
- 覆盖：full
- 判定：**PASS** — <reason>
- 归因：T2 / MODEL_REASONING / CONFIRMED
- 限制：<limitations 或 —>
````

要点：Markdown 的每一行都必须来自 JSON 的对应字段，**不得在 Markdown 里新增未入 JSON 的结论**；反过来 JSON 里也不要放 Markdown 独有的"备注"。

## 4. 最小示例（合成）

```json
{
  "schema": "dsh-ui-testing/report-v1",
  "task": {
    "task_ref": "synthetic-example",
    "objective": "检查表单提交后的状态反馈",
    "target": { "url": "http://127.0.0.1:3000/form", "title": "示例表单", "heading": "示例表单" },
    "environment": { "runtime": "headless-chromium", "gpu": "software(SwiftShader)", "viewport": { "width": 1024, "height": 768, "scale": 1, "dpr": 1 }, "tab": "primary", "notes": [] }
  },
  "summary": { "cases": 1, "pass": 0, "fail": 1, "blocked": 0, "inconclusive": 0, "not_run": 0, "coverage": { "full": 1, "partial": 0, "blocked": 0 } },
  "cases": [
    {
      "case_id": "case-01",
      "assertion": "必填项为空时提交应被拒绝并给出提示",
      "expected_contract": { "text": "空必填项提交返回错误提示，且不产生后端写入", "source": "接口文档 §x + 题目原文" },
      "observation": "点击提交后出现错误提示；网络无写请求；字段保持空值",
      "evidence_ids": ["act_…", "session_…", "networkSessionId=… seq=7"],
      "evidence_state": "complete",
      "counterexamples": [{ "observation": "提交按钮短暂 disabled", "disposition": "属于提交中的正常交互反馈，未产生写入，不构成缺陷" }],
      "coverage": "full",
      "coverage_gaps": [],
      "verdict": "FAIL",
      "reason": "提示出现方向与契约相反：契约要求拒绝并保持原值，实测页面把空值写入本地草稿并显示“已保存”",
      "attribution": { "layer": "T2", "kind": "MODEL_REASONING", "confidence": "CONFIRMED" },
      "limitations": []
    }
  ],
  "findings": [{ "finding_id": "F-01", "case_id": "case-01", "summary": "空必填项被当作已保存", "severity": "high", "duplicate_of": null }],
  "alternative_paths": [],
  "blocked": [],
  "evidence_index": [{ "kind": "screenshot", "path": "output/capture/case-01.png", "sha256": "…", "captured_at": "2026-01-01T00:00:00Z", "page": { "url": "http://127.0.0.1:3000/form", "title": "示例表单" } }]
}
```

## 5. 生成顺序（避免自相矛盾）

1. 先落 JSON（逐 case 填五元组），用脚本/人工跑 6 项交叉校验；
2. 校验通过后再生成 Markdown 投影（只搬字段）；
3. 最后汇总 `summary`/`findings` 并与逐 case 对账；对不上就回去改 JSON，不在 Markdown 里打补丁。