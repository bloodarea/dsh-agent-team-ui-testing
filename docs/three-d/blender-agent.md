# Blender Agent 工具与 Skill

`three-d` 环境在 `blender` 运行环境下向 Agent 提供 13 个 `blender_*` 工具与一个随插件发布的 Director Skill。工具面与调试视图的纯视口共用同一个工作区 Blender 实例。

## 启用条件

| 开关 | 配置字段 | 未启用时的表现 |
| --- | --- | --- |
| 3D 视图总开关 | `environments.three-d.enabled` | 不声明任何 `blender_*` 工具 |
| Blender 运行环境 | `environments.three-d.providers.blender.enabled` | 同上，且不披露 Blender Skill |

两个开关都打开、且当前会话解析到 `three-d` 环境时，工具才进入模型请求。留在 Web 环境或关闭任一开关时，请求里不会出现 Blender 专用 schema；准入在执行期再校验一次，不只依赖注册时的判断。

配置改动立即生效；**注册代码改动需要重载 DSH 插件**。

## 工具与分组

`blender_tools` 与 `blender_capabilities` 始终可见，其余按组披露，组内自动附加 `blender_job`。

| 分组 | 工具 |
| --- | --- |
| `project` | `blender_project`、`blender_control`、`blender_job` |
| `scene` | `blender_scene_query`、`blender_scene_apply`、`blender_spec_apply`、`blender_control`、`blender_job` |
| `view` | `blender_view`、`blender_capture`、`blender_control`、`blender_job` |
| `reference` | `blender_reference_analyze`、`blender_spec_revision`、`blender_job` |
| `verify` | `blender_verify`、`blender_capture`、`blender_job` |
| `jobs` | `blender_job` |

`blender_tools` 的 `action` 只有 `status`、`activate`、`reset`：先 `activate` 需要的能力组，下一步请求才会带上对应工具。

## 可用范围（当前）

| 工具 | 已实现 | 说明 |
| --- | --- | --- |
| `blender_tools` / `blender_capabilities` | ✅ | 冷态可读；`blender_capabilities` 只用 `blender --version` 探测，不启动 GUI |
| `blender_control` | ✅ | `status` 签发进程内 challenge；`acquire`/`renew`/`release` 推进 `controlRevision` |
| `blender_project` | 部分 | `list`、`status`、`save` 可用；`open`/`reload`/`saveAs`/`close` 不可用 |
| `blender_scene_query` | ✅ | `kind=scene`，只读 |
| `blender_scene_apply` | ✅ | 先 `mode=plan` 再 `mode=apply`，每批 ≤32 个 op |
| `blender_spec_apply` | ✅ | 消费已验证的 Scene Specification，编译成受控 op |
| `blender_view` | ✅ | `get` 读回；`set` 支持 `rotation`、`distance`、`projection` |
| `blender_spec_revision` | ✅ | `create`/`get`/`commit` |
| `blender_reference_analyze` | ✅ | CPU basic：归一化、ROI、像素读取；结果进 ArtifactStore |
| `blender_verify` | ✅ | 首批断言，逐条 `pass|fail|unknown`，聚合可为 `inconclusive` |
| `blender_job` | ✅ | `status`/`result`/`cancel`，进程内 JobStore |
| `blender_capture` | 部分 | `source=agentView` 可用（同实例取帧并发布到 ArtifactStore）；`humanView`/`checkpoint`/`sequence` 不可用 |
| `blender_project` 的 `open`/`reload`/`saveAs`/`close` | ❌ 不可用 | `saveAs` 需改路径的 runtime 命令，而 runtime 只支持保存到已绑定路径；`close` 缺安全的关闭路径 |

`blender_capabilities` 返回的 `declaration.unavailableActions` 就是上表的不可用项，与实际行为一致：

- 注入 storage 与 agentView capture 时：`project.open`、`project.reload`、`project.saveAs`、`project.close`、`capture.humanView`、`capture.checkpoint`、`capture.sequence`。
- 未注入这些服务时：上述项外加 `spec_revision.create/get/commit`、`spec_apply.artifact`、`reference_analyze`、`capture`、`verify`。

## 保存语义

`blender_project save` 的链路是「项目写授权与租约 → 磁盘 SHA-256 与 `expectedFileHash` 比对 → 调用 runtime 的 `project.save` → 校验 `saved:true` → 重读磁盘哈希」。哈希不符返回 `PROJECT_CONFLICT` 并携带双方哈希，此时**磁盘文件不会发生任何字节变化**。写后复核失败时保留 dirty 状态并标 `effectState=unknown`，同一 `idemKey` 重试不会重复写入。

原子性由 Blender 自身的 `save_as_mainfile` 保证。Node 侧只做比对、授权、校验与复核，**不提供针对外部写入者的原子 CAS**，也没有用「临时文件 + rename」伪造原子性。

保存需要权威的绑定路径：`runtime.status()` 返回只读的 `projectPath`（未绑定或断开时为 `null`），拿不到路径时 `save` 直接 fail closed 返回 `CAPABILITY_UNAVAILABLE`，而不是假装保存成功。

## 数值校验

非有限数（`NaN`/`±Infinity`）与非单位四元数在**两层**都被拒绝：

- **Schema 层**：Ajv 实例保留 `strict:false`，但显式开启 `strictNumbers:true`；`quatWxyz` 挂载自定义 keyword `unitQuaternion`，使 `validateOperation` 直接拒绝非单位四元数。
- **工具入口层**：`assertBlenderInput` 对 scene plan/apply 的 `object.transform.rotation` 与 `view.set.rotation` 做范数校验（容差 `1e-4`），失败抛 `SCHEMA_INVALID` 且 `details.instancePath` 精确指向旋转字段。

`[1,0,0,0]` 与 `[0,0,0,1]` 这类合法单位四元数正常通过；`1e-4` 边界按 `abs(‖q‖-1) <= 1e-4` 判定。

## 写入前置

所有写操作同时校验两条独立路径：

- `grantId`：由 `blender_control status`（或 `acquire`）签发，绑定会话、工作区、目标、资源与过期时间；跨目标、跨资源、跨工作区或过期一律拒绝。
- `leaseId`：`acquire` 返回，绑定 resource 与 owner，带 `controlRevision`。

其余守卫：`targetId`/`generation` 身份、`expectSceneRevision`（视图写用 `expectViewRevision`）、`expectControlRevision`、1–128 字节 `idemKey`。同一 `idemKey` 同参重放返回原结果，异参返回 `IDEMPOTENCY_CONFLICT`。

**当前局限：** grant 是进程内自签发，没有人工审批环节，也不跨环境持久化；插件重载后所有 grant 与 lease 失效。

## 受控操作

工具只下发 `targets/three-d/agent_runtime.py` 注册的 8 个 op：`collection.ensure`、`object.ensure`、`object.parent`、`object.transform`、`mesh.primitive`、`object.remove`、`material.ensure`、`material.assign`。不实现任意 Python 执行。

Blender 侧只接受 6 个命令：`hello`、`scene.query`、`scene.apply`、`project.save`、`view.get`、`view.set`。8 个 op 只能装在 `scene.apply` 的 `payload.ops` 批量里提交，批量上限 32 项；`stepId` 与 `opVersion` 留在审计计划中，不下发到 Blender。

## Boss 级说明：Schema 单一来源

`schemas/blender/` 是唯一契约来源：13 个工具 × input/output、8 个 op、Scene Specification `1.0.0`、`manifest.v1.json`、`errors.v1.json`。加载器是 `tools/blender/schema.js`（Ajv 8，Draft 2020-12）；生成器是 `tools/blender/generate-schemas.mjs`，连续两次生成应得到 `changed=[]`。运行时入参校验、输出契约和工具声明都从这套定义派生。对于多动作工具，注册时把参数声明投影为对象根节点，并在字段说明中注明适用动作和必填条件，以兼容要求对象根节点的 OpenAI 兼容网关。工具执行时用原始 Schema 校验各动作的必填字段和字段组合。维护步骤见[工具参数声明与模型网关兼容性](../tool-parameter-schemas.md)。

## Skill

`skills/blender-director/` 随插件发布：

- `SKILL.md`：Director 入口，负责 brief、阶段计划与 checks，按资产类型路由到 Workflow。
- `systems/`：建模拓扑、修改器与 Geometry Nodes、UV 材质纹理、骨骼蒙皮动画、物理、灯光相机渲染、优化导出 QA。
- `workflows/`：人物、场景、道具。
- `catalog.json`：11 条资源，含 `requires`/`optional`/`pipelineIds`/`requiredOps`。

Skill 只产出 brief、操作提案与检查，**不拥有 Grant/Lease**，不直接写 Blender，不绕过工具。所有实时写入必须 `plan → apply` 并在租约下执行。`catalog.json` 的 `requiredOps` 只引用上面 8 个已注册 opId；未实现的专业能力在对应 System 中显式写为阻塞项。

Skill 的可见性同样受两个开关约束：环境未启用、或 Blender 运行环境被单独关闭时，`list()` 与 `get()` 都不返回 `blender-director`。目录校验覆盖路径范围、软链跳转、重复 ID、依赖循环、未知 opId 与悬空 pipeline 引用。

## 错误码

写侧与运行时的语义码已登记到 `core/errors.js` 的分类表，调用方按 `code`/`category`/`retryable` 分支，不解析消息文本：

`AUTHORIZATION_REQUIRED`、`GRANT_INVALID`、`GRANT_EXPIRED`、`GRANT_SCOPE_MISMATCH`、`LEASE_REQUIRED`、`LEASE_LOST`、`BUSY`、`REVISION_CONFLICT`、`PLAN_STALE`、`IDEMPOTENCY_CONFLICT`、`PROJECT_DIRTY`、`PROJECT_CONFLICT`、`SCHEMA_INVALID`、`SEMANTIC_INVALID`、`UNSUPPORTED_SCHEMA_VERSION`、`PATCH_ID_CONFLICT`、`PATH_OUTSIDE_WORKSPACE`、`OUTPUT_LIMIT`、`OPERATION_TIMEOUT`、`WORKER_LOST`、`ASSET_DIGEST_MISMATCH`。

Blender 原生码按固定映射转译：`BLENDER_BUSY → BUSY`、`BLENDER_STALE_RUNTIME`/`BLENDER_STALE_FRAME → GENERATION_MISMATCH`、`BLENDER_VERSION_UNSUPPORTED`/`BLENDER_DEPENDENCY_MISSING`/`BLENDER_PROBE_FAILED → DEPENDENCY_MISSING`、`BLENDER_PROTOCOL_MISMATCH → WORKER_LOST`。

写操作返回 `effectState`：`none`（无效果）、`partial`（已提交部分步骤）、`committed`（已提交）、`unknown`（效果未知，禁止自动重放）。

## 可选视觉 Provider

除 Blender 工具面外，插件还把四个本地视觉模型接入为**可选 Provider**。它们只用于增强参考分析，**不是 Core 的依赖**：未安装、未启用或崩溃时，13 个 Blender 工具与 Skill 照常工作。

| Provider | 能力 | 许可 | 当前状态 |
| --- | --- | --- | --- |
| `vision.moge3`（MoGe-3 ViT-L） | 相对深度、表面法线、相机内参、点云 | MIT | 已接入，`quality: unverified` |
| `vision.sharp`（Apple SHARP） | 3D 高斯（3DGS） | 仅限非商业研究 | 已接入，`quality: unverified` |
| `vision.hyworld`（HY-WorldMirror-2.0） | 相对深度、法线、相机内外参、点云、3DGS | 腾讯混元（含地域与商用门槛） | 已接入，`quality: unverified` |
| `vision.spatiallm`（SpatialLM1.1） | 点云 → 结构化 3D 布局 | CC-BY-NC-4.0（不可商用） | 已接入，**smoke 失败**（输出 0 语义实体） |

**三条硬约束：**

1. **不硬耦合**：Provider 的 worker、权重路径与 Python 环境路径只存在于 `targets/three-d/providers/` 与 manifest 里；`tools.js`、`environment.js`、`index.js`、`skills/**` 都不 import 它们。import `providers/index.js` 不会加载权重、不会起子进程、不占显存。
2. **缺失即降级**：未安装报 `not-installed`，缺权重报 `DEPENDENCY_MISSING`，缺 Python 包报 `DEPENDENCY_MISSING`；这些都不影响 Core。
3. **路径可覆盖**：Python 可执行文件与模型根目录通过 `DSH_BLENDER_PYTHON` / `DSH_BLENDER_MODELS_ROOT` / `DSH_BLENDER_ENGINES_ROOT` 配置，manifest 只存权重摘要（`sha256` + `installedBytes`），不存权重复本。

**质量语义：** `availability`（现在能不能跑）与 `quality`（结果可不可信）是两个正交轴。已装入、已启用、adapter 存在即可 `available`；`quality` 只有在 smoke 与 conformance 都 `passed` 且有证据时才标 `verified`。降级原因写在 capability 的 `limitations` 与 `qualityTags` 里，不靠新增枚举值。

**实测资源门槛（RTX 4070 Ti 12 GiB）：** MoGe-3 峰值 VRAM 1.72 GiB；WorldMirror 六视角 @518 峰值 5.39 GiB；SpatialLM 峰值 5.11 GiB；**SHARP 峰值 6.90 GiB**。四个 Provider 必须串行运行，`maxConcurrency` 固定为 1。

## 相关文档

- [调试视图与交互](debug-panel.md)
- [Blender 运行时配置](blender-runtime.md)
- [环境定义与配置入口](../target-environments.md)
