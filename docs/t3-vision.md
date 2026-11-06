# 静态视觉

T3 对**有限张静态 PNG** 做确定性处理、识别、坐标输入与比较。六个工具，纯 JavaScript、零 npm 依赖，**没有 VLM/OCR 与语义命名**。

## 源图

```text
Source = { kind:"live", scale?:0.1–4, region?:画布CSS Rect（O=0 时与文档相同） }
       | { kind:"product", productId:"v1_<32hex>" }
       | { kind:"baseline", name, revision? }
```

- 不接受任意文件路径、URL、附件 ID 或调用方 base64，也不从附件服务反读图像。
- `live` 省略 `scale` 时使用本次调用开始时冻结的共享 `view.scale`。
- `product` 按工作区隔离：每 scope 16 张、合计 128 MiB、单张 32 MiB / 16M 像素；页面导航或关闭后仍可离线分析，但 `act` 的可操作资格失效；不跨重启恢复。

## 六个工具

| 工具 | 用途 | 关键约束 |
| --- | --- | --- |
| `browser_vision_image` | 裁剪、缩放、预处理、统计、识别、标注并交付 PNG | 处理顺序固定：source → crop → resize → preprocess → 统计/识别 → 标注 → 编码；分析与识别在标注之前 |
| `browser_vision_find` | 颜色/连通域/边缘/模板定位 | 无匹配是**成功空列表**；`semanticName` 恒 `null`，候选不是可操作 ref |
| `browser_vision_compare` | 两图 YIQ 差异与标注差异图 | 两图必须同像素尺寸，否则 `VISION_SIZE_MISMATCH` |
| `browser_vision_act` | 按截图坐标派发真实输入 | 六步校验全过才派发，任何一步不过**零派发**；`verdict` 固定 `INCONCLUSIVE(dispatch-only)` |
| `browser_vision_baseline` | 受管基线的增删改查 | 不可变 revision、HEAD CAS、删除是墓碑 |
| `browser_vision_check` | 回归与六类缺陷用例 | 整批先纯参数校验再逐 case 执行；不导航、不建基线、不读 DOM |

## 算法

- **差异**：固定 `yiq-v1`，输出完整尺寸的标注 PNG（红=差异、黄=抗锯齿、灰=mask、蓝=区域 bbox）；`similarity` 是阈值化差异覆盖率，不是语义相似度。
- **识别**：颜色阈值、连通域、Sobel 边缘、模板匹配；只回答「像素上像什么」，不回答「这是什么元素」。
- **坐标**：`find` 的候选坐标始终相对完整源图（ROI 原点已回加）；`documentCss` 由 mapping 换算，可为负；blank 区域 `documentCss=null`。
- **基线**：`<持久根>/output/vision-baselines/<scopeHash>/<name>/{images,heads}`；HEAD 是连续 revision + 父 hash 链；读取时校验 PNG hash 与元数据，损坏报 `READ_FAILED`。

## 结论规则

`ok:true` 只表示工具完成，**`verdict` 才是断言结论**：

```text
FAIL > BLOCKED > INCONCLUSIVE > WARN > PASS
```

- `required` 事实缺失或来源不匹配 → `INCONCLUSIVE`/`BLOCKED`，不能降级成 PASS。
- `advisory` 事实最多给 `WARN`。
- 全 mask 无分母 → `VISION_EMPTY_COMPARISON`，不返回 `similarity:1`。
- 证据超过 262144 字节会被截断并标记；若截断丢失必需依据，PASS 降为 `INCONCLUSIVE`。

## 证据

成功时带 `evidence.vision.version=1`（`provenance/source/coordinateSpace/regions/metrics/baseline/facts/verdict/dispatch/output/escalation/incomplete/truncated`），失败时在 `BrowserError.details.evidence.vision`。`facts` 一律 `trusted:false`——由调用方声明，T3 不重新查询 DOM。

## 推荐流程

```text
browser_vision_image      # 取 product + 统计
browser_vision_find       # 可选：确定性定位
browser_click / browser_vision_act   # 执行动作
browser_vision_image / browser_vision_compare   # 前后对比
browser_vision_baseline create → browser_vision_check   # 建基线并做回归
```

## 错误

| 错误码 | 含义 |
| --- | --- |
| `VISION_SIZE_MISMATCH` | 比较的两图尺寸不同 |
| `VISION_EMPTY_COMPARISON` | 全部被 mask，无有效分母 |
| `VISION_HIT_MISMATCH` | act 复验失败（含 `blank-area`） |
| `VISION_STALE_IMAGE` | 截图过期，需重新采集 |
| `VISION_BASELINE_CONFLICT` | 基线 CAS 不匹配 |
| `VISION_BASELINE_NOT_FOUND` | 基线不存在 |
| `INVALID_ARGUMENT` | 参数或源图非法 |

## 边界

- 截图成功、识别到候选、坐标已派发，都**不等于**视觉验收通过。
- 不证明业务正确性、可访问性或整页正确性；只对指定区域/分辨率/阈值下的像素负责。
- 基线目录守卫不抵抗本地恶意进程的 TOCTOU，也不保证网络文件系统上的 CAS。
- 跨 Node/zlib 版本只保证解码像素一致，不保证压缩字节相同。
