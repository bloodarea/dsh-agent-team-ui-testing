# WEB-T1 独立 HTTP 请求契约与收口裁决

> 日期：2026-10-31。状态：实施与验收契约，**尚未运行验证**；本文不能证明运行实例已注册第九个工具。仅依据仓库静态阅读制定，不启动 Chromium、不启动或重启 DSH、不访问 3080。
>
> 基线：[M0–M2 契约](t1-m0-m2-contract.md)、[已知缺口](t1-known-gaps.md)、[问题分类 §3.2/§3.3](t1-issues-and-solutions.md#32-明确不属于-t1本轮不解决附依据)。本文补充独立 HTTP API 及本轮明确交付的四项裁决，其余现行契约保持。文档登记与相关文档同步由 Lead 完成。

## 1. 能力、实现边界与生效

新增 Agent 工具 `browser_http_request`，能力 ID 为 **`web.t1.http-request`**。它是 Host 侧独立 HTTP(S) 客户端，使用 Node 内置能力，不引入 Playwright、Puppeteer 或第三方依赖，不通过页面 `fetch`、CDP 或面板内部 HTTP 路由执行。本文的“HTTP 请求”指该工具访问目标 API；既有插件 `/navigate`、`/eval` 等面板路由的 HTTP 错误兼容格式是另一层接口。

关联实现入口：[index.js](../index.js) 的 `apply()`、`register()` 与 `browser_capabilities`；目标/脱敏/错误分类复用 [browser-safety.js](../browser-safety.js)；验收接入 [run.mjs](../tests/acceptance/run.mjs)、[host-contract.mjs](../tests/acceptance/host-contract.mjs)。执行者可按仓库结构提取小型 Host helper，但不得扩为通用浏览器重构。

本文件保存即为文档交付，不需要重启。未来 Host 实现、工具/skill 注册变更需在获得授权的隔离 DSH 实例重启加载后验证；本文不授权启动实例或操作用户主实例。

## 2. 精确参数 schema

工具输入为普通 JSON object，拒绝未知顶层字段（`additionalProperties:false`），只有 `url` 必填。缺省仅指字段不存在；`null`、错误类型、空字符串等不得按缺省处理。拒绝强制 `String()`/`Number()` 转型、自动 clamp、自动扩大资源预算。下述约束须同时落入注册 schema 和执行时校验，执行时校验不可依赖 fake harness 或宿主已校验。

> **注册 schema 的宿主硬限制（Lead 复核 `@deepseek-ai/dsh-tools` `assertSupportedJsonSchema` 后裁决）**：真实宿主只接受 `type`/`oneOf`/`properties`/`required`/`additionalProperties`(boolean)/`items`/`enum`/`const` 加注解 `description`/`title`/`default`/`examples`，其余关键字（`minLength`、`maxLength`、`pattern`、`minimum`、`maximum`、`maxProperties`、`propertyNames`、`uniqueItems`、`format`、`additionalProperties` 为 schema 等）会让**注册直接失败**。因此注册 schema 只表达结构与 enum/默认值，所有长度/范围/模式/重名/头语义在执行时校验；P22 第 21 条另行断言注册 schema 能过宿主校验器与 `assertSupportedJsonSchema`。

```json
{
  "type": "object",
  "additionalProperties": false,
  "required": ["url"],
  "properties": {
    "method": {
      "type": "string",
      "enum": ["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
      "default": "GET",
      "description": "HTTP 方法，大小写严格匹配；默认 GET"
    },
    "url": { "type": "string", "description": "绝对 HTTP(S) URL；不 trim；UTF-8 ≤ 8192 字节（执行时校验）" },
    "headers": { "type": "object", "description": "调用方请求头：单值字符串；≤64 条、键 ≤128 字符、单值 ≤4096 字节、合计 ≤8192 字节、重名与危险头在执行时校验" },
    "body": { "type": "string", "description": "UTF-8 请求体，≤65536 字节（执行时校验）；GET/HEAD 提供即拒绝；不自动设置 content-type" },
    "timeoutMs": { "type": "integer", "default": 5000, "description": "总截止时间毫秒；范围 1–20000（执行时校验）" },
    "maxBytes": { "type": "integer", "default": 65536, "description": "响应保留字节上限；范围 1–1048576（执行时校验）" },
    "followRedirects": { "type": "boolean", "default": false, "description": "是否手动跟随重定向；默认不跟随" },
    "maxRedirects": { "type": "integer", "default": 0, "description": "最多再派发跳数；范围 0–5（执行时校验）；followRedirects=false 时不生效" }
  }
}
```

执行时的附加约束：

| 字段 | 精确行为 |
| --- | --- |
| `method` | 大小写严格匹配 enum；`get`、空白包裹、`CONNECT`、`TRACE` 均 `INVALID_ARGUMENT`。不自动重试任何方法。 |
| `url` | 不 trim；拒绝前后空白及控制字符；UTF-8 字节数也不得超过 8192。必须是 `validateTarget()` 接受的绝对 HTTP(S) URL；不得包含 userinfo。URL fragment 从实际请求地址去掉，证据中的逻辑 URL 仍按 `redactUrl()` 脱敏。 |
| `headers` | 仅自有可枚举的字符串键/字符串值，不接受数组、Headers 类实例、嵌套值；大小写归一后重名（如 `X-A`/`x-a`）拒绝。每值 UTF-8 最多 4096 bytes；请求头合计 `Σ(Buffer.byteLength(name)+Buffer.byteLength(value)+4)` 最多 8192 bytes，另受 64 条/键名 128 字符上限约束。值拒绝 CR/LF、NUL、DEL 及除 HTAB 外的 C0 控制字符；非 Node HTTP 可编码头值也拒绝，不能等到派发后报内部错误。危险头见 §4。 |
| `body` | 仅 UTF-8 文本，`Buffer.byteLength(body,'utf8') <= 65536`；不接受 JSON object、base64 请求体、文件或流。调用方自行 `JSON.stringify()` 并显式设置 `content-type`。不存在表示无 body，空字符串表示 0 bytes；`GET`/`HEAD` 只要提供 `body` 字段（包括空串）就拒绝。其余方法允许 body；不自动推断 Content-Type。 |
| `timeoutMs` | 从同步参数校验通过后、首次 DNS/目标校验前开始的**总截止时间**，覆盖 DNS、连接/TLS、每跳重定向、响应头和正文读取。每跳共用剩余预算，不重置，不等同于 socket idle timeout。最大 20s 留在现有 30s 工具外层时限内。 |
| `maxBytes` | 最终响应实体的**保留字节上限**；默认 64 KiB、最大 1 MiB。第 `maxBytes+1` 个响应字节证明截断后，停止读取并销毁当前响应/请求，不完整下载后再 slice。内存只保留最多 `maxBytes`，不得把超大 chunk 全量累积。 |
| `followRedirects` / `maxRedirects` | 默认不跟随且预算 0；显式 `true` 也不自动提高预算，调用方要显式给正预算。`false` 时 `maxRedirects` 可为合法的 0–5，但完全不生效，不将 Location 作为下一跳校验或跟随；Location 仍按响应头脱敏规则投影。`true,0` 遇首个可跟随响应立即超限。 |

所有非法参数在 DNS、连接、Chromium 启动、租约申请之前抛 `INVALID_ARGUMENT/input/false`；相同校验覆盖直接调用工具 execute 的路径。`NaN`、Infinity、`-0`（数字参数）、小数和字符串数字均拒绝。资源计数用整数，无负零。

## 3. 返回体与字节语义

成功取得可用 HTTP 响应时返回下列业务字段，并附现有 action 证据字段。**`ok:true` 表示请求取得响应，不表示 HTTP 2xx**；404、500 正常返回，调用方按 `status` 判定接口业务结果。超时、取消或正文异常中断抛错误，不将残缺正文冒充普通成功；有意达到 `maxBytes` 截断是明确标记的正常响应。

```json
{
  "ok": true,
  "method": "GET",
  "url": "http://127.0.0.1:12345/health",
  "status": 200,
  "statusText": "OK",
  "headers": {
    "content-type": ["application/json; charset=utf-8"],
    "set-cookie": ["***"]
  },
  "contentType": "application/json; charset=utf-8",
  "encoding": "utf8",
  "body": "{\"ok\":true}",
  "bodyBytes": 11,
  "bodyTruncated": false,
  "redirects": [],
  "timings": { "headersMs": 2, "totalMs": 3 },
  "actionId": "uuid",
  "sessionId": "session-or-anonymous",
  "startedAt": 1793449685000,
  "finishedAt": 1793449685003,
  "target": "http://127.0.0.1:12345/health",
  "args": { "url": "http://127.0.0.1:12345/health" }
}
```

以上 body/字节数示例仅用于说明字段，不作为 fixture 的完整响应预期。精确返回约束如下：

| 字段 | 类型与约束 |
| --- | --- |
| `ok` | 恒为 `true`；传输失败抛 BrowserError，见 §6。 |
| `method` | 最终请求使用的方法（可能由重定向规则改变）。 |
| `url` | 最终响应所在逻辑目标的规范化、`redactUrl()` 后字符串；不返回未脱敏 URL。 |
| `status` / `statusText` | 最终 HTTP 状态整数（100–599；1xx 中间响应不是最终结果）和原始 reason phrase 字符串，缺失 phrase 为 `""`。101/协议升级不受支持，抛 `HTTP_FAILED`。 |
| `headers` | 普通 JSON record，小写头名 → **非空 string[]**，按线上出现次序保留重复值，不用逗号折叠 Set-Cookie 等头。空响应头用 `{}`。敏感值和 URL 值按 §4 处理。用安全字典构造，任意远端头名不能污染对象原型。 |
| `contentType` | 最终 Content-Type 的第一个值（脱敏后），不存在为 `null`。不自动解析 JSON body。 |
| `encoding` | `"utf8"` 或 `"base64"`，描述 `body` 表达方式，不是 Content-Encoding。 |
| `body` | 恒为 string；无正文为 `""`。仅对未内容压缩、声明为 `text/*`、`application/json`、`application/*+json`、`application/xml`、`application/*+xml`、`application/javascript` 或 `application/x-www-form-urlencoded`，且 charset 缺失或为 utf-8/utf8/us-ascii，且保留字节可严格 UTF-8 解码时返回 utf8；其余返回 base64。截断落在 UTF-8 多字节中间时也返回 base64，不能用替换字符悄悄损坏保留字节。空正文统一 `encoding:"utf8"`。 |
| `bodyBytes` | 实际保留原始实体字节数，整数 `0..maxBytes`；base64 是解码后的数量，不能拿 JS 字符数代替。不是远端总长度，不依赖 Content-Length 推断完整性。 |
| `bodyTruncated` | boolean；仅当实际读到超出上限的字节时为 true。恰好上限且正常结束为 false；HEAD/204/304 正文为空且 false。 |
| `redirects` | 已处理的可跟随重定向列表，每项严格为 `{status:number,method:string,url:string,to:string}`。method/url 为产生该重定向的请求；to 为解析后的绝对逻辑目标；两 URL 均脱敏。`followRedirects:false` 恒为空列表。成功时每项均已经复验并实际跟随，不包含失败跳。 |
| `timings` | `{headersMs:number,totalMs:number}`：从总截止时间起点到最终响应头、到完成或有意截断的毫秒数，四舍五入到非负安全整数；`0 <= headersMs <= totalMs`。不伪造 DNS/TLS/TTFB 分项；使用单调时钟计时。 |
| 证据 | 必须有 `actionId/sessionId/startedAt/finishedAt/target/args` 并进入 render 文本。startedAt/finishedAt 为 epoch ms；target 为**初始 HTTP 目标脱敏值**，成功和错误均不得被所属工作区 page URL 覆盖。args 只记录 URL、方法、预算及 header/body 的计数/长度摘要，不存正文、头值、凭据。 |

传输按原始实体字节读取，不自动解压；可自动生成 `Accept-Encoding: identity`，拒绝调用方覆盖该头以保持确定性。若服务器仍返回 gzip/br 等 Content-Encoding，返回原始压缩实体 base64，`bodyBytes` 计压缩实体字节，不能声称正文已解压。每跳响应头解析硬上限 **16384 bytes**，超限为 `HTTP_FAILED`，不保留无限头数据；跳过的重定向正文直接取消/销毁，不消耗最终 body 配额也不后台继续下载。

返回值、render 内容、抛错 details 必须经过既有唯一 `losslessJson()` 边界；源头即只构造 JSON 标量、密集数组、普通对象，不返回 Buffer/Response/Headers/Error/URL/AbortSignal 类实例、BigInt、undefined、NaN、Infinity 或负零。固定字段缺失值显式为 `null`、`""`、`[]`、`{}`，不以 undefined 占位。P21/P22 还须调用真实宿主 `snapshotJsonValue()`；JSON.stringify 成功不能替代该校验。

## 4. 目标策略、头与脱敏

### 4.1 每次派发前校验目标

初始目标和**每一跳**重定向均调用同一个 `validateTarget(raw,{origins:[...runtime.origins],signal})`，保留既有 scheme/DNS/地址分类和环境开关，不另写弱化的 URL 检查。默认允许公网与 loopback；RFC1918/IPv6 ULA 默认阻断，仅 `DSH_UI_TESTING_ALLOW_PRIVATE=1` 放行；metadata/link-local、unspecified、multicast、userinfo 和已知 DSH 自身 origin 始终阻断。DNS 全部结果中任一受阻则拒绝。工具参数不得添加 allowPrivate、忽略 TLS、proxy、绕过策略或自定义 DNS 开关。

复用现有 `runtime.origins` 与 `DSH_WEB_URL`，即使 Chromium 未启动也适用；不能为了获取宿主 origin 懒启动 Chromium。未配置 `DSH_WEB_URL` 且尚未收集 origin 时，识别所有宿主 origin 的能力仍有限，必须在 limits 明示，不声称“任何宿主别名都已防住”。使用 Node 默认 TLS 证书验证，不降低证书验证。完整网络沙箱、DNS pinning/rebinding 防护、代理策略不在本轮。

自动重定向必须关闭，以 301/302/303/307/308 + 非空 Location 手动处理；其他 3xx 或无 Location 当普通响应。`followRedirects:true` 下，先解析 `new URL(location,currentUrl)`，再复验；禁止任何未复验的目标派发。非法/阻断 Location 抛 `INVALID_ARGUMENT`；DNS 解析失败保留 `NAV_FAILED`；超过预算抛 `HTTP_REDIRECT_LIMIT`。先校验目标再检查剩余跳数，二者都在派发前完成；已访问同一 URL 也不得跳过复验。HTTPS→HTTP 降级重定向拒绝 `INVALID_ARGUMENT`，不静默降级。

重定向方法规则：303 除 HEAD 外转 GET；301/302 仅 POST 转 GET；307/308 保留方法/body；转 GET 时移除 body 与调用方 `content-type`。`maxRedirects=N` 表示最多再派发 N 次，总请求数最多 N+1；循环由预算终止，不自动重试。被阻断跳的接收端请求数必须是 0，初始允许跳已发生不能回滚。

### 4.2 请求头与凭据

大小写不敏感拒绝以下调用方头，整次调用零派发：`host`、`content-length`、`transfer-encoding`、`connection`、`proxy-connection`、`keep-alive`、`te`、`trailer`、`upgrade`、`expect`、`cookie`、`cookie2`、`proxy-authorization`、`proxy-authenticate`、`accept-encoding`，以及 `proxy-*`、`sec-*` 前缀。冒号开头等 HTTP/2 伪头因头名语法同样拒绝。客户端所需 Host、Content-Length 等由 Node 根据已校验目标与实际 body 自行生成，绝不复用 Agent 自填值。

无 cookie jar：不读写 Chromium Cookie、localStorage、页面会话、DSH 登录态、系统凭据或 netrc，不持久化/重放 Set-Cookie，不在两次工具调用间携带任何凭据。调用方可以显式提供 `authorization`、`x-api-key` 等 API 凭据头（受总量约束）；参数能通过不等于获得目标业务授权。禁止 Cookie 头是本轮保守接口选择，不承诺 Cookie 登录流程。

同 origin 重定向保留已校验的调用方头；跨 origin（scheme/host/port 任一改变）清空**全部调用方头**，后续不能恢复，避免未知业务凭据头随重定向外泄。仅重新生成客户端协议所需头及 identity 编码；307/308 可以保留显式 body，故带敏感 body 的请求即使头已移除，跨 origin 跟随仍须调用方自行确认目标业务授权。不能宣称“重定向不会泄漏正文”。

### 4.3 输出与日志

所有 URL（顶层 url、redirects、target、args、errors、Location/Content-Location 等 URL 响应头）过 `redactUrl()`；相对 URL 先相对当前响应目标解析再脱敏。message 继续过 `redactText()`；不得把底层异常对象或原始 request options 直接序列化。

响应头大小写不敏感，`set-cookie`、`set-cookie2`、`cookie`、`cookie2`、`authorization`、`proxy-authorization`、`www-authenticate`、`proxy-authenticate`、`authentication-info`、`proxy-authentication-info`、`x-api-key`，以及头名匹配现有 URL 敏感键规则（token、key、secret、密码、auth、code、session 等，不区分大小写）的值统一投影为 `["***"]`（不保留重复条数和原值长度）。URL 响应头做 URL 脱敏而非原样返回。保留其余头时拒绝控制字符进入日志；头字段仍是非可信远端数据。

正文由调用者显式请求并在字节上限内返回，不做业务 JSON 键扫描，也不在 logger/activity/args/error message 再复制正文；正常 result/render 可能包含敏感正文、URL 路径和未知业务头，不能宣称全量脱敏。URL 查询/fragment 脱敏无法隐藏正文里同一 token。验收用合成 token，只检查指定输出面，不能用含 token 的 echo 正文来判定 URL 脱敏失效。

## 5. 生命周期、并发与取消

`register()` 要区分独立 HTTP 与页面执行；不能仅把新工具加进 diagnostic 名单后继续进入 `runtime.run()`，因为那仍会排在页面队列之后。HTTP 分支直接调用独立请求 helper，同时复用 action metadata、错误包装、`losslessJson()` 和 render；**不调用 `ensure/run/claim/touchAgent/refreshTitle`**，不创建 profile/CDP/帧，不读写页面 URL/title/network 缓冲/owner/activity，不设置或清除页面 lastError。

- 未启动、已关闭、正在关闭或 CDP 断连的浏览器都不妨碍 HTTP 调用；没有 Chromium 可执行文件也能请求。`browser_capabilities.runtime.running` 仍真实为 false，而 HTTP 为 available。
- 其他 session 正持租约或正在执行/排队页面操作时 HTTP 仍立即开始，不返回 BUSY、不续租、不夺 owner、不等待页面队列。不同 HTTP 调用相互独立，不建立全局 HTTP 串行队列；单次预算不等于全宿主流量预算。
- 合并每次调用的 `exec.signal`、总超时和插件生命周期取消。预先 aborted 零派发；进行中 abort 立即销毁当前 request/response，停止后续跳，移除 timer/listener，以 `ABORTED` 结束；若仅用 Promise.race 但底层请求继续跑，不符合契约。
- 取消/超时**不能关闭 Chromium**，不能修改租约或取消其他调用；不能自动重试。取消前服务器可能已接收或执行 body，不回滚副作用。成功收尾前再次检查取消信号；以先观察到的终止原因结算且只结算一次。
- DNS 底层 lookup 可能不能物理取消，但外层立即停止等待，迟到解析结果必须丢弃，不能继续派发；timer/listener 必须清理。
- 面板 `/close` 只关页面，不取消独立 HTTP；插件卸载/销毁应取消该实例仍在进行的 HTTP（ABORTED）并回收句柄，不能留下后台请求。没有 exec/agent 时仍用 anonymous 证据 scope，不承诺匿名隔离。

## 6. 错误码裁决

**新增 `HTTP_TIMEOUT`、`HTTP_FAILED`、`HTTP_REDIRECT_LIMIT` 三个 code**，在既有 BrowserError taxonomy 增加映射。HTTP 超时不是 CDP 超时，不能复用 `CDP_TIMEOUT` 以免触发关浏览器路径；网络/TLS/正文失败不是导航，使用 HTTP_FAILED。重定向超限需要与可重试传输问题区分，单独设不可重试 code。保留 `validateTarget()` 原有 DNS `NAV_FAILED/navigation/true` 是有意兼容，不因新增工具修改导航的错误表。

下表为本工具可能返回的完整错误集，其他页面 code 不复用到 HTTP：

| code | category | retryable | 触发条件 |
| --- | --- | --- | --- |
| `INVALID_ARGUMENT` | `input` | false | schema/字节预算/头/方法/body 非法；URL 或重定向目标 scheme、凭据、地址或自身 origin 受阻；非法 Location；HTTPS 降级。 |
| `NAV_FAILED` | `navigation` | true | `validateTarget()` 的 DNS 解析失败，沿用原分类；details 补 `operation:"http-request"`、`phase:"target-validation"`。 |
| `HTTP_TIMEOUT`（新增） | `timeout` | true | 总截止时间到期，涵盖 DNS/连接/重定向/头/body；主动销毁当前请求。 |
| `HTTP_FAILED`（新增） | `network` | true | 连接拒绝/重置、TLS 错误、协议/升级不支持、响应头超限、正文在正常结束前断开等传输错误。HTTP 404/500 不属于此项。 |
| `HTTP_REDIRECT_LIMIT`（新增） | `network` | false | followRedirects=true 且下一个可跟随响应会超过显式 maxRedirects（含 0）；不得派发超预算跳。 |
| `ABORTED` | `cancelled` | true | exec.signal 或插件生命周期取消；预先取消时零派发。 |
| `INTERNAL` | `internal` | false | 上述以外实现异常；不能吞掉原分类、伪装 HTTP 500 或返回含裸 Error 的值。 |

工具失败继续**抛 BrowserError**，message 含 `[CODE]` 与 action 证据摘要，details 为普通 JSON，至少带 `operation:"http-request"`、脱敏 `url`、`phase`（`validation|target-validation|request|headers|body|redirect` 之一）、已完成 `redirects` 和 action 证据。不保证底层失败有 HTTP 状态；没有就用 `status:null`，不得编造 `status:0`/500。错误 details 不附响应正文/头值。已有面板路由 `{ok:false,error:"字符串",code,category,retryable}` 兼容形状保持；新增 Agent 工具不是新增面板路由，不照搬此 envelope。

原表所有旧 code/category/retryable 不变；上述三个 code 是增量，不替换 NAV_FAILED/CDP_TIMEOUT 等。`BUSY`、`TARGET_NOT_FOUND`、`EVAL_ERROR`、`CDP_DISCONNECTED`、`UNSUPPORTED` 不应由一个已注册、输入合法的独立 HTTP 工具产生。retryable 只是诊断提示，**不授权自动重放 POST/PUT/PATCH/DELETE**。§3.3 的宿主 `info.code` 平台限制仍在，只保证 `[CODE]` 和 BrowserError 字段，不能引入私有 HarnessError 依赖。

## 7. browser_capabilities 的九项投影

T1 工具投影由 8 项增为 **9 项**，依次保留既有八项（navigate/eval/screenshot/input/network/computed_style/state/capabilities），追加：

```json
{
  "id": "web.t1.http-request",
  "tool": "browser_http_request",
  "status": "available",
  "constraints": [
    "Host HTTP(S) client; no Chromium startup, page queue or owner lease",
    "No cookie jar or page credentials; caller headers are explicit",
    "Target URLs and DNS checked before every dispatch; redirects are manual and opt-in",
    "Response bytes are bounded; body may be truncated; no automatic decompression"
  ]
}
```

HTTP 不因其他 owner、`running:false` 或 Chrome 未找到而变为 unavailable。原五个页面工具与 network 在其他 owner 持有时仍 unavailable/BUSY；state/capabilities 仍 available。原八项 ID 不重命名；HTTP 使用连字符 ID，工具用下划线，不误产生第二个 `web.t1.http_request`。从 unsupported 列表移除 `web.t1.http-request`；T2/T3/T4、viewport-control/browser-extras 继续 unsupported（已有缺失投影可补齐，不注册对应工具）。页面条目的懒启动约束不可误套在 HTTP 或诊断条目上。

在保留既有 limits 的同时，新增确定的 `limits.httpRequest`：

```json
{
  "defaultTimeoutMs": 5000,
  "maxTimeoutMs": 20000,
  "defaultMaxBytes": 65536,
  "maxBytes": 1048576,
  "maxRequestBodyBytes": 65536,
  "maxRequestHeaderBytes": 8192,
  "maxResponseHeaderBytes": 16384,
  "followRedirects": false,
  "defaultMaxRedirects": 0,
  "maxRedirects": 5,
  "cookies": "none; no cookie jar or page credentials",
  "isolation": "independent requests; no shared page lease or queue",
  "targetPolicy": "HTTP(S), URL and DNS validation per dispatch; loopback allowed; private ranges require DSH_UI_TESTING_ALLOW_PRIVATE=1; known DSH origins blocked",
  "security": "Not a complete network sandbox; DNS rebinding remains possible; unknown host origins and response content may contain secrets"
}
```

约束文案必须包含上述事实；数字字段须与执行默认/上限共用同一事实来源。capabilities 只声明实现能力，不自动代表 P22 通过，不声明 provider 看图、完整隔离或完整沙箱。

## 8. P22 可执行验收断言

执行者新增 `P22-http-request`，通过**注册后的真实工具包装器**调用；沿用 [fixture](../tests/ui_test_fixture/README.md) 的确定性接口，以随机回环端口运行。新增安全/二进制/循环重定向场景可在探针内建临时 `node:http` 回环服务器，不把固定 `/redirect` 改成自由 to/open redirect，不依赖外网。P22 无需 Chromium；P20 与生命周期回归另在授权的验收环境运行。每条保留输入、实际结果、action 证据、服务器计数/进程快照和 PASS/FAIL，不能仅检查字段存在。

1. **注册与默认**：注册表恰有 9 个工具；调用仅 `{url:fixture+'/health'}`，服务端确认 GET、无 Cookie/Authorization；结果 status=200、ok=true，JSON.parse(body) 严格等于 `{"ok":true,"status":"healthy","fixture":"dsh-ui-testing"}`，encoding=utf8、bodyBytes 等于真实 Buffer 字节数、无截断、redirects=[]，默认预算与 §2 一致。
2. **POST echo**：`method:'POST',headers:{'content-type':'application/json'},body:'{"probe":"P22"}'` 请求 `/api/echo`；status=200，JSON.parse(body) 等于 `{method:'POST',echo:{probe:'P22'}}`，服务端 body 字节与原串相等；没有隐式 JSON 转型。
3. **HTTP 错误状态**：分别请求 `/api/error` 和 `/missing`；工具不抛错且 ok=true，status 分别为 500/404，正文严格匹配 fixture 固定 JSON。
4. **默认不跟随**：只给 `/redirect`；返回 status=302、redirects=[]、空正文；临时计数服务器另证默认只收到一次请求。Location 输出已绝对解析并脱敏 fragment，不能泄漏原 fragment。
5. **显式跟随**：`/redirect,followRedirects:true,maxRedirects:1`；status=200，最终 url 指向 `/second.html?from=redirect` 且 fragment 脱敏，body 含 `second-page`；redirects 恰一项 status=302、method=GET、from/to 目标相符。通过策略验证 spy 或临时链计数证明初始与下一跳均调用 validateTarget，不能只凭最终 200 推断。
6. **超限**：临时 loopback 服务器 `/a→/b→/c`；true/maxRedirects=1 在 /b 的响应后抛 HTTP_REDIRECT_LIMIT/network/false，计数 a=1,b=1,c=0。true/0 遇首跳也同码且目标跳计数=0。
7. **方法规则**：临时服务器分别返回 POST 的 301/302/303/307/308；断言 301/302/303 下一跳 GET 且无 body/调用方 content-type，307/308 保留 POST 与原 body；HEAD 遇 303 仍 HEAD。
8. **超时**：`/api/slow?ms=1000,timeoutMs:50` 抛 HTTP_TIMEOUT/timeout/true，在 1s 内结束，当前连接被取消/销毁且无后续派发；另以注入挂起 DNS 或慢正文证明总时限覆盖 DNS/正文，不仅等响应头。timer/listener 在结束后清理。
9. **取消**：预 aborted signal 请求 /health，服务端计数为 0，抛 ABORTED/cancelled/true；已收到 `/api/slow?ms=1000` 请求后 abort，1s 内结束，迟到响应无第二次 settle，下一次 /health 正常。断言取消不调用 runtime.close、不改变另一个请求/页面租约。
10. **阻断目标零派发**：file、userinfo、metadata/link-local、unspecified、multicast、RFC1918/ULA（allowPrivate=false）及已配置 DSH origin 均 INVALID_ARGUMENT，客户端 dispatch spy=0；阻断地址不真实联网。DNS 注入返回混合 public+private 也零派发；DNS 失败为 NAV_FAILED。allowPrivate=true 仅放行私网策略（用 spy，不要求真实私网可达），metadata/DSH origin 仍阻断。
11. **重定向阻断零派发**：允许的临时 loopback 响应 302 到 metadata、DSH origin、带 userinfo、非法 scheme；首跳计数=1，被阻断跳 dispatch=0，抛 INVALID_ARGUMENT。使用重定向到一个可计数的第二个 loopback origin，并把其 origin 加入 runtime.origins，断言第二服务器请求数为 0，提供真实零请求佐证；HTTPS→HTTP 降级也零派发。
12. **非法参数零副作用**：逐个覆盖全部字段边界上下各一、null/错误类型/未知字段、小数/字符串数字、错误大小写方法、GET/HEAD body、超 UTF-8 body/头预算、重名头、CRLF/NUL、危险头及其大小写变体；均 INVALID_ARGUMENT，dispatch/DNS spy=0，Chromium 未启动。合法最小/最大值只用回环短请求或注入验证，不故意等待 20s。
13. **正文上限与字节一致**：临时服务器分别发送恰好 N bytes、N+1 bytes、无 Content-Length 的持续响应；maxBytes=N 时分别 truncated=false/true/true，保留恰 N bytes 并停止流；binary `[0,255,1]` 为 base64 且解码逐字节相同；UTF-8 多字节截断落半个码点时为 base64；空/HEAD/204 响应 bodyBytes=0。正文异常断开为 HTTP_FAILED，不能以 truncated=true 掩盖。
14. **无 cookie jar/页面凭据**：临时服务器响应 Set-Cookie 后再次调用，服务器未见 Cookie；Cookie 参数直接拒绝；用页面 Cookie 与独立请求对照时也不携带页面 Cookie。显式 Authorization/x-api-key 同 origin 到达目标，但不出现在 args/errors/logger；同 origin redirect 保留，跨 origin redirect 清空所有调用方头（含自定义 secret 头）。
15. **脱敏**：合成 query token/hash/Location URL 与敏感响应头值，断言顶层 url、redirects、target、args、error details/message、render 与 logger 不含原 URL secret 或敏感头值，敏感头为 `["***"]`；正文使用不回显 token 的固定内容，避免误判。只断言本契约明确覆盖的面。
16. **未启动与关闭态**：新 harness 下快照 runtime.proc/cdp/profileDir、profile 目录与进程；依次 HTTP 成功、500、参数拒绝、timeout、abort，再读取 state/capabilities；running=false、proc/cdp/profileDir 未创建、没有新 Chromium pid/profile、network 仍空。设置不存在的 Chrome 路径仍 /health 成功；面板已 close 后结果相同。
17. **跨租约与页面队列独立**：A 持有 lease，并用可控 Promise gate 保持页面 runtime.run 正在执行；B 的 /health 必须在释放 gate 前完成，非 BUSY，A owner/active/lease deadline 不被 HTTP 改动；HTTP 成败/取消均不改页面 lastError/activity。用 gate 顺序而非单纯计时证明没进队列。两个 HTTP 用慢/快接口同时开始，快者在慢者释放前完成。
18. **证据关联**：所有成功（含4xx/5xx/截断）及失败都有 actionId/sessionId/时间/args/target，并进入 render 或抛错证据；target 是本次 HTTP 初始脱敏 URL，即使所属工作区 page 指向别处、请求跟随或失败也不变；anonymous 行为可重现。
19. **真实 lossless 校验**：按 P21 从 DSH_ROOT 与 package exports 加载真实 `@deepseek-ai/dsh-util-values`，记录 version 与 `real:true`；对所有成功结果、render、错误 payload/details 调用 isJsonValue 与 snapshotJsonValue，必须成功且无 undefined/负零/类实例；九工具投影同步覆盖。只有 inline-equivalent 可用时该项为 BLOCKED/NOT_RUN，不能记 PASS。
20. **卸载与资源**：HTTP 进行中 dispose 插件，ABORTED 且句柄/定时器/监听器收尾；面板 /close 不取消 HTTP；已完成请求不得受随后 abort 影响；每跳响应头超过 16KiB 为 HTTP_FAILED 并清理，压缩响应仅返回有界 base64，未经自动解压。
21. **注册 schema 合法（宿主关卡）**：用真实 `@deepseek-ai/dsh-tools` 导出的 `assertSupportedJsonSchema` 断言新工具的参数 schema 与 `output.schema` 落在宿主白名单子集内（不能靠 fake ctx 的宽松注册掩盖）；并断言根 schema `additionalProperties:false`、`required:['url']`、method enum、默认值注解与 §2 一致。`minLength/maxLength/pattern/minimum/maximum/maxProperties/propertyNames` 等越界关键字出现即 FAIL。

P22 主机侧 fake ctx + 本地网络只证明该覆盖路径；需独立记录真实宿主第九工具注册/调用是否已验证，不把静态 schema、P21 校验器或既有 3081 报告冒充新的真实宿主验证。

## 9. 四项收口裁决

### 9.1 browser_state.error 的时效

保留 `error:string` 兼容现有面板，空值仍为 `""`；新增 `errorAt:number|null`（epoch ms）、`errorActionId:string|null`、`errorTarget:string|null`（脱敏）三个平级字段，不引入会随轮询变化的 age 或猜测性的 stale 布尔值，不设任意 TTL。没有错误时三个字段全 null。

将“当前页面错误”与某次 action 绑定：页面/网络操作进入执行后失败时按实际完成顺序记录；随后**真正执行并成功的页面/网络操作**清空全部错误字段，close/成功重新初始化也清空。eval/style 返回 ok:false 的操作错误也记录 code/message 与 action，不能当成功清掉。state/capabilities 的成功诊断不清历史错误；HTTP 独立工具成功或失败均不改这些字段；BUSY/参数预检失败、排队前取消不覆盖其他 owner 的页面错误。导航守卫异步错误有时间/目标但没有 action 时 errorActionId=null；应防旧 metadata/已退役连接事件覆写新运行态。

验收顺序：页面失败→state 两次（字段稳定、时间/target 可关联）→诊断不清→另一 session HTTP 成功/失败不清→同 owner 页面操作成功（四字段清空）→close 清空。此处新增诊断字段不要求修改 client.js 视觉或文案。

### 9.2 runtime-faults:208 清理竞态

静态证据是 [close()](../index.js) SIGTERM/有界 wait→SIGKILL/有界 wait 后，`rm(dir,{recursive:true,force:true})` 的错误被吞掉；[runtime-faults.test.mjs](../tests/acceptance/runtime-faults.test.mjs) 的恢复子进程等旧 PID 消失后立即断言目录不存在。旧文档已有约 1/8 flake 记录；**本次未运行复现，不把具体 errno 或残余写入者身份当成已证实根因**。可确定的问题是删除瞬态失败不可见且测试对目录最终状态没有等待。

裁决两侧都修：实现侧针对 exact mkdtemp profile 的 transient ENOTEMPTY/EBUSY/EPERM/EMFILE/ENFILE 使用 Node rm 的有界重试（`maxRetries:5,retryDelay:50`，与 recursive/force 一起），正常 close 与启动失败清理共用规则；既有进程退出有界等待继续保留，避免以无限重试遮住活进程。最终失败保留脱敏清理诊断，不能静默报告“已删除”。测试侧旧 PID 消失后再 `waitFor(async()=>!await pathExists(oldProfile),{timeoutMs:3000,intervalMs:50})`，保留新旧 PID/profile 不同、owner 恢复等原断言；到期输出实际目录状态并失败，不放宽为容许残留、不靠整组复跑过关。仅加 waitFor 不能修复已停止重试的永久残留，故不能只改测试。

### 9.3 Chrome 可执行文件解析与错误分类

仅在页面 ensure 真正需要启动时解析，不在 import/apply/capabilities/HTTP 调用时探测或启动。顺序固定：

1. 若 `DSH_UI_TESTING_CHROME` 已设置，作为唯一显式覆盖：允许绝对路径或单个命令名；空串/含 NUL/不合法相对路径为 INVALID_ARGUMENT。不经 shell、不拆参数；绝对路径需普通可执行文件，命令名只按 PATH 目录顺序查找。显式覆盖不存在或无执行权限时 **UNSUPPORTED/capability/false**，不得静默回退掩盖部署错误。
2. 未设置覆盖时，先试既有 `/opt/google/chrome/chrome`，保持现有安装优先；不可执行则按 PATH 顺序、每目录按 `google-chrome-stable`、`google-chrome`、`chromium`、`chromium-browser` 顺序选首个可执行文件。空 PATH 条目不代表 cwd，不搜索当前目录，不主动搜其他 profile，不复制/修改系统浏览器。
3. 全部未找到为 **UNSUPPORTED/capability/false**；选中后 spawn 竞态 ENOENT/EACCES 同码，不自动改选。已成功 spawn 但进程提前退出/传输失败为既有 **CDP_DISCONNECTED/disconnected/true**；启动等待 DevToolsActivePort 达现有约 10s 预算为 **CDP_TIMEOUT/timeout/true**，不落成裸 Error→INTERNAL。用户取消为 ABORTED，错误分类优先于 fallback。

默认启动参数不新增 `--no-sandbox`；已有 [验收 wrapper](../tests/acceptance/chrome-wrapper.sh) 只作为显式测试环境覆盖，必须报告使用情况。缺浏览器只影响页面懒启动，HTTP 继续 available；capabilities 仍按现行“页面可懒启动但启动可能失败”规则声明，不由能力读取探测进程。

### 9.4 P20 的页面级断言

沿用 [input-modifiers.mjs](../tests/acceptance/input-modifiers.mjs) 的真实注册工具→页面 recorder→browser_eval 路径，测试临时节点通过 eval 安装，无需改 fixture 文件。CDP ACK、`applied`、schema/透传 spy 都不是页面行为证明。

- **commands**：在临时可编辑 input 放 `abcdef`、聚焦并将 selectionStart=selectionEnd=3；发送 `rawKeyDown`（无 Ctrl/Meta、无 text、无可触发默认全选的快捷键），携带 `commands:['selectAll']`；读回 activeElement 与 selectionStart=0/selectionEnd=6，同时做不带 commands 的对照（仍为3/3），排除平台快捷键偶然生效。事件记录与 selection 均留证。若当前平台支持但对照/命令结果不符为 FAIL；若证实平台无该 editing command 效果，记录平台/Chrome版本、输入与两组页面读数为 INCONCLUSIVE/platform-no-visible-effect，不能将该项写 PASS 或“完整实现”。
- **unmodifiedText**：DOM KeyboardEvent 没有 unmodifiedText 属性，禁止断言 `e.unmodifiedText`。在空 input 记录 beforeinput/input 的 `data/inputType`、keydown/keypress 的 key/code/modifiers 与最终 value，发送 char，例如 `key:'A',code:'KeyA',text:'A',unmodifiedText:'a',modifiers:['shift']`；与省略 unmodifiedText 的相同 char 对照。可执行的可见断言是页面最终 value='A'、input.data='A'、无额外小写 a；该 PASS 只证明 text 与修饰键下的页面输入语义，**不能独立证明 unmodifiedText 被 renderer 消费**。若两组无差异，明确记 unmodifiedText 特有作用 INCONCLUSIVE/platform-no-visible-effect，保留 schema/透传单测与页面证据，不能伪造 DOM 字段或声称该字段完整行为验证。
- **pointerType:pen**：安装 pointerdown/pointermove/pointerup recorder，按 getBoundingClientRect 程序读目标中心，发送 pen 的 mouseMoved/Pressed/Released，读回 `PointerEvent.pointerType==='pen'`、坐标/目标/button/buttons 与事件顺序，再与默认 mouse 对照。当前 normalizePointerType 将字符串转为数字1/2，而 CDP Input.dispatchMouseEvent 的 pointerType 是字符串 mouse/pen；执行者须修正该映射，公开 schema 不变，合法 pen 被 CDP 拒绝为 FAIL。若仅有 mouse 事件或平台确无 pen 可见事件，保留页面原始读数并标 INCONCLUSIVE，不以 mousedown 计数或“工具成功”当 pen PASS；不声称物理触控笔/压感/触屏已验证。

P20 必需通道/现有行为断言保持，不允许静默 skip；平台不可观察项单独列出，Lead 汇报 covered/partial/INCONCLUSIVE，不得为了零 finding 把不可观察项折成通过。

## 10. 残余风险与明确不做

- 沿用 URL/DNS 校验不等于 DNS pinning 或完整网络沙箱；未知 DSH origin、DNS rebinding、URL 路径与未知业务数据的敏感信息仍是残余。
- 无 cookie jar 不等于全局网络/用户数据隔离；显式 Authorization、请求/响应正文和跨 origin 保留的 body 仍可能含秘密，目标放行不构成业务授权。
- 单请求时间/体积/跳数有界，不提供全局速率限制、全宿主并发配额、流式响应订阅、自动重试或后台任务；大量并发仍可能消耗宿主资源。
- 截断结果不能据此断言完整 JSON/body，4xx/5xx 正常返回不代表业务通过；取消/超时无法回滚服务器副作用。
- 结构化 info.code 仍受宿主平台限制；provider 图像可见性仍需独立专项验收；静态文档和 fake-ctx 结果不能替代真实宿主证据。
- 本轮不做 viewport-control、browser-extras、per-session Chromium/page/Cookie 隔离、完整网络沙箱、独立 JSONL/文件证据包、frame-push 半开连接修复；不改 client.js 视觉/文案，不开 T2/T3/T4，不新增上传/下载/Cookie 导出/多标签/frame 选择，不接管 GUI 交互重构。

截至本文交付：上述为执行者可据以实现的裁决，无需新增产品授权的未决技术选项；实现/运行验证尚未执行，P22/P20 与真实宿主验收状态均不得从本文推定。若实现发现无法满足零派发、取消清理、lossless JSON 或原分类兼容，须回报具体阻塞，不能自行降低契约或扩展范围。
