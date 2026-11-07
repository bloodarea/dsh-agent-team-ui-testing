# 三类 adapter：契约、接入与坑点

面向两类读者：给本插件接一个新调试环境的人（Android、Linux 桌面、小程序……），以及维护 `core/` / `integration/` 的人。这里只写当前实现与当前边界；不写过程记录。

一句话分层：**TargetAdapter 管"目标在哪、还能不能用"，CapabilityAdapter 管"这个操作能不能做、做了什么、证据是什么"，P0Provider 管"把平台数据翻译成公共数据模型"**。三者消费同一份不可变配置快照，串在一条调用链上。

## 1. 一个工具调用经过什么

```text
Agent 工具调用
   │
   ├─ 组合根：解析 ConfigSnapshot（按会话/工作区/全局）→ 未启用或能力缺失 → ADAPTER_DISABLED
   ├─ TargetAdapter.createSession() → TargetSession → listTargets()/bind(targetId) → 得到目标与 generation
   ├─ CapabilityAdapter.invoke({ operation, args, session, snapshot, executionClass, context })
   │     └─ P0 家族操作 → P0Provider.<family>.<method>() → 数据 + 证据 envelope
   ├─ 组合根：executionClass 决定是否进串行队列 / ensure / 租约
   └─ TargetSession.dispose()（每次调用即建即销的簿记对象）
```

`executionClass`（`page | readOnly | hostOnly | networkRead | diagnostic | independentHttp | tabs`）由**组合根**决定，adapter 只能声明与校验，不能改变分支——这是"只读诊断不进队列、不取租约"这类行为的唯一来源。

## 2. 三类 adapter 的职责边界

| 类型 | 必须实现 | 只属于它 | 不得做 |
| --- | --- | --- | --- |
| **TargetAdapter** | `manifest`、`probe`、`createSession`、`dispose` | 目标发现/绑定/关闭、目标 `generation`、连接与后台任务归属 | 定义工具语义、做业务操作、启动用户没启用的目标 |
| **CapabilityAdapter** | `manifest`、`operationStatus`、`invoke`、`preflight`、`dispose` | 操作清单与现场可用性、参数前置校验、证据 envelope | `bind`/`close` 目标、改 `executionClass`、自己起浏览器 |
| **P0Provider** | `manifest`、`familyStatus`、五个家族 surface、`dispose` | A–E 家族的数据模型转换与平台引用（`transportRef`） | `bind`/`close`（P0-E 只给 `list` 与租约）、伪造缺失能力 |

三者的 `manifest` 都以 `contractVersion`（当前 `1`）开头；版本不一致的环境在就绪报告里是 `support=unsupported`，不会被当成可用。

### 2.1 TargetAdapter

```js
{
  manifest: { contractVersion, id, class: 'target', environment, displayName, capabilities, dependencies, visibility },
  async probe({ scope, snapshot, signal }) -> ReadinessReport,   // 六轴，见 §4
  async createSession({ scope, snapshot, signal }) -> TargetSession,
  async dispose() -> void,
}
```

`TargetSession` 对组合根暴露：

| 成员 | 语义 |
| --- | --- |
| `sessionId` / `environment` / `scopeId` | 调用身份；`sessionId` 用于租约归属与网络归属 |
| `generation` | 目标代次。**`bind()` 成功后递增**；旧代次的引用（帧、标注、租约）必须一律失效 |
| `configRevision` | 创建时消费的配置 revision |
| `target` | 当前绑定目标 `{ targetId, generation, ... }` 或 `null` |
| `listTargets()` / `bind(targetId)` | 发现与绑定；目标不存在 → `TARGET_NOT_BOUND`，已关闭 → `TARGET_GONE` |
| `close()` / `dispose()` | 关闭/释放。两者都要幂等 |

要点：**TargetSession 是"每次工具调用一份"的簿记对象**，不是页面本身的生命周期。页面/连接/帧源/网络采集器属于平台实现（Web 里是 `Runtime`），由组合根与 `Runtime.close()` 负责。把两者的生命周期混在一起，会出现"一次调用结束后把用户的页面关掉"或"环境切换时页面没被释放"两种对称的 bug。

### 2.2 CapabilityAdapter

```js
{
  manifest: { contractVersion, id, class: 'capability', environment, capabilities, operations },
  operationStatus({ session, snapshot }) -> { [operation]: { status, reason, constraints } },
  preflight(args, operation) -> void,                     // 纯校验，零副作用
  async invoke({ operation, args, session, snapshot, signal, executionClass, context }) -> { value, evidence },
  async dispose() -> void,
}
```

- `operation` 是**环境无关的操作 id**（Web 是 `browser_*` 名字，映射到 `web.t*` 能力）；`context` 携带本次调用的平台句柄（页面 runtime、调用方 `exec`、`actionId` 等），**必须原样往下传**（见 §5 坑 1）。
- 工具返回给用户的结果形状由**工具契约**决定，不由 adapter 决定；P0 家族的公共数据模型（帧、网络事件、显示空间、标注文档、目标身份/租约）才走中立工厂。
- `preflight` 必须在任何 I/O 之前跑完：非法参数要做到"零 CDP、零文件、零派发"。

### 2.3 P0Provider（A–E）

| 家族 | 内容 | 方法 |
| --- | --- | --- |
| A | 采集（截图/帧/图像校验） | `screenshot`、`capture`、`product`、`readFrame`、`validateImage` |
| B | 网络（会话/事件/详情/拦截控制/链路/证据/订阅） | `start`、`stop`、`status`、`reset`、`events`、`detail`、`control`、`trace`、`evidence`、`subscribe` |
| C | 显示空间（视图投影与几何） | `read`、`set`、`transform` |
| D | 画布/标注 | `annotationRead`、`annotationWrite` |
| E | 目标模型与租约 | `list`、`leaseAcquire`、`leaseRelease`、`leaseStatus` |

- **家族可以缺省**。没有网络能力的平台把 B 报成 `support=unsupported`，A/C/D/E 照常工作；"可选"是契约的一部分，不是降级。
- 两组词表不能混用：`support` 回答"工程支持吗" = `supported | unsupported | planned`；`availability` 回答"现在能用吗" = `available | unavailable | not-probed | busy`。就绪报告里的 `capability` 轴是二者的并集词表（多出 `partial` / `unsupported`）。未探测就是 `not-probed`，不得写成 `available`；"支持但此刻不可用"要分别报。
- 每次成功调用都要带证据 envelope，字段固定：`version / scope / session / target / generation / configRevision / operation / source / capturedAt`；缺一个就是 `EVIDENCE_INCOMPLETE`。
- 租约必须同时带 `targetId` 与整数 `generation`；`acquire/release/status` 是三个不同操作，不能接成同一个只读投影。

## 3. 配置如何约束三类 adapter

- 组合根解析出**不可变** `ConfigSnapshot`：`{ revision, environment, adapterId, provider, executionAdapterId, enabledProviders, providerConfig, enabledEnvironments, capabilities, environmentConfig, targetId, source }`。深度冻结 + 按 revision 记忆化，同一 revision 内同一 Agent 拿到的是同一个对象。
- **`environment` 与 `adapterId` 仍是目标环境身份（Web 恒为 `"web"`）**；浏览器身份放在 `provider` / `executionAdapterId`（`web-<provider>`）里。一个字段不兼任两件事。
- `invoke` 收到 `snapshot.revision` 与 `session.configRevision` 不一致时抛 `CONFIG_STALE`，**不静默用旧配置执行**。
- `enabledEnvironments` 决定"允许启用谁"；`environmentConfig` 是该环境的连接参数。设置页只提交意图，Host 校验 + CAS 写入 + 返回权威 `revision`。
- 工具声明面 = **已启用环境的并集 + 两个环境无关诊断**（`browser_state`、`browser_capabilities`）。被禁用的环境其工具根本不注册，因此不会出现在模型请求里。

## 3.1 provider 维度：facade → driver

同一个目标环境可以有多个**运行环境**（provider = 实际执行端，如 `chrome` / `edge`）。注册面不变：每环境仍是一个 TargetAdapter / CapabilityAdapter / P0Provider 组成的 facade，注册表不需要复合键。

```text
registry.resolve(snapshot) → web facade（environment/adapterId = "web"）
   └─ resolveWebDriver(snapshot.provider) → chrome driver | edge driver
                                           └─ 未实现 / 未知 provider → ADAPTER_UNSUPPORTED
```

- **派发靠快照，不靠全局开关。** facade 在 `invoke`/`createSession` 前解析 driver，并把 `provider` / `executionAdapterId` 一并交给平台 dispatch；36 个 `browser_*` 名字只注册一次，切换 provider 不改变工具集合。
- **禁止静默换浏览器。** driver 解析结果只有两种：可执行，或带 `reason` 的阻断。被禁用是 `ADAPTER_DISABLED`（`environment-disabled` / `provider-disabled`），未实现/未知是 `ADAPTER_UNSUPPORTED`（`driver-pending` / `provider-unsupported` / `unknown-provider`），依赖问题属于 `DEPENDENCY_MISSING`（`executable-missing` / `override-invalid` / `identity-unverified` / `identity-mismatch`）。这些 `reason` 都在 `details` 里，不属于对外错误码。
- **厂商参数化。** 可执行文件候选、覆盖变量（Chrome `DSH_UI_TESTING_CHROME`、Edge `DSH_UI_TESTING_EDGE`）、profile 目录、启动参数都按 provider 注入；Chrome 的覆盖不会被 Edge 继承，反之亦然。一个提供者的覆盖无效时直接报错，不尝试另一个厂商。
- **产品身份校验。** 传输建立后用 `Browser.getVersion` 的产品串核对厂商（规则表：Chrome 必须含 `Chrome/` 且不含 `Edg/`；Edge 必须含 `Edg/`）。Edge 拿不到产品串按 `identity-unverified` 拒绝；Chrome 保持机会式（拿到就核对，拿不到不阻断）。
- **运行时归属按 provider。** 页面容器是 `hosts[provider]`，entry 键为 `(provider, workspace)`（`<provider>\u0000<baseKey>`）。切换 provider 后旧 `targetId`、旧 ref、旧租约一律失效；关闭一个 provider 不影响另一个；页面总预算按 provider 求和后仍与同一个 `maxPages` 比较，拆 host 不放宽上限。
- **GUI/预览读侧。** 明确绑定（binding）时用 provider 前缀键精确命中；其余读路径回落到"该工作区最近使用的 provider"，响应里带 `provider` 与 `providerResolved: "binding" | "recent"`。**预览面板按 provider 分栏尚未实现**。

## 4. 就绪（六轴）怎么写才算真实

`probe()` 返回 `support / enabled / dependency / connection / target / capability` 六个独立轴，每轴带 `status`、`reason`、`checkedAt`（`expiresAt` 可选），能测到的还要带 `target` / `evidence`：

- `probe()` **不得启动目标**，必须有超时；启动/连接属于显式操作。
- `dependency`：可执行文件/服务是否存在；版本没读到就 `version: null`，不编造。Web 的 evidence 还带 `provider` 与解析出的 `path`，并**用该 provider 自己的候选清单**探测（不借用另一个厂商的路径）；未实现的 provider 不探测，直接报 `not-probed` + 专属 reason。
- Web 的每张 provider 卡片读自己的结果：`readiness.environments.web.providers.<provider>.axes`；被禁用的 provider 不探测、不启动。
- `connection`：只在确有 transport 时 `ok`；有宿主进程但没有页面会话是 `not-probed / host-idle-no-transport`。
- `target`：配置目标与实际绑定目标不一致时报 `stale / identity-mismatch`（带 expected/actual），不要报 `bound`。
- `capability`：**逐项探测的并集**（Web 是结构树 / 输入 / 网络采集 / 帧源），全过 `available`、部分 `partial`、全不过 `unavailable`，明细放 `evidence.checks`。
- 被禁用或不允许选择的环境**不探测**，对应轴报 `not-probed / environment-disabled`——"工程支持"与"用户启用"是两件事，前者仍应是 `supported`。

## 5. 坑点（都是这轮实测踩到的）

1. **Provider 派发必须透传 `context`。** 只传 `{ args, session, snapshot, signal }` 时，平台 dispatch 拿不到页面 runtime，只能回 `PROVIDER_UNAVAILABLE`；表面"接好了"，实际一条数据都取不到。
2. **`when` 不等于声明隔离。** 本机组合按"已注册"构建模型请求（实测 `request/header`：`when=false` 的工具仍在声明里，调用也仍能进到插件）。隔离靠**注册范围**：只注册已启用环境的工具。`when` 是第二道闸门，不能当唯一防线。
3. **`TargetSession` 不是页面生命周期。** 每次调用即建即销；页面/连接/帧源/采集器归平台实现，由 `close()` 释放。
4. **租约要 `targetId + generation`。** 少了 generation 就无法判断"这条租约属于哪一代目标"，重绑后旧租约会被当成有效。
5. **目标重建必须让旧引用失效。** 帧、标注、租约、文本 ref 都要按 `targetId + generation` 校验，否则出现"数据属于 t1、证据写 t2"。
6. **平台错误码不要在边界上坍缩。** 适配器只认得中立码，`NET_*` / `VISION_*` / `OUTPUT_*` 这类平台码必须原样透出（保留 cause 或平台码），否则调用方拿到的是 `INTERNAL`，无法分类。
7. **缺能力要报 `unsupported`，不能假装。** 没有网络家族就报 `unsupported`，不要返回空数组冒充"没有事件"；没有服务 worker 采集就写明 `not-collected`。
8. **取消与关闭走同一条清理链。** 取消后必须释放连接/帧源/网络/租约（Web 里是 `ABORTED → close()`）；只把状态位改掉会留后台任务。
9. **按需加载。** Web 的帧源/采集/视觉/网络模块与三面 adapter 在首次真正需要时才创建；禁用环境时既不加载也不启动 Chromium。
10. **假环境只是契约夹具。** `targets/fake/` 的标注存储是单槽、目标是内存对象；用它证明的是"契约形状与准入/证据/清理"，**不能**据此声称任何真实平台可用，也不能把它当作会话级数据隔离的证据。
11. **证据字段缺一个就失败。** `P0_EVIDENCE_FIELDS` 是硬约束；为了"顺手"塞进工具结果里的额外字段不要污染中立 envelope。
12. **`executionClass` 不许 adapter 改。** 只读诊断若被当成页面操作，会多出 ensure/队列/租约，直接改变用户可见行为。

## 6. 接入一个新平台的步骤

1. 在 `targets/<platform>/` 实现 TargetAdapter、CapabilityAdapter、P0Provider（P0 家族可只实现有能力的部分）。
2. 在平台 manifest 里声明能力 id，并把 `operation` 映射到这些 id；不要复用 Web 的工具名。
3. 在 `integration/cross-environment.js` 注册三类 adapter，并让配置启用该环境（`enabledEnvironments` + `environments.<id>.enabled`）。
4. `probe()` 按 §4 返回六轴；先做到"冷态全部 `not-probed`、不启动目标"。
5. 用假环境做对照跑一遍契约（配置 revision 一致、generation、证据、可选能力、取消/清理），再接真实平台。
6. 跑文档里列出的验证命令，并把"假适配器契约通过"与"真实平台验证"分开记录。

## 7. 验证入口

```bash
node --test tests/contracts/*.test.mjs          # 契约层：adapter/fake/P0/配置/就绪/provider 派发
node --test tests/contracts/web-provider-config.test.mjs   # provider 配置与选择链（含旧配置规范化）
node --test tests/contracts/web-provider-runtime.test.mjs  # driver 门禁、host 隔离、页面预算、providerResolved
node --test tests/contracts/web-provider-edge.test.mjs     # Edge 厂商参数化、覆盖变量、产品身份判定
node tests/acceptance/cross-environment.mjs     # 配置 CAS、六轴、GUI 旁路、不启动浏览器
node tests/acceptance/foundation-isolation.mjs  # 逐项阻断复核（含 A08 面板为权威、A09 Skill 隔离）
node tests/acceptance/run.mjs                   # 真实无头 Chromium：36 工具面与 T1～T4 回归
```

新增或修改 adapter 后，至少要让契约套件与 `foundation-isolation` 通过；运行方式与套件清单见 [verification.md](verification.md)。
