# 适配器接口与接入

本文定义 TargetAdapter、CapabilityAdapter、P0Provider 的公共接口、配置与生命周期。具体平台的源码、注册和调用链见[目标环境实现](#3-目标环境实现)。

## 1. 职责与共同约束

### 1.1 三种适配器的分工

| 类型 | 回答的问题 | 负责的接口 | 边界 |
| --- | --- | --- | --- |
| **TargetAdapter** | 目标在哪里，当前能否连接和使用？ | 探测环境、创建目标会话；由会话发现、绑定和关闭目标 | 不定义工具操作的业务语义 |
| **CapabilityAdapter** | 这个操作是否受支持、是否获准执行，结果和证据是什么？ | 操作清单、操作状态、参数预检、操作执行 | 不自行发现或绑定目标，不改变组合根的执行分支 |
| **P0Provider** | 各种操作怎样共享采集、网络、显示空间、标注和目标数据？ | P0-A～E 数据服务与公共模型转换 | E 家族的 provider surface 只提供目标投影和租约原语；多目标生命周期由 TargetAdapter 的可选 `tabs` 服务承接 |

三者是三种职责不同的契约。一个工具操作使用哪些 P0 家族，由该操作的实现决定；普通点击不必经过全部 P0 家族。

**组合根**负责把三者与宿主服务连接起来：解析配置、注册和选择适配器、控制工具准入、决定队列与租约、注入平台执行句柄，并在调用结束后释放会话。在当前插件中，这些工作由 [Host 入口](../index.js) 与 [跨环境组合根](../integration/cross-environment.js) 协作完成。

### 1.2 三者使用统一的配置快照结构

Host 将全局、工作区和会话配置解析为不可变的 `ConfigSnapshot`。会话选择优先于继承父会话的有效配置，再依次回退到工作区与全局。三种适配器从快照读取当前环境、允许的能力、目标和配置版本。各调用入口分别解析快照，统一结构不代表嵌套调用始终复用同一个对象或 revision；具体调用边界见 [Web 截图的调用链](web/adapters.md#44-一次使用-p0-的操作截图)。

| 字段 | 用途 |
| --- | --- |
| `revision` | 本次配置版本；会话创建时记录为 `configRevision` |
| `environment` / `adapterId` | 目标环境与适配器选择身份 |
| `enabledEnvironments` | 允许使用的目标环境集合 |
| `capabilities` | 当前环境获准使用的能力 id 集合 |
| `environmentConfig` | 当前目标环境的配置 |
| `targetId` | 配置选择的目标；未选择时为 `null` |
| `source` | 本次解析采用的配置来源与降级说明 |

设置页提交配置意图，Host 校验并以 `expectedRevision` 做 CAS 写入，返回新的权威 revision。执行入口需要校验快照与会话版本；发生不一致应报告 `CONFIG_STALE`。

Chrome 还使用 `provider`、`executionAdapterId`、`enabledProviders`、`providerConfig` 表示具体执行端，见 [Web 执行端的身份与代码位置](web/adapters.md#31-身份与代码位置)。这些浏览器取值不属于其他目标环境必须照搬的接口语义。

### 1.3 状态与证据约束

工程支持和现场可用性分别报告：

| 字段 | 取值 | 回答的问题 |
| --- | --- | --- |
| `support` | `supported` / `unsupported` / `planned` | 工程上是否提供实现？ |
| `availability` | `available` / `unavailable` / `not-probed` / `busy` | 当前是否可以使用？ |

`probe()` 的六轴报告使用 `axes.<name>.status`，其中能力轴还可表达 `partial`。它与 `operationStatus()`、`familyStatus()` 的 `support/availability` 不是同一返回结构，不能互相替换。

适配器调用成功返回 `{ value, evidence }`。证据 envelope 的公共字段是：

```text
version / scope / session / target / generation /
configRevision / operation / source / capturedAt
```

字段定义见 [证据模型](../core/evidence.js) 与 [P0 模型](../core/p0.js)。缺失必需字段应报告 `EVIDENCE_INCOMPLETE`；没有观测到的值不得编造。不同目标、不同代次或不兼容的几何映射不能直接复用引用与比较证据。

## 2. 三种抽象接口

以下签名用于说明现有 JavaScript 对象的调用约定；类型名代表下文说明的数据结构。

### 2.1 TargetAdapter：环境探测与目标会话

```text
TargetAdapter {
  manifest: {
    contractVersion, id, class: "target", environment,
    displayName, capabilities, dependencies, visibility
  }
  probe({ scope, snapshot, signal }) -> Promise<ReadinessReport>
  createSession({ scope, snapshot, signal }) -> Promise<TargetSession>
  tabs?: TargetTabs  // 可选的跨环境多目标管理入口，见 multi-tab.md
  dispose() -> Promise<void>
}

TargetSession {
  sessionId, environment, scopeId, configRevision
  generation, target, closed
  listTargets({ signal }?) -> Promise<TargetIdentity[]>
  bind(targetId, { signal }?) -> Promise<TargetIdentity>
  close({ signal }?) -> Promise<void>
  dispose() -> Promise<void>
}
```

`manifest.contractVersion` 当前为 `1`，三类适配器均需声明。注册器校验版本、类别和环境；版本不兼容时拒绝注册或解析，错误为 `ADAPTER_UNSUPPORTED`。同一环境只能注册一个 TargetAdapter。

**目标会话的语义：**

| 成员 | 约定 |
| --- | --- |
| `sessionId` / `scopeId` | 适配器会话身份与作用域；与 Agent 会话身份分别传递，不假设两者相等 |
| `configRevision` | 创建会话时消费的配置版本 |
| `generation` | 会话绑定代次；成功 `bind()` 后递增，用于识别绑定变化 |
| `target` | 当前绑定的目标身份，未绑定时为 `null`；目标身份也可以携带自身 generation |
| `listTargets()` | 返回本作用域可见的目标身份，不以空列表冒充探测失败 |
| `bind(targetId)` | 绑定已发现的目标；不存在时报 `TARGET_NOT_BOUND`，已关闭的会话不能继续使用 |
| `close()` / `dispose()` | 幂等关闭或释放会话；平台资源的实际关闭需要按该环境的生命周期接线 |

**会话与被测程序的生命周期分开。** 当前组合根为每次适配器调用创建 TargetSession，并在 `finally` 中 `dispose()`。结束一次调用不应自动关闭用户仍在使用的目标。连接、帧源和后台任务的实际所有者由平台实现确定，必须有明确的关闭与取消清理路径。

**`probe()` 返回六个独立轴：**

| 轴 | 检查内容 |
| --- | --- |
| `support` | 是否存在兼容的工程实现 |
| `enabled` | 当前配置是否允许使用 |
| `dependency` | 所需可执行文件或服务是否可用 |
| `connection` | 是否存在可证明身份的连接 |
| `target` | 是否绑定了期望的目标，身份是否仍一致 |
| `capability` | 各项所需能力的实际探测结果 |

报告携带 `environment`、`configRevision`、`checkedAt` 与 `axes`；各轴可以带 `reason`、`expiresAt`、`target`、`evidence`。探测应有超时，不能启动目标。未检测写 `not-probed`；冷态目标写 `unbound`。被禁用环境不做现场探测，版本未知时保留 `null`。

### 2.2 CapabilityAdapter：操作声明、准入与执行

```text
CapabilityAdapter {
  manifest: {
    contractVersion, id, class: "capability", environment,
    capabilities, operations
  }
  operationStatus({ session, snapshot }) -> {
    [operation]: { support, availability, reason, ... }
  }
  preflight(args, operation) -> PreflightResult
  invoke({
    operation, args, session, snapshot, signal,
    executionClass, context
  }) -> Promise<{ value, evidence }>
  dispose() -> Promise<void>
}
```

- **`operation`** 是该适配器声明的操作 id，映射到能力 id。各环境可以定义自己的名字；Web 使用 `browser_*`，不要求新平台复用这些名字。
- **`operationStatus()`** 报告操作的工程支持与可用性，不执行操作，也不以“有目标”代替每项能力的探测。
- **`preflight()`** 提供无副作用的参数预检接口；调用方负责安排调用，工具自身仍需做详细参数校验。非法参数应在相关 I/O、文件写入或输入派发前被拒绝。
- **`executionClass`** 描述本次调用的执行类别。组合根据此选择队列、目标启动与租约分支；适配器校验收到的类别，不能自行改走另一分支。
- **`context`** 是本次调用的平台上下文，可包含运行时句柄、调用方信息和动作元数据。派发时需要透传，不能只保留 `args/session/snapshot`。
- **`value`** 是操作结果，`evidence` 是适配器证据。面向 Agent 的最终工具返回形状仍由工具契约决定。

错误跨越适配器边界时，应保留可分类的错误码和 cause。尤其不能把 `NET_*`、`VISION_*`、`OUTPUT_*` 等平台错误统一压成 `INTERNAL`。

### 2.3 P0Provider：五个可选的数据家族

```text
P0Provider {
  manifest: {
    contractVersion, id, class: "p0", environment,
    families, capabilities
  }
  familyStatus({ session, snapshot }) -> {
    [family]: { support, availability, reason, ... }
  }
  capture?: { ... }  // A
  network?: { ... }  // B
  display?: { ... }  // C
  canvas?:  { ... }  // D
  targets?: { ... }  // E
  dispose() -> Promise<void>
}

family.method({ args, session, snapshot, signal, context, ... })
  -> Promise<{ value, evidence }>
```

| 家族 / surface | 共享的数据与服务 | 公共模型 |
| --- | --- | --- |
| **A / `capture`** | 截图、帧、图像校验与采集产物 | Frame 与采集结果 |
| **B / `network`** | 网络会话、事件、正文、控制、链路、证据与订阅 | NetworkEvent 与网络会话结果 |
| **C / `display`** | 显示空间与几何映射 | DisplaySpace |
| **D / `canvas`** | 画布标注文档 | AnnotationDoc |
| **E / `targets`** | 目标身份投影与租约 | TargetIdentity、Lease |

各家族的方法由具体 provider 声明；Web / Chrome 的方法清单和当前接线见 [Web P0Provider](web/adapters.md#34-chrome-如何实现-p0provider)。

家族可以缺省，方法也需要按实际实现判断。没有网络能力的平台可以将 B 报为 `support=unsupported`，其他家族继续工作；不能返回空事件伪装成“采集后没有流量”。

公共模型由 [P0 工厂与校验器](../core/p0.js) 定义，包括 Frame、NetworkEvent、DisplaySpace、AnnotationDoc、TargetIdentity 和 Lease。平台特有引用放在 `transportRef` 等明确的扩展位置。租约必须绑定 `targetId` 和整数 `generation`，获取、释放、查询必须各自执行对应语义。

**P0-E 与 TargetAdapter 的区别：** `targets.list()` 提供公共目标投影，租约方法管理访问原语；TargetSession 负责一次调用的发现、绑定与释放。多目标的列举、选择、创建、关闭及控制权管理，由 TargetAdapter 的可选 `tabs` 服务承接，复用平台已有的生命周期资源；P0Provider 不另起一套目标生命周期。

`tabs` 使用 [公共多目标接口](../core/target-tabs.js) 的 `createTargetTabs({ environment, handlers })`，暴露 `contractVersion/environment/actions/invoke(request, context)`。缺失 `tabs` 表示未接入多目标管理；服务只列出真实接线的动作，合法但缺失的动作报 `CAPABILITY_UNSUPPORTED`。公共层验证请求形状与动作所属字段，目标创建方式、`kind/source` 枚举、权限、资源限额和返回字段由环境实现决定。Web 标签页与未来 Blender 多实例可以实现相同管理职责，无需共用浏览器协议。完整请求与视图接口见[多标签页：公共接口与目标环境实现](multi-tab.md)。

## 3. 目标环境实现

- [Web 适配器实现与调用链](web/adapters.md)

<a id="5-接入与验证"></a>

## 4. 接入与验证

### 4.1 接入另一个目标环境时要补齐什么

Chrome 的可执行文件、CDP、DOM 和页面模型属于 Web 实现。新环境沿用三种接口的职责和证据约束，并提供自己的目标发现、操作语义与数据转换。

1. **定义身份和能力目录。** 在公共配置、契约与 registry 允许的环境集合中登记环境和能力 id，再声明平台自己的操作名与执行类别。当前环境和能力目录是显式登记的，不能只增加一个目录就自动接入。
2. **实现 TargetAdapter。** 提供 manifest、六轴探测与目标会话；明确平台资源所有权、绑定代次、关闭和取消清理。
3. **实现 CapabilityAdapter。** 提供操作映射、状态、预检和执行；为组合根提供可注入的执行边界。
4. **实现需要的 P0 家族。** 将平台数据转换成公共模型；缺失家族和未接线方法如实报告不支持。
5. **在组合根接线。** 注册三种适配器，补齐配置解析、工具注册与会话准入、执行分支、P0 派发和 Skill 发现；平台连接参数通过统一的配置快照结构传递。
6. **验证身份与资源边界。** 检查 revision、目标代次、证据、可选能力、取消与释放，再做真实平台的操作闭环。

[假环境实现](../targets/fake/adapter.js) 可用于对照接口与确定性契约验证。它不是实际平台，不能用假目标通过来证明真实平台可用，也不能用其单槽标注存储证明真实会话隔离。

### 4.2 验证入口

修改适配器实现时，按下列层次验证；命令与结果判读详见 [验证与贡献](verification.md)。

| 验证层次 | 命令 | 验证重点 |
| --- | --- | --- |
| 公共契约与适配器 | `node --test tests/contracts/*.test.mjs` | 配置、registry、P0、fake 与 Web 接口约束 |
| 跨环境组合根 | `node tests/acceptance/cross-environment.mjs` | 配置、六轴、GUI 准入与不启动浏览器的诊断 |
| 隔离与清理 | `node tests/acceptance/foundation-isolation.mjs` | 工具、Skill、证据、租约和生命周期约束 |

执行端配置、运行时路由和真实目标验收见各环境的验证指南。[Web 验证](web/verification.md)

新增或修改适配器后，至少运行契约套件与 `foundation-isolation`，再按涉及的能力运行真实目标验收。工程支持、依赖存在、连接成功与实际操作通过分别记录；未执行的检查保留为未验证。
