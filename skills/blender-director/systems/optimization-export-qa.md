# 优化、导出与 QA

```json
{"id":"optimization-export-qa","version":"1.0.0","requiredOps":[]}
```

## 输入

阶段 brief、交付规格片段和 specRef、已绑定对象 ID、当前工程 checkpoint、源/求值网格统计、目标平台与格式、单位与轴向、层级/材质/外链清单、面数/内存预算、验收 assertions 和实际能力版本。

## 操作与边界

先核对交付范围和已有证据，按缺陷定位原阶段。优化方案需对比面数收益与轮廓/外观损失；不得为了满足预算删除用户对象或破坏不相关字段。当前 8 个受控 op 没有减面或格式导出能力，requiredOps 为空不代表这些步骤已执行。需要时列 blocker，保留可编辑原工程，不能用 shell/Python 导出替代。

保存和独立验证经 `blender_project` 与 `blender_verify` 的实际可用动作；写入须先 plan，在工具核验的授权与租约下执行。工程保存成功也不等同独立重开成功；验证对象必须是指定路径发布的那个摘要与 revision，不能取内存中的旧场景作证。导出不可用时仅在用户明确同意后交付工程与受限报告，不称导出完成。

## 输出

输出 `version=1.0.0`、briefId/stageId/specRef、boundObjectIds、空执行 proposal.ops、优化/格式方案、checks、dependencies 和 blockers。交付清单逐项记 artifact/checkpoint、摘要、版本、pass|fail|unknown、证据引用和复核方式。未产生的导出件不列为已交付。

## 下一阶段门槛

| 指标 | 单位 | 来源与容差 | 所需证据 |
| --- | --- | --- | --- |
| 持久工程/导出身份 | hash/revision | 交付清单；摘要精确一致 | 磁盘摘要、独立打开记录 |
| 尺寸与轴向 | m/degree | 规格与目标平台约定、公差 | 独立重开后的局部/世界读数 |
| 层级、稳定 ID、材质与外链 | 个/关系 | 规格清单；缺失/重复容差 0 | 重开后枚举与引用解析 |
| 几何与资源预算 | triangles/bytes | brief 上限 | 源、优化、导出统计对照 |
| 视觉损失 | px/IoU 或评审 | brief 的容差与标准 | 同镜头优化前后图、独立评审 |

每项硬检查需 pass；fail 必须返修。缺独立重开、格式读取器或视觉证据则对应 unknown，附解除方式。主观风格由用户/顾问裁决，不能覆盖结构、保存或尺寸失败。修订后重验受影响的全部断言。
