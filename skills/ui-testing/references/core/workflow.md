# Web T1 执行工作流

1. 明确目标与断言，按页面状态、计算样式、网络、截图或尚未实现的 T2/T3/T4 区分证据需求。
2. 确认授权 URL 与动作、网络/截图读取范围。
3. 先确认注册表，再调用 browser_capabilities/state 诊断；不启动浏览器、不占租约，不把 manifest 当 available。
4. 按 selection.md 选方法；single-owner-lease 非隔离，缺 exec 身份共享 anonymous。其他 owner 的页面/network BUSY 时不得绕过。
5. 用结构化工具执行；导航不保证加载完成，副作用动作记录前置状态。
6. 观察 state/eval/style/network，必要时截图；保留真实 action 时间/target/参数摘要、错误与附件/hash。provider 图像可见性与 fallback 如实记录。
7. 独立断言，ok/applied 不等于 PASS，单帧 PNG 不等于 T3/T4 分析。
8. 错误按 code/category/retryable 分类；取消/超时/断连后先查应用状态。已发 CDP 命令后 abort 先关闭浏览器再放锁，不能假设回滚。
9. 报告 expected/observed、工具与 action 证据、PASS/FAIL/BLOCKED/INCONCLUSIVE/NOT_RUN、限制与未验证部分。

面板仍会在同队列内改变共享页面，操作前后复查。真实缺陷确认后停止找 PASS，能力不足如实报告。详细契约见 ../contracts/operation.md 与 ../contracts/evidence.md。
