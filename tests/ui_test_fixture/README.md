# tests/ui_test_fixture — 明确授权的本地 Web 靶机

这是 **`dsh-agent-team-ui-testing` 插件 T1 Web 验收专用的本地靶机**，由本仓库自行编写并明确授权被测 Agent 访问。它**不是**外网站点、不是用户数据、也不包含任何真实凭据。

## 性质与边界

- 零依赖：只用 Node.js 内置 `node:http` / `node:fs` / `node:url`，不装任何 npm 包。
- 离线确定：页面与接口内容全部写死，无随机数、无外部请求、无第三方 CDN、无字体/图片外链。
- 只监听 `127.0.0.1`，端口用 `0` 由内核分配（每次运行不同，不会撞端口）。
- 供 `tests/acceptance/` 的验收探针驱动；也可以手工启动后用插件面板/工具调试。

## 启动

```bash
# 独立启动（前台运行，Ctrl+C 退出）
node tests/ui_test_fixture/server.mjs
# 打印：FIXTURE_URL=http://127.0.0.1:<随机端口>/

# 在验收脚本里以编程方式启动（推荐）
node -e "import('./tests/ui_test_fixture/server.mjs').then(async (m) => { const f = await m.startFixtureServer(); console.log(f.url); await f.close(); })"
```

## 接口（全部确定性）

| 方法 | 路径 | 行为 |
| --- | --- | --- |
| GET | `/health` | `200 {"ok":true,"status":"healthy","fixture":"dsh-ui-testing"}` |
| GET | `/api/data` | `200 {"message":"fixture-data-ok","items":[1,2,3],"source":"dsh-ui-testing-fixture"}` |
| GET | `/api/error` | `500 {"error":"fixture-internal-error","status":500}` |
| GET | `/api/slow?ms=N` | 延迟 `min(N,5000)` ms 后 `200 {"delayed":true,"ms":N}` |
| POST | `/api/echo` | `200 {"method":"POST","echo":<JSON 解析后的 body，失败则为原文>}` |
| GET | `/missing` | `404 {"error":"not-found","status":404}` |
| GET | `/redirect` | `302`，固定 `Location: /second.html?from=redirect#landed`，`Cache-Control: no-store`；无自由 `to` 参数（不可变成开放重定向） |
| GET | `/`、`/index.html` | 主页面 `index.html` |
| GET | `/second.html` | 第二页 `second.html` |

`pushState` / `replaceState` / `location.hash` / GET 搜索表单等地址栏验收场景由测试脚本经插件 `/eval` 在页面内临时安装，不改本仓库页面文件；`/redirect` 是唯一为地址栏验收新增的固定路由。

## 页面断言值（验收脚本依赖，改动页面必须同步改 `tests/acceptance/run.mjs`）
`index.html`：

- `#counter`：初始文本固定为 `"0"`；点击 `#inc` 一次后变为 `"1"`。
- `#style-target`：固定计算样式，用于 `browser_computed_style` 断言：
  - `color: rgb(220, 38, 38)`
  - `font-size: 16px`
  - `font-weight: 700`
  - `padding-top: 12px`、`padding-left: 16px`
- `#name`（输入框）、`#submit`（按钮）、`#result`：点击提交后 `#result` 为 `"hello <name>"`；空名字为 `"empty-name"`。
- `#fetch-btn` → `#fetch-result`：点击后显示 `/api/data` 的 `message`（`fixture-data-ok`），并在 `body.dataset.fetchStatus` 写入状态码。
- 页面加载时**自动**发起一次 `GET /api/data`，并把 `fixture-data-ok` 写入 `body.dataset.autoload`，供 `browser_network` 断言。
- `?token=DEMO_TOKEN_NOT_REAL`：页面把 query 里的 token 写入 `window.__fixture.token` 与 `body.dataset.token`。它**只是假 token**，用于验证运行时网络记录是否脱敏（不用于任何鉴权）。

`second.html`：

- `<title>` 固定为 `DSH UI Testing Fixture — Second Page`，`#second-marker` 文本为 `second-page`。

## 明确禁止

- 不要把它改成需要外网依赖（CDN、远程 API、外部字体）的页面。
- 不要把真实 token / Cookie / 凭据写进页面或 query；测试 token 固定用 `DEMO_TOKEN_NOT_REAL`。
- 不要改成监听 `0.0.0.0`；靶机必须只在本机回环地址可达。
