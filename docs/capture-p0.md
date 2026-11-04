# 截图与图片交付

`browser_screenshot` 是 P0 采集基础设施的入口：截一张经过校验的 PNG，并给出可复核的映射与像素统计。它**不做**视觉判断——那属于 [静态视觉](t3-vision.md)。

## 参数

| 参数 | 说明 |
| --- | --- |
| `scale` | 0.1–4 的连续值；省略时解析为当前共享 `view.scale`（冷启动为 1） |
| `region` | 画布 CSS 像素矩形，宽高 ≥1；省略则截当前视口 |
| `persist` | 显式要求持久化；默认暂存 |
| `out` | 工作区相对的 `.png` 路径，提供即视为持久化 |

## 输出与证据

返回体包含 PNG 的 base64、`sha256`、尺寸、附件元数据，以及 `capture.version=1` 的结构化证据：

| 字段 | 内容 |
| --- | --- |
| `capture.request` | 实际生效的 scale、`scaleSource`（`explicit`/`view`）、`viewRevision`、region、画布空间 |
| `capture.mapping` | 文档/画布/视口之间的映射，逐轴 `cssPerPixel`、`scrollAtCapture` |
| `capture.canvas` | `composite` 与 `contentRect`；`O ≠ 0` 时为 `true` |
| `capture.anomaly` | 全量像素统计：`uniform`、`transparent`、`maxDelta`、`averageColor`、`distinctColors` |
| `capture.file` | `pathKind`（`relative`/`absolute`）、`persistence`、`relativePath` |
| `warnings` | 封闭词表内的警告，不猜测 |

`anomaly` 对 ≤16,000,000 像素做**全量扫描**（不是抽样），因此「纯色/空白」结论可靠；超过预算会明确拒绝而不是降级抽样。

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
| `BUSY` | 工作区页面被其他 owner 占用 |

## 边界

- 截图成功**不等于**视觉验收通过；需要结论请用 T3 的 `verdict`。
- 截图内容不脱敏；分享前请自行检查。
- 返回图片附件不等于 provider 一定以原始分辨率收到图像。
- 画布合成路径会重编码，因此 `O ≠ 0` 时不要断言 PNG 字节稳定；需要字节级稳定时保持 `O = 0`。
- 高 DPI 只提升 DOM/CSS/文字与矢量的光栅密度，Canvas/WebGL 的内部位图不会变清晰。
