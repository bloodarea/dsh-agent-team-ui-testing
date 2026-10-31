# 能力发现契约（M0–M2）

## 注册表与运行态

当前 Agent 工具注册表决定可调用的名字；`browser_capabilities {}` 根据调用方与 owner/租约报告 `available / unavailable / unsupported`、原因和限制。其他 owner active/idle 占用时页面/network 为 unavailable、reason BUSY，state/capabilities 仍 available。未启动的 T1 可以 available（按需懒启动，constraint 说明启动可能失败），running/transport 单独报告真实连接，不能把未启动当 unsupported。附件状态与截图 fallback 另报限制，不能回显静态 manifest 作为运行态。T2/T3/T4、独立 HTTP 客户端仍 unsupported。

`browser_state {}` 与 capabilities 都是诊断，不懒启动、不申请页面租约；state 的 `running:false` 可表示未启动/已关闭/断连，不等于 unsupported。需要页面的 5 个工具可在授权操作时懒启动，network 不启动但须过租约检查。

## state 字段

| 字段 | 含义与限制 |
| --- | --- |
| `mode/activity` | 最近活动与控制权展示，不代表能力或业务授权 |
| `url/title` | 最近页面 URL、从 `document.title` 刷新的标题；不代表加载完成 |
| `viewport` | 当前视口；Agent 无设置工具 |
| `seq` | 面板预览帧序号，不能导出 Agent 连续帧 |
| `running/error` | CDP 连接与最后错误线索；error 可能过期 |
| owner/lease 诊断 | single-owner-lease，仅一个共享页面；不是会话/Cookie 隔离 |

页面/network 由 exec.agent.id 标识 owner，身份缺失共用 anonymous；空闲 15s、进行中保持、disposed 释放，其他 session 返回 BUSY。state/capabilities 可由其他 session 诊断。

## 探测流程

1. 确认注册表存在所需工具。
2. 调 capabilities 看状态/原因/限制，再用 state 确认页面/owner。
3. 执行授权操作，以真实返回和后续观察作证据。
4. 缺工具不得走 CDP/面板 HTTP 绕过；结果未知按 BLOCKED/INCONCLUSIVE 报告。

静态台账使用 implemented-not-verified、verified、partial、unsupported；这些是工程验收状态，与运行时三态含义不同。M0–M2 主验收已扩至 21/21 组、196/196 必需项通过（P1–P21；P21 用真实宿主校验器断言 8 工具输出为 lossless JSON），状态按台账覆盖范围回填；3081 HTTP 集成已扩到 14 项，需重启宿主后复跑；真实 Agent/provider NOT_RUN，不把旧版 verified 或主路径通过外推到未覆盖项。
