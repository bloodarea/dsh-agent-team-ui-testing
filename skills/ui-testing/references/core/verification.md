# 验证与证据标准（M0–M2）

执行成功与断言分离：ok/applied/actionId 说明操作，不自动产生 PASS。页面状态由 state/eval 实际值证明；计算样式由 computed_style 证明，不证明遮挡/像素。network 包含响应与 loadingFailed 元数据、脱敏 URL，不证明头/正文或完整接口契约。

每次调用返回并 render actionId/sessionId/startedAt/finishedAt/target/args 摘要。截图保留 base64 与 capturedAt/sha256/attachmentId，可选附件 image block，无服务为 base64-fallback 文本；provider 可见性另验，不意味着 T3 分析或 T4 帧序列已实现。详见 [证据契约](../contracts/evidence.md)。

state/capabilities 不启动、不占租约；capabilities 报实际三态，state 从 document.title 刷新标题但 error 可能过期。eval 异常 error 对象包含描述/栈与位置，执行错误 BrowserError 有分类码和证据消息。匿名 scope/共享页、面板操作以及关闭/取消造成的状态变化都须在证据时序中记录。

报告记录 platform/objective/expected/observed/tools_used/attempts/assertion_status/evidence/limitations，引用真实 camelCase action/附件字段，不发明文件路径或 evidence_refs。

- PASS：明确验收条件被充分验证。
- FAIL：可靠证据证实不满足条件。
- BLOCKED：权限/环境/能力缺失。
- INCONCLUSIVE：已执行但证据不足。
- NOT_RUN：未执行。

本轮新增契约尚未实测的条目保持 NOT_RUN/implemented-not-verified，旧版通过不证明新行为通过。截图/eval 内容可能敏感，URL 脱敏也非全覆盖；分享前检查。
