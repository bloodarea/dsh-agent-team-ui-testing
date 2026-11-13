# 调试面板

从 **更多 → 调试视图** 或右侧边栏的插件卡片进入。面板展示目标页面的实时画面，可直接用鼠标和键盘操作；按截图走一遍见[图文教程（tutorial.md）](tutorial.md)。

## 地址栏与最近访问

输入 HTTP(S) 地址后按 Enter，或点右侧「转到」。两者使用相同的地址校验；标注模式或导航进行中禁用「转到」。

时钟按钮打开最近访问列表：

- 最近的地址在上，最多 7 条；重复访问只置顶，点条目直接跳转。
- 空地址、`about:blank` 和应用自身地址不记录。
- 点外部或按 Esc 收起；切换工作区作用域或进入标注模式也会收起。
- 历史按工作区保存在浏览器 `localStorage`：`dsh-agent-team-ui-testing:address-history:v2:<工作区作用域 id>`。同工作区的多个面板共享，作用域未解析时不读写；旧版 `v1` 历史不迁移。

## 页面输入与预览

预览使用 CDP screencast，优先通过 WebSocket 推帧，HTTP 轮询兜底。点击预览使其获得焦点后，键盘输入会转发到目标页，包括修饰键组合、F1–F12、Home/End、PageUp/PageDown、Delete/Insert。按住与松开分别转发，离开焦点时释放仍按住的键。

标注、选元素和尺寸调整有各自的输入规则；普通点击没有到达页面时，先检查当前模式与画面同步状态。坐标、缩放、拖拽、输入屏障与光标跟随见[视口、画布与标注（viewport-control.md）](viewport-control.md#面板交互)。

浏览器原生的 alert/confirm、文件选择器不在页面画面中。单选 `<select>` 使用面板浮层；多选、列表框和不支持的情况会提示改用键盘，详见[选元素与原生下拉（element-picker.md）](element-picker.md)。页面右键菜单的优先级和默认操作见[页面右键菜单（panel-context-menu.md）](panel-context-menu.md)。

## 标签页、标注与尺寸

| 操作 | 说明与详细入口 |
| --- | --- |
| 切换或新建页面 | 标签栏位于地址栏下方，工具栏开关控制显隐，`+` 在标签栏内；GUI 切页与 Agent 选页独立，见[多标签页（multi-tab.md）](multi-tab.md) |
| 调整画面 | 尺寸预设、坐标、缩放、拖拽与适应窗口，见[视口控制（viewport-control.md）](viewport-control.md) |
| 指定元素 | 用「选元素」将 `@` 引用加入聊天框，见[选元素（element-picker.md）](element-picker.md) |
| 画标注并交付图片 | 使用绘制、选择和框选工具；标注栏「截图」把当前画面与已提交标注加入聊天框，见[标注（viewport-control.md）](viewport-control.md#标注)和[截图交付（capture-p0.md）](capture-p0.md) |

环境选择器与 Host 配置的关系见[环境设置（settings.md）](settings.md#启用与选择)。

## 打开 Chrome DevTools

在「更多 → 打开调试工具」中，为当前页面打开 Chrome 自带 DevTools 的独立窗口。需要该工作区的浏览器运行时已经启动，且 GUI 与 DSH 同机、通过 `127.0.0.1` 或 `localhost` 访问；远程 GUI 暂不支持。

弹窗被浏览器拦截时，使用提示中的「在新标签页打开调试工具」链接。DevTools 直接连接页面 CDP；断点、Console 求值、设备和网络模拟会改变页面，自动化取证前应恢复设置并重新采集。连接与访问边界见[外部 DevTools（architecture.md）](architecture.md#外部-devtools)。
