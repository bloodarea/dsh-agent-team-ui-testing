# 示例 · 运行态读取、导航、JS 状态与计算样式

> 展示本插件 16 个工具（T1 9 + T2 7，本文只用 T1）中的调用形状；业务返回示例省略统一 action 元数据；输出为示意，**未在本仓库运行**，不构成验证证据。所有参数名以 `index.js` 注册的 schema 为准。

## 1. 先探测运行态

```json
browser_state {}
```

示意返回：

```json
{
  "mode": "idle",
  "activity": "空闲",
  "url": "",
  "title": "",
  "viewport": { "width": 1280, "height": 800 },
  "seq": 0,
  "running": false,
  "error": ""
}
```

`running:false` 只表示浏览器尚未懒启动/已关闭；不表示工具不支持。

## 2. 打开已授权的本地页面

```json
browser_navigate { "url": "http://127.0.0.1:3000/" }
```

示意返回：

```json
{ "ok": true, "url": "http://127.0.0.1:3000/" }
```

注意：检查 errorText/最终 URL 与目标策略不保证 load complete。不要立刻断言页面已就绪。注册表有 browser_capabilities 时先调用其诊断实际状态；它与 browser_state 都不启动浏览器、不占租约。

## 3. 读取页面 JS 状态

```json
browser_eval {
  "expression": "JSON.stringify({ href: location.href, ready: document.readyState, title: document.title })"
}
```

示意返回：

```json
{ "ok": true, "value": "{\"href\":\"http://127.0.0.1:3000/\",\"ready\":\"complete\",\"title\":\"测试页\"}", "type": "string" }
```

表达式必须返回可序列化值；DOM 节点、函数、循环引用无法作为 `value` 返回。

页面 JS 抛异常时：

```json
{ "ok": false, "error": { "code": "EVAL_ERROR", "category": "app", "retryable": false, "message": "Error: example\n    at <anonymous>:1:7", "details": {} } }
```

error 对象保留异常描述/栈与位置；工具执行失败则抛带 [CODE] 和 action 证据的 BrowserError。示意 message 不代表本轮实际异常。

## 4. 读取计算样式

```json
browser_computed_style {
  "selector": "#login",
  "properties": ["display", "color", "font-size"]
}
```

示意返回：

```json
{ "ok": true, "style": { "display": "block", "color": "rgb(255, 255, 255)", "font-size": "14px" } }
```

元素不存在时：

```json
{ "ok": false, "error": { "code": "TARGET_NOT_FOUND", "category": "action", "retryable": false, "message": "未找到元素：#login", "details": {} } }
```

限制：只取首个匹配元素；不支持伪元素、iframe 或 Shadow DOM 内部元素的直接定位；非法选择器按实际分类错误处理。样式值不等于视觉正确。

## 5. 记录限制

- `browser_state` 没有能力清单，不能据此推断“支持哪些操作”。
- 导航未等待加载；本示例的 `ready:"complete"` 只是页面当时返回的值。
- 计算样式只证明 computed style，不证明遮挡、溢出或像素观感。
