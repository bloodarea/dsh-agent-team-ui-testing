# 示例 · 点击、文本输入、状态观察与截图

> 展示本插件 8 个工具中的调用形状；业务返回示例省略统一 action 元数据；输出为示意，**未在本仓库运行**，不构成验证证据。坐标为页面 CSS 像素，相对当前视口。

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

示意业务返回（single-owner-lease 空闲 15s、进行中保持，面板仍共享页；owner/action 元数据省略）：

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

字段值仅为占位。可选附件服务保存并 render image block，attachmentId 使用实际引用；无服务 render base64-fallback 文本。不能把附件 ID 当文件路径，或把保存成功当 provider 实际可见；需真实会话另验。没有裁剪/像素差异/VLM，原始截图不代表 T3/T4 已实现。

## 5. 失败与停止

- 点击后状态未变：先确认坐标、焦点与事件对；不要无限重复点击；无法确认时报告 `INCONCLUSIVE`。
- 需要视觉判断：T3 未实现，报告 `BLOCKED`，不要用截图“看起来正常”代替证据。
- 动作可能有副作用且状态未知：先查状态，不得盲重放。
