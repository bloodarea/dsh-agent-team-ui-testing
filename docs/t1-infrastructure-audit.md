# T1 Web 基础设施历史审计（对照 7 条清单）

> **历史快照，不作为当前实现或运行实例状态。** 下文保留 M0–M2 前的探针结论、计数和缺口，供追溯；包括“7 工具”“无租约/分类/证据”“3080 未加载”等说法。现行契约见 [t1-m0-m2-contract.md](t1-m0-m2-contract.md)。**现行计数已推进到 21 组 / 196 项必需检查（含本轮 P20 输入事件、P21 宿主返回契约），3081 重启后 verify-3081 14/14**；文中 13 组/92 项与 19 组/154 项均为历史快照，不改写。相应历史缺陷已被新实测取代。真实 Agent screenshot/provider 视图仍 NOT_RUN。3080 不重启，隔离宿主验收使用 3081。

> 索引：[docs/index.md](index.md) · 审计日期：2026-10-31 · 审计对象：`index.js`（Host 运行时）+ `skills/ui-testing/`（内置 Skill）
>
> **2026-10-31 帧管线调整后更新**：新增同源 WebSocket 推帧（轮询回退）、`frame-source.js`/`frame-push.js` 拆分、`/metrics` 实测指标与资源清理修复；第 7 条结论随之上调，第 5 条“同源鉴权”表述已修正。原审计证据仍保留在同一 `evidence/` 目录。

## 结论摘要

| # | 基础设施 | 结论 | 实现方式 / 关键证据 |
|---|---|---|---|
| 1 | 统一工具接口 | **满足**（T1 范围内） | 7 个结构化 `browser_*` 工具，JSON Schema，无原始 CDP 命令工具；由内置 Skill 的「统一工具接口」章节约束用法。验收 P1 8/8 |
| 2 | 能力发现 | **部分满足** | 内置 Skill 定义“运行时权威 = Agent 当前工具注册表”，`browser_state` 只探测运行态；**Runtime 没有独立 capability API**（finding F1）。服务级注册/加载 17/17 |
| 3 | 会话隔离 | **不满足** | 单插件实例只有一个 Chromium / 一个 page；所有 Agent、任务、面板共享 url/viewport/network/activity；无 session/lease/agent id。见 P9 |
| 4 | 错误分类 | **不满足** | 失败只有裸 `Error` 或 `{ok:false,error:"字符串"}`；无 timeout / 断连 / 能力缺失 / 动作失败 / 应用缺陷分类。见 P10、F9 |
| 5 | 操作安全 | **部分满足** | 有同源路由（默认仅 loopback、无登录鉴权；WS 升级经 connection 鉴权）、仅 http/https、请求体上限、独立 profile、无 Cookie 导出；缺 per-Agent 权限、危险动作限制、取消、脱敏、服务端目标范围限制。见 F5 等 |
| 6 | 证据记录 | **不满足** | 无 evidence id / 落盘 / 目标-参数-结果-错误关联；截图 `image` 不进模型上下文；`/metrics` 只有面板预览指标、不能作为页面证据。见 P7、F5 |
| 7 | 资源管理 | **满足**（小项待清） | 正常关闭 P8 9/9；帧管线调整后补齐：screencast 停止、CDP listener dispose、网络/帧/运行态清空、进程等待 + SIGKILL 兜底、profile 同步删除、启动失败路径清理、WS 客户端关闭。剩余 `Cdp.send` 定时器未 clear |

一句话：**T1 的“能操作”已经成立（第 1 条满足、第 2 条部分），帧管线的“可回收”在调整后已补齐；但“可隔离、可诊断、可取证”仍是主要缺口**。验收套件 `tests/acceptance/run.mjs` 仍以退出码 1 结束，原因是 P2 的两个真实缺陷（title 恒为空、不可达地址静默成功），不是测试脚本问题。

**判定口径说明**：本表按清单原文（Agent/任务/标签页隔离、每次操作留证、资源正确释放）从严判定。`tests/acceptance/evidence/checklist-matrix.md` 的自动矩阵对第 3、6 条给出“部分”的较宽松口径（它只计本轮探针覆盖到的路径）；差异只影响结论措辞，缺口清单一致。详见每条的“与矩阵口径差异”。

## 审计方法与环境

- 自建授权靶机：`tests/ui_test_fixture/`（仅 127.0.0.1、零依赖、断言值固定）。
- 真实验收：`tests/acceptance/run.mjs` 用 fake ctx 调用 `index.js` 的 `apply(ctx)`，直接执行注册到的工具与 HTTP handler，驱动真实无头 Chromium；13 组探针（P1–P13，含帧推送/鉴权/回退与指标）、92 项必需检查。
- Skill 结构：`tests/acceptance/check-skill.mjs`；真实 DSH 服务注册：`tests/acceptance/check-skill-registry.mjs`（真实 `Context` + `SkillRegistry` + `ctx.plugin(index.js)`）。
- 环境：Node v22.23.3 / Linux x64 / Chromium `/opt/google/chrome/chrome`。委派 shell 处于 DSH 文件沙箱内，默认 Chrome 无法启动（setuid sandbox、`/dev/shm`、crashpad 被拒），套件自动回退 `tests/acceptance/chrome-wrapper.sh`（同一真实二进制 + `--no-sandbox --disable-dev-shm-usage --disable-crash-reporter`），已在 `run-report.json.environment.chromePlan` 如实记录。

## 逐条审计

### 1. 统一工具接口 — 满足（由内置 Skill 实现）

要求：Agent 调用结构化工具，不能被迫直接拼 CDP 命令。

证据：

- `index.js:537–660` 注册且仅注册 7 个工具：`browser_navigate{url}`、`browser_eval{expression}`、`browser_screenshot{}`、`browser_input{events[]}`、`browser_network{limit}`、`browser_computed_style{selector,properties[]}`、`browser_state{}`；参数是 JSON Schema，不是命令字符串。
- 不存在任何“执行 CDP 方法”的 Agent 工具；Agent 侧也拿不到 `Cdp` 实例。
- `skills/ui-testing/SKILL.md` 的「统一工具接口」表列出 7 个工具的参数/返回/失败形态，并在「操作纪律」明确禁止自己拼 CDP / 调 Playwright / 走面板 HTTP 路由。
- 验收 P1：工具名、schema、`execute`、description 与文档一致，8/8 通过；findings 无“缺失结构化工具”。

边界与保留意见：

- `browser_input` 的事件形状仍暴露 CDP 词汇（`mousePressed`/`mouseReleased`/`buttons`/`clickCount`，`kind` + `type` 两段式），没有 `click(x,y)` / `type(selector,text)` 这类高层封装。Agent 是在“填事件对象”，不是“拼 CDP 命令”，但对初学者仍不友好。
- 缺的能力（T2/T3/T4、独立 HTTP 客户端、视口控制）是**明示缺失**（Skill 与 manifest 标 `unsupported`），没有给出“必须手写 CDP 才能做”的通道。因此该条按“T1 范围内满足”判定。

### 2. 能力发现 — 部分满足（由内置 Skill 实现 + 缺 Runtime API）

要求：Runtime 能告诉 Agent 当前有哪些可用功能。

已实现的部分（Skill 侧）：

- `SKILL.md`「能力发现：以当前工具注册表为唯一权威」：只认 Agent 当前会话实际拿到的工具；台账/manifest 是开发事实，不得当作运行时能力；unknown 时先探测、再按 `INCONCLUSIVE`/`BLOCKED` 报告；缺失能力不得伪造工具名。
- `skills/ui-testing/knowledge/web/t1-capability-ledger.md`：10 项能力逐项记录状态（`verified` / `implemented-not-verified` / `partial` / `unsupported`）、工具、代码位置、实测证据与限制。
- `skills/ui-testing/manifests/declared-capabilities.json`：静态快照，`notice` 明确“工具注册表才是运行时权威”。
- 验收：`check-skill-registry.mjs` 17/17（`ctx.skills.list()` 含 `ui-testing`、`modelInvocable=true`，`get()` 返回正文与 `resourceBase`，`renderSkillContent()` 输出 `<skill_content>…</skill_content>`，dispose 后消失）；`check-skill.mjs` 19/19（frontmatter、引用文件、工具名与 `index.js` 一致）。

缺口：

- **没有独立的能力发现接口**（F1）：`browser_state` 只返回 `mode/activity/url/title/viewport/seq/running/error`，没有“支持哪些操作/权限/限制”的结构化清单；Agent 无法程序化区分 `available / unavailable / unsupported / unknown`，只能靠工具是否出现在注册表 + 试调用来推断。
- **运行态字段本身有缺陷**：`title` 恒为空（F2，`index.js:231–235`），Agent 不能靠 `browser_state` 确认当前页面标题；`error` 只有最后一次错误的单值且可能过期。
- 当前运行中的 3080 实例尚未重启加载本插件（见“生效状态”），所以本会话的 Agent 实际看不到这 7 个工具与 Skill；能力发现只在服务级/隔离实例被证明。

建议：后续给 `browser_state` 增加 `capabilities`（或新增 `browser_capabilities` 工具），返回每项能力的 `status/constraints`；这属于对外接口变更，需用户明确要求。

### 3. 会话隔离 — 不满足

要求：不同 Agent、任务、标签页不会错误共享状态。

证据（P9 / F8）：

- `apply()`（`index.js:435`）每次插件挂载只建 **一个** `Runtime`；`Runtime` 内部只有一个 `cdp`、一个 page target、一份 `url/title/viewport/network/activity`（`index.js:115–133`）。同一插件实例内所有 Agent 调用共享这些状态。
- 探针实测：单实例内第二次调用沿用同一浏览器与 url，`network` 缓冲跨导航累积；两个独立 `apply()` 实例才各自拥有独立进程/profile、状态互不影响。
- 没有 session id / agent id / tab id / lease/ownership；`mode`（agent/human/idle）只是 15s/4s 的时间窗展示，不构成互斥，也不阻止并发写入（`index.js:136–141`、`272–280`）。
- 无多标签页能力；`close()` 也不清空 `url/title/network/requests`（`index.js:381–395`），关闭-重启后旧状态会继续被读到。
- 用户面板与 Agent 共享同一页面；两个面板实例各有本地 UI 状态，但都指向同一个 Host runtime，地址/视口可能互相覆盖。

结论：只有“插件实例级隔离”（不同 profile/不同 `apply`），没有“Agent/任务/标签页级隔离”。

**与矩阵口径差异**：`checklist-matrix.md` 因“两个独立 apply 实例互不影响”判“部分”；清单原文要求的是 Agent/任务/标签页之间不错误共享，当前实现连 agent/tab 标识都没有，故本审计判 **不满足**。

### 4. 错误分类 — 不满足

要求：区分超时、断连、能力缺失、操作失败、应用缺陷。

证据（P10 / F9，另 F3、F4）：

- CDP 层：`Cdp.send` 30s 超时抛 `Error('cdp timeout: ' + method)`（`index.js:89–102`）；断连抛 `Error('cdp closed')`（`index.js:68–72`、90）。
- 工具层：`browser_navigate` 的非法协议直接 `throw new Error('只支持 http/https 地址')`（`548`）；CDP 报错原样冒泡；`browser_eval` 页面异常返回 `{ok:false,error}` 且 `error` 只取 `exceptionDetails.text`（实测为 `"Uncaught"`，F4）；`computed_style` 找不到元素返回 `{ok:false,error:'未找到元素：…'}`（`366`）。
- HTTP 层：统一 `500 {ok:false,error}`（`526–529`），另有 404/405；同样只有字符串。
- 实测所有错误载荷都没有 `code/category/retryable` 等机器可判别字段（P10 5/5），错误文本也不含分类词。
- **静默失败**：不可达地址 `Page.navigate` 返回的 `errorText` 未检查，工具仍返回 `{ok:true,url}`，页面实际停在 `chrome-error://chromewebdata/`（F3，`index.js:295–299`）。

结论：调用方无法区分“超时 / 断连 / 能力缺失 / 动作失败 / 应用缺陷 / 静默失败”。

### 5. 操作安全 — 部分满足

已有的基础：

- 面板 HTTP 路由挂在宿主 `webServer` 上，默认只监听 loopback，但**路由层没有登录鉴权**（实测：不带 token 直接 `curl /plugins/ui-testing/state` 也返回 200）；WebSocket 升级才经 `ctx.get('connection').requestRejection(req)` 鉴权。Agent 只能经工具层操作。
- 只接受 `http(s)`（`index.js:548`）；请求体 8MB 上限（`398–418`）。
- 浏览器使用独立临时 profile（`index.js:151`），与用户浏览器 Cookie 隔离；无 Cookie 导出/文件下载上传。
- 现有验收未发现工具可越权读写宿主机文件。

缺口与风险：

- **无 per-Agent 授权/权限模型**：同一会话里任何 Agent 都能调用全部 7 个工具，没有目标白名单、危险动作确认或操作预算。
- **无取消**：工具参数不接受 `AbortSignal`，只有 CDP 30s 硬超时；长时间 `browser_eval`/导航不能中途取消。
- **目标范围只在客户端校验**：面板 `go()` 拦截 DSH 自身 origin 与含凭据 URL（`client.js:305`），但服务端 `browser_navigate` 只校验 scheme（`index.js:546–552`），可导航到本机/内网/DSH 自身地址（SSRF 面），Skill 只能靠文字约束。
- **不脱敏**：`browser_network` 原样返回含 `token` 的 query（实测 F5，`index.js:237–244`、`376–379`）；`browser_state.error`、activity 文案、日志可能带完整 URL。
- **截图与证据泄漏**：`browser_screenshot` 的 `image` 虽不进模型上下文，但 `execute` 返回值含完整 base64；工具结果通道/日志若落盘会带页面敏感内容。
- **无并发保护**：两个人/Agent 同时输入会交错，点击可能命中错误目标；没有 rate limit / lock / 所有权。

### 6. 证据记录 — 不满足

要求：每次操作保留目标、参数摘要、结果、错误和关联证据。

现状：

- 没有任何 evidence id、action id、时间戳字段、目标记录或持久化；`activity` 只是 15s 的展示字符串（`index.js:277–280`），`lastError` 是最后一次错误的单值（`283–292`），下一次错误就覆盖。
- 工具返回：`browser_eval` 无时间戳；`browser_network` 条目有 CDP `at`/`status` 但无请求头/响应头/正文/耗时；`browser_screenshot` 的 `capturedAt` 在 tool 返回里被去掉，`output.render` 只渲染 `{viewport,bytes}`，**`image` 不进模型上下文**（`index.js:570–580`），Agent 看不到图，也不能把截图落盘成证据。
- 关闭/重启语义已修：`close()` 现在会停 screencast、关闭 WebSocket、清空 `network/requests/url/title` 并重置帧缓存，上一轮数据不会自动混入下一轮；`/metrics` 只有面板预览指标，也不能当页面证据。
- 没有 `execution_status` / `assertion_status` 两个独立字段；Skill 只在文字上要求“操作成功 ≠ 断言通过”。

结论：当前“证据”只存在于会话 transcript 与内存态，不可独立复核，也不满足“每次操作都有记录”的要求。

**与矩阵口径差异**：`checklist-matrix.md` 把“工具能返回可读值 + 验收脚本能落盘”算作“部分”；但清单要求的是**每次操作**自动保留目标/参数/结果/错误/关联证据，插件没有任何记录字段与持久化，故本审计判 **不满足**。

### 7. 资源管理 — 满足（小项待清）

正常路径（P8 9/9 通过）：

- 懒启动 + `ensure()` 去重；`/close` 后 Chromium 进程消失、临时 profile 被删除、`running=false`、`seq` 归零、可重复 close、可重新启动新进程/新 profile。
- 插件卸载时 `ctx.effect` 清理调用 `runtime.close()`；`network` 数组上限 300。

2026-10-31 帧管线调整后补齐（代码审查 + 实测）：

- **启动失败路径**：`#start()` 的 catch 会 kill 已 spawn 的 Chromium、关闭 CDP、删除 `mkdtemp` 的 profile，不再遗留进程/目录。
- **关闭路径**：`Page.stopScreencast`、调用 `cdp.on()` 的 disposer、清空 `requests`/`network`/帧缓存/运行态；`SIGTERM` 后等待退出，超时 `SIGKILL` 兜底；profile 同步 `await rm`，不再用延迟 `setTimeout`。
- **WebSocket 服务端**：客户端 close/ping 都能处理（修复了漏挂 `socket.on('data')` 与 close 帧顺序问题），`/close` 时关闭全部客户端；实测连续 connect/close 10 次后 `clients=0`，不会占满连接上限。

剩余小项：

- `Cdp.send` 的 30s `setTimeout` 在成功/失败后不 clear，会短期堆积定时器（不影响关闭/重启正确性）。
- `Network.loadingFailed` 未处理，失败/挂起请求会留在 `requests` Map；`close()` 会清空，长时间单会话可能增长。

**与矩阵口径差异**：原审计判“部分”；帧管线调整后已修掉启动失败/关闭不彻底问题，本审计上调为 **满足**，不再列差异。

## 插件可用性门禁（模板 WEB-T1-CHECKLIST 对照）

| 门禁 | 结论 | 证据 |
|---|---|---|
| `ctx.skills.register()` 完成并在宿主正确发现 | 服务级通过；运行实例待重启 | `check-skill-registry.mjs` 17/17；当前 3080 实例未加载（见下） |
| 主 Skill 与 references 随插件产物打包 | 通过 | `npm pack --dry-run`：37 个文件，其中 27 个 `skills/ui-testing/**`；`package.json files` 含 `skills/**`，另含 `frame-source.js`/`frame-push.js` |
| 资源文件可由 Agent 经授权接口读取 | 部分验证 | `resourceBase` 指向仓库 `skills/ui-testing/`，文件真实存在；Agent 会话内实际读取未验证（需重启后新会话） |
| Tool Registry 只暴露实际已实现的工具 | 通过 | 恰好 7 个，全部有 `execute`，无 CDP 通用命令工具（P1） |
| 能力发现接口准确反映可用性（非静态计划） | 部分满足 | 无 capability API（F1）；Skill 以注册表为权威 |
| 正例、反例与回退原因可复核 | 通过 | `run-report.json` 13 组探针 + 7 条 finding；`check-skill*` 脚本；台账回填实测证据 |
| 操作完成与断言通过使用不同状态字段 | 不满足 | 工具返回值无这两个字段；仅 Skill 文字要求 |
| T1 不会虚报 T2/T3/T4 已实现 | 通过 | manifest `unsupported_tiers`；Skill 明示未实现；无对应工具 |

## 生效状态（重要）

- 当前用户正在使用的 **3080 实例没有加载本插件**：HTTP `GET /plugins/ui-testing/state` 返回 404，Host 侧 `Tool.listTools` 中没有 `browser_*`。原因可核对：3080 进程启动于 08:34，而本插件提交 `2c1c15f` 在 09:59，运行进程早于插件代码。
- 隔离实例（`DSH_HOME=/tmp/dsh-audit`，端口 3095，同一 web profile）能正常加载：`/plugins/ui-testing/state` 返回 200；在 `skills/` 就位后重启同一隔离实例，路由仍返回 200，说明真实 DSH web 组合能加载本插件（该实例未做 Agent 会话级 `skill` 调用验证）。
- 因此：**改完 `index.js` / 新增 `skills/` 后必须重启 DSH**；重启后用新会话验证 `skill` 工具能列出并加载 `ui-testing`、工具列表出现 7 个 `browser_*`，这一步本次未在 3080 现场验证（避免打断用户会话）。

## 复跑命令

```bash
node tests/acceptance/run.mjs                     # 13 组探针；当前退出码 1（只剩 P2 两个旧缺陷；P11–P13 帧管线通过）
node tests/acceptance/check-skill.mjs             # Skill 结构/引用/工具名一致性
node tests/acceptance/check-skill-registry.mjs    # 真实 DSH SkillRegistry 注册/发现/加载/render
node tests/acceptance/real-browser-ws.mjs         # 可选：隔离 DSH + 无头 Chromium + 页面内 WS 回归
```

证据：`tests/acceptance/evidence/{run-report.json,run.log,screenshot.png,network.json,check-skill.log,check-skill-registry.log,checklist-matrix.md,frame-pipeline-summary.md,real-browser-ws-report.json}`。

## 未验证项

- 重启后 Agent 会话内实际调用 `skill` 工具加载 `ui-testing`（服务级已验，会话级未验）。
- 面板 `client.js` 的帧渲染、真实鼠标/键盘转发、状态栏数据源。
- 启动失败路径的真实资源回收（代码上疑似泄漏，未构造故障实测）。
- 并发 Agent 同时点击/输入的竞态（代码上无锁）。
- 非沙箱宿主（默认 `/opt/google/chrome/chrome` 直接启动）与外部网络目标。

## 建议修复优先级（需用户拍板）

1. **P0 诊断与安全**：`browser_navigate` 检查 `errorText` 并返回失败；错误统一成 `{ok:false, code, category, retryable, message}`；`browser_state.title` 改用 `Page.getNavigationHistory`/`Runtime.evaluate('document.title')`；`browser_network` 对 query 做脱敏；服务端限制本机/内网/DSH origin。
2. **P0 隔离**：为每个 Agent/Session 引入 owner + lease + 至少“写操作互斥”；或明确文档化为“单会话独占工具”，并在 tool 返回里带 `session_id`。
3. **P1 证据**：增加 `action_id`、`asserted_at`、目标、参数摘要、结果/错误的结构化返回与可选落盘；`browser_screenshot` 让 `image` 进入模型上下文（或返回可保存路径）。
4. **P1 资源**：`#start()` 失败清理 proc/profile；`close()` 补 stopScreencast、清 requests/network/url/title、await 退出 + SIGKILL 兜底、同步删 profile；`loadingFailed` 处理与 `requests` 上限；CDP 定时器 clear。
5. **P2 体验**：`browser_input` 增加 `click`/`type`/`pressKey` 高层动作；`browser_state` 增加 `capabilities`（或独立工具）。