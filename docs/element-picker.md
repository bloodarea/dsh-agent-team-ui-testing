# 选元素加入聊天框

调试视图的「选元素」模式：在预览里悬浮会框出光标下的页面元素，点击后把该元素的节点信息追加到 DSH 聊天框末尾，并把键盘焦点交回聊天框。对标 Chrome DevTools 的检查元素，但只发送一份文本块，不改页面、不写标注。

## 前置

- DSH 0.2.2-rc.1 及以上（本机验证版本；Host 需要 `POST /plugins/ui-testing/element` 路由，旧宿主会提示「当前 Host 不支持选元素，请重启 DSH 后刷新面板」）。
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
- 截断是显式的：`outerHTML` 超过 240 码点时切到 240 并以 `…` 结尾（`outerHTMLTruncated:true`、`outerHTMLLength` 为原始码点数）；`text` 同理（上限 160）。
- 未命中：`200 {ok:true, element:null, reason}`，`reason` 为：
  - `no-page`：该 scope 没有运行中的页面（冷态）；
  - `no-hit`：空白页面背景或该点没有节点；
  - `stale`：CDP 读取失败/超时，或主帧身份无法核对；
  - `frame`：命中在子 frame（v1 只选主帧）；
  - `out-of-viewport`：文档点在当前可见视口之外。
- 只读：不启动 Chromium、不进串行队列、不占租约、不记录客户端指标、不写 `lastError`；每次 CDP 调用上限 1500ms。

`GET /element` 固定 `405`（该路由只接受 POST）。

## 限制

- **只选主帧**：iframe / OOPIF 内部元素返回 `reason:"frame"`，与 T2 `snapshot` 的 `frame:"main"` 范围一致；跨帧坐标/selector 不做推断。
- **closed shadow**：可命中 shadow root 内元素，但 `selector` 是该 root 作用域的路径，`document.querySelector(selector)` 可能找不到；`detail.shadowHost` 给出宿主信息、`closedShadow` 标明 root 是否 closed。
- **主面板 `recent` 限制**：主面板身份解析不到会话时不写入聊天框，只提示；请使用右侧边栏的 session 面板。
- **画布平移 `O ≠ 0`**：本版 GUI 验收只覆盖 `O = 0` 与页面滚动（`C` 变化）；平移后的悬浮映射按共享画布的既有 fail-closed 规则处理。
- 显示 DPR 固定为 1；非 loopback 的远程 GUI 不在承诺范围。
- `role`/`name` 来自可访问性树，是 best-effort，不是语义识别；不提供 OCR 或视觉命名。
- 选元素模式不修改页面、不创建标注、不进入截图。

## 验证

```bash
node tests/acceptance/pick-element-host.mjs   # Host：坐标空间/命中/detail/只读语义/边界（137 checks）
node tests/acceptance/pick-element-gui.mjs    # GUI：隔离 DSH + 无头 Chrome 的真实面板操作（54 checks）
```

两个套件都自启资源：Host 套件使用 fake-Cordis harness + 插件自己的无头 Chromium；GUI 套件自建隔离 DSH（临时 `DSH_HOME`、随机端口，绝不用 3080/3081）并另开无头 Chrome 驱动真实面板。报告与截图分别写入 `tests/acceptance/runs/`、`tests/acceptance/evidence/`；`NOT_RUN` 原样保留，不当作通过。
