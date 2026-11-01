# 按需选择与升级示例（当前实现）

> 本插件已实现 Web T1（程序化接口）+ T2（结构化 GUI，待运行验收）；T3/T4 与其它平台未实现。下表说明每个断言该用什么、以及**不能装作可用**的边界；独立 HTTP 请求由 `browser_http_request` 覆盖（SEL-08），元素级交互由 T2 覆盖（SEL-10…SEL-14）。示例状态是行为规范，不是运行证据。

| ID | 断言 | 当前可用方法 | 正确行为 |
|---|---|---|---|
| SEL-01 | 页面跳转到目标地址 | `browser_navigate` + `browser_state` / `browser_eval` | 用 T1 验证；记录导航不等待加载，必要时观察 `location.href` |
| SEL-02 | 登录按钮的 `display` 是 `block` | `browser_computed_style` | 直接读计算样式；说明只证明 computed style，不证明像素 |
| SEL-03 | 点击后进入下一步（需要可信点击证据） | `browser_snapshot` → `browser_click` | ref/唯一 selector + `evidence.dispatch`；再用 `browser_node_state` 或页面真值断言；`dispatched:true` 不是 PASS |
| SEL-04 | 页面发起了某接口且返回 200 | `browser_network` | 响应与 loadingFailed 元数据、URL 脱敏；无头/正文，其他 owner BUSY |
| SEL-05 | 弹窗布局像素级正确 | **无 T3** | `BLOCKED` / `INCONCLUSIVE`；原始截图/可选 image block 不提供像素差异或阈值分析 |
| SEL-06 | 过渡动画时长 300ms 且流畅 | **无 T4** | `BLOCKED`；单帧截图/`browser_eval` JS 值不能冒充 |
| SEL-07 | 按钮的 ARIA accessible name 正确 | `browser_snapshot`（T2） | 用 AX 文本树的 role/name 断言；不要用 `browser_eval` 读 DOM 属性冒充语义树 |
| SEL-08 | 独立 HTTP 请求的响应头与状态码 | `browser_http_request` | 直接请求，读 `status/headers/body`；默认不跟随重定向、无 cookie jar；超时/网络/重定向超限有分类错误 |
| SEL-09 | 选择元素并回传聊天 | **面板“选择元素”未实现（按钮禁用）** | `BLOCKED`；但“按 ref 操作元素”已由 T2 覆盖，与面板点选回传是两件事，不要混为一谈 |
| SEL-10 | 表单（文本框/勾选/单选/下拉/滑块）按值填好 | `browser_fill_form` | 整批预检后执行；`combobox`/`slider` 为 `dom-control` 结构写入，**不打开原生 popup、不模拟拖拽** |
| SEL-11 | 异步结果出现后再断言 | `browser_wait_for` | `text`/`state` 条件；超时抛 `WAIT_TIMEOUT`（page 不关闭），不能缩小预算掩盖 |
| SEL-12 | 隐藏/被遮挡按钮点不动是缺陷 | `browser_click` | `NOT_INTERACTABLE` + `details.reason` 即 finding；`escalation:"T3"` 只说明视觉成因需 T3，不改坐标硬点 |
| SEL-13 | 同名两个 Save 按钮该点哪一个 | `browser_click` | 用 `ref` 或更精确的唯一 selector；`TARGET_NOT_UNIQUE` 时**不能取第一个** |
| SEL-14 | input[type=number] / contenteditable 输入 | **T2 `browser_type` 不支持** | 抛 `UNSUPPORTED`；回落 T1 `browser_input` + 页面读回，并注明证据强度不同 |
| SEL-15 | iframe / closed shadow 内部元素 | **无 T2 路径** | `BLOCKED`；只报告边界叶子状态，不把动作送进内部、不落到相似节点 |

## 回退与停止的正确姿势

- **T2 内部替代**：ref ↔ 主文档唯一 selector；`wait_for` ↔ `node_state` 轮询；但这只换表达形式，不降低证据要求。
- **T2 → T1 回落**：只在 T2 缺能力（`UNSUPPORTED`：contenteditable/number/date/file、iframe 内部）或需要原始事件序列（多点、组合键、滚轮增量）时使用，并说明回落理由。
- **禁止跨层假装**：`browser_screenshot` 返回图片不等于 T3；`browser_eval` 能执行 JS 不等于 T4；页面内 `.click()`/直接写 DOM value 不等于 T2 的可信派发。
- **T2 失败即 finding**：`REF_STALE` 重新快照，`NOT_INTERACTABLE`/`WAIT_TIMEOUT` 记 `FAIL`，不做 force/改坐标/换节点。
- **动作状态未知**：先查 `browser_state` / 页面状态，再决定是否重试；不得盲重放提交/删除/支付。
- **确认缺陷**：`FAIL` 并停止，不用更高层“找 PASS”。
- **无方法可用**：`BLOCKED` / `INCONCLUSIVE`，写清缺哪项能力。

## 记录模板

- 目标断言与原始验收标准
- 当前工具注册表中实际存在的工具
- `browser_state` 探测结果（running/error/mode）
- 每个断言选用的工具、参数、返回值（T2 另附 `snapshotId/digest`、`targets[].resolved`、`dispatch`）
- 替代/回落与停止原因
- 操作副作用检查结果
- 最终状态与未验证部分
