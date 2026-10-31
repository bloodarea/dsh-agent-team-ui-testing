# 视觉与动态场景（能力边界）

T3 未实现。browser_screenshot 可保留 PNG base64，并可通过可选附件服务 render image block；缺服务为 base64-fallback 文本，provider 实际可见性需验。原始图像可见仍不提供裁剪/放大/像素差异/基线阈值或 VLM 管线，不能把截图动作成功判为视觉 PASS。定量视觉条件缺乏工具证据时 BLOCKED/INCONCLUSIVE。

T4 未实现。没有 Agent 动画时间轴、连续帧、录屏或运动轨迹工具；面板事件驱动 screencast/metrics 是预览诊断。单帧截图不证明时长、流畅度、丢帧/闪烁，state.seq 不能导出连续帧，eval JS 值不冒充 T4。

报告实际可见性、使用的方法、action/附件证据及未验证部分；未执行 NOT_RUN，能力不足 BLOCKED，部分证据不足 INCONCLUSIVE。无定量证据不能凭主观印象写阈值通过。
