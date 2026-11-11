# 选元素加入聊天框

调试视图的「选元素」模式：在预览里悬浮会框出光标下的页面元素，点击后把该元素的节点信息追加到 DSH 聊天框末尾，并把键盘焦点交回聊天框。对标 Chrome DevTools 的检查元素，但只发送一份文本块，不改页面、不写标注。

## 前置

- DSH 0.2.2-rc.1 及以上（Host 需要 `POST /plugins/ui-testing/element` 路由，旧宿主会提示「当前 Host 不支持选元素，请重启 DSH 后刷新面板」）。
- Host 改动后需要重启 DSH；面板需要刷新以加载新的 `client.js`。
- 面板必须已绑定会话；聊天框最好同时可见，推荐从右侧边栏的 guide 页打开 `debug-view`（会话绑定由右侧栏提供，聊天框留在中间）。主面板在身份解析为 `recent` 时没有可写入的会话，会提示「当前面板未绑定会话，无法加入聊天框」。

## 入口与互斥

工具栏「选择元素发送到聊天框」按钮的状态与可用性一致：

| 状态 | 含义 |
| --- | --- |
| 冷（`cold`） | 内嵌浏览器未启动；按钮 disabled，提示「需先启动内嵌浏览器」 |
| 未就绪（`unsupported`） | 运行环境/视口/画布同步未满足；按钮 disabled |
| 标注中（`annot`） | 标注模式占用；按钮 disabled |
| 尺寸调整中（`sizing`） | 尺寸调整模式占用；按钮 disabled |
| 就绪（`ready`） | 可进入 |
| 已开启（`on`） | 选元素模式中；按钮 `aria-pressed="true"` |

- 选元素、标注、尺寸调整三者**双向互斥**：任一模式开启时另外两个入口 disabled；程序化/键盘路径同样被拒。
- 进入时退出页面拖拽、退出平移、清除缩放意图并关闭菜单。
- 运行停止、页面切换、scope/标签切换、就绪或画布同步失效时自动退出并清除悬浮框。
- `Esc` 退出并把焦点还给入口按钮；输入框、文本域、可编辑区（包括聊天框）内的 `Esc` 不会被劫持。
- 指针离开预览时清除悬浮框。

## 坐标

- 悬停与点击都使用**页面文档 CSS 像素**（`getBoundingClientRect()` + `scrollX/scrollY`），也就是画布偏移 `O = 0` 时的画布坐标；面板侧用既有指针映射 `d = q + canvasPosition()`。
- Host 返回的 `scroll` 与 `rect` 来自同一次 `Page.getLayoutMetrics` 读取；`loaderId` 标识文档代次。页面滚动/切换导致画布原点 `C` 变化时，面板丢弃旧响应并按最新指针位置重取，不会画出错位的框。
- 固定/粘性定位元素的文档矩形等于「视口矩形 + 当前滚动」，因此它会随滚动改变文档坐标。

## 悬浮框选

- 移动到预览中的页面内容上：以 70–90ms 节流、单飞方式请求命中；只在指针位于页面区域时请求。
- 面板内渲染一层 `pointer-events: none` 的叠加层：2px 品牌色描边 + 12% 填充 + 左上角小标签（`tag#id`，无 id 时 `tag.class`），越界时标签夹紧到画布内。
- 叠加层是纯面板 DOM，不进入 Host 截图，也不写页面事件。
- 空白画布区域不请求、不派发页面事件；点击只清掉当前悬浮框，不选元素。
- 选元素模式内页面零输入：指针按下/移动/抬起与键盘都不派发给页面。

## 滚轮

选元素模式不拦截滚轮：滚轮照常滚动目标页面。滚动稳定（约 180ms 去抖，且 Host 画布原点 `C` 已回读）后，面板按最后的指针位置重新请求悬浮命中，因此框会跟随滚动后的元素重新定位。

## 点击加入聊天框（@ 元素引用 chip）

`pointerdown` 时以**当下坐标**重新请求一次完整详情（不复用可能过期的悬浮结果）。成功后优先把元素作为一条 **`@` 引用 chip** 插入聊天框末尾（保留既有草稿、@ 引用 chip 与引用块）：

- chip 只显示紧凑标签：`元素 <selector>`（selector 退化或过长时用 `tag#id.class` 兜底，标签最多 40 码点）；hover 的 `title` 与标签相同。
- **模型实际收到的是完整块**（由插件注册的 `@` 来源的 `codec.serialize` 生成），而不是 chip 标签：

```text
[调试视图元素] <outerHTML 折叠空白；超过 240 码点则截断并以 … 结尾>
selector: <稳健 CSS path>（degraded 时标注「非唯一定位，仅作线索」）
role: <role> · name: <name>
rect(文档坐标): x=…, y=…, w×h
page: <url>
frame: <子 frame 文档地址>（selector 在该 frame 文档内有效）   ← 仅嵌套 frame 命中时出现
outerHTML: 截断 <显示>/<原始> 码点（末尾 …，完整文本未取得）   ← 仅截断时出现
```

- `role` 与 `name` 都为空时省略整行。
- selector 优先唯一 `id`；否则生成带 `nth-of-type` 的祖先路径，并校验在所属 root 内唯一；Host 在 `selectorQuality` 里返回 `unique` / `degraded` / `none`，degraded 不当作稳定定位器。
- 点击 chip 会打开调试视图面板（`openReference`），便于回到该元素继续取证。
- 在聊天框输入 `@` 会出现「最近选取的元素」候选（按会话保存，最多 12 条），可直接重新引用。
- **降级**：`@` 引用插入不可用时（`inputTriggers`/`insertReference` 缺失、会话未保留、草稿处于 adjudicating/submitting/sending），自动回退为把上面的完整块作为纯文本追加，并在状态里标注原因；绝不静默丢弃元素。
- 成功后提示「已加入聊天框（引用）：<selector>」或「已加入聊天框（文本）：<selector>」，退出选元素模式，焦点交给聊天框；页面本身不产生点击。
- 失败时只在面板内提示，不抛异常、不写 Host `lastError`：
  - 未命中：「未命中页面元素（页面可能已变化）」
  - 旧 Host：「当前 Host 不支持选元素，请重启 DSH 后刷新面板」
  - 聊天框发送中：「聊天框正在发送，稍后再试」
  - 无会话：「当前面板未绑定会话，无法加入聊天框」
  - 会话未保留：「该会话未保留，无法加入聊天框（请在会话打开时操作）」
  - 会话切换：「会话已切换，请重试」
  - 其他：「获取元素失败，请稍后重试」

## 发送后的聊天记录

发送后的用户消息里，同样的 `[调试视图元素] …` 块会经客户端文本规则折叠为一条紧凑的**元素引用 chip**（`元素 <selector>`，悬停 `title` 显示完整原文：selector/rect/page/截断说明）。模型侧文本不变——发送时仍由 `codec.serialize` 提供完整块。

- 规则**只匹配引用块本身**（首行 `[调试视图元素] `，后续 `selector:`/`role:`/`rect(文档坐标):`/`page:`/`outerHTML:`），不跨普通段落；你在 chip 后面输入的其它文字原样保留在折叠块之外（末尾 `page:`/`outerHTML:` 行按固定结尾截断，不会把后续句子吞进 chip）。
- 历史消息同样按当前规则渲染；规则/渲染节点缺失时保持原文可见（不丢内容）。
- degraded selector、`outerHTML: 截断 …` 等信息保留在 chip 的 title 里，折叠不隐藏证据。

## Host 接口

`POST /plugins/ui-testing/element`（认证 scoped GUI，legacy 客户端仍受既有 `requestRejection` 闸）：

```json
{ "x": 300, "y": 322, "detail": false }
```

- `x` / `y` 是页面文档 CSS 像素，必须是有限数且 `|v| ≤ 1e7`；否则 `400 INVALID_ARGUMENT`。小数会被 floor 后再命中。
- 命中：`200 {ok:true, element:{tag,id,classes,rect,frameId,scroll,page:{url,title},loaderId?}}`；`detail:true` 追加 `selector` 与 `selectorQuality`（`unique`/`degraded`/`none`）、`outerHTML` 与 `outerHTMLTruncated`/`outerHTMLLength`、`text` 与 `textTruncated`/`textLength`、`role`/`name`（AX best-effort）以及 shadow 事实 `shadowHost`/`closedShadow`。
- 命中原生控件时排除浏览器自带的 UA shadow 节点，读取控件本身；页面作者创建的 open/closed shadow 命中规则不变。
- 命中 `<select>` 时追加 `select:{multiple,size,value,options:[{value,label,disabled,selected}],truncated,target?}`（最多 200 项，超出置 `truncated:true`）。`disabled` 包含控件、fieldset、option 和 optgroup 的有效禁用状态。可读取文档身份时，`target:{backendNodeId,loaderId}` 绑定该节点与文档；只有命中 select 才追加 `select` 字段。
- 命中嵌套 frame（同进程的 `<iframe>`）内的元素时，`rect` 仍是**顶层页面**文档坐标（iframe 偏移与滚动已折算），并追加 `frame:{id,url,main:false}`：`selector`/`outerHTML` 来自该 frame 的文档，`loaderId`/`select.target.loaderId` 也是该 frame 的文档代次。主帧命中不带 `frame` 字段，形状不变。
- 截断是显式的：`outerHTML` 超过 240 码点时切到 240 并以 `…` 结尾（`outerHTMLTruncated:true`、`outerHTMLLength` 为原始码点数）；`text` 同理（上限 160）。
- 未命中：`200 {ok:true, element:null, reason}`，`reason` 为：
  - `no-page`：该 scope 没有运行中的页面（冷态）；
  - `no-hit`：空白页面背景或该点没有节点（含子 frame 的 `html`/`body`）；
  - `stale`：CDP 读取失败/超时、主帧身份无法核对，或命中帧已不在当前 frame 树里；
  - `out-of-viewport`：文档点在当前可见视口之外。
- 只读：不启动 Chromium、不进串行队列、不占租约、不记录客户端指标、不写 `lastError`；每次 CDP 调用上限 1500ms。

`GET /element` 固定 `405`（该路由只接受 POST）。

`POST /plugins/ui-testing/select` 写回一个选项（面板浮层用；门禁与 `/input` 完全一致——A10 环境门、scoped 鉴权、`ready`/租约（BUSY）、串行队列，且校验在派发之前，拒绝时零派发）：

```json
{ "value": "world", "optionIndex": 1, "target": { "backendNodeId": 42, "loaderId": "文档身份" } }
```

- `value` 必填且必须是字符串。面板提交 `/element` 返回的 `target` 与点击的 `optionIndex`；Host 按**整棵 frame 树**校验该 `loaderId` 仍是活着的文档（主帧或嵌套 frame），再解析同一节点，不受后续聚焦变化影响。`optionIndex` 是非负安全整数，写前校验对应 option 的 value，因此重复 value 也能精确选择。
- 兼容调用可给唯一 `selector`（否则 `selector-not-found` / `selector-not-unique` / `selector-invalid`）；没有 `target` 或 `selector` 时才使用当前聚焦的 `<select>`。
- 写入用 `HTMLSelectElement.prototype.selectedIndex` 的 native setter，随后依次派发 `input`、`change`，返回 `200 {ok:true, value, selectedIndex, selector}`。禁用控件、禁用 option 和禁用 optgroup 均在写前拒绝。
- 拒绝统一 `400 INVALID_ARGUMENT`，`details.reason` 包括 `stale-target`（文档变化或节点无法解析）、`target-detached`、`option-index-out-of-range`、`option-value-mismatch`、`option-disabled`、`no-focused-element`、`not-a-select`、`select-disabled`、`unsupported-shape`（`multiple`/`size>1`）、`no-options`、`value-not-in-options` 与上述 selector 三类。
- 浮层等待页面点击完成后读取选项；关闭、scope/标签/文档切换（含嵌套 frame 导航）、画布原点或比例变化会使在途结果失效。选中或按 Esc 关闭后，键盘焦点交回预览。
- `multiple`、`size>1` 和无选项的控件只在地址栏下方、预览区域外显示键盘提示，不在页面画面上渲染提示浮层，也不抢走预览的键盘焦点。提示仍可见时，重复点击不支持的控件会保留同一条提示，不重新触发或改变预览布局；关闭后才可再次触发。按 Esc、点击预览外或其他内容可关闭提示，正常单选仍可直接打开选项列表。

## 限制

- **同进程嵌套 frame 可选**：页面内 `<iframe>` 的元素可以命中，`rect` 是顶层文档坐标、`selector` 属于该 frame 文档（响应里带 `frame`），`<select>` 浮层与写回同样可用。跨进程 OOPIF、closed shadow root 内部与不归属本页 frame 树的命中仍不支持，按 `no-hit`/`stale` 处理，不做坐标/selector 推断。
- **closed shadow**：可命中 shadow root 内元素，但 `selector` 是该 root 作用域的路径，`document.querySelector(selector)` 可能找不到；`detail.shadowHost` 给出宿主信息、`closedShadow` 标明 root 是否 closed。
- **主面板 `recent` 限制**：主面板身份解析不到会话时不写入聊天框，只提示；请使用右侧边栏的 session 面板。
- **画布平移 `O ≠ 0`**：本版 GUI 验收只覆盖 `O = 0` 与页面滚动（`C` 变化）；平移后的悬浮映射按共享画布的既有 fail-closed 规则处理。
- 显示 DPR 固定为 1；非 loopback 的远程 GUI 不在承诺范围。
- `role`/`name` 来自可访问性树，是 best-effort，不是语义识别；不提供 OCR 或视觉命名。
- 选元素模式不修改页面、不创建标注、不进入截图。

## 验证

```bash
node tests/acceptance/pick-element-host.mjs   # Host：坐标空间/命中/detail/嵌套 frame/只读语义/边界（145 checks）
node tests/acceptance/pick-element-gui.mjs    # GUI：隔离 DSH + 无头 Chrome 的真实面板操作（选元素/悬停/@ 引用 + `--select-only` 分支含下拉浮层与右键菜单）
```

两个套件都自启资源：Host 套件使用 fake-Cordis harness + 插件自己的无头 Chromium；GUI 套件自建隔离 DSH（临时 `DSH_HOME`、随机端口，绝不用 3080/3081）并另开无头 Chrome 驱动真实面板。报告与截图分别写入 `tests/acceptance/runs/`、`tests/acceptance/evidence/`；`NOT_RUN` 原样保留，不当作通过。
