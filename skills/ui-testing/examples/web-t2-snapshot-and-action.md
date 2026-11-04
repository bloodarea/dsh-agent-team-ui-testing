# T2 示例：快照 → 定位 → 动作 → 证据 → 等待/节点状态

> 示例页面是仓库内确定性靶机 `tests/ui_test_fixture/web-t2.html`（契约见该目录 README「T2 页面契约」）。本文是**行为规范示例**，不是运行证据：`ref` 编号、`snapshotId`、`digest` 都随实际运行时变化，引用时必须写真实返回值。
> T2 工程状态：verified（优化构建 `tests/acceptance/runs/2026-11-01T03-41-31-025Z-39784/run-report.json`：探针 37/38、必需检查 **260/260**、exit 0；快照树为压缩后投影——见下文 `- text " "` 与 generic 无 ref 说明）。真实宿主会话已由 `本地验证记录（不随仓库分发）/t2-real-host-2026-11-01.md` 验证（14/14 检查行）；仍未验证：provider 图像可见性、closed-shadow ref 细分——这类断言写 `NOT_RUN`。

## 1. 先观察：拿到 ref

```json
browser_snapshot { "maxNodes": 500, "depth": 12 }
```

典型返回（截断示意）：

```text
snapshotId: "s1"
digest: "3f1c0a9b7d2e4c58"
tree:
- RootWebArea "DSH T2 Fixture"
  - heading "DSH T2 Fixture" [level=1] [ref=e1]
  - navigation "" [ref=e2]
    - link "T1 fixture page" [ref=e3]
    - link "T2 second page" [ref=e4]
  - heading "Form" [level=2] [ref=e5]
    ...
    - textbox "Name" [required] [ref=e12]
    - textbox "Email" [required] [ref=e13]
    - textbox "Bio" [ref=e14]
    - checkbox "I agree to the fixture terms" [checked=false] [ref=e15]
    - combobox "Country" [ref=e16]
    - button "Submit form" [ref=e17]
  - heading "Interactions" [level=2] [ref=e20]
    - button "Increment" [ref=e21]
    - text "0"
```

记录：`snapshotId`、`digest`、以及要用到的 `ref`（`e21`=Increment、`e12`=Name…）。`refs` 里每项带 `role/name/backendNodeId/frameId/bbox` 与 **minted** `snapshotId/digest`。

## 2. 定位：ref 还是 selector

- 有 `ref` 用 `ref`（最稳，带身份校验）；要跨多次快照复用时，只要节点身份不变、没被 LRU 淘汰，旧 `ref` 仍有效。
- 没有快照或要按结构表达式定位时用 `selector`，**必须主文档唯一**：

```
#t2-inc            → 唯一，可点
#t2-save           → 命中 2 个（.t2-save 同名按钮）→ TARGET_NOT_UNIQUE
#t2-does-not-exist → 0 命中 → TARGET_NOT_FOUND
#t2-??             → 非法 CSS → INVALID_ARGUMENT
```

禁止：`#t2-form input:nth-child(3)` 这类“第一个匹配就行”的写法、XPath、文本 DSL、`getByRole/getByText`。

## 3. 动作：可信派发 + 现场证据

```json
browser_click { "ref": "e21" }
```

返回 `{ok:true,dispatched:true,button:"left",clickCount:1,point:{x,y}}` + `evidence`（`provenance.snapshotId="s1"`、`targets[0].resolved.{role:"button",name:"Increment",bbox,identity.backendNodeMatched:true}`、`dispatch.{started:true,eventCount:2,completed:true}`、`before/after` 的 url/title/focus/scroll）。

**派发成功不等于断言通过**：读页面真值。

```json
browser_node_state { "selector": "#t2-counter" }
→ { "ok": true, "node": { "role": "generic", "name": "", "text": "1", "visible": true, ... } }
```

`#t2-counter` 由 `0` 变 `1` 才是这条断言（点击生效）的证据；只报 `dispatched:true` 等于没断言。

## 4. 输入与表单

```json
browser_type { "selector": "#t2-name", "text": "T2 Tester" }
```

- `replace` 默认 true：先清空再输入；`replace:false` 追加到末尾；`text:""` 清空。
- 结果只给 `insertedCharacters/replaced/submitted`，**不回显文本**；请输入后用 `browser_node_state` 或页面真值确认（注意可编辑控件的 `value` 恒为 `null`，`valueRedacted:true`，需用页面侧断言或 `state.valueEquals` 等待）。
- `submit:true` 只是派发 Enter；业务提交是否成功要另看 `#t2-output` / `document.body.dataset.t2Submitted`。

批量表单（整批预检通过才执行，失败不回滚）：

```json
browser_fill_form {
  "fields": [
    { "selector": "#t2-name", "type": "textbox", "value": "T2 Tester" },
    { "selector": "#t2-email", "type": "textbox", "value": "t2@example.test" },
    { "selector": "#t2-agree", "type": "checkbox", "value": true },
    { "selector": "#t2-plan-pro", "type": "radio", "value": true },
    { "selector": "#t2-country", "type": "combobox", "value": "cn" },
    { "selector": "#t2-tags", "type": "combobox", "value": ["a", "c"] },
    { "selector": "#t2-volume", "type": "slider", "value": 70 }
  ]
}
```

注意：`combobox`/`slider` 是**结构状态写入**（`eventSource:"dom-control"`），不打开原生 popup、不模拟拖拽；它们不等于“原生交互已验证”。失败时读 `details.applied/failedIndex/fields`，例如第 5 项 option 不存在 → `NOT_INTERACTABLE`，前 4 项的副作用保留。

## 5. 等待异步结果

```json
browser_click    { "selector": "#t2-async" }
browser_wait_for { "selector": "#t2-async-result", "state": { "visible": true, "valueEquals": "async-done" } }
```

- 多 key 为 AND；`valueEquals` 是精确等于。
- 超时抛 `WAIT_TIMEOUT`（`details.elapsedMs/polls/condition`，page 不关闭）；`timeoutMs:0` 只采样一次。
- 等“元素消失”用 `selector` + `{visible:false}`；**ref 失效是 `REF_STALE`，不能当成“已被移除”**。

## 6. 失败与升级的正确写法

| 场景 | 工具返回 | 报告 |
| --- | --- | --- |
| `#t2-hidden-btn`（父级 `display:none`） | `NOT_INTERACTABLE`，`details.reason:"hidden"`，`details.escalation:"T3"`，零派发 | 交互 `FAIL`；需要解释遮挡/可读性时用 T3（`browser_vision_image`/`compare`）给出成因证据 |
| `#t2-covered`（被 `#t2-overlay` 全覆盖） | `NOT_INTERACTABLE`，`reason:"covered"`，`escalation:"T3"` | 同上；**不得改坐标硬点** |
| 两个同名 Save 按钮 | `TARGET_NOT_UNIQUE`（含隐藏副本也计数） | 改用 ref 或更精确 selector，不改判“点了第一个所以通过” |
| 复用旧 ref 但页面已跨文档导航 | `REF_STALE` | 重新 `browser_snapshot` 后再动作 |
| 持续移动的元素 | `NOT_INTERACTABLE`，`reason:"unstable"` | 交互 `FAIL`；动画/时序判断走 T4（`browser_dynamic_session` + `motion_analyze`） |
| `contenteditable` 富文本 | `UNSUPPORTED` | 回落 T1（`browser_input` + 页面读回），并注明证据强度不同 |

## 7. 记录模板（T2）

- 目标断言与原始验收标准
- `browser_snapshot` 的 `snapshotId/digest/nodeCount/truncated`
- 每个动作的 `ref`/`selector`、参数摘要、`evidence.provenance`、`targets[].resolved`、`dispatch`
- 断言读取方式（`browser_node_state` / `browser_wait_for` / 页面真值）与前后值
- 失败码与 `details`（含 `escalation`）、是否 `FAIL`/`BLOCKED`/`INCONCLUSIVE`
- 未验证部分（T3 视觉、T4 动画、iframe/shadow 边界）写 `NOT_RUN`
