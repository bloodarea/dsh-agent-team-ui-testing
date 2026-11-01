# T3 实施计划（Lead 协调用）

> 2026-11-01 · 本文件是 WEB-T3 实施阶段的**内部协调契约**：切片、模块 API、共享约定、集成顺序。
> 行为与验收的权威来源是 [t3-vision.md](t3-vision.md)（顾问交付，56 条验收）。二者冲突时以 t3-vision.md 为准，并把歧义报 Lead 裁决。
> 本文件不写进对外文档口径；收口时由 Lead 决定保留为历史实施记录并登记索引。

## 1. 切片与写入边界（互不重叠）

| 切片 | 交付物 | 写入范围 | 负责人 |
| --- | --- | --- | --- |
| 核心算法 | `vision-t3.js`（纯函数：PNG 编解码、裁剪/缩放/预处理/标注、统计、YIQ diff、识别/模板、几何映射、参数校验、product store） | `vision-t3.js`、`tests/vision-t3-algorithms.test.mjs` | executor-alpha |
| 基线存储 | `vision-baseline.js`（受管根、不可变 revision、head CAS、tombstone、只读 list/get、故障注入） | `vision-baseline.js`、`tests/vision-baseline.test.mjs` | executor-beta |
| Host 集成 | `index.js` 六工具 + capabilities.vision + Runtime 集成；`browser-safety.js` 分类；`package.json` files；验收 harness 工具面；check-skill 计数；skills/manifests 同步 | `index.js`、`browser-safety.js`、`package.json`、`tests/acceptance/harness.mjs`、`tests/acceptance/check-skill.mjs`、`skills/ui-testing/**` | executor-gamma |
| 靶机 + 验收 | `web-t3.html` 确定性靶机、server 路由、fixture README 真值表、`t3-vision.mjs` 56 条验收套件（B 类真实 Chromium + 合并 U 类单测） | `tests/ui_test_fixture/web-t3.html`、`tests/ui_test_fixture/server.mjs`、`tests/ui_test_fixture/README.md`、`tests/acceptance/t3-vision.mjs` | executor-delta |
| 收口 | 状态/分层/架构/索引/README 同步、独立复跑、git | `docs/**`（t3-vision.md 除外）、`README.md`、`README_zh.md` | lead |

禁止改 `client.js`（UI 冻结）。禁止引入任何 npm 依赖。禁止启动/重启用户 DSH 实例。禁止 git commit/push（由 Lead 在用户授权后处理）。

## 2. 共享模块 API（实现方必须一致，调用方按此编码）

### 2.1 `vision-t3.js`（executor-alpha）

导出常量：

```js
export const VISION_ALGORITHM_VERSION = 't3-v1';
export const VISION_LIMITS = Object.freeze({
  maxProducts: 16, maxTotalBytes: 128 * 1024 * 1024, maxProductBytes: 32 * 1024 * 1024,
  maxProductPixels: 16000000, maxWorkingSetBytes: 256 * 1024 * 1024,
  maxTemplateComparisons: 50000000, algorithmBudgetMs: 5000,
  maxOutputPixels: 16000000, maxOutputBytes: 32 * 1024 * 1024,
});
export const DEFAULT_DIFF_OPTIONS = Object.freeze({ threshold: 0.1, includeAA: false, minRegionPixels: 1 });
export const DEFAULT_THRESHOLDS = Object.freeze({ warnRatio: 0.001, failRatio: 0.01 });
export const WARNING_VOCABULARY = Object.freeze([... t3-vision.md §3.3 的封闭词表 ...]);
```

图像内存对象统一 `Image = { width:number, height:number, rgba: Uint8Array }`，`rgba.length === width*height*4`。

```js
export function decodePngToRgba(bytes)            // -> {ok:true,width,height,rgba} | {ok:false,code,message}
export function encodePngRgba(image)              // -> Buffer（固定 filter0/level9/单 IDAT）
export function cropImage(image, rect)            // rect 已由调用方校验；返回 Image
export function resizeImage(image, factor, method)  // 'nearest'|'bilinear'
export function preprocessImage(image, ops)       // ops: Preprocess[]
export function annotateImage(image, annotations) // annotations: Annotation[]
export function analyzeImage(image)               // -> Analysis（t3-vision.md §2.2）
export function edgeMask(image, threshold)        // -> Uint8Array（1=edge）
export function diffImages(beforeImage, afterImage, { region, masks, options })
  // -> { metrics:{totalPixels,maskedPixels,comparedPixels,diffPixels,aaPixels,diffRatio,similarity},
  //      regions:[{id,area,imagePixels}], highlight:Buffer /* 完整尺寸 annotated diff PNG */ }
export function findInImage(image, query, { roi, templateImage }) // -> {candidates,totalCandidates,truncated,metrics}
export function mapImagePointToDocument(mapping, point)            // -> Point|null
export function mapImageRectToDocument(mapping, rect)              // -> Rect|null
export function mappingCompatible(a, b)                           // -> boolean
export function validateSource(value, label)                       // -> 规范 Source；非法抛 BrowserError('INVALID_ARGUMENT')
export function validatePixelRect(value, label)                    // -> Rect（integer）
export function validateCssRect(value, label)                      // -> Rect（有限 number）
export function validatePoint(value, label)
export function validateQuery(value, label)
export function validateDiffOptions(value, label)
export function validateThresholds(value, label)
export function validateMasks(value, label)
export function validateAnnotations(value, label)
export function validatePreprocess(value, label)
export function validateOutput(value, label)
export class VisionProductStore {
  constructor({ now } = {})
  add(entry)   // entry:{bytes,width,height,sha256,kind,mapping,actionable,parentIds,operations,createdAt,capturedAt}
               // -> Product（productId='v1_'+32hex，不重复 base64）
  get(productId) -> entry|null
  pin(productId) -> entry         // 不存在/淘汰/跨 scope 由调用方抛 VISION_SOURCE_NOT_FOUND
  release(productId)
  clear()
  stats() -> {count,bytes,pinned}
}
```

约束：同步算法循环每 65536 像素/比较检查一次取消并 `await` 让出事件循环；单次算法预算 5000ms（`VISION_TIMEOUT`）；预算/字节/像素超限抛 `VISION_LIMIT_EXCEEDED`（`details:{limit,actual,max}`）；解码前按预期扫描行字节数限制 inflate 输出（防压缩炸弹）。所有抛错用 `BrowserError`（`import { BrowserError } from './browser-safety.js'`），码表见 t3-vision.md §3.3。

### 2.2 `vision-baseline.js`（executor-beta）

```js
export function baselineScopeHash(scopeId)              // sha256(scopeId UTF8).hex.slice(0,32)
export function createBaselineStore({ root, scopeId, now, fsOps })
// root 为可信持久根（index.js 用 P0 同款规则解析后传入；非法/缺失由 index.js 抛 VISION_BASELINE_ROOT_UNAVAILABLE）
// store 目录 = <root>/output/vision-baselines/<scopeHash>；目录 0700，文件 0600；仅 create/update mkdir
// fsOps 可注入用于故障注入（mkdir/readFile/readdir/writeFile/link/fsync/realpath/unlink/...），默认 node:fs
store.list()                                        // -> {ok:true, baselines:BaselineMeta[]}；无根目录 -> []
store.get(name, revision)                           // -> {meta, pngBytes}；tombstone HEAD -> VISION_BASELINE_NOT_FOUND
store.create({ name, actionId, caseId, pngBytes, mapping, options, thresholds, masks, source })
store.update({ name, actionId, expectedRevision, pngBytes, mapping, options, thresholds, masks, source })
store.delete({ name, actionId, expectedRevision })
// 三者均 -> BaselineMeta；错误码/分类见 t3-vision.md §3.3/§8
```

head 规范 JSON：递归 key 字典序、无空白、末尾 LF；`<name>/heads/0000000001.json` 十位零填充；`<name>/images/<revision>-<actionId>.png`；CAS 以 `link` no-clobber 为提交点；提交后不回滚；提交前只清理本次临时文件/未被引用的本次 PNG。`BaselineMeta` 字段严格按 t3-vision.md §2.6。

### 2.3 Unit runner 接口（alpha/beta 提供，delta 调用）

两个单测文件都必须：

```js
export async function runAlgorithmChecks(check) {}   // tests/vision-t3-algorithms.test.mjs
export async function runBaselineChecks(check) {}    // tests/vision-baseline.test.mjs
// check(criteria /* 如 '§9.C18' */, label, pass /* boolean */, detail)
```

- 纯算法/文件系统，不启动 Chromium；临时目录用 `mkdtemp` 并在 finally 清理；不得在 import 时执行测试。
- 直接 `node tests/vision-t3-algorithms.test.mjs` 时自行汇总 `PASS/FAIL` 并 `process.exitCode`。
- 每条 check 的 `criteria` 必须对应 t3-vision.md §9 的编号；一个 criterion 可有多条 check。

### 2.4 `index.js` 集成（executor-gamma）

- 六工具注册名/required 数组严格按 t3-vision.md §2.1；参数校验先于 `ensure`/mkdir/CDP；全部 T3 工具在 `runtime.run(..., {agent:true, action})` 内执行（single-owner + 串行），离线 baseline 操作不调用 `ensure`。
- `Runtime` 增加每 scope 的 `visionProducts`（`VisionProductStore` 实例，dispose 清理）；live 采集复用 `runtime.capture()`（原始 PNG，`file:null`）。
- `browser_vision_act`：按 t3-vision.md §6 的 6 步顺序实现（现场几何/scroll 复验 → 同矩形重采样解码 RGBA hash 比对 → 视口校验 → `DOM.getNodeForLocation` + 节点检查 + 两帧稳定 → CDP Input 派发 → finally 释放 + after product）。
- `browser_capabilities`：新增 `vision:{version:1,algorithmVersion:'t3-v1',tools:[六名],sourceKinds:[...],limits:{...},observed:null|{observedAt,lastOperation,lastVerdict}}`；六个 `web.t3.*` + 聚合项按 BUSY 状态报告；`web.t4.dynamic-vision` 仍 unsupported；不启动浏览器、不建目录。
- `browser-safety.js` 新增 t3-vision.md §3.3 全部错误码及 category/retryable。
- `tests/acceptance/harness.mjs` 的 `EXPECTED_TOOLS` 增至 22（T3_TOOLS 子集）；`tests/acceptance/check-skill.mjs` 16→22 并允许 6 个新工具名。
- Skill：`SKILL.md` 工具表/描述、`references/tiers/t3-static-visual.md` 改写成已实现契约摘要、`manifests/declared-capabilities.json` 增加 6 个 `web.t3.*` 与 `web.t3.static-vision`（验收前状态写 `implemented`，Lead 收口时按实测改 `verified`）。

## 3. 靶机真值（executor-delta 按 t3-vision.md §9 实现）

- 默认视口 1280×800，document 高 1600，无外链/随机/自动动画；所有盒绝对整数 CSS。
- `#t3-red`=(40,40,80,60) 纯红；`#t3-blue`=(160,40,80,60) 纯蓝；
- `#t3-canvas`=(40,140,160,80)，内部左右各 80×80 红/蓝（canvas 内部位图）；
- `#t3-click`=(300,40,80,60) 点击计数；`#t3-drag` 起点=(300,160)，drop 中心=(420,160)；
- `#t3-overlay` 覆盖 click 中心（默认 hidden）；`#t3-clock`=(500,40,80,20)，仅显式 toggle 变色；
- 六缺陷容器在 y=400–750：`#t3-layout`/`#t3-occluded`/`#t3-overflow`/`#t3-truncated`/`#t3-color`/`#t3-missing` 及各自正常副本；
- `window.__t3` 记录输入事件 type/isTrusted/clientX/clientY/buttons/modifiers 与计数，提供 reset/场景函数；视觉工具不得读取插桩。

## 4. 集成顺序（Lead 调度）

1. alpha/beta 先落模块 + 单测（不依赖 Host）。gamma 同时写 Host 层（对固定 API 编码）。delta 同时写靶机 + 套件。
2. 模块就绪后 gamma 跑 `node --check` + `check-skill` + 冷启动注册/C1；然后 delta 跑 `tests/acceptance/t3-vision.mjs`，失败项直接报 Lead，由 Lead 派给对应 owner 修复（不改他人写入范围）。
3. Lead 独立复跑：`t3-vision.mjs`（要求 56 criteria 全覆盖、required 全过）、`run.mjs` 回归、`t2-structured.mjs` 回归、`runtime-faults`、`check-skill`、`check-skill-registry`、两个单测；记录报告路径。
4. Lead 同步 docs/status、capability-tiers、architecture、index、README 与 manifest 状态；git 暂存/提交按用户授权处理。

## 4.1 Lead 裁决记录（实施期）

1. **回归套件工具计数**：T1/T2 套件里硬编码的 16 必须随总面同步为 22（或从 `EXPECTED_TOOLS` 动态取），只改计数/标签，不放宽原有断言；T1/T2 子集存在性与 required 断言保留。
2. **template 坐标**：`findInImage` 的 template 候选回加 ROI 原点，返回完整源图坐标；以裁剪 product 作 source 时坐标相对该源图（并由 `documentCss` 还原）是 §2.2/§2.3 的正确语义。gamma 报告的 {20,20} 未复现（alpha 真实 Host+Chromium 复跑 {100,670}，delta C48 6/6 PASS），不改模块。
3. **inert 与 hit-test**：inert 子树不参与命中测试（`elementFromPoint` 返回祖先），因此「inert 命中 → VISION_HIT_MISMATCH」在真实浏览器不可达。C30 的 inert 子项改为验证「inert 按钮未收到事件/未被激活 + hit-test 返回非 inert 祖先」，在报告中标 NOT_APPLICABLE/NOT_RUN 并写 reason，不得记 PASS；C30 其余 required 子项不变。
4. **AA 第二层邻居计数**：契约 §4.2 的「两图各有 ≥3 个相等 RGBA 邻居」按实际有效邻居计数（不再加边界初值 1）；第一层「相等邻居 >2 即非 AA」的边界初值 1 保留。alpha 单测与独立参考实现一致。
5. **标注 thickness**：矩形/十字/箭头用方形笔刷；编号固定 2× nearest 位图、忽略 thickness（契约未定义编号 thickness 语义）。箭头箭翼从端点向主线反方向 ±45°、长 6、端点 round+clamp。
6. **diff 工作集预算**：分配前按 `16·W·H + 7·N + min(4·W·H, 32MiB)` 估算，双 16M px 图比较会抛 `VISION_LIMIT_EXCEEDED`（符合 §1.1「包括双图+输出」）；模板命中另设 1,000,000 条防御性上限（非契约公开字段）。
7. **baseline 目录 fsync**：提交后目录 fsync 的真实 I/O 错误报 `VISION_BASELINE_WRITE_FAILED` + `committed:true`；平台不支持目录 fsync 的 errno 按 P0 尽力而为不算失败。
8. **baseline options/thresholds**：缺失字段继承旧值，字段存在即逐字段覆盖；`delete` 墓碑额外保留 mapping 作审计信息。
9. **C4 live 小数尺寸**：实测 Chrome 对 `{x:40.5,y:40.5,width:79.5,height:59.5}@1` 返回 79×59（floor），而契约公式给 round=80×60。按契约 §3.1「差不足一个采样像素时按实际映射报告」：T3 live 路径接受每轴 `|actual-round(css×scale)|≤1`，mapping 用实际像素尺寸构造；超出 ±1 才 `CAPTURE_SIZE_MISMATCH`。P0 `browser_screenshot` 的严格行为不改。
10. **C25 act 命中**：`DOM.getNodeForLocation` 用**文档 CSS 整数**坐标；派发仍用连续坐标。视口坐标/小数传入 CDP 会 Invalid parameters/误命中。
11. **C28 viewport 子项**：允许用插件自身 `/viewport` HTTP 路由（同源已认证 GUI 命令、同一 runtime.run）作 setup 触发 resize→STALE；被测 act 路径仍走注册工具。
12. **C31**：契约只要求取消不重放/button 释放/dispatch 计数/after null；ABORTED 会关闭页面导致页面事件日志不可读，页面级 downs/ups 子项记 NOT_APPLICABLE。
13. **C42/C50**：契约标 U，但 check 批量校验与 fact provenance 逻辑在 Host；由验收套件以 **B 类**检查覆盖（报告注明 implemented as B），不宣称 U。
14. **evidence 形状**：成功体必须是 §1.2 的 `evidence:{vision:VisionEvidence}`；错误路径 `details.evidence.vision`。实现曾直接平铺，收口前改为嵌套并由套件收紧断言。

## 5. 验收口径

- 只有 56 条 criteria 全部有结果、required 检查全过、报告写入 `tests/acceptance/runs/<iso>-<pid>/run-report.json` 才能宣称 T3 通过；NOT_RUN 不是 PASS。
- 真实宿主加载与 provider 图像可见性仍 NOT_RUN，除非另有专门证据；不得由进程内套件推定。
- 截图成功、识别到候选、坐标已派发都不等于视觉验收通过；inconclusive/blocked 必须原样报告。