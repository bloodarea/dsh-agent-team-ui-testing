# T1 Web 插件验收

套件通过真实插件注册的 8 个 `browser_*` 工具与 HTTP handler，驱动插件自己的无头 Chromium 和仓库 loopback 靶机。进程归属通过 `/proc/<pid>/stat` 的父 PID 精确绑定当前测试 Node，profile 仅从这些进程登记；清理不会把并行运行的其他 DSH/验收 Chromium 算入本次。测试不操作用户 3080/3081 实例。M0–M2 的失败必须影响退出码；旧的缺能力、未脱敏、无隔离、无分类 finding 已改为必需断言。

## 运行

```bash
node tests/acceptance/run.mjs
node --test tests/acceptance/runtime-faults.test.mjs
node tests/acceptance/check-skill.mjs
node tests/acceptance/check-skill-registry.mjs
```

主验收每次生成 `tests/acceptance/runs/<ISO时间>-<pid>/`，包含报告、日志、PNG 和脱敏网络记录。已有 `evidence/` 是历史证据，默认不覆盖。主验收退出码：0 表示所有必需项通过，1 表示断言失败，2 表示套件无法运行。`runtime-faults.test.mjs` 使用 Node 原生测试器，失败退出非零。

Chromium 默认 `/opt/google/chrome/chrome`；显式 `DSH_UI_TESTING_CHROME=/path/to/chrome` 可覆盖。默认探活失败后仅使用本目录 `chrome-wrapper.sh` 增加测试环境 flag，并在报告中保留失败原因。总超时默认 240 秒，可用 `DSH_ACCEPTANCE_TIMEOUT_MS` 覆盖。Skill registry 检查使用已安装 DSH 的真实 Cordis/SkillRegistry，可用 `DSH_ROOT` 覆盖路径；宿主包缺失时会明确 SKIP。

## 测试职责

| 文件 | 内容 |
| --- | --- |
| [harness.mjs](harness.mjs) | 加载真实 `apply(ctx)`，捕获注册工具、HTTP/WS 路由；透传 `exec.agent.id`/`exec.signal`，收集错误分类与 render content；模拟 optional attachments 与 `agent/disposed` 事件。 |
| [run.mjs](run.mjs) | P1–P13 主浏览器与帧管线回归，并集成 M0–M2、P20 与 P21 探针。 |
| [milestone-probes.mjs](milestone-probes.mjs) | P14–P19 能力发现、lease、证据 envelope、截图附件/回退、取消/面板同锁、启动失败与目标策略。 |
| [input-modifiers.mjs](input-modifiers.mjs) | P20 `browser_input` 功能键与修饰键：Tab/Shift+Tab 焦点、Ctrl+A 标志、`virtualKeyCode`→`e.keyCode`、位掩码/`autoRepeat`/mouse/wheel、老式最小调用、非法参数拒绝；真值为页面内捕获的 DOM 事件（经 `browser_eval` 读回）。 |
| [host-contract.mjs](host-contract.mjs) | P21 宿主输出契约：按 `DSH_ROOT` 从 DSH 安装目录解析真实 `@deepseek-ai/dsh-util-values`，用 `snapshotJsonValue`/`isJsonValue` 断言 8 工具返回值与 render content 为 lossless JSON（含 eval `undefined`/抛错、数字参数 args、无附件截图、失败网络条目、类实例附件的投影）。解析不到真实包时退回内联等价校验器并记 finding，不静默冒充。 |
| [runtime-faults.test.mjs](runtime-faults.test.mjs) | CDP 故障注入和 Runtime 边界；使用 fake WebSocket、受控时钟与 fake CDP，避免等待真实 30 秒超时。 |
| [check-skill.mjs](check-skill.mjs) | 8 工具与 Skill、台账、manifest 一致性；错误、lease、截图回退契约。 |
| [check-skill-registry.mjs](check-skill-registry.mjs) | 真实 Cordis 注册、加载、resourceBase、render 和 dispose。 |
| [real-browser-ws.mjs](real-browser-ws.mjs) | 可选隔离 DSH 的真实 GUI 帧管线回归。 |

## 主验收探针

| ID | 必需行为 |
| --- | --- |
| P1 | 恰好 8 工具、schema、HTTP 路由、owner 诊断、未启动时 capability 可用。 |
| P2 | loopback 导航成功；state URL/title 与页面一致；SPA 改标题可读；file 拒绝、不可达 `NAV_FAILED`、失败恢复。 |
| P3 | 按值 JS/Promise/undefined；页面异常返回 `EVAL_ERROR` 对象及消息、stack、details。 |
| P4 | CSS 精确值、全集；缺失元素返回 `TARGET_NOT_FOUND` 操作失败。 |
| P5 | 原生点击的 counter 副作用、文本输入与提交结果。 |
| P6 | 完成/失败网络元数据；token 脱敏与 redacted 标记；state 不泄露 token。 |
| P7 | 保留 PNG base64；魔数、bytes、IHDR 尺寸；本次运行目录截图落盘。 |
| P8 | close 等待进程退出、删除 profile、清空状态/网络/帧；幂等 close、全新 profile 重启。 |
| P9 | 独立 apply 实例进程隔离；单 runtime 其他会话无法读 owner 页面。 |
| P10 | throw/操作失败/HTTP 均有 code/category/retryable；HTTP error 保持字符串；BrowserError 消息有 `[CODE]` 与 action 证据。 |
| P11–P13 | WS hello/二进制帧、epoch/seq、鉴权/loopback、metrics、轮询回退、close 清理。 |
| P14 | capability 实际服务探测、8 工具声明、T2–T4 unsupported；可跨会话诊断。 |
| P15 | 两会话仅一个拿 lease；6 个页面/网络工具拒绝其他 owner；diagnostic 不夺租约；disposed 匹配释放；未知 exec 共享 anonymous。 |
| P16 | 8 工具成功返回和 durable 文本均有 actionId/sessionId/startedAt/finishedAt/target/args；actionId 唯一；截图 hash/time/attachmentId；有服务 render image attachment、无服务明确 base64-fallback 并保留图片。 |
| P17 | signal 取消 1 秒内 `ABORTED`；返回前关闭旧浏览器、释放 owner；后续懒启动；长 eval 与面板输入/后续工具不交错。HTTP body 异步解析不规定其与工具的先后入队顺序。 |
| P18 | `/bin/false` 注入启动失败；明确 BrowserError，无新增 profile 残留。 |
| P19 | 工具及 HTTP 阻断 scheme/metadata/RFC1918/credentials/DSH 自身；合法 loopback 重定向成功，metadata 重定向失败；HTTP 200 后截断更新 failed/errorText 且不重复条目；window.open 的 secondary target 向被阻断 origin 发出 Document 请求计数为 0，原页仍可导航。 |
| P20 | Tab 焦点前进（#inc→#name）、Shift+Tab 焦点回退；Ctrl+A 的 keydown `ctrlKey=true`/`key='a'`；`virtualKeyCode` 决定 `e.keyCode`（Tab=9/A=65）；整数位掩码 10 等价 ctrl+shift；`autoRepeat`→`e.repeat`；`location`/`isKeypad`（数字键盘 `e.location=3`、左 Shift `e.location=1`）；mouse/wheel 修饰键生效且点击副作用保持；老式最小 key/mouse 调用仍工作；非法修饰键名/类型/越界掩码/非法 `key.type`/非法 `pointerType` 抛 `INVALID_ARGUMENT` 且不向页面派发事件；schema 声明全部新字段。 |
| P21 | 真实宿主校验器（`@deepseek-ai/dsh-util-values`，版本随安装走）对 8 工具成功值 + render content 断言 lossless JSON；`browser_eval` 页面值 undefined、页面抛错（EVAL_ERROR 值）、`browser_network` 数字参数 args、无附件服务截图、loadingFailed 网络条目、工具抛错 details、附件类实例投影均可快照且无 `undefined` 属性；校验器解析失败时用内联等价实现并记 finding。 |

## 故障注入覆盖

- CDP resolve、协议错误、abort、timeout、disconnect、同步发送失败都清空 pending、清除 timer 和 abort listener。
- 已关闭或预取消命令不派发；同步发送失败会关闭 CDP。
- 真实 Chromium 的 CDP 断开后，ensure 先回收旧进程/profile，再启动新实例并恢复 owner。
- lease 在 15 秒 idle 后可转交；操作进行中越过 expiry 不失效，完成后重新计算 idle 窗口。
- 排队中取消不执行其 action，也不提前解锁正在进行的操作。
- 派发后的取消/超时完成关闭后，才允许下一队列操作；无响应 stopScreencast 的清理受 200ms 超时约束。
- owner A1 取消清 lease 后，已排队 A2 的 reservation 仍拒绝 B；A2 执行前重新 claim，完成后可正常 release。
- CDP navigation errorText、最终目标被禁时回到 about:blank。
- literal IPv4/IPv6、DNS localhost、域名解析失败、private 显式 opt-in 与 metadata 恒拒绝。

## 实测范围

Host 截图的 attachment image block 和 base64 fallback 都有断言；真实 provider 是否把图片交给视觉模型仍需宿主会话验证。测试不宣称覆盖 provider 视觉效果、所有子资源网络沙箱、DNS rebinding、宿主/操作系统级按键语义（如 macOS 专有快捷键、IME 组字）、T2–T4 或冻结面板视觉；P20 只断言 Chromium 渲染器实际产生的 DOM 事件与焦点变化。目标策略的 DNS 检查使用真实解析，Chromium Document 重定向使用真实本地 HTTP server；最终目标校验另以 fake CDP 注入验证。宿主侧 `snapshotToolValue` → `snapshotJsonValue` 的值快照由 P21 用真实校验器覆盖；但 fake Cordis ctx 仍不等同完整宿主会话（`tools/result` 物化、provider 呈现、会话持久化不在本套件内）。
