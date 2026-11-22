# Blender 纯视口

Linux 和 Windows 上可以在调试视图中打开 Blender 的 3D 视口。进入 **设置 → UI 测试**，启用「3D 视图」分组，确认「Blender」卡片的开关处于启用状态，然后在 **更多 → 调试视图** 或右侧的调试面板切换到「3D 视图」。在画面里用左键选择对象，右键打开 Blender 原生菜单，中键拖动旋转视角，Shift + 中键拖动平移，滚轮缩放。按 Esc 可关闭菜单或取消 Blender 当前操作。进入标注时，鼠标用于面板标注。

- 上方提示栏显示当前操作，提供「标注」和「尺寸调整」入口。底部状态栏显示实际图像分辨率、最近一帧从请求到加载的耗时，以及连接和出图状态。
- 尺寸栏支持分辨率预设、手动宽高、适应窗口与显示缩放。宽高作用于 Blender 实际出图，单边为 200–4096 像素，总面积上限为 8,388,608 像素。显示缩放只改变面板中的呈现比例。
- 标注使用公共绘图工具，保存在当前面板的 3D 画布中，与 Web 标注分开。截图将已提交的图形与当前 Blender 帧合成为 PNG，可加入当前会话的聊天框。

## 启用条件

取画面要同时满足两个开关，缺一个都返回 `409 ADAPTER_DISABLED`，面板直接把原因显示在视口上：

| 开关 | 配置字段 | 关闭时的提示 |
| --- | --- | --- |
| 3D 视图总开关 | `environments.three-d.enabled` | 请先在设置中启用 3D 视图。 |
| Blender 运行环境 | `environments.three-d.providers.blender.enabled` | 请先在设置中启用 Blender 运行环境。 |

Blender 是 3D 视图的**运行环境**（provider），工程支持度为 `preview`：它提供纯视口，不提供 Agent 执行工具。第一次读取配置时 Blender 默认为开启，所以只打开 3D 总开关就能看画面；把它单独关掉不会停用整个 3D 分组。开关语义见[运行环境（provider）开关](../target-environments.md#运行环境provider开关)。

配置保存在 `${DSH_HOME}/ui-testing/config.json`，改动立即生效，不需要重启 DSH。

## Host 依赖

- 在运行 DSH 的主机上安装 Blender。Linux 另外需要 Xvfb，Windows 使用系统自带的 Windows PowerShell。安装方式和发现规则见[运行时配置](blender-runtime.md)。
- 可通过 `DSH_UI_TESTING_BLENDER` 指定可执行文件的绝对路径。Linux 可用 `DSH_UI_TESTING_XVFB` 指定 Xvfb。
- 默认加载 Blender 出厂场景。要查看现有工程，在启动 DSH 前将 `DSH_UI_TESTING_BLEND_FILE` 设为 Host 上一个可信 `.blend` 文件的绝对路径。这个工程由 Host 配置，供该 Host 的 3D 面板使用。Blender 禁用工程脚本自动运行。选择与菜单操作在临时运行实例中执行，面板关闭时不会保存工程。
- 修改 Host 的启动环境后，须重启 DSH 并刷新网页；只改设置页开关不需要重启。

## 视口行为

Host 按需在隔离的显示环境里启动 Blender，Linux 使用私有 Xvfb 显示，Windows 使用独立的 Win32 桌面。当前 Windows 桌面不会显示 Blender 的原生窗口或切走焦点。面板把鼠标事件发给 Blender，并接收包含选择高亮和弹出菜单的原生画面。画面等比放进所选输出尺寸，比例不同时保留留边。Linux 默认使用 Mesa 软件 OpenGL 渲染。连续移动事件会合并，按下和释放会按顺序送达。Host 同时运行一个 Blender 视口，切换到另一会话的视口会开启新的运行实例，无请求 45 秒后回收进程。

面板覆盖这些视口鼠标操作和 Esc。原生菜单中的部分命令会修改临时 Blender 场景。完整编辑器界面、其他键盘快捷键、多窗口对话框和 Agent 执行工具尚未接入。

## 验证

进入 3D 视图后，默认场景应出现立方体、网格和坐标轴。拖动后查看立方体的可见面是否变化，滚动后查看它的投影大小是否变化。Windows 上可在首次出图和操作期间检查当前桌面、任务栏与 Alt-Tab，并确认焦点留在正在使用的应用。返回 Web 视图后核对原来的页面。依赖缺失、Host 未响应或渲染失败时，面板会显示错误并提供重试入口。
