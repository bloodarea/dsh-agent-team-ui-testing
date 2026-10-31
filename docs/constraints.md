# 边界与其他约定

> 索引：[docs/index.md](index.md)

- `tests/ui_test_exam/_examiner_only/` 是考官答案。**以被测 Agent 身份工作时禁止访问**，只用 `tests/ui_test_exam/target/AsterFlow_Workspace.html`。
- 正式盲测时最好把 `_examiner_only/` 移出本仓库（或放进私有仓库），否则被测 Agent 在同一台机器上能直接读到答案；目录隔离不是安全隔离。
- 仓库里的 `README.md` / `README_zh.md` 是架构设计文档，其中的能力清单多为规划，不代表已实现；分层章节（T1–T4）与 [capability-tiers.md](capability-tiers.md) 保持一致。
- 能力分层这一事实同时存在于 README（中英）、docs 与界面文案的推导中，改动时一起改。
