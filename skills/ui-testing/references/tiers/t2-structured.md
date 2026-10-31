# T2 · 结构化 GUI（未实现 / 不可用）

**实现状态：未实现，不可用。** 本插件没有注册任何 T2 工具。

## 不存在的能力

- 没有 DOM 树快照工具、ARIA/Accessibility 快照工具、元素选取工具；
- 没有 Playwright Locator / `getByRole` / `getByText` 等结构化定位能力；
- 没有 Shadow DOM 或 iframe 的跨边界节点协议；
- 没有“选择元素”回传聊天通道（面板按钮当前禁用）；
- 没有任何结构化 GUI 工具名；不要虚构。

## 不要用 T1 冒充 T2

`browser_eval` 可以在页面里执行 `document.querySelector(...)` 并返回可序列化值，但这只是**页面上下文 JS 状态**，不是 T2 的结构化 GUI 协议：

- 没有稳定的节点句柄、快照、无障碍语义或跨帧定位；
- 不能证明 ARIA role/name 正确、结构树完整，或元素在视觉上可交互；
- 返回值必须可序列化，DOM 节点/函数本身无法作为证据返回。
- `browser_computed_style` 只能按选择器取第一个匹配元素的计算样式，不提供节点身份或结构关系。

因此，当断言依赖“元素语义、可访问名、结构化定位、Shadow DOM/iframe 内部结构”时，报告 `BLOCKED` / `INCONCLUSIVE`，不要假装升级到 T2。

## 可交付条件（未来）

必须存在真实 Adapter、当前会话能力声明、最小回归、正负例及证据样本，才允许把该能力从 `unsupported` 变为可用；在此之前，任何文档都不得声称 T2 可用。
