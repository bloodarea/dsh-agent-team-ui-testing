# 人物 Workflow

```json
{"id":"character","version":"1.0.0","requiredOps":[]}
```

## 输入与输出

输入为 `assetType=character` 阶段 brief、目标用途/风格/视角、规范化规格片段与 specRef、单位/体高、参考图、变形与动作需求、预算、已绑定对象 ID 和实际 op 版本。缺侧视的厚度、遮挡结构和面部特征保留候选。

输出为 `version=1.0.0` 的阶段 DAG、有版本操作提案、各阶段验收断言、发现的依赖/限制和中间 checkpoint。沿用 Director 的 briefId/stageId/boundObjectIds/proposal/checks/dependencies/blockers 合同。Workflow 的空 requiredOps 由所选 System 的真实依赖展开，不直接写 Blender；执行一律通过 Tools plan → 租约下 apply。

## 阶段顺序与门槛

| stageId / needs | System 与产物 | 指标、单位、来源、容差与证据 |
| --- | --- | --- |
| reference / 无 | 参考、单位、风格和视角 brief | 尺度 m、视图 px；来源为用户或冻结参考，容差来自 brief；保留来源摘要、未知和候选 |
| blockout / reference | modeling-topology：比例与剪影白模 | 标志点/体高归一化比值与轮廓 px，按 brief 公差；同画幅参考与独立白模图、局部/世界尺寸 |
| body-topology / blockout | modeling-topology，按需 modifiers-geometry-nodes：身体、服装和变形环线方案 | 拓扑异常个数、triangles 预算、服装间隙 m；按动作需求/brief 公差，需网格统计与指定姿态证据 |
| surface / body-topology | uv-material-texture：UV、已确认材质与纹理方案 | px/m、重叠 %、材质 0–1 参数；按 brief/规格容差，需 UV 检查、节点读数和标准照明图 |
| rig / surface | rig-skin-animation：rest pose、骨骼与蒙皮；仅需要时进入 | 关节 degree/m、权重和无量纲，按绑定标准公差；独立层级/权重与 rest/pose 证据 |
| motion / rig | rig-skin-animation，按需 physics：典型动作 | frame/degree/m，按 brief 动作窗公差；FCurve/帧采样与保留姿态图 |
| delivery / surface，以及选用的 motion | optimization-export-qa：可编辑工程/目标格式与审查 | triangles、bytes、m、轴向 degree；按交付预算，独立重开、外链/材质解析和持久摘要 |

`needs` 是显式 DAG，静态角色省略 rig/motion 并将 delivery 依赖 surface；不能保留悬空阶段引用。只有前置必需 checks 为 pass 或用户明确接受受限交付范围才前进。检查字段统一为 metric/unit/source/tolerance/observed/evidenceIds/verdict，verdict 仅 pass|fail|unknown。

## 能力缺口与返修

当前原语与材质 op 可支撑有限白模/纯色材质；雕刻、重拓扑、UV、建骨、蒙皮和关键帧没有对应受控 op 时必须阻塞相应阶段，保留白模和方案。不能把静态 parent/transform 当成绑定动画完成。

比例不符返回 blockout；变形异常先定位身体结构、拓扑或权重，再修对应阶段并重新采样有关动作窗口。风格比例没有统一人体头身数阈值，以用户确认的 brief 为准。缺独立姿态证据的变形结论是 unknown；只有 brief 要求绑定或动画时才将其列为最终发布必需门槛。
