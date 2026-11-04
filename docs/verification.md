# 验证与贡献

本页说明如何复现验证、如何判读结果，以及提交改动前必须做到什么。

## 环境

- Node.js 22 及以上。
- 本地 Chrome / Chromium（可用 `DSH_UI_TESTING_CHROME` 指定）。
- 验收套件**自己启动**无头 Chromium 与本地靶机（只监听 `127.0.0.1`），不会驱动你正在使用的 DSH 实例。

## 主机侧套件

```bash
node tests/acceptance/run.mjs                  # 主验收：工具面、能力报告、渲染与 lossless 投影
node tests/acceptance/viewport.mjs             # 共享视口与画布
node tests/acceptance/capture-p0.mjs           # 截图采集
node tests/acceptance/t2-structured.mjs        # 结构化 GUI
node tests/acceptance/t3-vision.mjs            # 静态视觉
node tests/acceptance/t4-dynamic.mjs           # 动态行为 40 条门槛
node tests/acceptance/t4-visual-fixtures.mjs   # 动态视觉靶机
node tests/acceptance/t4-network-fixtures.mjs  # 动态网络靶机
node tests/acceptance/network-p0.mjs           # 网络 P0
node tests/acceptance/network-chain.mjs        # 电商链路场景
node tests/acceptance/workspace-isolation.test.mjs
node --test tests/acceptance/runtime-faults.test.mjs
node --test tests/dynamic-t4.test.mjs          # T4 纯核心单测
node --test tests/network-p0.test.mjs          # 网络纯核心单测
node tests/acceptance/check-skill.mjs          # Skill 结构、引用、工具名与清单一致性
node tests/acceptance/check-skill-registry.mjs # 真实 SkillRegistry 注册与加载
```

**串行执行**：这些套件各自启动 Chromium 与靶机，并行会让端口、profile 与 CPU 互相干扰，计数不可信。

## 判读结果

每个套件把报告写到 `tests/acceptance/runs/<时间>-<pid>/`，包含 `run-report.json` 与日志。判读规则：

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
- 截图成功、识别到候选、输入已派发，都不等于验收通过；看 `verdict`。
- 报告中的 `observed` 只代表那一次运行，不是长期保证。

## 真实验证（可选）

需要验证真实宿主行为时，建议起一个**隔离实例**（独立 `DSH_HOME`、独立端口、复制 profile、软链 `node_modules`），不要用你日常使用的实例。相关脚本：

```bash
node tests/acceptance/viewport-gui.mjs   # 隔离 DSH + 无头 Chrome 的面板断言
node tests/acceptance/verify-3081.mjs    # 隔离宿主 HTTP 集成
```

这些脚本不会自己重启实例；改了 `index.js` 或 `client.js` 后必须先重启隔离实例再取证。

## 本地生成物

以下内容属于本地产物，不纳入版本控制：

```text
tests/acceptance/runs/       验收报告与日志
tests/acceptance/evidence/   人工留存的证据与截图
docs/internal/               开发过程记录
output/                      插件运行输出
reference/                   本地参考资料
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
