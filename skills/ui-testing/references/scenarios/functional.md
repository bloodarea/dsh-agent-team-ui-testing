# 功能测试场景（当前实现）

## 典型目标

导航、表单输入、点击/滚动、页面状态变化、已完成网络请求观察、计算样式读取。

## 断言层次（只到 T1）

- **页面状态**：`browser_state` 的 url/title/viewport/running，或 `browser_eval` 读取的页面 JS 值。
- **交互副作用**：`browser_input` 派发事件后，必须另行观察状态；`applied` 只是事件数量。
- **网络行为**：`browser_network` 给响应与 loadingFailed 失败元数据、脱敏 URL，无头/正文，不能证明完整接口契约；其他 owner 返回 BUSY。
- **样式**：`browser_computed_style` 只给计算样式，不等于视觉正确。
- **结构化元素语义（T2）/ 静态视觉（T3）/ 动态视觉（T4）**：未实现；相关断言只能 `BLOCKED` / `INCONCLUSIVE`。

## 结果要求

按步骤分别记录“执行成功”“状态符合预期”“样式符合预期”“视觉未验证”“动态未验证”。不能把某个 T1 断言通过写成整个功能或整个 GUI 通过。

## 常见限制

- 导航不等待加载；跳转后立即断言容易得到旧值。
- 页面只有一个，人类与 Agent 共用；single-owner-lease 非隔离，面板与 Agent 同队列仍能先后改变页面，需核对 action 时序与前后状态。
- 没有多标签页/iframe 目标选择；SSO 弹窗、跨窗口流程不可执行。
- 没有下载/上传/Cookie 能力；涉及文件或登录态导出的场景直接 `BLOCKED`。
