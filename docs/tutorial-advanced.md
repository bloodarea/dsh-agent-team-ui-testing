# 开发者进阶：从页面操作到可复核验证

本文承接[图文入门（tutorial.md）](tutorial.md)，解释 Agent 怎样定位控件、验证结果，以及何时使用网络、视觉和动态工具。日常使用可以直接用自然语言描述目标；需要排障或编写验证流程时再看下面的调用示例。

## 1. 手动启动演示页

在本插件仓库根目录运行：

```sh
node docs/examples/order-query/serve.mjs
```

也可以将[演示页（index.html）](examples/order-query/index.html)和[启动脚本（serve.mjs）](examples/order-query/serve.mjs)下载到同一目录，运行该目录下的脚本。脚本按自身位置读取页面，不依赖当前工作目录；使用 Node.js 即可，无需安装依赖。

默认请求端口 8199，被占用时自动选取其他空闲端口。以终端打印的 URL 为准，示例为 `http://127.0.0.1:8199/index.html`；追加参数 `0` 可直接让系统分配端口。脚本仅监听 `127.0.0.1`，按 Ctrl+C 停止。远程访问 DSH 时，浏览器和该服务需要运行在同一台宿主机器上。

练习页的预期行为：

| 输入与动作 | 页面结果 |
| --- | --- |
| 输入 `A-1001`，点击查询 | `订单 A-1001：已发货（演示数据）。` |
| 留空，点击查询 | `请先输入订单号。` |
| 输入 `A-9999`，点击查询 | `未找到订单 A-9999，请试试 A-1001。` |

查询逻辑在页面本地执行，不发送查询接口请求；它适合练习输入与结果校验。网络接口和动画需要使用带相应功能的目标页面。

## 2. 理解一次操作的工具流程

先核对能力与目标，再读取结构、执行输入、独立验证结果：

```text
browser_capabilities / browser_state / browser_tabs
  → browser_navigate（需要导航时）
  → browser_snapshot
  → browser_fill_form / browser_click
  → browser_wait_for / browser_snapshot / browser_eval
  → browser_screenshot
```

### 发现控件，再使用引用

在实际演示页地址上导航并取得快照。以下示例假设终端返回端口 8199：

```text
browser_navigate { "url": "http://127.0.0.1:8199/index.html" }
browser_snapshot {}
```

快照中会包含类似的条目：

```text
- textbox "订单号" [ref=e1]
- button "查询" [ref=e2]
```

`ref` 是当前页面节点的引用，编号以实际快照为准。下面只有在快照确实返回 `e1` 和 `e2` 时才可直接使用：

```text
browser_fill_form { "fields": [{ "ref": "e1", "type": "textbox", "value": "A-1001" }] }
browser_click { "ref": "e2" }
browser_wait_for { "text": "订单 A-1001：已发货（演示数据）。" }
browser_eval { "expression": "({ orderId: document.querySelector('#order-id').value, result: document.querySelector('#result').textContent })" }
browser_screenshot { "out": "output/capture/order-query.png" }
```

这里的 JS 只读取输入框和结果，输入与点击由可信事件执行。已知演示页的 DOM 结构后，可以用它核对实际值；在未知页面上先观察，再确定读取位置。截图输出不覆盖同名文件，重复练习时请换一个文件名。

### 执行完成与验证通过

- `dispatched:true` 说明输入已派发，`applied:1` 说明执行了一个字段；两者都不证明订单查询成功。应核对结果文字、输入值、目标 URL，并保存需要的证据。
- 主文档导航、刷新、节点替换等会使引用失效。收到 `REF_STALE` 时重新取得快照；同一文档中取得新快照不会自动废弃全部旧引用。
- `NOT_INTERACTABLE` 需要结合遮挡、禁用、运动或焦点等原因排查，保留失败证据。iframe 内部控件属于当前 T2 的支持边界，可能返回 `UNSUPPORTED`；不要把它当成主文档里的普通按钮。
- GUI 与 Agent 有各自的选页状态。先用 `browser_tabs` 核对目标；读工具还可能采用观察选页，不能仅凭地址栏判断工具正在读哪一页。

完整字段、目标限制和错误语义见[Chrome T2 契约（capability-tiers.md）](capability-tiers.md#web-chrome-t2)。

## 3. 按问题选择观察方法

| 目标 | 可以向 Agent 这样描述 | 工具与证据 |
| --- | --- | --- |
| 验证表单与结果 | “填入 A-1001，点查询，核对输入值和结果文字。” | T2 定位与输入，操作后读取结构或页面值 |
| 检查颜色、位置或布局差异 | “在相同视口下对比这两次画面，标出差异区域。” | T3 图像、比较与断言，核对来源、尺寸与几何映射 |
| 排查请求错误或重复请求 | “先开始采集，再触发一次提交，检查请求次数、响应与业务反馈。” | 网络会话 → 真实操作 → events/detail/trace，保留完整性与正文缺失信息 |
| 观察动画、闪烁或卡顿 | “在操作前开始采帧，分析变化过程，说明实测采样率和覆盖范围。” | T4 有界会话 → 帧查询 → 分析；单张终态截图不能证明过程平滑 |
| 留存一次操作 | “保存操作后的截图，并记录目标、输入、预期与实际结果。” | `browser_screenshot {out}` 与对应的结构、网络或动态证据 |

网络采集必须在被测请求发生前开始，动态采集必须覆盖被测过程。证据缺失、采样不足或目标不一致时保留限制；不能仅凭工具成功返回就给业务通过结论。方法与参数见[能力分层（capability-tiers.md）](capability-tiers.md)、[网络调试（network-p0.md）](network-p0.md)。

## 4. 元素引用、标注与截图

选元素得到的 `@` 引用用于描述具体界面对象；人工标注用于表达位置或区域。两者均需结合当前页面身份解析。

将元素或截图写入聊天框还要求面板绑定当前会话，推荐从该会话右侧边栏打开。主面板解析为 `recent` 时可能没有可写会话；遇到「当前面板未绑定会话」应从会话入口重新打开，详见[选元素前置条件（element-picker.md）](element-picker.md#前置)。

Agent 读取面板标注时，先核对所在标签页和标注文档，再用带标注截图观察：

```text
browser_tabs { "action": "list" }
browser_annotation { "action": "read" }
browser_screenshot { "includeAnnotations": true, "out": "output/capture/annotated-query.png" }
```

默认截图不包含标注；显式叠加时只包含 Host 已接受的图形，不含未提交草稿、工具栏或选中效果。Agent 写标注还要求人类正在前台查看该标签页。坐标、选择／框选快捷键与隔离规则见[视口、画布与标注（viewport-control.md）](viewport-control.md#标注)。

## 5. 开发排障与验证入口

| 问题 | 查阅位置 |
| --- | --- |
| 浏览器路径、有头模式、profile 或厂商身份 | [浏览器运行配置（browser-runtime.md）](browser-runtime.md) |
| 环境开关、执行端选择、诊断结果与配置冲突 | [环境设置（settings.md）](settings.md)、[诊断状态码（diagnose-reason-codes.md）](diagnose-reason-codes.md) |
| 客户端或 Host 代码改动未生效 | [改动如何生效（verification.md）](verification.md#改动如何生效) |
| 选择测试套件、判读未运行项和报告 | [验证与贡献（verification.md）](verification.md) |
| 理解模块或新增目标环境 | [架构（architecture.md）](architecture.md)、[适配器接口（adapters.md）](adapters.md) |

验证至少写清目标与前置条件、实际动作、预期结果、实际观察和证据位置。演示页通过只说明这条练习路径可用，不代表其他业务流程或平台也已通过。
