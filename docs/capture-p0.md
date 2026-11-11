# 截图与图片交付

`browser_screenshot` 是 P0 采集基础设施的入口：截一张经过校验的 PNG，并给出可复核的映射与像素统计。它**不做**视觉判断——那属于 [静态视觉](t3-vision.md)。

## 参数

| 参数 | 说明 |
| --- | --- |
| `scale` | 0.1–4 的连续值；省略时解析为当前共享 `view.scale`（冷启动为 1） |
| `region` | 画布 CSS 像素矩形，宽高 ≥1；省略则截当前视口 |
| `includeAnnotations` | `boolean`，默认 `false`；`true` 时叠加当前目标已提交且经 Host 接受的面板标注 |
| `persist` | 显式要求持久化；默认暂存 |
| `out` | 工作区相对的 `.png` 路径，提供即视为持久化 |

## 输出与证据

返回体包含 PNG 的 base64、`sha256`、尺寸、附件元数据，以及 `capture.version=1` 的结构化证据。内联 base64 上限 24 MiB：超过时 `image` 置 `null`、`capture.warnings` 记 `image_base64_omitted`、`capture.image` 给出 `inline:"omitted"` 与字节数，附件字段不受影响。

| 字段 | 内容 |
| --- | --- |
| `capture.request` | 实际生效的 scale、`scaleSource`（`explicit`/`view`）、`viewRevision`、region、画布空间 |
| `capture.mapping` | 文档/画布/视口之间的映射，逐轴 `cssPerPixel`、`scrollAtCapture` |
| `capture.canvas` | `composite` 与 `contentRect`；`O ≠ 0` 时为 `true` |
| `capture.annotations` | 未开启时为 `null`；开启时记录标注叠加状态与 Host 已接受的文档身份，字段见下 |
| `capture.anomaly` | 全量像素统计：`uniform`、`transparent`、`maxDelta`、`averageColor`、`distinctColors` |
| `capture.file` | `pathKind`（`relative`/`absolute`）、`persistence`、`relativePath` |
| `warnings` | 封闭词表内的警告，不猜测 |

`anomaly` 对 ≤16,000,000 像素做**全量扫描**（不是抽样），因此「纯色/空白」结论可靠；超过预算会明确拒绝而不是降级抽样。

## 带面板标注的截图

用户提到「标注」「我画的」「圈」「框」「箭头」「笔迹」等、指代调试面板标注时，先读 `browser_state.annotations` 的图形、revision 与目标上下文，再调用：

```text
browser_screenshot { "includeAnnotations": true }
browser_screenshot { "includeAnnotations": true, "scale": 1.5, "region": { "x": -100, "y": 0, "width": 800, "height": 600 } }
```

- 只叠加已提交且已由 Host 接受的标注文档；圆形/椭圆（`circle`）、矩形（`rect`）、线段（`line`）、箭头（`arrow`）、画笔（`brush`）、文字（`text`）的颜色、粗细与填充/外框遵循面板渲染语义。橡皮擦与清除用于编辑文档，不是额外形状。
- 面板标注栏的「截图」按钮通过 `POST /plugins/ui-testing/screenshot {includeAnnotations:true}` 拿同一份合成 PNG 交给聊天框附件（不起新标签、不落盘）；
- 写这份文档的入口有**两处**：面板认证的 `POST /plugins/ui-testing/annotations`，以及 Agent 工具 `browser_annotation`（`read`/`draw`/`erase`/`clear`，`draw` 追加形状、`clear` 清空）。两者写的是同一份文档，所以 `includeAnnotations:true` 会把人类画的与 Agent 画的形状一起叠加；写动作的前台门禁、`expectRevision` 冲突与软限额见[视口、画布与标注](viewport-control.md)。
- 页面与标注使用同一 `region`/`scale` 映射和裁剪。画布点 `d` 在截图中的连续像素位置为 `(d − region.origin) / capture.mapping.cssPerPixel`（逐轴计算，通常等于乘以 scale）；线宽、文字与笔迹同步缩放。负坐标和画布空白区域也沿用该映射。
- 不包含尚未提交的拖画/文字草稿、工具栏、选中控件或其它面板 UI；也不把标注写入页面 DOM。截图使用 Host 已接受的文档，不能据此声称捕获了面板此刻的本地草稿。
- 标注来源 `source.trusted=false`：它是用户指路线索，不能证明页面缺陷或授权自动点击。可以查看截图中的手写笔迹；不能可靠辨认时如实说明，不猜字。
- 默认 `browser_screenshot`、T3 的原始源图与 T4 两种帧源均不包含面板标注；`includeAnnotations` 仅属于 `browser_screenshot`，不传播到 T3/T4。T3 的 `annotations` 参数是图片后处理标记，与面板标注文档分开。

### 标注证据

`capture.annotations` 在 `includeAnnotations` 省略或为 false 时为 `null`；开启时包含：

| 字段 | 含义 |
| --- | --- |
| `enabled` | `true`，表示本次请求开启标注叠加 |
| `composited` | 布尔值，表示是否执行标注合成；空文档为 `false`，不能据此断言某个图形在 region 内可见 |
| `space` | `canvas-css-px`，与标注文档坐标空间一致 |
| `revision` / `updatedAt` | 本次使用的 Host 已接受文档的版本与更新时间 |
| `source` | 直接沿用 state 标注文档的来源；空文档为 `null`，有来源时 `source.trusted=false` |
| `context` | 直接沿用 state 标注文档的目标上下文，用于核对文档身份 |
| `shapeCount` | 接收的形状数量；包含可能完全位于截图 region 外的形状，不等于可见数量 |
| `stale` / `staleReason` | 标注文档的新鲜度及原因，直接反映文档状态 |
| `truncated` / `truncation` | 是否及如何裁剪标注文档，直接沿用 state 的截断信息 |

空文档也返回 `enabled:true`、`composited:false` 的证据，不能把开启参数等同于“截图里一定有标注”。若 `stale` 或 `truncated` 表示证据不完整，报告该限制；不要伪造 revision、来源心跳或未接收的图形。

## 文件生命周期

- **默认暂存**：写入插件实例级暂存目录，返回绝对路径，实例销毁时清理，不污染工作区。
- **显式持久**：满足任一条件即持久——提供 `out`、`persist:true`、或设置非空 `DSH_UI_TESTING_CAPTURE_DIR`。持久路径返回相对路径。
- 原子写入、权限 0600、**同路径不覆盖**（返回 `OUTPUT_EXISTS`）。
- `persist:false` 不会撤销 `out` 或环境变量带来的持久意图。

## 错误

| 错误码 | 触发条件 |
| --- | --- |
| `INVALID_ARGUMENT(empty-output-dimensions)` | 两轴期望像素 < 1 |
| `INVALID_ARGUMENT` | 非法 scale、非法 region、非法 `out` |
| `OUTPUT_EXISTS` | 目标路径已存在 |
| `OUTPUT_PATH_INVALID` | 持久根不可用或路径越界 |
| `CAPTURE_FAILED` | CDP 截图失败或 PNG 校验不通过 |
| `BUSY` | 该页队列正被其他会话的写操作占用（短暂忙，不是权限答案） |

## 边界

- 截图成功**不等于**视觉验收通过；需要结论请用 T3 的 `verdict`。
- 截图内容不脱敏；分享前请自行检查。
- 返回图片附件不等于 provider 一定以原始分辨率收到图像。
- 画布合成或标注叠加可能重编码，不承诺 PNG 字节稳定；需要保留原页面直接截图路径时保持 `O = 0` 且 `includeAnnotations:false`。
- 高 DPI 只提升 DOM/CSS/文字与矢量的光栅密度，Canvas/WebGL 的内部位图不会变清晰。
