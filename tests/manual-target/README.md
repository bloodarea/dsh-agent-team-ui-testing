# 人工验收靶机

浏览器里人工操作的验收页面，自己判定事件与 `computed` 值，不需要任何人做口头结论。

## 起服务

在本仓库根目录：

```bash
python3 -m http.server 8130 --bind 127.0.0.1
```

然后在调试视图里打开 `http://127.0.0.1:8130/tests/manual-target/input-cursor-target.html`。

## 两个页面

| 文件 | 用途 |
| --- | --- |
| `game-target.html` | **游戏靶机**：① WASD 八方向斜向移动（多键组合，含"斜向不加速"）② FPS 视角 + 指针锁定打靶（鼠标相对移动）。右上角 8 项自评分数，`window.__target.report()` 可读 JSON |
| `input-cursor-target.html` | **能力清单靶机**：逐项列出多键同按、修饰键合成、自动重复、movement 增量、指针锁定、10 种光标形状与 `url()` 白名单 |

两个页面都由页面自己监听 DOM 事件 / 读 `computed` 值来判定，不依赖任何人的口头结论；自动化回归见 `tests/acceptance/game-target.mjs`（同一份 HTML，13 项断言跑到自评 8/8）。

## 覆盖的能力

| 组 | 条目 | 谁操作 |
| --- | --- | --- |
| 键盘 | 三个键同时按住、松开后归零、修饰键进到事件里、松开后不再带位、`autoRepeat` 透传 | 👤 人 + 🤖 Agent |
| 鼠标 | 页面收到 `movement` 增量、进入指针锁定、锁定期间准星靠增量移动、按住修饰键的鼠标按下 | 👤 人（指针锁定必须真实点击） |
| 光标 | 10 个 `cursor` 磁贴的 `computed` 自检、`url(...)` 光标不落到预览 | 👤 人看预览 + 页面自检 |

页面右上角的分数就是判定结果，全部变绿即通过；`window.__target.report()` 可读出逐项 JSON（Agent 用）。
