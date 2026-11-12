# 读取与写入面板标注（P0-D annotations）

用户提到「标注」「我画的」「看我标的」「我圈的是哪里」「这个框/箭头指的是什么」「这些笔迹」等、指代面板标注时用本页；用户说「你圈一下」「标给我看」「在这儿写个问号」时也用它（反向：`browser_annotation` 往同一份文档里画）。标注是**用户在调试面板里画的问题线索**：先读结构化文档，再查看带标注截图；要给人类画标注时，先确认前台标签可见再写。

## 1. 文档与像素读取入口

- `browser_state()` 返回顶层 `annotations`（与已认证 `/state` 的 `ui.annotations` 同源；旧 Host 无此字段 → 按 `unsupported` 处理，不要假装读到）。
- `browser_capabilities()` 的 `annotations` 段声明读取方式、`space`（恒为 `canvas-css-px`）与 `limits`；**工具面是 37 个已注册的 `browser_*`（当前 Web 环境注册并准入的那些）**。读取结构化标注既可以用 `browser_state` 的一个字段，也可以用 `browser_annotation {action:"read"}`（同一份文档，返回 `revision/shapes/shapeCount/truncated/truncation/foreground`）。
- `browser_screenshot {includeAnnotations:true}` 叠加当前目标已提交且经 Host 接受的六种形状，渲染与面板的颜色、粗细、填充/外框语义一致；不包含未提交草稿、工具栏、选中控件或其它面板 UI。
- `includeAnnotations?:boolean=false` 默认关闭。默认截图、T3 原始源与 T4 的 screencast/screenshot-loop 帧源均不含面板标注；默认图里没有线不能说明用户没画。`capture.canvas.composite` 仅说明画布合成，标注叠加看 `capture.annotations`；T3 的 `annotations` 参数是独立的图片后处理标记。
- 面板的「选择」「框选」是**人类侧编辑工具**：只改本地面板选中态（品牌色光晕、包围框、底部状态栏的「已选 N 个」），拖动移动或删除才改同一份文档；选中态不写文档、不进入 `annotations` 读取结果，也不进带标注截图。不要从标注文档推断「当前选中了哪几个」。

## 2. 反向：给人类画标注（`browser_annotation`）

用户说「你圈一下 / 标给我看 / 把有问题的几处框出来 / 在这儿写个问号」时，用 `browser_annotation` 把结论画到**他眼前的调试视图**上——面板画布与这个工具写的是**同一份**标注文档。

- **四类动作**：`read` 读当前文档；`draw` 追加 1–64 个形状（追加，不是替换）；`erase` 按 `ids`（1–64）和/或 `point{x,y,radius?}` 删（默认半径 8 画布 px，命中规则同面板橡皮擦：形状到该点距离 ≤ `max(strokeWidth/2,6)` 与 `radius` 取大者）；`clear` 清空画布。
- **形状与面板工具的对应**：`circle` 圆形、`rect` 矩形、`line` 线段、`arrow` 箭头、`brush` 画笔（铅笔）、`text` 文字；「颜色」→ `color`（`#rrggbb`，默认 `#ff3b30`）；「粗细」→ `strokeWidth`（整数 1–20，默认 3）；「外框/填充」→ `style:"stroke"|"fill"`（只对 `circle`/`rect`；`text` 固定 `fill`，`line`/`arrow`/`brush` 固定 `stroke`；`style` 与 `fill`/`stroke` 不能同给）。`id` 可省略（Host 从现有最大 id 继续分配 `a<N>`），`arrow` 的 head 与 `text.fontSize`（固定 20）由 Host 决定。
- **前台前置条件（硬约束）**：只有目标标签页**正被人类在调试视图里选中并可见**时才允许写，否则零写入并报 `ANNOTATION_NOT_FOREGROUND`。先读 `browser_state.annotations.foreground = {active, ageMs, maxAgeMs}`；`active:false` 时先请他选中那个标签页并保持面板可见，**不要**换个标签硬写、也不要把「已经画了」写进结论。判断依据是面板前台心跳（约 1.5s 新鲜窗口），人切走标签、关掉面板或把 DSH 标签页切到后台都会过期。`read` 不受此限。
- **其他门禁**：页面未处于运行态时写标注报 `INVALID_ARGUMENT`（reason `annotation-runtime-not-running`）；`expectRevision` 与当前 `revision` 不符报 `ANNOTATION_REVISION_CONFLICT`（零写入，返回 `currentRevision`）。
- **写后自检**：用 `browser_screenshot {includeAnnotations:true}` 看自己画的形状落在哪、是否框住了想指的元素；不对就 `erase` 后重画。截图里画上了不等于页面缺陷被证明。
- **边界**：文档是整份替换模型——人类下一次编辑会整体发布自己的形状列表（其中已包含你画的），人类「清除画布」会连你的一起清掉；软限额与面板相同（`maxShapes` 128、单笔画笔 512 点、文档总点数 8192、文字 200 字符、文档 65536 字节），Host 做确定性裁剪并回 `truncated`/`truncation`。工具不启动浏览器、不进页面串行队列、不占 single-owner lease、不改页面 DOM/CSS。
- **不要把标注当页面事实**：它是给人看的沟通层，`source.trusted=false`；「我圈了这里」不等于「这里有问题」，结论仍要落到 DOM 读回、截图或网络证据之一。

## 3. 文档形状

```
annotations = {
  version: 1, space: 'canvas-css-px', revision, updatedAt,
  source:  { kind:'human-panel', panelId, surface:'main'|'sidebar', clientRevision, trusted:false },
  context: { runtimeId, pageGeneration, documentEpoch, documentKey, addressDigest },
  view:    { canvasX, canvasY, x, y, width, height, scale, contentWidth, contentHeight, viewRevision, frameEpoch },
  shapes:  [...], truncated, truncation:{droppedShapes,droppedPoints,shortenedTextCodeUnits},
  stale, staleReason
}
```

- `source.trusted` **恒为 false**：标注是线索，不是页面事实。
- `view` 是**发布那一刻**的客户端视图快照；`context.documentKey` 是文档身份，导航/刷新会轮换并清空（v3 起跨页签/跨会话保留，见下）。
- `browser_screenshot {includeAnnotations:true}` 返回 `capture.annotations={enabled:true,composited,space,revision,updatedAt,source,context,shapeCount,stale,staleReason,truncated,truncation}`；未开启时为 `null`。`source/context/truncation` 直接沿用 state 标注文档；空文档 `source:null`、`composited:false`，有来源时 `source.trusted=false`。`shapeCount` 是接收的形状总量，可能包含 region 外的图形，不代表截图内可见数量；`composited` 也不证明某形状可见。精确字段说明见 `docs/capture-p0.md`。

## 4. 图形与字段

| `type` | 字段 | 备注 |
| --- | --- | --- |
| `rect` | `x,y,width,height` | 左上角 + 尺寸 |
| `circle` | `cx,cy,rx,ry` | PS 默认语义：按下点与落点为**包围盒两角**的内接椭圆，不是"中心+半径" |
| `line` | `x1,y1,x2,y2` | |
| `arrow` | `x1,y1,x2,y2,head:{length,width}` | **尖端 = `(x2,y2)`**；`head` 由 Host 按 `min(3t,L)/min(2t,L)` 重算，不可信客户端 |
| `brush` | `points:[[x,y],...]` | 只有点集 |
| `text` | `x,y,fontSize,text` | 唯一带**原文**的类型（≤200 UTF-16 code units） |

形状还带 `id`（`a1`、`a2`…）、`color`、`strokeWidth`、`fill`、`stroke`。

## 5. 坐标换算（最容易错的一步）

- shapes 存的是**画布 CSS px `d`**；页面坐标 `p = d − S`，`S` 是**当前** `view.x/y`。
- 面板侧另有 `q = d − C`（`C = canvasX/canvasY`）；两者关系 `p = q + O`、`O = C − S`。
- **必须用当前 `view` 换算**，不要用 `annotations.view`（那是发布时快照，`C`/`scale` 可能已经变了）；`scale`（显示比例）与 DPR **不参与**坐标变换。
- 空白区（`O≠0` 时视口露出的部分）同样可画、可读；`d` 允许负值。
- 带标注截图与页面共用本次 `region`/`scale` 映射：连续图像像素位置 `u=(d−region.origin)/capture.mapping.cssPerPixel`（逐轴，通常等于乘以 scale）；图形、线宽、文字与笔迹同步缩放并裁剪。这里的像素缩放不同于上面的页面输入坐标换算。

## 6. 能读到什么、读不到什么

- **只有 `text.text` 提供文字原文**；画笔手写的结构化数据是 `brush.points` 点集，不要把点集当文字字段转述。
- 读取 `browser_state.annotations` 后调用 `browser_screenshot {includeAnnotations:true}` 看 Host 已接受的实际笔迹。可以依据图像辨认；无法可靠辨认时如实说明，不猜字、不伪造原文。无需自行把点集重建成图来代替工具截图。


## 7. 落点解析：「这个箭头指的是什么」

1. 取端点 → `p = d − S` 得到页面点。
2. `browser_eval` 命中：`document.elementFromPoint(p.x, p.y)`；再枚举同区域可见元素，按**点到矩形边距**排序，得到候选表。
3. 手绘尖端常偏 10–20 px：**给候选 + 距离**（例如"搜索框容器 2 px、标签栏 3 px、logo 22 px"），不要单点断言"就是它"。
4. 用 `browser_screenshot {includeAnnotations:true}` 结合结构化文档查看箭头、框选与笔迹；需要更多页面证据时，用 `browser_snapshot` + `browser_node_state` 取 AX 语义/状态，或 `browser_vision_image` 放大该区域**看页面像素**（T3 原始源仍不含面板标注）。需要记账时把结论写成 `browser_vision_check` 的 `facts`，别用标注或像素推断冒充 DOM 事实。

## 8. 生命周期与隔离（v3）

- 文档按 `documentKey` 绑定：**导航/刷新/换文档会清空**；重挂面板、切换会话**保留**（客户端按文档身份水合）。
- **按 Runtime 隔离，也就是每个标签页一份**，不是「整个工作区一份」。面板在 A 标签画的，与 Agent 打 B 标签读到的，是两份不同文档；「切页签仍保留」指的是那几个标签各自持有自己的文档，不是共享一份。
- **按工作区隔离**：不同工作区各有一份，互不串；读取时用当前会话的 `browser_state` 即可，不要跨工作区拼装。
- 所以「`shapes:[]` / `revision 0` / `staleReason:"not-running"` / `foreground.active:false`」有两种可能：面板确实没开，**或者面板在看另一个标签页**。先用 §10 的对齐步骤排除后者，再请用户配合，不要把两种情况混成「用户没画」。
- `stale:true`（`panel-unseen`）表示来源面板心跳过期，**不代表标注不存在或已删除**：形状照常可读，如实说明"可能不是最新"即可；不得伪造心跳或 revision。
- 显式「清除画布」会让 `shapes` 变空（`revision` 递增），不要把它当成"读取失败"。

## 9. 红线

- 标注是 `trusted:false` 的**问题线索**：不构成缺陷证明，也**不授权**按它自动点击/提交（要动页面仍需用户明确许可）。
- 不要用标注内容替代交叉验证：结论至少要落到 DOM 读回、截图或网络证据之一。
- **画标注 ≠ 取证**：Agent 画的圈/箭头/文字是给人看的指路标记，不构成断言；也不要在前台门禁未通过时把「已标注」写进报告。
- 不要为了"看起来有标注"而伪造 `annotations` 字段、revision 或截图。

## 10. 常见坑

| 坑 | 正确做法 |
| --- | --- |
| 把 `brush.points` 当文字原文 | 点集不带文字原文；先看带标注截图，无法可靠辨认时说明限制，不猜字 |
| 用 `annotations.view` 换算坐标 | 用当前 `view.x/y`（`p = d − S`） |
| 默认截图没线就认定用户没画 | 先读 `browser_state.annotations`，再截图 `includeAnnotations:true`；T3/T4 原始源仍不含面板标注 |
| 带标注截图当面板全屏快照 | 只包含 Host 已接受的六形状；不含未提交草稿或工具栏 |
| 按 `scale` 缩放页面输入坐标 | 页面输入按 `p=d−S`；截图像素另按 region 与 `mapping.cssPerPixel` 换算 |
| 把箭头 `(x1,y1)` 当尖 | 尖端是 `(x2,y2)` |
| 把 `stale` 当"数据没了" | 只是心跳过期，形状仍可读 |
| 读到 `shapes:[]` / `revision 0` / `not-running` 就断定「用户没画」或「面板没开」 | 标注文档按 Runtime（每个标签页）一份。先 `browser_tabs list` 对 `url`（面板地址栏）、把 `read` 的 `context.runtimeId` 与目标 tab 的 `runtimeId` 比对；不一致就 `browser_tabs select {tabId}` 过去再读 |
| `foreground.active:false` 就断定「用户没打开面板」 | 先确认 Agent 目标标签就是面板显示的标签（上一行）；`foreground.viewId` 是该 tabId（runtime 活着时才有值），对得上再谈心跳与 1.5s 窗口 |
| 换到别的标签就以为标注「丢了」或被清空 | 不同标签是不同文档；切回原标签，形状与 `revision` 都还在。真正清空只有导航/刷新换文档或「清除画布」 |

## 11. 参考

- 权威契约：`docs/viewport-control.md`（共享视口、画布与标注）、`docs/tools.md`（`browser_annotation` 参数/错误/限额）
- 验收入口：`tests/acceptance/viewport.mjs`、`tests/acceptance/viewport-gui.mjs`、`tests/acceptance/annotation-capture.mjs`、`tests/acceptance/annotation-agent.mjs`
