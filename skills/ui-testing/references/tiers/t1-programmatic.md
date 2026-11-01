# T1 · 程序化接口（M0–M2）

部分实现；**工具面 29 个 = 本文的 T1 9 个（含独立 HTTP `browser_http_request`）+ T2 7 个**（见 [T2 表](t2-structured.md)）**+ T3 6 个**（见 [T3 表](t3-static-visual.md)，权威契约 `docs/t3-vision.md`）**+ 网络 P0 7 个**（`browser_network_session`、`browser_network_events`、`browser_network_detail`、`browser_network_trace`、`browser_network_control`、`browser_network_evidence`、`browser_network_subscribe`，权威契约 `docs/network-p0.md`）。注册表决定可调用名字，browser_capabilities 报实际运行态三态；静态工程状态不能当 available。验收：M0–M2 的 P1–P21 加上 P22（独立 HTTP），具体计数与结论以仓库 runs/ 报告为准；T2 优化构建套件已跑绿（37/38 探针、**260/260** 必需检查、criteriaCovered 38、exit 0，报告 `tests/acceptance/runs/2026-11-01T03-41-31-025Z-39784/run-report.json`；套件内 C38 真实宿主/声明为 NOT_RUN，属 fake-ctx 套件边界），真实宿主 14/14 记录见 `tests/acceptance/evidence/t2-real-host-2026-11-01.md`（属优化前构建，优化后待定向复验）；provider 图像可见性仍 NOT_RUN。详细返回见 [操作契约](../contracts/operation.md)。

| 操作 | 工具 | 关键边界 |
| --- | --- | --- |
| 导航 | browser_navigate | errorText/最终 URL/目标与 DNS/Document 重定向校验，不保证 load complete |
| JS | browser_eval | 顶层主世界，可序列化值；页面异常 error 对象含描述/栈/位置 |
| 截图 | browser_screenshot | P0：连续scale1–4、region文档CSS px、out相对.png；PNG CRC/尺寸/全量均匀统计、JSON mapping、安全落盘与附件metadata证据；保留base64/附件fallback；provider另验，无T3分析 |
| 输入 | browser_input | applied 是数量，不证明生效；支持 modifiers（数组或 CDP 位掩码）、key 的 virtualKeyCode/autoRepeat 等、mouse 的 buttons/pointerType；无焦点管理工具与高层动作 |
| 网络（旧工具） | browser_network | 响应与 loadingFailed 元数据、URL 脱敏、有界 300 条；**无头/正文**；其他 owner BUSY。深度采集/控制看下一条 |
| 网络（P0 七工具） | browser_network_session · events · detail · trace · control · evidence · subscribe | `action` 必填；HTTP/HTTPS 请求响应与头/体（按需、配额截断、读不到 `available:false`）、WebSocket 双向帧、SSE、same-origin iframe/OOPIF/Worker、统一时间轴与分析聚合、业务步骤链路、拦截/限速/断连/重放/Mock、JSONL+HAR 与多 Agent 独立订阅；只读/诊断不启动浏览器，`session.start` 与需 page 的 `control` 才懒启动；`G1.5` partial（same-origin iframe + dedicated worker 已实证；OOPIF partial；shared/service worker 不采集）、HTTPS 未独立验收（`limits.network.https="mechanism-identical"`）、`responseModification` 条件支持（C37 NOT_RUN）、真实宿主重启后 NOT_RUN；套件 verified：52/52 criteria、266/266 required、notRunChecks 8、exit 0 |
| CSSOM | browser_computed_style | 首匹配，未命中 error 对象；无伪元素/iframe/Shadow DOM 内部定位 |
| 状态 | browser_state | document.title 刷新与 owner 诊断，不启动/不占租约；error/errorAt/errorActionId/errorTarget 由成功页面操作清空 |
| 独立 HTTP | browser_http_request | Host HTTP(S) 客户端：不启动浏览器/不占租约；默认 GET、5s 总超时、64KiB 保留上限、不跟随重定向；每跳复验目标、无 cookie jar、新错误码 HTTP_TIMEOUT/HTTP_FAILED/HTTP_REDIRECT_LIMIT；`ok:true` 非 2xx |
| 能力 | browser_capabilities | 实际 available/unavailable/unsupported 与原因限制，不启动/不占租约；按段报 T1/T2（7+1）/T3（6+1）/network（7+1，聚合 `web.network.p0`，含必报标量 `limits.network.https:"mechanism-identical"` 与并列的 `responseModification` 实测值），并报 `limits.structuredGui`、`vision`/`limits.vision`、`network`/`limits.network`（T4 仍 unsupported） |

同一时刻一个无头 Chromium/profile；每个 DSH 工作区一个 page。single-owner-lease 按工作区，15s idle、进行中保持、缺 exec 走 legacy、disposed 只释放对应 owner。页面操作与 network（含 network P0 的 session/control 变更）受同工作区租约，network P0 只读/离线动作不加租约；state/capabilities 可诊断。同工作区页面工具与面板同串行队列；已发 CDP 命令后 abort 先关闭该 page 再放锁，后续可懒启动。Cookie/存储共享，非安全隔离。

默认视口1280×800/受控DSF1，Agent无视口工具；P0 scale不改viewport/DSF，输出round(css×scale)且≤16M像素。region为文档坐标，T2 bbox/输入为视口坐标，按scroll转换。页面DPR读取失败null、headlessSource依据product/userAgent；capture JSON mapping不返回函数。persist:boolean默认false；默认staging（包括legacy无cwd）绝对路径/0600/no-clobber/dispose清理，out/persist:true/非空env才persistent相对路径；file含pathKind/persistence/root/ephemeral，observed不含绝对路径；持久无根报root_unknown、tmp失败仅warning。安全规则见 [安全边界](../core/safety.md)；observed不启动、只代表上次真实截图。当前P0暂存修订14/14、142/142见 [T1台账](../../knowledge/web/t1-capability-ledger.md)，宿主P0重载/provider仍NOT_RUN。页面工具可懒启动，network/state/capabilities 不启动。CDP 超时、断连和取消有分类错误，pending timers 清理；close 清空网络/请求/URL/标题/帧并清进程/profile。

安全策略见 [安全边界](../core/safety.md)：loopback 允许，RFC1918 默认阻断，可显式环境变量开放；Document/DNS/最终 URL 校验不等于对子资源/页面 fetch/WebSocket 的完整网络沙箱，仍有 rebinding 风险。

所有工具 action 元数据进入 render；操作成功与断言分离。网络元数据不证明完整接口契约（接口契约用 `browser_http_request`），CSSOM 不证明视觉，原始截图可见不意味着 T3/T4 已实现。元素语义与元素级交互优先走 T2（`browser_snapshot`/`browser_click`/`browser_type`/`browser_fill_form`/`browser_wait_for`，见 [T2 表](t2-structured.md)）；下载/上传/Cookie 导出、多 target/frame 选择、Agent 视口工具、T3/T4 仍 unsupported。验收状态见 [T1 台账](../../knowledge/web/t1-capability-ledger.md)、[T2 台账](../../knowledge/web/t2-capability-ledger.md) 与 [网络 P0 台账](../../knowledge/web/network-p0-capability-ledger.md)，未有本轮证据前不标 verified。
