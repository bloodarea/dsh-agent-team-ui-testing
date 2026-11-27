# UV、材质与纹理

```json
{"id":"uv-material-texture","version":"1.0.0","requiredOps":[{"opId":"material.ensure","minOpVersion":1},{"opId":"material.assign","minOpVersion":1}]}
```

## 输入

阶段 brief、规格材质片段和 specRef、已绑定 part Mesh / mat ID、槽索引、共享材质使用者、已确认的线性 Base Color/roughness/metallic/opacity、参考光照及色彩管理、像素密度/纹理预算、授权图像引用及摘要、实际 op 版本。图像像素值与物理材质参数分开记录。

## 操作与边界

先过几何门槛。用 `material.ensure` 创建或更新受管 `mat_*`，只写已确定的 claim；用 `material.assign` 将材质赋给 `part_*` 的 0 基槽位。先 plan 查看影响的所有共享使用者，再由 Tools 在租约下 apply。使用 Blender 实际节点接口与版本，不猜 socket 名称，不对未知值填零。

`sampleSrgb8` 只描述参考像素，不能直接写入 `baseColorLinear`；roughness、metallic 或透明度仍为 unknown/candidates 时跳过该步骤并列 blocker。临时白模或占位材质需要明确许可，并标记占位字段与影响；不得取候选第一项假装确定。

这些 op 不执行 UV 展开、纹理烘焙、图像导入、任意 shader 连线或复杂 PBR 推断。规划接缝、重叠许可和目标密度可以保留为提案，但需要专业 op 时明确阻塞，不使用 Python/外部路径回退。删除共享材质也不在覆盖内。

## 输出

输出 `version=1.0.0` 的阶段结果，含 briefId、stageId、specRef、boundObjectIds、带 stepId/opVersion 的 material ops 提案、checks、dependencies 与 blockers。附每个材质的确定值/候选来源、共享使用者、槽映射及纹理引用清单。已执行结果另附 job、节点读数和 checkpoint，不把提案当成回执。

## 下一阶段门槛

| 指标 | 单位 | 来源与容差 | 所需证据 |
| --- | --- | --- | --- |
| 参数与赋槽 | 0–1 无量纲/槽索引 | 已确认规格及其 tolerance；槽计数容差 0 | 独立读回 shader 参数、材质槽和共享使用者 |
| UV 重叠与拉伸 | %/比值 | brief 的重叠许可与上限 | UV 层检查、棋盘格标准照明图 |
| 像素密度与纹理量 | px/m、bytes | brief 目标及预算 | UV 量测与图像清单/摘要 |
| 材质外观 | 评审或像素差指标 | 用户确认标准和相机/照明/色彩管理 | 独立标准照明图与评审记录 |

当前 UV/纹理缺能力时相应检查 unknown；不需 UV 的纯色已确认材质可独立过门槛。光照与涂层可相互解释时分别建候选并取补充证据。材质参数通过不替代外观评审，外观相似也不替代节点数值断言。
