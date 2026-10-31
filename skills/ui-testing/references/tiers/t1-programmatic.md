# T1 · 程序化接口（M0–M2）

部分实现；主验收21/21组、196/196必需项通过（P1–P21，含宿主 lossless JSON 契约 P21）；3081 HTTP集成已扩到14项，新增 N2 的 /input+/eval 检查待重启宿主后复跑；真实Agent/provider NOT_RUN。工具面 8 个，注册表决定可调用名字，browser_capabilities 报实际运行态三态；静态工程状态不能当 available。详细返回见 [操作契约](../contracts/operation.md)。

| 操作 | 工具 | 关键边界 |
| --- | --- | --- |
| 导航 | browser_navigate | errorText/最终 URL/目标与 DNS/Document 重定向校验，不保证 load complete |
| JS | browser_eval | 顶层主世界，可序列化值；页面异常 error 对象含描述/栈/位置 |
| 截图 | browser_screenshot | PNG base64、capturedAt/sha256/attachmentId；可选附件 image block，否则 base64-fallback 文本；provider 可见性另验，无 T3 分析 |
| 输入 | browser_input | applied 是数量，不证明生效；支持 modifiers（数组或 CDP 位掩码）、key 的 virtualKeyCode/autoRepeat 等、mouse 的 buttons/pointerType；无焦点管理工具与高层动作 |
| 网络 | browser_network | 响应与 loadingFailed 元数据、URL 脱敏、有界；无头/正文；其他 owner BUSY |
| CSSOM | browser_computed_style | 首匹配，未命中 error 对象；无伪元素/iframe/Shadow DOM 内部定位 |
| 状态 | browser_state | document.title 刷新与 owner 诊断，不启动/不占租约 |
| 能力 | browser_capabilities | 实际 available/unavailable/unsupported 与原因限制，不启动/不占租约 |

一个无头 Chromium/page，面板与 Agent 共享；single-owner-lease 非会话隔离，15s idle、进行中保持、缺 exec 共用 anonymous、disposed 释放。页面操作与 network 受租约；state/capabilities 可诊断。页面工具与面板同串行队列；已发 CDP 命令后 abort 先关闭浏览器再放锁，后续可懒启动。

默认视口 1280×800/DPR1，Agent 无视口工具。页面工具可懒启动，network/state/capabilities 不启动。CDP 超时、断连和取消有分类错误，pending timers 清理；close 清空网络/请求/URL/标题/帧并清进程/profile。

安全策略见 [安全边界](../core/safety.md)：loopback 允许，RFC1918 默认阻断，可显式环境变量开放；Document/DNS/最终 URL 校验不等于对子资源/页面 fetch/WebSocket 的完整网络沙箱，仍有 rebinding 风险。

所有工具 action 元数据进入 render；操作成功与断言分离。网络元数据不证明完整接口契约，CSSOM 不证明视觉，原始截图可见不意味着 T3/T4 已实现。独立 HTTP 客户端、下载/上传/Cookie 导出、多 target/frame 选择、T2–T4 仍 unsupported。验收状态见 [台账](../../knowledge/web/t1-capability-ledger.md)，未有本轮证据前不标 verified。
