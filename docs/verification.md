# 验证与贡献

本页说明如何复现验证、如何判读结果，以及提交改动前必须做到什么。

## 环境

- Node.js 24.9 及以上（当前 DSH 发行版的 engines 要求；插件自身依赖原生 `WebSocket`）。
- 本地 Chrome / Chromium（可用 `DSH_UI_TESTING_CHROME` 指定）。
- 验收套件**自己启动**无头 Chromium 与本地靶机（只监听 `127.0.0.1`），不会驱动你正在使用的 DSH 实例。

## 主机侧套件

```bash
node tests/acceptance/run.mjs                  # 主验收：工具面、能力报告、渲染与 lossless 投影
node tests/acceptance/viewport.mjs             # 共享视口与画布
node tests/acceptance/capture-p0.mjs           # 截图采集
node tests/acceptance/t2-structured.mjs        # 结构化 GUI
node tests/acceptance/t3-vision.mjs            # 静态视觉
node tests/acceptance/t4-dynamic.mjs           # 动态行为 44 条门槛
node tests/acceptance/t4-visual-fixtures.mjs   # 动态视觉靶机
node tests/acceptance/t4-network-fixtures.mjs  # 动态网络靶机
node tests/acceptance/network-p0.mjs           # 网络 P0
node tests/acceptance/network-chain.mjs        # 电商链路场景
node tests/acceptance/devtools.mjs             # DevTools 独立窗口：Host 投影、真实连接、共存与端口重试
node tests/acceptance/pick-element-host.mjs    # 选元素 Host：坐标空间/命中/详情/可见区边界/只读语义
node tests/acceptance/workspace-isolation.test.mjs
node tests/acceptance/p0e-multitab.mjs           # P0-E Host：per-tab BUSY、browser_tabs、容量、T2 ref
node tests/acceptance/p0e-multitab-gui.mjs       # P0-E GUI：Agent A/B、active 状态、+、BUSY 提示
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

## 判读结果

每个套件把报告写到 `tests/acceptance/runs/<时间>-<pid>/`，文件名按套件是 `run-report.json` 或 `report.json`，并附日志。判读规则：

| 字段 | 含义 |
| --- | --- |
| `criteria` | 验收条目通过数 / 总数 |
| `requiredChecks` | 必需检查通过数 / 总数 |
| `failedChecks` | 必须为 0；非 0 即失败 |
| `notRunChecks` | 未运行项，**不算通过** |
| `exit 0` | 通过 |
| `exit 2` | 有必需项未运行（不是失败） |
| `exit 1` | 存在失败项 |

注意事项：

- `notRun` 必须原样报告，不能写成「已验证」。
- 截图成功、识别到候选、输入已派发，都不等于验收通过；看 `verdict`。
- 报告中的 `observed` 只代表那一次运行，不是长期保证。

## 真实验证（可选）

需要验证真实宿主行为时，建议起一个**隔离实例**（独立 `DSH_HOME`、独立端口、复制 profile、软链 `node_modules`），不要用你日常使用的实例。相关脚本：

```bash
node tests/acceptance/viewport-gui.mjs     # 隔离 DSH + 无头 Chrome 的面板断言
node tests/acceptance/canvas-wheel.mjs     # 隔离 DSH + 无头 Chrome 的滚轮消费/命中/A2 瞬态
node tests/acceptance/popup-tabs.mjs       # 隔离 DSH + 无头 Chrome 的内部标签页/target=_blank/关闭回收
node tests/acceptance/devtools-gui.mjs     # 隔离 DSH + 无头 Chrome 的 DevTools 弹窗断言
node tests/acceptance/pick-element-gui.mjs # 隔离 DSH + 无头 Chrome 的选元素模式/悬浮/加入聊天框断言
node tests/acceptance/verify-3081.mjs      # 隔离宿主 HTTP 集成
```

`viewport-gui.mjs` 与 `verify-3081.mjs` 不会自己重启实例；改了 `index.js` 或 `client.js` 后必须先重启隔离实例再取证。

`devtools.mjs` 在 fake ctx 上驱动真实无头 Chromium：验证 `ui.devtools` 的 scoped-only 投影、固定 loopback 端口与精确 allow-origin、DevTools 前端真实连接（shadow DOM 中出现目标标记）、screencast 与 T2 共存，以及端口冲突/端点身份不符时的有界重试。`devtools-gui.mjs` 自己启动私有隔离 DSH 与无头 Chrome，验证真实「更多 → 打开调试工具」点击、`opener=null`/无 Referer、弹窗被拦截时的本地提示、标注模式禁用与预览共存。它只证明弹窗 target 与内容，不证明真实桌面窗口外观；GUI 内 T2 与非 loopback GUI 按 `NOT_RUN` 原样报告，不要用推断补成通过。

`pick-element-host.mjs` 在 fake-Cordis harness 上驱动真实无头 Chromium 与仓库 fixture：先实证 `DOM.getNodeForLocation` 是文档坐标（且只命中当前可见区）、`DOM.getBoxModel` 是根帧视口坐标，再断言固定/滚动/空白/越界命中、detail 的 selector/selectorQuality、outerHTML/text 的显式截断与长度字段、role/name、shadow（open/closed）、跨帧 `reason:"frame"`、主帧未知 fail-closed、`scroll`/`loaderId` 回显与导航一致性，以及只读语义（不进 `run` 队列、不 ensure、不占租约、不写 `lastError`、不加页）。要求项计 140 条，`NOT_RUN` 仅保留 iframe 内部元素与 SSR 文档两项。不要用「返回了元素」代替「与真实 DOM 读数一致」。

`pick-element-gui.mjs` 默认自启私有隔离 DSH（临时 `DSH_HOME`、随机端口，绝不用 3080/3081）并另开无头 Chrome：从右侧边栏 guide 的 `debug-view` 打开面板、地址栏导航到 `/pick-element.html`，断言入口三态与互斥（标注/尺寸调整双向）、悬浮框的 `data-utb-pick-*` 与按面板 `view`/图片几何计算的屏幕矩形误差 ≤2px、`detail:false` 的 hover 不带 selector、点击后 `[data-composer-input]` 的 `@` 元素引用 chip（紧凑标签 + 模型文本由 codec.serialize 提供，经测试钩子核对完整块）、强制降级时的完整文本块、发送后聊天记录的文本规则（块→紧凑 chip 的匹配与注册，含长 selector/截断样本）、成功提示与模式退出、聊天框焦点、Esc/指针离开、滚轮滚动后按新画布原点重取、以及退出后真实点击使 fixture 计数器 1→页面输入恢复；悬停/选元素期间页面计数保持 0。`NOT_RUN`（画布平移 O≠0、主面板 `recent`、DPR≠1/非 loopback、iframe/closed shadow 选取）必须原样报告。

下拉浮层可单独验收：`node tests/acceptance/pick-element-gui.mjs --select-only`。默认仍使用隔离 Host；显式设置 `DSH_SELECT_GUI_URL` 可连接已有 Host，`DSH_SELECT_GUI_LOG` 指向其启动日志，`DSH_SELECT_GUI_SESSION` 选择会话标题，`DSH_SELECT_GUI_RETURN_URL` 可在验收后恢复页面地址。已有 Host 模式会导航选定会话的内嵌页面，不重启或关闭该 Host；认证仅保留在内存。检查覆盖真实 `/element` 响应、面板选项、重复 value、禁用项/组、键盘兜底、焦点转移、200 项上限、导航后旧目标拒绝，以及 Ctrl+A 和字符输入。浮层来自面板 DOM，不能用目标页面截图代替面板截图。

`popup-tabs.mjs` 额外覆盖 Web 视图的 无头/有头 切换（默认无头、切到有头后 Host `ui.display.mode=headed`、离屏窗口已隐藏 `display.hidden=true`、有头能打开页面、持久 profile 存在、切回无头可继续打开页面）。有头模式默认离屏并尝试从窗口管理器隐藏，但测试仍可能影响桌面环境，默认记 `NOT_RUN`；设 `DSH_UI_TESTING_HEADED_TEST=1` 才实际运行。

`canvas-wheel.mjs` 也自启私有隔离 DSH：用 3000px 长页、O=0/±、内容/blank wheel 和真实点击，断言宿主/舞台滚动链不变、内容 wheel 恰派发一次、`p=q+O` 误差 ≤1px、点击只增目标按钮、A2 瞬态 `maxDeviation`/`extraBlank` 为 0；实时帧 barrier/seed 与 BUSY 注入等无法稳定复现的项按 `NOT_RUN` 报告，不能用“收到 wheel/显示提示”冒充通过。

`popup-tabs.mjs` 自启私有隔离 DSH，用同时含 `target=_blank`、`rel=noopener`、真实 `window.open` 与自动定时 `window.open` 的本地 fixture：验证单标签时标签栏即显示且开关可收起/展开、`+` 只在栏内（工具栏无常驻 `+`）、真人点击后内部标签栏从 1→2、新标签 active、原 A 标签 URL/history 不变、A/B 切换与 B→C→后退、B active 时真实坐标点击命中 B、开关在标注左侧且隐藏不丢页面、关闭 child 发 binding `/close` 并回 A、非法/无 ticket/超容量阻断并提示、Host Agent `browser_state` 仍 primary。跨 workspace、刷新恢复、Agent lease 竞态等按 `NOT_RUN` 原样报告；Chrome 自动弹窗被 popup blocker 拦截时只证明“不新增标签”，不冒充可见 notice。

## 本地生成物

以下内容由运行/验收产生或属于本机资料，不纳入版本控制：

```text
tests/acceptance/runs/       验收报告与日志（运行时生成）
tests/acceptance/evidence/   人工留存的证据与截图（运行时生成）
output/                      插件运行输出（运行时生成）
```

## 提交前检查

1. 改动范围与需求一致，不做顺手重构。
2. 工具名、schema、能力报告、内置 Skill 与文档同步更新（同一事实多处出现时必须一起改）。
3. 至少跑通受影响的套件；行为变化要在 PR 描述里给出命令与结果。
4. 未验证的部分明确写「未验证」，不得用推断代替结论。
5. 不提交凭据、个人设备数据、未脱敏的认证流量或本机绝对路径。

## 贡献方向

最有价值的是可复现的问题：DSH 集成差异、平台可行性、无障碍/DOM 回退案例、安全威胁模型，以及具体的 UI 验收场景。

提 issue 时请附 DSH 版本/commit、平台与运行时版本、复现步骤、预期与实际结果，以及脱敏后的证据。
