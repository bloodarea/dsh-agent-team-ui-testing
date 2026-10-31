# 项目文档索引

本仓库的项目记忆全部放在 `docs/` 下，**一个主题一个文件**。`AGENTS.md` 只保留通用工作规范，不放项目事实。

| 文件 | 内容 | 什么时候读 |
| --- | --- | --- |
| [status.md](status.md) | 当前实现状态、冻结约定、未实现清单 | 任何改动前先读 |
| [t1-m0-m2-contract.md](t1-m0-m2-contract.md) | M0–M2 现行实现契约、验收状态与剩余风险 | 查工具/租约/错误/证据现状时先读 |
| [t1-infrastructure-audit.md](t1-infrastructure-audit.md) | M0–M2 前历史审计（结论、证据、缺口；不代表现行状态） | 追溯缺陷与历史证据时 |
| [t1-issues-and-solutions.md](t1-issues-and-solutions.md) | 缺陷解决状态总表：已解决/部分解决，以及「不属于 T1」的分类依据（含 §3.2/§3.3） | 查某个问题是已修、待做还是不该在 T1 做时 |
| [runtime-t1.md](runtime-t1.md) | T1 运行时：无头 Chromium、HTTP 接口、Agent 工具、限制 | 改运行时/接工具时 |
| [skill-authoring.md](skill-authoring.md) | 内置 Skill 编写参考（模板包位置、以实际实现为准的对照表） | 写/改 SKILL 时 |
| [capability-tiers.md](capability-tiers.md) | Web 能力分层 T1–T4：分层总表、每级完成门槛、回退链规则、选型与实现策略 | 设计/排序功能时 |
| [architecture.md](architecture.md) | 代码结构与文件职责 | 改代码前 |
| [ui-spec.md](ui-spec.md) | 已定稿界面的尺寸与规格 | 动 UI 前（需用户同意） |
| [dsh-integration.md](dsh-integration.md) | DSH 插件接入要点与已踩的坑 | 接新能力、排查不生效时 |
| [verification.md](verification.md) | 怎么验证（隔离实例 + 无头 CDP） | 需要证明"改生效了"时 |
| [constraints.md](constraints.md) | 边界与其他约定（靶机、README 定位） | 涉及考试/对外文档时 |

## 维护约定

- 新增主题就新增一个文件，并在上表登记；不要把这些内容塞回 `AGENTS.md`。
- 同一事实如果在多处出现（例如分层表同时出现在 README 与本目录），改的时候**一起改**。
