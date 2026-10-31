# 怎么验证（不要靠肉眼猜）

> 索引：[docs/index.md](index.md)

CUA 的后台点击在 Chrome 窗口上落点不稳（会点到相邻行），**优先用无头 Chrome + CDP 读 DOM / computedStyle** 来证明改动生效。

```bash
# 1) 隔离实例：DSH_HOME 独立、profile 软链，不碰用户会话
mkdir -p /tmp/dsh-iso/profiles && ln -sfn ~/.dsh/profiles/web /tmp/dsh-iso/profiles/web
DSH_HOME=/tmp/dsh-iso dsh web --port 3081 --no-open      # 日志里有带 token 的 URL

# 2) token 跳转代理：避免把 token 写进命令
#    小服务 302 到 http://127.0.0.1:3081/?token=… ，浏览器访问 3082 即可

# 3) 无头浏览器
chrome --headless=new --remote-debugging-port=9334 --user-data-dir=/tmp/chrome-iso about:blank

# 4) node 脚本用内置 WebSocket 连 CDP
#    Runtime.evaluate 做点击与测量，Page.captureScreenshot 落地截图
```

## 注意

- 隔离实例默认收起右侧边栏，要先点 `aria-label="打开右侧边栏"` 才能看到「开始」页入口。
- 隔离实例会弹「开始使用」登录遮罩，它**会吞掉真实鼠标事件**；判断"点击没生效"前先确认遮罩是否挡住。
- 用户自己的 3080 窗口里可能正在别的会话上工作，不要长期占用、也不要乱点。
