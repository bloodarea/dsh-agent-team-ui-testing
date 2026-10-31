# Fallback & Stop · 恢复与停止（当前实现版）

> 本文件只在按 `selection.md` 选路后参与决策。回退是换一个 T1 方法验证**同一个预先确定的断言**；不能降低验收标准，也不能用新结果覆盖已证实的缺陷。当前插件没有实现 T2/T3/T4，**不存在可用的跨层升级路径**。

## 决策流程

```text
目标 / 断言 / 当前工具注册表
          |
          v
   选择一个 T1 工具执行
          |
          v
     独立观察 + 断言
          |
          +-- 证据充分且符合预期 ----------> PASS（附证据）
          |
          +-- 证据充分但不符合预期 --------> FAIL（保留缺陷证据，停止）
          |
          +-- 无授权 / 风险不可接受 --------> BLOCKED（停止）
          |
          +-- 动作状态未知 ----------------> 先查 browser_state / 页面状态，再决定能否重试
          |
          +-- 工具缺失 / 能力未实现 / 证据不足
                         |
                         v
              同层是否有其它 T1 方法能证明同一断言？
                 | 是                    | 否
                 v                       v
            替代执行并独立断言       INCONCLUSIVE / BLOCKED
                                    （不得假装升级到 T2–T4）
```

“同层替代”只可能是 T1 内部的方法（例如用 `browser_eval` 读状态、用 `browser_computed_style` 读样式）。**不要因为 `browser_screenshot` 能返回图片就把它当作 T3，也不要因为 `browser_eval` 能执行 JS 就宣称具备 T4 动画采样。**

## 执行失败分类

| 结果 | 语义 | 合法下一步 |
|---|---|---|
| `UNSUPPORTED` | 当前插件明确没有该能力（如 T2–T4、独立 HTTP 客户端、下载/上传/Cookie/多标签页） | 报告 `BLOCKED`，不要找不存在的方法 |
| `UNAVAILABLE` | 工具存在但当前不可用（浏览器启动失败、CDP 连接断开、30s 超时） | 检查 `browser_state.error`；可重试一次并记录，不要越权绕过 |
| `INCONCLUSIVE` | 执行了部分操作，但证据不足以得出结论（例如截图无法分析、导航未等待加载） | 换 T1 观察方法；仍不足则 `INCONCLUSIVE` |
| `ACTION_UNKNOWN` | 输入/导航超时或断连，副作用不确定 | **先查页面状态**，不得盲重放提交、删除、支付等动作 |
| `ACTION_FAILED` | 明确执行失败且已检查副作用 | 在预算和风险允许时替换 T1 方法或重试 |
| `ASSERTION_FAILED` | 充分证据确认被测应用违背断言 | `FAIL`，停止“寻找 PASS” |
| `PERMISSION_DENIED` | 无授权或权限受限 | `BLOCKED`，不能通过其它层级绕过权限 |
| `OBSERVED_PASS` | 断言被充分证据验证 | `PASS`，附证据并结束该断言 |

## 三类常见边界

1. **导航后立刻断言**：`browser_navigate` 检查 errorText/最终 URL 与目标策略，但不保证 load complete。通过 state/eval 观察并记录时序限制；证据不足时 INCONCLUSIVE。
2. **`browser_input` 返回 `applied`**：它只是事件数组长度，未知 `kind` 会被静默跳过，也不代表控件接收了事件。必须观察操作后状态；状态未知时先查，不要重复点击。
3. **截图证据不足**：保留 base64，可选附件 image block，缺服务 render base64-fallback 文本；provider 可见性另验。插件无像素差异/裁剪/视觉分析，不能以截图动作成功代替视觉阈值证据。

以上表格的 UNAVAILABLE/ACTION_UNKNOWN 等是 Agent 报告分类，非新增工具错误码。真实 code 包含 NAV_FAILED/CDP_TIMEOUT/CDP_DISCONNECTED/TARGET_NOT_FOUND/EVAL_ERROR/BUSY/ABORTED/INVALID_ARGUMENT/UNSUPPORTED/INTERNAL。BUSY 可用 state/capabilities 诊断，不能绕过租约；取消可能先关闭浏览器，不回滚网页副作用，重试前查应用状态。

## 停止条件

- 没有可用工具能证明当前断言：停止并报告 `BLOCKED` / `INCONCLUSIVE`。
- 已确认真实缺陷：`FAIL` 并保留证据，不再尝试其它层级“翻案”。
- 动作状态未知且不可逆：先查状态；仍未知则停止，报告 `ACTION_UNKNOWN`。
- 达到会话/时间/风险预算：停止，不做无限重试。
