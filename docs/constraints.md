# 边界与其他约定

> 索引：[docs/index.md](index.md)

- `tests/ui_test_exam/` 是**能力对照测试**用的靶机（20 处预设缺陷），不是盲测题库：`_examiner_only/` 里的答案与靶机同仓存放是**有意的**，用于事后逐条对照插件的发现能力。
- 如果将来要改成正式盲测，必须先把 `_examiner_only/` 移出本仓库（或私有仓库）——目录隔离不是安全隔离，被测 Agent 在同一台机器上能直接读到答案。
- 仓库里的 `README.md` / `README_zh.md` 是架构设计文档，其中的能力清单多为规划，不代表已实现；分层章节（T1–T4）与 [capability-tiers.md](capability-tiers.md) 保持一致。
- 能力分层这一事实同时存在于 README（中英）、docs 与界面文案的推导中，改动时一起改。
