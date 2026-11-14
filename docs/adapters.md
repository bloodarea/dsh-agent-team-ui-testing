# 适配器接口与接入

本文先定义 TargetAdapter、CapabilityAdapter、P0Provider 的公共接口，再以 **Web 目标环境下的 Chrome** 说明三者如何实现、如何注册，以及一次工具调用怎样到达 Chrome 页面。面向新增目标环境适配器的贡献者，以及维护组合根与运行时的开发者。

阅读顺序：

1. [职责与共同约束](#1-职责与共同约束)：三种适配器分别解决什么问题。
2. [三种抽象接口](#2-三种抽象接口)：调用方可以依赖哪些成员和返回值。
3. [Web / Chrome 的实现](#3-web--chrome-的实现)：抽象接口如何对应到现有代码。
4. [Chrome 的注册与调用链](#4-chrome-的注册与调用链)：配置、注册、工具准入和执行如何连接。
5. [接入与验证](#5-接入与验证)：扩展环境时需要补齐哪些部分。

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

Host 将全局、工作区和会话配置解析为不可变的 `ConfigSnapshot`。会话选择优先于继承父会话的有效配置，再依次回退到工作区与全局。三种适配器从快照读取当前环境、允许的能力、目标和配置版本。各调用入口分别解析快照，统一结构不代表嵌套调用始终复用同一个对象或 revision；具体调用边界见 [§4.4](#44-一次使用-p0-的操作截图)。

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

Chrome 还使用 `provider`、`executionAdapterId`、`enabledProviders`、`providerConfig` 表示具体执行端，见 [§3.1](#31-身份与代码位置)。这些浏览器取值不属于其他目标环境必须照搬的接口语义。

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

各家族的方法由具体 provider 声明；Web / Chrome 的方法清单和当前接线见 [§3.4](#34-chrome-如何实现-p0provider)。

家族可以缺省，方法也需要按实际实现判断。没有网络能力的平台可以将 B 报为 `support=unsupported`，其他家族继续工作；不能返回空事件伪装成“采集后没有流量”。

公共模型由 [P0 工厂与校验器](../core/p0.js) 定义，包括 Frame、NetworkEvent、DisplaySpace、AnnotationDoc、TargetIdentity 和 Lease。平台特有引用放在 `transportRef` 等明确的扩展位置。租约必须绑定 `targetId` 和整数 `generation`，获取、释放、查询必须各自执行对应语义。

**P0-E 与 TargetAdapter 的区别：** `targets.list()` 提供公共目标投影，租约方法管理访问原语；TargetSession 负责一次调用的发现、绑定与释放。多目标的列举、选择、创建、关闭及控制权管理，由 TargetAdapter 的可选 `tabs` 服务承接，复用平台已有的生命周期资源；P0Provider 不另起一套目标生命周期。

`tabs` 使用 [公共多目标接口](../core/target-tabs.js) 的 `createTargetTabs({ environment, handlers })`，暴露 `contractVersion/environment/actions/invoke(request, context)`。缺失 `tabs` 表示未接入多目标管理；服务只列出真实接线的动作，合法但缺失的动作报 `CAPABILITY_UNSUPPORTED`。公共层验证请求形状与动作所属字段，目标创建方式、`kind/source` 枚举、权限、资源限额和返回字段由环境实现决定。Web 标签页与未来 Blender 多实例可以实现相同管理职责，无需共用浏览器协议。完整请求与视图接口见[多标签页：公共接口与目标环境实现](multi-tab.md)。

## 3. Web / Chrome 的实现

### 3.1 身份与代码位置

Web 是目标环境，Chrome 是该环境的具体执行端。一次选择 Chrome 的配置快照包含：

```js
{
  environment: 'web',
  adapterId: 'web',
  provider: 'chrome',
  executionAdapterId: 'web-chrome',
  // 另有 revision、capabilities、targetId 等公共字段
}
```

三种适配器按 Web 环境注册，执行时从快照解析 Chrome；不会按每个页面分别注册适配器。

| 角色 | 实现入口 | 对应 manifest 身份 |
| --- | --- | --- |
| TargetAdapter | [适配器模块](../targets/web/adapter.js) 的 `createWebTargetAdapter()`；可选 `tabs` 使用 [Web 多目标服务](../targets/web/tabs.js) | `id: "web"`、`class: "target"`、`environment: "web"` |
| CapabilityAdapter | [适配器模块](../targets/web/adapter.js) 的 `createWebCapabilityAdapter()` | `id: "web.capability"`、`class: "capability"`、`environment: "web"` |
| P0Provider | [P0 提供者模块](../targets/web/provider.js) 的 `createWebP0Provider()` | `id: "web.p0"`、`class: "p0"`、`environment: "web"` |
| 创建、注册与派发接线 | [跨环境组合根](../integration/cross-environment.js) | `createWebFaces()`、`invokeTool()`、`p0Call()` |
| Chrome 进程、页面与协议执行 | [Host 入口](../index.js) | `BrowserHost`、`RuntimeRegistry`、`Runtime` |

适配器通过注入接口访问运行时：TargetAdapter 使用 registry，CapabilityAdapter 使用 dispatch，P0Provider 使用 p0Dispatch。实际 Chrome/CDP 操作保留在 Host 运行时中。

### 3.2 Chrome 如何实现 TargetAdapter

`createWebTargetAdapter({ registry, capabilityAvailability, ... })` 将抽象目标模型映射到现有页面运行时：

1. **探测依赖与现场状态。** `probe()` 根据 Chrome 的可执行文件候选与 `DSH_UI_TESTING_CHROME` 覆盖检查依赖，并从现有运行时读取连接和目标状态；它不启动 Chrome。
2. **创建簿记会话。** `createSession()` 校验 scope，调用 `resolveWebDriver(snapshot)` 确认执行端，记录 `provider: "chrome"`、`executionAdapterId: "web-chrome"` 和配置 revision。
3. **发现页面目标。** `listTargets()` 从注入的 RuntimeRegistry 收集本 scope 的条目，转换成 `kind: "page"` 的目标身份。
4. **绑定目标。** `bind(targetId)` 在这些身份中查找目标，更新 `session.target` 并递增会话 generation。目标身份的 generation 与会话绑定计数分别保留，不能混当成同一个值。
5. **释放调用会话。** 当前 Web TargetSession 的 `close()` 标记会话关闭，`dispose()` 清理会话绑定；它们不会直接关闭 Chrome 页面。真实页面和连接由 Runtime 的关闭路径释放。

因此，`createSession()`、`bind()` 与“启动 Chrome、打开网页”是不同动作。真正需要页面的工具分支由 Host 调用运行时的 ensure 路径，按需启动 Chrome 并建立 CDP 连接。

Chrome 的厂商身份在连接后通过 `Browser.getVersion` 校验：取得的产品串应含 `Chrome/` 且不含 `Edg/`；当前 Chrome 路径在取得产品串时核对，取不到时不额外阻断。可执行文件缺失、覆盖无效或产品身份不符通过依赖错误与具体 reason 报告。

Web 的六轴探测还包括：

| 轴 | Chrome 实现中的证据 |
| --- | --- |
| `dependency` | Chrome 自己的可执行文件解析结果；未观测版本为 `null` |
| `connection` | 实际页面传输连接；只有进程而没有页面 transport 时为 `not-probed / host-idle-no-transport` |
| `target` | 配置目标与当前目标的身份比较；不一致为 `stale / identity-mismatch` |
| `capability` | 结构读取、输入、网络采集器和帧源的逐项结果，明细在 `evidence.checks` |

### 3.3 Chrome 如何实现 CapabilityAdapter

`createWebCapabilityAdapter({ dispatch })` 使用两张声明表：

- `WEB_TOOL_OPERATIONS`：将 `browser_*` 操作名映射到 `web.t1`、`web.t2`、`web.t3`、`web.t4`、`web.network`、`web.tabs` 等能力 id。
- `WEB_TOOL_OPERATION_SPECS`：声明操作允许的执行类别；`resolveExecutionClass(operation, args)` 根据具体动作细分，例如 `browser_viewport get` 与 `set`。

当前 Web 执行类别为 `page | readOnly | hostOnly | networkRead | diagnostic | independentHttp | tabs`。其中 `page/tabs` 要求绑定目标；其余类别不会仅因为没有已绑定页面而被拒绝。类别的具体队列、ensure 与租约行为由 Host 工具包装层落实。

`operationStatus()` 按操作返回 `support/availability/reason`。`preflight(args, operation)` 校验参数对象形状并返回 `{ ok: true, executionClass }`，第二参数接受操作名或 `{ operation }`；各工具的字段、范围和互斥校验仍由工具实现负责。当前 `invokeTool()` 直接调用 `invoke()`，不会自动先调用适配器的 `preflight()`；工具包装层另有自己的预检入口。

执行 `invoke()` 时，适配器依次校验操作名、会话状态、Chrome 执行端、配置 revision、执行类别、目标绑定与能力准入，然后调用注入的 `dispatch()`。组合根的 dispatch 执行 `context.execute()`，也就是本次工具 handler。handler 再通过 Runtime 执行具体 CDP 操作。

适配器生成 `{ value, evidence }`；组合根另保留 `context.rawResult`，避免把 `browser_eval` 等工具原本就有的 `value` 字段误当成适配器包装而丢掉其他字段。

### 3.4 Chrome 如何实现 P0Provider

`createWebP0Provider({ p0Dispatch })` 创建五个家族 surface，执行支持性检查、基础参数校验、结果转换和证据封装。组合根注入的 p0Dispatch 从 `context.runtime` 取得本次操作的 Chrome 页面运行时。

| 家族 | Web provider 声明的方法 | 当前 Host 接线 |
| --- | --- | --- |
| A | `screenshot`、`capture`、`product`、`readFrame`、`validateImage` | `screenshot → runtime.screenshot()`；`capture → runtime.capture()`；`product → runtime.browserProduct()` |
| B | `start`、`stop`、`status`、`reset`、`events`、`detail`、`control`、`trace`、`evidence`、`subscribe` | 会话动作 → `netSession()`；事件、详情、控制、链路、证据、订阅 → 对应的 `net*()` 方法 |
| C | `read`、`set`、`transform` | `read → runtime.viewProjection()`；`set → runtime.applyView()` |
| D | `annotationRead`、`annotationWrite` | `annotationRead → runtime.annotationsDocument()`；`annotationWrite → runtime.acceptAnnotations()` |
| E | `list`、`leaseAcquire`、`leaseRelease`、`leaseStatus` | `list → registry.listTabs()`；租约方法 → 组合根的 `leaseFamily()`，读取或操作真实 Runtime 租约 |

**声明方法与实际接线要分别看。** Web provider 的方法表还列有 `A.readFrame`、`A.validateImage`、`C.transform`；当前 Host p0Dispatch 没有为它们接线，直接调用会报告 `CAPABILITY_UNSUPPORTED`。不能仅凭 surface 上存在函数，认定该方法已可执行。

provider 默认通过公共工厂转换结果。现有工具调用 `p0Call()` 时通常使用 `raw: true`，保留工具所需的平台结果，并继续返回适配器证据。例如 `browser_screenshot` 使用 A 家族的 `capture/product`，随后由工具完成 PNG 校验、文件留存和附件交付。

P0 派发必须保留 `context`：没有其中的 Runtime 与调用方信息，即使方法已注册也无法完成采集和归属判断。平台错误经 provider 包装时，组合根需要保留原始 cause 或错误码。

## 4. Chrome 的注册与调用链

### 4.1 从配置到适配器注册

接入发生在 Host，不由面板直接创建适配器：

```text
Host apply()
  ├─ 创建 RuntimeRegistry（管理 Chrome 的运行时与页面）
  └─ createCrossEnvironment({ ctx, registry, ... })
       ├─ 加载 ConfigStore，解析不可变 ConfigSnapshot
       ├─ 创建 AdapterRegistry
       └─ prepareWeb(snapshot)
            └─ ensureWebRegistered() → createWebFaces()
                 ├─ createWebTargetAdapter({ registry, capabilityAvailability })
                 ├─ createWebCapabilityAdapter({ dispatch })
                 ├─ createWebP0Provider({ p0Dispatch })
                 └─ 分别 registerTargetAdapter /
                         registerCapabilityAdapter / registerP0Provider
```

适配器实例按需创建并缓存；注册三种适配器本身不启动 Chrome。`adapterRegistry.resolve(snapshot)` 按 `environment: "web"` 返回这组对象，执行端选择由快照中的 `provider: "chrome"` 继续确定。

Chrome 的调用前提是：Web 环境已允许启用，`environments.web.enabled` 为真，Chrome 分开关 `environments.web.providers.chrome.enabled` 为真，当前有效选择为 `provider: "chrome"`。禁用选择会阻断执行，不静默换执行端。

### 4.2 从注册到 Agent 可用

组合根与 Host 还需要完成两道工具门禁和 Skill 接入：

| 接入点 | 当前行为 |
| --- | --- |
| 工具注册 | `declarableToolNames()` 计算启用环境的工具并集；Host 据此注册或撤销工具定义 |
| 会话准入 | `when(agent)` 与执行入口再次根据该 Agent 的快照检查环境和能力 |
| Skill 发现 | `registerSkills()` 按环境与启用状态过滤目录和正文；公共规则与 Web 扩展分别提供 |
| GUI 写入 | 页面写路由校验相同的 Host 配置，不能绕过工具准入 |

Web 的公开工具集合为 37 个 `browser_*`，其中 `browser_state`、`browser_capabilities` 按当前契约作为常驻诊断保留。注册范围控制模型能看到哪些 schema，会话准入控制该 Agent 能否执行；不能只用 `when=false` 代替注册隔离。完整工具契约见 [工具参考](tools.md)。

### 4.3 一次普通页面操作：点击

```text
browser_click({ ref })
  → Host：校验配置与调用身份，解析 scope 和当前页面
  → Host：按执行类别安排 Runtime 队列、页面就绪与写入租约
  → invokeTool()
      → TargetAdapter.createSession()，绑定本次页面目标
      → CapabilityAdapter.invoke(operation="browser_click", ...)
          → dispatch({ context }) → context.execute()
              → 工具 handler → Runtime → Chrome CDP 输入与结果读取
      → 保留工具结果，在 finally 中 dispose 会话
  → Host：返回工具结果与执行元数据
```

目标身份、权限与控制版本需要在真正派发前再次校验。取消或失败时应沿运行时的清理路径释放相应资源，不能只修改会话状态而遗留连接或后台任务。

### 4.4 一次使用 P0 的操作：截图

截图先经过同样的工具包装与 CapabilityAdapter，再由 handler 使用 P0：

```text
browser_screenshot handler
  → p0Call(family="A", method="capture")
      → 解析同一调用环境的快照与 P0Provider
      → 创建本次 P0 调用的 TargetSession，绑定目标
      → provider.capture.capture({ session, snapshot, context, raw: true })
          → p0Dispatch("A", "capture", ...)
              → context.runtime.capture() → Chrome 截图与合成
      → 返回 value/evidence，finally 中 dispose P0 会话
  → p0Call(family="A", method="product") 读取浏览器产品信息
  → 工具完成 PNG 校验、输出与附件交付
```

当前 `invokeTool()` 与每次 `p0Call()` 分别创建会话，不能把示意图理解为整次工具调用只创建一个 TargetSession。它们需要对齐实际 Runtime、目标与配置身份；会话标识或绑定计数不能替代页面本身的代次校验。

### 4.5 一次多目标管理操作

```text
browser_tabs handler
  → crossEnvironment.invokeTabs(args, exec)
    → 当前 Web TargetAdapter.tabs.invoke(args, context)
      → core/target-tabs：公共请求校验与实际动作派发
        → targets/web/tabs：Web 参数、页面结果与 P0-E list 投影
          → 现有 RuntimeRegistry：目标生命周期、选择、权限与控制权
```

这条调用仍经过外层 CapabilityAdapter 的工具准入与 Host 原有的 `tabs` 执行分支。公共接口不创建第二份页面表，也不把动作绕过原有的权限、CAS 和租约。Web 的 P0Provider 继续负责目标投影与租约原语；其他环境未提供 `tabs` 时没有可执行的多目标管理服务。

## 5. 接入与验证

### 5.1 接入另一个目标环境时要补齐什么

Chrome 的可执行文件、CDP、DOM 和页面模型属于 Web 实现。新环境沿用三种接口的职责和证据约束，并提供自己的目标发现、操作语义与数据转换。

1. **定义身份和能力目录。** 在公共配置、契约与 registry 允许的环境集合中登记环境和能力 id，再声明平台自己的操作名与执行类别。当前环境和能力目录是显式登记的，不能只增加一个目录就自动接入。
2. **实现 TargetAdapter。** 提供 manifest、六轴探测与目标会话；明确平台资源所有权、绑定代次、关闭和取消清理。
3. **实现 CapabilityAdapter。** 提供操作映射、状态、预检和执行；为组合根提供可注入的执行边界。
4. **实现需要的 P0 家族。** 将平台数据转换成公共模型；缺失家族和未接线方法如实报告不支持。
5. **在组合根接线。** 注册三种适配器，补齐配置解析、工具注册与会话准入、执行分支、P0 派发和 Skill 发现；平台连接参数通过统一的配置快照结构传递。
6. **验证身份与资源边界。** 检查 revision、目标代次、证据、可选能力、取消与释放，再做真实平台的操作闭环。

[假环境实现](../targets/fake/adapter.js) 可用于对照接口与确定性契约验证。它不是实际平台，不能用假目标通过来证明真实平台可用，也不能用其单槽标注存储证明真实会话隔离。

### 5.2 验证入口

修改适配器实现时，按下列层次验证；命令与结果判读详见 [验证与贡献](verification.md)。

| 验证层次 | 命令 | 验证重点 |
| --- | --- | --- |
| 公共契约与适配器 | `node --test tests/contracts/*.test.mjs` | 配置、registry、P0、fake 与 Web 接口约束 |
| 执行端配置 | `node --test tests/contracts/web-provider-config.test.mjs` | provider 选择链、旧配置兼容、revision/CAS |
| Chrome 运行时路由 | `node --test tests/contracts/web-provider-runtime.test.mjs` | 执行端门禁、Host 隔离、页面预算和绑定路由 |
| 跨环境组合根 | `node tests/acceptance/cross-environment.mjs` | 配置、六轴、GUI 准入与不启动浏览器的诊断 |
| 隔离与清理 | `node tests/acceptance/foundation-isolation.mjs` | 工具、Skill、证据、租约和生命周期约束 |
| 真实 Chrome 工具闭环 | `node tests/acceptance/run.mjs` | 真实无头 Chrome 下的工具与 T1～T4 行为 |

新增或修改适配器后，至少运行契约套件与 `foundation-isolation`，再按涉及的能力运行真实目标验收。工程支持、依赖存在、连接成功与实际操作通过分别记录；未执行的检查保留为未验证。
