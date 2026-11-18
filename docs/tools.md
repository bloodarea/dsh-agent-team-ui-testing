# 工具准入与参考索引

Host 根据已启用环境决定工具注册范围，并按当前会话的配置和能力检查执行准入。工具名称、参数、返回和错误由目标环境的实现定义。配置与诊断入口见[环境设置](settings.md)。

`browser_state` 与 `browser_capabilities` 是当前常驻的诊断入口，可在目标环境禁用时查询配置与支持状态，调用不会启动目标。能力分类和证据要求见[能力分层](capability-tiers.md)。

## 目标环境工具

- [Web 工具参考](web/tools.md)
