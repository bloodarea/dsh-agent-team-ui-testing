# Web 平台操作指南（M0–M2）

Web 仅有部分 T1，8 个结构化工具；T2/T3/T4 未实现。按当前注册表与 browser_capabilities 实际三态选路，不把文档或 manifest 当运行态证明。工具映射见 [T1 表](../tiers/t1-programmatic.md)，返回见 [操作契约](../contracts/operation.md)。

一个无头 Chromium/page，默认 1280×800/DPR1，面板与 Agent 共用。single-owner-lease 非会话隔离：空闲 15s、进行中保持、缺 exec 共用 anonymous、disposed 释放；其他 session 页面/network BUSY；state/capabilities 不启动、不占租约。面板同串行队列，仍可能改变共享页面。

导航检查 errorText/最终 URL，不保证加载完成；标题从 document.title 刷新。目标/DNS/Document 重定向校验允许 loopback，阻断默认私网、metadata/unspecified/multicast/credentials/已配置宿主 origin。它不是子资源/页面 fetch/WebSocket 的完整网络沙箱，仍有 rebinding 风险。详细环境变量与风险见 [安全边界](../core/safety.md)。

网络记录响应/失败元数据、URL 脱敏、有界，close 清空；无头/正文。截图保留 base64 与时间/hash/附件 ID，可选附件 image block，无服务 base64-fallback 文本；provider 图像可见性另验，不提供 T3 差异分析。所有工具有 action 元数据并 render。

面板 screencast 的 WS 优先/HTTP 回退、metrics 都是预览诊断，不是 Agent 页面证据；内部 HTTP 路由不是 Agent API，不可绕过工具。

本轮须验证 8 工具/诊断不启动、标题/导航/错误、租约/anonymous/disposed/BUSY、面板队列与取消关闭、目标/DNS/Document 重定向、网络失败/脱敏/资源界限、action render、截图附件/fallback/provider。实测状态见 [台账](../../knowledge/web/t1-capability-ledger.md)，未跑写 NOT_RUN。没有独立 HTTP、Agent 视口设置、下载/上传/Cookie 导出、多 target/frame 或 T2–T4。
