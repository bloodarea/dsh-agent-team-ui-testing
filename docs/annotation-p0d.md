# P0-D 标注模式（annotation，2026-11-02 用户要求）

> 索引：[docs/index.md](index.md) · 关系：[canvas-viewport.md](canvas-viewport.md)（P0-D 画布坐标）、[viewport-control.md](viewport-control.md)（P0-C 共享视口）、[ui-spec.md](ui-spec.md)（界面规格）。
>
> 用户需求：在工具栏“尺寸调整”左侧新增“标注”按钮（画笔图案），与尺寸栏一样拥有独立的伸缩横向面板；子功能为圆形、矩形、线段、填充、外框、颜色、粗细调整、箭头、画笔、文字。**功能范围已由用户固定**，不额外增加撤销/清空/删除/选择/导出。补充裁定：打开标注面板即进入**标注模式**，模式内只允许标注子功能操作，不可与页面交互，退出模式后才可交互。
>
> 归属：P0-D 混合画布的切片；**§1–§10 是 v1 契约（纯客户端，Host/30 工具/`browser_*`/截图/T3 均不变）**；**§11 是 v2（2026-11-02 第二轮）契约**：新增 Host 只读投影让 Agent 读到标注 + 清除画布 + 橡皮擦，工具面仍 30。标注不修改目标页 DOM/CSS，不进 Agent 截图/T3，不落盘。
>
> 实现状态：**v1 已实现并通过隔离 DSH GUI 验收**（198/198、14 NOT_RUN；详见 §10），**v2（Agent 可见 + 清除画布 + 橡皮擦）已实现并验收**：Host `viewport.mjs` **19/19 probes、206/206 required**，GUI **222/222 PASS、14 NOT_RUN、exit 0**（详见 §11.7）；**v3（跨分页/会话保留 + 工作区隔离）已修复并验收**：只改 `client.js`，Host 回归 19/206、GUI **242/242 PASS、0 FAIL、12 NOT_RUN、exit 0**（详见 §12.7）。真实 3080 面板交互、真实右栏 seat/真实会话切换、真实旧 Host、真实 OS IME、原生色盘、provider 仍 NOT_RUN（见 §8/§12.7）。
>
> 生效方式：**v1** 只改 `client.js`，刷新当前 GUI/重载面板 bundle 即可；**v2** 另改 `index.js`（`POST /annotations` + 投影 + capability），因此需要**重启 DSH** 并刷新面板，Agent 才能在真实宿主上读到标注（见 §11.6/§11.7）。

## 1. 边界与非目标

1. （v1）只改 `client.js`（生产）与 `tests/acceptance/viewport-gui.mjs`（验收）；不新增依赖、工具、HTTP 字段或 Host 能力。**（v2 起以 §11 为准：新增 `index.js` 的 annotations 路由/存储/只读投影与 capability，仍不新增工具与依赖。）**
2. 标注属于**工作区文档**（Host 每 Runtime 一份）+ 面板本地视图：切页签/卸载重挂/同工作区换会话**保留**（v3，见 §12）；导航（换文档）会清空；不跨面板编辑同步、不写磁盘，整页关闭时未送达的 pending 不保证恢复。
3. **不新增用户未要求的界面**：没有撤销、清空、删除、选择/移动、导出、字体族或透明度控件。
4. 标注**不参与 `browser_screenshot`/T3**：Host 截图只含页面像素；隔离 GUI 截图（`Page.captureScreenshot`）会含标注，属 UI 证据，不是页面证据。**v2 起标注另有一条只读通路给 Agent**：面板经认证 scoped `POST /annotations` 上报，`browser_state.annotations` / `ui.annotations` 返回结构化的画布坐标、样式与文字（工具面仍 30）；这不改变截图/T3 的像素语义。
5. 目标页 DOM/CSS/视口/DPR/zoom 不因标注改变；页面事件在模式内**零派发**。

## 2. UI 契约

- 工具栏顺序：后退 / 前进 / 刷新 / 地址栏 / **标注** / 尺寸调整 / 选择元素（禁用）/ 更多。
- 入口：`button.utb-btn[aria-label="标注"][title="标注"]`，画笔图标（16×16、`strokeWidth 1.7`、`currentColor`、`strokeLinecap/Linejoin=round`），`aria-pressed` 严格为 `"true"|"false"`，`aria-controls` 指向本实例面板 id（main/右栏实例唯一后缀）。
- 面板：`.utb-annot-bar[role="group"][aria-label="标注工具"]`，只在模式开启时渲染；DOM 顺序 toolbar → annot-bar → size（若展开）→ stage。正常单行高 41px，深色 alias 变量，窄面板 `flex-wrap` 且不覆盖 stage、不横向溢出。
- 控件与精确字符串：
  - 六个工具按钮：`aria-label`/`title` 精确为 `圆形` `矩形` `线段` `箭头` `画笔` `文字`；`data-utb-annot-tool` 为 `circle|rect|line|arrow|brush|text`；均有 `aria-pressed`，任何时刻恰一个为 `true`。
  - `input[type=checkbox][aria-label="填充"]`、`[aria-label="外框"]`：原生 checked；非闭合工具（线段/箭头/画笔）时 `disabled` 但保留 checked；文字工具时两者也禁用（文字固定填充）。
  - `input[type=color][aria-label="颜色"]`，value 六位 hex；`input[type=number][aria-label="粗细"]`，`min=1 max=20 step=1`，文字工具时禁用。粗细是**即时生效**的受控输入：空值/非数字中间态不生效，越界值即时 clamp 到 1–20（与尺寸栏的“Enter/blur 提交、Esc 恢复”草稿语义不同，因为它不写共享 Host 状态）。
- 默认值（首次打开）：工具 `矩形`；颜色 `#ff3b30`；粗细 `3`；填充 `false`；外框 `true`。关闭再打开保留工具与样式。
- 样式快照：每个已完成图形在**起笔时**记录颜色/粗细/填充/外框；之后改控件不追改既有图形。
- 模式标记：`.utb-box[data-utb-annot="on|off"]`；SVG 层 `.utb-annot-layer[data-utb-annot-layer="true"][data-utb-annot-space="canvas-css-px"]`，`role="img"`、`aria-label="标注画布"`，模式内 `tabIndex=0`、模式外 `-1`。
- 文字编辑器：`.utb-annot-text-input[type=text][aria-label="标注文字"]`，`maxLength=200`，绝对定位在落点，字号 = `20 × sy` 屏幕 px，z-index 3。

### 2.1 模式内禁用矩阵（用户“只可子功能操作”）

- 模式开启 = 面板展开 = 同一状态；再次点击“标注”退出。`annotRef` 与 React state 同步更新，禁止“下一拍才生效”的窗口。
- 进入前：结束活动页面拖动并释放按键；清空未发送的 pan/zoom 意图；`panMode` 置 `false`（拖拽复选框取消并禁用）；取消活动文字编辑；已有标注保留。
- 模式内禁用：地址输入与提交、后退/前进/刷新、更多菜单、环境选择、尺寸调整入口；**已展开的尺寸栏共存但全部控件禁用**（预设、X/Y/W/H、比例、适应窗口、拖拽）。
- 模式内可用：标注入口（退出）、六个工具、填充/外框、颜色、粗细、标注画布；面板滚动与焦点导航保持可用。
- 预览区所有滚轮（含 blank、letterbox、Ctrl/Meta）被面板吞掉：不滚目标页、不改 C/scale、不滚宿主。标注控件（颜色/粗细等）保留本地原生交互。
- 模式内不向页面派发任何 `text`/`key`/`mouse`/`wheel` 的 `/input`；总闸必须在所有 frame 指针/滚轮/`img` keydown 处理器内，不能只靠 overlay 命中。
- 退出模式：恢复原 sizing 开关、fit 偏好与正常页面输入；`panMode` 保持 `false`（不自动恢复）；标注继续显示，但 SVG `pointer-events:none` 且不占 Tab 焦点；再次进入可续画。

## 3. 坐标与渲染模型

```text
P  = paintedRect(box.getBoundingClientRect(), img.naturalWidth, img.naturalHeight)   // 未平移的绘制矩形
sx = P.width / W      sy = P.height / H
d  = (Cx + (clientX - P.left) / sx,  Cy + (clientY - P.top) / sy)                    // 画布 CSS px
screen(d) = (P.left + (d.x - Cx) * sx,  P.top + (d.y - Cy) * sy)
```

- 标注几何以**画布 CSS px** 存储；`viewBox="{Cx} {Cy} {W} {H}"`、`preserveAspectRatio="none"`、`overflow:hidden`；SVG 的 CSS 矩形精确覆盖 P（不继承 `img` 的 `frameShift`/`seedClip`，避免重复偏移），并再受 `.utb-box` 裁剪。
- 只用 P 内起笔；P 外 letterbox 不起笔。P 内包括负 C、内容盒外的 blank 都可画，不做 `inContent` gating；不得复用会拒绝 blank 的 `mapEventPoint()`。
- 画布坐标在 C 变化时随内容移动；scale/显示矩形变化时按 `sx/sy` 缩放；不乘宿主 DPR，不叠加 O。
- 拖出 P 后用**冻结映射**继续采样，并夹到 `[Cx, Cx+W] × [Cy, Cy+H]`；几何可落在画布任意处，离开当前取景只是不可见，不删除。
- 描边宽度 `t` 是**画布 CSS px**（1–20，默认 3），随显示比例缩放（不使用 `vector-effect: non-scaling-stroke`）；`stroke-linecap/linejoin="round"`。文字字号固定 20 画布 px、`font-weight:400`、`system-ui`，与粗细无关。
- 手势期间冻结 C/W/H/P；外部接受视图发生实际几何变化时取消未提交草稿，已完成标注按新映射继续显示。普通帧刷新（shot URL/onLoad/`setFrameVersion`）不得取消手势或重建 SVG。

## 4. 工具语义

| 工具 | 手势与几何 | 样式 |
| --- | --- | --- |
| 圆形 | 按下点与拖拽落点构成包围盒的两角（可为任意方向）；`cx=(x1+x2)/2`、`cy=(y1+y2)/2`、`rx=|dx|/2`、`ry=|dy|/2`，绘制内接椭圆（默认无修饰键，等同 PS 椭圆工具的默认拖拽；**不是**中心+半径，也不是按住 Ctrl/Alt 的中心式画法） | 填充/外框按快照；`<ellipse>` |
| 矩形 | 两点对角；`x=min, y=min, width=abs, height=abs`；无圆角 | 同上 |
| 线段 | 起点→终点 | `fill=none`，始终描边（外框开关不禁用） |
| 箭头 | 起点→终点，单端箭头；头长 `min(3t, L)`、头底宽 `min(2t, L)`，线身 + 同色实心三角，三角不描边 | 与填充/外框开关无关 |
| 画笔 | round cap/join 折线；与上一采样点**屏幕距离 ≥2 CSS px** 才采样（保留首点与最终点）；纯点击不生成对象 | 始终描边 |
| 文字 | P 内单击落点 = 文字左上角；单行 input，`dominant-baseline="text-before-edge"`；最多 200 字符 | `fill=当前色`，`stroke=none`，字号 20 画布 px |

- 最小手势：圆形包围盒两边、矩形两边、线段/箭头终点位移各 ≥2 屏幕 px；画笔按**累计路径长度** ≥2 屏幕 px（首末点相同但确有移动的闭环也有效），否则取消。`pointercancel`/`lostpointercapture`/Esc 取消草稿；成功 `pointerup` 才提交。
- Esc 顺序：composition 期间不处理；存在文字编辑或图形草稿时**只取消**（不退出模式）；两者都没有时退出标注模式并把焦点还给“标注”入口。
- 切换工具或样式：正在进行的 pointer 手势直接取消；文字编辑的**普通 blur 可提交**，但显式退出/导航/scope/几何变化必须先标记 cancel 再移除 editor，压住随后 blur，防重复提交。
- 填充/外框：仅圆形/矩形启用；填充 = 当前色 opacity 1，外框 = 当前色 + 粗细；关闭对应项即 `none`；**最后一个已勾选项不能被取消**（checked 保持 true，不新增提示）。
- 文字提交：Enter（非 IME composing）或普通 blur 提交非空字符串；空串/全空白丢弃；Esc 取消；模式关闭、导航、scope/几何变化取消编辑并压住随后的 blur 提交。不新增确定/取消按钮。
- 文字/IME：composition 期间 Enter/Esc 不提交、不退出；提交读取 input 完整 value，SVG 用文本节点（不解释 HTML）。

## 5. 生命周期与清理

| 事件 | 已完成标注 | 草稿/编辑 | 模式 |
| --- | --- | --- | --- |
| 关闭标注面板 | 保留 | 取消 | 退出 |
| 再打开 | 保留并续画 | — | 进入 |
| 页面导航（本地动作在模式外发起；或用新文档 epoch 识别） | 清空 | 清空 | 保持原状态 |
| 外部（Agent/别的面板）导航 | 清空 | 清空 | **保持开启**（继续禁交互） |
| 同地址 reload / 新文档 epoch | 清空 | 清空 | 保持 |
| 普通帧刷新（同 epoch、seq/revision 变化） | 保留 | 保留 | 保持 |
| scope/runtime 切换、running=false、canvas 能力消失 | 清空 | 清空 | 退出 |
| 组件卸载 / GUI 刷新 | 丢失 | 丢失 | — |

> **v3（§12）已改写上表的两条语义**：`scope/runtime` 切换只撤下当前面板的本地视图并退出模式，**不删除工作区文档、不发 release/空文档**；组件卸载/重挂/同工作区换会话**保留**（重挂按 D 水合，卸载前把未确认内容交给 retained queue）。`running=false`/canvas 能力消失、导航（documentKey 轮换）、显式 close/Runtime 回收仍清空。

- 识别规则：**不得用 `ui.revision` 或帧 `seq` 判断文档代次**；用帧 `meta.epoch`（新文档/流重启时递增）、接受的 `ui.address` 与本地导航动作。URL/hash 改变保守清空；seed 帧不触发清空。
- 模式内本地导航不可发起；模式外本地导航在发起时清空（即使失败也不恢复）。不新增 Host 字段。
- 旧 Host：无 `ui.view` 或 `ui.canvas` 时标注入口 `disabled`（不回退到屏幕坐标）；运行中能力消失则清空并退出。

## 6. 可测 DOM 契约

- 已完成图形根 `g[data-utb-annot-id="a<递增整数>"][data-utb-annot-type=...][data-utb-annot-state="committed"]`；id 在同一实例内不复用。
- 根通用：`data-utb-annot-color`、`data-utb-annot-stroke-width`、`data-utb-annot-fill="true|false"`、`data-utb-annot-stroke="true|false"`；非闭合工具固定 `fill=false/stroke=true`，文字固定 `fill=true/stroke=false`。
- 几何：矩形 `data-utb-annot-x/y/width/height`；圆/椭圆 `cx/cy/rx/ry`（原生 `<ellipse>`，由按下点与落点包围盒派生）；线/箭头 `x1/y1/x2/y2`；画笔 `points`（JSON `[[x,y],...]`）；文字 `x/y/font-size=20`，内容读子 `text.textContent`。矩形 `width` 与通用线宽不共名（线宽用 `data-utb-annot-stroke-width`）。
- 草稿 `g[data-utb-annot-state="draft"]` 不计入已完成；SVG 内图形 `pointer-events:none`，捕获在 SVG 根。
- 验收必须同时核对 data 模型、SVG 原生几何/样式与屏幕位置（`getScreenCTM` 或换算），data 单独正确不算绘制正确；每轴屏幕误差 ≤2 CSS px（模型仅浮点误差）。

## 7. 验收（V15，扩展 `viewport-gui.mjs`）

顺序：V14 → V15（宽面板）→ 原 V11（含 V15.13 窄断言）→ 原 V10；原 142 条断言与阈值不变。

- **V15.1** 入口在地址栏与尺寸调整之间；画笔图标 16/1.7/currentColor；面板 41px/单行/主题；**七工具单一激活（v2 起含橡皮擦）**；默认值与控件属性精确。
- **V15.2** 打开前聚焦 img；真实 CDP 点击/拖拽/悬停/滚轮/字符键/Enter/Tab/方向键/Ctrl+Meta/insertText；`/input` 零增量、目标页事件/滚动/文本值不变；blank 亦零派发。
- **V15.3** 先勾拖拽再开标注：`pan=false` 且禁用；已开尺寸栏存在且控件全禁用；预览滚轮（普通/Shift/Alt/Ctrl/Meta）C/scale/stage.scroll 不变、零 viewport patch。
- **V15.4** 按 P+C 真实绘制反向矩形、**包围盒椭圆**（起点/落点为两角，`cx/cy/rx/ry` 与原生 `<ellipse>`、屏幕位置一致；旧“中心+半径”必须不成立）、线段：模型公式、SVG 原生几何、屏幕位置一致。
- **V15.5** 箭头方向/终点/头长/头宽/同色实心且与填充开关无关；画笔首末点、2px 采样、round cap/join、累计路径 ≥2px（闭环有效）、拖出边界裁剪、零长度取消；pointercancel 取消。
- **V15.6** 颜色/粗细 1/3/20、填充/外框三种有效组合；试图全关被拒绝；非闭合工具禁用开关、文字禁用粗细；后改样式不改既有对象。
- **V15.7** 文字落点、中文/`<>&` 原文本、Enter/blur 各提交一次、Esc 与空串不提交、200 字符限制；composition 逻辑验证（真实 OS IME 单列 NOT_RUN）。
- **V15.8** 负 C 与内容外 blank 绘制；退出后外部 `hostViewportSet` 改 C/scale，验证 `screen(d)`、描边与 20px 文字随比例缩放；fit 本地比例一次。
- **V15.9** 跨取景边缘只显示交集；普通新帧刷新不丢活动笔画/已完成对象、不重复提交；外部 C/W/H/显示矩形变化取消草稿、已完成保留。
- **V15.10** 退出后 SVG `pointer-events:none`、页面真实可信点击/滚轮/键盘恢复、pan 保持 false；关闭重开保留工具/样式。
- **V15.11** 模式外同 URL 刷新、跨 URL、history、frame epoch、scope/runtime 清理；外部导航中模式保持 on（**v3 起卸载/scope 代次不再丢失，改由 V17.3–V17.6 覆盖**）。
- **V15.12** 用 CDP 改写 state 模拟缺 `ui.canvas`/缺 `ui.view`：入口 disabled、不发送 canvas patch；恢复能力可再进入（真实旧 Host 单列 NOT_RUN）。
- **V15.13** 窄窗口同时展开两栏：两栏 `scrollWidth ≤ clientWidth + 1`、子项可达、不覆盖 stage、工具栏不横向溢出；标注 checkbox 用独立类，避免现有 `.utb-check input` 取首个。
- **V15.14** 前后 Host 截图 PNG 解码像素相同、目标 DOM/CSS/视口/DPR/zoom 不变；隔离 GUI 截图含标注、Host 截图不含；T3 只保留既有回归说明。
- 证据：新增 5 张 PNG（双栏默认 `shot-15-annot-dual` / 六工具样例 `shot-16-annot-tools` / 负 C+scale 锚定与裁剪 `shot-17-annot-negative` / 文字编辑 `shot-18-annot-text` / 双栏窄屏 `shot-19-annot-narrow`），原有 13 张保留（共 18 张）；`capturePanel` 的裁剪上界取 `min(annotBar.top, sizeBar.top)`。

## 8. NOT_RUN（不得冒充通过）

- 真实 3080 面板交互（需用户刷新面板后人工/受控验证；隔离 GUI 不能替代）。
- 真实旧 Host（套件只模拟缺少 `ui.canvas`/`ui.view` 的投影）。
- 真实 OS 输入法 composition 行为（只做合成事件的逻辑验证）。
- 原生 `<input type="color">` 的系统色盘交互（OS 自动化不纳入 PASS；控件 value/input/change 与 SVG 样式可受控断言）。
- provider 图像可见性。
- letterbox 若自然不存在且无法受控构造，则该项 NOT_RUN，不由正常比例推定。

## 9. 风险与实现顺序

- 风险：pointer capture 按 pointerId 释放、晚到 `lostpointercapture` 不能二次提交；编辑 blur 与模式关闭竞态；`img` keydown 原有转发必须先被总闸拦住；React 被动 `wheel` 不可靠，需用现有 native `passive:false` 监听；高频画笔不得每次 move 复制全数组/重绘全列表（活动手势用 ref + rAF，每屏幕帧最多更新一次独立草稿 `g`）；帧 `epoch` 不等于 `documentEpoch`（流重启也递增，保守清空可接受，但同 epoch 新帧不得清空）；长笔画/大量标注性能未实测。
- 最小切片：①入口+面板+总闸/互斥 + V15.1–3；②SVG 坐标 + 矩形/圆/线 + 锚定；③箭头/画笔/文字 + 生命周期；④窄面板/兼容/完整旧回归。

## 10. v1 验收结果（Lead 独立终验，2026-11-02）

- **命令**：`DSH_VIEWPORT_GUI_TIMEOUT_MS=900000 node tests/acceptance/viewport-gui.mjs`（隔离 DSH + 无头 Chrome，串行单驱动；未触碰 3080/3081、未重启 DSH）。
- **结果**：**198/198 checks PASS、0 FAIL、14 NOT_RUN、exit 0**（其中原 V1–V14 的 142 条全部保留通过，V15 共 56 条）。
- **报告**：[run-report.json](../tests/acceptance/runs/viewport-gui-2026-11-02T09-31-43-758Z-120373/run-report.json)（Lead 独立复跑，圆形修正后；执行者同代码 [09-24-51](../tests/acceptance/runs/viewport-gui-2026-11-02T09-24-51-678Z-118269/run-report.json) 亦 198/198、14 NOT_RUN；修正前 Lead [08-52-19](../tests/acceptance/runs/viewport-gui-2026-11-02T08-52-19-269Z-110686/run-report.json) 与执行者 [08-46-01](../tests/acceptance/runs/viewport-gui-2026-11-02T08-46-01-751Z-108737/run-report.json) 为 197/197，保留为历史）。
- **证据**：[viewport-gui-2026-11-02T09-31-43-758Z](../tests/acceptance/evidence/viewport-gui-2026-11-02T09-31-43-758Z/SUMMARY.md)（18 PNG；Lead 已实看双栏默认、六工具样例（可见起点→落点的包围盒椭圆，非中心式圆）、负 C 空白与裁剪、文字编辑框、窄屏双栏 5 张；修正前证据 [08-52-19](../tests/acceptance/evidence/viewport-gui-2026-11-02T08-52-19-269Z/SUMMARY.md) 与执行者证据保留为历史）。
- **14 条 NOT_RUN**：原 V7.10 / V8.5 / V10.4 / V10.5 / V10.6；新增 V15.0a 真实 3080 面板、V15.0b provider 图像、V15.2c letterbox 零派发（本轮实测 painted rect 填满容器、无 band）、V15.6h 原生色盘、V15.7h 真实 OS IME、V15.11d scope/runtime 拆除、V15.11e 组件卸载、V15.12e 真实旧 Host、V15.14d T3 专项。可控场景没有转 NOT_RUN。**v3 起 V15.11d/11e 的“丢失是预期”说明作废，由 V17 覆盖；NOT_RUN 减为 12 条（见 §12.7）。**
- **过程记录（不掩盖）**：实现期修过两个真实缺陷——effect 依赖数组在 `const canvasOn` 之前求值导致面板崩溃（TDZ）、退出模式误清空已完成标注；另修矩形 `width` 与线宽同名冲突、画笔极小闭环 fallback、文字编辑 blur 竞态。执行者中途有一轮 12 FAIL 是并行临时诊断驱动造成的环境争用，已作废、不计入。
- **未验证（只列这些）**：真实 3080 面板交互（需用户刷新面板后人工/受控验证）、真实旧 Host、真实 OS IME、原生色盘、provider 图像可见性、长笔画/大量标注的性能、真实 letterbox。
- **2026-11-02 17:21 用户反馈修订（圆形）**：圆形由“按下点为中心 + 终点距离为半径”改为**PS 椭圆工具默认语义**——按下点与落点构成包围盒两角，绘制内接 `<ellipse>`（`cx/cy/rx/ry`），最小手势改为包围盒两边各 ≥2 屏幕 px。契约 §4/§6/§7 已同步；测试改 V15.4b 并新增 V15.4b2 明确否定旧“中心+半径”；上方的 198/198 与证据即为修订后的结果。
- **生效**：v1 只需刷新面板（Host 未改）；**v2 需重启 DSH + 刷新面板**，见 §11.6/§11.7。

## 11. v2 契约（2026-11-02 第二轮：Agent 可见 + 清除画布 + 橡皮擦，**已实现并验收**）

> 用户要求：“标注就是为了给 agent 看问题在哪里的”；新增“清除画布”和“橡皮擦”。本节为冻结契约（Lead 裁决），实测结果见 §11.7。

### 11.1 Agent 可见面（选 A1，工具面仍 30）

- 新增仅认证 scoped `POST /plugins/ui-testing/annotations`；每个 Runtime 保存一份“最近接受的面板标注文档”。`Runtime.state()` 顶层新增 `annotations`（`browser_state` 可见）；仅认证 GUI 的 `uiState()` 增 `ui.annotations` 与 `ui.annotationContext`。**不新增工具**（仍 30），不改既有工具 schema/参数/注册数，不叠加 `browser_screenshot`/T3。
- `browser_capabilities` 增 `annotations` 段与 `limits.annotations`：`readTool:'browser_state'`、`writeSurface:'authenticated-scoped-http'`、`source:'human-panel'`、`trusted:false`、`screenshotOverlay:false`、限额/复位/坐标说明；这不是第 31 个工具。
- `browser_state` 保持只读缓存诊断（不启动 Chromium、不 claim/续租、不增加页面交互）。
- **Agent 侧读取流程内置为 bundled skill**：`skills/ui-testing/SKILL.md` 的「读取面板标注（P0-D annotations）」小节 + 细则 `skills/ui-testing/references/scenarios/annotations.md`（入口/文档形状/`p=d−S`/箭头尖 `(x2,y2)`/手写无原文/`elementFromPoint` 指代解析/stale 与隔离/常见坑）。改这两个文件属 Host 侧资源变更，**需重启 DSH 才重新注册**；`check-skill.mjs` 30/30、`check-skill-registry.mjs` 19/19 证明结构与“正文引用可读”，不证明已运行会话看到新正文。

### 11.2 数据契约（精确）

```text
annotations = {version:1, space:'canvas-css-px', revision, updatedAt, source, context, view, shapes, truncated, truncation, stale, staleReason}
```

- 所有字段必有，未知值用 `null`；`revision` 为 Host 同 Runtime 单调非负安全整数；`updatedAt` 为 Host 接受内容的 epoch-ms|null；冷态 `revision=0/shapes=[]/source=context=view=null`。
- `source={kind:'human-panel',panelId,surface,clientRevision,trusted:false}`；`panelId` 每次组件挂载生成的 UUID（scope 切换不复用），`surface:'main'|'sidebar'`，`clientRevision` 该 panel 单调安全整数 ≥1；不含 sessionId/cwd/真实地址。数组顺序即 SVG 叠放顺序。
- `context={runtimeId,pageGeneration,documentEpoch,documentKey,addressDigest}`；`pageGeneration`/`documentEpoch` 来自既有 Runtime 方法（整数 ≥0，cold 可 null）；`documentKey` 是 Host 生成的不透明随机导航令牌；`addressDigest` 是 Host 内部带随机盐的地址摘要（64 hex），不得从 `ui.address` 复制到文档/错误/日志。
- `ui.annotationContext` 与 context 同源供客户端回传；**documentKey 在主文档提交、主上下文清除、同文档主框架 URL/hash/history 变化、关闭/CDP 断连时轮换并清空 Host 标注**。`frame.epoch` ≠ `documentEpoch`；禁止用 `ui.revision`/`view.revision`/帧 `seq` 当文档代次。
- `view={canvasX,canvasY,x,y,width,height,scale,contentWidth,contentHeight,viewRevision,frameEpoch}`：发布时客户端已接受的 Host 视图快照（不是实时真值）。C ∈ ±10,000,000；S=x/y 有限 CSS px（允许 RTL 观测负值，绝对值 ≤10,000,000）；W/H 整数 200..4096；scale 0.1..2；contentW/H 有限非负或 null；viewRevision 非负安全整数；frameEpoch 非负安全整数|null。
- shape 通用 `{id,type,color,strokeWidth,fill,stroke}`：`id` `/^a[1-9][0-9]{0,15}$/` 且同文档唯一；`type` 为 circle/rect/line/arrow/brush/text；`color` 六位 hex 小写；`strokeWidth` 整数 1..20；`fill/stroke` boolean。rect/circle 至少一项 true；line/arrow/brush 固定 false/true；text 固定 true/false。
- 几何：rect `{x,y,width,height}`（本地 `w/h` 投影为 `width/height`）；circle `{cx,cy,rx,ry}`（保持 PS 包围盒椭圆，不能退回中心半径）；line/arrow `{x1,y1,x2,y2}`；arrow 另加 `head:{length,width}`（Host 由端点+线宽重算 `min(3t,L)/min(2t,L)`，不信任客户端）；brush `points:[[x,y],...]`（显式数组，不混用 `{x,y}`）；text `{x,y,fontSize:20,text}`（原文，≤200 UTF-16 code units，裁剪不拆代理对）。
  - **只有 `text` 图形带原文**：用**画笔手写**的字只有 `brush.points`，Agent 拿不到语义（真宿主上已实测，见 [证据](../tests/acceptance/evidence/annotation-realhost-2026-11-02.md) §5）。要“让 Agent 读到字”，必须用**文字工具**输入并提交；手写笔迹只能按点集描述/渲染，不得当作可读文本转述。
  - **箭头指向 = `(x2,y2)`**：客户端三角形以 `end` 为顶点、沿 `(x1,y1)→(x2,y2)` 方向，`head.length/width` 由 Host 按 `min(3t,L)/min(2t,L)` 重算（[证据](../tests/acceptance/evidence/annotation-realhost-2026-11-02.md) §6）。Agent 判断“指向什么元素”应把尖按 `p=d−S` 换成页面点后用 DOM 命中（`elementFromPoint` + 可见元素矩形距离）复核；手绘箭头尖端可偏十几到二十像素，落点模糊时**给候选与距离，不要单点断言**。
- 几何坐标有限 `[-10,000,000, 10,004,096]`（C 上界 + 最大视口）；rect width/height ∈ (0,4096]；ellipse rx/ry ∈ (0,2048]；线/箭头端点不得重合；brush ≥2 点。
- 软限额：128 shapes、每笔 512 points、每文档 8192 points、每文字 200 字符、完整 annotations UTF-8 JSON ≤65536 bytes。客户端与 Host 同一确定性规则：保留最新 128 形状；画笔均匀降采样保首末点；按最旧完整形状逐个移除满足总点/字节预算；不截半个 JSON/坐标对象。
- `truncated` 严格等于 `truncation` 任一非 0；`truncation={droppedShapes,droppedPoints,shortenedTextCodeUnits}` 非负安全整数，合并客户端已裁剪与 Host 新增裁剪，不重复累计；清除/导航后归零；客户端最终渲染同一规范化集合。
- HTTP 原始 body 硬上限 **262144 bytes**（读取时有界，不改其它路由 8MiB 默认）；硬上限/非法结构/未知字段/非法 enum/重复 id/非有限数/循环/函数/BigInt/稀疏数组/原型污染一律 `INVALID_ARGUMENT`、HTTP 400、details 仅 field/reason/limits，不回显原文；纯 JS 入口先严格检查，`-0` 规范化为 0。
- scope 由既有可信 header → select/resolveScopeRequest 解析；仅 scopeVersion=1 且通过 browserPeer 鉴权的请求可写；不接受 legacy/recent 未固定时猜 scope，不接受 body 内 cwd/session/scope 任意寻址。`context.runtimeId` 与已选 Runtime 不同 → `SCOPE_INVALID`(400)；旧 documentKey/代次 → `INVALID_ARGUMENT`(409, reason:'annotation-context-stale')，旧请求零写入。
- 发布不复用 viewport CAS：每 panel `clientRevision` 去重/拒迟到（同 revision+同内容幂等 ACK；同号异内容 400；低号 200 `ignored:true`，不覆盖）。Host 最多保留 16 个当前 documentKey 的 panel 水位，满额拒新来源 400（reason:'annotation-source-limit'）；轮换 key 后清表。
- 多面板“最近接受的内容修改胜出”，不跨面板编辑同步；初次空挂载、轮询、心跳不得抢占他人文档。卸载/旧 scope 的 release 只清 `source.panelId` 相同的 Host 文档，不能清另一面板的新标注；显式用户清除属于内容修改，可成为最近版本。
- 坐标：`d` 为 shape 的画布点；发布快照下 `q=d−C`、`O=C−S`、页面视口 `p=q+O=d−S`；Agent 操作前必须读取当前 `S` 再换算，不能把旧快照当当前命中；`d` 在内容盒外或 `p` 在当前视口外时不能派发；scale 与宿主 DPR 不进入 p。

### 11.3 上报协议与失败策略

- `POST` body = `{version:1,panelId,surface,clientRevision,context,view,shapes,truncation,release:false}`；`release:true` 时 `shapes=[]`（取消草稿/编辑后发布），其余上下文仍必需。Host 仅抽取白名单并重算时间/地址摘要/箭头头部/截断结果。
- ACK = `{ok:true,accepted:boolean,ignored:boolean,clientRevision,annotations}`；`annotations` 经真实 `snapshotJsonValue` 校验；错误沿既有 envelope，不携带原始 body/ui.address；不返回 Runtime/DOM/React ref/函数。
- commit/文字提交/每次擦除：150ms trailing 合并；同 scope 最多 1 个请求在途，只保留最新待发快照；清除/模式退出立即 flush；草稿不发布。导航先冻结旧身份发空文档，随后取消旧排队；Host 生命周期自身清空，不依赖客户端成功送达。**（v3：切 scope 不再发 release/空文档，改为 only-retract-local-view + 按新 D 水合，见 §12.1。）**
- 可重试网络/5xx：500ms 后最多重试 1 次“仍为最新且身份未变”的同 revision；被新快照替代即丢旧重试；400/401/403/404 不自动重试；context-stale 409 只采纳最新上下文并清本地，不重放旧形状。失败保留本地已完成集合，不阻塞绘制/输入总闸。
- 本地 `.utb-annot-layer` 增 `data-utb-annot-sync='idle|pending|synced|error|unsupported'`、`data-utb-annot-revision`；复用状态栏给出 title/`aria-live='polite'` 的“标注未同步”提示（不弹 modal、不把注释错误塞入页面 lastError）。旧 Host 无 annotationContext 时保留绘制能力、sync=unsupported，禁止声称 Agent 已可见。
- 现有 `/metrics` 心跳可附可选 `annotationPanelId`/`annotationClientRevision`/`documentKey`（不附文本）；仅匹配当前 source+已 ACK revision 的心跳刷新 lastSeenAt，不改变 shapes/Host revision/抢写。`stale` 在身份不匹配、running=false 或 30s 无匹配心跳时为 true，`staleReason='context-changed'|'not-running'|'panel-unseen'|null`；未 ACK 的新内容只在本地 pending/error，Host 不能凭空宣称已收到。
- 关闭模式保留标注；本地导航（即使失败）、外部地址/Host 令牌/非 seed 帧 epoch 变化清空草稿与已完成并上报空；普通同 epoch 新帧、平移/缩放只取消不再匹配的草稿，不清已完成；scope/runtime/running/canvas 能力丢失清空退出；卸载 best-effort release，异常断开由 stale 显式兜底。**（v3 改写：scope/runtime 切换只撤本地视图+退出模式，不发 release；卸载交给 retained queue 不转空文档，见 §12.1/§12.4。）**

### 11.4 清除画布与橡皮擦

- 标注横栏右侧（粗细之后）新增可见文案按钮“清除画布”：`aria-label`/`title='清除画布'`、`data-utb-annot-action='clear'`；仅 annotOn 时可见、无二次确认；`disabled=!annotReady ||（无已完成且无草稿且无文字编辑）`；有草稿/编辑必须可清。
- clear 的 pointerdown 先 cancel 编辑防 blur 提交；单击清已完成 + 草稿/编辑、释放 pointer capture/取消 rAF，保留模式/工具/样式，立即发布空文档；不得清页面/Host view/网络/截图产物。
- 第七个单选工具 `data-utb-annot-tool='eraser'`，`aria-label`/`title='橡皮擦'`，与原六工具互斥；沿用 28×28 按钮、16×16 currentColor/1.7 描边橡皮图标；无画布时禁用。SVG 在该工具下 cursor='crosshair'，不新增擦除半径控件。
- 橡皮擦禁用“填充/外框/颜色/粗细”，保留旧值；切回原工具恢复原禁用矩阵；不产生 shape、不受样式值影响、不走最小画图手势判定。
- 仅主按钮按下即擦，pointer capture 拖动连续擦，hover 不擦；每个采样点从 shapes 逆序找**最上层命中者**并删整个对象；不按最近距离抢选、不一次删穿所有重叠层；相同坐标重复 move 不继续钻层；擦掉的对象不因 pointercancel/Esc 回滚，结束 flush。
- `r=max(strokeWidth/2,6)` 画布 CSS px。line/brush 到每段最短欧氏距离 ≤r（含端点/round join）；arrow 测线身到 base 与实心头三角内部/边缘；rect/circle 仅 `fill=true` 内部命中，`stroke=true` 描边距离 ≤r，空心中心不命中。
- 椭圆/矩形用客户端内存 `Path2D` + `isPointInPath/isPointInStroke(lineWidth=2r)` 做真实路径命中，不得按包围盒擦掉椭圆四角；文字用已渲染 `text.getBBox()` 的画布矩形，bbox 不可读则本次不命中（不猜、不改目标 DOM）。
- 拖动沿冻结画布映射；长距离 move 插值步长 ≤3 画布 px（重复位置去重）；拖出 P 只处理与画布可见矩形相交的路径，不沿 clamp 边界额外擦；外部几何变化/导航按原生命周期终止手势；每帧批量更新一次列表/一次 dirty 上报，页面 `/input` 仍零派发。

### 11.5 验收矩阵（实施目标；实测结果见 §11.7）

- Host：`viewport.mjs` 新增 5 probes × 8 required = 40 条（A1 鉴权/scope/冷态/零 CDP/30 工具/能力；A2 六图形与负 C/S 换算/文字/工具值；A3 软裁剪与硬拒绝/lossless；A4 导航/reload/hash/history/context-loss/close/跨 scope；A5 迟到/同号幂等/多 panel/release/失败不污染 lastError/stale），原 14/166 全部保留，目标 **19 probes / 206 required / 0 FAIL**。
- GUI：新增 V16.1–V16.24（24 条 required）：七工具单选、图标/精确 label/data、橡皮擦四样式禁用与恢复、点击即擦/hover 不擦、线距离阈值、画笔中段、箭头头部、空心 rect 内外、填充 rect、空心 ellipse 四角不擦、填充 ellipse、文字 bbox、重叠最上层/原地去重、真实 CDP 长拖插值连续擦、负 C/scale/fit 映射、清除可见/空态禁用/无确认、清除草稿编辑防 blur 复活、清除保留模式样式、提交→Host 六几何/文字读回、清/擦 Host 读回与 revision、失败 1 次重试 + error 标记、晚到 ACK/导航防复活、模式互斥/零 input/退出恢复、窄屏双栏无溢出且两新控件可达。
- GUI 既有 198 条不得删除/降阈值/改 NOT_RUN；V15.1d 保留原六工具标签/顺序/单选，明确把总数六改七并在 V16.1 严格验证七；目标 **222/222 PASS、0 FAIL、仍 14 NOT_RUN**。
- 串行单驱动：`run.mjs`（23/349，P21 保留）、`viewport.mjs`、`viewport-gui.mjs`、`capture-p0.mjs`（15/162）、`t3-vision.mjs`（56/415）；`node --check index.js/client.js`、`git diff --check`。新字段的 state/capabilities/ACK/错误体必须走真实 `@deepseek-ai/dsh-util-values` 的 `snapshotJsonValue/isJsonValue`，至少一个含全部六图形的 `browser_state` 真实调用过注册 wrapper → 真实宿主 validator。
- NOT_RUN 保留既有 14 项；真实 3080/3081、真实旧 Host、原生色盘/OS IME、provider 不由隔离套件推定；新增能力的真实宿主路径只承诺 fake-ctx + 真实 validator 证据。

### 11.6 风险与生效

- 标注是用户给 Agent 的**非可信问题线索**，不证明页面缺陷，也不授权自动点击；文字原文进模型是用户要求；系统地址/鉴权材料不可随投影泄漏。大量画笔与重复 state/frame 中的 64KiB 投影有 CPU/带宽成本，受限额保护；不得在 pointermove 逐次序列化整个文档。
- 最新面板胜出、不跨面板编辑同步为本轮边界；异常断开可能保留最后文档，但 30s 后必须 stale；不持久化、不在重启后恢复。Host 无法确认未送达的本地新内容，UI 未同步状态必须如实。
- **Host `index.js` 改动必须重启 DSH 才生效**；`client.js` 需刷新当前 GUI/重载 bundle（HMR 免刷新只在确认 `pnpm run dev:web` watcher 时成立）。本轮禁止触碰真实 3080/3081，交付说明必须标记“待用户重启后真实 Host 复验”。

### 11.7 验收结果（Lead 独立终验，2026-11-02 第二轮）

- **Host 探针**：`node tests/acceptance/viewport.mjs` → **19/19 probes、206/206 required、0 FAIL、findings 1(info)、exit 0**（Lead 复跑 [11-04-54](../tests/acceptance/runs/viewport-2026-11-02T11-04-54-275Z-161260/report.json)；执行者 [11-36-22](../tests/acceptance/runs/viewport-2026-11-02T10-36-22-588Z-147252/report.json) 同结果）。A1–A5 覆盖：工具面仍 30 且无标注工具、capabilities/limits 声明、冷态空文档、未运行/未带 scope/未鉴权拒绝、六图形与文字读回、箭头头重算、`p=d−S=q+O` 自洽、`browser_state` 顶层同源且过真实 `snapshotJsonValue/isJsonValue`、软裁剪与 11 条非法结构硬拒绝、导航/hash/reload/close/CDP 断连轮换 documentKey 与 409 stale 零写入、跨 scope 隔离、clientRevision 幂等/迟到、16 panel 水位、release、心跳与 30s stale、lastError 全程为空。
- **GUI**：`DSH_VIEWPORT_GUI_TIMEOUT_MS=900000 node tests/acceptance/viewport-gui.mjs` → **222/222 PASS、0 FAIL、14 NOT_RUN、exit 0**（Lead 复跑 [11-09-12](../tests/acceptance/runs/viewport-gui-2026-11-02T11-09-12-517Z-165556/run-report.json)，证据 [viewport-gui-2026-11-02T11-09-12-517Z](../tests/acceptance/evidence/viewport-gui-2026-11-02T11-09-12-517Z/SUMMARY.md)（18 PNG）；执行者 [10-55-13](../tests/acceptance/runs/viewport-gui-2026-11-02T10-55-13-836Z-155013/run-report.json) 亦 222/222）。V15 六工具断言按需求明确改七（标签/顺序/单选未放宽），V16.1–V16.24 覆盖擦除命中（线/画笔中段/箭头实心头/空心与填充 rect 与 ellipse/文字 bbox/重叠最上层/真实 CDP 长拖插值/负 C+0.75 scale）、清除（可见/空态禁用/无确认/防 blur 复活/保留样式）、上报（六几何与文字读回、擦除与清除后 Host 同步、失败重试 1 次 + error 未同步提示、晚到 ACK 不复活、无 `annotationContext` → unsupported）、模式闸门零派发与退出恢复、窄屏双栏可及。
- **同一最终代码的回归**：`run.mjs` **23/23、349/349、exit 0**（Lead 复跑 [11-07-27](../tests/acceptance/runs/2026-11-02T11-07-27-989Z-163632/run-report.json)；Lead 首跑 [11-05-29](../tests/acceptance/runs/2026-11-02T11-05-29-353Z-161777) 22/23，唯一失败是**文档已记录的既有 P21 loadingFailed flake**，复跑通过，未放宽断言）；`capture-p0.mjs` **15/162、exit 0**（[11-03-20](../tests/acceptance/runs/capture-p0-2026-11-02T11-03-20-113Z-158031/report.json)）；`t3-vision.mjs` **56/56 criteria、415/415、exit 0**（[11-03-38](../tests/acceptance/runs/2026-11-02T11-03-38-890Z-159006/run-report.json)）；`runtime-faults` 16/16、`workspace-isolation` 77/77。
- **证据已实看**（Lead，[11-09-12 证据目录](../tests/acceptance/evidence/viewport-gui-2026-11-02T11-09-12-517Z/SUMMARY.md)）：`shot-16` 显示七工具（含橡皮擦图标）+ 填充/外框/颜色/粗细 + 最右“清除画布”按钮，画布上含包围盒椭圆；`shot-19` 显示窄屏下横栏换行后两个新控件仍可达且不覆盖预览区。
- **过程记录（不掩盖）**：执行者前两轮 GUI 均为 221/222，失败在 V16.24 的“页面点击后重进模式”seam，第三轮把 V16.24 调整到 V16.22 之前并加仅记录探针，断言强度不变；Host 侧 `run.mjs` 的 P21 首跑复现既有 flake、复跑通过。两次失败报告与证据保留。
- **NOT_RUN（14 条，不含通过）**：V7.10、V8.5、V15.0a、V15.0b、V15.2c、V15.6h、V15.7h、V15.14d、V15.11d、V15.11e、V15.12e、V10.4、V10.5、V10.6。**真实宿主读取路径已于 2026-11-02 21:56 实测**（用户重启 3080 后在面板绘制，Lead 用 `browser_state` 读到 `revision 11`、11 个图形、`stale:false`、来源 `human-panel/sidebar`，页面 `about:blank` 整页纯白；[证据](../tests/acceptance/evidence/annotation-realhost-2026-11-02.md)）——证明「面板写 → Host 存 → Agent 读」在真实宿主可用；**受控“发布→读回”、`p=d−S` 非零换算、导航清空/409 stale、多 panel/限额仍未在真宿主复跑**（以隔离 `viewport.mjs` A1–A5 与 `viewport-gui.mjs` V16 为准）。**真实旧 Host、真实 OS IME、原生色盘、provider 图像可见性、长笔画/高频轮询性能、真实 socket 抖动均 NOT_RUN。**

## 12. v3 契约（2026-11-02 第三轮：跨分页/会话保留 + 工作区隔离）

> 用户报 bug：“标注切换分页或者会话就会丢失，然后正常按工作区隔离。” 期望：切页签/重挂/同工作区换 session 都保留；不同工作区各看各的。**根因**：client 从不水合 `ui.annotations`，且 scope 变化/卸载会 `annotRelease()` 发 `release:true` 空文档，而 Host 只清同 panelId 的文档 → 面板一卸载就把工作区文档清了；`resetKey` 路径同理。**裁决：Host/index.js 不改**（每 Runtime 已隔离、state 可读、revision 可排序、stale 只标记不清 shapes、导航 key 可拒旧写），工具面仍 30，只修客户端生命周期/水合/队列并补 GUI V17。

### 12.1 本地视图 vs 工作区内容

- scope/binding/resetKey 变化、卸载、隐藏、切页签、能力暂缺都**只撤下当前面板的本地视图**，不得发 `release` 或空文档；退出模式仅 flush 真正 dirty 的内容（clean 时零 POST）。
- **显式清除**：取消草稿/文字/手势后按正常 `release:false` 立即发布空文档；任何来源都可清除；另一面板经 adoption 清空。Host 的 `release:true` 字段保留兼容，v3 客户端不再使用。
- **本地导航启动**仍立即清本地，并用旧冻结身份提交正常空文档，随后清掉旧内容队列（不在新 documentKey 重放）；Host 导航轮换负责最终清空。外部 token/address/有效非 seed epoch 变化取消草稿并重置文档，**不向新 key 补发空文档**去覆盖别人刚画的内容。

### 12.2 水合（hydrate）

- 入口在 `acceptRemote` 完成 runtime/revision 接受与视图采纳**之后**；同时处理 annotation POST ACK。只接收属本请求 scope generation 的 `ui.annotations`；校验 `version:1`/`space:'canvas-css-px'`/revision/context。
- 文档身份 `D = (已认证 scope.id, runtimeId, documentKey, pageGeneration, documentEpoch)`；有内容时 `annotations.context` 必须与 `ui.annotationContext` 完全一致（含 addressDigest）；空文档 `source/context/view=null` 是合法 authoritative empty，用同响应 context 定位 D。身份缺失/不符 → 先隐藏标注，不猜 recent/旧 scope。
- scope 变化当帧即用 identity gate 遮住旧列表，effect 再清本地/取消 transient/退出模式；**新 scope 首份可信 state 到达前既不显示也不发布旧 shapes**。sessionId 不作文档 key：同工作区换 session 允许短暂空窗，随后恢复同一 Runtime 的文档。
- 同 D 首次水合含 `revision=0` 空文档；此后只采纳更大的 `annotations.revision`（`ui.revision`/`view.revision`/`frame.seq` 都不作标注版本）；同 revision 仍刷新 stale 元数据；换 D 重置版本门槛。
- shapes 深拷贝并保序/id/样式：rect `width/height`→本地 `w/h`，brush `[[x,y]]`→`{x,y}`，箭头头继续按端点/线宽重算；几何都是画布 CSS px，**禁止按 scale 重算**。新增 id 取本地历史水位与导入 `aN` 最大值中的较大者并避开已占用。
- 首帧只建立当前帧 epoch 基线；不得把 `frame.epoch` 与 `documentEpoch` 混比，旧代帧不得清新文档；普通帧/平移/缩放不触发发布。
- `source.panelId` 只用于 ACK 归属、心跳与来源提示，**不限制水合**：自己的和别人的都恢复。adoption 绝不触发发布、不抢 source、不改 Host revision/updatedAt。

### 12.3 多面板 adoption 与 dirty

- clean 且无绘制/擦除/文字编辑时立即采纳更高 revision；busy/dirty/pending/error 时只记住同 D 最新候选，不替换可见集合；手势取消且无 dirty 后采纳；提交则保留本地集合并发布，**不静默合并形状**。
- dirty 独立于 timer/inflight：已提交集合 ≠ 最后一次被确认的规范化集合即 dirty；草稿与未提交文字不进 Host；擦除已删内容算 dirty；**无命中的橡皮擦不产生 POST**。
- ACK 按本地内容序号归属：旧 ACK 不能把较新本地修改标 synced；最终 ACK 的规范化形状（含 Host 截断）要回填；同步后再采纳比 ACK revision 更高的候选，丢弃 ≤ACK 的候选；error 保留本地内容，不被轮询覆盖成成功。
- LWW 边界 = Host 接受完整文档的先后，无跨面板 CAS/操作合并；clean 面板最终收敛，未完成手势不被 adoption 打断。本轮不新增协作协议。

### 12.4 卸载/重挂与发布者身份

- 卸载/切 scope 前冻结旧 D + 旧 headers + 已提交规范化集合，把未确认的最新内容交给**模块级 retained queue** 并立即 flush 真 dirty、保持在途；**绝不转成空文档**；草稿/文字取消，擦除已生效部分保留。重挂同 D 优先接回 dirty/error 集合，否则按 Host 权威水合。
- retained queue 不依赖卸载组件的 setState；每个逻辑发布者/文档最多 1 在途 + 1 最新待发。旧 scope 的网络完成只更新旧记录；新面板订阅必须同时匹配 mount generation + scopeEpoch + D；ACK、409、catch/finally、retry timer **全部**检查代次。
- 409 只废弃对应旧 D 的待发内容并请求当前 state，不清另一工作区；过时代次的回包不改当前 shapes/sync/revision；旧 runtime 请求永不用新 `scopeRef`/当前 view；payload/headers/panelId/surface 全部冻结。
- **发布者持久化**：`sessionStorage` 只存 `{panelId, lastAllocatedClientRevision}`，key = 版本前缀 + 已认证 opaque `scope.id` + runtimeId + surface(`main`/`sidebar`)；不存路径/会话 id/标注正文。模块级 registry 同 key 共用计数器/队列；同 surface 重复挂载不得各生成 UUID。
- 每次分配 revision 先持久化再发请求；重试用同 revision/同 body；重挂读取并续增，若 Host 当前 `source.panelId` 同 UUID 则 counter 还要 `max(存储值, source.clientRevision)`；切 session 同 runtime 复用，换 workspace/runtime 用另一记录；documentKey 轮换不回退计数。旧 snapshot 自带 panelId，不能用当前面板 UUID 代替。
- `sessionStorage` 不可用时降级为模块内 registry（保当前 GUI 页面内重挂）；完整 GUI 重载的身份复用不保证，记为限制。pending 正文只在模块内存留存。
- Host 水位维持“每 documentKey 16 来源、key 轮换清表”，**不改 LRU**（淘汰会让被淘汰来源的迟到旧写重新被接受）；稳定 workspace+surface 发布者解决常规反复重挂耗尽，真实多浏览器上下文的上限保留。

### 12.5 生命周期边界与同步状态

- 同工作区/session 切换与面板重挂保留；不同工作区只显示各自 Runtime 的文档。600s idle 回收、显式 close、CDP 断连、Host 重启结束页面文档并清空（沿用现契约），本轮不做磁盘持久化、不延长 Runtime 寿命。
- sync：`idle` = 当前有效 D 尚无文档且无修改；`synced` = 本地与已接受 Host 文档一致（含别人发布/合法空文档）；`pending` = dirty 待发/在途；`error` = 未确认修改失败；`unsupported` = 无标注通道。`data-utb-annot-revision` 表示**可见集合**最后对应的已接受 Host revision，不能取尚未展示的候选。
- `stale`（panel-unseen）≠ error/数据不存在：恢复时仍显示形状且 synced，状态栏 title 提示“标注已保存到工作区，来源面板心跳已过期”；不为消 stale 重新发布或伪造别人的心跳；stale 变化不改 revision。其他面板写入且本地 clean → synced；本地 dirty 仍 pending/error。
- **导航提示（文案级）**：标注入口/状态 title 补“标注按工作区保留，导航/刷新会清除当前页面标注”；不加弹窗/控件/布局。导航=换文档，标注不跨文档（含 hash/history 沿用已冻结规则）。

### 12.6 验收 V17（20 条 required，真实 CDP，不得直接改 React refs 伪造）

V17.1 退出/重进模式后 shapes 与 Host revision/updatedAt 不变、零冗余 POST；V17.2 隐藏页签再显示保持且零 release；V17.3 真正卸载→重挂（不能只隐藏 DOM）Host 内容/revision 不变且 SVG 恢复；V17.4 main→sidebar→main 恢复同份且不抢 source（data/SVG/屏幕位置 ≤2 CSS px）；V17.5 同 Runtime 的 session A1→A2→A1 恢复同份、空窗无旧 scope 形状、零清空写；V17.6 两工作区 A/B 各画不同 nonce、A→B→A 各自保留、清 B 不改 A；V17.7 B 新 revision → clean A adoption，Host 仅 B 一次内容写，A 不回声发布；V17.8 A 绘图时 B 更新不打断草稿，取消后采纳 B；V17.9 A 文字/IME 编辑时 B 更新不丢编辑，提交/取消两条路径分别核对；V17.10 A dirty + 晚 ACK + 新修改：旧 ACK 不得把新修改标 synced，最终规范化读回一致；V17.11 A 显式清除 → Host 与两面板最终为空且不被旧候选复活、保模式/样式；V17.12 commit 后 <150ms 卸载：已提交内容经 retained queue 送达、重挂恢复、草稿不提交；V17.13 持住 A 的 200/409/失败回包 → 切 B → 释放：B 的 shapes/sync/revision 与 Host 不变；V17.14 pending/error 保留不被轮询覆盖、回挂同 D 接回、一次重试规则如实；V17.15 六图形 roundtrip 水合后再画/擦，rect/brush 逆映射正确、id 唯一、顺序正确；V17.16 main/sidebar 各反复重挂并修改 ≥20 次：UUID 按 surface 稳定、clientRevision 单调、无 `annotation-source-limit`；V17.17 同页 GUI reload 后计数续增；storage 不可用降级可覆盖，禁止新增清 Host 动作；V17.18 模拟 panel-unseen 且 revision 不变：形状保留、stale 提示可见、无额外 POST/伪心跳；V17.19 外部导航/本地刷新/hash-history 两侧清空、晚帧/ACK 不复活、同 epoch 帧与 C/scale 不清；V17.20 close/Runtime 替换清空且旧缓存不复用，模式内 `/input` 零派发与旧 Host unsupported 不回归。

- 原 222 required 一条不放宽，目标 **242 PASS、0 FAIL**；V15.11d/11e 的“丢失是预期”NOT_RUN 说明失效，改由 V17 覆盖，**其余 12 条 NOT_RUN 保留**。
- `/state` 改写可证明客户端投影隔离，但必须同步 `ui.runtimeId`/`scope`/`annotationContext`/`annotations` 与帧代次；若没有真实 scope 转换，只能声称 projection adoption，真实 session 切换另列 NOT_RUN，**不得伪称 V17.5/V17.6 完整通过**；优先复用隔离实例的真实双 scope fixture。
- 报告需记录每步 D/面板位置/Host revision/形状摘要与 `/annotations` POST（隐藏鉴权）与 client 构建指纹；至少落“重挂后 / 双面板 adoption / A-B-A 隔离 / 显式清除”4 组前后 PNG 并实看；除截图外还要 DOM 几何与 Host 读回。
- 运行：`node --check client.js`、`git diff --check`；串行 `viewport.mjs`（19/206）→ `viewport-gui.mjs`（目标 242）；`workspace-isolation.test.mjs`（77）作隔离底座回归。Host 未改故不强制重跑 T3/截图全套；若共用导航/队列层被改再补 `run.mjs`（23/349）。不触碰 3080/3081。

### 12.7 验收结果（Lead 独立终验，2026-11-02 第三轮）

- **GUI**：`DSH_VIEWPORT_GUI_TIMEOUT_MS=900000 node tests/acceptance/viewport-gui.mjs` → **242/242 PASS、0 FAIL、12 NOT_RUN、exit 0**（Lead 独立复跑 [17-35-20](../tests/acceptance/runs/viewport-gui-2026-11-02T17-35-20-549Z-252325/run-report.json)，证据 [viewport-gui-2026-11-02T17-35-20-549Z](../tests/acceptance/evidence/viewport-gui-2026-11-02T17-35-20-549Z/SUMMARY.md)；执行者 [17-19-13](../tests/acceptance/runs/viewport-gui-2026-11-02T17-19-13-155Z-248576/run-report.json)）。原 222 条一条未放宽：V15.1d 仍是七工具唯一激活、V15.11d/11e 的“丢失是预期”NOT_RUN 删除并由 V17.3–V17.6 覆盖，其余 12 条 NOT_RUN 保留。V17.1–V17.20 全部 PASS。
- **Host 回归**：`node tests/acceptance/viewport.mjs` → **19/19 probes、206/206 required、0 FAIL、exit 0**（Lead [17-34-54](../tests/acceptance/runs/viewport-2026-11-02T17-34-54-691Z-251969/report.json)）；`index.js` **未改动**（sha256 前缀 `ae6c6b81`，与 v2 验收同一份）。
- **证据（Lead 已实看/对比）**：[证据目录](../tests/acceptance/evidence/viewport-gui-2026-11-02T17-19-13-155Z/SUMMARY.md) 的 4 组前后 PNG——`shot-22-v17-remount-before/after` 与 `shot-23-v17-generation-before/after` **逐字节相同**（sha256 一致，说明重挂/第二面板代次后画面与 Host 内容一致）、`shot-24-v17-isolation-b/a` 分别只显示 B（绿）/A（红）的 nonce 矩形、`shot-25-v17-clear-before/after` 清除后画布为空而模式/颜色/粗细保留；每组另附 DOM 几何（SVG data/CTM/屏幕 ≤2 px）与 Host 读回（revision/updatedAt/source/context）。
- **过程记录（不掩盖）**：执行者共 6 轮迭代。V17.15 连续 3 轮只挂一个条件，Lead 定位根因是**测试断言混用两种表示层**——本地 `data-utb-annot-points` 是 `[{x,y}]`（本地模型），Host 文档是 `[[x,y]]`（契约 §11.2/§12.2）；改为同时断言本地对象数组与 Host 数组后通过，**没有放宽任何既有断言、也没有为测试改实现**。其余失败（V17.1–V17.14/V17.16）均由实现侧修正（水合/代次/保留队列）。
- **12 条 NOT_RUN**：V7.10、V8.5、V15.0a、V15.0b、V15.2c、V15.6h、V15.7h、V15.14d、V15.12e、V10.4、V10.5、V10.6。
- **本轮新增未验证（如实，不得冒充通过）**：① **真实右栏 seat（main↔sidebar 真实切换）NOT_RUN**——隔离 shell 把右栏渲染为 collapsed track、expand 控件未挂载，V17.4 用“第二面板代次”验证同一文档/同一 source（detail 已写明 limitation），V17.16 的第二个 publisher 用真实 Host POST 合成 source（同 UUID 20 次写入验证 Host 16 水位与 clean 采纳）；② **真实 A1→A2→A1 会话切换与真实双 workspace 绑定链 NOT_RUN**——V17.5/V17.6 走 `/state` 投影（同步 runtimeId/scope/annotationContext/annotations 与帧代次），只证明**客户端投影隔离与保留**，并读回真实 A 文档未被 B 清除影响；③ V17 打开标注模式的 setup 有 DOM `.click()` 兜底（交接时 trusted click 被吞、hit=`svg`），绘制/擦除/零派发仍是真实 CDP，真实交互由 V15/V16 覆盖。
- **残余风险**：`annotApplyImported` 曾观测 Host `maxId` 非有限值，已 sanitize（水位归 0 + `used` 保证不复用），最终 run 无该 console error，但来源未定位；LWW 覆盖与迟到在途写仍是现有无 CAS 边界；500ms 一次性重试与 stale 语义沿用 v2。
- **生效方式**：只改 `client.js`，**刷新当前 GUI 即可**（Host 未改、无需重启 DSH）。刷新后请复测你报的场景：切页签、切会话/工作区——标注应保留且按工作区隔离；导航/刷新仍会清除当前页面标注。

## 13. v4 面板交互细节（2026-11-03 用户 6 条，已实现并验收）

> 只改 `client.js` + GUI 套件：**Host/index.js 未改、工具面仍 30、Host 的 `fill`/`stroke` 与 `ui.annotations` 契约不变**。GUI `viewport-gui.mjs` → **258/258 PASS、0 FAIL、12 NOT_RUN、exit 0**（Lead [05-34-26](../tests/acceptance/runs/viewport-gui-2026-11-03T05-34-26-811Z-79819/run-report.json)，证据 [05-34-26](../tests/acceptance/evidence/viewport-gui-2026-11-03T05-34-26-811Z/)）。

### 13.1 填充 / 外框 → 分页选择器（单选，第 1 条）

- 单一真源 `annotStyleMode ∈ {fill, stroke}`；派生：圆形/矩形 `{fill: mode==='fill', stroke: mode==='stroke'}`，line/arrow/brush 冻结 `{false,true}`，text 冻结 `{true,false}`，eraser 保持派生值。`annotSnapshot()`、图形渲染与 Host 上报**未改**。
- DOM：`div.utb-seg[role=group][aria-label="填充与外框"][data-utb-annot-seg="fill-stroke"]` + 两个 `button[data-utb-annot-mode="fill"|"stroke"][aria-pressed]`，顺序 fill→stroke；默认「外框」；**恰好一个 `aria-pressed=true`**；点已选项**完全 no-op**（不取消草稿、不提交活动文字编辑）。
- **选中态标记（2026-11-03 追加）**：每个选项左侧固定 8×8 SVG（`viewBox="0 0 8 8"`、`<circle r="3" fill="#22c55e">`、`aria-hidden`），**仅 `aria-pressed=true` 的项可见**，其余 `visibility:hidden` 但保留 8px 占位（切换时同组文字起点位移 ≤1px）；钩子 `data-utb-seg-dot="on|off"`、`data-utb-seg-group="fill-stroke|panfit"`。纯视觉，不参与计算/上报。
- 非闭合工具（line/arrow/brush）、文字与橡皮擦：整组 `disabled`，但**保留显示上次选择**；颜色/粗细的既有禁用矩阵不变。
- 语义收窄：GUI 不再产出“填充+描边同时为真”（旧标注数据仍可读/可擦）；如需恢复“实心+描边”，数据模型与 Host 都无需改。
- 已删除旧实现 `changeAnnotToggle` 与“最后一个勾选项不能被取消”的保护。

### 13.2 双向模式互斥（第 2 条）

- 尺寸调整（`sizing`）开启时「标注」入口原生 `disabled`，`data-utb-annot-entry="sizing"`，`title="尺寸调整模式下不可进入标注（先关闭尺寸调整）"`；`enterAnnotMode()` 首行用同拍的 `sizingRef` 再挡一次（防程序化/键盘路径绕过）。
- 反向（标注模式内尺寸调整入口禁用、尺寸栏不能在模式内打开）保持不变。`data-utb-annot-entry` 取值 `on|sizing|ready|unsupported`，供验收与调试读取。

### 13.3 默认分辨率按运行环境确定（第 3 条）

- `ENV_DEFAULTS`：web / windows / linux / macOS / TUI → `landscape`（1024×768）；android / HarmonyOS → `phone`（393×852）；game / three-d → `wide`（1920×1080）；**全部 `fit:true`**。面板初值取当前环境默认（初始 Web）。
- 冷启动且 Host `view.source==='default'` 时按该默认**发布一次** `{width,height,scale:1}`；与 Host 现值完全相等则**不发**（不动 revision）。
- 回访（已接受的 `source!=='default'`）**不套环境默认、零写入**；用户主动切换运行环境时套用默认并**只发布 `width/height`（不发布 `scale`）**、`fit=true`、退出拖拽；非 `ready` 环境只写表不生效（option 本身 disabled）。
- 影响：首次绑定默认从 393×852 变为 **1024×768**（GUI 断言 V3.1/V18.8 同步；Host 侧 `viewport.mjs` 零改动）。

### 13.4 拖拽 / 适应窗口 / 默认 → 分页选择器（第 4 条 + 追加第 6 条）

- DOM：`div.utb-seg[role=group][aria-label="拖拽与适应"][data-utb-panfit][data-utb-panfit-state="pan|fit|default"]`，顺序 **拖拽 → 适应窗口 → 默认**，紧跟百分比输入（沿用 `gap`，≤6px）；同样带“选中项左侧绿色小圆点”标记（见 §13.1）。
- **任何时刻恰好一个 `aria-pressed=true`**，选中态由实际模式推导：`pan ? 'pan' : fit ? 'fit' : 'default'`。
  - 选「拖拽」→ `pan=true, fit=false`；选「适应窗口」→ `pan=false, fit=true`；选「默认」→ `pan=false, fit=false`（`%` 回到共享 `view.scale`，**点它本身零 `/viewport`**，重复点 no-op）。
  - 点已选中的「拖拽」→ 退出到「默认」；点已选中的「适应窗口」→ 取消 fit 回落共享比例且不发布。
  - **手动改 `%` 输入 / 尺寸栏 `%` 滚轮**：只置 `fit=false` → 落到「默认」；若 pan 原本为 on，则保持「拖拽」（改数字不会把用户踢出拖拽模式）。
  - **拖拽模式内的画面滚轮缩放保持「拖拽」选中**（不回退为「默认」），保住 V14 已验收的锚点/步长/合并语义。
- 启用态：「拖拽」需 `viewSync && canvasOn && !annotOn`（旧 Host/无画布 `disabled`）；「适应窗口」/「默认」仅标注模式内禁用。删除旧 `data-utb-check="pan"` 复选框钩子。

### 13.5 粗细滚轮（第 5 条）

- 粗细输入加 `data-utb-annot-field="width"`；标注栏挂**非 passive** `wheel` 监听（沿用尺寸栏写法）：命中该字段才 `preventDefault + stopPropagation`（其余区域让窄栏正常滚动），Ctrl/Meta 吞掉不改，`deltaY===0` 不改。
- 步长：普通 ±1、Shift ±5、Alt ±1（**Alt 优先于 Shift**）；`clamp(1,20)`；文字/橡皮擦工具下不响应；**即时提交**（与输入框同一 `changeAnnotStyle` 路径，纯本地、不写 Host、无 draft/Enter/Esc）；不触发 `markHuman`（不谎报“人类接管”）。

### 13.6 验收（V18，真实 CDP）

V18.1 分段结构/默认外框/恰好一个 pressed；V18.2 点已选项 no-op 且不打断草稿；V18.3 填充模式 data+native 与屏幕 ≤2px；V18.4 外框模式且四个图形永不双 true；V18.5 五个工具下整组 disabled 但保留选中、切回矩形恢复；V18.6 尺寸栏开着入口 disabled（真实点击零进入、零 `/viewport`/`/input`）+ 关栏后恢复；V18.7 模式内尺寸入口仍 disabled 且打不开尺寸栏；V18.8 冷启动 first-bind 恰好一次 1024×768 + 横屏高亮 + 组状态 fit；V18.9 回访不重放环境默认（零 `/viewport`）；V18.10 `pan→fit→默认→pan` 每步恰好一个 pressed、grab↔auto、默认/fit→默认零发布；V18.11 手动 % 落「默认」且只发 scale；V18.11b 拖拽中编辑 % 仍「拖拽」；V18.12 粗细滚轮 ±1/Shift/Alt/clamp/不滚页面/不产出图形/工具禁用不响应；V18.13 三选一互斥 + 「默认」语义 + 旧 Host 下「默认」可用而「拖拽」disabled；**V18.14 两组每个选项都有 8×8 标记 SVG、只有选中项显示绿色小球（其余 hidden 但占位）、小球在文字左侧、切换后同组文字起点位移 ≤1px**；**V18.15 664px 窄屏下两组都不横向溢出、标注栏仍 41px 单行、选中点仍可见**。

- 原 242 条中因需求变更需改的：V3.1（默认尺寸）、V15.1e/V15.6a–f（复选框→分段单选与 no-op）、V15.3b（双向互斥）、V15.13a/b 与 V16.23（两栏改顺序两阶段）、V14.3（互斥下 fit 保持关闭）、V15.8c/V15.10a 与各读取点；**其余断言未放宽，`V14.*` 语义零改动**。
- **未验证**：真实 3080 面板交互（Host 未改，刷新面板即生效）；非 ready 环境（Android 等）只写表、其默认尺寸无法在 UI 验证；旧 Host 为 CDP 投影。**已知 flake 候选（未定位）**：`V6.5/V6.6`（Y-commit 时序）与 `V15.12c/V16/V17`（`CDP Fetch response rewriting is unavailable`），本轮各出现一次、重跑即绿、断言未改。
