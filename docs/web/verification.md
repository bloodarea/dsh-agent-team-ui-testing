# Web 验证

通用判读、贡献检查与改动生效方式见[验证与贡献](../verification.md)。

## 环境

- Node.js 24.9 及以上（当前 DSH 发行版的 engines 要求；插件自身依赖原生 `WebSocket`）。
- 本地 Chrome / Chromium（可用 `DSH_UI_TESTING_CHROME` 指定）。
- 验收套件**自己启动**无头 Chromium 与本地靶机（只监听 `127.0.0.1`），不会驱动你正在使用的 DSH 实例。
- 在 Agent 的文件沙箱里跑套件时，Chrome 建不了 setuid 命名空间也写不了 `/dev/shm`，启动会失败（`CDP_DISCONNECTED`，日志里是 `Zygote process exited prematurely`）。此时用 `DSH_UI_TESTING_CHROME=$PWD/tests/acceptance/chrome-wrapper.sh` 指定仓库自带的兼容包装：它把同一个真实二进制加上 `--no-sandbox`、`--disable-dev-shm-usage`、`--disable-crash-reporter` 三个参数后原样转发其余参数。这不是插件的运行要求——在非沙箱的普通 DSH 进程里默认二进制可以直接跑，`run.mjs` 也是先试真实默认路径、失败才回退到该包装并把它记进报告。

## 主机侧套件

```bash
node tests/acceptance/run.mjs                  # 主验收：工具面、能力报告、渲染与 lossless 投影
node tests/acceptance/viewport.mjs             # 共享视口与画布
node tests/acceptance/capture-p0.mjs           # 截图采集
node tests/acceptance/annotation-capture.mjs   # includeAnnotations：六形状、region/scale 映射与标注文档证据
node tests/acceptance/game-target.mjs        # 人工靶机 tests/manual-target/game-target.html 的自评在真实浏览器里跑到 8/8
node tests/acceptance/input-state.mjs        # browser_input 状态机：多键按住/修饰键合成、相对鼠标、光标探测
node --test tests/contracts/panel-cursor.test.mjs # 预览光标：尾沿查询、换帧重试、迟到响应与生命周期失效
node --test tests/contracts/panel-annotation-selection.test.mjs # 标注移动：同步回复、取消、切页保留与提交边界
node --test tests/contracts/panel-address-bar.test.mjs # 地址栏历史：栈语义、7 条上限、持久化与接线
node tests/acceptance/panel-address-gui.mjs  # 真实面板：历史下拉顺序/去重/持久化、Esc 关闭与「转到」按钮
node tests/acceptance/gui-annot-shot.mjs   # 面板「截图」：/screenshot 的 includeAnnotations 合成、旧回复形状与拒绝
node tests/acceptance/annotation-agent.mjs     # Agent 标注读写：四类动作、样式映射、前台门禁、限额与 revision CAS
node tests/acceptance/audio-preview.mjs        # 页面声音到达面板：格式/幅度/静音页/导航重置/媒体元素
node tests/acceptance/audio-panel-player.mjs   # 面板播放器：按包排程、幅度还原、reset、禁用与坏包
node tests/acceptance/panel-audio-button.mjs    # 声音开关位置：地址栏内侧、历史按钮左侧的实测几何与截图
node tests/acceptance/t2-structured.mjs        # 结构化 GUI
node tests/acceptance/t3-vision.mjs            # 静态视觉
node tests/acceptance/t4-dynamic.mjs           # 动态行为 44 条门槛
node tests/acceptance/t4-visual-fixtures.mjs   # 动态视觉靶机
node tests/acceptance/t4-network-fixtures.mjs  # 动态网络靶机
node tests/acceptance/network-p0.mjs           # 网络 P0
node tests/acceptance/network-chain.mjs        # 电商链路场景
node tests/acceptance/devtools.mjs             # DevTools 独立窗口：Host 投影、真实连接、共存与端口重试
node tests/acceptance/pick-element-host.mjs    # 选元素 Host：坐标空间/命中/详情/可见区边界/只读语义
node tests/acceptance/context-menu-host.mjs    # 页面右键：真实取消状态/iframe/默认菜单动作/过期令牌
node tests/acceptance/workspace-isolation.test.mjs
node --test tests/contracts/target-tabs.test.mjs # P0-E 公共管理接口：非 Web 参数、可选动作与 Web 接线
node --test tests/contracts/panel-tabs.test.mjs # 公共标签栏与环境 provider 隔离
node tests/acceptance/p0e-multitab.mjs           # P0-E Web Host：per-tab BUSY、browser_tabs、容量、T2 ref
node tests/acceptance/p0e-multitab-gui.mjs       # P0-E GUI：Agent A/B、active 状态、+、BUSY 提示
node tests/acceptance/tab-lock.mjs               # 标签保活锁：锁定跳过 idle 回收、解锁后恢复、锁无 Agent 工具
node --test tests/acceptance/runtime-faults.test.mjs
node --test tests/dynamic-t4.test.mjs          # T4 纯核心单测
node --test tests/network-p0.test.mjs          # 网络纯核心单测
node tests/acceptance/check-skill.mjs          # Skill 结构、引用、工具名与清单一致性
node tests/acceptance/check-skill-registry.mjs # 真实 SkillRegistry 注册与加载
node --test tests/contracts/*.test.mjs         # 跨环境契约：core/config/P0/fake/Web adapter
node --test tests/contracts/web-provider-config.test.mjs  # provider 配置形状、选择链、旧配置兼容、revision/CAS
node --test tests/contracts/web-provider-runtime.test.mjs # provider 门禁、hosts[provider]、页面预算、providerResolved
node --test tests/contracts/web-provider-edge.test.mjs    # Edge 候选/覆盖变量/身份判定（注入 platform 与 env，不启动进程）
node --test tests/contracts/isolation.test.mjs # 真实 ToolsService/SkillRegistry 的 schema 与 Skill 隔离
node tests/acceptance/cross-environment.mjs    # 配置 CAS/持久化/六轴就绪/GUI 旁路/不启动浏览器
node tests/acceptance/foundation-isolation.mjs # A03/A04/A05/A08/A09/A10/A11/A12/A13/A14 逐项阻断复核（离线，不发模型请求）
node tests/acceptance/settings-config-gui.mjs  # 隔离 DSH GUI：设置页读取/写入/revision/六轴/两层开关
node tests/acceptance/audit-isolated-agent.mjs --group g1 --prompt <prompt.txt> \
  --expect-tools browser_navigate,browser_snapshot      # 隔离 DSH 实例里跑真实 Agent 轮次并判定 browser_* 结果
node tests/acceptance/audit-payload-capture.mjs         # 本地录制代理抓真实模型请求体（工具声明/Skill 目录）
node tests/acceptance/audit-a05-annotations.mjs         # 标注写面（面板 scoped 路由）与目标绑定探针
node tests/acceptance/audit-a11-scope.mjs               # 会话级环境选择：控制面/工具快照/声明层一致性
```

**串行执行**：这些套件各自启动 Chromium 与靶机，并行会让端口、profile 与 CPU 互相干扰，计数不可信。

## 真实验证（可选）

需要验证真实宿主行为时，建议起一个**隔离实例**（独立 `DSH_HOME`、独立端口、复制 profile、软链 `node_modules`），不要用你日常使用的实例。相关脚本：

```bash
node tests/acceptance/viewport-gui.mjs     # 隔离 DSH + 无头 Chrome 的面板断言
DSH_VIEWPORT_GUI_ONLY=V16c node tests/acceptance/viewport-gui.mjs # 选择手感：实时框选、组合键、拖动/取消、键盘与缩放命中
DSH_VIEWPORT_GUI_ONLY=V1b node tests/acceptance/viewport-gui.mjs  # 空白画布隔离：切到无视图环境后零视口写入/零截图/零状态轮询/零标注同步
node tests/acceptance/input-delivery.mjs   # 输入送达、长文档与模态框滚动、部分手势保护和无头滚轮失败不重载
node --test tests/contracts/panel-view-registry.test.mjs # Web 视图重建后滚轮监听的绑定与清理
node tests/acceptance/headed-input-x11.mjs # Linux/X11 有头窗口、面板输入路由及故障注入
node tests/acceptance/canvas-wheel.mjs     # 隔离 DSH + 无头 Chrome 的滚轮消费/命中/A2 瞬态
node tests/acceptance/popup-tabs.mjs       # 隔离 DSH + 无头 Chrome 的内部标签页/target=_blank/关闭回收
DSH_UI_TESTING_CHROME=$PWD/tests/acceptance/chrome-wrapper.sh node tests/acceptance/tab-lock.mjs # 保活锁 Host 侧（idle 压到 1s，锁定与解锁对照）
node tests/acceptance/devtools-gui.mjs     # 隔离 DSH + 无头 Chrome 的 DevTools 弹窗断言
node tests/acceptance/pick-element-gui.mjs # 隔离 DSH + 无头 Chrome 的选元素模式/悬浮/加入聊天框断言
node tests/acceptance/verify-3081.mjs      # 隔离宿主 HTTP 集成
```

`viewport-gui.mjs` 与 `verify-3081.mjs` 复用隔离实例。改 Host 后应先重启该实例。改客户端后按[客户端开发](../verification.md#客户端开发)构建，并在取证前刷新页面。

`devtools.mjs` 在 fake ctx 上驱动真实无头 Chromium：验证 `ui.devtools` 的 scoped-only 投影、固定 loopback 端口与精确 allow-origin、DevTools 前端真实连接（shadow DOM 中出现目标标记）、screencast 与 T2 共存，以及端口冲突/端点身份不符时的有界重试。`devtools-gui.mjs` 自己启动私有隔离 DSH 与无头 Chrome，验证真实「更多 → 打开调试工具」点击、`opener=null`/无 Referer、弹窗被拦截时的本地提示、标注模式禁用与预览共存。它只证明弹窗 target 与内容，不证明真实桌面窗口外观；GUI 内 T2 与非 loopback GUI 按 `NOT_RUN` 原样报告，不要用推断补成通过。

`pick-element-host.mjs` 在 fake-Cordis harness 上驱动真实无头 Chromium 与仓库 fixture：先实证 `DOM.getNodeForLocation` 是文档坐标（且只命中当前可见区）、`DOM.getBoxModel` 是根帧视口坐标，再断言固定/滚动/空白/越界命中、detail 的 selector/selectorQuality、outerHTML/text 的显式截断与长度字段、role/name、shadow（open/closed）、嵌套 same-process frame 命中（顶层视口 rect、该 frame 的 `loaderId`、select 投影与写回、伪造 loaderId 的 `stale-target`）、主帧未知 fail-closed、`scroll`/`loaderId` 回显与导航一致性，以及只读语义（不进 `run` 队列、不 ensure、不占租约、不写 `lastError`、不加页）。要求项计 145 条，`NOT_RUN` 只保留 SSR 文档一项（仓库内没有该 fixture）。不要用「返回了元素」代替「与真实 DOM 读数一致」。

`pick-element-gui.mjs` 默认自启私有隔离 DSH（临时 `DSH_HOME`、随机端口，绝不用 3080/3081）并另开无头 Chrome：从右侧边栏 guide 的 `debug-view` 打开面板、地址栏导航到 `/pick-element.html`，断言入口三态与互斥（标注/尺寸调整双向）、悬浮框的 `data-utb-pick-*` 与按面板 `view`/图片几何计算的屏幕矩形误差 ≤2px、`detail:false` 的 hover 不带 selector、点击后 `[data-composer-input]` 的 `@` 元素引用 chip（紧凑标签 + 模型文本由 codec.serialize 提供，经测试钩子核对完整块）、强制降级时的完整文本块、发送后聊天记录的文本规则（块→紧凑 chip 的匹配与注册，含长 selector/截断样本）、成功提示与模式退出、聊天框焦点、Esc/指针离开、滚轮滚动后按新画布原点重取、以及退出后真实点击使 fixture 计数器 1→页面输入恢复；悬停/选元素期间页面计数保持 0。`NOT_RUN`（画布平移 O≠0、主面板 `recent`、DPR≠1/非 loopback、closed shadow 选取）必须原样报告；iframe 内 `<select>` 的浮层与写回由 `--select-only` 的 S16–S17a 真实覆盖，页面右键菜单由同一次运行覆盖（可信 `contextmenu`、页面自绘菜单可见可点、默认区显示面板菜单、重新加载/复制/Esc/离图释放、预览内不出现宿主菜单、预览外仍冒泡），契约见[页面右键菜单](panel-context-menu.md)。

下拉浮层可单独验收：`node tests/acceptance/pick-element-gui.mjs --select-only`。默认仍使用隔离 Host；显式设置 `DSH_SELECT_GUI_URL` 可连接已有 Host，`DSH_SELECT_GUI_LOG` 指向其启动日志，`DSH_SELECT_GUI_SESSION` 选择会话标题，`DSH_SELECT_GUI_RETURN_URL` 可在验收后恢复页面地址。已有 Host 模式会导航选定会话的内嵌页面，不重启或关闭该 Host；认证仅保留在内存。检查覆盖真实 `/element` 响应、面板选项、重复 value、禁用项/组、键盘兜底、焦点转移、200 项上限、导航后旧目标拒绝，以及 Ctrl+A 和字符输入；同一次运行还会用 `/panel-context.html` 验证页面自绘菜单与默认面板菜单、实际刷新/复制、Esc/离图释放和预览内外的宿主菜单隔离；加 `--context-only` 可单独运行右键 GUI 分支。浮层来自面板 DOM，不能用目标页面截图代替面板截图。

`headed-input-x11.mjs` 使用本地 X11 和临时 Chrome profile。运行前让另一个桌面窗口获得焦点。套件检查冷启动、面板心跳、切页、可信点击和文本输入前后的活跃窗口与键盘焦点，同时读回原生窗口的零透明度和空绘制形状，并检查预览出帧、模式切换及丢输入时的文档保留。有条件时在独立的图形显示环境中运行，避免启动时的原生窗口影响日常桌面。原生弹窗在初次激活后单独检查再次前置的焦点行为。`xprop`、`xwininfo` 与 `xdotool` 仅用于验收，插件运行不依赖它们。

`popup-tabs.mjs` 额外覆盖 Web 视图的无头和有头切换。验证有头页面能打开、`display.hidden=true`、持久 profile 存在，并在真实预览里点击和滚动，读回可信事件、点击计数、滚动位置及文档身份。切回无头后再次验证可以打开页面。此分支可能影响桌面环境，默认记 `NOT_RUN`，设 `DSH_UI_TESTING_HEADED_TEST=1` 才运行。

`canvas-wheel.mjs` 也自启私有隔离 DSH：用 3000px 长页、O=0/±、内容/blank wheel 和真实点击，断言宿主/舞台滚动链不变、内容 wheel 恰派发一次、`p=q+O` 误差 ≤1px、点击只增目标按钮、A2 瞬态 `maxDeviation`/`extraBlank` 为 0；实时帧 barrier/seed 与 BUSY 注入等无法稳定复现的项按 `NOT_RUN` 报告，不能用“收到 wheel/显示提示”冒充通过。

`popup-tabs.mjs` 自启私有隔离 DSH，用同时含 `target=_blank`、`rel=noopener`、真实 `window.open` 与自动定时 `window.open` 的本地 fixture：验证单标签时标签栏即显示且开关可收起/展开、`+` 只在栏内（工具栏无常驻 `+`）、真人点击后内部标签栏从 1→2、新标签 active、原 A 标签 URL/history 不变、A/B 切换与 B→C→后退、B active 时真实坐标点击命中 B、开关在标注左侧且隐藏不丢页面、关闭 child 发 binding `/close` 并回 A、非法/无 ticket/超容量阻断并提示、Host Agent `browser_state` 仍 primary。跨 workspace、刷新恢复、Agent lease 竞态等按 `NOT_RUN` 原样报告；Chrome 自动弹窗被 popup blocker 拦截时只证明“不新增标签”，不冒充可见 notice。
