# T3 · 静态视觉（已实现并通过进程内验收；真实宿主/provider 仍 NOT_RUN）

> 权威契约：[`docs/t3-vision.md`](../../../../docs/t3-vision.md)（§1 范围/源图/校验、§2 六工具 schema、§3 坐标与统一证据/错误码、§4 PNG 与 YIQ diff、§5 识别限制、§6 坐标交互、§7 六类缺陷与事实、§8 基线/回归、§9 56 条验收、§10 能力映射、§11 交接）。
> 本文件只是**已实现能力的操作摘要**，不替代契约；字段、边界与验收口径以契约为准。

## 已实现的六个工具（当前工具面 35 = 10 T1 + 7 T2 + 6 T3 + 7 network + 5 T4）

| 工具 | 用途 | 关键边界 |
| --- | --- | --- |
| `browser_vision_image` | 采集/裁剪/缩放/预处理/统计/可选识别/像素标注，交付一张 PNG | 顺序固定 source→region→resize→preprocess→统计/识别→标注→编码/交付；分析与识别在标注前；无断言 `INCONCLUSIVE(no-assertion)` |
| `browser_vision_find` | 确定性识别与定位（color/components/edges/template） | 坐标相对完整源图（ROI 原点已回加），`semanticName` 恒 null；无匹配是成功空列表 |
| `browser_vision_compare` | 两图 YIQ 像素差异 + 标注差异 PNG | 两图必须同尺寸；mask/options/thresholds 继承 before 基线并可覆盖；全屏蔽 `VISION_EMPTY_COMPARISON` |
| `browser_vision_act` | 用截图坐标派发真实 CDP 鼠标输入 | 六步安全校验（现场几何/重采样 RGBA hash/视口/命中+两帧稳定/CDP 派发/finally 释放），失败零派发；verdict 恒 `INCONCLUSIVE(dispatch-only)` |
| `browser_vision_baseline` | 受管基线 list/get/create/update/delete | 可信持久根 + scopeHash 隔离；不可变 revision + HEAD CAS；delete 为墓碑；离线操作不启动浏览器 |
| `browser_vision_check` | 回归 + 六类缺陷用例集 | cases 1–20 / assertions 1–32 / facts 0–64；required 缺事实=INCONCLUSIVE、advisory 最多 WARN；不发布文件、不读 DOM、不建基线 |

## 证据口径（`evidence.vision.version=1`）

- 成功业务体 `{ok:true,...,evidence:{vision:…}}`；失败抛 `BrowserError`，完整证据在 `details.evidence.vision`。
- 字段：`version/operation/provenance(algorithmVersion=t3-v1)/source/coordinateSpace/regions/metrics/baseline/facts/verdict/dispatch/output/escalation/incomplete/truncated`（全部必填，未观察项 null，非适用列表 []）。
- `evidence` JSON ≤262144 字节、`regions`≤100；超限标 `truncated` 并只丢可选细节；截断会丢失 required 判断依据时 PASS 降 INCONCLUSIVE。
- `ok:true` 只表示工具完成，`verdict` 才是断言结论；截图成功、识别到候选、坐标已派发都不等于视觉验收通过。
- `facts` 一律 `trusted:false`：T3 不重新查询 DOM，只融合调用方显式提供的、带 provenance 的几何/样式事实。

## 三个坐标空间

`image-px`（PNG 实际像素，T3 region/mask/annotation/find/act 默认）→ `document-css-px`（live source.region、外部 facts、基线 mapping）→ `viewport-css-px`（CDP Input，document 减现场 scroll）。`act.point` 是连续图像坐标：像素中心请传 `i+0.5`，不自动取整、不加 0.5。

## 新增错误（§3.3，分类固定）

`VISION_SOURCE_NOT_FOUND` / `VISION_FORMAT_UNSUPPORTED` / `VISION_SIZE_MISMATCH` / `VISION_EMPTY_COMPARISON` / `VISION_BASELINE_NOT_FOUND`（vision）；`VISION_LIMIT_EXCEEDED`（resource）；`VISION_TIMEOUT`（timeout/retryable）；`VISION_STALE_IMAGE` / `VISION_HIT_MISMATCH`（action）；`VISION_BASELINE_ROOT_UNAVAILABLE` / `VISION_BASELINE_EXISTS` / `VISION_BASELINE_READ_FAILED` / `VISION_BASELINE_WRITE_FAILED`（output）；`VISION_BASELINE_NAME_INVALID`（input）；`VISION_BASELINE_CONFLICT`（concurrency）。原有 `ABORTED/CDP_TIMEOUT/CDP_DISCONNECTED/BUSY/scope/INVALID_ARGUMENT/INVALID_PNG/CAPTURE_*/OUTPUT_*` 分类不变。

## 不被支持 / 不可外推的保证

无 VLM/OCR/语义命名；不接受任意图片路径/URL/附件 ID/调用方 base64；不跨 frame 坐标输入；不跨重启恢复 product；无自动基线接受/更新、无自动阈值学习、无自动动态 mask；无图像配准/透视/旋转/模板缩放；无 SSIM/感知模型；无动画时序与「无中间闪烁」保证。canvas/WebGL 只对最终像素可识别，不能推断内部对象或语义。像素相等只支持指定区域/分辨率/时间/阈值下的相等。

## 与 T1/T2 的关系

`browser_screenshot` 仍是原始 PNG 采集（P0），不隐式产生 productId；要用同一画面做视觉分析，先 `browser_vision_image` 取得 product。T2 负责语义元素与可交互目标；T3 的 `act` 用当前截图里的顶层命中点，不是“知道调用者想要哪个 DOM 对象”，也不是 T2 `NOT_INTERACTABLE` 的 force 逃生口。`escalation:"T3"` 只提示需要视觉分析；`escalation:"T4"`（持续运动）仍未实现。

## 验收状态（verified / 进程内）

- **进程内真实 Chromium（同一最终代码，Lead 串行复跑）**：`node tests/acceptance/t3-vision.mjs` → criteria **56/56**、requiredChecks **389/389**、failedChecks **0**、notApplicable **3**、exit 0
  报告 `tests/acceptance/runs/2026-11-01T07-34-49-952Z-174834/run-report.json`；执行者复跑 `tests/acceptance/runs/2026-11-01T07-33-56-470Z-172394` 结果一致。
- **回归**：T1 `run.mjs` 22/22、324/324（`2026-11-01T07-31-29-210Z-168725`）；T2 `t2-structured.mjs` 37/38 + 1 NOT_RUN（C38 套件边界）、260/260（`2026-11-01T07-33-10-505Z-170262`）；
  P0 `capture-p0.mjs` 14/14、142/142（`capture-p0-2026-11-01T07-35-21-142Z-176846`）；单测 vision 36/36 + 基线 52/52、capture 26/26、runtime-faults 16/16；check-skill 26/26、registry 17/17。
- **3 条 notApplicable（不是 PASS，均带 reason）**：
  1. `C25` DOM 小数 / Blink 截断：Chrome 对小数 clip 取 floor（79.5→79），Host 按 §3.1 以实际采样构造 mapping 并记录 `sizeTolerance`（±1px）；页面侧小数字面量不可稳定观测。
  2. `C30` inert hit-test：inert 子树不参与命中测试（`elementFromPoint`/CDP 均返回 BODY），故「inert 命中→零派发」不可达；已由 Lead 裁决改为断言「inert 按钮未被激活/事件不递送」，Host 侧保留 composed 祖先 inert 检查作防御。
  3. `C31` 页面级 downs/ups：取消/部分派发的按钮释放由 CDP 层保证，页面事件计数不能稳定观测（部分派发仍不重放）。
- **真实宿主已复验**：2026-11-01 16:23 重启后的 3080 真实会话内完成六工具冒烟（live 裁剪/识别/两图比较/baseline 全套/check/act + 页面真值），记录 `本地验证记录（不随仓库分发）/t3-real-host-2026-11-01.md`；同一时点复跑本套件 56/56、389/389、exit 0（`2026-11-01T08-38-27-595Z-194712`）。
- **仍未验证（NOT_RUN，不得由本套件推定）**：provider 图像可见性（附件已作为 image block 进入会话，但未专项验收）、T4 动态视觉；
  以及本地恶意进程 TOCTOU、网络文件系统下的 HEAD CAS、`link/fsync` 崩溃孤儿等运行风险。
- 能力台账（`manifests/declared-capabilities.json`）中 6 个 `web.t3.*` 与聚合 `web.t3.static-vision` 记 **verified**，并已写入上述报告路径、N/A 与未验证项。
