# T3 · 静态视觉理解（未实现）

本插件没有Sharp/Pixelmatch/基线阈值、视觉坐标标注或VLM分析管线；T3仍unsupported。P0已在browser_screenshot提供连续scale1–4/文档region/PNG校验与安全落盘，属于共享采集基础设施；裁剪和均匀统计不等于视觉判定。P0三次进程内真实Chromium各13/13、115/115，证据见 [T1台账](../../knowledge/web/t1-capability-ledger.md) 的P0记录；真实宿主P0重载/provider仍NOT_RUN。

browser_screenshot 是 T1 原始 PNG 采集：保留 base64，返回 capturedAt/sha256/attachmentId；附件服务可用时保存并 render image block，无服务明确 base64-fallback 文本。provider 是否实际显示图像须单独验证，不能由附件 ID 或工具执行成功推定。图片进入模型也不意味着插件具备 T3 分析与可复现的像素阈值证据。

高密度采集只增加DOM/CSS/文字/矢量的输出像素，canvas/WebGL内部位图不增加源细节；C13仅证fixture前后布局无持久变化，不排除瞬时LBI。附件compare='attachment-metadata'、缺字段不推断相同，也不能保证模型收到原始分辨率。

视觉断言需要实际可见图像、明确方法与足够证据；没有能力证明像素差异/定量阈值时 BLOCKED/INCONCLUSIVE，不能以“截图成功”判 PASS。不要编造已保存文件路径，截图可能含敏感内容。

面板 CDP screencast 是事件驱动 JPEG 预览，WS 优先、HTTP 回退，无固定显示 FPS 保证；不提供 Agent 可查询的截图序列或 T3/T4 分析。未来须具备固定基线、真实分析链路、阈值与正负例后才能标 T3 available。
