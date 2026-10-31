# DSH 集成要点（已踩的坑）

> 索引：[docs/index.md](index.md)

## 服务与注册

- `ctx.get('layout')` / `ctx.get('sidebarRightTabs')` 在 `apply()` 执行时**返回 undefined**（服务未就绪）。取 `layout` 要放在点击回调里；注册右栏页签类型要用 `ctx.inject(['sidebarRightTabs'], (sub) => …)`。
- 「更多」下拉的行来自 `sidebar.panellist.actions`，点击用 `ctx.layout.selectPanel('ui-testing-browser')` 打开面板；面板本体注册在 `main`，键为 `ui-testing-browser`。
- 右栏页签 = `sidebarRightTabs.register({ id, kind, priority, title, guide })` + 正文注册到 `sidebar.right.pane.tab`（key = id）。

## 样式

- 插槽注册的组件**必须自带样式**：菜单行 `MoreRow` 不在面板里渲染，若把 `<style>` 只放在 `DebugView` 里，该行会退化成浏览器默认按钮样式（`display:block`、`border:2px outset`、文字居中）。
- 宿主菜单项实测几何：高 34px、`padding 6px 8px`、`gap 6px`、`border-radius 12px`、字号 13/行高 20、hover 底色 `rgba(164,183,229,.14)`。与宿主行对齐时照抄这些值。

## 安装与生效

- 若安装被 pnpm 供应链策略挡住（`ERR_PNPM_MINIMUM_RELEASE_AGE_VIOLATION`，报的通常是**已有旧依赖**而不是本插件）：临时在 profile 的 `pnpm-workspace.yaml` 加 `trustLockfile: true` 完成安装，**装完立刻改回**。pnpm 11.7 的锁文件复检不认 `minimumReleaseAgeExclude`。
- 新装 bundle 需要重启 DSH 才生效（首装 + `package-moved`）；之后改 `client.js` 是热更新。
