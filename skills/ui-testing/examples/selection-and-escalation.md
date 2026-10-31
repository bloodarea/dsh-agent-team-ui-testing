# 按需选择与“无法升级”示例（当前实现）

> 本插件只实现了 Web T1 的一部分。以下表格说明：当断言需要 T2/T3/T4 或独立 HTTP 客户端时，正确行为是报告 `INCONCLUSIVE` / `BLOCKED`，**不得假装升级**。示例状态为行为规范，不是运行证据。

| ID | 断言 | 当前可用方法 | 正确行为 |
|---|---|---|---|
| SEL-01 | 页面跳转到目标地址 | `browser_navigate` + `browser_state` / `browser_eval` | 用 T1 验证；记录导航不等待加载，必要时观察 `location.href` |
| SEL-02 | 登录按钮的 `display` 是 `block` | `browser_computed_style` | 直接读计算样式；说明只证明 computed style，不证明像素 |
| SEL-03 | 点击后进入下一步 | `browser_input` + `browser_state` / `browser_eval` | 成对派发点击，另观察状态；`applied` 只作执行记录 |
| SEL-04 | 页面发起了某接口且返回 200 | `browser_network` | 响应与 loadingFailed 元数据、URL 脱敏；无头/正文，其他 owner BUSY |
| SEL-05 | 弹窗布局像素级正确 | **无 T3** | `BLOCKED` / `INCONCLUSIVE`；原始截图/可选 image block 不提供像素差异或阈值分析，provider 可见性另验 |
| SEL-06 | 过渡动画时长 300ms 且流畅 | **无 T4** | `BLOCKED`；单帧截图/`browser_eval` JS 值不能冒充 |
| SEL-07 | 按钮的 ARIA accessible name 正确 | **无 T2** | `BLOCKED`；`browser_eval` 读 DOM 属性不是 T2 结构化语义协议 |
| SEL-08 | 独立 HTTP 请求的响应头与状态码 | **无独立 HTTP 客户端** | `BLOCKED`；页面内 `fetch` 属于页面上下文，受 CORS/Cookie 限制，不能替代 |
| SEL-09 | 选择元素并回传聊天 | **T2 未实现，按钮禁用** | `BLOCKED`，不做“视觉点选”假装 |

## 回退与停止的正确姿势

- **同层替代**：只在 T1 内部换方法。例如用 `browser_eval` 读页面状态代替对 `browser_state.title` 的依赖；用 `browser_computed_style` 代替 `browser_eval` 里的 `getComputedStyle` 取样式证据。
- **禁止跨层假装**：`browser_screenshot` 返回图片不等于 T3；`browser_eval` 能执行 JS 不等于 T4；没有 Locator 就不要说“用结构化定位”。
- **动作状态未知**：先查 `browser_state` / 页面状态，再决定是否重试；不得盲重放提交/删除/支付。
- **确认缺陷**：`FAIL` 并停止，不用更高层“找 PASS”。
- **无方法可用**：`BLOCKED` / `INCONCLUSIVE`，写清缺哪项能力。

## 记录模板

- 目标断言与原始验收标准
- 当前工具注册表中实际存在的工具
- `browser_state` 探测结果（running/error/mode）
- 每个断言选用的工具、参数、返回值
- 同层替代与停止原因
- 操作副作用检查结果
- 最终状态与未验证部分
