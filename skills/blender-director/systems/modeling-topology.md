# 建模、雕刻与拓扑

```json
{"id":"modeling-topology","version":"1.0.0","requiredOps":[{"opId":"collection.ensure","minOpVersion":1},{"opId":"object.ensure","minOpVersion":1},{"opId":"object.parent","minOpVersion":1},{"opId":"object.transform","minOpVersion":1},{"opId":"mesh.primitive","minOpVersion":1}]}
```

## 输入

阶段 brief、规范化规格片段及其 `specRef`、单位/轴约定、硬尺寸与公差、参考轮廓和标定信息、面数预算、实际 op 版本、已绑定 `obj_* / part_*` 对象 ID、当前层级、受管摘要和工程 revision。缺尺度时只能给无量纲比例候选，不能猜成米制真值。

## 操作与边界

先按部件和连接关系拆分对象，在 `DSH::<sceneId>` 受管集合内创建或复用 assembly Empty 与独立 Mesh。按依赖安排 ensure → parent → 局部 TRS → 几何；root 与 part 通过稳定 ID 绑定，不按可编辑名称猜测。使用 WXYZ 四元数，声明局部/世界空间，核对 parent 后世界矩阵。保存前不无差别应用缩放或改枢轴。

当前可提案的几何是 `box/cylinder/frustum`，轮廓先于细节；圆形离散段数是实现参数，应写入 plan、args 和产物摘要，不能变成无来源的规格 claim。部件须有合理位置、比例与归属，不以大量重叠原语伪装细化拓扑。

只经 Tools 提交版本化 `ops[]`，先 plan，核对影响后在授权租约下 apply。单批不超过 32 项并遵守运行时更低预算。更新前核对 content hash；重复 stableId、外部使用者、非受管子对象或所有权不明时停止。需要删除时单独发现 `object.remove` 版本及删除权限，提交显式计划与一次性 approval grant，不能作为清理默认步骤。

雕刻、挤出、倒角、重拓扑、开放边界编辑与任意网格资产不在这些 op 的覆盖内。需要时输出具体缺失能力和对应规格 JSON Pointer，保留白模，不以 shell/Python 或忽略字段替代。

## 输出

按 Director 合同输出 `version=1.0.0`、`briefId/stageId/specRef`、`boundObjectIds[]`、`proposal.ops[]`（含 stepId/opId/opVersion/args）、`checks[]`、`dependencies[]`、`blockers[]`。附对象层级、白模 checkpoint、原始与 evaluated 网格统计（可读时）、声明的有意开放边界和不可编译字段。

## 下一阶段门槛

| 指标 | 单位 | 来源与容差 | 所需证据 |
| --- | --- | --- | --- |
| 主尺寸与部件偏移 | m | 规格硬尺寸与显式公差；缺值为 unknown | 局部无缩放几何读数、世界边界/矩阵独立读回 |
| 主标志点与剪影比例 | 归一化比值或 px | brief/已标定参考，容差来自 acceptance | 相同画幅和视角的独立对比图、点与 mask |
| 稳定 ID、父级和归属 | 个/关系 | 规格 ID 唯一、无环；计数容差 0 | 重新枚举层级与受管摘要 |
| 原始/evaluated 面数 | triangles | brief 上限；不自动放宽预算 | 网格统计及版本 |
| 法线、流形与可编辑性 | 个异常 | 有意开放边界名单外异常为 0；未能检查为 unknown | 独立拓扑检查与边界列表 |

硬尺寸或层级失败返回本阶段；不可获取的拓扑检查记 unknown。只有必需检查 pass 或用户明确接受受限白模范围时，才交 UV/材质或后续系统。
