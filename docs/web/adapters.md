# Web 适配器实现与调用链

下文以 Chrome 为例说明 Web 实现的源码、注册与调用链。对象签名、通用配置和生命周期见[适配器接口与接入](../adapters.md)。

## 实现

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
| TargetAdapter | [适配器模块](../../targets/web/adapter.js) 的 `createWebTargetAdapter()`；可选 `tabs` 使用 [Web 多目标服务](../../targets/web/tabs.js) | `id: "web"`、`class: "target"`、`environment: "web"` |
| CapabilityAdapter | [适配器模块](../../targets/web/adapter.js) 的 `createWebCapabilityAdapter()` | `id: "web.capability"`、`class: "capability"`、`environment: "web"` |
| P0Provider | [P0 提供者模块](../../targets/web/provider.js) 的 `createWebP0Provider()` | `id: "web.p0"`、`class: "p0"`、`environment: "web"` |
| 创建、注册与派发接线 | [跨环境组合根](../../integration/cross-environment.js) | `createWebFaces()`、`invokeTool()`、`p0Call()` |
| Chrome 进程、页面与协议执行 | [Host 入口](../../index.js) | `BrowserHost`、`RuntimeRegistry`、`Runtime` |

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

## 注册与调用链

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

## 验证入口

| 验证层次 | 命令 | 验证重点 |
| --- | --- | --- |
| 执行端配置 | `node --test tests/contracts/web-provider-config.test.mjs` | provider 选择链、旧配置兼容、revision/CAS |
| Chrome 运行时路由 | `node --test tests/contracts/web-provider-runtime.test.mjs` | 执行端门禁、Host 隔离、页面预算和绑定路由 |
| 真实 Chrome 工具闭环 | `node tests/acceptance/run.mjs` | 真实无头 Chrome 下的工具与 T1～T4 行为 |

Web 套件及真实目标要求见[Web 验证](verification.md)。
