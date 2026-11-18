# 工具参考

插件向 Agent 注册 **43 个执行工具 + 1 个发现入口 `browser_tools`（共 39 个）**。工具名即调用名，返回值统一以 `{ok:true,…}` 表示工具执行完成，失败抛类型化 `BrowserError`。

> 能力分层、支持/可用/执行/通过的区别，以及证据判读统一见[能力分层文档](capability-tiers.md#2-共同约束与选路)。`integrity` 报告采集完整性，业务结论仍需具体断言。

## 注册、发送与执行是三个问题

宿主在每个模型 step 重新计算插件注册的 `when` 条件，**只把通过条件的定义发送给模型**，并用同一份 step 集合执行调用（当前安装在 `LlmAdapter.stream` 的 `request.tools` 与 `request/header` 事件上都实测过；`when=false` 的工具不在请求里，强制调用报 `UNKNOWN_TOOL`）。因此：

| 概念 | 含义 | 不等于 |
| --- | --- | --- |
| 注册 | 插件登记完整实现与 schema（受环境启用范围限制） | 本步已发送 |
| 发送 | 本步 `when` 通过、环境准入通过、该 Agent 已选择对应能力组 | 一定能在当前目标执行成功 |
| 允许调用 | 本步集合允许该名字，并通过环境授权、工具作用域、目标权限与 guards | 页面输入生效或断言通过 |

默认每个模型请求只带 **3 个** 插件定义：`browser_tools`、`browser_state`、`browser_capabilities`。需要页面、网络、静态图像或动态帧时，先调用 `browser_tools` 激活能力组，**下一 step** 才携带对应工具的完整 schema。分组、激活方式与生命周期见[按任务披露工具](tool-disclosure.md)。

`browser_state` 与 `browser_capabilities` 是**环境中立诊断**：任何环境（含被禁用）都保留，用于回答"支持什么/为什么被拒"，它们不启动目标；被禁用环境的六轴报告为 `support=supported` + `enabled=false`，不再退化成"未注册"或 `INTERNAL`。成功/失败 envelope 额外携带 `configRevision`、`environment`、`adapterId`，用于核对本次执行使用的配置版本；`browser_capabilities.adapter` 报告 adapter 契约版本、能力矩阵、P0 family 状态、六轴就绪，以及 `declaration`：`registeredTools`（注册上限）、`admittedTools`（该作用域的环境准入）、`isolated`。`declaration` 的两份列表都**不是**本步实际发送内容；`browser_capabilities.disclosure` 给出本 Agent 的选择与下一请求候选。

## 注册面

**工具布局由设置页的面板配置作为唯一权威**：启用了哪些环境，就只注册这些环境的工具，不会额外带入其它环境的 schema。

| 面板里启用 | 注册面（可注册的插件工具；本步实际发送还需经过披露选择） |
| --- | --- |
| 只 Web | 43 个 Web 工具 + `browser_tools` = 44 |
| Web + fake（测试环境） | 上述 39 个 + `browser_fake_probe` = 40 |
| 只 fake | `browser_tools` + `browser_fake_probe` + 两个诊断 = 4 |
| 全关 | `browser_tools` + `browser_state` + `browser_capabilities` = 3 |

被禁用或不允许选择的环境，其工具**根本不注册**，因此不可能出现在任何模型请求里。注册范围是环境上限，逐步筛选由 `when` 完成；两者都不改变执行期的环境授权与工具白名单。`browser_fake_probe` 仅在 `DSH_UI_TESTING_TEST_HOOKS=1`/`DSH_UI_TESTING_ALLOW_TEST_ENV=1` 的测试配置中注册，不属于生产工具面。

### `browser_tools`

| 工具 | 参数 | 返回与限制 |
| --- | --- | --- |
| `browser_tools` | `action:"status"\|"activate"\|"reset"`（必填）；`groups?:"basic"\|"network"\|"vision"\|"dynamic"` 数组（仅 activate，1–4 项） | 返回 `environment`/`provider`/`selected`/`catalog`/`nextRequestTools`/`effective`/`lifetime`。`status` 与 `reset` 只读或不含 schema；`nextRequestTools` 是下一 step 的候选名字（无完整 schema），不是本步冻结集合、也不是权限裁决。不启动浏览器、不占租约、不读写页面。错误：`INVALID_ARGUMENT`、`TOOL_DISCLOSURE_UNKNOWN_GROUP`、`TOOL_DISCLOSURE_UNAVAILABLE`、`TOOL_DISCLOSURE_AGENT_REQUIRED`。 |

## 总览

| 分组 | 数量 | 工具 |
| --- | --- | --- |
| 发现入口（discovery） | 1 | `browser_tools` |
| P0-E 多标签（tabs） | 1 | `browser_tabs` |
| P0-D 标注（annotations） | 1 | `browser_annotation` |
| 程序化（T1） | 10 | `browser_navigate` `browser_eval` `browser_screenshot` `browser_input` `browser_network` `browser_computed_style` `browser_http_request` `browser_viewport` `browser_state` `browser_capabilities` |
| 结构化 GUI（T2） | 7 | `browser_snapshot` `browser_click` `browser_type` `browser_scroll` `browser_fill_form` `browser_node_state` `browser_wait_for` |
| 静态视觉（T3） | 6 | `browser_vision_image` `browser_vision_find` `browser_vision_compare` `browser_vision_act` `browser_vision_baseline` `browser_vision_check` |
| 动态行为（T4） | 5 | `browser_dynamic_session` `browser_motion_observe` `browser_motion_analyze` `browser_motion_control` `browser_dynamic_correlate` |
| 网络（P0-B） | 7 | `browser_network_session` `browser_network_events` `browser_network_detail` `browser_network_trace` `browser_network_control` `browser_network_evidence` `browser_network_subscribe` |
| 安全（security 组） | 6 | `browser_security_scope` `browser_cookies` `browser_surface` `browser_script` `browser_findings` `browser_biz` |

## 多标签（P0-E）

P0-E 的[多目标管理接口](multi-tab.md#1-公共抽象)由各目标环境实现，当前提供 Web 工具 `browser_tabs`。它管理当前 workspace、provider 与团队根内的 primary + child 页面；写工具走调用者 workSelection（默认指向自己已拥有的页，没有自有页则未绑定），读工具优先 observationSelection，再回退 workSelection。具体约定见[Web 实现](multi-tab.md#2-具体实现web)。

| 工具 | 主要参数 | 要点 |
| --- | --- | --- |
| `browser_tabs` | `action:"list"\|"current"\|"select"\|"open"\|"close"\|"wait"\|"acquire"\|"release"\|"transfer"` `tabId?` `mode?`（仅 select，work/observe）`kind?` `source?` `timeoutMs?`（wait/acquire）`pollMs?`（wait）`expectedControlRevision?`（acquire/release/transfer 必填）`expectedOwnershipRevision?`（transfer 必填）`toSessionId?`（transfer） | `list/current/wait` 只读（wait 纯内存轮询，不启动 Chromium、不取 lease，超时 `WAIT_TIMEOUT`）；`select` 只改调用者自己的选择（work 写目标 / observe 只读目标），**不 claim 租约、不切前台**；`open` 新建 about:blank；`close` 按长期归属/控制权判定（owner 或 controller，本 root Lead 亦可）；`acquire/release/transfer` 仅本 root Lead，带 CAS 版本，`acquire` 先 draining 再等安全边界（不中断在途操作，超时 `BUSY` 且撤销 draining）；页面组按 (workspace, provider, 团队根) 划分，child 最多 3 个按 (workspace, provider) 跨 root 合计、全局 live 8；`list` 每项含 `source/parentTabId/openEventId/createdAt/lastUsedAt/idleRemainingMs/manageable` 与 `accessVersion/rootSessionId/creatorSessionId/ownerSessionId/controllerSessionId/ownershipRevision/controlRevision/accessState/permissions`，并返回 `notices`/`recentClosed`（各最多 8 条）；错误 `TAB_NOT_FOUND`（跨 root 统一，不泄露存在性）`/TAB_FORBIDDEN/TAB_CONTROL_CHANGED/TAB_OWNERSHIP_STALE/TAB_IDENTITY_UNAVAILABLE/TAB_LIMIT/BUSY(仅短暂忙)/WAIT_TIMEOUT/INVALID_ARGUMENT` |

## 标注（P0-D）

`browser_annotation` 读写**调试视图里的面板标注文档**：每个 Runtime 一份，与面板认证的 `POST /plugins/ui-testing/annotations` 是**同一份**文档。人类画的形状和 Agent 画的形状落在同一个文档里，面板下一次 `/state` 轮询（约 500ms）就会画出来。它**不启动浏览器、不进页面串行队列、不占 single-owner lease、不写页面 `lastError`、不改页面 DOM/CSS**——只写 Host 侧的标注文档。坐标契约同[视口、画布与标注](viewport-control.md)。

| 动作 | 参数 | 要点 |
| --- | --- | --- |
| `read` | 不接受其它字段 | 返回当前文档：`revision`、`shapes`、`shapeCount`、`truncated`、`truncation`、`foreground`。**不受前台条件限制** |
| `draw` | `shapes` 1–64、`expectRevision?` | 形状**追加**到现有文档，不是替换；省略 `id` 时由 Host 从现有最大 id 继续分配 `a<N>` |
| `erase` | `ids?` 1–64、`point?`、`expectRevision?` | `ids` 与 `point` 至少给一个；`point` 为 `{x,y,radius?}`，默认半径 8 画布 px |
| `clear` | 不接受其它字段（`expectRevision?` 除外） | 清空画布：写成空形状列表 |

写动作成功后返回写入后的同一份文档视图，字段与 `read` 相同。

形状字段：

| 字段 | 取值 |
| --- | --- |
| `type` | 必填：`circle` / `rect` / `line` / `arrow` / `brush` / `text`，分别对应面板的圆形、矩形、线段、箭头、画笔（铅笔）、文字（用于写问题、问号等文字提示） |
| `id` | 可省略（省略则由 Host 分配）；显式给出时必须匹配 `^a[1-9][0-9]{0,15}$` 且不重复 |
| `color` | `#rrggbb`，默认 `#ff3b30` |
| `strokeWidth` | 整数 1–20，默认 3（面板的「粗细」） |
| `style` | `stroke` / `fill`（面板的「外框」/「填充」），只对 `circle`/`rect` 有效；`text` 固定 `fill`，`line`/`arrow`/`brush` 固定 `stroke` |
| `fill` / `stroke` | 也接受显式布尔值；**同时**给 `style` 与 `fill`/`stroke` 报 `INVALID_ARGUMENT` |

几何字段按类型：

| `type` | 字段 | 备注 |
| --- | --- | --- |
| `rect` | `x,y,width,height` | 左上角 + 尺寸 |
| `circle` | `cx,cy,rx,ry` | 与面板一致：包围盒内接椭圆（不是「中心 + 半径」） |
| `line` / `arrow` | `x1,y1,x2,y2` | `arrow` 的 head 由 Host 按端点与线宽派生，调用方给了也不作数 |
| `brush` | `points:[[x,y],…]` | 单笔画笔点数受下文限额约束 |
| `text` | `x,y,text,fontSize?` | `fontSize` 固定 20 |

- **橡皮擦命中规则**：`erase.point` 命中形状的判据与面板橡皮擦一致——形状几何到该点的距离 ≤ `max(strokeWidth/2, 6)` 与给定 `radius` 取大者。
- **前台硬约束**：`draw`/`erase`/`clear` 只在目标标签页**正被人类在调试视图里选中且可见**时才允许，否则**零写入**并报 `ANNOTATION_NOT_FOREGROUND`。判断依据是面板在认证请求上携带的前台标签心跳（约 1.5s 新鲜窗口）：人切走标签、关掉面板、或把 DSH 标签页切到后台都会让窗口过期。目的就是 Agent 画的标注必须人能立刻看到。`read` 不受此限；可用 `browser_state.annotations.foreground = {active, ageMs, maxAgeMs}` 先判断能不能画。
- **页面必须处于运行态**：未启动页面时写标注报 `INVALID_ARGUMENT`（reason `annotation-runtime-not-running`）。
- **乐观并发**：`expectRevision` 与当前文档 `revision` 不同则报 `ANNOTATION_REVISION_CONFLICT`，零写入并返回 `currentRevision`。
- **整份替换语义**：文档是整份替换模型——人类在面板里下一次编辑会整体发布自己的形状列表（其中已包含 Agent 画的形状，因为面板会采纳 Host 文档），而人类「清除画布」会连 Agent 的形状一起清掉。
- **软限额**：与面板写面相同——文档最多 `maxShapes` 128 个形状、单笔画笔 512 点、文档总点数 8192、文字 200 字符、文档 65536 字节。Host 做确定性裁剪，并在结果里如实报 `truncated` / `truncation`。
- **证据边界**：标注是 `trusted=false` 的问题线索，不是页面事实；`browser_screenshot {includeAnnotations:true}` 会把 Agent 画的形状与人类画的形状一起叠加。

## 程序化（T1）

| 工具 | 主要参数 | 要点 |
| --- | --- | --- |
| `browser_navigate` | `url` | 只接受 HTTP(S)；校验目标、DNS 与最终 URL；**不保证加载完成** |
| `browser_eval` | `expression` | 主世界执行，返回可序列化值；页面异常以错误对象返回 |
| `browser_screenshot` | `scale` `region` `includeAnnotations?:boolean=false` `persist` `out` | 显式 scale 0.1–4；省略时跟随共享 `view.scale`；`region` 为 canvas CSS px（`O=0` 时与文档坐标相同）；`includeAnnotations:true` 按相同映射叠加 Host 已接受的六种面板标注，不含未提交草稿/工具栏，证据见 `capture.annotations`；默认截图及 T3/T4 原始源不含面板标注；PNG 经结构/尺寸校验；内联 base64 超过 24 MiB 时 `image=null` 并附 `image_base64_omitted` 警告（附件优先） |
| `browser_input` | `events[]` | 原始鼠标/滚轮/键盘事件，单批 ≤ 200 条（超出 `INVALID_ARGUMENT`）；`applied` 只是数组长度，不能证明生效。**带按键状态机**：`keyDown` 记位、`keyUp` 清位，按住 Shift/Ctrl/Alt/Meta 时后续 key/mouse/wheel 自动带上对应位（页面 `e.shiftKey` 等为真），`synthesizeModifiers:false` 可显式关掉；`mouse` 事件给 `deltaX/deltaY` 时按相对位移移动一个虚拟光标（点积锁定/转视角类调用不需要知道绝对坐标，光标被 clamp 在视口内）；返回 `{ok,applied,modifiers,held,cursor}`，`held` 是当前仍按住的键。导航/关闭会清空状态 |
| `browser_network` | `limit` | 轻量请求列表（默认 50、上限 300）；**只读**：不取页面队列、不取也不校验单 owner 租约（owner 持租约时仍可读），因此信封里 `sessionId` 是采集会话、agent 会话见 `agentSessionId`；深度分析用网络 P0 七工具 |
| `browser_computed_style` | `selector` `properties` | 首个匹配元素的计算样式；简写属性（如 `border-color`/`margin`/`font`）经页面 `getComputedStyle` 回退读取，未知属性不返回；不证明视觉结果 |
| `browser_http_request` | `url` `method` `headers` `body` `timeoutMs` `maxBytes` … | 独立 HTTP(S) 客户端，不启动浏览器、不占页面租约；`ok:true` **不等于 2xx** |
| `browser_viewport` | `action:"get"\|"set"` `mode` `x` `y` `canvasX` `canvasY` `width` `height` `scale` `expectedRevision` | `get` 是只读缓存诊断；`set` 是页面操作，走队列与租约 |
| `browser_state` | — | URL、标题、视口、错误、标注等诊断信息；不保证新鲜 |
| `browser_capabilities` | — | 能力声明（含 `web.tools.discovery`）、状态投影、limits、最近 observed 与 `disclosure`（能力组选择）；不启动浏览器；报告结构及其能证明的范围见[能力发现](capability-tiers.md#web-chrome-discovery) |

详见[视口、画布与标注](viewport-control.md)、[截图与图片交付](capture-p0.md)。

## 结构化 GUI（T2）

结构化发现、ref 协议、七个工具的参数、动作门禁、证据和错误统一见[Chrome T2 实现](capability-tiers.md#web-chrome-t2)。

## 静态视觉（T3）

Source、图像处理、定位、比较、动作、基线与断言的完整说明见[Chrome T3 实现](capability-tiers.md#web-chrome-t3)，包括[工具表](capability-tiers.md#web-chrome-t3-tools)与[源图协议](capability-tiers.md#web-chrome-t3-source)。

## 动态行为（T4）

| 工具 | 用途 |
| --- | --- |
| `browser_dynamic_session` | `start`/`stop`/`status`/`reset`/`extend`；帧源 `screencast` 或 `screenshot-loop`；`session.sampling` 给出机制/节奏/requested/measured/计数器/limitations |
| `browser_motion_observe` | 只读帧与事件查询；`includeImages` ≤3；`region`（image-px，仅与 `includeImages` 同用，注册 schema 可发现）只交付指定矩形；顶层与 `evidence.dynamic.sampling` 附实测采样块 |
| `browser_motion_analyze` | `motionSessionId` + 1–20 条断言；`window`/`frameIds` 恰一；返回 results/summary/verdict/exitCode 与 integrity |
| `browser_motion_control` | WAAPI `pause`/`resume`/`seek`/`rate`/`restore`，逐目标回读 |
| `browser_dynamic_correlate` | 六向「帧 ↔ 网络」关联，区分因果与时间邻近 |

完整会话、采样字段、帧查询、分析、控制与关联说明见[Chrome T4 实现](capability-tiers.md#web-chrome-t4)。

## 网络（P0-B）

| 工具 | 用途 |
| --- | --- |
| `browser_network_session` | 唯一会懒启动采集的动作：`start`/`stop`/`status`/`reset` |
| `browser_network_events` | 列表、时间线、聚合、过滤与检索（命中内容只回脱敏预览） |
| `browser_network_detail` | 单个请求/WS/SSE 的完整详情；读不到就是 `available:false` |
| `browser_network_trace` | 业务步骤窗口、对象提取、显式关联与因果查询 |
| `browser_network_control` | 限速、离线、拦截、hold、重放、mock |
| `browser_network_evidence` | JSONL（保真）/ HAR（1.2 子集）导出、导入、索引与完整性 |
| `browser_network_subscribe` | 多 Agent 各自游标 poll/ack，pin 预算内不丢 |

`browser_network_session` 的 `status`/`start`/`stop`/`reset` 与各 network 工具的 `evidence` 回传 `attribution:{scopeId,runtimeId,tabId}`（主标签 `primary`，缺失为 `null`、不反推）；`status` 另有 `activeSessionId`/`bufferedEvents`。`browser_network_detail` 的 body 为三态 `captured|empty|unavailable`，`unavailable` 带兼容字段 `reason:"NET_BODY_UNAVAILABLE"` + 稳定 `reasonCode`（`not-captured` / `cdp-*`）+ 脱敏 `reasonDetail`（≤160 字节）；`captureBodies:false` 明确 `not-captured`，不补抓。无会话时 `browser_network_events` 返回空并明示 `session:null`；跨标签不聚合，status 与 events 的历史不一致按 UNKNOWN 记录（详见[网络调试](network-p0.md)）。

详见[网络调试](network-p0.md)。

## 安全（security 组）

| 工具 | 用途 |
| --- | --- |
| `browser_security_scope` | 会话授权边界：`status`=只读查看；`set`=建立/重配置 Origin 白名单（精确 Origin）、路径前缀约束、预算（maxRequests/maxConcurrent/timeWindowMs）与 passive/active 模式（CAS 用 scopeConfigRevision）；`stop`=幂等不可撤销停止。生效后每次导航（含重定向落点）、Cookie 导出读取与独立 HTTP 请求（browser_http_request）在派发前逐次校验：越界 Origin/路径、超预算/并发、被动模式下的主动派发、以及**危险操作**（DELETE 任意路径、支付/注册/清除语义词路径、白名单外 Origin 回连）全部 0 次实际派发并留审计（SECURITY_SCOPE_* 错误码）。危险操作默认禁止；确需验证时以单次调用的 `allowDangerous` 显式升级（不粘滞、仍计数留证）。不 set 时普通 GUI 测试不受影响 |
| `browser_surface` | 攻击面发现：`build`=从网络采集事件与当前页面 DOM 事实构建结构化 Inventory。apiOperations（method/path/**参数来源**：`params.query`/`params.body`（JSON 支持一层嵌套展平）/`params.bodySources`（body-json、body-form）/`params.header`（名小写）/`params.pathHints`；认证观测/`initiatorTypes`/首次观测 seq）与 pageRoutes=observed（网络实发）、forms=inferred（DOM 可发起）、unverifiedPaths=unverified（调用方注入的静态线索）。**参数只记字段名，永不复制值**——body 与 header 常含令牌/密码。body 参数在**响应到达时**即读取（`Network.loadingFinished` 并非每个请求都会发出，曾因此漏掉 fetch POST 的请求体）；确实是空体（无 body 的 POST）时 `params.body` 为空且**不推测**；query/path/header 不受影响；认证状态只按 collector 头存储里**已观测到的** Cookie/Authorization 头标记，未观测保持 null；不主动派发任何请求。需先 `browser_network_session start` 才有 observed 流量 |
| `browser_biz` | 业务逻辑测试（服务端状态不变量）：`evaluate`=对已观测事实检查数量/价格边界、优惠券重复累加、客户端金额信任、重复提交幂等、非法状态迁移；`probe`=执行受控场景（cart-quantity 边界数量→读服务端购物车、coupon-reuse 同码多次应用→读折扣、order-state 只读状态基线、snapshot 只读快照）。所有 probe 都经 scope 闸门。BIZ-05 硬规则：每个确认问题至少 2 次可重复观测 |
| `browser_findings` | 安全 Finding 与证据闭环：`add`=登记（**状态只能由证据类型推导**：static-pattern→potential、observed-once→likely、differential/reproduced 且 ≥2 次复现+对照→confirmed；调用方请求更高状态会被降级并在 notes 说明）；`evaluate`=对观测事实跑规则引擎（匿名访问/横向纵向授权/参数篡改/**注入两类证据**：错误签名 + 布尔差分/DOM+存储型 XSS/CORS/安全头/调试端点/客户端金额信任），候选永不为 confirmed；注入的布尔差分需要**三组对照**（正常值、恒真 payload 结果变多、恒假 payload 结果变少）同时成立，缺一不出结论；`list`=清单+汇总；`grade`=证据完整度（必填字段+请求/响应+UI/源码关联）；`report`=结构化报告并做 canary 自检；`retest`=记录复测（复现计数/对照）；`reproduce`=**真实重放** Finding 记录的请求并比对服务端回答，返回能否独立复现（EVD-05）：状态必须一致、响应体前缀不符即判不可复现；重放同样经 scope 闸门，越界或危险操作不会因"复现"而放行。High/Critical 证据完整率须 100%（硬门槛） |
| `browser_script` | JavaScript 静态分析（Debugger 按需启用）：`list`=脚本清单（scriptId/URL/来源（external/inline）/字符长度/起止行/Source Map 声明（sourceMapUrl）/是否 module，**不含内容也不含哈希**（sha256 由 source 现算））；`armed`=启用 Debugger 采集；`source`=取源码（含 sha256 与 Source Map 三态）；`format`=格式化（`isOriginalSource:false` + 逐行原始位置映射）；`strings`=字符串表还原（`decoded` 可确定 / `plain` 本来可读 / `unknown` 无法还原，绝不伪造）；`sinks`=Source-to-Sink 定位（high/medium/low 置信度，low 不得声称可利用）；`analyze`=综合结论并可做静态/运行时一致性对照。**运行时分析**：`breakpoint`（set/list/remove，URL 断点；**导航时自动重放已注册断点**，因此在脚本执行前设置的断点也能命中；hitCount 未命中如实为 0）、`stack`（最近暂停的调用栈，不含 live callFrameId）、`scope`（作用域变量，敏感名只回类型与长度）、`resume`（恢复执行）、`correlate`（暂停栈↔请求关联，confirmed/likely/possible，possible 明确不是因果）、`verify`（静态签名结论 vs 运行时参数逐项比对，缺失项不算一致、敏感项只比形态）。暂停有硬超时（5s）：超时即自动 `Debugger.resume`，页面不会因调试永久挂起。未 armed 返回 `armed:false` 而非"没有脚本" |
| `browser_cookies` | Cookie Store 读取与受控凭据导出/导入：`metadata`=当前标签页精确 Origin 的元数据（名称/Domain/Path/Expires/Secure/HttpOnly/SameSite；永不返回 value）；`export`=明文导出到持久根内 0600 的 .json——需要人类在插件配置目录 security-approvals.json 签发授权（绑定 workspace/runtime/tab/origin、一次性、带过期；HttpOnly 需 allowHttpOnly:true 专项），Agent 的 confirm 字符串一律无效，超限整次失败不截断；`import`=把本工具导出的快照回填当前会话（HttpOnly 条目需 importHttpOnly:true）。工具响应/日志/网络证据零明文（canary 自检） |

错误分类：`SECURITY_SCOPE_*`（input/scope/authorization/resource）；`COOKIE_*`（input/scope/authorization/resource/output/capability）。

### 服务端授权判定、退出清理与传输边界

- **授权结论只能来自服务端状态**：隐藏按钮/菜单是界面约定，不构成授权通过或失败的依据。
  只有 UI 观测时结论为 `undetermined`，必须补「同一请求在不同身份下的响应码」对照——
  一方被 401/403 表示授权正确；双方都 2xx 表示功能级授权缺失。
- **退出清理**：退出后用旧会话凭据重放必须 **0 次成功**。没有重放观测时不得判定"已清理"。
- **会话观测用页内同源 fetch**（携带 Cookie）；`browser_http_request` 按设计无 Cookie jar，
  用它测会话只会得到 401——那是匿名视角，不是会话失效。
- **Cookie 导出/导入是纯本地操作**：写受控文件、解析封装快照、经 CDP 回填，不向任何第三方
  发送数据，也不切换到 `file:`/`ws:`/`data:` 等非 HTTP 通道。导入只接受本工具导出的封套
  （`kind: dsh-ui-testing-cookie-export`）——任意 Cookie 转储不会被当作本工具产物执行。

## 常见错误分类

| 错误码 | 含义 |
| --- | --- |
| `INVALID_ARGUMENT` | 参数不合法（含未知字段、互斥字段同时出现） |
| `BUSY` | 该页队列正被其他会话的**写**操作占用（短暂忙；只读观察不占写租约，权限问题不会报 BUSY） |
| `REF_STALE` | ref 所属快照或文档已失效，需要重新 snapshot |
| `NOT_INTERACTABLE` | 目标不可见/被遮挡/持续运动，零派发 |
| `INPUT_NOT_DELIVERED` | CDP 已派发但页面未观察到该事件（重试一次后仍无），见 [Web 输入送达校验](web/input-delivery.md) |
| `TARGET_NOT_UNIQUE` | selector 命中多个元素 |
| `VIEWPORT_CONFLICT` | `expectedRevision` 不匹配，patch 未应用 |
| `VISION_*` | 视觉源、尺寸、基线或比较错误 |
| `DYNAMIC_*` | 动态会话、预算、控制或关联错误 |
| `NET_*` | 网络会话、事件、规则、证据或订阅错误 |
| `ANNOTATION_NOT_FOREGROUND` | 目标标签页不是人类此刻选中且可见的前台标签，写标注零写入 |
| `ANNOTATION_REVISION_CONFLICT` | `expectRevision` 与当前文档 `revision` 不一致，写标注零写入并返回 `currentRevision` |

完整错误列表与字段以各功能文档为准；失败时 `details` 携带结构化证据，不要把错误文本当成结论。
