# 示例 · HTTP 请求能力（未实现）与页面内 fetch 边界

> 本插件**没有独立 HTTP 客户端**（没有 Playwright `APIRequestContext`）。本示例说明遇到“验证接口”类需求时应如何正确降级与报告。输出为示意，未运行。

## 情形 A：需要独立 HTTP 请求/响应报文

断言例如：

- 需要拿到响应头、状态码、完整响应体；
- 需要独立于页面的 Cookie/鉴权上下文；
- 需要请求超时、重试或非浏览器网络的错误分类。

**正确行为**：报告 `BLOCKED`，说明“本插件未实现独立 HTTP 请求能力（`web.t1.http-request: unsupported`）”。不要：

- 虚构一个实际不存在的 HTTP 工具名；
- 用 `browser_network` 冒充响应报文（它只有 URL/方法/类型/时间戳/状态码，没有头与正文）；
- 用 `curl` / 面板 HTTP 路由绕过工具层。

## 情形 B：页面内请求结果可作为页面 JS 状态

如果验收条件允许“打开页面后，页面上下文发起请求并返回结果”，可以用 `browser_eval`：

```json
browser_navigate { "url": "http://127.0.0.1:3000/" }
```

```json
browser_eval {
  "expression": "fetch('/api/health').then(r => r.json()).then(v => JSON.stringify({ ok: true, v })).catch(e => JSON.stringify({ ok: false, error: String(e) }))"
}
```

示意返回：

```json
{ "ok": true, "value": "{\"ok\":true,\"v\":{\"status\":\"up\"}}", "type": "string" }
```

必须记录的限制：

- 这是**页面上下文 fetch**，受 CORS、页面 Cookie、页面 CSP 与当前导航状态影响；不是独立 HTTP 客户端。
- `browser_eval` 默认 `awaitPromise:true`，但仍有 30s CDP 超时；失败需要自己 `catch` 并返回结构化结果。
- 不能用它证明响应头、跨域策略或独立会话行为。
- 需要“接口契约/响应报文”证据时，仍应把该断言标为 `BLOCKED`，不要降级成页面 fetch 后判 PASS。

## 情形 C：观察页面自己的请求

```json
browser_network { "limit": 20 }
```

示意返回：

```json
{
  "entries": [
    { "url": "http://127.0.0.1:3000/api/health", "method": "GET", "type": "Fetch", "at": 123456.7, "status": 200 }
  ]
}
```

限制：响应与 loadingFailed 失败元数据，URL 尽力脱敏、记录有界；无请求头/响应头/正文，不能据此断言接口契约完整。network 不启动浏览器但受租约，其他 owner BUSY；所有返回还有 action 元数据，示例省略。
