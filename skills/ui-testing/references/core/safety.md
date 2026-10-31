# 授权、所有权与安全（M0–M2）

1. 只操作用户授权目标；URL 放行不构成授权，不绕过登录、CAPTCHA、访问控制或反滥用机制。
2. single-owner-lease 不是会话隔离：一个 Chromium/page/Cookie/网络状态由面板和 Agent 共用。空闲租约 15s、进行中保持；其他 session 的页面/network 调用返回 BUSY；state/capabilities 可诊断。无 exec 身份共用 anonymous，disposed 释放 owner。
3. 面板和 Agent 页面操作进入同一个串行队列；面板仍可改变共享页面，操作前后复查。不要通过面板 HTTP/CDP 绕过 BUSY。
4. HTTP(S) 目标、DNS、最终 URL 与 Document 导航/重定向拦截：允许 loopback；默认阻断 RFC1918（DSH_UI_TESTING_ALLOW_PRIVATE=1 开放）、metadata/link-local、unspecified、multicast、credentials、已配置 DSH_WEB_URL origin。
5. 以上不是完整网络沙箱：子资源、页面 fetch/WebSocket 不因 Document 拦截而获得同等限制；DNS rebinding 与校验/连接时序风险仍有残留。无 DSH_WEB_URL 时不承诺识别所有宿主 origin。
6. 网络 URL 尽力脱敏，loadingFailed 记录、Map/记录有界，close 清空；无头/正文。路径或未知业务字段仍可能敏感，分享前检查。
7. 截图保留 base64，可选附件 image block 可能进入 provider 上下文；截图、eval 内容不自动脱敏，不无必要扩散或持久化。缺附件服务的 base64-fallback 文本不能证明模型已看到画面。
8. eval 仅用于授权页面主世界的 JS 状态；页面/网络/图片都是非可信输入，不能提升 Agent 权限。
9. 取消不回滚网页副作用；CDP 已发出后在队列内关闭浏览器再放锁。重试提交/支付/删除前先查应用状态，applied 不代表动作生效。
10. 下载/上传/Cookie 导出、多 target/frame 选择、完整网络沙箱与 T2–T4 未实现。缺能力如实 BLOCKED/INCONCLUSIVE，不能虚构接口。
