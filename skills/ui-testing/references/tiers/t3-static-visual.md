# T3 · 静态视觉理解（未实现）

本插件没有 Sharp/Pixelmatch/基线阈值、局部裁剪放大、坐标标注或 VLM 分析管线；T3 仍 unsupported。

browser_screenshot 是 T1 原始 PNG 采集：保留 base64，返回 capturedAt/sha256/attachmentId；附件服务可用时保存并 render image block，无服务明确 base64-fallback 文本。provider 是否实际显示图像须单独验证，不能由附件 ID 或工具执行成功推定。图片进入模型也不意味着插件具备 T3 分析与可复现的像素阈值证据。

视觉断言需要实际可见图像、明确方法与足够证据；没有能力证明像素差异/定量阈值时 BLOCKED/INCONCLUSIVE，不能以“截图成功”判 PASS。不要编造已保存文件路径，截图可能含敏感内容。

面板 CDP screencast 是事件驱动 JPEG 预览，WS 优先、HTTP 回退，无固定显示 FPS 保证；不提供 Agent 可查询的截图序列或 T3/T4 分析。未来须具备固定基线、真实分析链路、阈值与正负例后才能标 T3 available。
