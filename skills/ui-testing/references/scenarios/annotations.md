# 读取面板标注（P0-D annotations）

用户说「看我标的」「我圈的是哪里」「这个箭头指的是什么」时用本页。标注是**用户在调试面板里画的问题线索**，Agent 通过结构化文档读取，不通过截图。

## 1. 唯一读取入口

- `browser_state()` 返回顶层 `annotations`（每个**工作区**一份，与已认证 `/state` 的 `ui.annotations` 同源；旧 Host 无此字段 → 按 `unsupported` 处理，不要假装读到）。
- `browser_capabilities()` 的 `annotations` 段声明读取方式、`space`（恒为 `canvas-css-px`）与 `limits`；**工具面仍是 30**，没有"标注工具"可调。
- **标注不进截图、也不进 T3**：`browser_screenshot` 的 `capture.composite:true` 只表示"页面帧合成到白画布"，与标注无关。若在截图里找不到用户画的线，这是设计如此，不是 bug。

## 2. 文档形状

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

## 3. 图形与字段

| `type` | 字段 | 备注 |
| --- | --- | --- |
| `rect` | `x,y,width,height` | 左上角 + 尺寸 |
| `circle` | `cx,cy,rx,ry` | PS 默认语义：按下点与落点为**包围盒两角**的内接椭圆，不是"中心+半径" |
| `line` | `x1,y1,x2,y2` | |
| `arrow` | `x1,y1,x2,y2,head:{length,width}` | **尖端 = `(x2,y2)`**；`head` 由 Host 按 `min(3t,L)/min(2t,L)` 重算，不可信客户端 |
| `brush` | `points:[[x,y],...]` | 只有点集 |
| `text` | `x,y,fontSize,text` | 唯一带**原文**的类型（≤200 UTF-16 code units） |

形状还带 `id`（`a1`、`a2`…）、`color`、`strokeWidth`、`fill`、`stroke`。

## 4. 坐标换算（最容易错的一步）

- shapes 存的是**画布 CSS px `d`**；页面坐标 `p = d − S`，`S` 是**当前** `view.x/y`。
- 面板侧另有 `q = d − C`（`C = canvasX/canvasY`）；两者关系 `p = q + O`、`O = C − S`。
- **必须用当前 `view` 换算**，不要用 `annotations.view`（那是发布时快照，`C`/`scale` 可能已经变了）；`scale`（显示比例）与 DPR **不参与**坐标变换。
- 空白区（`O≠0` 时视口露出的部分）同样可画、可读；`d` 允许负值。

## 5. 能读到什么、读不到什么

- **只有 `text` 有原文**。用户用**画笔手写**的字只有 `brush.points`，没有语义——不要"读"出手写内容，也不要把点集当文本转述。
- 需要 Auxiliary 视觉时，可以按 `points` 自己渲染成图辅助人工核对，但必须声明"这是按点集重建的几何，不是面板渲染结果"。
- `truncated:true` 时如实报告 `truncation`（丢了多少形状/点/截断多少字符），并说明"标注可能不完整"。

## 6. 落点解析：「这个箭头指的是什么」

1. 取端点 → `p = d − S` 得到页面点。
2. `browser_eval` 命中：`document.elementFromPoint(p.x, p.y)`；再枚举同区域可见元素，按**点到矩形边距**排序，得到候选表。
3. 手绘尖端常偏 10–20 px：**给候选 + 距离**（例如"搜索框容器 2 px、标签栏 3 px、logo 22 px"），不要单点断言"就是它"。
4. 需要更多证据时：`browser_snapshot` + `browser_node_state` 取 AX 语义/状态；`browser_vision_image` 放大该区域**看页面像素**（仍不含标注）做人工复核；需要记账时把结论写成 `browser_vision_check` 的 `facts`，别用像素推断冒充 DOM 事实。

## 7. 生命周期与隔离（v3）

- 文档按 `documentKey` 绑定：**导航/刷新/换文档会清空**；同一工作区内切页签、重挂面板、换会话**保留**（客户端按文档身份水合）。
- **按工作区隔离**：不同工作区各有一份，互不串；读取时用当前会话的 `browser_state` 即可，不要跨工作区拼装。
- `stale:true`（`panel-unseen`）表示来源面板心跳过期，**不代表标注不存在或已删除**：形状照常可读，如实说明"可能不是最新"即可；不得伪造心跳或 revision。
- 显式「清除画布」会让 `shapes` 变空（`revision` 递增），不要把它当成"读取失败"。

## 8. 红线

- 标注是 `trusted:false` 的**问题线索**：不构成缺陷证明，也**不授权**按它自动点击/提交（要动页面仍需用户明确许可）。
- 不要用标注内容替代交叉验证：结论至少要落到 DOM 读回、截图或网络证据之一。
- 不要为了"看起来有标注"而伪造 `annotations` 字段、revision 或截图。

## 9. 常见坑

| 坑 | 正确做法 |
| --- | --- |
| 把 `brush.points` 当文字转述 | 只有 `text` 有原文；手写只说"笔画"，必要时提议用户改用文字工具 |
| 用 `annotations.view` 换算坐标 | 用当前 `view.x/y`（`p = d − S`） |
| 以为截图/T3 里有标注 | 没有；走 `browser_state.annotations` |
| 按 `scale` 缩放坐标 | `scale` 只影响显示与截图密度 |
| 把箭头 `(x1,y1)` 当尖 | 尖端是 `(x2,y2)` |
| 把 `stale` 当"数据没了" | 只是心跳过期，形状仍可读 |

## 10. 参考

- 权威契约：`docs/viewport-control.md`（§11 v2 Agent 可见面、§12 v3 保留与隔离）
- 真宿主实测（读取路径、手写无原文、箭头落点解析）：`本地验证记录（不随仓库分发）/annotation-realhost-2026-11-02.md`
- 隔离验收：`tests/acceptance/viewport.mjs`（A1–A5）、`tests/acceptance/viewport-gui.mjs`（V15/V16/V17）
