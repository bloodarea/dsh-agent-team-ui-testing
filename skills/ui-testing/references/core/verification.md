# 验证与证据标准（M0–M2）

执行成功与断言分离：ok/applied/actionId 说明操作，不自动产生 PASS。页面状态由 state/eval 实际值证明；计算样式由 computed_style 证明，不证明遮挡/像素。network 包含响应与 loadingFailed 元数据、脱敏 URL，不证明头/正文或完整接口契约。

每次调用返回并 render actionId/sessionId/startedAt/finishedAt/target/args 摘要。截图保留 base64 与 capturedAt/sha256/attachmentId，可选附件 image block，无服务为 base64-fallback 文本；provider 可见性另验；截图本身不等于 T3 像素结论，也不等于 T4 帧序列（后者须 `browser_dynamic_session` 采集 + `motion_analyze` 判定）。P0增加capture的PNG CRC/尺寸/全量均匀统计/文档JSON mapping、file的pathKind/persistence/root/ephemeral及delivery/warnings；默认暂存绝对路径，插件dispose清理，out/persist:true/非空env才持久且路径相对根；observed只persistence/relativePath|null不含绝对路径；原始base64/磁盘hash相等才证明原图落盘，附件compare='attachment-metadata'缺字段不推断相同。uniform只警告、UP只是尺寸保守拒绝，不自动判产品FAIL。详见 [证据契约](../contracts/evidence.md)。

state/capabilities 不启动、不占租约；capabilities 报实际三态与 workspaceIsolation（page=true、cookie=false），state 从 document.title 刷新标题但 error 可能过期，并带 scope。eval 异常 error 对象包含描述/栈与位置，执行错误 BrowserError 有分类码和证据消息。工作区 scope、同工作区面板操作、关闭/取消造成的状态变化都须在证据时序中记录；跨工作区 Cookie 共享不得写成隔离。

报告记录 platform/objective/expected/observed/tools_used/attempts/assertion_status/evidence/limitations，引用真实 camelCase action/附件字段，不发明文件路径或 evidence_refs。

- PASS：明确验收条件被充分验证。
- FAIL：可靠证据证实不满足条件。
- BLOCKED：权限/环境/能力缺失。
- INCONCLUSIVE：已执行但证据不足。

判定前先过 [verdict-gate.md](verdict-gate.md)：五元组（expected_contract/observation/evidence_ids/counterexamples/verdict）+ 6 项交叉校验；反例词出现即复核；写了 limitation 不得判 PASS。报告字段与同源模板见 [reporting.md](reporting.md)、[report-template.md](report-template.md)；合成正反例见 [verdict-examples.md](verdict-examples.md)。


截图/eval 内容可能敏感，URL 脱敏也非全覆盖；分享前检查。
