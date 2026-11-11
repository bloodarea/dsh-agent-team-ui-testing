# 调试视图里的页面右键菜单

在预览的页面内容上按右键，会向目标页发送一次可信的右键按下、`contextmenu` 和抬起。DSH 自身的右键菜单不会在预览区内打开；预览区以外保持宿主行为。

## 页面菜单与默认菜单

- 页面调用 `preventDefault()` 时，保留页面自己的行为。页面自绘菜单仍在预览帧中显示，菜单项沿用普通左键输入。
- 页面没有取消默认行为时，面板在点击处显示菜单：后退、前进、重新加载、复制页面地址；存在相应上下文时增加复制选中文本、复制链接地址、复制图片地址。后退/前进按页面历史禁用。
- 方向键、Home/End 移动，Enter/空格执行，Esc/Tab 关闭并恢复预览焦点；点击外部关闭。菜单自动限制在预览框内，空间不足时可滚动。
- 复制使用 GUI 浏览器的剪贴板 API。权限失败会显示提示；密码输入的选中文本不读取。地址只接受不含用户名/密码的 HTTP(S) URL，复制图片地址不会下载或复制图片二进制。

此菜单覆盖上述常用操作，没有提供完整 Chromium 菜单里的打印、另存为、翻译、扩展项、剪切与粘贴。浏览器原生 UI 本身仍不进入页面 screencast 或截图；面板菜单也不包含在目标页的 `browser_screenshot` 中。

## 观测与失效

Host 在命中 frame 的隔离 world 中安装临时 capture 监听器，保存真实 Event；完整右键派发后才读取最终 `defaultPrevented`。结果分为 `handled`（页面取消默认）、`default`（可显示面板菜单）、`unknown`（没有足够证据）。`unknown` 不显示面板菜单；例如页面较早的 window capture 监听器调用 `stopImmediatePropagation()`，或命中跨进程 frame、期间发生导航。

同进程 iframe 在自己的 frame 中观测。标注/选元素模式、画布空白、画面未同步时不发送右键。右键抬起在同一 Host 事务内完成，用户把指针移出图片不会遗留按下状态。

右键响应携带同次操作结束时的权威页面状态，面板按 Runtime/revision 接收后绑定文档，避免刷新后的帧先到而状态轮询晚到导致菜单误关。菜单响应还绑定面板 scope、画布与请求序号；切页、预览相关滚动、缩放、失焦或视图不可操作时会关闭并丢弃旧响应；聊天等无关区域的滚动不影响菜单。Host 动作令牌只属于当前 Runtime，60 秒内单次有效，并在执行时核对主文档和命中 frame 的 loaderId。旧文档令牌返回 `INVALID_ARGUMENT` / `stale-target`。

## 面板接口

两个认证 GUI 页面操作均沿用环境门禁、scope 解析、输入租约与 Runtime 串行队列，不增加 Agent 工具：

| 路由 | 请求 | 返回 |
| --- | --- | --- |
| `POST /plugins/ui-testing/context-menu` | `{x,y,modifiers?}`；视口 CSS px，修饰键 CDP 位掩码 0–15 | `{ok,status,menu?,state}`；menu 含短期 token 与白名单 items，state 为同次操作的权威快照 |
| `POST /plugins/ui-testing/context-action` | `{token,action}` | 执行后退/前进/重新加载；拒绝过期 token 和未知/禁用项 |

复制项的文本在右键上下文中读取并有长度上限；实际复制在 GUI 的真人菜单点击中发起，以保留剪贴板手势权限。

## 验证

```bash
node --test tests/contracts/panel-context-menu.test.mjs
node tests/acceptance/context-menu-host.mjs
node tests/acceptance/pick-element-gui.mjs --context-only
```

Host 验收驱动真实 Chromium，覆盖最终取消状态、传播中断、iframe、密码保护、旧令牌及导航动作。GUI 验收覆盖页面自绘菜单、面板默认菜单、复制、Esc、离图释放及预览内外宿主菜单隔离；调用已有实例的方法见[验证与贡献](verification.md)；`DSH_CONTEXT_GUI_FIXTURE_URL` 可指定同契约的右键靶页地址。
