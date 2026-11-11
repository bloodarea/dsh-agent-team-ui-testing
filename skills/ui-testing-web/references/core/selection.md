# Selection · 按断言选择方法

先明确需要的证据，再确认当前注册表与 browser_capabilities 实际状态。T1 程序化接口 + T2 结构化 GUI + T3 静态视觉 + T4 动态行为 + 网络 P0 均已实现（验收范围见各层台账；同层替代只能证明同一个原始断言。

| 断言 | 工具 | 证据与边界 |
| --- | --- | --- |
| 运行态/owner/标题 | browser_state | document.title 刷新、连接/最后错误，不保证加载完成 |
| 当前能力/限制 | browser_capabilities | 实际 available/unavailable/unsupported，不启动、不占租约；自身抛错时按证据不足处理 |
| 元素语义/结构（role、name、树形） | browser_snapshot | AX 文本树 + refs；只覆盖主 frame，iframe 是边界叶子 |
| 点击/输入/滚动/表单（元素级） | browser_click / browser_type / browser_scroll / browser_fill_form | ref 或唯一 selector；可信 CDP 输入；失败抛 T2 错误码，不 force |
| 单节点状态（可见/启用/勾选/焦点/bbox） | browser_node_state | 现场读数，可编辑值脱敏 |
| 异步条件（出现/消失/文本/值） | browser_wait_for | 三类互斥条件；超时抛 WAIT_TIMEOUT，page 不关闭 |
| 页面 JS 状态 | browser_eval | 可序列化值，不冒充点击/网络/CSSOM/动画；不冒充 T2 结构化协议 |
| 页面请求成功或失败 | browser_network | 响应及 loadingFailed、脱敏 URL，无头/正文；其他 owner BUSY |
| 元素计算样式 | browser_computed_style | 首匹配值，不证明像素/遮挡 |
| PNG采集/局部高密度证据 | browser_screenshot | 显式scale 0.1–4（省略跟随共享view.scale）/region画布CSS（O=0时同文档）/out相对.png；includeAnnotations?:boolean=false，true 叠加 Host 已接受的六形状（不含草稿/工具栏）；用户指代标注时先 state.annotations 再带标注截图，默认截图与 T3/T4 原始源不含面板标注；PNG校验、capture.annotations/映射/文件/附件metadata/warnings；observed不等于本次图，provider另验；无T3/T4分析 |
| 原始事件序列（多点/组合键/滚轮） | browser_input | 事件数量，不证明生效；另查状态 |
| 颜色/遮挡成因/可读性/像素差异 | **T3**（`browser_vision_*`） | 用确定性算法取像素证据；T2 的 hit-test 只证明坐标命中 |
| 动画/时序/帧连续性 | **无 T4** | BLOCKED；单帧截图与 JS 读值不能冒充 |

1. 拆分状态、样式、网络、副作用、视觉与动画断言。
2. 查注册表、capabilities/state；静态台账不代表可用性，不绕过 BUSY/缺工具。
3. 选择能提供足够证据的工具，记录参数、预期、限制。**元素级交互优先 T2**（元素语义、可信点击/输入、表单、等待），只有在 T2 工具缺失/抛 `UNSUPPORTED`/需要原始事件序列时才回落 T1，并说明回落理由。
4. 执行并另行观察；失败按 fallback.md 分类，不因 ok/applied/dispatched 判 PASS。

导航检查 errorText/最终 URL 仍不等待 load complete；另读 readyState/应用状态。点击成对派发，核对结果后再重试。T2 的 `dispatched:true` 只代表事件已发出，必须用 `browser_node_state`/`browser_wait_for`/页面真值断言。network 失败记录不代表完整接口报文；可见原始图像不等于像素阈值或动画证据。单个断言通过不能判整个 GUI 场景通过。没有足够方法时 BLOCKED/INCONCLUSIVE，确认缺陷 FAIL。
