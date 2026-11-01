# 内置 Skill：模板与已落地实现

> 索引：[docs/index.md](index.md) · 更新于 2026-10-31

## 两个位置，别混淆

- **模板**：`reference/skill-template-v1.1/`，一套**编写插件内置 Skill 的参考模板**，不是已启用的 Skill，也不是可运行的插件。入口 `reference/skill-template-v1.1/README_TEMPLATE.md`。该目录**不入库**（已在 `.gitignore`），只存在于本地工作区；从远端克隆的仓库没有它。
- **已落地实现**：`skills/ui-testing/`（27 个文件）随插件发布，由 `index.js` 的 `ctx.inject(['skills'], …)` 注册为 `ui-testing`。运行时 Agent 通过 `skill` 工具加载正文，`resourceBase` 指向该目录，可再按需读取 `references/` 等资源。

模板自带 `knowledge/`、`manifests/` 在落地时被收进 `skills/ui-testing/` 内部（`skills/ui-testing/knowledge/…`、`skills/ui-testing/manifests/…`），这样 `package.json` 只需 `files: ["skills/**"]` 就能整包发布，不用在仓库根再加两个目录。

## 硬规则：以实际实现为准

模板里的 `planned` / `not-verified` 标记、示例工具名、示例参数**都只是占位**。落地版已按真实实现改写，事实来源：

| 模板里的条目 | 真实状态 |
| --- | --- |
| `web.t1.runtime-evaluate`（JS 执行） | 已实现：`browser_eval` + `POST /plugins/ui-testing/eval` |
| `web.t1.input`（原生事件） | 已实现按键/组合键：`browser_input` + `POST /input`；`modifiers`（数组或位掩码）、`virtualKeyCode`、`autoRepeat`、`location/isKeypad`、mouse/wheel 修饰键均透传，整批先校验后派发（P20）。`applied` 仍只是数组长度；`commands`/`unmodifiedText`/`pointerType:pen` 本轮补页面真值断言（pen 已修 CDP 字符串映射；无可见效果项按 INCONCLUSIVE 记录） |
| `web.t1.network-observe`（网络抓包） | 部分实现：`browser_network`，响应及 loadingFailed 元数据、URL 脱敏；无头/正文；其他 owner 调用返回 BUSY |
| `web.t1.cssom`（样式读取） | 已实现：`browser_computed_style`（只取首个匹配元素） |
| `web.t1.http-request`（独立 HTTP 请求） | 已实现：`browser_http_request`（Host 侧 node:http/https，不启动 Chromium、不占租约）；默认不跟随重定向、5s/64KiB 预算、每跳复验目标、无 cookie jar；契约见 [t1-http-request.md](t1-http-request.md) |
| `web.t1.screenshot` | 保留 base64 与 `capturedAt/sha256/attachmentId`；可选附件 image block，无服务 render `base64-fallback` 文本；返回值按 lossless JSON 投影（附件为纯 JSON），否则真实宿主会判 `INVALID_TOOL_OUTPUT`；provider 可见性待实测，无 T3 分析 |
| 能力发现 | 工具面 9 个，`browser_capabilities` 报真实 `available/unavailable/unsupported`（含 web.t1.http-request=available）；注册表决定能否调用，state/capabilities 诊断不启动 |
| T2 结构化 GUI / T3 静态视觉 / T4 动态视觉 | 未实现，Skill 与 manifest 明确标 `unsupported` |

运行时细节与限制见 [runtime-t1.md](runtime-t1.md)，M0–M2 当前契约与待验收项见 [t1-m0-m2-contract.md](t1-m0-m2-contract.md)；[t1-infrastructure-audit.md](t1-infrastructure-audit.md) 是历史结论，不代表新增路径通过。改 `index.js` 的工具名/参数时，**必须同步改 SKILL 与台账**，否则 Skill 会教 Agent 调用不存在的接口。

## 注册与发布（已落地）

1. 资源目录由 `index.js` 按 `new URL('./skills/ui-testing/', import.meta.url)` 定位，注册代码从 `SKILL.md` 的 frontmatter 取**单行** `description`（块标量会退回代码内常量），正文去掉 frontmatter 后作为 `content`。
2. 注册走 `ctx.inject(['skills'], …)`：宿主没有 `skills` 服务或资源缺失时只记日志，不阻断浏览器工具，保证纯工具部署可用。
3. `package.json` 的 `dsh.profile` 安装方式不变；新增 `files: ["skills/**"]`，`npm pack --dry-run` 可见 27 个 Skill 文件随包发布。
4. 改 `index.js` / `package.json` / 新增 `skills/` 属 Host 变更，**需要重启 DSH** 才生效；`client.js` 仍是热更新。

## 验收入口

```bash
node tests/acceptance/check-skill.mjs           # SKILL 结构、引用文件、工具名与 index.js 一致性
node tests/acceptance/check-skill-registry.mjs  # 真实 DSH SkillRegistry 的注册/发现/加载/render
node tests/acceptance/run.mjs                   # 驱动真实运行时；本轮探针数量/结果以实际报告为准
```

`check-skill-registry.mjs` 需要本机已安装 DSH（可用 `DSH_ROOT` 覆盖包路径）；它证明 `ctx.skills.register()` 在真实 DSH 服务里能列出、加载、渲染，**不代表**某个正在运行的 DSH 会话已经重启生效。Agent 会话级是否真的能调用 `skill` 工具，以重启后新会话的实际工具列表为准。

模板自带的 `reference/skill-template-v1.1/scripts/validate_skill.py` 只校验模板目录自身结构（`ROOT/manifests/…`、全部 `planned`），**不能**用来校验 `skills/ui-testing/`，验收以上面的三个脚本为准。