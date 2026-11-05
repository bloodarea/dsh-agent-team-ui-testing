# Fallback & Stop · 恢复与停止（当前实现版）

> 本文件只在按 `selection.md` 选路后参与决策。回退是换一个方法验证**同一个预先确定的断言**；不能降低验收标准，也不能用新结果覆盖已证实的缺陷。当前插件已实现 T1 + T2 + T3 + T4 + 网络 P0 + P0-E 多标签（36 工具）：T2 → T3 → T4 的升级是**真实可用路径**，且跨层证据要分别记账。

## 决策流程

```text
目标 / 断言 / 当前工具注册表
          |
          v
   选择工具执行（元素级交互优先 T2，其余用 T1）
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
              同层是否有其它方法（T2 或 T1）能证明同一断言？
                 | 是                    | 否
                 v                       v
            替代执行并独立断言       INCONCLUSIVE / BLOCKED
                                    （不得假装升级到 T3/T4）
```

“同层替代”是 T2 内部换目标表达形式（ref ↔ 唯一 selector、`wait_for` ↔ `node_state` 轮询）或 T1 内部换方法（`browser_eval` 读状态、`browser_computed_style` 读样式、`browser_input` 派发原始事件序列）。**不要因为 `browser_screenshot` 能返回图片就把它当作 T3，也不要因为 `browser_eval` 能执行 JS 就宣称具备 T4 动画采样，更不要用页面内 `.click()`/DOM 写值顶替 T2 的可信派发。**

## T2 失败的归类

`REF_STALE`、`TARGET_NOT_FOUND`、`TARGET_NOT_UNIQUE`、`NOT_INTERACTABLE`、`WAIT_TIMEOUT` 是**发现**，不是“换个方式点成功”的许可：

| T2 失败 | 正确下一步 | 禁止 |
| --- | --- | --- |
| `REF_STALE` | 重新 `browser_snapshot` 拿新 ref | 复用旧 ref、猜编号、按坐标硬点 |
| `TARGET_NOT_FOUND` / `TARGET_NOT_UNIQUE` | 改用 ref 或更精确的唯一 selector | 取第一个匹配、`nth-child` 碰运气 |
| `NOT_INTERACTABLE`（hidden/covered） | 记 `FAIL`；需要视觉成因时用 T3 截图/对比给出成因证据 | force/JS click、改坐标、换相似节点 |
| `NOT_INTERACTABLE`（unstable） | 记 `FAIL`；动画/时序判断走 T4（帧序列 + `motion_analyze`） | 缩短观察窗口假装稳定 |
| `NOT_INTERACTABLE`（focus/value-mismatch） | 记 `FAIL` 并保留 dispatch 证据 | 直接写 DOM value 凑结果 |
| `WAIT_TIMEOUT` | 记 `FAIL`/`INCONCLUSIVE`，检查条件是否写错 | 缩小 `timeoutMs` 掩盖、把超时当“元素不存在” |
| `UNSUPPORTED`（contenteditable/`number`/`date`/`file` 等） | 回落 T1 并说明证据强度不同 | 声称 T2 已完成该输入 |

## 执行失败分类

| 结果 | 语义 | 合法下一步 |
|---|---|---|
| `UNSUPPORTED` | 当前插件明确没有该能力（如 T3/T4、iframe/OOPIF 内部、closed shadow、contenteditable 编辑器、下载/上传/Cookie 导出、Agent 多标签页选择（GUI 内部标签页另有支持）、原生 select popup、Agent 视口工具） | 报告 `BLOCKED`，不要找不存在的方法 |
| `UNAVAILABLE` | 工具存在但当前不可用（浏览器启动失败、CDP 连接断开、30s 超时） | 检查 `browser_state.error`；可重试一次并记录，不要越权绕过 |
| `INCONCLUSIVE` | 执行了部分操作，但证据不足以得出结论（例如截图无法分析、导航未等待加载） | 换 T1 观察方法；仍不足则 `INCONCLUSIVE` |
| `ACTION_UNKNOWN` | 输入/导航超时或断连，副作用不确定 | **先查页面状态**，不得盲重放提交、删除、支付等动作 |
| `ACTION_FAILED` | 明确执行失败且已检查副作用 | 在预算和风险允许时替换 T1 方法或重试 |
| `ASSERTION_FAILED` | 充分证据确认被测应用违背断言 | `FAIL`，停止“寻找 PASS” |
| `PERMISSION_DENIED` | 无授权或权限受限 | `BLOCKED`，不能通过其它层级绕过权限 |
| `OBSERVED_PASS` | 断言被充分证据验证 | `PASS`，附证据并结束该断言 |

## 四类常见边界

1. **导航后立刻断言**：`browser_navigate` 检查 errorText/最终 URL 与目标策略，但不保证 load complete。通过 state/eval 观察并记录时序限制；证据不足时 INCONCLUSIVE。跨文档导航也会让 T2 的 ref 全部失效（`REF_STALE`），必须重新快照。
2. **`browser_input` 返回 `applied`**：它只是事件数组长度，未知 `kind` 会被静默跳过，也不代表控件接收了事件。必须观察操作后状态；状态未知时先查，不要重复点击。
3. **T2 返回 `dispatched:true`**：只表示可信事件已派出，业务结果仍未断言。用 `browser_node_state` / `browser_wait_for` / 页面真值读回；`fill_form` 的 `applied` 同理，部分生效且不回滚。
4. **截图证据不足**：保留 base64，可选附件 image block，缺服务 render base64-fallback 文本；provider 可见性另验。P0已支持连续scale/文档clip/PNG校验与安全落盘，仍无像素差异/视觉分析，不能以截图动作成功代替视觉阈值证据。capture.warnings与附件metadata须保留；缺字段不推断模型收到原图。

以上表格的 UNAVAILABLE/ACTION_UNKNOWN 等是 Agent 报告分类，非新增工具错误码。真实 code 包含 NAV_FAILED/CDP_TIMEOUT/CDP_DISCONNECTED/TARGET_NOT_FOUND/EVAL_ERROR/BUSY/ABORTED/INVALID_ARGUMENT/UNSUPPORTED/INTERNAL；T2 另有 REF_STALE/TARGET_NOT_UNIQUE/NOT_INTERACTABLE/WAIT_TIMEOUT（一律抛错）；独立 HTTP 另有 HTTP_TIMEOUT/HTTP_FAILED/HTTP_REDIRECT_LIMIT。BUSY 可用 state/capabilities 诊断，不能绕过租约；取消可能先关闭浏览器，不回滚网页副作用，重试前查应用状态。

## P0 采集失败恢复

CAPTURE_FAILED（capture/true）可先诊断；INVALID_PNG、CAPTURE_SIZE_MISMATCH、CAPTURE_UPSCALED（capture/false）不交付坏图/尺寸异常图，保留安全expected/actual，不能用附件绕过。CAPTURE_TOO_LARGE（resource/false）需减少区域或scale；OUTPUT_PATH_INVALID（input/false）修正相对.png/out或绝对env根；OUTPUT_EXISTS（output/false）必须换out，不能覆盖；OUTPUT_WRITE_FAILED（output/true）先核对发布事实，link成功后不回滚。取消/超时/断连保留原码，retryable不授权自动重放。

legacy无cwd默认仍staging；persist/out且无持久根报OUTPUT_PATH_INVALID(root_unknown)，不能静默暂存。暂存失败才file=null+capture_file_unavailable，图片继续交付；无附件时attachment_unavailable+fallback；这两种降级不能声称已落盘/模型已看图。其余封闭warnings为content_uniform/content_transparent/model_image_downscaled/attachment_reencoded/blank_check_skipped/capture_beyond_viewport；均匀统计不是产品视觉FAIL。

## 停止条件


- 已确认真实缺陷：`FAIL` 并保留证据，不再尝试其它层级“翻案”。
- 动作状态未知且不可逆：先查状态；
- 达到会话/时间/风险预算：停止，不做无限重试。
