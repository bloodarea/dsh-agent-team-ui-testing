# 代码结构

> 索引：[docs/index.md](index.md)

```text
package.json          DSH bundle 清单：dsh.bundle.patch + dsh.client（platform: web）
cordis.patch.yml      插入一行 plugin：id = ui-testing-browser
index.js              Host 半边：无头 Chromium + CDP、HTTP 路由、Agent 工具
client.js             全部 UI（React，无 JSX，用 h()）
locale/{en,zh}.json   插件显示名与描述
icon.svg              插件图标
tests/ui_test_exam/   插件自身能力的盲测靶机（20 处预设缺陷），见该目录 README
reference/            参考资产（目前是内置 Skill 模板包 v1.1，见 skill-authoring.md）
docs/                 项目记忆（本目录）
```

## client.js 内部结构

1. `CSS` 常量 —— 全部使用 `--dsw-alias-*` 主题令牌，不写死颜色
2. 内联 SVG 图标组件 —— 16×16、`strokeWidth 1.7`、`currentColor`
3. `DebugView` 组件 —— 顶部环境栏 / 工具栏 / 尺寸栏 / 预览区 / 底部状态栏；主面板与右栏页签复用同一个组件，状态各自独立
4. `apply(ctx)` —— 三处注册：`main` 面板、`sidebar.panellist.actions` 菜单行、右栏页签类型 + 正文

`DebugView` 与 `MoreRow` 各自渲染一份 `<style>`（原因见 [dsh-integration.md](dsh-integration.md)）。
