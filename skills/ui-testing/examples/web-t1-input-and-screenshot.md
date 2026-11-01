# 示例 · 点击、文本输入、状态观察与截图

> 展示本插件 22 个工具（T1 9 + T2 7 + T3 6，本文只用 T1）中的调用形状；业务返回示例省略统一 action 元数据；输出为示意，**未在本仓库运行**，不构成验证证据。输入坐标为当前视口CSS px；截图region为文档CSS px，两者按采集前scroll转换。

## 1. 点击一个按钮

```json
browser_input {
  "events": [
    { "kind": "mouse", "type": "mousePressed", "x": 120, "y": 88, "button": "left", "clickCount": 1 },
    { "kind": "mouse", "type": "mouseReleased", "x": 120, "y": 88, "button": "left", "clickCount": 1 }
  ]
}
```

示意返回：

```json
{ "ok": true, "applied": 2 }
```

`applied` 只是事件数组长度，**不证明控件接收了事件或 click 已触发**。需要成对 press/release；只发一个通常不产生 click。

## 2. 输入文本

聚焦输入框后：

```json
browser_input {
  "events": [
    { "kind": "text", "text": "hello" }
  ]
}
```

`kind:"text"` 走 `Input.insertText`，不会触发页面的 `keydown` / `keyup` 监听。需要按键语义时使用 `kind:"key"`：

```json
browser_input {
  "events": [
    { "kind": "key", "type": "keyDown", "key": "Enter", "code": "Enter", "text": "\r" },
    { "kind": "key", "type": "keyUp", "key": "Enter", "code": "Enter" }
  ]
}
```

功能键（Tab/Enter/Escape）要带 `virtualKeyCode`，修饰键用 `modifiers`（字符串数组或 CDP 位掩码 Alt=1/Ctrl=2/Meta=4/Shift=8）：

```json
browser_input {
  "events": [
    { "kind": "key", "type": "keyDown", "key": "Tab", "code": "Tab", "virtualKeyCode": 9, "modifiers": ["shift"] },
    { "kind": "key", "type": "keyUp", "key": "Tab", "code": "Tab", "virtualKeyCode": 9, "modifiers": ["shift"] },
    { "kind": "key", "type": "keyDown", "key": "a", "code": "KeyA", "virtualKeyCode": 65, "text": "a", "modifiers": 2 }
  ]
}
```

然后必须读回页面真值（`document.activeElement.id`，或用 `browser_eval` 装的 keydown 记录器里的 `e.ctrlKey/e.keyCode`）。`applied` 只是事件数量；没读回就不要断言快捷键或焦点已经生效。非法修饰键名/类型会抛 `INVALID_ARGUMENT`，不会静默丢弃。

## 3. 观察操作后的状态

```json
browser_state {}
```

示意业务返回（按工作区 page 隔离 + 每工作区 single-owner-lease；同工作区面板与 Agent 共用 page，跨工作区 Cookie/存储共享；owner/action 元数据省略）：

```json
{ "mode": "agent", "activity": "派发输入事件", "url": "http://127.0.0.1:3000/", "running": true, "error": "" }
```

更具体的断言用 `browser_eval` 读取页面状态，例如：

```json
browser_eval { "expression": "document.querySelector('#result')?.textContent ?? null" }
```

## 4. 原始截图

```json
browser_screenshot {}
```

示意返回：

```json
{ "viewport": { "width": 1280, "height": 800 }, "bytes": 182340, "image": "<base64 PNG>", "capturedAt": 0, "sha256": "<actual SHA-256>", "attachmentId": null }
```

字段值仅为占位。可选附件服务保存并 render image block，attachmentId 使用实际引用；无服务 render base64-fallback 文本。不能把附件 ID 当文件路径，或把保存成功当 provider 实际可见；需真实会话另验。P0支持文档区域clip、连续scale和安全落盘，无像素差异/VLM，原始截图不代表T3/T4。当前暂存修订14/14、142/142报告见 [T1台账](../knowledge/web/t1-capability-ledger.md)；P0真实宿主重载/provider仍NOT_RUN。

需要局部高密度原图时，示意调用（不是运行记录）：

```json
browser_screenshot {
  "scale": 1.25,
  "region": { "x": 20, "y": 100, "width": 120, "height": 40 },
  "out": "output/capture/detail.png"
}
```

scale允许连续1–4；输出尺寸由round(css×scale)计算，最多16M像素。返回capture记录PNG实际尺寸/CRC/sizeCheck、纯JSON mapping、anomaly、file的pathKind/persistence/root/ephemeral及path/hash、delivery及warnings；不要根据示例编造这些字段值。persist:boolean默认false；本例提供out即持久（即使persist:false），也可persist:true使用持久默认名output/capture/<actionId>.png。无out/persist:true/非空env时默认插件实例暂存，绝对path、dispose清理，不写工作区；file含pathKind/persistence/root/ephemeral，持久路径相对env或cwd根，observed只persistence/relativePath|null。已有同名报OUTPUT_EXISTS，换名重试；legacy无cwd默认暂存，持久无根报root_unknown。DSF固定1；DPR未知null；headlessSource来自product/userAgent。原始base64/落盘同一字节，附件compare='attachment-metadata'缺字段不能推断相同；完整路径/legacy/env约束见 [安全边界](../references/core/safety.md)。均匀图只是警告，canvas内部位图不增加源细节，C13前后不变不排除瞬时布局影响。

## 5. 失败与停止

- 点击后状态未变：先确认坐标、焦点与事件对；不要无限重复点击；无法确认时报告 `INCONCLUSIVE`。
- 需要视觉判断：T3 未实现，报告 `BLOCKED`，不要用截图“看起来正常”代替证据。
- 动作可能有副作用且状态未知：先查状态，不得盲重放。
