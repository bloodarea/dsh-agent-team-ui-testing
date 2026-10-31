# Web T1 · 能力与验收台账

> 开发事实记录，不是运行时可用性声明。先确认当前 Agent 注册表，再读 browser_capabilities 实际 available/unavailable/unsupported。静态 implemented-not-verified/partial/verified 不可直接当作 available。
> 2026-10-31 M0–M2 + N2 + 宿主输出契约：主运行时验收 **21/21 组、196/196 必需项通过，0 finding/skip、exit=0**（P1–P21）；结构检查 23/23、registry 17/17、exit=0。3081 HTTP 集成已扩到 14 项（新增 N2 的 /input+/eval 检查），需重启 3081 后由 Lead 复跑；真实 Agent screenshot/provider视图NOT_RUN。仓库开发记录在 docs/t1-m0-m2-contract.md；发布后仓库 docs 不一定随 skill 可读，随包契约和工具实际结果优先。

## 现行能力

| ID | 工具 | 工程状态 | 契约与验收边界 |
| --- | --- | --- | --- |
| web.t1.navigate | browser_navigate | verified（报告覆盖路径） | P2/P19 正负例：errorText/NAV_FAILED、loopback、策略与 Document 重定向；不保证加载完成 |
| web.t1.runtime-evaluate | browser_eval | verified（报告覆盖路径） | P3：主世界可序列化值、Promise、undefined、EVAL_ERROR 描述/栈/details；无 frame 选择 |
| web.t1.input | browser_input | partial | P5/P17/P20：点击/text 副作用、面板同锁；N2 已加 modifiers（数组或 CDP 位掩码）、key 的 virtualKeyCode/autoRepeat/unmodifiedText/commands/location/isKeypad、mouse 的 buttons/pointerType，P20 用页面 keydown/activeElement 真值断言 Tab/Shift+Tab 与 Ctrl+A；applied 仍是数量，无焦点管理工具与 M3 高层动作 |
| web.t1.network-observe | browser_network | partial | P6/P15：响应与 loadingFailed、URL 脱敏、其他 owner BUSY、不启动；无头/正文；Map/timer 细节专项待最终汇总 |
| web.t1.cssom | browser_computed_style | verified（报告覆盖路径） | P4：首匹配 5 属性、完整样式、TARGET_NOT_FOUND error 对象；无伪元素/iframe/Shadow DOM 目标 |
| web.t1.screenshot | browser_screenshot | partial | P7/P16：PNG/base64/hash/时间、无服务 fallback、fake saveImage+image block；真实 provider 实际可见性另验 |
| web.t1.runtime-state | browser_state | verified（报告覆盖路径） | P1/P2/P15：诊断不夺 owner、document.title/SPA 刷新、连接与关闭状态；error 可过期 |
| web.t1.capability-discovery | browser_capabilities | partial | P1/P14/P15：第8工具、不启动/不占租约、三态枚举与 unsupported；主报告后新增 BUSY unavailable 细化待最终汇总 |
| web.t1.http-request | 无 | unsupported | 无独立 HTTP 客户端，页面 fetch 不可替代 |
| web.t1.viewport-control | 无 | unsupported | Agent 无视口工具；默认 1280×800/DPR1，面板 200–4096 |
| web.t1.browser-extras | 无 | unsupported | 无下载/上传/Cookie 导出/多标签/frame 选择 |

## 所有权、错误与证据

single-owner-lease 共享一个 Chromium/page/Cookie，非会话隔离；exec.agent.id 标识 owner，缺身份共用 anonymous；15s idle，进行中保持，disposed 释放。页面与 network 受租约，其他 session BUSY；state/capabilities 可诊断。面板同页、同串行队列；CDP 已发出后 abort 在队列内关闭浏览器才放锁，后续可懒启动，不回滚网页副作用。

所有工具返回并 render actionId/sessionId/startedAt/finishedAt/target/args 摘要。返回值在 Host 侧统一做 lossless JSON 投影后才交给宿主：`undefined` 属性缺省（`browser_eval` 的 undefined 结果没有 `value` 字段）、非有限数字转 `null`、`attachment` 投影为 `{attachmentId,mediaType,bytes,width,height,name}`；否则宿主 `snapshotJsonValue` 会以 `INVALID_TOOL_OUTPUT: value is not lossless JSON` 拒绝整次调用。工具失败 BrowserError 带 code/category/retryable/details 与 [CODE] 证据消息；eval/style 操作失败返回 error 对象；HTTP 保留 error 字符串并加分类字段。核心码见 [操作契约](../../references/contracts/operation.md)。

目标允许 loopback；默认阻断 RFC1918（DSH_UI_TESTING_ALLOW_PRIVATE=1 可开放）、metadata/unspecified/multicast/credentials/已配置 DSH_WEB_URL origin。Document 拦截与 DNS 校验仍不构成子资源/页面 fetch/WebSocket 的完整网络沙箱，存在 rebinding/时序风险。URL 脱敏不覆盖所有业务敏感内容。

## 历史证据（仅供追溯）

M0–M2 前历史套件最初 P1–P10 为 10 组/61 项，随后帧管线扩为 P1–P13、13 组/92 项；两次均有 P2 标题恒空与不可达导航静默成功两处失败，exit=1。旧 check-skill 为 19/19、check-skill-registry 为 17/17；旧截图 PNG/viewport 正常但 render 未显示图像；旧网络 token 未脱敏。详见仓库 docs/t1-infrastructure-audit.md 与 tests/acceptance/evidence/ 的历史记录。

这些计数与 F1–F9 是历史快照。旧主验收 19/19 组、149/149 项（报告 `tests/acceptance/runs/2026-10-31T04-59-24-426Z-79195/run-report.json`）已被新套件取代：`node tests/acceptance/run.mjs`，generatedAt `2026-10-31T09:11:49.006Z`，报告在仓库 `tests/acceptance/runs/2026-10-31T09-11-49-006Z-151626/run-report.json`，21/21 组、196/196 必需项、0 failed/skip/finding、exit=0（新增 P20 输入修饰键/功能键、P21 宿主 lossless JSON 契约）。环境 Node v22.23.3/Linux，真实 Chromium + sandbox-fallback wrapper、fake Cordis ctx。P17 证明 1s 内 ABORTED、关闭旧浏览器后返回、重新懒启动及面板队列；P18 启动失败无 profile 遗留；Lead 汇报 cleanup leftoverProfile/PID=0。结构检查 check-skill 23/23、exit=0。主 3080 不动，真实宿主本轮用 3081 隔离实例；不得把 fake 附件保存/render 通过等同 provider 图像可见。

## 未验证与未实现

3081 HTTP 集成已11/11通过；真实 Agent screenshot/provider视图仍NOT_RUN；主报告后追加的 capability BUSY unavailable 细化、15s 到期/进行中续持、Map/timer/close 上限专项单测待 Lead 最终汇总。主验收只覆盖列出的路径，默认非沙箱 Chromium 与未覆盖输入组合不能据此推定通过。

T2/T3/T4、独立 HTTP 客户端、多 target/会话隔离、M3 高层输入、完整网络沙箱、独立 JSONL 证据包仍未实现。面板 WS/HTTP 预览与 metrics 不构成 T3/T4 证据。

## 变更日志

- 2026-10-31：保留旧 T1 与帧管线验收为历史来源；M0–M2 按 Lead 契约同步为待验收，避免沿用旧 verified 或旧失败作为当前结论。
