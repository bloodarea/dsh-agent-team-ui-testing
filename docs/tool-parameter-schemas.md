# 工具参数声明与模型网关兼容性

新增工具、添加动作或修改字段时，检查注册到 DSH 的 `parameters`。模型适配器会把本步可用的工具声明随请求发送。OpenAI 兼容适配器通常将它放进 `tools[].function.parameters`。网关可能在生成开始前检查整份工具列表，所以即使用户只发了一句短消息，一条不兼容的声明也可能让整个请求返回 HTTP 400。OpenDesign 的 `deepseek-v4.1-flash-eco` 会拒绝以根级 `oneOf` 声明的工具参数，即使每个分支都是对象。

## 声明规则

1. 给模型的 `parameters` 根节点声明 `type: "object"`，在 `properties` 中列出字段。把根级 `oneOf` 动作联合投影为一个对象。DSH 的注册 Schema 子集也拒绝在同一个节点同时声明 `type` 和 `oneOf`，因此应转换结构。
2. 多动作工具用 `action` 枚举列出可选动作。把所有动作都需要的字段列在根级 `required`，并用字段说明注明各动作独有的适用字段和必填条件。
3. 执行入口继续按原始输入契约检查动作、必填字段、字段组合和取值范围。已有运行时 Schema 时，从它生成模型侧声明，避免两处手写同一套字段。

[Browser 的 `browser_network_session`](../targets/web/tools.js#L4612) 直接使用对象根节点和 `action` 枚举。[Blender 的 `blender_tools`](../schemas/blender/tools/v1/blender_tools.input.schema.json) 在运行时使用 `oneOf` 校验 `status` 和 `activate` 的不同入参，通过[工具注册时的参数投影](../targets/three-d/tools.js#L57) 生成对象声明。下面是该模型侧声明的简化示例。

```json
{
  "type": "object",
  "properties": {
    "action": { "type": "string", "enum": ["status", "activate"] },
    "groups": {
      "type": "array",
      "items": { "type": "string" },
      "description": "Available only for activate. Required for activate."
    }
  },
  "required": ["action"],
  "additionalProperties": false
}
```

运行时仍拒绝缺少 `groups` 的 `activate`，也拒绝带 `groups` 的 `status`。

## 验证方法

1. 检查实际注册出来的 `parameters`。断言参数根为对象，并检查动作枚举、公共必填字段和动作特有字段是否齐全。修改 Blender 声明时，从仓库根目录运行以下回归测试。

   ```bash
   node --test --test-isolation=none tests/acceptance/blender-tool-registration.mjs tests/acceptance/blender-input-validation.mjs
   ```

2. 在 DSH 中重载插件，进入能披露该工具的会话。发送一条短消息，核对该步 `request/header` 中的工具名与参数声明，并确认模型路由能生成文本。对按组披露的工具，先激活对应能力组再验证。
3. 如果在工具执行前就收到 HTTP 400，保持账号、模型、端点和消息相同，只替换工具声明做对照。先跑最小工具声明，再复测实际工具列表。用模型响应判断网关是否接受声明，用执行测试验证合法和非法参数的处理。
