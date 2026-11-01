# Web T2 结构化 GUI 调试契约

> 本文是本轮 T2 的权威实施与验收契约，已纳入 Lead 的接口裁决。本文为静态设计交付，T2 实现与运行验收状态均须由实施报告另证；不能以本文声称通过。现行基线见 [T1 契约](t1-m0-m2-contract.md) 与 [工作区隔离契约](workspace-isolation.md)。

## 1. 范围与运行不变量

新增恰好 7 个工具：`browser_snapshot`、`browser_click`、`browser_type`、`browser_scroll`、`browser_fill_form`、`browser_node_state`、`browser_wait_for`。工具总数由 9 变为 **16**，覆盖元素发现/定位、点击、输入、滚动、表单、交互测试、节点状态与结构化证据。交互测试由这些原语组合；派发成功与业务断言通过分开记录，不新增测试 DSL 或自动 PASS 字段。

沿用一个 headless Chromium/profile、每 DSH 工作区一个 page Runtime。Ref 注册表、URL、网络缓冲、队列和 single-owner-lease 按 Runtime 隔离；Cookie/存储仍共享。七工具均经过现有 `register()`、可信 exec scope 解析与 `Runtime.run()`，包含只读 snapshot/node_state/wait_for 也受其他 owner 的 BUSY 限制。合法页面操作可懒启动；纯参数校验先于 ensure/输入派发。`browser_state`、`browser_capabilities` 继续不启动、不夺 owner；独立 HTTP 原语保持独立。

结果沿用 `actionId/sessionId/startedAt/finishedAt/target/args/scope` envelope；外层 `target` 仍为脱敏页面 URL，节点目标放在 evidence，不覆盖 envelope。返回及错误 details 经过现有 lossless JSON 投影，render 保留业务值与证据。只用现有 CDP 和 Node 内建库，**零新 npm 依赖**，不引入 Playwright/Puppeteer。不改面板视觉/文案/按钮状态，不实现面板“选择元素”回传聊天。

保存本文不需重启；后续 Host/Skill 修改需要重新加载 DSH 并在隔离实例验证，不因本文获得操作或重启主 3080 的授权。

## 2. 最终工具接口

### 2.1 共用参数及校验

动作目标使用两个互斥 **string** 参数 `ref` / `selector`，不使用 Target 对象，不要求调用者提供 snapshotId。

- `ref:string`：`^e[1-9][0-9]*$`，最多 32 字节；不接受 `@e12` 或裸数字。协议详见 §3。
- `selector:string`：原生 CSS selector，非空、≤2048 UTF-8 字节、不含 NUL；只查主文档，必须唯一，详见 §3。
- click/type/node_state 必须恰好提供一个；fill_form 每项也如此。scroll 两者可都省略（文档滚动）；wait 的目标条件详见 §4。snapshot 可选 `scope:{ref?:string,selector?:string}`，提供 scope 时其中恰好一个，不使用顶层 ref/selector。
- 所有对象拒绝未知字段；错误类型、非有限数、越界、整数参数小数、非法枚举、目标冲突均抛 `INVALID_ARGUMENT`。不隐式 stringify、不 clamp。无特别说明的长度单位为 UTF-8 字节，截断保持 Unicode 边界。
- 所有工具成功为 `{ok:true,...businessFields,evidence}`；**全部 T2 参数、目标、协议和动作失败抛 BrowserError**，不返回 `{ok:false,error}`。T1 legacy 查询原形状不变。
- 宿主支持的 schema 子集有限，类型/required/oneOf 可注册，长度/范围/模式在执行时校验；不能把 `minimum` 等不支持关键字写进 output.schema。

### 2.2 七工具表

`*` 表示必填；“目标恰一”是运行约束，不伪造 JSON schema required 数组。

| 工具 | 参数（类型、默认、边界） | 业务成功字段 | 主要失败 |
| --- | --- | --- | --- |
| `browser_snapshot` | `scope?:{ref?:string,selector?:string}`；`maxNodes?:integer=500`，1–2000；`depth?:integer=12`，0–32；`boxes?:boolean=false` | `snapshotId:string,digest:string,tree:string,refs:object,nodeCount:integer,truncated:boolean,truncationReasons:string[],coverage:{frame:"main",shadow:"ax-backed",complete:boolean}` | scope 的 REF_STALE/TARGET_NOT_FOUND/TARGET_NOT_UNIQUE；采集中文档代次变化 REF_STALE，不发布混合快照 |
| `browser_click` | `ref?:string,selector?:string`，目标恰一；`button?:"left"|"right"|"middle"="left"`；`clickCount?:integer=1`，1–2；`modifiers?:string[]=[]`，最多 4 个不重复的 alt/ctrl/meta/shift | `dispatched:true,button,clickCount,point:{x,y}` | 目标错误；NOT_INTERACTABLE；帧/特殊控件 UNSUPPORTED |
| `browser_type` | `ref?:string,selector?:string`，目标恰一；`text*:string`，允许空串、≤65536；`replace?:boolean=true`；`submit?:boolean=false` | `dispatched:boolean,insertedCharacters:integer,replaced:boolean,submitted:boolean`，字符数按 Unicode code point；不回显输入 | 目标错误；NOT_INTERACTABLE；不支持编辑器 UNSUPPORTED |
| `browser_scroll` | `ref?:string,selector?:string`，至多一；`direction?:"up"|"down"|"left"|"right"`；`amount?:integer=400`，1–10000 CSS px；`to?:"top"|"bottom"`。direction 与 to 必须恰一；to 禁止 amount | `dispatched:boolean,requested:{direction:string|null,amount:integer|null,to:string|null},scrollBefore:{x,y},scrollAfter:{x,y},moved:boolean` | 目标错误；不可滚/被覆盖 NOT_INTERACTABLE；参数冲突 INVALID_ARGUMENT；已到边界 moved=false 是成功 |
| `browser_fill_form` | `fields*:Field[]`，1–20 项；Field 详见下表，整批文本值总量 ≤65536 | `applied:integer,fields:[{index,type,changed,nodeBefore,nodeAfter,eventSource}]`；不回显原 value | 参数/目标错误；NOT_INTERACTABLE；失败 details 有 applied/failedIndex/fields，可部分生效，不回滚 |
| `browser_node_state` | `ref?:string,selector?:string`，目标恰一 | `node:NodeState` | 目标错误；hidden/disabled/readonly/covered 本身不导致读状态失败 |
| `browser_wait_for` | `text?:string,textGone?:string`，非空、≤4096；`ref?:string,selector?:string`，至多一；`state?:{visible?:boolean,enabled?:boolean,checked?:boolean,valueEquals?:string}`，至少一已知 key，valueEquals ≤4096、可空；`timeoutMs?:integer=5000`，0–30000；`pollMs?:integer=100`，50–1000。条件组合见 §4 | `matched:true,elapsedMs:integer,polls:integer,condition:object,node:NodeState|null` | REF_STALE/TARGET_NOT_UNIQUE/WAIT_TIMEOUT；错误条件 INVALID_ARGUMENT |

`Field` 中 `ref?:string,selector?:string` 必须恰一，`type` 与 `value` 必填：

| type | value 类型与约束 | 支持控件与操作 |
| --- | --- | --- |
| `textbox` | string，≤65536 | 普通文本 input/textarea；清空替换，复用 type，不自动提交 |
| `checkbox` | boolean | 原生 input checkbox；可信点击到指定 checked；已满足不点击 |
| `radio` | boolean，仅 true | 原生 radio；可信点击选中，不提供 false 取消选择 |
| `combobox` | string，或 1–20 项不重复 string[]；每项 ≤256 | 原生 select，以 option.value 精确匹配；单选必须 string，多选必须 string[]；选项必须存在且未禁用 |
| `slider` | finite number | 原生 input range；值在 min/max 内且符合 step；不支持无法有界表示的 step=any |

组合框与 slider 的写入是明确的 DOM 控件操作（原生 setter + 冒泡 input/change），不能宣称这些事件 isTrusted。其 `eventSource:"dom-control"`；click/type/checkbox/radio 为 `eventSource:"cdp-input"`。不打开原生 select popup、不模拟拖动 range。选项缺失/禁用、控件类型不符为 NOT_INTERACTABLE；value 类型、重复值、越界/step 不符为 INVALID_ARGUMENT。失败检查发生在整批输入派发前。

`EXPECTED_TOOLS` 新增 required 数组为 snapshot `[]`、click `[]`、type `['text']`、scroll `[]`、fill_form `['fields']`、node_state `[]`、wait_for `[]`。ref/selector 恰一、direction/to 恰一、wait 条件合法性由执行层验证，验收不能把 required=[] 误当允许空动作。

## 3. Snapshot 与 Ref 协议

### 3.1 输出格式与边界

语义来源是 `Accessibility.getFullAXTree({frameId:mainFrameId})`，按 AX 子节点顺序深度优先前序输出。scope 先唯一解析并验证身份，然后选择对应 AX 子树，scope 根深度为 0；无 scope 为主文档根。底层仍可能完整采集主 AX 树，scope 减少输出和句柄解析成本，不保证减少原生 AX 采集成本。

两空格缩进、LF、无末尾换行；name 使用 JSON 字符串转义：

```text
- RootWebArea "Fixture"
  - heading "设置" [level=1] [ref=e1]
  - textbox "姓名" [focused] [ref=e2]
  - checkbox "订阅" [checked=false] [ref=e3]
  - button "保存" [disabled] [ref=e4]
```

1. 保留非空文本、语义分组、列表/表格、image/svg/canvas、iframe、带 name/ref 的节点。ignored 包装提升子节点并保持顺序；移除空白（含 NBSP/零宽格式符）text；无名无 ref 的 generic 空容器删除、单子容器折叠、多子容器保留。不可因非交互删除有内容的 text。

   **空白文本的投影（2026-11-01 裁决）**：不输出空文本行（`- text ""` 为缺陷）；作为内联片段分隔符的空白文本投影为**单独一行** `- text " "`，不折叠进相邻 sibling（避免有损拼接或改变 sibling 文本）、不丢弃；纯排版缩进/换行产生的空白不输出。

   **允许合并同一内容的冗余 AX 表示（2026-11-01 优化）**：仅当子子树**全部**是"无 ref、无独立 state、无 frame/shadow/role 边界、无语义包装"的纯文本表示，且其有序完整拼接与该父级**原始** accessible name / content **精确相等**时，只保留唯一一份表示。heading/button/link 等"内容命名 owner"首版允许此类抑制，但必须证明 name 来自该 owner 的 contents（`aria-label`/`aria-labelledby`/外部 label 不属于此列，不得据此吞掉同名子文本）。StaticText → InlineTextBox 的纯文本链只保留一份；多片 InlineTextBox 不逐片全局去重；换行/空格不做有损 normalize。
   压缩在 emit / 节点计数 / byte 预算之前完成：被合并的表示不计入 truncation，`nodeCount` 仍等于实际输出行数，depth/coverage 对最终语义投影计算。资格比较使用限长/脱敏**之前**的原始值；若保留表示会发生截断或脱敏碰撞，则保守不抑制更完整的子表示。带 ref/name/state 的独立语义节点、同名 sibling、不同 role 的父子、listitem/tablecell/iframe/image/canvas 与任何 frame/shadow 边界一律保留。
2. 仅给主文档中有 backendDOMNodeId、可 resolve 成 connected Element 的非 ignored **语义**节点分配 Ref。StaticText/inline text/虚拟 AX 节点无 ref；**不可交互的非语义 `generic` 包装一律不分配 ref**（含 contenteditable generic——该编辑器本层不支持，需要查询时用显式 selector；`role=textbox` 的自定义控件不受影响）。无法 resolve 可显示 `[unresolved]`，不能伪造句柄。iframe 是边界叶子，不输出内部 ref。
3. role ≤64、name ≤256、text ≤512 字节（含 `…` 后缀）；先脱敏后截断，不输出可编辑 AX value。适用且已知的 state 顺序固定为 level/disabled/readonly/checked/selected/expanded/required/invalid/focused。
4. boxes=true 行尾追加 `[box=x,y,width,height]`，保留小数后 2 位；refs 对应 bbox 相同。boxes=false 无 box 文本，refs.bbox=null；避免无必要的逐节点几何读取。动作证据总是现场读 bbox。
5. maxNodes 限制语义输出行数；depth=0 只输出根。tree ≤131072 字节，完整快照业务 JSON（不含 envelope）≤524288 字节。限额在完整行/ref 项边界停止，不破坏 JSON；truncationReasons 为 maxNodes/depth/treeBytes/resultBytes，truncated=true、coverage.complete=false。nodeCount 为实际行数。
6. coverage.complete 只表示本次 scope 语义投影未被限额截断，不表示 AX 包含全部 DOM/视觉内容。无额外虚假省略节点或 ref。

每 Runtime capture 成功发布产生单调 `snapshotId:"s1","s2",…`，导航/close 后计数不重置；插件新进程可重置，证据用 runtimeId/pageGeneration 区分。`digest=sha256(Buffer.from(tree,'utf8')).digest('hex').slice(0,16)`，只计算最终脱敏、截断、带 ref/可选 boxes 的精确 tree 文本，不含 URL/title/时间/snapshotId/refs map。

refs map 示例：

```json
{"e2":{"role":"textbox","name":"姓名","backendNodeId":42,"frameId":"MAIN","bbox":null,"snapshotId":"s1","digest":"0123456789abcdef"}}
```

其中 snapshotId/digest 是 **minted provenance**：首次分配该 ref 的已发布快照。role/name/bbox 是本次快照现场读数。objectId 留在 Runtime 内部，不作为客户端句柄。refs 仅包含树中显示的有效项，不宣称生成 stableLocator；本轮不自动推导 CSS/role-name locator。

### 3.2 分配、复用和失效

ref 为 e1、e2…，在 **同一 Runtime 整个生命周期单调增长、永不复用编号**，包括导航、page 回收、close 后重建。每次快照按最终输出前序处理：同一 documentEpoch/backendNodeId 已有有效 entry 则复用其 ref；新身份才分配下一个编号。新 entry 在成功发布时写入本次 snapshotId/digest。先构建完整有界结果，文档代次未变才发布；失败 capture 不发布半份表。Ref 计数用安全整数，耗尽前抛 UNSUPPORTED，不能回绕。

注册表是每 Runtime 最多 2000 项的 LRU，访问/再次展示更新活跃度；若插入导致溢出，淘汰最近未使用项，但优先保留本次输出（本次最多 2000 refs）。已淘汰节点重新发现只能分配更大新编号，不复活旧号。内部表保存 runtimeId/pageGeneration/documentEpoch/backendNodeId/frameId/minted snapshotId/digest，不保存长期 objectId。当前快照与保留 refs 是不同概念。

**较新快照不自动使旧 ref 失效**：旧 ref 仍在 LRU 且身份有效时可继续操作，证据使用其首次 minted provenance；不在最新输出中不等于失效。相同静态内容连续捕获会复用 refs，故 tree/digest 相同，snapshotId 不同。LRU 淘汰或节点身份变化导致 ref 变化时，包含 ref 的 tree/digest 可随之变化；不得声称 digest 忽略 refs。

以下清空 refs/提升 documentEpoch：主框架跨文档 navigation commit、reload、跨文档 history commit、主执行上下文丢失、page close/回收/重建、CDP 断连。事件监听处立即处理，不等下一次 browser_navigate。pushState/replaceState/hash/同文档 popstate 不清；每动作仍复验身份。其他条件：unknown ref、被 LRU 淘汰、节点 detach/替换或身份不符均 REF_STALE。DOM 移动原节点仍可有效；同名/同属性新节点不是原节点。

### 3.3 身份与 selector 规则

解析 ref 时先查当前 Runtime entry 与 page/document 代次，然后 `DOM.resolveNode({backendNodeId,objectGroup})` 得 objectId；`Runtime.callFunctionOn` 对该对象检查 Element、isConnected、ownerDocument、主 frame，必要时 `DOM.describeNode({objectId})` 反查 backendNodeId。必须等于原 entry 身份；role/name/bbox 只读当前状态，不能拿同名当证明。对象在 action object group 结束时释放，避免钉住已移除节点。

selector 仅由调用者显式提供，主文档 querySelectorAll 必须 **唯一**：0=TARGET_NOT_FOUND，>1=TARGET_NOT_UNIQUE（隐藏副本也计入）。无 first/nth/隐式只选可见节点、无 ref 失败后的 selector 自动回退。CSS 语法错=INVALID_ARGUMENT。唯一匹配后获取 backend 身份，后续与 ref 相同；派发前被替换=REF_STALE，不重新选择替代节点。动作准备、自动滚动后和最终派发前都复验，不使用缓存 bbox。

selector 不穿透 shadow root、不进入 iframe、不支持 XPath/文本 DSL/伪 Playwright API。需要 shadow 用 snapshot 发出的 AX-backed ref；无法证明身份时拒绝。所有匹配计数与身份结果进入 evidence。

## 4. 动作、表单与等待

### 4.1 actionability 和可信派发

click/type/表单写入前检查 connected、主 frame、非 disabled（含 fieldset/aria-disabled=true）、无 inert、display/visibility 可见、正面积 rect；type 额外 editable 且非 readonly。node_state 可读取 hidden/disabled/covered，不能因不可交互而拒绝只读查询。aria-hidden 不等于 DOM 隐藏，应分别保留 AX/DOM 差异；无 AX Ref 的隐藏元素可显式 selector 查询。

before 先于自动滚动/聚焦。可交互但离屏的目标先 scrollIntoView(center,instant)，在最多 1000ms 内用两次连续 animation frame（间隔最多 100ms）证明 bbox 四项差值均 ≤1 CSS px。取 rect 与 viewport 交集中心点，使用 DOM.getNodeForLocation 和/或 open shadow 的递归 elementFromPoint 验证，命中必须是目标或 composed descendant。无交集、持续运动、overlay、pointer-events:none、只能看到 shadow host 但无法证明内部命中均拒绝；不搜索别的点击点，不提供 force/JS click 逃生参数。

hidden/covered 的 NOT_INTERACTABLE 必须有 `details.escalation:"T3"`，evidence.escalation 同步说明原因；持续布局运动可建议 T4。hit-test 只能证明当前坐标命中，颜色/可读性/遮挡成因等视觉判断仍属 T3。

click 使用 CDP mouseMoved/Pressed/Released；double click 两组 press/release，clickCount 为 1、2；正确 button/buttons/modifiers。type 点击并深入 open shadow activeElement 验证焦点，replace=true 用 Ctrl+A/Backspace down/up 再 insertText；replace=false 明确追加末尾，先将 caret 放末尾；空串 replace 清空。支持 text/search/email/url/tel/password input 和 textarea；单行输入含 CR/LF 抛 INVALID_ARGUMENT；不支持 number/date/file/hidden/contenteditable 编辑器，抛 UNSUPPORTED。普通 insertText 不产生逐字符 keydown，不承诺 IME/composition。

type 在内存比较最终值，不公开原值；焦点被拦截、beforeinput 被取消、控件恢复旧值为 NOT_INTERACTABLE，reason=focus-mismatch/value-mismatch。submit=true 在值验证后派发 Enter down/up（virtualKeyCode=13），先取输入后的节点状态再 Enter，pageAfter 取 Enter 后即时结果；submitted=true 只表示 Enter 已派发，不代表业务提交通过。dispatch/已生效变化不得自动重放。

### 4.2 表单批处理

fields 整批纯参数检查→解析所有身份/控件类型/选项/值范围→检查基础 actionability，再按数组顺序执行。不同 target 指向同一 backend 节点也为 INVALID_ARGUMENT；整批预检失败零输入。预检不把所有离屏节点依次滚入，实际每项执行时再滚动/命中/复验。中途失败立即停止，details 保留 applied、failedIndex、已完成 fields 与失败项 dispatch 状态；无事务回滚、无跳过。

textbox/checkbox/radio 复用可信输入，already satisfied 的 checkbox/radio changed=false 不派发。checkbox mixed 状态读回，最终 checked 必须符合请求。combobox 支持单/多选原生 select，通过原生 HTMLSelectElement/option setter 设置并派发 input/change；slider 用原生 input value setter + input/change；两者 eventSource=dom-control，读回 selected values/value 验证，不能把 DOM 写入声称用户可信输入。这是表单结构状态支持，不是 native popup/drag 的测试。自定义 ARIA combobox/slider 不接受这种 setter，由已支持节点组合操作或明确 UNSUPPORTED。

### 4.3 滚动

direction 映射有符号 wheel delta，amount 默认 400；默认作用 document.scrollingElement，目标参数指定元素自身滚动区。元素必须 visible、stable、viewport 有交集、中心点可命中且轴有滚动范围；不要求 enabled/editable。方向动作走 Input.dispatchMouseEvent(mouseWheel)，两帧后最多观察 1000ms 至位置稳定，返回实际位移；滚动链影响祖先/page 必须在 evidence.page scroll 中读回。到边界 moved=false 仍成功。

**不自动滚入视口（2026-11-01 裁决）**：指定元素时本工具不把目标或其祖先滚入视口——`click`/`type` 的准备滚动语义不适用于本工具。`direction` 与 `to` 都在派发前校验 visible/stable/viewport 交集/中心命中；不满足即零派发 `NOT_INTERACTABLE`（reason=`outside-viewport` 或 `unstable`），`details` 附固定 hint：先用**不带** ref/selector 的 `browser_scroll` 滚动文档，使目标进入视口后重试（hint 不得包含 selector 原文）。失败前后的页面与元素 scroll 读数进入 evidence，便于核对"零副作用"。元素稳定性用两次连续 animation frame 的 bbox 四项差 ≤1 CSS px 证明；持续运动一律拒绝，不换点击点、不 force。

to=top/bottom 是显式精确滚动命令，对目标滚动区 `scrollTo({top:0|scrollHeight-clientHeight,behavior:'instant'})`，eventSource=dom-scroll，返回实际结果；不模拟无限 wheel。direction 动作 eventSource=cdp-input。to 禁止 amount，方向与 to 不可同给，不能默认猜方向。

### 4.4 等待

条件恰好属于以下一类，混用 INVALID_ARGUMENT：①仅 text；②仅 textGone；③ref/selector 恰一 + state（state 省略等价 `{visible:true}`）。无目标时禁止 state；有目标时禁止 text/textGone。state 多 key 为 AND；visible/enabled/checked 为布尔期望，valueEquals 精确等于，text/textGone 是主文档 body.innerText 的包含/不包含（不穿 iframe/shadow），不支持 regex/任意 JS。

selector 0 命中时 `{visible:false}` 可满足；其余 enabled/checked/valueEquals 不因节点缺失而满足。>1 立即 TARGET_NOT_UNIQUE。Ref 失效立即 REF_STALE，不能当“隐藏/移除条件成功”；等待移除使用 selector+visible=false。covered 不等于 hidden，visible 不等于 clickable。不适用 checked/valueEquals 的节点类型 INVALID_ARGUMENT；未知读数永不视作满足。

timeout 从首次 poll 前开始，不含排队/启动耗时；timeout=0 只一次，poll 可取消 timer，无 busy loop。单份满足样本即可 matched，不承诺持续满足；polls/elapsedMs 真实记录。不满足到期 **抛** WAIT_TIMEOUT，details 至少 `{elapsedMs,polls,condition}`，retryable=true，不关闭 page。不能把 CDP_TIMEOUT/断连/取消变成 WAIT_TIMEOUT。timeoutMax=30000 与既有工具 wrapper 30000 相等，实施须为 wait_for 单独留宿主清理余量（建议 definition.timeoutMs=35000），让 30000ms 条件预算能返回 WAIT_TIMEOUT；其余工具保持原 30000。CDP 本身失败仍沿用 close-before-unlock，不以延长工具预算覆盖无限 CDP 等待。

## 5. 结构化证据与能力报告

### 5.1 证据 schema

每个 T2 调用成功或抛错都产生 version=1 evidence；纯参数/BUSY/队列前取消不能为取证启动/访问页面，未观察字段 null 且 incomplete 说明原因。成功放 `result.evidence`；失败放 `BrowserError.details.evidence`，render/message 规则见下。

```text
Evidence = {
  version:1, operation:string,
  provenance:{runtimeId:string|null,pageGeneration:integer|null,documentEpoch:integer|null,
    snapshotId:string|null,digest:string|null,source:"ref"|"selector"|"document"|"snapshot"},
  targets:[{
    fieldIndex:integer|null,
    requested:{kind:"ref",ref:string}|{kind:"selector"}|{kind:"document"},
    resolved:{ref:string|null,role:string,name:string,bbox:BBox|null,frameId:string,
      identity:{backendNodeId:integer,objectResolved:boolean,connected:boolean,
        ownerDocumentMatched:boolean,backendNodeMatched:boolean}}|null,
    nodeBefore:NodeState|null,nodeAfter:NodeState|null,
    provenance:{snapshotId:string|null,digest:string|null}
  }],
  before:PageObservation|null,after:PageObservation|null,
  dispatch:{started:boolean,eventCount:integer,completed:boolean,eventSource:string|null},
  networkDelta:{from:integer,to:integer,total:integer,dropped:integer,entries:NetworkEntry[]},
  escalation:{tier:"T3"|"T4"|null,reason:string|null},
  incomplete:string[],truncated:boolean
}
BBox = {x:number,y:number,width:number,height:number}
PageObservation = {observedAt:epochMs,url:redactedString,title:string,
  focus:{backendNodeId:integer|null,role:string,name:string}|null,
  scroll:{x:number,y:number},viewport:{width:number,height:number}}
NodeState = {connected:boolean,role:string,name:string,tagName:string,inputType:string|null,
  visible:boolean|null,enabled:boolean|null,editable:boolean|null,readOnly:boolean|null,
  checked:boolean|"mixed"|null,selected:boolean|null,expanded:boolean|null,
  required:boolean|null,invalid:boolean|string|null,focused:boolean|null,
  bbox:BBox|null,inViewport:boolean|null,hitTarget:boolean|null,
  text:string,value:string|null,valueRedacted:boolean,
  scroll:{x,y,scrollWidth,scrollHeight,clientWidth,clientHeight}|null}
NetworkEntry = {seq:integer,requestId:string,url:redactedString,method:string,type:string,
  status:number|null,failed:boolean,errorText:string|null,at:epochMs}
```

role/name 优先读取当前 backend node 的 AX（可用 getPartialAXTree），不套旧快照。bbox 是现场视口 CSS px；不可测 null，所有 number 有限；不适用布尔属性 null，不伪写 false。focus 深入 open shadow；after 与 before 独立重读 URL/title/focus/scroll。动作导航后旧 nodeAfter=null、incomplete 含 node-after-document-changed，after 则报告当前页；不要拿新页节点冒充旧身份。

ref 请求 provenance 来自其 entry 的 **minted snapshotId/digest**；表单多目标各自有 provenance，顶层用第一目标来源（无共同来源不捏造同一 snapshot）。selector/document 来源用最近成功 capture 的 snapshotId/digest（无则 null），source 必须是 selector/document，不伪称快照定位；snapshot 成功指本次 capture。unknown/dropped ref 的 provenance null，不冒用当前新快照。内部取证/node_state/wait poll 不发布新 snapshot、不分配新 ref。

snapshot 无 scope 时 targets=[]；有 scope 记录 scope 根；scroll 默认 document target。目标解析失败 resolved=null。networkDelta 用 Runtime 单调事件 seq，before 基线至 after 的新增/response/failed 等状态更新各递增 seq；不靠 Date.now 过滤，不声称因果归属。最多返回窗口最新 20 条，total 是窗口总事件数、dropped 包含缓冲覆盖和输出截断。沿用有界网络缓存，不建无界事件账本。不导出 header/body/cookie；未启动时全零空数组并标 incomplete。

### 5.2 大小、脱敏和错误证据

- action evidence JSON ≤262144 字节，targets ≤20；单个 NodeState text/name/value 最多 512/256/512 字节、title 512、URL 2048、network errorText 256。超限优先删减网络条目/截断文本，保留必填结构、identity、dispatch、provenance 和错误原因，truncated=true。快照业务体另受 §3 限制。
- 不把 text、value、selector 原文、fields 原数组写进 evidence/args/message/lastError/activity；requested.selector 只保留 kind。args 沿用现有结构摘要。错误只写字段名、fieldIndex、reason，不拼输入值。
- 所有可编辑控件值默认 `value:null,valueRedacted:true`；password、autocomplete=current-password/new-password/one-time-code 或 name/id 命中 password/token/secret/auth/api-key/session 的控件同时屏蔽 text/AX value。snapshot 不输出 input value。谓词/输入回读比较在内存用原值完成，不用截断值判断。
- 所有公开 URL 用现有 redactUrl；role/name/title/text/error 内 URL 调用 redactText 后限长。页面任意自由文本仍可能敏感，脱敏不是任意秘密检测器。不自动导出 HTML/attributes/截图/请求正文；backendNodeId 仅证据，不允许调用方直接传入定位。
- 成功完整 evidence 进入 result/render。失败完整 evidence 在 details；message 附不含输入的有界摘要（actionId、provenance、dispatch、incomplete、reason），register 再追加既有 envelope。不得承诺宿主 info.code 可达；ABORTED/断连后 after 可为 null，不能为补证据继续发命令阻塞取消。

### 5.3 能力报告

`browser_capabilities` 名称不变，description 必须从“Web T1”改为“Web T1/T2”，返回 16 工具事实。新增精确映射：

| id | tool |
| --- | --- |
| `web.t2.snapshot` | `browser_snapshot` |
| `web.t2.click` | `browser_click` |
| `web.t2.type` | `browser_type` |
| `web.t2.scroll` | `browser_scroll` |
| `web.t2.fill_form` | `browser_fill_form` |
| `web.t2.node_state` | `browser_node_state` |
| `web.t2.wait_for` | `browser_wait_for` |

`web.t2.structured-dom` 移出 unsupported，单独 available；有其他 owner 则七项/聚合项 unavailable、reason 含 BUSY。冷启动可 available，constraint 明示懒启动可能失败；running/transport 独立反映连接，不因检查能力生成 snapshot。T3/T4 与 viewport-control/browser-extras 仍 unsupported；诊断/独立 HTTP、lease 行为不变。不顺手重命名既有 T1 id。

`limits.structuredGui` 至少报告 protocolVersion=1、targetFrame=main、defaultMaxNodes=500/maxNodes=2000、defaultDepth=12/maxDepth=32、boxesDefault=false、treeBytes=131072/snapshotBytes=524288/evidenceBytes=262144、maxRefs=2000/refPolicy=monotonic-lru、formFields=20/textBytes=65536、scrollAmount=400、wait default/max/poll=5000/30000/100，以及 CSS unique/main frame、AX-backed shadow、DOM-control select/range、无 force/无视觉判定的限制。

## 6. 错误码与运行状态

所有下列码均 **抛 BrowserError**，含 code/category/retryable/details、[CODE] message 与证据，不使用 T1 legacy `{ok:false,error}` 路径：

| code | category / retryable | 语义 |
| --- | --- | --- |
| REF_STALE | action / false | ref unknown/LRU 淘汰、document/page 代次改变、节点 detach/替换或身份不符；必须重新观察 |
| TARGET_NOT_FOUND | action / false | 显式 selector 0 命中（wait 条件例外按 §4） |
| TARGET_NOT_UNIQUE | action / false | selector 多匹配，包含隐藏副本，不自动取首项 |
| NOT_INTERACTABLE | action / false | reason=hidden/disabled/readonly/inert/zero-area/outside-viewport/unstable/covered/not-editable/type-mismatch/focus-mismatch/value-mismatch/not-scrollable；hidden/covered details.escalation=T3 |
| WAIT_TIMEOUT | timeout / true | 条件截止；details 包含 elapsedMs/polls/condition、最后观察和 evidence；不关闭 page |
| INVALID_ARGUMENT | input / false | 参数/互斥/边界/CSS 语法/重复字段目标/错误谓词或值类型；纯参数预检不启动/零输入 |

[browser-safety.js](../browser-safety.js) TAXONOMY 必须补 REF_STALE/TARGET_NOT_UNIQUE/NOT_INTERACTABLE/WAIT_TIMEOUT，否则会退为 INTERNAL。BUSY/ABORTED/CDP_TIMEOUT/CDP_DISCONNECTED/UNSUPPORTED/INTERNAL、scope/resource/startup/navigation 错误保持原抛错分类，不能吞成 WAIT_TIMEOUT 或 REF_STALE。已进入队列的取消/断连/CDP_TIMEOUT 沿用关闭当前 page 后再放锁；其他 workspace 不关。WAIT_TIMEOUT 不能走此清理分支。retryable 不授权自动重放有副作用动作。

成功页面操作清空 lastError，实际操作失败带当前 action 归属；BUSY/纯参数预检不覆盖 owner 原错误。state/capabilities/独立 HTTP 不清错误，T2 读取也按 page operation 现有语义处理。不重构 T1/HTTP 错误兼容行为。

## 7. CDP 可实施性、非目标和升级

- 在 [index.js](../index.js) Runtime 集中实现 ref/documentEpoch/Target 解析、NodeState、actionability、evidence；注册入口复用 queue/ensure/send。Node crypto 做 digest，现有 Cdp 做传输；零依赖。
- `Accessibility.enable/getFullAXTree/getPartialAXTree` 提供语义，`DOM.describeNode/resolveNode` + `Runtime.callFunctionOn` 提供对象身份，rect/quads/viewport/hit-test 提供几何，`Input.dispatchMouseEvent/insertText/dispatchKeyEvent` 提供可信输入。节点操作用 objectId 和 CDP call arguments，不把 selector/text 拼接成 JS 源码。select/range/to-scroll 的 DOM 路径明确标 eventSource，不谎称可信输入。
- 主 renderer 的 AX-backed shadow ref 可直接 resolve backendNodeId，不依赖 CSS 穿透；open shadow 的 composed ancestor、深层 activeElement 和 hit-test 必须处理。closed shadow/缺失 backend 身份/命中只能证明 host 时不保证支持，拒绝并建议 T3，不落到相似节点。
- frame 首版严格主 frame。same-origin iframe 也只显示边界叶子，cross-origin iframe/OOPIF 不 attach/不遍历/不查内部 selector，不产生内部 ref；iframe 元素可查询状态，不支持将 click/type/form 送入其内部。未来跨帧须 renderer sessionId+frameId+documentEpoch 联合身份，backendNodeId 不是跨 renderer 全局 ID。
- canvas/WebGL/图像文字、无可证明节点的 shadow/frame、颜色/布局/可读性等视觉判断升级 T3；overlay/hit-test 失败先明确动作失败，需视觉判断命中区或原因时 T3。动画/拖拽/持续变化和时序判断升级 T4。escalation 只是提示。**本文 T2 轮快照中的“T3/T4 仍 unsupported”已被第 7 轮取代**：T3 六个视觉工具（[t3-vision.md](t3-vision.md)）已实现并验收，仍不自动把 T2 失败变成视觉 PASS；T4 仍 unsupported，报告 BLOCKED/INCONCLUSIVE 或交已有 screenshot 给授权视觉能力/人工，不能伪造已完成视觉判定。
- 不做 hover 专用工具、上传/下载、drag/drop、native select popup/文件选择器/权限窗口/JS dialog 管理、多标签/popup 接管、IME/composition、contenteditable 编辑器协议、触摸、截图 diff、独立证据文件包。native select/range 的结构赋值不能替代 popup/drag 测试；provider 图像可见性仍须专项验证。
- 性能：输出限额不限制 getFullAXTree 的原生工作量，boxes 默认关闭，避免给非引用节点逐个 resolve；读数有界、object group 及时 release；串行输入不并发。采集中 page/document 代次改变整份废弃，不拼两页数据。

## 8. 跨层文件变更清单（Owner scope）

本任务仅写本文；以下由对应 owner 同步。现有历史验收计数保持历史，不改写成新结果。

| Owner scope | 文件 | 预期修改 |
| --- | --- | --- |
| index.js / runtime | [index.js](../index.js) | 七工具/Runtime helpers、ref LRU/单调计数/epoch 清理、网络 seq、evidence/render、wait 工具超时余量；activity labels 为读取结构快照/点击元素/输入文本/滚动页面/填写表单/读取节点状态/等待节点条件，禁带输入原文；capabilities 16、web.t2.* 和 structured-dom available |
| runtime 分类 | [browser-safety.js](../browser-safety.js) | TAXONOMY 新增四码，保持原有错误语义 |
| tests 注册/主验收 | [tests/acceptance/harness.mjs](../tests/acceptance/harness.mjs)、[run.mjs](../tests/acceptance/run.mjs) | EXPECTED_TOOLS=16 与 §2 required；P1 名称/schema、P14 T2 可用、P16 全 16 envelope/render+T2 evidence；P21 全 16 真 lossless/schema、含错误 details；接入 T2 probe |
| tests 探针 | [tests/acceptance/milestone-probes.mjs](../tests/acceptance/milestone-probes.mjs)、[check-skill.mjs](../tests/acceptance/check-skill.mjs)、[check-skill-registry.mjs](../tests/acceptance/check-skill-registry.mjs) | capabilities/lease/evidence/cancel 覆盖七工具；Skill 自检改 16、tier=T1+T2、unsupported_tiers 精确 T3/T4，检查新增 T2 ledger；registry 如有固定 T1 数量/文案同步，不降低真实性断言 |
| tests fixture/probe | `tests/ui_test_fixture/web-t2.html`、`tests/ui_test_fixture/web-t2-second.html`；新增 `tests/acceptance/t2-structured.mjs` | 固定路由 /web-t2.html、/web-t2-second.html；fixture/window.__t2 事件真值与 §9 一致，独立编号验收结果；不使用考试答案 |
| skills manifest | [skills/ui-testing/manifests/declared-capabilities.json](../skills/ui-testing/manifests/declared-capabilities.json) | `tier:"T1+T2"`、unsupported_tiers=[T3,T4]；新增七 web.t2 operations、lease_checked_tools/错误/限额/Ref/evidence；无实测仅 implemented-not-verified，notice 不冒充运行态 |
| skills 入口/层级/台账 | [skills/ui-testing/SKILL.md](../skills/ui-testing/SKILL.md)、[t2-structured.md](../skills/ui-testing/references/tiers/t2-structured.md)；新增 `skills/ui-testing/knowledge/web/t2-capability-ledger.md` | 入口 16 工具和 snapshot→ref→动作→wait/state、纯字符串目标、全抛错、升级边界；T2 ledger 逐项状态与报告；**现有 [T1 ledger](../skills/ui-testing/knowledge/web/t1-capability-ledger.md) 保持不改**，它是 T1 历史/现行台账，T2 新事实由新 ledger 和入口说明优先 |
| skills 联动引用 | [capability.md](../skills/ui-testing/references/contracts/capability.md)、[operation.md](../skills/ui-testing/references/contracts/operation.md)、[evidence.md](../skills/ui-testing/references/contracts/evidence.md)、[web.md](../skills/ui-testing/references/platforms/web.md)、[selection.md](../skills/ui-testing/references/core/selection.md)、[fallback.md](../skills/ui-testing/references/core/fallback.md)、[workflow.md](../skills/ui-testing/references/core/workflow.md)、[selection-and-escalation.md](../skills/ui-testing/examples/selection-and-escalation.md) | 同步接口/选路/错误/证据，移除与新 T2 当前态冲突的泛称，T3/T4/其他平台保持未实现 |
| docs | [docs/index.md](index.md)、[status.md](status.md)、[capability-tiers.md](capability-tiers.md)、[architecture.md](architecture.md)、[runtime-t1.md](runtime-t1.md) | 索引登记本文；status 写实际实现/验证/加载构建/未测；tiers 当前态 T1+T2，保持门槛；architecture/runtime 16 工具和 Ref/evidence 主 frame 职责 |
| README | [README.md](../README.md)、[README_zh.md](../README_zh.md) | 同步当前实现范围/T2 状态、表格/完成门槛/架构节点；T2 参考策略表述为借鉴协议/CDP 自研零依赖；R2 只记录实际完成子范围，不把跨平台 Test core 整体勾完 |

## 9. 编号验收条件（38 项）

脚本对授权 loopback fixture `/web-t2.html` 与 `/web-t2-second.html` 执行，独立初始化页面/owner，不靠前一项残留。通过 `window.__t2` 与 DOM/请求日志核对事件和业务真值；需要 LRU、长文本、错误/运动的变体由测试 setup 注入确定性节点/状态，不修改考试靶机。全部条件可脚本判断；静态文档不能算执行证据。

1. **注册面**：apply 实际注册恰好 16 工具，新增 required 数组与 §2 一致；schema 经宿主验证，无依赖变化/原始 CDP 工具；click 空参数确实 INVALID_ARGUMENT。
2. **冷启动能力**：仅 state/capabilities 无 Chrome/profile；七 web.t2.* 与 structured-dom available、限额正确，T3/T4 unsupported，description 不再仅说 Web T1。
3. **工作区隔离**：两个 workspace 独立 page/ref/lease/network；A 中产生且 B 尚未分配的 ref 在 B 为 REF_STALE，未影响 A；A/B 各自 e1 只解析到各自本地节点，证据 scope/runtimeId 不串。Cookie 共享及短 ref 本身不携带 scope 的限制如实声明。
4. **语义快照**：fixture 标题、40-item list、table、两个 Save 按钮保留顺序/名字/状态；ref 只给可解析 Element，refs 与树完全对应，空 generic/text 压缩符合规则。 **冗余文本压缩正负例**：内容命名 owner（heading/button/link）的纯文本重复链只留一份；`#t2-live` 之类纯文本区保留一份实际 StaticText；aria-label 命名 owner 与其可见子文本不得互相吞；同名 sibling、不同 role 父子、分片文本的顺序/空格/标点不得丢；256/512 长度差与脱敏碰撞不得误判相等；压缩不改变 digest 定义（仍 sha256(最终 tree)），相同新算法页面重复捕获 tree/digest 相同，跨构建 digest 变化不算回归。
5. **稳定摘要**：连续静态捕获 snapshotId=sN/sN+1，原节点复用 ref，tree/digest 相同；脚本 sha256(tree).slice(0,16) 严格相等。
6. **快照限额**：默认 maxNodes/depth 等价显式值；maxNodes/depth/长文本/总字节各触发截断标记，完整 JSON/refs/nodeCount 受限；非法范围抛 INVALID_ARGUMENT。
7. **boxes**：false 不含 box/refs.bbox=null；true 与 getBoundingClientRect 误差 ≤0.02 CSS px，无聚焦/滚动副作用。
8. **scope**：scope.selector=#t2-scroll-box 与 scope.ref 仅输出其子树、根深度 0；空/多匹配清晰报错；scope 新快照不使其他仍保留 ref 失效。
9. **跨快照 ref 保留**：第二次 snapshot 后旧 #t2-inc ref 仍点击原节点、counter+1；新增节点获更大编号，从不将旧号发给新节点。
10. **LRU**：注入 >2000 可引用节点多 scope 捕获后，表≤2000、被淘汰 ref REF_STALE；重新发现分配更大 eN，不能复用淘汰号。
11. **导航失效**：到 /web-t2-second.html、reload、跨文档 history commit 各清 refs；pushState/hash 后 #t2-inc 原 ref 仍可验证使用；编号/快照计数不重置。
12. **节点身份**：移动 #t2-inc 原对象仍可点；替换成同 id/name 新对象后旧 ref REF_STALE、counter 不增，证据 backend 身份不误绑定。
13. **唯一 selector**：#t2-inc 可点，缺失 TARGET_NOT_FOUND；两个 Save 同名按钮对应 CSS 多匹配 TARGET_NOT_UNIQUE（加隐藏副本也计数）；非法 CSS INVALID_ARGUMENT。
14. **可信 click**：#t2-inc counter 精确+1、__t2 isTrusted/button/modifiers 正确；double click 两 click/一 dblclick；#t2-toggle 控制 #t2-panel 且 aria-expanded 读回。
15. **hidden/disabled**：#t2-hidden、#t2-disabled、#t2-disabled-btn（及注入 disabled fieldset/inert/零面积）拒绝输入，NOT_INTERACTABLE 与 reason 正确；hidden details.escalation=T3，node_state 仍可读取。
16. **覆盖/运动**：#t2-covered 被 #t2-overlay 全覆盖，NOT_INTERACTABLE+details.escalation=T3、零事件；pointer-events:none/持续运动变体拒绝，不能 force 或换目标。
17. **离屏点击**：对 #t2-page-end 附近可点击测试节点操作前后 scroll 真值变化，最终中心 hit-test 是该节点，使用现场 bbox。
18. **文本输入**：#t2-name/#t2-email/#t2-bio 验证 replace 默认替换、false 追加、空串清空、textarea 换行；实际 DOM/value 与 __t2 input 真值吻合，结果无原输入回显。
19. **编辑限制**：#t2-readonly 返回 NOT_INTERACTABLE；#t2-editable 明确 UNSUPPORTED；拦截焦点/beforeinput 的测试变体返回相应 reason 和真实 dispatch，不把旧值当成功。
20. **Enter**：#t2-name submit=false 无提交，true 的 Enter keyCode=13/isTrusted 与 #t2-output/提交计数符合 fixture；submitted 不冒称服务器成功。
21. **表单文本/布尔**：#t2-name/#t2-email/#t2-bio/#t2-agree/#t2-plan-basic/#t2-plan-pro 填入合法组合并验证 applied/顺序/最终值；#t2-checked 已满足时不额外点击。
22. **combobox/slider**：#t2-country 选择 cn、#t2-tags 多选 a/c、#t2-volume 从30到合法值（如70）读回准确，eventSource=dom-control；非法 option/值范围/step/单多选类型在预检拒绝。
23. **表单零派发预检**：后项参数非法、缺失、歧义、控件不符或同 backend 重复目标，前项无输入；错误 applied/failedIndex（适用时）正确。
24. **表单部分失败**：首字段 input 监听移除下一字段，抛 REF_STALE，details.applied/failedIndex 正确，首项副作用存在、后项未输入、无回滚。
25. **方向滚动**：文档四方向 delta 符号和实际 scroll 正确；#t2-scroll-box（200px viewport/1200px content）上下滚动目标真值一致；默认 amount=400；边界 moved=false 仍成功。 **离屏/不稳定负例**：目标当前在视口外时 `direction` 与 `to` 均零派发 `NOT_INTERACTABLE(outside-viewport)`、`dispatch.started=false/eventCount=0`、页面与元素 scroll 均不变、details 含固定 hint；持续运动目标 `unstable` 零派发；随后无目标滚动文档、重读节点状态、重试成功。
26. **to 滚动/校验**：#t2-scroll-box to=bottom/top 达实际端点、eventSource=dom-scroll；direction+to、to+amount、无方向/目标歧义拒绝，不默认猜方向。；离屏目标同 §9.25 的零派发与 hint 规则（`to` 也不绕过视口/命中预条件）。
27. **节点状态**：#t2-selected-tab selected=true、#t2-checked checked=true、#t2-toggle expanded/focus、#t2-aria-hidden AX/DOM 差异及 readonly/disabled 状态现场准确，不适用属性 null。
28. **wait 成功**：#t2-async→#t2-async-result/#t2-live 异步文字可 text/textGone 等待；目标 state visible/enabled/checked/valueEquals 单项/AND 按定义满足，polls/elapsedMs 真实，不产生新 snapshot/ref。
29. **wait 负例**：持续不满足抛 WAIT_TIMEOUT，details.elapsedMs/polls/condition 完整、retryable=true、page仍 running；timeout=0 只一次；混条件 INVALID_ARGUMENT，多匹配立即 TARGET_NOT_UNIQUE，ref 移除立即 REF_STALE。
30. **取消等待**：poll 中 abort 1s 内 ABORTED；进入队列后当前 page 关完才放锁，其他 workspace 仍可用；后续懒启动、旧 refs 失效，after 不伪造。
31. **取消部分输入**：首字段完成后取消，ABORTED details 真实保留 applied/dispatch，后项无输入，不宣称回滚或自动重放。
32. **lease**：A 持 lease 时 B 七工具均 BUSY、无输入/新 snapshot；B capabilities 七项 unavailable+BUSY，state/HTTP 仍可工作；disposed 仅释放对应 owner。
33. **成功证据**：七工具结果及 render 都有外层 scope/envelope、version=1、target role/name/bbox/identity、before/after URL/title/focus/scroll、nodes、minted snapshotId/digest、networkDelta/escalation/dispatch；空值与缺口如定义。
34. **失败证据/错误形状**：六规定码都抛 BrowserError，details.evidence 与 message 安全摘要存在；hidden/covered 有 details.escalation=T3；参数/BUSY 不启动页面/覆盖 owner 原错误。
35. **网络/脱敏/限额**：#t2-submit/#t2-async 相关已知请求状态 seq 增量不丢同时间戳更新，>20/缓冲覆盖报告 dropped；密码/输入/selector 哨兵不泄露，编辑 value=null，URL 脱敏，长证据不破界/缺字段。
36. **shadow/frame**：t2-widget open shadow 的 #shadow-btn 经 AX ref 可信点击并更新 #t2-shadow-result，深层 focus/hit 身份正确；CSS 不穿透，iframe 仅边界无内部 ref，未支持 frame/closed shadow 不落到其他节点。
37. **T1/宿主输出回归**：主验收 T1/HTTP/帧/安全、runtime-faults、workspace-isolation、Skill/registry 通过；P1/P14/P16/P21 按新契约扩展不删旧断言；16 工具值、render、T2 错误 details 经真实 lossless 校验，无 undefined/NaN/-0/类实例；面板视觉无改动。
38. **真实宿主/声明**：隔离 DSH 重新加载终版实际注册16，新 Agent 会话执行 snapshot→click/type/form→wait→node_state 并有 durable 证据；记录 loaded build/报告/未测。无法跑真实会话则 NOT_RUN，不能用 fake ctx 或本文代替；manifest tier=T1+T2、unsupported精确T3/T4，ledger 只凭对应实测升 verified。

## 10. 裁决、假设及风险交接

Lead 已定：字符串 ref/selector、单调不复用 Ref + 2000 LRU、全部 T2 失败抛 BrowserError、sN 捕获编号、七工具/五表单 type、scroll/wait 参数、manifest T1+T2、T1 ledger 不改。相同节点复用有效 ref 才能同时满足单调身份与重复快照 digest 稳定；entry 保留 minted provenance，后续捕获不改来源。

本轮保守边界为主 frame、AX-backed open shadow、普通 input/textarea；select/range 结构赋值与可信输入分别标事件来源，原生 popup/drag/contenteditable/IME 不承诺。wait 30000ms 条件预算需要宿主超时余量；错误分类需增加 [browser-safety.js](../browser-safety.js) 的四码。这两项是明确实施工作，不应以静默改码或缩短请求预算处理。

只读参考：[Playwright MCP 工具表](../reference/web-t2/playwright-mcp/README.md)、[ego-lite 紧凑快照/稳定身份规则](../reference/web-t2/ego-lite/docs/native-snapshot-ref-requirement.md)、[agent-browser core 流程](../reference/web-t2/agent-browser/skill-data/core/SKILL.md)。参考 clone gitignored，不是发布依赖或运行验证。若目标 Chromium 无法提供可证明的 shadow 身份/hit-test，带最小复现交回 Lead；不得静默放宽身份规则。本文无阻塞实施的待决事项，例行编码/调试/测试由执行者负责。
