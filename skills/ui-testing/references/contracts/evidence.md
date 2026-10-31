# 证据契约（M0–M2）

每次工具调用返回并 render `actionId/sessionId/startedAt/finishedAt/target/args` 摘要，关联业务结果；失败 BrowserError 的 `[CODE]` message 含该次证据。不能只留在 execute value：只有 render 内容可进入 durable transcript。实际字段与附件必须来自本轮工具，不伪造路径/ID。

| 证据 | 能说明什么 | 限制 |
| --- | --- | --- |
| state/capabilities | 页面/owner 与实际可用性诊断 | 不启动；不证明业务正确或加载完成 |
| eval | 顶层页面可序列化 JS 值、异常描述/栈 | 无 frame 选择，不冒充 UI/网络/像素证据 |
| computed_style | 首个匹配元素计算样式 | 无伪元素/iframe/Shadow DOM 定位，不证明画面无遮挡 |
| network | URL 脱敏后的响应与 loadingFailed 元数据 | 有界、跨导航可能累积，close 清空；无头/正文，不保证全部业务敏感字段已消除 |
| screenshot | PNG base64、capturedAt、sha256、attachmentId | 不提供 T3 差异/裁剪/VLM 或 T4 序列 |

截图保留 image base64；可用时 `ctx.attachments.saveImage` 保存附件并 render image block。缺少附件服务明确 render base64-fallback 文本。附件 ID 不是文件路径，保存成功不等于 provider 已显示图像；真实可见性需在视觉 provider 会话实测。不能宣称已落本地证据文件，除非有实际返回/授权保存证据。截图与 eval 内容不自动脱敏，image block 可能进入 provider 上下文。

没有独立 JSONL 证据包、自动 assertion_status、帧序列或像素分析。`/metrics` 是预览管线诊断，不能替代页面断言。close 清空网络/URL/标题/帧缓存；引用记录仍要核对本轮 action 时序。

报告独立记录 expected/observed、tools_used、真实 action/附件引用、限制与 PASS/FAIL/BLOCKED/INCONCLUSIVE/NOT_RUN。原始截图可见也不把 T3/T4 升为已实现；证据不足时 INCONCLUSIVE，未执行 NOT_RUN。
