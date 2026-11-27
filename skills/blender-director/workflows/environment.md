# 场景 Workflow

```json
{"id":"environment","version":"1.0.0","requiredOps":[]}
```

## 输入与输出

输入为 `assetType=environment` 阶段 brief、规范化空间/约束规格片段与 specRef、参考和尺度锚点、动线/可达性、模块网格、镜头、预算、已绑定对象 ID 与实际 op 版本。建筑净空与模数来自用户/规格，不把经验尺寸当成本项目硬约束。

输出为 `version=1.0.0` 的阶段 DAG、版本化操作提案、验收断言、发现的依赖/限制、资产清单和 checkpoint。沿用 Director 的 briefId/stageId/boundObjectIds/proposal/checks/dependencies/blockers 合同。空 requiredOps 由 System 依赖展开；通过 Tools 先 plan、核对工程版本与影响，再在租约下 apply，不直接写 Blender。

## 阶段顺序与门槛

| stageId / needs | System 与产物 | 指标、单位、来源、容差与证据 |
| --- | --- | --- |
| reference-scale / 无 | 参考与尺度锚点 | m/px，来源为冻结图/已知尺度与 brief 公差；源摘要和标定证据 |
| spatial-blockout / reference-scale | modeling-topology，lighting-camera-render：空间、动线、模数组合与镜头白模 | 净空/拼缝 m、遮挡 %、构图 px，按规格/brief 公差；世界几何读回与固定镜头图 |
| assets / spatial-blockout | modeling-topology，按需 modifiers-geometry-nodes：部件、模块与实例方案 | 模块 m、实例个数、triangles，按 brief 网格与预算；层级与独立枚举 |
| surface-light-camera / assets | uv-material-texture、lighting-camera-render：材质、灯光、相机配方 | px/m、材质参数 0–1、构图 px，按规格/brief 容差；标准照明图、参数和相机证据 |
| render-export / surface-light-camera | optimization-export-qa：渲染或目标格式与工程 | bytes/triangles/m/degree，按交付要求与预算；持久摘要、独立重开和固定引擎图 |

所有 stage 使用 checks 的 pass|fail|unknown 三值；只有前置硬检查 pass 或用户明确接受受限范围才推进。装饰与布景不能替代空间净空检查。几何重复不等于链接实例，重开后需重新读取实例数和引用。

## 能力缺口与返修

当前受控原语可表达有限空间白模，已确认纯色参数可走材质 System；实例、GN、UV、灯光、作品相机编译、渲染和导出缺已注册能力时逐项阻塞。Scene Specification 保留的 relations/surfaces/depths/constraints 不自动变成几何或修改器，不允许静默忽略。

动线、硬净空、可达性失败返回 spatial-blockout；拼缝/资产链接失败返回 assets；构图异常先核对镜头与遮挡，再定位几何。缺标定或独立图的视觉结论 unknown，不通过增加布景遮住失败项。只交白模时明确保留哪些空间约束、尚缺哪些外观和格式能力。
