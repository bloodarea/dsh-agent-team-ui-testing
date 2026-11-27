# 修改器与 Geometry Nodes

```json
{"id":"modifiers-geometry-nodes","version":"1.0.0","requiredOps":[]}
```

## 输入

阶段 brief、规格片段与 JSON Pointer、已绑定对象 ID、原始网格 checkpoint、Blender 与 op 实际版本、目标 evaluated 几何、修改器栈顺序、节点树类型、socket 稳定标识/类型/版本及内存和面数预算。没有 typed socket 的名称猜测不能成为连线依据。

## 操作与边界

当前 8 个受控 op 不提供修改器或 GN 写入能力；`requiredOps=[]` 表示本系统仅能形成方案，**不表示无依赖可执行**。先在 `blender_capabilities` 核对目标能力；缺失时把栈编辑、节点组和连线逐项列为 blocker，保存源网格及配方参数说明。不输出伪造的可执行 opId，不直接运行 Python、节点脚本或 shell。

规划时写明各修改器用途、顺序、输入输出与可恢复边界；对节点明确数据类型、单位、依赖与 evaluated 输出预算。检查潜在依赖环、失效 socket、共享节点组和资源引用。不得为了绕过缺能力而破坏性应用整个栈或把用户工程替换为离线生成网格。仅当运行时目录明确给出等效已注册路径时，才由 Director 重新 plan，并在租约下 apply。

## 输出

输出 `version=1.0.0` 的阶段提案，含 briefId、stageId、specRef、boundObjectIds、空的执行 `proposal.ops[]`、类型化栈/节点配方、checks、dependencies 与 blockers。任何建议中的未来操作留在 limitations，不混入可执行 ops。

## 下一阶段门槛

| 指标 | 单位 | 来源与容差 | 所需证据 |
| --- | --- | --- | --- |
| socket 类型与依赖环 | 个错误 | 运行时树接口版本；错误 0 | 独立重读的节点/连线和接口版本 |
| evaluated 尺寸与轮廓 | m/px | brief 或规格容差 | evaluated 几何边界和固定视角图 |
| evaluated 网格量 | triangles | brief 上限 | 原始/求值统计对照 |
| 内存与求值成本 | bytes/ms | 用户预算 | 作业资源读数、配方版本 |

缺必需专业 op 时上述写入结果保持 unknown，阻塞依赖该结果的后续阶段；允许交付原语白模须单独记录用户接受的范围。类型错误修配方，轮廓异常先定位栈中的最早失效步骤。
