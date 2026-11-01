# 能力发现契约（M0–M2）

## 注册表与运行态

当前 Agent 工具注册表决定可调用的名字；`browser_capabilities {}` 根据调用方与 owner/租约报告 `available / unavailable / unsupported`、原因和限制。**工具面 16 个**：T1 9 个 + T2 7 个；`web.t1.http-request`、`web.t2.*` 七项与聚合项 `web.t2.structured-dom` 报 available（或 BUSY），并且必须报 `limits.structuredGui`（protocolVersion/targetFrame/ref 策略/各限额）。其他 owner active/idle 占用时页面/network/T2 为 unavailable、reason BUSY，state/capabilities 与 http_request 仍 available。未启动的页面工具可以 available（按需懒启动，constraint 说明启动可能失败），running/transport 单独报告真实连接，不能把未启动当 unsupported。附件状态与截图 fallback 另报限制，不能回显静态 manifest 作为运行态。T3/T4、Agent 视口工具、下载/上传/Cookie 导出仍 unsupported。

**能力报告不能自证**：若 capabilities 自身抛错或字段与本文/注册 schema 不符（早期草稿曾在 limits 块引用未声明常量抛 `INTERNAL`，已修），按“证据不足”处理（BLOCKED/INCONCLUSIVE），不据此推断某能力可用或不可用；以注册表 + 真实工具调用为准。

`browser_state {}` 与 capabilities 都是诊断，不懒启动、不申请页面租约；state 的 `running:false` 可表示未启动/已关闭/断连，不等于 unsupported。需要页面的 5 个 T1 工具与全部 7 个 T2 工具可在授权操作时懒启动，network 不启动但须过租约检查；`browser_http_request` 既不启动也不受租约。T2 中只读的 snapshot/node_state/wait_for 同样受其他 owner 的 BUSY 限制。

## P0 capture 声明与观测

`browser_capabilities` 增加顶层capture与limits.capture，不创建page、不启动、不夺租约。capture声明version1、PNG/CDP、document-css-px、defaultScale1、连续scaleRange[1,4]、maxOutputPixels16000000；supports包含region/clipScale/captureBeyondViewport/PNG结构/均匀统计/fileWrite/noClobber/attachmentSizeCompare。output声明defaultMode:'staging'、persistRules:['out','persist:true','DSH_UI_TESTING_CAPTURE_DIR']、stagingRoot:'<tmp>/dsh-ui-testing-capture-*'、workspaceRoot:'<workspace>'、directory:'output/capture'、env变量名、mode0600/noClobber、ephemeral:true；不返回实际绝对根。limits.capture含staging:true/persistParam:true/pathKind:['relative','absolute']；声明不创建暂存根。

observed首次为null，只能来自所属Runtime上次真实截图，含observedAt/scale/png尺寸/sizeCheck/anomaly/delivery.downscaled/file:{persistence,relativePath}，staging时relativePath=null，不含绝对路径或页原始URL；旧观察不是当前页保证。limits.capture包含相同scale/像素限制及路径200字节/单段100、八项warnings。supports是实现声明，不保证根可写或附件可见。P0暂存修订真实Chromium+fake ctx为14/14、142/142（仓库 `tests/acceptance/runs/capture-p0-2026-11-01T05-52-05-302Z-104057/report.json`），真实宿主重载/provider仍NOT_RUN。

## state 字段

| 字段 | 含义与限制 |
| --- | --- |
| `mode/activity` | 最近活动与控制权展示，不代表能力或业务授权 |
| `url/title` | 最近页面 URL、从 `document.title` 刷新的标题；不代表加载完成 |
| `viewport` | 当前视口；Agent 无设置工具 |
| `seq` | 面板预览帧序号，不能导出 Agent 连续帧 |
| `running/error` | CDP 连接与最后错误线索；`errorAt`/`errorActionId`/`errorTarget` 给出归属与时间，成功的页面/网络操作会清空，诊断与 HTTP 不清 |
| owner/lease 诊断 | 按 DSH 工作区 page 隔离 + 每工作区 single-owner-lease；Cookie/存储共享，不是安全隔离；capabilities 报 workspaceIsolation |
| `limits.httpRequest` | 独立 HTTP 默认/上限预算与「非完整网络沙箱」声明；不因 Chrome 缺失或 owner 占用变为 unavailable |

页面/network 由 exec.agent.id 标识 owner，身份缺失共用 anonymous；空闲 15s、进行中保持、disposed 释放，其他 session 返回 BUSY。state/capabilities 可由其他 session 诊断。

## 探测流程

1. 确认注册表存在所需工具。
2. 调 capabilities 看状态/原因/限制，再用 state 确认页面/owner。
3. 执行授权操作，以真实返回和后续观察作证据。
4. 缺工具不得走 CDP/面板 HTTP 绕过；结果未知按 BLOCKED/INCONCLUSIVE 报告。

静态台账使用 implemented-not-verified、verified、partial、unsupported；这些是工程验收状态，与运行时三态含义不同。主验收在 M0–M2 的 P1–P21 之上新增 P22（独立 HTTP 请求）；**工具面已扩到 16 个**，宿主 lossless JSON / schema 断言与 Skill 自检须按 16 个工具复跑（测试侧同步中）。T2 七工具与聚合项记 **verified**：`tests/acceptance/t2-structured.mjs` 优化构建探针 37/38 通过（唯一 notRun = C38 套件边界）、必需检查 **260/260**、criteriaCovered 38、exit 0（报告 `tests/acceptance/runs/2026-11-01T03-41-31-025Z-39784/run-report.json`）；真实宿主会话已由 `tests/acceptance/evidence/t2-real-host-2026-11-01.md`（14/14 检查行）验证，closed-shadow ref 细分与 provider 图像可见性仍未验证。具体计数与结论以仓库 `tests/acceptance/runs/` 报告为准；真实宿主会话内的工具调用与 provider 图像可见性仍须单独证据，不把旧版 verified、静态 schema 或主路径通过外推到未覆盖项。
