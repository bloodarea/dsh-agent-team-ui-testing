# 内置 Skill 编写参考（模板包 v1.1）

> 索引：[docs/index.md](index.md) · 更新于 2026-10-31

## 这是什么

`reference/skill-template-v1.1/` 是一套**编写插件内置 Skill 的参考模板**，不是已启用的 Skill，也不是可运行的插件。

- 位置：`reference/skill-template-v1.1/`
- 入口：`reference/skill-template-v1.1/README_TEMPLATE.md`
- 主 Skill 骨架：`reference/skill-template-v1.1/skills/ui-testing/SKILL.md`

之所以放在 `reference/` 而不是仓库根：模板里自带 `skills/`、`knowledge/`、`manifests/`、`integration/`、`scripts/` 和一份 `docs/`，直接铺到根目录会和现有 `docs/`（项目记忆）以及将来真正要发布的 `skills/` 混在一起。真正启用时再从模板复制，不要原地改模板。

## 硬规则：以实际实现为准

模板里的 `planned` / `not-verified` 标记、示例工具名、示例参数**都只是占位**。写真正的 SKILL 时，以下事实优先于模板：

| 模板里的条目 | 当前真实状态 |
| --- | --- |
| `web.t1.runtime-evaluate`（JS 执行） | **已实现**：`browser_eval` 工具 + `POST /plugins/ui-testing/eval` |
| `web.t1.input`（原生事件） | **已实现**：`browser_input` 工具 + `POST /input`；键盘只支持可打印字符与少量控制键 |
| `web.t1.network-observe`（网络抓包） | **已实现**：`browser_network` 工具，只存元数据、不含正文 |
| `web.t1.cssom`（样式读取） | **已实现**：`browser_computed_style` 工具 |
| `web.t1.http-request`（Playwright APIRequestContext） | **未实现**：没有独立 HTTP 客户端，页面内请求只能靠 `browser_eval` 里的 `fetch` |
| T2 结构化 GUI（元素选取/ARIA） | **未实现**，界面按钮禁用 |
| T3 / T4（视觉、动画） | **未实现** |

其它必须与实现对齐的点：

- 能力发现没有独立接口；目前唯一可用的自述是 `browser_state` 工具返回的 `{mode, activity, url, viewport, running}`。
- 运行时的细节与限制见 [runtime-t1.md](runtime-t1.md)，不要把模板示例里的 Playwright 用法写进 SKILL 当作可用能力。
- 模板自带的 `knowledge/web/t1-capability-ledger.md` 仍是初始 `planned` 状态；真正集成 Skill 时必须按实现逐项改写，并附代码位置与运行证据。

## 真正启用内置 Skill 时的步骤

1. 把 `reference/skill-template-v1.1/skills/ui-testing/` 复制到仓库根的 `skills/ui-testing/`（DSH 要求 Skill 资源随包发布）。
2. 按上表把内容改成实际实现，删掉所有不存在的工具与参数。
3. 在 `index.js` 里用 `ctx.skills.register(...)` 注册，并确认 scope（宿主全局或 preset）。
4. 把 `skills/**` 加进 `package.json` 的 `files`，否则发布包里没有这些文件。
5. 用 `python reference/skill-template-v1.1/scripts/validate_skill.py` 做结构自检——它只校验模板结构，**不代表 DSH 能发现或加载**；最终以 `skill` 工具能否列出并加载为准。
