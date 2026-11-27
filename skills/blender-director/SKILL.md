---
name: blender-director
description: Blender 资产制作与修订入口：把参考图、尺寸和交付目标整理为版本化 brief，按人物、场景、道具流程选择专业 System，使用 blender_tools 与 blender_capabilities 核对能力，经 blender_scene_apply 或 blender_spec_apply 先 plan 后 apply，并以 blender_scene_query、blender_verify 和独立产物逐项验证。适用于建模、材质、桌灯等道具、工程保存、参考图匹配和交付检查；缺能力或证据时明确阻塞与 unknown。
---

# Blender Director

## 何时使用与边界

用于 `environmentId=three-d`、`providerId=blender` 的资产规划、制作、修订与交付。`list()` 只给入口摘要；`get()` 在同一作用域再次验证环境和 Blender provider 双开关，返回正文与目录型 `resourceBase`。禁用任一开关或选择其他环境时不可发现、不可加载。有效环境内未连接 Blender 也可读取手册，但读取成功不证明工具可执行。旧宿主无 Skill provider API 时保留 Web 回退，不注册全局 Blender 入口。

Skill 只产出 brief、操作提案与检查，**不拥有 Grant/Lease**，不直接写 Blender、不绕过 Tools、不自动扩权。所有实时写入必须 **plan → apply**，由工具核验授权、租约、目标身份和版本。不得执行模型生成的 Python、工程文本块、任意脚本、shell 或内部 HTTP 路由；`script.run` 不属于可用执行路径。

## 按需加载与路由

先读 [catalog.json](catalog.json) 的 `version` 与 `entries[]`，再读所选 Workflow 和当前阶段需要的 System，避免一次加载所有正文。只接受目录内的已登记相对路径，不根据用户提供的 locator 或路径穿越打开资源。

- `requires[]` 是资源依赖 DAG；先加载必需条目。`optional[]` 只在 brief 要求时加载，可以互相提示，不形成执行依赖。
- `pipelineIds[]` 是本目录中的 Workflow ID（`character`、`environment`、`prop`），用于路由，**不是**运行时图像算法或脚本 ID。
- `requiredOps[]` 为 `{opId,minOpVersion}`。逐项与运行时能力目录核对版本和可用性；目录闭合不证明对应平台可执行。空数组仅表示该条目无可直接执行的已注册专业 op，不代表完整专业能力已经实现。
- System/Workflow 的首个 JSON 块是版本化资源元数据。输出使用同版本的数据合同；能力限制必须带回 Director。

| 任务 | Workflow | 按需专业资料 |
| --- | --- | --- |
| 人体、服装、角色、姿态 | [character](workflows/character.md) | [建模拓扑](systems/modeling-topology.md)、[UV 材质纹理](systems/uv-material-texture.md)、需要时读 [骨骼蒙皮动画](systems/rig-skin-animation.md) |
| 房间、建筑、模块与布景 | [environment](workflows/environment.md) | 建模拓扑、UV 材质纹理、[灯光相机渲染](systems/lighting-camera-render.md) |
| 桌灯、家具、器械、独立资产 | [prop](workflows/prop.md) | 建模拓扑、UV 材质纹理、[优化导出 QA](systems/optimization-export-qa.md) |
| 修改器、程序化系统 | 资产所属 Workflow | [修改器与 Geometry Nodes](systems/modifiers-geometry-nodes.md) |
| 模拟、碰撞、缓存 | 资产所属 Workflow | [物理](systems/physics.md) |

复合任务拆为独立资产 brief，显式声明共用材质、对象与交付依赖。人物绑定、场景实例化、UV、物理、GN 或导出能力若不在当前目录可用范围，保留方案与中间产物，不宣布已完成。

## 最短执行流程

1. **锁目标与输入**：读取用户目标、用途、单位、尺寸、近远镜头、目标格式、预算、现有工程及允许修改范围。参考图冻结为授权资产引用，保留摘要、来源、像素/裁切映射。可从工程读取的事实先读取，设计决策不从图像猜成确定值。
2. **探能力**：用 `blender_tools` 选择本阶段需要的组，下一步确认实际收到的 schema；用 `blender_capabilities` 读取状态、op 版本、平台、预算及依赖。仅注册、声明或存在手册不能替代 `available` 与实际执行证据。
3. **生成 brief**：输出下节结构，路由 Workflow，并列出未知、候选和待确认字段。关键设计约束缺失时先处理；允许时继续不依赖该项的阶段。
4. **建立基线**：经 `blender_project` / `blender_scene_query` 读工程身份、generation、sceneRevision、稳定对象 ID 与受管摘要。既有工程优先增量修改；用户名称不充当对象 ID。
5. **提案并 plan**：对规范化 Scene Specification 使用 `blender_spec_apply`；显式受控操作使用 `blender_scene_apply`。绑定 `sceneId/specRevision/specHash`（适用时）、target、generation 和预期 revision。读回影响集合、共享材质使用者、预算、不可编译字段与 planId，拒绝静默丢弃字段。
6. **在租约下 apply**：通过 `blender_control` 取得允许的控制状态，使用工具返回的真实 Grant/Lease 和预期控制版本提交原计划。不得自行构造或借用其他工作区的 token。删除需专属删除权限和一次性 approval grant。
7. **读回并独立验证**：经 `blender_job` 对账作业，`blender_scene_query` 核对实际值，按需用 `blender_capture`、`blender_verify` 或保存后的独立重开产物检查。派发成功、作业成功和数值/视觉断言通过是不同事实。
8. **过门槛再交付**：依赖 DAG 的前置硬检查均为 pass 才推进；fail 返回最早失效阶段，unknown 补证据或记录用户接受的受限范围。最终收集工程/导出产物、摘要、规格版本、独立证据与未决项。

## Brief 与阶段输出合同

Director 必须交付以下字段；可选 `specRef` 与 `projectRef` 不存在时省略，不伪造哈希或 revision。

```json
{
  "briefId": "brief_asset",
  "assetType": "prop",
  "goal": "用户确认的目标",
  "budgets": {"triangles": null, "textureBytes": null, "durationMs": null},
  "deliverables": [{"kind": "project", "format": "blend"}],
  "acceptance": [],
  "assumptions": [],
  "stages": [
    {
      "stageId": "blockout",
      "needs": [],
      "systemIds": ["modeling-topology"],
      "requiredOps": [{"opId": "mesh.primitive", "minOpVersion": 1}],
      "inputs": [],
      "outputs": [],
      "checks": [
        {"id": "dimensions", "metric": "length", "unit": "m", "source": "brief", "expected": null, "tolerance": null, "observed": null, "evidenceIds": [], "verdict": "unknown"}
      ]
    }
  ]
}
```

- `assetType` 是 `character|environment|prop`。未分类先记录待分类假设；不要启动错误 Workflow。
- `specRef={sceneId,revision,artifactId,sha256}`；`projectRef` 引用工具给出的工程/checkpoint，不填个人绝对路径。预算未知为 `null` 并附待确认项，不能记作 0。
- `stageId` 唯一；`needs[]` 只能指向同 brief 的前置阶段且无环。`checks[].verdict` 只能为 `pass|fail|unknown`。每个检查给指标、单位、来源、容差与证据；主观审美给评审主体和依据，不能冒充机械量测。
- System 输出统一为 `{version,briefId,stageId,specRef?,boundObjectIds[],proposal:{ops:[],limitations:[]},checks[],dependencies[],blockers[]}`。每个 op 带 `stepId,opId,opVersion,args`，提案不是执行回执。
- 规格变更先经 `blender_spec_revision` 提交并读回新 revision/hash，再重做受影响计划；不能在旧 plan 上替换参数。

## 已注册操作与提交语义

受控 op 仅有 `collection.ensure`、`object.ensure`、`object.parent`、`object.transform`、`mesh.primitive`、`object.remove`、`material.ensure`、`material.assign`。`mesh.primitive` 只用能力目录确认的 `box/cylinder/frustum`；`obj_*` 为 assembly Empty，`part_*` 为独立 Mesh，`mat_*` 为材质，均使用持久稳定 ID。局部 TRS 在 parent 后设置，四元数 WXYZ；父级逆矩阵遵守编译器合同。

公开 `blender_scene_apply` 的请求使用 `action:"apply"`、`mode:"plan"|"apply"` 与 `ops:[{stepId,opId,opVersion,args}]`，其余必填项以实际 schema 为准。将一批限制在不超过 32 项，且满足更低运行时预算；跨批依赖逐批读回，不承诺全工程事务回滚。Runtime 的 `scene.apply` 只接受 `payload.ops` 批量形状，不能把 8 个 opId 当作 Runtime 单命令直发；Agent 始终通过公开 Tools 提交。

未知材质参数保持 unknown/candidates；像素 `sampleSrgb8` 不等于线性物理 Base Color。只有明确批准才可使用占位材质，并列出占位和影响。重复 stableId、content hash 不符、非受管子对象或受管集合越界时停止，不接管用户数据。

## 参考图与证据门槛

先统一画幅、镜头和主形，再做细节。缺已标定镜头时，厚度、遮挡结构、光照与涂层的多种解释分别保留；相机编译能力不足则阻塞该步骤，不以改几何补偿错误透视。ROI、裁切及金字塔结果须能映射回原图坐标。

T1/T2 结构与量测、T3 静帧和 T4 过程证据按问题选择，不要求机械逐层爬升。静态桌灯不强行进入物理/动画。几何通过不推出材质通过；无独立图、mask、相机标定或持久证据的视觉指标为 unknown。通用阈值来自本任务 brief，桌灯特定示例见 Prop Workflow，不能当成所有资产的通用阈值。

## 错误与恢复

| 观测/错误 | 处理 |
| --- | --- |
| provider 禁用、未连接、缺依赖或 op 不可用 | 记录具体依赖与能力状态，保存 brief 和提案；不得用 shell/Python 绕过 |
| `REVISION_CONFLICT`、过期 target/generation、用户接管 | 停止写入；重读身份、控制与版本，在新基线重算 plan，按需重新申请授权/租约 |
| 超时、取消、响应丢失、执行结果 unknown | 先按作业/幂等键对账已提交前缀，不盲目重发、杀进程或宣称回滚 |
| 几何、材质或独立重开断言失败 | 定位最早失效阶段；仅修复相关对象与字段，重验所有受影响检查 |
| 证据不完整或未测 | 对应检查 unknown，报告已完成范围与补证路径 |

## 与预设团队交接

需要视觉或专业评审时输出 `{briefId,task,assetRefs[],specRef?,questions[],checks[],expectedOutput}`。只交付已授权图像、标准化元数据与证据引用；建议须引用基线 revision、具体 JSON Pointer 和替代解释。预设团队决定角色、模型和调度，专家不会因此拥有工程租约或扩大授权。返回的 scene/patch/审查意见仍需同样的 schema、语义、权限检查；认可的修订先提交规格再编译。并发冲突在新基线重算。缺顾问时保留候选，继续未阻塞阶段。
