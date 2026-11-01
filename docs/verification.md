# 怎么验证（不要靠肉眼猜）

> 索引：[docs/index.md](index.md)

优先用**无头 Chrome + CDP 读 DOM / computedStyle / 网络事件**来证明改动生效；CUA 的后台点击在 Chrome 窗口上落点不稳，不作为主通道。

## 本轮 M0–M2 验收边界

真实宿主验证使用用户指定的 **3081 隔离实例**；主 3080 不重启、不操作。下文 3096/临时目录仅是历史隔离搭建示例，不是本轮指定目标。新增检查与当前状态见 [t1-m0-m2-contract.md](t1-m0-m2-contract.md) 与 [t1-http-request.md](t1-http-request.md)：9 工具/运行态 capabilities、分类错误与标题、15s 租约与 anonymous/disposed、跨 session network BUSY、面板队列、abort 关闭再放锁、Document 导航/DNS/最终 URL、脱敏/失败请求/有界资源、action render、截图附件与无服务 fallback、**返回值 lossless JSON 投影与 `output.schema` 白名单**、**N2 输入事件与页面真值**、**P22 独立 HTTP**。provider 图像可见性必须在真实 Agent 中单独确认。本轮主验收 **22/22 组、303/303 必需项、0 failed/skip、exit=0**（P22 95/95），报告 `runs/2026-10-31T13-08-56-816Z-277736/run-report.json`；故障注入单测 16/16、exit=0；隔离宿主 `verify-3081` **22/22**（`runs/host-3081-1793452433416/report.json`），3081 终版已由 **Lead 独立终验** 通过：pid <pid>（18:36:21 启动；index.js `fe870ee1…a38b3`/18:19:00、client.js `f03a1c2d…681edf`/18:01:07；报告 `environment.build.loadedBuildMatchesWorkspace=true`、`editedAfterStart={}`）：`verify-3081.mjs` **22/22 PASS、exit=0**（runs/host-3081-1793445523902/report.json，`observations.navigateResponseHistory={available:true,index:1,length:2,canGoForward:false}`），`address-history-3081.mjs` **276/276 PASS、exit=0**（runs/address-history-2026-10-31T11-18-49-001Z-243848/report.json）。执行者 2 硬化脚本后另有**连续 3 次 276/276**（11:11:06 / 11:11:49 / 11:12:31）与 B1/G1 专项各 12/12（runs/address-history-2026-10-31T11-13-57-368Z-237117、runs/address-history-2026-10-31T11-15-23-028Z-240144）。 此前 GUI 脚本偶发（Lead 复跑 255/260：B1 首次面板提交用了旧地址、G1 blur 未取消草稿）的根因是**环境/脚本，不是实现缺陷**：隔离实例 DSH Web shell 的账号登录/onboarding 对话框异步挂载时，Modal 的 `autoFocus` 关闭按钮抢走面板地址栏焦点（终验报告 `environment.dialogsDismissed=2`）。脚本硬化：交互前清理 shell 对话框、强制 blur→focus 循环、草稿稳定性门 + 提交恢复链（`focusStealRetries`/`enterFallback` 计数）、B1 navigate 统计窗口边界、G1 失败自证；未放宽断言、未改实现；硬化后无未解释项。 Lead 主验收（同一代码，docs 改动前）：`run.mjs` **21/21 组、196/196、0 finding、exit=0**（runs/2026-10-31T10-45-41-877Z-211748）；`runtime-faults.test.mjs` 16/16；`check-skill.mjs` 23/23；`check-skill-registry.mjs` 17/17。 真实 Agent 会话内 8 工具已在 3080 真实调用（由此发现并修复宿主 lossless 阻断），但 provider 可见性仍 NOT_RUN。

**两条踩坑提醒**：① `verify-3081.mjs` 顶层直接执行，不要用 `import()` 做"语法检查"，否则会真实驱动 3081（现已加 import 守卫）；② fake-ctx 验收不经过宿主的 lossless JSON 校验，真实会话里截图/网络/eval 曾因此整体失败——新增工具或改返回体必须过 P21。

## 1. 主机侧验收（不启动 DSH）

```bash
node tests/acceptance/run.mjs                    # 主验收：22 组 / 303 项必需检查（含 P22 独立 HTTP 95 项）
node tests/acceptance/workspace-isolation.test.mjs # 按工作区 page 隔离：77 项（真实 Chromium + fake ctx；含 scope/lease/frame/idle/上限/身份矩阵）
node --test tests/acceptance/runtime-faults.test.mjs  # CDP 故障注入与 Runtime 边界（16 项；rm 竞态已修，DNS 用注入 resolve 固定）
node tests/acceptance/check-skill.mjs            # Skill 结构/引用/工具名一致性（23 项）
node tests/acceptance/check-skill-registry.mjs   # 真实 DSH SkillRegistry 注册/发现/加载（17 项）
node tests/acceptance/verify-3081.mjs            # 真实隔离宿主 legacy HTTP 集成（22 项，含认证/UI 投影与输入回归）
DSH_3081_HOME=/tmp/dsh-utb-home node tests/acceptance/workspace-isolation-3081.mjs # 真实 3081：17 项 scope/WS/frame/close
DSH_3081_HOME=/tmp/dsh-utb-home node tests/acceptance/gui-workspace-3081.mjs       # 真实 3081 GUI：两个注册工作区/会话、main/右栏 scope、WS、隐藏停播
DSH_3081_HOME=/tmp/dsh-utb-home node tests/acceptance/address-history-3081.mjs   # 真实 3081 GUI：地址栏/刷新/后退前进（scope 头取自 main 面板，只连 3081）
```

- 3081 脚本都**不会自己重启实例**，也不会启动替代 DSH：必须先重启 3081 让新 `index.js`/`client.js` 生效，再用它们取证。`workspace-isolation-3081`/`gui-workspace`/`address-history` 都要显式 `DSH_3081_HOME=/tmp/dsh-utb-home`，不要继承调用者的 `DSH_HOME=<local-path>/.dsh`；否则会读真实 3080 的 workspace/session store。
- `verify-3081.mjs` 现在先交换一次 launch token → 内存 cookie，之后所有请求带 cookie（原 14 项断言不变并追加 authenticated `ui.version=1`、停止态空地址、未认证无 `ui`/无 raw、`/reload` `/history` 未认证 401/403）。`address-history-3081.mjs` 用独立无头 Chrome 从 `about:blank` 启动，token 只经内存读取与 `Page.navigate` 传入。
- 3081 重启（第 5 轮实测）：`/tmp/dsh-iso` 的 `profiles/web` 曾指向真实 `~/.dsh/profiles/web`（symlink，写入会 EACCES），不要再用。用复制 profile 的隔离 home：`/tmp/dsh-utb-home/profiles/web`（复制 package.json/cordis.patch.yml/compatibility.json/pnpm-lock.yaml/cordis.yml，`node_modules` 软链真实依赖；home 下复制 credentials/presets/storages/sessions）。启动：`env -u DISPLAY -u WAYLAND_DISPLAY DSH_HOME=/tmp/dsh-utb-home DSH_PROFILE=web DSH_WEB_URL=http://127.0.0.1:3081 DSH_UI_TESTING_CHROME=tests/acceptance/chrome-wrapper.sh dsh web --port 3081 --no-open > /tmp/dsh-3081.log`；`-u DISPLAY` 让 directory picker 走 browse（native zenity 不在 DOM）。只对该 PID `kill -TERM`，禁止 `pkill dsh/node`；token URL 只由脚本内存读取，不要 cat/回显。

`run.mjs` 用 fake Cordis ctx 调真实 `apply()`，启动真实无头 Chromium 与自建靶机；每次写入独立 `tests/acceptance/runs/<时间>-<pid>/`，不覆盖历史 `evidence/`；进程归属按 `/proc/<pid>/stat` 的父 PID 绑定本次测试 Node，避免把并行的其他 Chromium 算入本次或误清理。帧推送探针会另起一个真实 `node:http` server 并挂上插件的 upgrade handler，用 Node 22 原生 WebSocket 客 户端验证握手/鉴权/二进制帧/close。

## 2. 真实浏览器回归（隔离 DSH + 无头 Chrome）

```text
# DSH_HOME 独立；在 DSH 文件沙箱内不能直接写 ~/.dsh/profiles/web/cordis.yml，
# 所以复制 profile 文件、只软链 node_modules：
/tmp/dsh-real/profiles/web/{package.json,cordis.patch.yml,compatibility.json,pnpm-lock.yaml,cordis.yml}
/tmp/dsh-real/profiles/web/node_modules -> ~/.dsh/profiles/web/node_modules
DSH_HOME=/tmp/dsh-real dsh web --port 3096 --no-open
# 日志里有带 token 的 URL；脚本自行读取，不要把 token 写进命令行/仓库

# 无头 Chrome（DSH 文件沙箱内需要 --no-sandbox/--disable-dev-shm-usage/--disable-crash-reporter，
# 用 tests/acceptance/chrome-wrapper.sh；Chrome 端口用 DevToolsActivePort 自取）
chrome --headless=new --remote-debugging-port=0 --user-data-dir=/tmp/chrome-real about:blank
```

然后用 CDP（Node 内置 WebSocket）依次：

1. `Page.navigate` 到 token URL；
2. 点 `aria-label="更多"`，再点文本为 `调试视图` 的行（面板出现 `.utb`）；
3. `POST /plugins/ui-testing/navigate` 指向 `tests/ui_test_fixture` 的 URL（不需要 GUI 输入）；
4. 断言 `.utb-frame` 的 `img.src` 是 `blob:`、`naturalWidth = 1280`、`.utb-perf` 有 `N FPS M ms`；
5. 点工具栏 `aria-label="尺寸调整"`，断言 `.utb-zoom` 显示自动百分比且「适应窗口」勾选；把 `.utb-zoom` 改成 60，断言勾选自动取消、`.utb-box` 宽高 = 视口 × 0.6；再点勾选框，断言恢复自动百分比与自动宽高；
6. `Network.webSocketCreated` 里应出现 `/plugins/ui-testing/frames`；
7. `GET /plugins/ui-testing/metrics` 应有 `host.captured/pushed/clients` 与 `client.transport="ws"`、`endToEndMs`；
8. 连续 `POST /eval` 改页面（制造 damage）后读 `.utb-perf`，确认 FPS/延迟来自**实际显示**；
9. 验证轮询回退：`Page.addScriptToEvaluateOnNewDocument` 把目标 URL 的 `new WebSocket` 改成抛错 → `Page.reload` → 重复 3–8，此时 `client.transport="poll"`、`host.clients=0`（若 3081 上有外部 viewer 则不会为 0，见文末注意）、延迟应高于 WS。

可选脚本：`node tests/acceptance/real-browser-ws.mjs`（带清理；不得触碰用户的 3080/3081）。

## 注意

- **同一时间只允许一个驱动者**：`verify-3081.mjs` 与 `address-history-3081.mjs` 都会驱动 3081 的同一个浏览器（导航/输入/`/close`）。并发运行、或在一个脚本运行期间重启 3081，会让两边结果全部作废——本轮实测踩过（GUI 脚本 15 条失败、verify 结果不可用）。验收窗口内不要重启、不要额外发 `/navigate` `/reload` `/history` `/input` `/eval` `/close`。
- 隔离实例默认收起右侧边栏；`更多` 下拉在左侧，菜单行文本是「调试视图」。
- 隔离实例可能出现「开始使用」遮罩；判断"点击没生效"前先确认遮罩是否挡住。
- 沙箱内 Chrome 直接启动会失败（setuid sandbox / `/dev/shm`），套件会自动回退 `chrome-wrapper.sh`，并把 `environment.chromePlan` 写进报告。
- **不要在 3081 上断言 `host.clients` 的绝对值为 0**：3081 可能长期连着外部 viewer（用户自己的 3080 浏览器、旧 headless `/tmp/chrome-iso2`），本轮的基线实测就是 1；而正常 GUI reload（即使拦掉 `/plugins/ui-testing/frames`）在私有实例上实测会回收为 0。另有一个既有缺口：没有 WebSocket Close 帧的粗暴断开会让服务端 socket 停在 `CLOSE-WAIT`、frame-push 不回收该 client（`MAX_CLIENTS=8`，`frame-push.js` 本轮未改）；要测该计数请用增量或私有实例。
- 观察到一次环境相关的瞬时失败：`P8-close-resources` 的"关闭后临时 profile 目录被删除"在 8s 预算内判失败（有 Chromium 退出/目录重建竞争），随后两轮全绿；报告 `runs/2026-10-31T10-15-24-114Z-184962`。复跑前先确认没有残留 Chromium 在占用 `/tmp/dsh-ui-testing-*`。
- 用户自己的 3080 窗口里可能正在别的会话上工作，不要长期占用、也不要乱点；插件 Host 改动必须重启 DSH 才生效。
- **第 5 轮 3081（工作区隔离）**：listener pid <pid>，22:57:39 启动，home `/tmp/dsh-utb-home`；`loadedBuildMatchesWorkspace=true`、`editedAfterStart={}`。`workspace-isolation-3081` 17/17（`runs/host-3081-workspace-1793458998884/`）、`gui-workspace-3081` 45/45（`runs/gui-workspace-2026-10-31T15-33-53-964Z-381563/`）、`address-history-3081` 278/278（`runs/address-history-2026-10-31T15-34-45-025Z-382205/`，与 main 面板同 session scope）、legacy `verify-3081` 22/22（`runs/host-3081-1793458887176/`）。**3080 仍是旧构建（pid <pid>，19:36:05）**；要加载工作区隔离需用户重启 DSH。
- 地址/历史的主机侧核验（真实 Chromium + fake ctx）可参考本轮临时脚本思路：`/state` 带认证假 `connection` 时取 `ui.address`，断言 pushState/replaceState/hash、真实 back/forward、reload 不新增历史、redirect 最终地址、`/frame` 两个分支同形 `ui`、close 清空；这类脚本不入库，最终证据以 `address-history-3081.mjs` 的 `runs/` 报告为准。
- 同样的思路可以起一个**私有隔离 DSH 实例**（临时 DSH_HOME + 复制 web profile + 软链 node_modules，端口避开 3080/3081）做 GUI 冒烟：本轮用无头 Chrome 打开 `更多 → 调试视图` 后 19/19 通过——冷启动地址空/三按钮禁用、地址跟随真实导航与 `pushState`、面板后退/前进按真实 CDP 历史、草稿跨 3 次轮询不被覆盖、blur/Escape 恢复已接受地址、刷新复位文档且 URL/历史长度不变、面板提交显示 redirect 最终地址。**这不是 3081 证据**，不能替代 `address-history-3081.mjs`，也不要把私有实例端口写成 3081。
