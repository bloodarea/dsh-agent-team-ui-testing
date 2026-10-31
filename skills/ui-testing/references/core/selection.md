# Selection · 按断言选择方法

先明确需要的证据，再确认当前注册表与 browser_capabilities 实际状态。T2–T4 未实现；同层替代只能证明同一个原始断言。

| 断言 | 工具 | 证据与边界 |
| --- | --- | --- |
| 运行态/owner/标题 | browser_state | document.title 刷新、连接/最后错误，不保证加载完成 |
| 当前能力/限制 | browser_capabilities | 实际 available/unavailable/unsupported，不启动、不占租约 |
| 页面 JS 状态 | browser_eval | 可序列化值，不冒充点击/网络/CSSOM/动画 |
| 页面请求成功或失败 | browser_network | 响应及 loadingFailed、脱敏 URL，无头/正文；其他 owner BUSY |
| 元素计算样式 | browser_computed_style | 首匹配值，不证明像素/遮挡 |
| 当前 PNG | browser_screenshot | base64/时间/hash/附件；可选 image block，缺服务 fallback，provider 可见性另验；无 T3/T4 分析 |
| 点击/文本/滚动 | browser_input | 事件数量，不证明生效；另查状态 |

1. 拆分状态、样式、网络、副作用、视觉与动画断言。
2. 查注册表、capabilities/state；静态台账不代表可用性，不绕过 BUSY/缺工具。
3. 选择能提供足够证据的工具，记录参数、预期、限制。
4. 执行并另行观察；失败按 fallback.md 分类，不因 ok/applied 判 PASS。

导航检查 errorText/最终 URL 仍不等待 load complete；另读 readyState/应用状态。点击成对派发，核对结果后再重试。network 失败记录不代表完整接口报文；可见原始图像不等于像素阈值或动画证据。单个 T1 断言通过不能判整个 GUI 场景通过。没有足够方法时 BLOCKED/INCONCLUSIVE，确认缺陷 FAIL。
