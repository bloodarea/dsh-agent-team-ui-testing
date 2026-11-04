# T2 · 结构化 GUI（已实现并验收）

**实现状态：已实现并已验收（verified）。** 本轮（T2 时点）新增 7 个工具，工具总数 9 → **16**（T3 收口后总面为 **22 = 9 T1 + 7 T2 + 6 T3**）：`browser_snapshot`、`browser_click`、`browser_type`、`browser_scroll`、`browser_fill_form`、`browser_node_state`、`browser_wait_for`。权威契约是仓库 `docs/t2-structured-gui.md`；能力 id 为 `web.t2.snapshot/click/type/scroll/fill_form/node_state/wait_for`，聚合项 `web.t2.structured-dom`。

> 验收口径：`tests/acceptance/t2-structured.mjs` 已跑绿（Lead 独立复跑）——`tests/acceptance/runs/2026-11-01T03-41-31-025Z-39784/run-report.json`：探针 38（pass 37 / fail 0 / notRun 1 = C38 套件边界）、必需检查 **260/260**、criteriaCovered 38、failedChecks 0、exit 0（此前一轮 233/233：`runs/2026-10-31T19-25-29-077Z-54114`）。优化实测（同 fixture/默认参数）：nodeCount 421→275、tree 14432→9254 字节、`- text` 232→91，两次捕获 tree/digest 一致。§9.38 **真实宿主**已由 Lead 在 DSH 3080（pid <pid>，2026-11-01 10:40:04 重载）的真实 Agent 会话验收：`tests/acceptance/evidence/t2-real-host-2026-11-01.md` **14/14 检查行通过**（16 工具注册、snapshot→click→type→fill_form→scroll→wait→node_state、页面真值与 `window.__t2` 核对、覆盖目标 NOT_INTERACTABLE、导航后 REF_STALE、T1 未回归），套件内 C38 仍记 NOT_RUN 属 fake-ctx 套件边界。**注意：该记录属优化前构建**；优化构建（快照压缩 + scroll 硬化）已进程内 260/260 通过，但真实宿主**定向复验 5 项仍待**（snapshot 压缩形态、同名/独立节点 refs、离屏拒绝 + hint + 恢复、持续运动 `unstable`、T1 未回归）——未完成前不得写成“优化后真实宿主已验证”。仍未验证：provider 图像可见性（T1 遗留）、closed-shadow「不产生 ref」细分（仅 advisory 检查）。运行态仍以 `browser_capabilities` 与真实调用结果为准，本文与 manifest 都不是可用性证明。

## 能力（已实现）

| 能力 | 工具 | 说明 |
| --- | --- | --- |
| 语义快照 | `browser_snapshot` | 主 frame AX 树 → 缩进文本树 + `refs` 表；`maxNodes`/`depth`/`boxes` 可控；`snapshotId`（`s1`、`s2`…）、`digest=sha256(tree)` 前 16 位、`truncationReasons`、`coverage{frame:'main',shadow:'ax-backed'}` |
| 定位与点击 | `browser_click` | `ref`/`selector` 恰一；滚动进视口 + 两帧稳定 + 命中校验后派发 CDP 真实鼠标事件；支持 button/clickCount/modifiers |
| 文本输入 | `browser_type` | 原生 `input[type=text|search|email|url|tel|password]` 与 `textarea`；replace/append、可选 Enter 提交；焦点与值双重校验 |
| 滚动 | `browser_scroll` | `direction`（wheel，`cdp-input`）或 `to:top|bottom`（精确 `scrollTo`，`dom-scroll`）；返回 before/after/moved |
| 表单批处理 | `browser_fill_form` | 1–20 项，`type` = textbox/checkbox/radio/combobox/slider；整批预检后再执行，部分生效不回滚 |
| 节点状态 | `browser_node_state` | 现场读 NodeState（可见/启用/只读/勾选/焦点/bbox/hitTarget/滚动…），可编辑值脱敏 |
| 条件等待 | `browser_wait_for` | text / textGone / 目标 state（visible、enabled、checked、valueEquals，多 key 为 AND）；超时抛 `WAIT_TIMEOUT` |

组合出的交互流程：`snapshot → ref/selector → 动作 → before/after 证据 → wait_for/node_state → 页面真值断言`。派发成功与业务断言分开记录，没有自动 PASS 字段。

## 交付条件（本轮已满足的部分）

- **注册面**：7 个工具经既有 `register()` 注册，目标用字符串 `ref`/`selector`（无 Target 对象），共用 action envelope 与 lossless JSON 投影。
- **语义来源**：`Accessibility.getFullAXTree`（主 frame）+ `DOM.describeNode/resolveNode` + `Runtime.callFunctionOn` 做身份校验；几何用 rect/quads/命中测试；输入用 `Input.dispatchMouseEvent/dispatchKeyEvent/insertText`。
- **可信输入**：click/type/textbox/checkbox/radio 走 CDP 输入事件；只有 combobox/slider 用原生 setter（`eventSource=dom-control`，不声称 isTrusted）。
- **证据**：version=1 evidence（provenance/targets/before/after/dispatch/networkDelta/escalation/incomplete），成功在 `result.evidence`，失败在 `BrowserError.details.evidence`。
- **错误**：`REF_STALE`/`TARGET_NOT_FOUND`/`TARGET_NOT_UNIQUE`/`NOT_INTERACTABLE`/`WAIT_TIMEOUT`/`INVALID_ARGUMENT` 全部抛错（不再走 T1 legacy `{ok:false,error}`）。
- **零依赖**：只用现有 CDP 与 Node 内建库，不引入 Playwright/Puppeteer；不改面板视觉。
- **Skill/manifest**：入口工具表（T2 时点 16，T3 收口后 22）、本文与 `knowledge/web/t2-capability-ledger.md` 同步；`declared-capabilities.json` tier `T1+T2`（T3 收口后 `T1+T2+T3`）、unsupported 仅 T4。

## 压缩与滚动行为（2026-11-01 优化，契约 §3.1/§4.3）

**快照压缩（§3.1 第 1 条）**：内容命名 owner（heading/button/link，且 name 确实来自其 contents）的纯文本重复链只保留一份；`aria-label`/`aria-labelledby`/外部 `label` 命名的 owner 不吞子文本；`StaticText → InlineTextBox` 单链只留一份，多片 InlineTextBox 不逐片全局去重；换行/空格不做有损 normalize。压缩在 emit / `nodeCount` / 字节预算**之前**完成，被合并的表示不计入 truncation。同名 sibling、不同 role 父子、`listitem`/`tablecell`/`iframe`/`image`/`canvas`、任何 frame/shadow 边界一律保留。

**空白与 generic（§3.1 第 1/2 条）**：不输出 `- text ""`；内联片段分隔符投影为单行 `- text " "`；不可交互的非语义 `generic` 包装不分配 ref（含 `contenteditable` generic → 用显式 selector 查状态；`role=textbox` 的自定义控件不受影响）。

**实测（同 `/web-t2.html`、默认参数）**：`nodeCount` 421→275（−34.7%）、tree UTF-8 14432→9254（−35.9%）、`- text` 行 232→91；两次连续捕获 `tree/digest` 一致。`nodeCount`/`digest` 是构建相关读数，跨构建变化不算回归。

**滚动硬门禁（§4.3）**：`direction` 与 `to` 都**不自动滚入视口**；派发前校验 visible / 两帧稳定（bbox 四项差 ≤1 CSS px）/ 视口交集 / 中心命中 / 轴有滚动范围，不满足零派发 `NOT_INTERACTABLE`（`outside-viewport`|`unstable`）+ 固定无 selector 的 `details.hint`；失败前后页面与元素 scroll 读数进 evidence。恢复：先无目标滚文档 → `browser_node_state` 确认 `inViewport` → 带目标重试；持续运动属 T4，不换点、不 force。

## 仍然存在的限制

- **主 frame only**：same-origin iframe 也只显示边界叶子，cross-origin/OOPIF 不遍历、不查内部 selector、不产生内部 ref；动作不能送入 iframe 内部。跨帧需要 renderer `sessionId`+`frameId`+`documentEpoch` 联合身份，本轮不做。
- **shadow**：只支持 open shadow 的 AX-backed ref；CSS 不穿透 shadow root；closed shadow 或无 backend 身份时拒绝，不落到相似节点。
- **定位**：selector 仅原生 CSS、仅主文档、必须唯一；无 XPath/文本 DSL/`getByRole`/`getByText`/Locator；不自动推导 CSS locator。
- **无 force / 无 JS click / 无 hover 工具**；overlay 命中失败即动作失败，不搜索其它点击点。
- **表单**：`combobox` 按 `option.value` 精确匹配、**不打开原生 select popup**；`slider` 用原生 setter、**不模拟拖拽**；自定义 ARIA combobox/slider 不接受。结构赋值不能替代 popup / 拖拽手势测试。
- **输入**：不承诺 IME/composition 与逐字符 keydown；contenteditable/富文本编辑器、`number`/`date`/`file`/`hidden` 抛 `UNSUPPORTED`。
- **不做**：上传/下载、drag/drop、文件选择器、JSDialog 管理、多标签/popup 接管、触摸、截图 diff、独立证据文件包。
- **视觉归类**：hit-test 只证明当前坐标命中；颜色、可读性、遮挡成因、canvas/WebGL 文字等属 T3（`browser_vision_image`/`compare`）；动画/时序属 T4（`browser_dynamic_session` + `motion_analyze`）。两者均已实现。

## 不要用旧层级冒充 T2

`browser_eval` 里的 `document.querySelector(...)`、读 DOM 属性、`element.click()` 仍然只是**页面 JS 状态/页面内合成事件**：没有节点身份、没有可信派发、没有 before/after 证据，也不能证明 ARIA role/name 或命中正确。T2 工具缺失或抛 `UNSUPPORTED` 时才回落到 T1，并如实说明回落理由与证据强度差异——**不得**用 T1 结果声称结构化语义已通过。

## 验收门槛（本轮达成情况）

1. ✅ T2 正/负例脚本在授权 loopback fixture 上跑出绿报告：`tests/acceptance/runs/2026-11-01T03-41-31-025Z-39784/run-report.json`（优化构建），探针 38（37 pass / 0 fail / 1 notRun）、必需检查 **260/260**、exit 0；覆盖注册面、冷启动能力、工作区隔离、快照、ref 生命周期（含 LRU 与跨快照保留）、唯一 selector、可信动作、表单、滚动、等待、错误码、证据、租约、取消。
2. ✅ 报告路径与计数已写进 `manifests/declared-capabilities.json` 与 `knowledge/web/t2-capability-ledger.md`。
3. ✅ 真实宿主上注册 16 工具（T2 时点）、真实 Agent 会话跑通 snapshot→动作→wait/node_state 并留下 durable 证据：`tests/acceptance/evidence/t2-real-host-2026-11-01.md`（14/14 检查行，每行 actionId）。
4. ✅ `browser_capabilities` 按 §5.3 报 `limits.structuredGui`（C2 required 检查通过）。

因此 7 个 T2 工具与聚合项记 `verified`；真实宿主会话已补齐，**仅剩 provider 图像可见性（T1 遗留）与仅 advisory 覆盖的 closed-shadow「不产生 ref」细分未验证**。不要把 verified 外推到跨帧、视觉（T3/T4）或 provider 图像可见性。
