# 能力发现契约（M0–M2）

## 注册表与运行态

当前 Agent 工具注册表决定可调用的名字；**工具面 35 个**：T1 10 个 + T2 7 个 + T3 6 个 + 网络 P0 7 个 + T4 5 个；`web.t1.http-request`、`web.t2.*` 七项与聚合项 `web.t2.structured-dom`、`web.t3.*` 六项与聚合项 `web.t3.static-vision`、`web.network.*` 七项与聚合项 `web.network.p0`、`web.t4.*` 五项与聚合项 `web.t4.dynamic-behavior`（旧名 `web.t4.dynamic-vision` 为别名）报 available（或 BUSY），并且必须报 `limits.structuredGui`（protocolVersion/targetFrame/ref 策略/各限额）、`vision`/`limits.vision`（version=1、algorithmVersion='t3-v1'、六个工具名、sourceKinds、全部预算、observed）、`network`/`limits.network` 与 `dynamic`/`limits.dynamic`（algorithmVersion='t4-draft-v1'、六向、预算、`maxSessionExtendMs`/`sessionCapMs`）。其他 owner active/idle 占用时页面/network/T2/T3 为 unavailable、reason BUSY（含 T3 的离线 baseline list/get/delete，它们仍过队列与 owner 检查），state/capabilities 与 http_request 仍 available。未启动的页面工具可以 available（按需懒启动，constraint 说明启动可能失败），running/transport 单独报告真实连接，不能把未启动当 unsupported。T3 只有 live 源与 `act` 会懒启动页面；product/baseline 源与离线 baseline 操作不启动浏览器。附件状态与截图 fallback 另报限制，不能回显静态 manifest 作为运行态。下载/上传/Cookie 导出、多标签/frame 级目标仍 unsupported（T4 与共享视口已实现；T4 的 media 适配器/WebGPU 真实渲染/16ms 闪白采样覆盖仍未验证）。

**能力报告不能自证**：若 capabilities 自身抛错或字段与本文/注册 schema 不符（早期草稿曾在 limits 块引用未声明常量抛 `INTERNAL`，已修），按“证据不足”处理（BLOCKED/INCONCLUSIVE），不据此推断某能力可用或不可用；以注册表 + 真实工具调用为准。

`browser_state {}` 与 capabilities 都是诊断，不懒启动、不申请页面租约；state 的 `running:false` 可表示未启动/已关闭/断连，不等于 unsupported。需要页面的 5 个 T1 工具与全部 7 个 T2 工具可在授权操作时懒启动，network 不启动但须过租约检查；`browser_http_request` 既不启动也不受租约。T2 中只读的 snapshot/node_state/wait_for 同样受其他 owner 的 BUSY 限制。

## network P0 声明与观测

`browser_capabilities` 增加顶层 `network` 段，**不启动浏览器、不建目录、不生成证据文件、不申请租约**：

```jsonc
{ "network": { "version": 1, "tools": ["browser_network_session", "…7 个"],
    "session": { "id": "net-…", "state": "running", "counters": {…}, "integrity": {…} },
    "limits": { "maxEvents": 20000, "maxBodyBytes": 1048576, "maxTotalBytes": 33554432,
      "maxWsFrames": 20000, "subscriptionMax": 16, "subscriptionPin": 1000,
      "eventPageLimit": 200, "holdTimeoutMs": 30000,
      "network": { "capture": true, "bodies": true, "websocket": true, "sse": true,
        "workers": true, "interception": true,
        "responseModification": true|false,
        "https": "mechanism-identical",
        "throttle": true, "offline": true, "replay": true, "mock": true,
        "har": true, "jsonl": true, "subscriptions": true } },
    "observed": { "lastCallAt": 1760000000000, "lastOperation": "events" } } }
```

- `web.network.session/events/detail/trace/control/evidence/subscribe` 与聚合 `web.network.p0` 逐一报 `available|unavailable|unsupported`；其他会话持有租约时 `control`/`session` 变更报 `unavailable(BUSY)`，只读仍 `available`；会话未启动时 `session.start` 仍 `available`（懒启动，constraint 说明可能失败）。
- **`capabilities.network.limits.network.https` 是必报标量字段，取值只能是 `"mechanism-identical"`**（与 `responseModification` 并列同层；同一 CDP 机制、未独立验收，**不得写 `verified`/`https-captured`/`true`**）。`responseModification` 紧随其后，按 Chrome 实测支持与否报 `true|false`；`responseModification` 按 Chrome 实测支持与否报 `true|false`，不支持时 `modify-response` 不可用；`G1.5`（iframe/OOPIF/Worker）在台账记 **partial**，popup 不采。
- `observed` 只来自真实调用（`lastCallAt`/`lastOperation`），不含事件内容、正文、绝对路径或页面文本；`limits` 必须与 §2.1/§4.2/§8.7 的契约数值一致，任何新增限额都要在这里公开。
- 静态台账/清单里的 `implemented-not-verified`/`partial` 是**工程状态**，不能映射成运行时 `available`；反向也不能：`available` 不等于行为已验收。

7 项 `web.network.*` 与聚合 `web.network.p0` 按此报 available（或其 owner 冲突 unavailable+BUSY）。`G1.5` 仍 partial；

## P0 capture 声明与观测

`browser_capabilities` 增加顶层capture与limits.capture，不创建page、不启动、不夺租约。capture声明version1、PNG/CDP、document-css-px、defaultScale1、连续scaleRange[1,4]、maxOutputPixels16000000；supports包含region/clipScale/captureBeyondViewport/PNG结构/均匀统计/fileWrite/noClobber/attachmentSizeCompare。output声明defaultMode:'staging'、persistRules:['out','persist:true','DSH_UI_TESTING_CAPTURE_DIR']、stagingRoot:'<tmp>/dsh-ui-testing-capture-*'、workspaceRoot:'<workspace>'、directory:'output/capture'、env变量名、mode0600/noClobber、ephemeral:true；不返回实际绝对根。limits.capture含staging:true/persistParam:true/pathKind:['relative','absolute']；声明不创建暂存根。

observed首次为null，只能来自所属Runtime上次真实截图，含observedAt/scale/png尺寸/sizeCheck/anomaly/delivery.downscaled/file:{persistence,relativePath}，staging时relativePath=null，不含绝对路径或页原始URL；旧观察不是当前页保证。limits.capture包含相同scale/像素限制及路径200字节/单段100、八项warnings。supports是实现声明，不保证根可写或附件可见。

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

静态台账使用 implemented、implemented-not-verified、verified、partial、unsupported；这些是工程验收状态，与运行时三态含义不同。**工具面 35 个（10 T1 + 7 T2 + 6 T3 + 7 network + 5 T4）**，`check-skill` 与 `check-skill-registry` 断言注册表恰好 35 个。台账只记录当前状态，不保留逐轮历史。

**`vision` 报告要求**：`browser_capabilities.vision` 必须报 `version:1`、`algorithmVersion:'t3-v1'`、六个工具名、`sourceKinds:['live','product','baseline']`、`limits`（maxProducts/maxTotalBytes/maxProductBytes/maxProductPixels/maxWorkingSetBytes/maxTemplateComparisons/algorithmBudgetMs/maxOutputPixels/maxOutputBytes，以及 evidenceBytes/regions、cases/assertions/facts、masks/annotations/preprocess、actMaxAgeMs）与 `observed:null|{observedAt,lastOperation,lastVerdict}`；`limits.vision` 另报坐标空间、productId 形态、diff 默认值与 warnings 词表、baseline 根/权限/action。观测只来自真实视觉调用，不含图像、绝对路径或页面文本；该调用不启动浏览器、不建目录、不生成 product、不申请租约。

真实宿主重载、provider 图像可见性、上表 3 条 N/A 仍须单独证据；
