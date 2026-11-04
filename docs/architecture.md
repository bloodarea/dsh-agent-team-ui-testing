# 架构

插件由 Host 半边、客户端面板、纯逻辑模块和内置 Skill 组成，全部以 DSH bundle 形式分发。

## 模块

```text
package.json           DSH bundle 清单（dsh.bundle.patch + dsh.client，platform: web）
cordis.patch.yml       注册插件：id = ui-testing-browser
index.js               Host：BrowserHost、RuntimeRegistry、租约与串行队列、scoped HTTP 路由、
                       35 个工具注册、共享 view、标注存储、网络采集、T4 会话
browser-safety.js      错误类型与分类、CDP 封装、取消与定时器清理、URL 脱敏、目标/DNS 校验
capture-p0.js          PNG 结构/CRC/解码、像素统计、尺寸校验、映射投影、原子安全写入
network-p0.js          网络事件与会话、配额、分析、链路、规则、JSONL/HAR、订阅（零依赖）
vision-t3.js           PNG 编解码、裁剪/缩放/预处理/标注、YIQ 差异、识别、映射、产物存储
vision-baseline.js     受管基线：scope 根、不可变 revision、HEAD CAS、墓碑
dynamic-t4.js          T4 纯核心：帧存储、事件日志与时钟锚点、七类分析、六向关联、JPEG 解码
frame-source.js        最新帧缓存与统计（与传输、UI 解耦）
frame-push.js          同源 WebSocket 推帧：握手、合并推送、背压丢帧、鉴权
client.js              全部面板 UI（React，无 JSX）与传输层
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
        ├─ Runtime（每个 DSH 工作区一个）
        │    ├─ 独立 page：URL、视口、历史、网络缓冲
        │    ├─ 权威 view 与 revision
        │    ├─ 串行队列 + single-owner lease
        │    └─ 帧、标注、动态会话、网络会话
        │
        └─ 调试面板（同一 Runtime 的另一个视图）
```

- **隔离粒度**：页面、URL、视口、历史、网络缓冲、租约按工作区隔离；**Cookie 与存储由 profile 共享**。
- **串行化**：所有会改动页面的操作走该 Runtime 的串行队列；只读诊断（`browser_state`、`browser_capabilities`、`browser_viewport get`、离线基线读取）不进队列、不占租约。
- **租约**：同一时刻只有一个 owner 可以操作页面；其他人拿到 `BUSY`。
- **懒启动**：只有真正需要页面的动作才启动 Chromium；诊断类工具不启动。

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
