# P0 采集基础设施契约

> 索引：[index.md](index.md) · 2026-11-01 · 本文是 `browser_screenshot` P0 的权威实施与验收契约，已纳入 Lead 的接口裁决。本文属于静态设计交付；实现、运行验收与已加载构建须由执行报告另证。§9.1 的事实来自 Lead 提供的 Chrome 152 / Linux headless 实测记录，本文作者未重新运行这些实验。现行 T1/T2 基线见 [T1 契约](t1-m0-m2-contract.md)、[T2 契约](t2-structured-gui.md) 与 [状态记录](status.md)。

## 1. 范围与运行不变量

P0 提供 Web T1–T4 可复用的**采集、校验、落盘与证据**基础设施。只扩展已有 `browser_screenshot`，不新增工具，工具总数仍为 16。P0 不实施视觉判断、基线差异、可读性判定、VLM 分析、连续帧或时序分析；`content_uniform` 等像素统计警告不是页面视觉 FAIL。T3/T4 仍 `unsupported`，不能因本契约、截图成功或高 DPI 输出而升级。

沿用一个 headless Chromium/profile、每工作区一个 page Runtime，以及既有可信 exec scope、页面串行队列、single-owner-lease、BUSY 与取消清理。PNG 采集不替换 JPEG screencast 预览管线，不改面板视觉、文案或交互。只使用 CDP 与 Node 内建模块，保持 ESM、零新增运行时依赖。

保存本文与索引不需重启；后续 Host 模块、工具参数与 bundled Skill 修改需要重启 DSH 才能由宿主加载。文档或测试进程加载成功不能证明现有宿主已加载新构建，不能因此授权重启用户实例。

## 2. 工具参数与兼容性

### 2.1 `browser_screenshot` 参数

参数均可省略，注册 schema 的 `required:[]` 保持不变。范围与类型由执行层校验；不隐式转换、不 clamp，不把宿主不支持的 schema 关键字当作执行校验。

| 参数 | 类型、默认与边界 | 语义 |
| --- | --- | --- |
| `scale` | finite number，默认 1，连续区间 `[1,4]` | CDP `clip.scale`；1.11、1.25、1.5 等小数合法；字符串、NaN、越界为 `INVALID_ARGUMENT` |
| `region` | 可选 `{x,y,width,height}`；四项均为有限数，`width/height >= 1` | 文档 CSS px 矩形；字段使用 `width/height`，不使用 `w/h`；省略时取采集前现场 layout viewport 的文档原点和大小 |
| `persist` | boolean，默认false；非布尔为INVALID_ARGUMENT | true表示持久留存；false不取消out/env表达的持久意图 |
| `out` | 可选string，持久根相对POSIX路径，以`.png`结尾 | 提供即请求持久留存；持久模式省略out时用`output/capture/<actionId>.png`；无持久意图默认暂存，见§6 |

纯参数预检先于懒启动、CDP 截图和文件创建。可由参数直接判定的像素超预算同样提前失败；默认矩形须先读现场 viewport，随后在 `Page.captureScreenshot` 前完成预算检查。合法路径所需的目录创建只能在参数预检之后进行。

默认 CSS viewport 为 1280×800、受控 `deviceScaleFactor=1`。`browser_screenshot {}` 在该视口输出 1280×800 PNG；若所属 Runtime 已由 GUI 修改 viewport，默认截图跟随该 Runtime 的现场视口，不暗中重置为 1280×800。旧调用继续保留 `viewport/bytes/image/capturedAt/sha256/attachment/attachmentId/imageDelivery/attachmentError` 与原有 action envelope；原始 `image` 仍为 PNG base64，附件服务缺失时保持 `base64-fallback`。

### 2.2 尺寸与资源预算

```text
p = scale × deviceScaleFactor
expected.width  = Math.round(region.width  × p)
expected.height = Math.round(region.height × p)
expectedPixels  = expected.width × expected.height
```

本插件固定受控 `deviceScaleFactor=1`，因此 `p=scale`。预算按**舍入后的输出像素数**计算，上限 16,000,000；不是只限制 CSS 面积。计算中间值非有限、溢出或超过预算必须拒绝，不能等分配大图后再判定。连续 scale 的舍入按上述公式，不收窄成离散档位。

## 3. 单一采集路径与坐标语义

### 3.1 CDP 路径

采集前读 `Page.getLayoutMetrics` 的 `cssLayoutViewport`（`pageX/pageY/clientWidth/clientHeight`）与 `cssVisualViewport`，并读取页面 `window.devicePixelRatio`。后者是现场观测，失败为 `null`；期望尺寸使用 Runtime 已设置的 DSF=1，并记录 `deviceScaleFactorSource:'runtime-override'`，不能把回退值伪装成读回事实。

有效矩形 `R` 为显式 `region`，或 `{x:pageX,y:pageY,width:clientWidth,height:clientHeight}`。只调用一次：

```text
Page.captureScreenshot({
  format:'png', fromSurface:true,
  captureBeyondViewport:true, optimizeForSpeed:false,
  clip:{x:R.x,y:R.y,width:R.width,height:R.height,scale}
})
```

不使用 JPEG 预览帧作为截图来源，不通过修改 viewport/DSF 获得 scale，不对低分辨率图做事后位图放大，不重试截取、拼接或二次编码。禁止 DSF>1 与 `clip.scale>1` 双重缩放；如果将来改变 DSF，必须同步公式、环境事实与验收，不能继续引用当前 DSF=1 结论。

### 3.2 “无损裁剪”与尺寸校验

“无损裁剪”指直接由 CDP clip 对目标区域光栅采集，原始 PNG 字节随后直接校验、返回和落盘；没有截整图后重新编码的步骤。`scale=1` 的确定性纯色区域应逐像素保持颜色。`scale>1` 表示请求更密的光栅输出，不承诺不同 scale 下文字抗锯齿逐像素相同，也不承诺 PNG 压缩字节与另一张截图相同。

截图路径要求 PNG 实际尺寸与公式逐轴相等，容差 `tol=0`。模块通用校验规则如下；大于/小于均按超出 tolerance 计算：

```text
oversized  = actual.width > expected.width+tol || actual.height > expected.height+tol
undersized = actual.width < expected.width-tol || actual.height < expected.height-tol
ok         = !oversized && !undersized
code       = (oversized && !undersized) ? CAPTURE_UPSCALED : CAPTURE_SIZE_MISMATCH
reason     = (oversized && undersized) ? 'mixed-dimensions'
             : oversized ? 'upscaled' : 'undersized'
```

code/reason 仅在不满足 ok 时使用。一边超出、另一边相等为 `CAPTURE_UPSCALED`；存在不足轴时为 `CAPTURE_SIZE_MISMATCH`，一大一小标记 `reason:'mixed-dimensions'`，不能把混合变化归结为单纯放大。两类失败均不交付 image/附件/正式文件，已观测的安全 capture 元数据放错误 `details`。

`CAPTURE_UPSCALED` 是**实际尺寸超期望的保守拒绝码**，不独自证明发生了位图放大。尺寸吻合也不能自证图像未经过插值；“插件无事后放大”的承诺依赖单一 CDP 路径与原始字节不重编码的不变量。§9.1 的条纹实验只支持已测 Chromium 和已测 DOM/CSS 图形路径，不能推广为所有内容与所有浏览器的清晰度保证。

### 3.3 文档、视口与图片映射

`region`、`mapping.originCss/cssRect` 始终使用**文档 CSS px**；T1 输入与 T2 bbox/点击点通常使用**视口 CSS px**，不可直接混用。令采集前滚动原点为 `S`，区域原点为 `R`，密度为 `p`：

```text
documentCss = viewportCss + S
imagePixel  = (documentCss - R.origin) × p
documentCss = imagePixel / p + R.origin
viewportCss = documentCss - S
```

公式是连续坐标变换，不代替采样像素索引的取整规则。以实际 PNG 宽高描述图片边界；小数舍入可使边界像素数与连续长度相差不足一像素。公开 mapping 为纯 JSON（§4），不得返回函数。

截图不主动调用滚动或修改页面 DSF/viewport。`captureBeyondViewport:true` 允许文档坐标 clip，不表示插件执行了 scroll。显式区域与采集前可见矩形**完全无交集**时添加 `capture_beyond_viewport`；部分越界不触发该词。截图前后 scroll 不变由 C5 验证；position:fixed、sticky、响应式布局及视觉 viewport 的瞬时变化仍须专项验证，不能由 scroll 不变推定无影响。

### 3.4 清晰度与内容边界

高密度采集可为 DOM/CSS、文字与矢量提供更多输出像素。canvas/WebGL 内部 backing store、低分辨率 `<img>` 等已有位图不会因此新增源细节；页面自行按 DPR 创建的资源也受其原有逻辑约束。P0 不改 canvas 大小、不重绘业务内容、不保证所有内容变清晰。动画、异步字体、图片解码与布局可在读指标和截取之间变化；本路径不冻结页面，也不承诺所有观察来自同一渲染事务。

## 4. 返回与证据契约

### 4.1 兼容字段与 `capture.version=1`

结果沿用 action envelope 与 lossless JSON 返回/render 边界；新增 `capture`，不覆盖 T2 `evidence.version=1`。两者的版本各自独立。`capture` 是采集证据，不自动生成 assertion PASS。

| 字段 | 类型与内容 | 事实来源/约束 |
| --- | --- | --- |
| `capture.version` | integer，1 | 此契约版本 |
| `format` / `transport` | `'png'` / `'cdp-page-capture-screenshot'` | 采集路径声明 |
| `request` | `{scale,region:null\|Rect,coordinateSpace:'document-css-px',persist:boolean,out:null\|string}` | 调用参数；省略参数按默认 scale、null region/out 表示，不把有效区域冒充显式请求 |
| `environment` | `{browser:'chromium',pageDevicePixelRatio:number\|null,deviceScaleFactor:1,deviceScaleFactorSource:'runtime-override',viewport:{width,height},scroll:{x,y},headless:boolean\|null,headlessSource:'product'\|'userAgent'\|null}` | viewport/scroll 为采集前读回；页面 DPR 读取失败为 null；headless 联合检查已有浏览器版本 product/userAgent 的 HeadlessChrome 标记，任一命中为 true（product 优先），headlessSource 记录判定来源；取不到观测值时两者为 null，不为判定启动浏览器 |
| `png` | `{width,height,bytes,chunks,crc:'ok'}` | 原始 PNG 结构/CRC 校验；`chunks` 为块数量，不是图片内容摘要 |
| `expected` | `{width,height,pixelsPerCssPixel}` | §2.2 公式结果，不能冒充 PNG 实际值 |
| `sizeCheck` | `{ok,actual:{width,height},expected:{width,height,pixelsPerCssPixel},upscaled:false}` | 成功分支实际/期望相等；失败信息见 §5 |
| `mapping` | `{coordinateSpace,originCss:{x,y},imagePixels:{width,height},pixelsPerCssPixel,cssRect:{x,y,width,height},formulas}` | 文档 CSS→图片的纯 JSON 投影；`imagePixels` 与已校验实际尺寸一致；`formulas` 为正反映射公式文本，不是可执行函数 |
| `anomaly` | `{checked,uniform,transparent,sampledPixels,tolerance,maxDelta,averageColor,distinctColors}` | 解码像素统计；tolerance=0；≤16M 像素全量扫描；averageColor 固定 `{r,g,b,a}`；maxDelta是公开字段，checked=false为null，checked=true为相对首像素最大通道差；未检查的判断/颜色值为 null，扫描数为 0，不伪称 false |
| `file` | null或`{path,pathKind:'relative'\|'absolute',persistence:'persistent'\|'staging',root:'workspace'\|'env'\|'staging',ephemeral,bytes,sha256,width,height,mode:'0600',noClobber:true,createdAt}` | persistent为根相对路径/ephemeral=false；staging为插件暂存绝对路径/ephemeral=true；仅暂存路径可公开绝对值，见§6 |
| `delivery` | `{compare:'attachment-metadata',original,image,downscaled,reencoded}` | §4.2；附件元数据证据与源图分开 |
| `warnings` | string[] | §5.2 封闭词表，去重保序；成功仍可带警告 |

所有未观察值须明确为 null 或按字段约定为空，不得含 undefined、非有限数字、类实例、Buffer 或函数。模块内 `cssToPixel/pixelToCss` 可用于计算，但公开 mapping 必须经纯 JSON 投影；公式遵循 §3.3。错误详情、render、能力报告同样遵守该边界。

顶层 `bytes/sha256/image/capturedAt` 描述本次**原始 PNG**；`viewport` 描述 CSS 视口，不能用它冒充 scale 后 PNG 尺寸。若文件存在，`file.sha256`、顶层 `sha256`、`delivery.original.sha256` 与解码 `image` 后的字节 hash 必须相等；文件和原始 base64 必须来自同一份字节。附件 ID 不能当作文件路径。

### 4.2 原始字节、附件与 provider

`delivery.original={width,height,bytes,sha256,mediaType:'image/png'}` 来自已校验原图。`delivery.image` 为附件服务返回的 `{width,height,bytes,mediaType}`（未知项为 null），无可用附件为 null；不能用原图尺寸填补附件未知尺寸。

| 结论 | 允许置 true 的观测依据 | 未知边界 |
| --- | --- | --- |
| `downscaled` | ref.width 或 ref.height 为有效观测值，且至少一轴明确小于原始 PNG 对应轴 | 元数据缺失时不能声称同尺寸；false 只表示未观察到降采样证据 |
| `reencoded` | 已知 ref.mediaType 不等于 `image/png`，或已知 ref.bytes 与原图字节数不同，或 ref.sha256 存在且与原图 hash 不同 | 字节数相同不能证明内容相同；字段缺失不证明没有重编码 |
| `compare` | 固定 `'attachment-metadata'` | 不代表读取附件内容逐字节比对，不代表 provider 最终接收尺寸 |

观测到降采样/重编码分别追加 `model_image_downscaled` / `attachment_reencoded`。这些字段和警告只描述当前可观测附件元数据；不能宣称已探测 provider 后续缩放，也不能把缺少警告当作原始分辨率已送达模型。

可用时沿用 `attachments.saveImage` 与 image block；无服务或保存失败保留 base64、使用 `imageDelivery:'base64-fallback'`、`delivery.image:null` 与 `attachment_unavailable`，保留现有 `attachmentError` 文案兼容。原始分辨率保留仅指返回 base64 与成功落盘的原始 PNG；provider 视觉可见性仍 **NOT_RUN**，须真实宿主/视觉 provider 会话另证。

### 4.3 PNG 校验与像素统计

先检查 PNG 签名、块边界、IHDR/IEND、尾部字节、CRC；失败不交付。结构解析防御上限为 100,000 块与 200,000,000 像素，不放宽截图输出的 16,000,000 像素预算。

像素解码仅支持 8-bit、color type 0/2/4/6、非交错、filter 0–4；支持多 IDAT。palette、16-bit、交错等格式不猜像素，内部 `PNG_UNSUPPORTED_FORMAT` 只导致 `anomaly.checked:false` + `blank_check_skipped`，不作为新公开工具错误码。PNG 结构有效并不保证当前解码器支持全部 PNG 格式。

`uniform` 表示全部像素各通道相对首像素的差不超过 tolerance=0；`transparent` 表示有 alpha 通道且所有 alpha=0。截图路径对 ≤16,000,000 像素**全量扫描**，避免稀疏扫描漏掉白底小字；`sampledPixels` 是实际扫描像素数，应等于本次 PNG 总像素数。纯模块仅在 >16M 时存在 `sampled:true` 分支，该分支不会由本契约截图路径到达；不能用该分支结果冒充本路径的全量结论。

`maxDelta` 为相对首像素的最大通道差；`distinctColors` 为最多 1024 的有界颜色计数，1024 表示“≥1024”，不能当精确总颜色数。`averageColor` 固定为 `{r,g,b,a}` 四成员对象；灰度 G/GA 格式将灰度映射为相同 r/g/b，无 alpha 时 a=255。未解码或超检查预算时使用 checked=false 并警告。合法纯色页面仍交付图片，警告不能自动判为采集失败。

## 5. 结构化错误与警告

### 5.1 错误表

失败抛既有 `BrowserError`，含 `code/category/retryable/details` 与 `[CODE]` message；不新增 `{ok:false,error}` 分支，不承诺宿主结构化 `info.code`。除成功结果`capture.file`在staging模式按§6明确返回暂存绝对路径外，错误details、capabilities/observed不得含绝对文件路径、原始系统错误堆栈或页面原文；持久根始终不公开，仅保留相对路径、阶段、数值与安全原因。

| code | category | retryable | 语义与交付 |
| --- | --- | --- | --- |
| `CAPTURE_FAILED` | capture | true | 截图协议失败或空 data；不交付；既有取消/超时/断连分类例外见下 |
| `INVALID_PNG` | capture | false | 原始 PNG 结构/CRC 无效；不交付 |
| `CAPTURE_SIZE_MISMATCH` | capture | false | 存在不足轴；reason 为 undersized 或 mixed-dimensions；不交付，details 带 expected/actual/capture |
| `CAPTURE_UPSCALED` | capture | false | 至少一轴超出且无不足轴；reason 为 upscaled；保守拒绝，不独自证明插值放大 |
| `CAPTURE_TOO_LARGE` | resource | false | 输出像素超 16,000,000；截图前拒绝，details 含 expected/max/requested 安全数值 |
| `OUTPUT_PATH_INVALID` | input | false | out/root无效、越界或持久请求persist/out缺可信根（root_unknown）；不发布文件 |
| `OUTPUT_EXISTS` | output | false | 正式路径已存在（含 symlink）；既有字节不改，重试必须换 out |
| `OUTPUT_WRITE_FAILED` | output | true | 提交前文件创建/写入/发布失败；不伪造 file 成功证据 |
| `INVALID_ARGUMENT` | input | false | scale/region 类型、非有限数或边界不合法；纯参数预检无启动/截图/文件副作用 |

`ABORTED/CDP_TIMEOUT/CDP_DISCONNECTED/BUSY/UNSUPPORTED` 及 scope 错误保留既有码与清理语义；不能被笼统包装为 `CAPTURE_FAILED`。已发 CDP 后的取消/超时/断连继续按现行队列规则清理，不为补 capture 证据延迟取消。retryable 只是诊断提示，不授权自动重复截图或覆盖文件；可能已经发生的文件发布不回滚，须先核对返回与路径事实。

### 5.2 warnings 封闭词表

| warning | 触发条件 | 能说明什么 |
| --- | --- | --- |
| `content_uniform` | 成功解码且 uniform=true | 颜色统计均匀；不是“错误空白页”的视觉判定 |
| `content_transparent` | 成功解码且 alpha 全 0 | 全透明；不猜成因 |
| `model_image_downscaled` | 附件尺寸至少一轴明确小于原图 | 附件元数据观测到降采样；不覆盖 provider 后续变化 |
| `attachment_reencoded` | §4.2 的类型、字节数或 hash 差异 | 观测到交付表示变化；不假定编码方式 |
| `blank_check_skipped` | 解码不支持、无法完成像素检查或超检查预算 | 未得出 uniform/transparent 结论 |
| `capture_file_unavailable` | 默认暂存目录创建或文件发布失败 | 原始图仍交付，file=null；不代表已有可引用文件；不新增warning词 |
| `attachment_unavailable` | 无附件服务或附件保存失败 | base64-fallback；不能宣称模型可见 |
| `capture_beyond_viewport` | 显式 region 与现场可见矩形完全无交集 | 使用文档区域采集；不代表已滚动 |

不悄悄添加其它词；页面 DPR 读回失败按 null 记录，不扩 warnings。多个条件可同时出现，去重保序；不得为了“成功”移除警告。

## 6. 安全写入与文件生命周期

### 6.1 默认暂存与显式持久

**此前“默认写工作区output/capture”已改为默认暂存。** 持久意图为三者任一：提供out、persist:true、非空DSH_UI_TESTING_CAPTURE_DIR；persist:false不撤销out/env意图。其余调用（含legacy无cwd）写插件实例级暂存，不污染工作区。

| 模式 | 根/文件 | 返回file事实 | 生命周期/失败 |
| --- | --- | --- | --- |
| staging（默认） | 插件实例懒建`<tmp>/dsh-ui-testing-capture-*`，文件`<actionId>.png` | path为绝对路径、pathKind=absolute、persistence=staging、root=staging、ephemeral=true | 正常插件dispose递归清理；不随单次截图/页面close清理；暂存失败file=null+capture_file_unavailable，仍交付图片 |
| persistent | 非空env优先，否则可信`exec.agent?.session?.header?.cwd` realpath；out省略用`output/capture/<actionId>.png` | path为根相对路径、pathKind=relative、persistence=persistent、root=env或workspace、ephemeral=false | 不随插件dispose删除；根无效/发布失败为结构化错误，不能静默暂存 |

持久根必须绝对、存在且为目录；不以exec.meta、Host cwd或猜测路径替代。env非法时OUTPUT_PATH_INVALID，不回落cwd；无env且legacy缺cwd，persist/out请求报OUTPUT_PATH_INVALID，reason=root_unknown。默认legacy仍可暂存，不再因无cwd自动file=null。

| 项 | 要求 |
| --- | --- |
| 持久out | 根相对POSIX .png；拒绝绝对/..段/空段/NUL/反斜杠；总长≤200 UTF-8字节、单段≤100 |
| 持久目录 | mkdir后realpath必须仍在根下或等于根，不能仅字符串前缀判断 |
| 暂存路径公开 | 成功file.path允许返回实际暂存绝对路径，供本机消费；不得把它当可持久引用或抄成工作区路径 |
| observed.file | 仅`{persistence,relativePath}`；persistent为相对路径，staging为null；绝不复制暂存绝对路径到能力报告 |
| 原始bytes | 两模式都与base64同份PNG/hash，0600/no-clobber；禁止重编码/缩放 |

正常dispose清理已由C14验证；tmp不可写真实失败场景仍NOT_RUN。SIGKILL/崩溃/断电可能残留暂存目录，不保证自动回收或永久可访问。截图本身不自动脱敏；暂存路径也可能含环境信息，分享时按敏感证据处理。

### 6.2 原子发布与防覆盖

同目录随机隐藏临时文件以 `O_EXCL`（`wx`）和 0600 创建，写入并 fsync，然后以 `link(temp,final)` 原子发布。final 已存在时返回 `OUTPUT_EXISTS`，不跟随 symlink，不修改任何既有字节。发布成功后删除临时文件；目录 fsync 尽力而为。**同路径不覆盖，重试请换 out。**

link 成功是发布提交点。提交前失败清理本次临时文件；提交后临时文件清理或目录 fsync 的问题不能回滚/删除已发布 final，也不能伪称从未发布。正常成功路径须无临时残留；进程崩溃或系统故障可能遗留临时文件，P0 不承诺崩溃后自动回收，也不把尽力目录 fsync 当作跨所有文件系统的断电持久性保证。

realpath 守卫与 no-clobber 防止常规路径越界/覆盖，不构成对本地恶意进程并发替换父目录的完整隔离；目录校验与后续路径操作之间仍有 TOCTOU 边界。若需要抵抗不可信本地进程，必须另设计目录句柄/openat 一类机制，不能由现有路径检查推定已经解决。

## 7. 能力探测：声明与观测分开

`browser_capabilities` 保持诊断调用：不 ensure、不创建 page、不启动 Chromium、不申请/续租、不发起截图，也不为查询 headless 去启动浏览器。保留现有 16 工具、`web.t1.*` / `web.t2.*`、BUSY 与 T3/T4 unsupported 行为；只增 `capture` 和 `limits.capture`。

### 7.1 `capture` 声明字段

| 字段 | 值/语义 |
| --- | --- |
| `version / transport / format` | `1 / 'cdp-page-capture-screenshot' / 'png'` |
| `coordinateSpace` | `'document-css-px'` |
| `defaultScale / scaleRange` | `1 / [1,4]`，连续范围 |
| `maxOutputPixels` | `16000000` |
| `supports` | `region/clipScale/captureBeyondViewport/pngStructureCheck/blankCheck/fileWrite/noClobber/attachmentSizeCompare:true`；表示实现支持的路径，不证明本次根可写、图片可解码或附件可用 |
| `output.defaultMode / ephemeral` | `'staging' / true`，描述默认模式 |
| `output.persistRules` | `['out','persist:true','DSH_UI_TESTING_CAPTURE_DIR']`，任一触发持久 |
| `output.stagingRoot` | `'<tmp>/dsh-ui-testing-capture-*'`占位，不暴露实际绝对根 |
| `output.workspaceRoot / directory` | `'<workspace>' / 'output/capture'`，仅持久模式默认目录 |
| `output.env` | `'DSH_UI_TESTING_CAPTURE_DIR'`，非空即持久意图，必须绝对有效根 |
| `output.mode / noClobber` | `'0600' / true`；output不再声明旧root/defaultName字段，持久默认名见limits.capture |
| `limits.maxRegionPixels` | `16000000`；须同时遵守 scale 后 maxOutputPixels，不意味着 CSS 区域达此值在 scale4 仍合法 |
| `observed` | null 或 §7.2 的上次截图事实 |

`limits.capture`增加staging:true、persistParam:true、pathKind:['relative','absolute']、persistRules；保留scale/像素/路径限制、持久defaultName和八warnings。声明不能保证本次tmp/持久根可写，不把最近实测混成当前保证；查询不会创建暂存根。

### 7.2 `observed` 的最小事实

```text
null | {
  observedAt, scale,
  png:{width,height}, sizeCheck:{ok},
  anomaly:{checked,uniform,transparent},
  delivery:{downscaled}, file:null|{persistence:'persistent'|'staging',relativePath:string|null}
}
```

首次真实截图前必须为 null；只从所属 Runtime 的真实采集记录更新，不从静态 manifest、预设视口或测试期望值构造。历史 observed 带时间，是上次观测，不代表当前页截图或当前 provider 状态。close 后是否清除历史记录应保持实现生命周期的一致约定；无论是否保留都不得把旧值冒充本次采集。报告不含页面原始 URL/自由文本、绝对路径或图像内容。

## 8. 验收矩阵与交付证据

目标脚本为 `tests/acceptance/capture-p0.mjs`，对应C1–C14：原C1–C12、C13布局前后探针和本次C14暂存/持久生命周期。以下是**必须执行的条件，不是已通过记录**。使用授权离线 fixture、真实 Chromium、fake-ctx harness；PNG 像素/磁盘字节/HTTP 读回是真值，不靠肉眼。报告目录为 `tests/acceptance/runs/capture-p0-<ts>-<pid>/`，包含 report.json、PNG 与日志；退出码 0=必需项全过，1=断言失败，2=环境不可用。

| ID | 必需行为与真值 | 证据/边界 |
| --- | --- | --- |
| C1 默认截图 | 1280×800；PNG 结构/CRC；scale1；mapping 文档坐标；sizeCheck.ok；env 指定临时根下相对 .png 路径；0600；base64/file/返回 hash 相等 | 记录 PNG、磁盘权限/字节/hash；证明源图保留 |
| C2 scale2 | 默认 2560×1600；条纹区域 scale1/2 均纯黑/白，scale2 灰阶为 0 或低于 1% | 黑白条纹真值与尺寸共同支持已测路径；不能单凭无灰阶排除所有放大方式 |
| C3 region | 红色中心 20×20 全像素 255,0,0；蓝色中心同理 0,128,255 | 明确传 width/height；scale1 颜色不变 |
| C4 连续小数 scale | 101×50：1.25→126×63，1.5→152×75；增加 scale1.11 合法且尺寸按 round 公式断言 | 禁止把 1.11 当非法；逐轴 sizeCheck.ok |
| C5 文档坐标/滚动 | scrollTo(0,400) 后截文档 y1500 绿色 40×40；环境 scroll.y=400；截图前后 scrollY 相同；完全离屏 warning | 不覆盖 fixed/sticky 的瞬时布局行为 |
| C6 预览回归 | 高DPI采集后GET `/frame` 仍200、application/json JSON投影，`image`字段是非空base64 JPEG（magic ffd8）；按JPEG魔数及解码尺寸1280×800验证，host.captured增长 | 不存在image/jpeg响应头；JSON传输类型与内部JPEG图像格式分开记录 |
| C7 均匀图 | 纯白页 warning + anomaly.uniform=true，仍交付且 file 存在；返回图案页后无 uniform warning | 统计异常不是自动视觉 FAIL |
| C8 路径/no-clobber | 路径越界/绝对/反斜杠/错误后缀报 OUTPUT_PATH_INVALID；已存在报 OUTPUT_EXISTS 且 hash 不变；多级目录成功；两次默认名不同 | 原文件字节与成功后临时残留检查；不将此扩称恶意进程隔离 |
| C9 参数/错误 | scale=0/0.999/4.001/5/字符串/NaN 非法；region 宽0/负/字符串非法；4000×4001 scale1 超预算；code/category/retryable/message 与安全 details | 参数错误不新增截图/文件；details 不泄露主机绝对路径 |
| C10 附件/原始图 | fake 附件半尺寸且 webp→downscaled/reencoded 与对应 warnings；原图尺寸仍等于 PNG；无附件→fallback/null/警告 | compare='attachment-metadata'；缺失字段不推断相同；不证明真实 provider |
| C11 能力探测 | 冷启动含 capture/limits.capture，observed=null；截图后含真实事实；dispose 后 capabilities 不启动；无绝对路径/原始页面 URL | 声明支持与实测值分离；不把 running=false 当 unsupported |
| C12 重复/回归 | 独立根与 profile 连跑两次全部必需项通过；主验收可独立重复运行 | 两份报告及计数，不靠状态残留 |
| C13 前后布局一致性 | 截图前后对比viewport/scroll及fixture红块、绿块、fixed rect，静态页面读数完全相同 | §9报告已覆盖；前后相同仍不能证明瞬时无变化 |
| C14 默认暂存/显式持久 | 23项覆盖默认与legacy staging、0600/hash/绝对pathKind、不落cwd、request.persist=false；无根persist/out拒绝、persist非布尔零新增文件、cwd与env持久相对路径、dispose清理、output/limits声明、observed不含绝对路径 | 14/14、142/142报告见§9；真实tmp不可写/SIGKILL场景未验证 |

同时要求执行：模块单测、语法检查、T1 主验收、T2 结构化验收、Runtime 故障注入。命令及既有退出码语义见 [验收说明](../tests/acceptance/README.md)。本轮前置对比基线由 Lead 提供：T1 为 22 probes、324 必需项，其中 P21 loadingFailed 有已知环境 flake；执行者必须列 before/after 失败项，不能只称“原有失败”。T2 目标保持 37/38 PASS + 1 NOT_RUN、260/260 必需项，故障注入保持 16/16。新失败不能以文档或旧通过记录豁免。

fixture 真值由 task-3 维护：红块文档 (20,20) 60×40；蓝块 (120,20) 40×40；黑白条纹 (20,100) 120×40；绿块 (20,1500) 40×40；文字 (20,200)，13px/16px monospace；白底、margin0、总高至少 2400。文本清晰度没有自动视觉 PASS 阈值，不能把 fixture 含文字当成已验证可读性。

## 9. 已测事实、未验证与不做承诺

**默认暂存修订（当前）**：Lead独立串行真实Chromium+fake ctx **14/14 probes、142/142必需项、0失败、exit0**（[最终报告](../tests/acceptance/runs/capture-p0-2026-11-01T05-52-05-302Z-104057/report.json)）；新增C14 23项、C1增加2项。T1 **22/22、324/324**（[报告](../tests/acceptance/runs/2026-11-01T05-49-22-590Z-100191/run-report.json)）、T2 **37/38+1 NOT_RUN、260/260**（[报告](../tests/acceptance/runs/2026-11-01T05-50-44-987Z-101531/run-report.json)）。unit26/26、faults16/16由Lead交接；文档后skill/registry由Lead最终复核。执行者05-45-29的142项报告亦通过，保留为过程记录。下方115/117报告属于本次修订前历史。tmp不可写真实失败场景、SIGKILL残留与真实宿主重载/provider仍NOT_RUN。

T1最终文案代码复跑 **21 PASS/1 FAIL、323/324通过/1失败、exit1**（[05-59-53](../tests/acceptance/runs/2026-11-01T05-59-53-185Z-105978/run-report.json)），与上方05-49-22的22/22并列。两次行为实现相同、仅persist描述不同。唯一失败P21-host-output-contract→“失败网络条目（loadingFailed）可快照且无undefined字段”，actual仅3条成功网络条目，与[基线04-30-43](../tests/acceptance/runs/2026-11-01T04-30-43-916Z-53146/run-report.json)同项。Lead判为既有环境随机flake，非P0回归；失败仍为FAIL，验收需串行且不能保证消失。T2最终代码仍37/38+1 NOT_RUN、260/260、exit0（[06-01-14](../tests/acceptance/runs/2026-11-01T06-01-14-788Z-107358/run-report.json)）；P0独立142项结果不因此改写。

### 9.1 Lead 的 CDP 实测事实

这些是 Lead 在 task-4 提供的**本机实测记录**，环境为 Chrome 152 / Linux headless；不是本文作者运行报告，也不等同插件最终集成后的 C1–C12 验收。实验临时脚本/原始输出未随任务描述归档，后续执行者须以可复现报告补齐链路。

| 项 | 已测观察 | 允许引用的结论 |
| --- | --- | --- |
| Runtime 初始环境 | metrics override：1280×800、DSF1；CSS innerHeight=800 | 当前默认受控视口/DSF |
| headless 标记（Lead 补充实测） | Chrome 152 `--headless=new` 的 `Browser.getVersion.product` 为 `Chrome/152.0.7977.82`，不含 HeadlessChrome；标记出现在 userAgent | product/userAgent 任一命中为 true，headlessSource 为 product 或 userAgent（product 优先）；取不到观测值为 null，不能只因 product 未命中就断言 false |
| clip 坐标 | `captureBeyondViewport:true` 下按文档 CSS 坐标截取 | region 使用文档 CSS px；不自动转换成视口坐标 |
| scale 舍入 | 101×1.25→126；101×1.5→152；101×2→202；101×3→303 | 当前 Chrome 路径按 round 公式；其它引擎未测 |
| DOM/CSS 条纹 | 1 CSS px 黑白条纹在 scale2 输出纯色 2px 交替、灰阶0 | 支持当前 CDP clip.scale 的重光栅解释；不概括所有内容 |
| DSF 与 scale 叠乘 | DSF2、scale2 同时使用，100×100 CSS 区域输出400×400 | 固定 DSF1、只用 clip.scale，避免双重缩放 |
| PNG 编码 | 8-bit、color type2 RGB、非交错、多 IDAT | 解码器须覆盖该真实格式；不推定未来永远同格式 |

### 9.2 P0集成执行证据与未验证边界

**默认暂存修订前历史**：Lead独立串行P0两次各13/13、117/117、0 failed、exit0（[05-15-01](../tests/acceptance/runs/capture-p0-2026-11-01T05-15-01-055Z-85097/report.json)、[05-15-05](../tests/acceptance/runs/capture-p0-2026-11-01T05-15-05-476Z-85616/report.json)）；T1 22/22、324/324、exit0（[报告](../tests/acceptance/runs/2026-11-01T05-15-09-827Z-86138/run-report.json)），P21基线flake为随机复现风险，后续05-59-53已同项失败（见当前记录），此历史单次通过不证明消失；T2 37/38+1 NOT_RUN、260/260（[报告](../tests/acceptance/runs/2026-11-01T05-17-06-786Z-87684/run-report.json)）。Lead交接P0单测26/26、runtime-faults16/16、check-skill25/25、registry17/17，无仓库output/或PNG残留。以下115项为增量前历史，这是当时117项口径；当前默认暂存修订以§9开头142项为准。

执行者真实Chromium+fake ctx三次各13/13、115/115、0 failed、exit0：[首轮](../tests/acceptance/runs/capture-p0-2026-11-01T04-57-34-532Z-65733/report.json)、[第二轮](../tests/acceptance/runs/capture-p0-2026-11-01T04-58-28-002Z-66463/report.json)、[第三轮](../tests/acceptance/runs/capture-p0-2026-11-01T04-58-32-550Z-66980/report.json)。公开maxDelta增量后复跑 **13/13、117/117、exit0**（[报告](../tests/acceptance/runs/capture-p0-2026-11-01T05-09-04-665Z-79630/report.json)），纯白页maxDelta=0、内容页=255。默认1280×800、scale2=2560×1600、101×50@1.11=112×56；C13的scroll/视口/红块/绿块/fixed rect前后完全相同。T1回归22/22、324/324（[报告](../tests/acceptance/runs/2026-11-01T04-59-29-531Z-68121/run-report.json)）。以上是他人执行报告核对，非本文作者重新运行，也不代表真实宿主已加载或provider视觉已验。

| 项目 | 状态 | 不做的承诺/下一证据 |
| --- | --- | --- |
| P0进程内集成 C1–C14 | 当前默认暂存修订14/14、142/142；见§9最终报告 | 仅报告覆盖路径；本文作者未重新运行，真实宿主重载与provider仍NOT_RUN |
| `captureBeyondViewport` 对 fixed/sticky/布局的瞬时影响 | C13前后布局通过，瞬时影响仍未专项验证 | C5 scroll不变不能代替；C13前后读数相同也不能排除瞬时变化，必要时补CDP事件/截图像素专项证据 |
| 文字/矢量在不同 scale 的可读性 | 无视觉判定 | 可补可复现的文字/矢量频率或边缘探针；不声称所有截图更清晰 |
| canvas/WebGL/低分辨率位图 | 明确源分辨率限制 | scale 不增加源细节；不承诺变清晰 |
| 附件标准化/模型接收图 | 元数据比较可覆盖，真实 provider NOT_RUN | 原始 PNG 保留不代表模型收到原图；需真实 provider 会话 |
| 本地敌对进程/断电恢复 | 不属于 P0 保证 | realpath/no-clobber 不是完整文件系统沙箱或崩溃恢复系统 |
| T3/T4 | unsupported | 不提供差异/阈值/VLM/帧序列/时序判断；均匀统计也不等于 T3 |

## 10. 跨文档同步清单与收口风险

初始task-4只写本文与索引，后续task-5/task-7已同步下表相关文档及默认暂存修订；本表保留为跨文档维护位置清单。历史115/117验收不改写为142，也不外推旧默认路径。

| 文件 | 小节/定位 | 需要同步的具体内容 |
| --- | --- | --- |
| [runtime-t1.md](runtime-t1.md) | Agent 工具、截图证据、内置 Skill 与能力发现、已知限制 | 链接本文；新增 scale/region/out、capture 字段、纯 JSON mapping、DPR unknown/null 与受控 DSF 来源、能力声明/observed；移除当前态“截图无裁剪”，保留无视觉判断/provider 未验 |
| [architecture.md](architecture.md) | 代码结构、证据/能力职责 | 登记新采集模块的 PNG 校验/解码/映射/安全写入职责；Runtime 单 CDP 采集、工具编排、公开 mapping 投影；与 JPEG 预览分离 |
| [status.md](status.md) | 实现了什么、生效方式、还没做 | P0 实际实现与报告计数/构建加载、未验证项；单独写采集裁剪已实现和 T3/T4 未实现；原始 PNG/附件/provider 边界；不得仅凭本文标已验证 |
| [t1-m0-m2-contract.md](t1-m0-m2-contract.md) | 每次调用的证据与截图 | 加后续 P0 权威契约引用，解释旧“无裁剪”是历史；保留历史证据/计数 |
| [t1-known-gaps.md](t1-known-gaps.md)、[capability-tiers.md](capability-tiers.md) | 截图缺口、T1/T3 分层与完成门槛 | 采集裁剪/密度属于共享基础设施；像素判断/VLM/T4 仍缺失，不能把裁剪出现视为 T3 完成 |
| [验收说明](../tests/acceptance/README.md) | 运行、测试职责、实测范围 | 维护capture-p0命令/C1–C14/报告与退出码、暂存/持久测试隔离；声明连续 scale、元数据比较、未验 provider/fixed；记录真实结果 |
| [Skill 入口](../skills/ui-testing/SKILL.md) | 适用范围、工具表、错误与证据、限制 | screenshot 参数/capture/warnings/新错误/输出路径与 no-clobber；纯 JSON mapping 与两种 CSS 坐标；DPR 未知不猜；去掉“无裁剪”当前态但保留无 T3/T4 判断 |
| [操作契约](../skills/ui-testing/references/contracts/operation.md)、[证据契约](../skills/ui-testing/references/contracts/evidence.md) | screenshot 行、证据交付段 | 原图hash/尺寸、file.pathKind/persistence/root/ephemeral、默认暂存/显式持久、observed不含绝对路径、附件 compare='attachment-metadata'、缺失字段不推断、provider 仍未验；capture 不覆盖 T2 evidence |
| [能力契约](../skills/ui-testing/references/contracts/capability.md) | 能力诊断/限额 | capture 与 limits.capture；supports 声明、observed 事实、诊断不启动/不夺租约 |
| [T1 层](../skills/ui-testing/references/tiers/t1-programmatic.md)、[T3 层](../skills/ui-testing/references/tiers/t3-static-visual.md)、[Web 平台](../skills/ui-testing/references/platforms/web.md) | 截图范围、默认视口、T3 缺口 | 连续 scale/文档 clip/受控 DSF1；移除“局部裁剪未实现”，保留无差异/阈值/VLM、canvas 与固定布局边界 |
| [视觉场景](../skills/ui-testing/references/scenarios/visual-motion.md)、[回退规则](../skills/ui-testing/references/core/fallback.md) | 截图不足、T3 限制、错误列表 | 可采集局部高密度图但没有视觉判定；新增 capture/output 错误与恢复条件；不得自动重放/覆盖 |
| [选路](../skills/ui-testing/references/core/selection.md)、[验证](../skills/ui-testing/references/core/verification.md)、[安全](../skills/ui-testing/references/core/safety.md)、[流程](../skills/ui-testing/references/core/workflow.md) | 截图证据与持久化 | 使用 capture/file/warnings 记录事实；默认暂存/显式持久及0600/no-clobber；file区分绝对暂存/相对持久，dispose清理；截图仍敏感，tmp失败不声称已有文件 |
| [截图示例](../skills/ui-testing/examples/web-t1-input-and-screenshot.md) | §4 原始截图及顶部坐标说明 | 保留 `{}` 兼容示例；补 scale/region/out、文档与视口坐标区别、文件/附件尺寸示意；示例仍注明非运行证据 |
| [manifest](../skills/ui-testing/manifests/declared-capabilities.json)、[T1 台账](../skills/ui-testing/knowledge/web/t1-capability-ledger.md) | web.t1.screenshot、能力/错误/证据条目 | 同步新约束和报告链接，依据实测更新工程状态；DPR/附件未知不伪称已测；T3/T4 保持 unsupported，历史事实不抹去 |

已收口且后续应保持的具体项：C9 不能拒绝合法 scale1.11；公开 mapping 不能含函数；页面 DPR 读取失败不能伪造为观测到1；截图包装不能吞既有取消/超时/断连码；附件缺失元数据不能推出“原图未改”；output 根标签与 defaultName 不能导致双层目录。Lead 已裁决连续 scale、附件元数据口径、mapping 投影和 DPR 来源；当前实现/验收按§9报告覆盖；新增默认暂存/显式持久后以file.pathKind及observed投影区分路径公开边界。

风险评审结论：a) 当前 CDP 实测足以支撑所测图形路径和单 CDP 方案，尚不足以普遍证明所有内容无放大；b) captureBeyondViewport 的 fixed/sticky 瞬时副作用未专项验证；c) 只承诺原始 PNG 字节保留，模型实际分辨率不由附件元数据自证；d) legacy无cwd默认暂存；显式persist/out且无持久根必须root_unknown，暂存失败仅既有warning；e) 新错误 category 与既有分类可并存，封闭 warnings 保持八词，PNG 解码不支持留内部状态，取消/超时/断连原码透传。例行实现、调试与运行验证由执行者负责，本文不替代运行验收。
