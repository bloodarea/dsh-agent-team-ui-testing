# Web T1/T2 执行工作流

1. 明确目标与断言，按页面状态、元素语义/交互（T2）、计算样式、网络（P0）、静态视觉（T3）、动态/时序（T4）区分证据需求；跨层组合见 `references/scenarios/functional.md`。
2. 确认授权 URL 与动作、网络/截图读取范围。
3. 先确认注册表，再调用 browser_capabilities/state 诊断；不启动浏览器、不占租约，不把 manifest 当 available；能力报告自身报错时按证据不足处理。
4. 按 selection.md 选方法；页面操作先按 exec 身份解析到 DSH 工作区，再申请该工作区的 single-owner-lease。同工作区其他 owner BUSY 时不得绕过；不同工作区互不影响。缺 exec 身份走 legacy。
5. **需要元素语义/元素级交互时先 `browser_snapshot` 拿 ref**，再 click/type/scroll/fill_form；目标用 `ref` 或主文档唯一 `selector`，无快照不猜坐标。
6. 用结构化工具执行；导航不保证加载完成，副作用动作记录前置状态。
7. 用 `browser_node_state`/`browser_wait_for` 读回 T2 动作结果，用 state/eval/style/network 补充观察，必要时截图；保留真实 action 时间/target/参数摘要、T2 evidence（snapshotId/digest/targets/dispatch）、错误与附件/hash。截图可选scale/文档region/persist/out：默认插件暂存且dispose清理；仅out/persist:true/非空env持久。按采集前scroll转换视口坐标，保留capture的PNG尺寸/CRC/sizeCheck/mapping/file的path/pathKind/persistence/root/ephemeral/hash/warnings（暂存绝对路径不视为持久引用）。capabilities.capture.observed只代表上次截图；同路径不覆盖，OUTPUT_EXISTS换out。provider图像可见性、metadata未知与fallback如实记录。
8. 独立断言，ok/applied/dispatched 不等于 PASS；单帧 PNG 本身不产生 T3/T4 结论，必须走 `vision_compare`/`vision_check` 或 `motion_analyze`。
9. 错误按 code/category/retryable 分类；`REF_STALE` 重新快照、`WAIT_TIMEOUT` 不改小预算掩盖、`NOT_INTERACTABLE` 是 finding 不是换目标理由。取消/超时/断连后先查应用状态。已发 CDP 命令后 abort 先关闭浏览器再放锁，不能假设回滚。
10. 报告 expected/observed、工具与 action 证据、PASS/FAIL/BLOCKED/INCONCLUSIVE/NOT_RUN、限制与未验证部分。

面板与 Agent 在同一工作区的同队列内改变该工作区 page；不同工作区 page 独立、ref 表独立，但 Cookie/存储共享。操作前后复查。真实缺陷确认后停止找 PASS，能力不足如实报告。详细契约见 ../contracts/operation.md 与 ../contracts/evidence.md。
