# Web T2 · 结构化 GUI 能力台账

> 开发事实记录，**不是运行时可用性声明**。先确认当前 Agent 注册表里确有 T2 工具，再读 `browser_capabilities` 的实际 `available/unavailable/unsupported` 与真实调用结果。静态状态（`verified` / `partial` / `implemented-not-verified` / `unsupported`）不能直接当作 available。
>
> 契约与验收依据：仓库 `docs/t2-structured-gui.md`（§2 工具表、§3 Ref、§4 动作/表单/等待、§5 证据、§6 错误、§9 验收条件）。T1 历史台账见 [t1-capability-ledger.md](t1-capability-ledger.md)（保持不改；T2 新事实以本文与入口 `SKILL.md` 为准）。

**当前口径**：工具面 9 → 16（+7 T2）。T2 验收套件已跑绿（Lead 独立复跑，同一代码）：

```text
node tests/acceptance/t2-structured.mjs（优化构建，最新）
→ tests/acceptance/runs/2026-11-01T03-41-31-025Z-39784/run-report.json
  probes 38（pass 37 / fail 0 / notRun 1 = C38 套件边界）
  requiredChecks 260 / failedChecks 0 / criteriaCovered 38 / findings 5（全部 info+advisory）/ exit 0
  （此前一轮：runs/2026-10-31T19-25-29-077Z-54114，233/233）
node tests/acceptance/run.mjs
→ tests/acceptance/runs/2026-10-31T19-26-07-741Z-55458/run-report.json
  probes 22/22、requiredChecks 324/324、failedChecks 0、findings 1（info: P20 unmodifiedText INCONCLUSIVE）、exit 0
runtime-faults 16/16、check-skill 25/25、check-skill-registry 17/17（均 exit 0）
团队同代码复跑：runs/2026-10-31T19-21-26-010Z-49307（T2 37/38 + C38 NOT_RUN）、runs/2026-10-31T19-22-02-871Z-50749（T1 22/22）
```

§9.38 真实宿主由 Lead 在 DSH 3080（pid <pid>，2026-11-01 10:40:04 重载终版）的真实 Agent 会话补齐：`tests/acceptance/evidence/t2-real-host-2026-11-01.md` —— **14/14 检查行通过**（16 工具注册与 capabilities、snapshot 主文档/scope、可信 click、type、fill_form 7 字段、表单提交真值、toggle、wait text/textGone、文档与目标滚动、隐藏节点 node_state、覆盖目标 NOT_INTERACTABLE、导航后 REF_STALE、T1 未回归），每行带 actionId 与页面真值。套件内 **C38 仍记 NOT_RUN 是套件边界**（fake ctx 不能冒充真实宿主），该项以真实宿主记录为准。

## 逐工具状态

| ID | 工具 | 工程状态 | 契约要点 / 已知边界 | 证据 |
| --- | --- | --- | --- | --- |
| web.t2.snapshot | `browser_snapshot` | verified | 主 frame AX 树 → 文本树 + `refs`；`scope`/`maxNodes`(500/2000)/`depth`(12/32)/`boxes`；`snapshotId=s1,s2…`、`digest=sha256(tree).slice(0,16)`；`truncationReasons`=maxNodes/depth/treeBytes/resultBytes；`coverage.complete` 只表示未被限额截断；iframe 只做边界叶子 | C4(24) 语义快照（含冗余文本压缩正负例） / C5 稳定摘要 / C6(8) 限额（含注入 800×~220B 的 `treeBytes>131072` 截断）/ C7 boxes / C8 scope |
| web.t2.click | `browser_click` | verified | `ref`/`selector` 恰一；`button`/`clickCount`(1–2)/`modifiers`(≤4)；滚动+两帧稳定+命中校验后 CDP 鼠标事件；hidden/covered → `NOT_INTERACTABLE` + `details.escalation=T3`；无 force | C12 身份 / C13 唯一 selector / C14 可信 click / C15 hidden-disabled / C16 覆盖与运动 / C17 离屏 / C36 影子 DOM |
| web.t2.type | `browser_type` | verified | 原生 text/search/email/url/tel/password 与 textarea；`replace`(默认 true)/`submit`；深层 activeElement 校验焦点；`insertedCharacters` 按 code point；不回显文本；contenteditable 等 `UNSUPPORTED` | C18 文本输入 / C19 编辑限制（只读、contenteditable、焦点拦截） / C20 Enter 提交语义 |
| web.t2.scroll | `browser_scroll` | verified | `direction` 与 `to` 恰一、`to` 禁止 `amount`；`amount` 默认 400；wheel 走 `Input.dispatchMouseEvent`、`to` 走 `scrollTo`；返回 before/after/moved，到边界 `moved:false` 仍成功 | C25(18) 四方向与目标滚动区（含离屏/不稳定零派发 + hint + 恢复）/ C26(8) `to=top\|bottom` 与参数校验 |
| web.t2.fill_form | `browser_fill_form` | verified | 1–20 项；`type`=textbox/checkbox/radio/combobox/slider；整批预检后执行、失败不回滚（`applied/failedIndex/fields`）；combobox 按 `option.value` 精确匹配**不开 popup**；slider 原生 setter 不模拟拖拽；两者 `eventSource=dom-control` | C21 文本与布尔 / C22 combobox-slider / C23 整批预检零派发 / C24 部分失败 / C31 取消部分输入 |
| web.t2.node_state | `browser_node_state` | verified | 现场读 NodeState；hidden/disabled/readonly/covered 也能读；可编辑 `value` 恒 null + `valueRedacted:true`；不适用布尔属性为 null | C27 节点状态读数（含 AX 与 DOM 差异） |
| web.t2.wait_for | `browser_wait_for` | verified | text / textGone / 目标 state 三类互斥；多 key AND；`timeoutMs` 默认 5000（上限 30000，工具 envelope 35000 留清理余量）、`pollMs` 默认 100；超时抛 `WAIT_TIMEOUT`（retryable，page 不关闭）；不发布新 snapshot/ref | C28 成功路径 / C29 负例 WAIT_TIMEOUT / C30 取消等待 |
| web.t2.structured-dom | （聚合） | verified | 聚合能力：snapshot→ref→动作→证据；其他 owner 持租约时与 7 项一起 unavailable+BUSY；限制主 frame/AX-backed open shadow/唯一 CSS/无 force/无视觉判定 | C1 注册面 / C2 冷启动能力 / C3 工作区隔离 / C32 七工具 lease / C33 成功证据 / C34 失败证据 / C35 网络·脱敏·限额 / C36 shadow-frame / C37 T1-宿主回归（进程内） |

## 逐条能力状态

| 能力 | 状态 | 说明 / 证据指针 |
| --- | --- | --- |
| 语义快照与稳定摘要 | verified | 契约 §3.1；C4(24)/C5：连续静态捕获复用 ref、`tree/digest` 相同而 `snapshotId` 递增（sN/sN+1），脚本侧 `sha256(tree).slice(0,16)` 严格相等 |
| 快照冗余文本压缩（2026-11-01 优化） | verified | 契约 §3.1 第 1 条；C4 的压缩正负例（内容命名 owner 只留一份、aria-label 不吞子文本、分片顺序/空格/标点保留、同名 sibling 与 role 边界保留、256/512 与脱敏碰撞不误判）；实测 nodeCount 421→275、tree 14432→9254 字节、`- text` 232→91，两次捕获 tree/digest 一致 |
| 空白文本投影与 generic 无 ref（2026-11-01 裁决） | verified | 契约 §3.1 第 1/2 条；不输出 `- text ""`，分片分隔符投影为单行 `- text " "`；generic 包装（含 contenteditable generic）不分配 ref → 查询改用显式 selector；C4/C36 覆盖 |
| 快照限额（maxNodes/depth/treeBytes/resultBytes） | verified | 契约 §3.1；C6：默认 500/12 与显式等价、`maxNodes=6`/`depth=0`/`treeBytes>131072` 均正确截断并标原因、完整 JSON ≤524288、非法范围 `INVALID_ARGUMENT` |
| Ref 生命周期（单调不复用 / 2000 LRU / 跨快照保留 / 跨文档清空） | verified | 契约 §3.2；C9 跨快照保留 + 新节点拿更大编号；C10 注入 2800 节点推到 2000 上限后淘汰与不复活；C11 导航/reload/跨文档 history 失效、`pushState`/hash 保留 |
| 节点身份复验（backendNodeId/ownerDocument/main frame） | verified | 契约 §3.3；C12：移动原对象仍可点，替换成同名新对象后旧 ref `REF_STALE` 且业务计数不变 |
| 唯一 selector（主文档、0/多命中分别报错、无 first/nth/回退） | verified | 契约 §3.3；C13：唯一命中可点、缺失 `TARGET_NOT_FOUND`、同名多匹配（含隐藏副本）`TARGET_NOT_UNIQUE`、非法 CSS `INVALID_ARGUMENT` |
| 可信 click（CDP 鼠标事件、两帧稳定、hit-test） | verified | 契约 §4.1；C14 计数+1 与 `__t2.isTrusted`/双击、C15 hidden/disabled/inert/零面积零派发、C16 覆盖与 pointer-events、C17 离屏先滚动后命中 |
| 可信文本输入（焦点+值校验、replace/append、Enter） | verified | 契约 §4.1；C18 替换/追加/清空/textarea 换行、C19 只读与 contenteditable 拒绝、焦点拦截与值恢复报 reason、C20 Enter keyCode=13 |
| 表单批处理（预检零输入、部分失败、不回滚） | verified | 契约 §4.2；C21 文本与布尔顺序执行、C23 后项非法时前项零输入、C24 中途 `REF_STALE` 时 `applied/failedIndex` 且首项副作用保留 |
| combobox / slider 结构写入（`dom-control`） | verified | 契约 §4.2；C22 单选 `cn`、多选 `a`/`c`、range 30→合法值读回准确、`eventSource=dom-control`、非法 option/范围/step 预检拒绝 |
| 方向滚动与 `to` 精确滚动 | verified | 契约 §4.3；C25(18) 四方向 delta 符号与实际 scroll（含 200/1200 目标滚动区、边界 `moved=false` 仍成功）、C26(8) `to` 达端点且 `eventSource=dom-scroll`、冲突参数拒绝 |
| scroll 预派发门禁 + 不自动滚入 + hint（2026-11-01 优化） | verified | 契约 §4.3 裁决；C25/C26：visible/stable(两帧 bbox ≤1px)/viewport 交集/中心命中全检，不满足零派发 `NOT_INTERACTABLE`（`outside-viewport`\|`unstable`）并带不含 selector 的固定 `details.hint`；失败前后页面与元素 scroll 不变；持续运动 `#t2-moving` 三次稳定复验 |
| 条件等待（三类互斥、`WAIT_TIMEOUT`） | verified | 契约 §4.4；C28 text/textGone/state 单项与 AND、polls/elapsedMs 真实且不产生新 snapshot；C29 超时 details 完整、`timeoutMs:0` 只采一次、混条件拒绝；C30 取消 1s 内 `ABORTED` 且 page 清理正确 |
| 结构化证据（version=1、minted provenance、networkDelta、escalation） | verified | 契约 §5；C33 七工具成功证据（envelope/provenance/targets/identity）、C34 六码抛错 + `details.escalation=T3`、失败后页面仍 running |
| 脱敏与证据限额（可编辑值 null、密码类屏蔽、selector 原文不入 args） | verified | 契约 §5.2；C35 输入哨兵不外泄、`value:null`+`valueRedacted`、evidence ≤262144、URL 脱敏、networkDelta 窗口 20 条与 dropped 计数 |
| 能力报告（16 工具、`limits.structuredGui`、T3/T4 unsupported） | verified | 契约 §5.3；C2 冷启动能力报告：七项 `web.t2.*` + `web.t2.structured-dom` available、限额字段正确、T3/T4 unsupported；本机另以真实 Cordis+SkillRegistry 调用确认 22 项能力可返回 |
| 工作区隔离（page/ref/lease/network 按工作区） | verified | 契约 §1；C3 两工作区独立 page/ref/lease/network、A 的 ref 在 B 为 `REF_STALE`；C32 七工具 lease BUSY 且 state/HTTP 仍可用 |
| 取消语义（等待中取消、表单输入中途取消） | verified | C30/C31：`ABORTED` 真实保留 `applied`/dispatch，无回滚、不自动重放 |
| closed shadow 不产生 ref / 不落到相似节点 | partial | 只有 C36 的一条 **advisory** 检查（"closed shadow 不产生 ref（或 ref 不可解析时明确 UNSUPPORTED）"）；closed shadow 相关的 selector 不可达与宿主可查状态属 required 且已通过。禁止据此声称 closed shadow 内部可操作 |
| iframe / OOPIF 内部定位 | unsupported | 仅主 frame；C36 已验证 iframe 仅为边界叶子、selector 不进入其中；跨帧需联合身份，本轮不做 |
| 原生 select popup / 文件选择器 / JSDialog | unsupported | 不打开、不接管 |
| hover 专用工具 / drag-drop / 上传 / 下载 | unsupported | 不在本轮 |
| contenteditable/富文本、IME/composition | unsupported | `browser_type` 抛 `UNSUPPORTED`（C19 已验证该拒绝） |
| 多标签 / popup 接管 / 触摸 | unsupported | 不在本轮 |
| 视觉判定（颜色/可读性/遮挡成因/canvas 文字） | unsupported（T3） | hit-test 只证明坐标命中；`escalation:"T3"` 只是提示 |
| 动画/时序/运动连续性 | unsupported（T4） | `unstable` 只拒绝派发并建议 T4 |
| 真实宿主 Agent 会话内 T2 调用（优化前构建） | verified | `tests/acceptance/evidence/t2-real-host-2026-11-01.md`（3080 pid <pid> / 2026-11-01 10:40:04 重载 / session-8ed5dfdc… / scope <scope-id>）**14/14 检查行通过**；该记录属**优化前构建**，优化后行为见下一行 |
| 优化构建真实宿主定向复验 | **待复验（pending，非失败）** | 需 DSH 重启加载优化构建后按记录「优化构建复验（待真实宿主重载）」小节跑 5 项：① 压缩形态（无重复 text、`- text " "` 分隔、generic 无 ref）② 同名/独立节点 refs 各自可点 ③ 离屏目标 scroll 零派发 + `outside-viewport` + hint 后恢复 ④ 持续运动 `unstable` ⑤ T1 未回归；**未完成前不得声称优化后真实宿主已验证** |

## 优化构建（2026-11-01）

| 项 | 内容 |
| --- | --- |
| 变更 1：快照冗余文本压缩 | 契约 §3.1 第 1 条（2026-11-01 优化）。内容命名 owner（heading/button/link）且 name 来自其 contents 时，纯文本重复链只保留一份；aria-label/labelledby/外部 label 不属此列（不得吞子文本）；StaticText→InlineTextBox 单链只留一份，多片 InlineTextBox 不逐片去重；换行/空格不做有损 normalize；压缩在 emit/计数/字节预算前完成，被合并者不计入 truncation |
| 变更 2：空白与 generic 裁决 | 契约 §3.1 第 1/2 条。不输出 `- text ""`；分片分隔符投影为单行 `- text " "`；generic 包装（含 contenteditable generic）不分配 ref（查询用显式 selector；`role=textbox` 自定义控件不受影响） |
| 变更 3：`browser_scroll` 硬化 | 契约 §4.3 裁决。**不自动滚入视口**（click/type 的准备滚动不适用）；direction 与 to 都在派发前过 visible/stable/viewport/center-hit 门禁，不满足零派发 `NOT_INTERACTABLE(outside-viewport|unstable)` + 固定无 selector 的 `details.hint`；失败前后页面与元素 scroll 原样保留；持续运动一律拒绝 |
| 实测效果（同 fixture / 默认参数） | nodeCount 421→275（−34.7%）、tree UTF-8 14432→9254（−35.9%）、`- text` 行 232→91；两次连续捕获 tree/digest 一致 |
| 限额口径变化 | requiredChecks 233→260（C4 24、C6 8 含注入 800×~220B 的 treeBytes 用例、C25 18、C26 8）；`nodeCount` 与 `tree/digest` 属**构建相关**读数，跨构建变化不算回归；`treeBytes` 上限仍 131072、`snapshotBytes` 524288、`evidenceBytes` 262144 不变 |
| 复验状态 | 进程内 260/260 已过；真实宿主的 14 行记录属**优化前构建**，优化后需按 `tests/acceptance/evidence/t2-real-host-2026-11-01.md` 的「优化构建复验」小节跑 5 项定向复验（**待复验，非失败**） |

## 验收门槛（本轮达成情况）

1. ✅ T2 套件在授权 loopback fixture 上跑绿（优化构建）：`runs/2026-11-01T03-41-31-025Z-39784`（probes 38：37 pass / 0 fail / 1 notRun，requiredChecks **260/260**，criteriaCovered 38，exit 0；此前 233/233 见 `runs/2026-10-31T19-25-29-077Z-54114`）。覆盖 §9 的注册面、冷启动能力、工作区隔离、快照、ref 生命周期、唯一 selector、可信动作、表单、滚动、等待、错误码、证据、租约、取消。
2. ✅ 报告路径 + 计数已写入本表与 `manifests/declared-capabilities.json` 的 `evidence`/`observations`。
3. ✅ 隔离/真实宿主注册 16 工具并由新 Agent 会话跑通 snapshot→动作→wait/node_state：`tests/acceptance/evidence/t2-real-host-2026-11-01.md` 14/14 检查行通过（DSH 3080 pid <pid> 重载终版，非 legacy scope）。套件内 C38 仍记 NOT_RUN 属套件边界。
4. ✅ `browser_capabilities` 可调用并按 §5.3 报 `limits.structuredGui`（C2 required 检查）。

因此：7 个 T2 工具与聚合项按上述实测覆盖记 `verified`；真实宿主会话已由记录补齐，**仅剩 provider 图像可见性（T1/T3 遗留）与仅 advisory 覆盖的 closed-shadow ref 细分未验证**。不要把本台账的 verified 外推到跨帧、视觉（T3/T4）、provider 图像可见性（T1 遗留）或真实宿主首次加载行为。

## 变更日志

- 2026-11-01（task-11，优化构建）：快照冗余文本压缩 + 空白/generic 裁决 + `browser_scroll` 不自动滚入/稳定性硬化；进程内 260/260（C4 24、C6 8、C25 18、C26 8）通过；真实宿主 14 行记录标为优化前构建，优化后 5 项定向复验待做（pending，非失败）。
- 2026-11-01（task-8，Lead 真实宿主验收）：§9.38 由 `tests/acceptance/evidence/t2-real-host-2026-11-01.md` 补齐（3080 pid <pid> 重载终版、14/14 检查行、每行 actionId），「真实宿主会话」行升 `verified`、门槛第 3 项打勾；closed-shadow ref 细分仍 `partial`，provider 视觉仍未验证。
- 2026-11-01（task-7）：T2 套件与 T1 套件由 Lead 独立复跑全绿，逐工具/逐能力状态升 `verified`（closed-shadow ref 细分与真实宿主会话保留 partial/NOT_RUN），补报告路径与计数，门槛第 3 项仍缺。T1 台账不变。
- 2026-11-01（task-5）：新建本台账。工具面 9 → 16；T2 七工具与聚合项登记为 implemented-not-verified（当时无运行报告）；记录能力报告实测与 T3/T4 升级边界。
