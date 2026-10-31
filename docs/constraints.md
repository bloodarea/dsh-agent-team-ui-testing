# 边界与其他约定

> 索引：[docs/index.md](index.md)

- `tests/ui_test_exam/` 是**能力对照测试**用的靶机（20 处预设缺陷），不是盲测题库：`_examiner_only/` 里的答案与靶机同仓存放是**有意的**，用于事后逐条对照插件的发现能力。
- 如果将来要改成正式盲测，必须先把 `_examiner_only/` 移出本仓库（或私有仓库）——目录隔离不是安全隔离，被测 Agent 在同一台机器上能直接读到答案。
- 仓库里的 `README.md` / `README_zh.md` 是架构设计文档，其中的能力清单多为规划，不代表已实现；分层章节（T1–T4）与 [capability-tiers.md](capability-tiers.md) 保持一致。
- 能力分层这一事实同时存在于 README（中英）、docs 与界面文案的推导中，改动时一起改。
- `tests/ui_test_fixture/` 是**为本插件验收自建的、明确授权的本地 Web 靶机**（只监听 127.0.0.1），与 `tests/ui_test_exam/` 的对照测试靶机是两回事；验收脚本见 `tests/acceptance/`。
- M0–M2 前的历史验收 `run.mjs` 以 exit=1 结束，P2 两处失败是当时的真实缺陷（标题恒空、不可达导航静默成功），不是脚本问题。该结果已被现行主验收对应路径取代：21/21 组、196/196 必需项、0 finding/skip、exit=0；旧输出保留为历史，不改写。3081 宿主（重启后）`verify-3081` 14/14 PASS、exit=0；真实 Agent/provider 视图仍 NOT_RUN；故障注入单测 16/16、exit=0。现行契约与验收状态见 [t1-m0-m2-contract.md](t1-m0-m2-contract.md)。
- 主实例 3080 不重启、不操作；本轮真实宿主验收用用户指定的 3081 隔离实例。本轮已做 M3 输入扩展（N2：`browser_input` 的 modifiers/功能键，仅限该工具契约）；多 target、帧升级、UI 变更仍不做。
