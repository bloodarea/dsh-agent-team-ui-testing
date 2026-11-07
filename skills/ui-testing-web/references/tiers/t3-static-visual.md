# T3 · 静态视觉

> 权威契约：[`docs/t3-vision.md`](../../../../docs/t3-vision.md)。本文件是已实现能力的操作摘要，字段、边界与验收口径以契约为准。

## 已实现的六个工具（当前工具面 36 = 10 T1 + 1 P0-E + 7 T2 + 6 T3 + 7 network + 5 T4）

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

`browser_screenshot` 仍是原始 PNG 采集（P0），不隐式产生 productId；要用同一画面做视觉分析，先 `browser_vision_image` 取得 product。T2 负责语义元素与可交互目标；T3 的 `act` 用当前截图里的顶层命中点，不是“知道调用者想要哪个 DOM 对象”，也不是 T2 `NOT_INTERACTABLE` 的 force 逃生口。`escalation:"T3"` 只提示需要视觉分析；`escalation:"T4"` 提示需要连续帧证据（持续运动）。

## 结论边界

- 结论只对指定源图、区域、分辨率与阈值负责；`ok:true`、截图成功、识别到候选、坐标已派发都不等于视觉验收通过。
- `INCONCLUSIVE`/`BLOCKED` 必须原样报告，不能降级成 PASS；`advisory` 事实最多给 `WARN`。
- 3 条 N/A 子项（DOM 小数/Blink 截断、inert 命中、页面级 downs/ups）以 reason 说明，不计入 PASS。
- 真实宿主加载与 provider 图像可见性需要单独证据。
