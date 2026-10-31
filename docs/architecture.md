# 代码结构

> 索引：[docs/index.md](index.md)

```text
package.json          DSH bundle 清单：dsh.bundle.patch + dsh.client（platform: web）
cordis.patch.yml      插入一行 plugin：id = ui-testing-browser
index.js              Host 半边：共享 Chromium/page、租约/串行队列、HTTP 路由、8 工具与内置 Skill
browser-safety.js     BrowserError/CDP、取消/定时器清理、URL 脱敏与目标/DNS 校验
frame-source.js       Host 帧缓存：最新帧/元数据/捕获统计（与传输、UI 解耦）
frame-push.js         Host 同源 WebSocket 推帧：握手、合并推送、背压丢帧、鉴权、清理
client.js             全部 UI（React，无 JSX，用 h()）；内含 UI-free 的 createFrameTransport
locale/{en,zh}.json   插件显示名与描述
icon.svg              插件图标
skills/ui-testing/    内置 Skill（SKILL.md + references/examples/templates/knowledge/manifests）
tests/ui_test_exam/   插件自身能力的对照测试靶机（20 处预设缺陷），见该目录 README
tests/ui_test_fixture/ 自建授权本地靶机（确定性断言值），供验收脚本使用
tests/acceptance/     真实验收脚本：fake ctx 驱动 index.js、帧推送/轮询、能力台账检查、Skill 注册检查
reference/            本地参考资产（Skill 模板包 v1.1）**不入库**：已进 .gitignore，见 skill-authoring.md
docs/                 项目记忆（本目录）
```

## client.js 内部结构

1. `CSS` 常量 + 图标
2. `createFrameTransport()` —— 与 UI 无关的传输层：WS 优先、`/frame` 80ms 轮询回退、重连、帧元数据、实测统计
3. `DebugView` 组件 —— 顶部环境栏 / 工具栏 / 尺寸栏 / 预览区 / 底部状态栏；只消费 transport 的帧与状态
4. `apply(ctx)` —— 面板、菜单行、右栏页签注册

`DebugView` 与 `MoreRow` 各自渲染一份 `<style>`（原因见 [dsh-integration.md](dsh-integration.md)）。
