# 架构

插件由 Host 半边、客户端面板、纯逻辑模块和内置 Skill 组成，全部以 DSH bundle 形式分发。

## 模块

```text
package.json           DSH bundle 清单（dsh.bundle.patch + dsh.client，platform: web）
cordis.patch.yml       注册插件：id = ui-testing-browser
index.js               Host：BrowserHost、RuntimeRegistry、租约与串行队列、scoped HTTP 路由、
                       36 个工具注册、共享 view、标注存储、网络采集、T4 会话、
                       固定 loopback 调试端口与 scoped `ui.devtools` 投影
browser-safety.js      错误类型与分类、CDP 封装、取消与定时器清理、URL 脱敏、目标/DNS 校验
capture-p0.js          PNG 结构/CRC/解码、像素统计、尺寸校验、映射投影、原子安全写入
network-p0.js          网络事件与会话、配额、分析、链路、规则、JSONL/HAR、订阅（零依赖）
vision-t3.js           PNG 编解码、裁剪/缩放/预处理/标注、YIQ 差异、识别、映射、产物存储
vision-baseline.js     受管基线：scope 根、不可变 revision、HEAD CAS、墓碑
dynamic-t4.js          T4 纯核心：帧存储、事件日志与时钟锚点、七类分析、六向关联、JPEG 解码
frame-source.js        最新帧缓存与统计（与传输、UI 解耦）
frame-push.js          同源 WebSocket 推帧：握手、合并推送、背压丢帧、鉴权
client.js              全部面板 UI（React，无 JSX）与传输层；DevTools 独立窗口
skills/ui-testing/     内置 Agent 操作手册
tests/                 验收套件与确定性靶机
```

`index.js` 只负责编排与 CDP；纯算法与状态机都在独立模块里，可脱离浏览器单测。

## 运行时模型

```text
DSH Agent / Agent Team
        │  工具调用
        ▼
   BrowserHost ── 一个无头 Chromium / 一个 profile
        │
        ├─ Runtime（每个 DSH 工作区一个 primary）
        │    ├─ 独立 page：URL、视口、历史、网络缓冲
        │    ├─ 权威 view 与 revision
        │    ├─ 串行队列 + single-owner lease
        │    └─ 帧、标注、动态会话、网络会话
        │
        ├─ 受控 popup child Runtime（同工作区，每个内部标签一个）
        │    └─ 独立 page/队列/lease/view/历史/标注/网络；不计入 Agent 默认目标
        │
        └─ 调试面板（primary 与内部标签页的视图）
```

- **隔离粒度**：页面、URL、视口、历史、网络缓冲、租约按 Runtime 隔离；同一 DSH 工作区的 primary 与 popup child 共享 profile，但各有独立页面状态。**Cookie 与存储由 profile 共享**，不是登录态隔离。
- **内部标签页**：真人触发的 `target=_blank` / `window.open` 会把原生 popup target 接管为同工作区的 child Runtime（不重新发请求），面板在地址栏下方增加标签；child 由 binding 路由，primary 保留原页。自动弹窗、无真人输入、非法目标与超容量仍阻断。每 Agent 会话独立 selectedTab：现有 `browser_*` 工具默认操作该会话选中的标签（无选择时 primary），`browser_tabs` 负责 list/current/select/open/close；GUI active 独立，GUI 切标签不会改变 Agent selection。
- **串行化**：所有会改动页面的操作走该 Runtime 的串行队列；只读诊断（`browser_state`、`browser_capabilities`、`browser_viewport get`、离线基线读取）不进队列、不占租约。
- **租约**：同一标签同一时刻只有一个 owner；不同标签可由不同 Agent 并行，同标签冲突返回 `BUSY`。
- **懒启动**：只有真正需要页面的动作才启动 Chromium；诊断类工具不启动。

### 面板 HTTP 路由

认证 scoped GUI 使用同一前缀 `/plugins/ui-testing` 的 HTTP 路由（legacy 客户端按既有闸处理）：

- 读：`GET /state`、`GET /frame`、`GET /metrics`；
- 页面操作（串行队列 + single-owner lease）：`POST /ensure`、`/navigate`、`/reload`、`/history`、`/viewport`、`/input`、`/eval`、`/screenshot`、`/tabs`、`/close`；
- 标注唯一写面：`POST /annotations`；
- 只读元素选取：`POST /element`（文档 CSS px → 命中元素；不 ensure、不进串行队列、不占租约、不写 `lastError`、不记录客户端指标；`GET /element` 固定 405）。语义与限制见 [选元素加入聊天框](element-picker.md)。

只读诊断（`/state`、`/metrics`、`/element` 与离线基线读取）不进页面队列、不占租约。

## 外部 DevTools

面板的「更多 → 打开调试工具」直接加载 Chrome 自带的 DevTools 前端，连接当前 Runtime 的 page target。它不经过插件工具、串行队列或 single-owner lease：按工作区选择 target 是**路由正确性**，不是 CDP 权限隔离。

- Host 为每次 Chromium 启动选择一个 loopback 端口，显式传 `--remote-debugging-port` 与精确的 `--remote-allow-origins=http://127.0.0.1:<port>`；不使用通配 Origin。
- 就绪判据是 IPv4 `/json/version` 与本次子进程 stderr 报出的 browser 端点身份一致；端口竞争、仅 IPv6 或身份不符会在预算内换端口重试。
- 认证 scoped GUI 的 `ui.devtools` 提供 `{available,url,pageGeneration,reason}`；`state()`、`browser_state`、工具值、metrics 与日志都不含该 URL。
- 仅支持 GUI 与 DSH 同机、经 loopback 访问；远程 GUI、非 Chromium 浏览器和旧版 Chrome 未承诺。

## 数据流

1. Agent 调用工具 → 参数预检（纯函数，不碰浏览器）。
2. 进入 Runtime 队列 → 获取租约 → 必要时 ensure 页面。
3. 执行 CDP 操作，收集证据（目标身份、前后状态、派发事实、网络增量）。
4. 结果经 lossless JSON 投影返回，图像以附件形式交付。
5. 失败抛类型化 `BrowserError`，证据放在 `details`。

## 证据与状态

- **共享 view**：面板与 Agent 读写同一对象，用 `expectedRevision` 做 CAS。
- **标注**：独立文档，按工作区存放，唯一写面是认证的 `POST /annotations`。
- **视觉产物**：按 scope 隔离、有配额、重启失效。
- **网络证据**：JSONL 保真、HAR 为 1.2 子集；只写持久根。
- **帧**：有界存储，带淘汰与空档计数。

## 安全

- 导航只允许授权目标：默认 loopback，私网需 `DSH_UI_TESTING_ALLOW_PRIVATE=1`；校验 DNS、重定向与弹窗。
- 页面访问限定在 DSH 工作区 scope 内，HTTP 路由需认证。
- 不读取调用方提供的任意路径；截图与证据文件写入受控根，权限 0600 且不覆盖。
- 截图与网络正文默认不脱敏。

## 扩展点

新增一个运行环境适配器时，需要提供：

1. 该环境的能力探测与三态报告（`available`/`unavailable`/`unsupported`）。
2. 与现有工具语义一致的实现，或明确声明不支持的能力。
3. 独立的验收套件与确定性靶机。

不要照搬 Web 的技术栈去假设其他平台的实现路径；也不要让适配器假装支持同样的操作。

## 相关文档

- [能力分层与限制](capability-tiers.md)
- [验证与贡献](verification.md)
- [工具参考](tools.md)
