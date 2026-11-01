# 示例 · 独立 HTTP 请求（`browser_http_request`）与页面内 fetch 的边界

> 本插件提供 Host 侧独立 HTTP(S) 客户端 `browser_http_request`（能力 ID `web.t1.http-request`，工程状态见台账）。示例为调用形状与判定口径，**输出为示意、未在本仓库运行**，不构成证据。

## 情形 A：验证接口契约（推荐）

断言例如：状态码、响应头、响应体、超时/错误分类，且与页面无关。

```json
browser_http_request { "url": "http://127.0.0.1:3000/api/health" }
```

示意返回（省略统一 action 证据字段）：

```json
{
  "ok": true,
  "method": "GET",
  "url": "http://127.0.0.1:3000/api/health",
  "status": 200,
  "statusText": "OK",
  "headers": { "content-type": ["application/json; charset=utf-8"] },
  "contentType": "application/json; charset=utf-8",
  "encoding": "utf8",
  "body": "{\"ok\":true,\"status\":\"healthy\"}",
  "bodyBytes": 26,
  "bodyTruncated": false,
  "redirects": [],
  "timings": { "headersMs": 3, "totalMs": 4 }
}
```

判定口径：

- `ok:true` 只表示**取得了响应**；404/500 也走成功返回，业务结论看 `status` 与 `body`。
- `headers` 是小写头名 → 非空 `string[]`；`bodyBytes` 是保留的原始实体字节，不受 `JSON.parse` 影响。
- `encoding` 为 `base64` 时（二进制/非文本/截断在多字节码点中间）不要当文本解析。
- 要断言接口“完整响应”，先确认 `bodyTruncated === false`；截断结果不能替代完整 JSON 断言。

## 情形 B：POST 与自定义头

```json
browser_http_request {
  "method": "POST",
  "url": "http://127.0.0.1:3000/api/echo",
  "headers": { "content-type": "application/json", "x-api-key": "demo-key" },
  "body": "{\"probe\":\"x\"}",
  "timeoutMs": 2000
}
```

限制：`body` 只接受 UTF-8 文本且 ≤64 KiB；不会自动补 `content-type`；`host`/`content-length`/`transfer-encoding`/`connection`/`cookie`/`accept-encoding` 等头被拒绝（整次调用零派发）。显式凭据头会到达目标，但参数放行不等于业务授权。

## 情形 C：重定向默认不跟随

默认 `followRedirects:false`、`maxRedirects:0`：`/redirect` 这类响应会以 `status:302` 正常返回，`redirects:[]`，不会自动请求下一跳。

```json
browser_http_request { "url": "http://127.0.0.1:3000/redirect", "followRedirects": true, "maxRedirects": 1 }
```

只有显式 `followRedirects:true` 且给出预算时才跟随；**每一跳**都用同一目标策略复验；HTTPS→HTTP 降级被拒绝；跨 origin 会清空调用方头。超过预算抛 `HTTP_REDIRECT_LIMIT`（network、不可重试），被阻断的跳零派发。

## 情形 D：页面内 fetch 仍属页面上下文

```json
browser_eval { "expression": "fetch('/api/health').then(r => r.json()).then(v => JSON.stringify({ ok: true, v })).catch(e => JSON.stringify({ ok: false, error: String(e) }))" }
```

这只能证明“该页面在该时刻用该 Cookie/CORS/CSP 上下文发起了请求”，不能替代 `browser_http_request` 的独立请求/响应报文（无响应头、受页面生命周期与跨域策略影响）。需要接口契约证据时用 `browser_http_request`，不要把页面 fetch 判为同一断言 PASS。

## 情形 E：只观察页面自己的请求

```json
browser_network { "limit": 20 }
```

`browser_network` 只有 URL/方法/类型/时间/状态等元数据（URL 脱敏），没有请求/响应头与正文，也不能拦截或 Mock；接口断言仍用 `browser_http_request`。

## 错误与排查

| 现象 | 含义 | 下一步 |
| --- | --- | --- |
| `HTTP_TIMEOUT` | 总截止时间（含 DNS/连接/重定向/头/正文）到期，当前请求已销毁 | 检查目标可达性/延迟；不要自动重放有副作用的请求 |
| `HTTP_FAILED` | 连接拒绝/重置、TLS、协议升级、响应头超限、正文异常中断 | 区分是网络问题还是服务端行为；旁证 `browser_network`/服务端日志 |
| `HTTP_REDIRECT_LIMIT` | 显式预算不足（含 `true,0`） | 明确提高 `maxRedirects` 或自行逐步请求 |
| `INVALID_ARGUMENT` | 参数/目标/重定向目标非法或被策略阻断，未派发 | 修正参数或目标；不要用其他工具绕过策略 |
| `NAV_FAILED` | DNS 解析失败（沿用页面分类） | 核对域名与网络环境 |
| `ABORTED` | 调用被取消，当前请求已销毁 | 不回滚副作用，重试前核对目标服务状态 |