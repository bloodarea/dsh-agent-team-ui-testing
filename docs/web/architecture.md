# Web 运行时架构

通用职责、配置与适配器契约见[架构](../architecture.md)。Web 的通信接口使用 CDP，调试执行后端为 Chromium 内置的 DevTools 后端，目标运行时运行浏览器页面。独立 HTTP 工具使用自己的 HTTP(S) 客户端。

## 模块

```text
package.json           DSH bundle 清单（dsh.bundle.patch + dsh.client，platform: web）
cordis.patch.yml       注册插件：id = ui-testing-browser
index.js               Host 入口：环境注册项装配、工具准入/披露/注册（定义来自 Web 环境）、
                       scoped HTTP 认证、控制面（/config、/readiness、诊断）路由与页面路由委托、
                       作用域/主体解析、证据壳与配置切换的清理编排
targets/web/host.js    Web 运行时：BrowserHost（Chromium 进程）、Runtime（页面 + CDP 会话）、
                       RuntimeRegistry（页面组、单写租约、P0-E 投影）、独立 HTTP 客户端、
                       T2 结构投影、标注文档校验、采集请求归一、元素选取
targets/web/tools.js   Web 工具面：执行工具与发现入口的 schema + handler、T3 视觉链路；
                       由 Host 注入 log/组合根/披露/页面 registry 后返回定义表
targets/web/invoke.js  Web 派发管线：页面/标签解析、执行类别分支、串行队列与单写租约、
                       派发前复核、handler 执行与活动标记；只返回平台事实，证据壳仍在 Host
targets/web/routes.js  面板页面路由：/frame、/state、/metrics、/element、/select、/annotations、
                       /input、/screenshot、/tabs、/close 等；认证与控制面仍由 Host 负责
targets/web/environment.js       Web 环境注册项：能力探针、P0 派发、租约族、逐 provider 就绪卡片、
                                操作表、provider 门禁与诊断探针声明
targets/web/frame-transport.js   帧推送 WebSocket 升级接线（挂载/退役/释放）
targets/web/scope-target.js      作用域→页面条目的唯一规则（binding 不新建、session 跟随选中标签）
targets/web/transition.js        环境切换清理：取消在途、轮换选中标签、关闭页面
integration/           跨环境组合根：权威配置、adapter registry、工具准入、逐次 adapter 调度、
                       `/config` `/config/select` `/readiness` 路由与 Skill provider；只 import core/，
                       平台实现一律通过环境注册目录解析
core/                  环境中立契约：身份/几何/时钟/证据/错误、配置解析与持久化、registry、
                       六轴就绪、P0-A～E 中立模型（`core/p0.js`）、多目标管理接口
                       （`core/target-tabs.js`）、环境注册项契约与惰性目录（`core/environments.js`）
targets/web/           Web 三面 TargetAdapter / CapabilityAdapter / P0Provider（注入 Runtime，不直接发 CDP）
targets/fake/          仅测试的确定性假环境（test-only，不是真实平台实现）及其注册项
browser-safety.js      错误类型与分类、CDP 封装、取消与定时器清理、URL 脱敏、目标/DNS 校验
capture-p0.js          PNG 结构/CRC/解码、像素统计、尺寸校验、映射投影、原子安全写入
network-p0.js          网络事件与会话、配额、分析、链路、规则、JSONL/HAR、订阅（零依赖）
vision-t3.js           PNG 编解码、裁剪/缩放/预处理/标注、YIQ 差异、识别、映射、产物存储
vision-baseline.js     受管基线：scope 根、不可变 revision、HEAD CAS、墓碑
dynamic-t4.js          T4 纯核心：帧存储、事件日志与时钟锚点、七类分析、六向关联、JPEG 解码
context-menu.js        页面右键事务、最终取消状态观测、默认菜单投影与短期动作令牌
frame-source.js        最新帧缓存与统计（与传输、UI 解耦）
frame-push.js          同源 WebSocket 推帧：握手、合并推送、背压丢帧、鉴权
client.js              公共视图外壳、环境正文/标注映射接点、共享尺寸与标注组件；
                       Web 帧传输、输入与 DevTools（当前仍在同文件、组件闭包内接线）
skills/ui-testing-web/  Web 环境 Agent 操作手册
skills/ui-testing-common/ 跨环境公共规则（证据、判定、报告、安全）
skills/ui-testing-fake/    test-only 假环境说明（生产默认不可发现）
tests/                 验收套件与确定性靶机
```

`index.js` 只负责 Host 侧的装配与准入：注册工具、解析作用域与主体、认证并路由 HTTP、聚合就绪；Web 运行时（进程、页面、租约、CDP）与工具 handler 在 `targets/web/`。纯算法与状态机都在独立模块里，可脱离浏览器单测。`core/` 不 import `index.js`、`targets/` 或任何平台实现；`targets/web/` 只 import `core/`、中性平台助手（`browser-safety.js`、`select-control.js`、`context-menu.js`）、Node 内置模块与同目录模块，平台能力通过注入的 dispatch 使用，Host 服务通过注入的查询函数使用。

环境实现由注册项装配（`core/environments.js`）：每项声明能力、工具描述、provider 门禁、诊断探针与 `create(api)` 惰性构造入口；公共组合根按环境 id 解析，新增环境不需要修改组合根。

Web 专用模块（帧源、采集、T3 视觉、基线、P0 网络）与 Web 三面 adapter 在首次真正需要时才加载/创建；Web 被禁用时既不加载这些模块，也不创建 adapter、不启动 Chromium。

## 运行时模型

```text
DSH Agent / Agent Team
        │  工具调用
        ▼
   BrowserHosts[provider] ── 每个运行环境一个浏览器（默认无头；Web 视图可切有头）/ 每个 provider 一份 profile
        │
        ├─ Runtime（每个 DSH 工作区一个 primary）
        │    ├─ 独立 page：URL、视口、历史、网络缓冲
        │    ├─ 权威 view 与 revision
        │    ├─ 串行队列 + single-owner lease
        │    └─ 帧、标注、动态会话、网络会话
        │
        ├─ 受控 popup child Runtime（同工作区，每个内部标签一个）
        │    └─ 独立 page/队列/lease/view/历史/标注/网络；不计入 Agent 默认目标
        │
        └─ 调试面板（primary 与内部标签页的视图）
```

- **隔离粒度**：页面、URL、视口、历史、网络缓冲、租约按 Runtime 隔离；同一 DSH 工作区的 primary 与 popup child 共享 profile，但各有独立页面状态。**Cookie 与存储由 profile 共享**，不是登录态隔离。
- **内部标签页**：真人触发的 `target=_blank` / `window.open` 会把原生 popup target 接管为同工作区的 child Runtime（不重新发请求），面板在地址栏下方增加标签；child 由 binding 路由，primary 保留原页。自动弹窗、无真人输入、非法目标与超容量仍阻断。每 Agent 会话独立保存两个选择：写工具用 workSelection（无选择时 primary），读工具优先用 observationSelection（未设置时回退 workSelection），`browser_tabs` 负责 list/current/select/open/close/wait/acquire/release/transfer。页面组按 (workspace, provider, 团队根) 划分：同 root 共享一组页，跨 root 的目标一律 not-found 语义；谁能写由 root → 角色 → 控制权/版本决定，15 秒租约只表示"短暂忙"。GUI active 独立，GUI 切标签不会改变 Agent 的选择。
- **串行化**：所有会改动页面的操作走该 Runtime 的串行队列；只读诊断（`browser_state`、`browser_capabilities`、`browser_viewport get`、离线基线读取）不进队列、不占租约。
- **租约**：同一标签同一时刻只有一个 owner；不同标签可由不同 Agent 并行，同标签冲突返回 `BUSY`。
- **懒启动**：只有真正需要页面的动作才启动 Chromium；诊断类工具不启动。
- **运行环境（provider）归属**：页面容器按 provider 分开（`hosts[provider]`），entry 键是 `(provider, workspace)`，所以同一工作区在不同 provider 下是两套互不影响的页面/租约/ref；页面总预算按 provider 求和后仍受同一个 `maxPages` 约束。目标环境身份（`environment` / `adapterId`）不因此改变，仍是 `"web"`。跨 provider 的预览分栏尚未实现。

### 面板 HTTP 路由

认证 scoped GUI 使用同一前缀 `/plugins/ui-testing` 的 HTTP 路由（legacy 客户端按既有闸处理）：

- 读：`GET /state`、`GET /frame`、`GET /metrics`；
- 页面操作（串行队列 + single-owner lease）：`POST /ensure`、`/navigate`、`/reload`、`/history`、`/viewport`、`/input`、`/context-menu`、`/context-action`、`/eval`、`/screenshot`、`/tabs`、`/close`；其中 `/screenshot` 的 `{includeAnnotations:true}` 复用 Agent 截图的离屏合成器（`capture.annotations` 随响应返回），供标注栏「截图」按钮把页面+标注交给聊天框附件；空 body 与 `{canvas:true}` 的旧回复形状不变；
- 标注写面：`POST /annotations` 是面板写面（Agent 侧写同一份文档走 `browser_annotation` 工具，不经 HTTP 路由）；
- 只读元素选取：`POST /element`（文档 CSS px → 命中元素；不 ensure、不进串行队列、不占租约、不写 `lastError`、不记录客户端指标；`GET /element` 固定 405）。语义与限制见 [选元素加入聊天框](element-picker.md)。

只读诊断（`/state`、`/metrics`、`/element` 与离线基线读取）不进页面队列、不占租约。

## 外部 DevTools

面板的「更多 → 打开调试工具」直接加载 Chrome 自带的 DevTools 前端，连接当前 Runtime 的 page target。它不经过插件工具、串行队列或 single-owner lease：按工作区选择 target 是**路由正确性**，不是 CDP 权限隔离。

- Host 为每次 Chromium 启动选择一个 loopback 端口，显式传 `--remote-debugging-port` 与精确的 `--remote-allow-origins=http://127.0.0.1:<port>`；不使用通配 Origin。
- 就绪判据是 IPv4 `/json/version` 与本次子进程 stderr 报出的 browser 端点身份一致；端口竞争、仅 IPv6 或身份不符会在预算内换端口重试。
- 认证 scoped GUI 的 `ui.devtools` 提供 `{available,url,pageGeneration,reason}`；`state()`、`browser_state`、工具值、metrics 与日志都不含该 URL。
- 仅支持 GUI 与 DSH 同机、经 loopback 访问；远程 GUI、非 Chromium 浏览器和旧版 Chrome 未承诺。

## 数据流

1. Agent 调用工具 → 参数预检（纯函数，不碰浏览器）。
2. 进入 Runtime 队列 → 获取租约 → 必要时 ensure 页面。
3. 执行 CDP 操作，收集证据（目标身份、前后状态、派发事实、网络增量）。
4. 结果经 lossless JSON 投影返回，图像以附件形式交付。
5. 失败抛类型化 `BrowserError`，证据放在 `details`。

## 证据与状态

- **共享 view**：面板与 Agent 读写同一对象，用 `expectedRevision` 做 CAS。
- **标注**：独立文档，按工作区存放；人类在面板经认证的 `POST /annotations` 写，Agent 经 `browser_annotation` 写**同一份**文档（前台标签心跳门禁 + `expectRevision` CAS）。
- **视觉产物**：按 scope 隔离、有配额、重启失效。
- **网络证据**：JSONL 保真、HAR 为 1.2 子集；只写持久根。
- **帧**：有界存储，带淘汰与空档计数。

## 安全

- 导航只允许授权目标：默认 loopback，私网需 `DSH_UI_TESTING_ALLOW_PRIVATE=1`；校验 DNS、重定向与弹窗。
- 页面访问限定在 DSH 工作区 scope 内，HTTP 路由需认证。
- 不读取调用方提供的任意路径；截图与证据文件写入受控根，权限 0600 且不覆盖。
- 截图与网络正文默认不脱敏。

## 相关文档

- [Web 适配器实现与调用链](adapters.md)
- [Web 调试面板](debug-panel.md)
