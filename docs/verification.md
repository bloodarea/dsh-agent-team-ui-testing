# 验证与贡献

本页定义公共验证方法和报告判读规则。执行端依赖、真实目标及具体验收命令见各环境的验证指南。

## 公共契约验证

从仓库根目录运行 `node --test tests/contracts/*.test.mjs`。公共契约测试覆盖配置、适配器、P0 数据模型、面板接点和作用域隔离。真实目标操作需使用对应环境的验收套件。

## 判读结果

每个套件把报告写到 `tests/acceptance/runs/<时间>-<pid>/`，文件名按套件是 `run-report.json` 或 `report.json`，并附日志。判读规则：

| 字段 | 含义 |
| --- | --- |
| `criteria` | 验收条目通过数 / 总数 |
| `requiredChecks` | 必需检查通过数 / 总数 |
| `failedChecks` | 必须为 0；非 0 即失败 |
| `notRunChecks` | 未运行项，**不算通过** |
| `exit 0` | 通过 |
| `exit 2` | 有必需项未运行（不是失败） |
| `exit 1` | 存在失败项 |

注意事项：

- `notRun` 必须原样报告，不能写成「已验证」。
- 工具执行、断言结论与证据完整性的判读，按[能力分层的共同约束](capability-tiers.md#21-支持可用执行和通过分别判断)与对应工具契约执行。
- 报告中的 `observed` 只代表那一次运行，不是长期保证。

## 目标环境验收

- [Web 验证环境、主机侧套件与真实 GUI 验收](web/verification.md)
- 运行环境互斥：`tests/acceptance/provider-exclusive-gui.mjs` 在真实设置页里点 Web 的 Edge / Chrome 开关，断言另一个自动关闭、一次点击只涨一个 revision；契约层 `tests/contracts/provider-exclusivity.test.mjs` 覆盖补丁、加载收敛与 3D 单 provider。语义见 [运行环境（provider）开关](target-environments.md#运行环境provider开关)。
- 视图选择：`tests/acceptance/view-selection.mjs` 在同样的隔离实例上走已认证的同源 HTTP，断言默认视图（新会话、无能力）、`POST /config/select` 的 `view` 持久化、按会话隔离、3D 可选中但无执行能力、以及显式选回默认视图。契约层另有 `tests/contracts/view-selection.test.mjs` 覆盖工作区继承与 A/B 工作区隔离。语义见 [调试面板公共视图 · 视图选择](debug-panel.md#3-视图选择与默认视图)。
- 3D：`tests/acceptance/three-d-provider-switch.mjs` 在本机起一个私有隔离 DSH 实例（随机端口、临时 `DSH_HOME`、`--no-open`），用独立 headless Chromium 走真实 GUI 登录令牌操作设置页，断言 Blender 卡片开关的可点性、`PUT /config` 的写入字段、revision 递增，以及 `/blender/frame` 在 provider 关闭时 409、开启时返回 PNG。不触碰运行中的实例；报告写在 `tests/acceptance/runs/three-d-provider-switch-*`。门禁语义见 [Blender 纯视口 · 启用条件](three-d/debug-panel.md#启用条件)。

## 改动如何生效

| 改动 | 生效方式 |
| --- | --- |
| 面板 UI（`client.js`） | 更新客户端产物后刷新当前 DSH GUI |
| Host 实现、工具 schema、Skill provider 或配置存储 | 重启 DSH 或重挂插件；旧会话中已经注入的 Skill 正文不会自动移除 |
| 仅文档 | 重新打开或刷新文档预览，无需重启 DSH |
| 设置页的环境启用配置 | 保存后生效，无需重启；会话准入与后续 Skill 发现按新配置执行 |

## 本地生成物

以下内容由运行/验收产生或属于本机资料，不纳入版本控制：

```text
tests/acceptance/runs/       验收报告与日志（运行时生成）
tests/acceptance/evidence/   人工留存的证据与截图（运行时生成）
output/                      插件运行输出（运行时生成）
```

## 提交前检查

1. 改动范围与需求一致，不做顺手重构。
2. 工具名、schema、能力报告、内置 Skill 与文档同步更新（同一事实多处出现时必须一起改）。
3. 至少跑通受影响的套件；行为变化要在 PR 描述里给出命令与结果。
4. 未验证的部分明确写「未验证」，不得用推断代替结论。
5. 不提交凭据、个人设备数据、未脱敏的认证流量或本机绝对路径。

## 贡献方向

最有价值的是可复现的问题：DSH 集成差异、平台可行性、无障碍/DOM 回退案例、安全威胁模型，以及具体的 UI 验收场景。

提 issue 时请附 DSH 版本/commit、平台与运行时版本、复现步骤、预期与实际结果，以及脱敏后的证据。
