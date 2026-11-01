# Web T3 静态视觉调试权威契约

> 2026-11-01 · task-1 · 本文是实施者唯一的 T3 接口、算法与验收依据。本文为静态设计交付，**未进行运行验证**；实现完成、测试通过、真实宿主加载与 provider 图像可见性分别需要证据。截图成功不等于视觉验收通过。
>
> 关联现行契约：[采集 P0](capture-p0.md)、[T2](t2-structured-gui.md)、[工作区隔离](workspace-isolation.md)、[分层标准](capability-tiers.md)。本文不改变上述既有 16 工具的参数、成功形状、输入语义或错误语义。新增工具实现后总数为 **22**。索引、README、Skill、能力台账与测试工具计数由实施者/Lead 同步，本文作者仅写本文件。

## 1. 范围、边界与裁决

T3 是**静态视觉调试**：对有限张静态 PNG 做处理、确定性识别、坐标输入及结果比较。新增且只新增六个工具：`browser_vision_image`、`browser_vision_find`、`browser_vision_compare`、`browser_vision_act`、`browser_vision_baseline`、`browser_vision_check`。不新增第七工具，不修改客户端 UI。

只使用现有 CDP、Node 内建模块和纯 JavaScript；不引入任何 npm 依赖、原生库、外部图片服务、VLM 或 OCR。复用 [capture-p0.js](../capture-p0.js) 的结构/CRC 校验、`decodePng`、路径与发布机制；其解码结果的 channels=1/2/3/4 必须先正规化为 RGBA8，不能误把灰度输入当 RGBA。只读参考 [Pixelmatch](../reference/web-t3/pixelmatch/index.js) 等算法，不 vendoring；当前参考 Pixelmatch 是 OKLab 距离，**本契约独立固定 YIQ 算法**，不能照搬参考库默认值或宣称与该版本完全相同。若日后复制获准代码，另履行相应许可证与归属义务。

六工具复用可信 exec scope、每工作区 single-owner-lease、串行 Runtime 队列、取消及错误 envelope。纯参数预检必须在 ensure、磁盘创建和 CDP 派发之前完成。离线 product/baseline 操作也进所属 scope 队列和 owner 检查，但不为此启动 Chromium；仅 `kind:live` 或 `act` 需要现存/懒启动页面。image/find/compare/act/baseline在运算前解析并pin其全部源图，操作结束释放；check整批先校验纯参数，然后逐case解析并pin本case源图及baseline/template，case结束即释放（不把20个case同时pin到16图store）。内部调用不得嵌套申请队列。诊断 capabilities 不启动、续租、生成 product 或创建目录。

**缺陷检测不主动查询 DOM。** 只有调用方显式提供的、带 provenance 的几何/样式事实可参与融合。坐标输入的现场 CDP 命中与稳定性安全校验是例外，见 §6；它不构成对缺陷检测的隐式 DOM 取证。

保存文档无需重启；后续 Host、模块、工具 schema 和 bundled Skill 修改需要重启 DSH 才由真实宿主加载。测试进程通过不能证明用户现有宿主已经更新；不启动或重启用户实例。

### 1.1 源图与 product store

所有工具源图只能是下面的 `Source`。禁止任意文件路径、URL、附件 ID、调用方 base64 和 Buffer 输入；不从附件服务反读图像。已有 `browser_screenshot` 不隐式新增 productId；要使用同一画面，先调用 `browser_vision_image` 取得 product，再执行 T1/T2 动作并取得第二 product。

```text
Source = {kind:"live", scale?:number, region?:CssRect}   # 省略 scale = 本次调用冻结的共享 view.scale（cold 1）
       | {kind:"product", productId:string}
       | {kind:"baseline", name:Name, revision?:integer}
```

`live` 沿用 P0 单次原始 PNG 截图路径、显式 `scale∈[0.1,4]`（省略时跟随共享 `view.scale`，见 [viewport-control.md](viewport-control.md) §6.1）、文档 CSS region 和固定 runtime DSF=1；未给 region 时为现场 layout viewport。不使用预览 JPEG，不改变 viewport、滚动或 DPR，不重复截图择优。源图作为内部 P0 采集可以直接进入内存 store，不因截图本身创建文件；其采集证据标记 `file:null`，不是变更已有 `browser_screenshot` 的暂存行为。

product store 按可信工作区 scope 隔离，属于插件实例；与当前 page 生命周期分离。每 scope 最多 **16 张、合计 128 MiB 编码 PNG、单张 32 MiB 编码 PNG、单图 16,000,000 像素**；RGBA 临时工作集另限 256 MiB（估算所有同时存活缓冲，包括比较双图、输出、标签图，分配前检查），单操作模板候选像素比较次数上限 50,000,000。不得通过压缩比绕过像素与解码预算，解压前限制 inflate 输出长度为预期扫描行字节数，避免压缩炸弹。同步循环每最多 65,536 像素/比较迭代检查取消，并让出事件循环；每工具调用的累计CPU算法墙钟预算5,000ms（从首次解码开始，跨check的所有case共享；不含队列、启动、CDP或磁盘等待），超限抛VISION_TIMEOUT，不交付半成品；已完成case通过错误details保留。现有30000ms工具wrapper保留，check不设置无界批次或绕开wrapper。

ID 为 `v1_<32位小写hex随机数>`，由 cryptographic randomBytes 生成，不以内容 hash 或序号使跨 scope 猜测可用。缓存按读取/创建的访问顺序 LRU 淘汰，pin 项不可淘汰；放不下且无可淘汰项时拒绝，不能删仍在使用的源图。store 保存原始编码字节、hash、尺寸、完整 lineage、mapping 和采集 provenance；解码缓冲只活到本操作结束。不把磁盘路径当缓存回退。跨 scope、被淘汰、插件重启后的 ID 均同样报 `VISION_SOURCE_NOT_FOUND`，不泄露其是否在别的工作区。page 导航/close 后图片仍可离线分析，但其可操作资格失效。dispose 清空所有 store、pin、任务 timer 及默认暂存文件；显式持久图片和基线保留。崩溃后不保证暂存清理；不存在跨重启 product 恢复。

### 1.2 公共值和校验

- `Rect={x,y,width,height}`；禁止 `w/h`。`CssRect` 是有限 number，x/y≥0、width/height≥1，允许小数；`PixelRect` 四项均 integer，x/y≥0、width/height≥1。区域为左闭右开，不 clamp、不隐式取整、不自动裁到边缘。
- `Point={x:number,y:number}` 为图像连续像素坐标，允许有限小数；有效区间 `[0,width)×[0,height)`。`PixelPoint` 是同范围整数坐标。颜色 `RGBA=[r,g,b,a]`，各项 integer 0–255；RGB 同理前三项。不接受 CSS 颜色字符串。
- `Name` 匹配 `^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$`。大小写敏感；不支持路径、点号、空格、NUL、Unicode 名称。用例 `id` 同此规则。
- 所有对象拒绝未知字段、非有限数、类型转换、重复列表 ID、超限与不适用字段。所有可选默认值只在字段缺失时应用，null 不表示省略。schema 与执行层均验证；宿主不支持的关键字由执行层落实，不能因 required=[] 放行空动作。
- `Output={persist?:boolean=false,out?:string}`，路径与环境触发持久规则完全继承 P0。仅输出图片的工具可给 output；无图片时禁止。每调用最多一张交付 PNG；compare 的差异区域已画在同张图中。默认写 P0 暂存、0600/no-clobber；请求持久失败则抛错误。默认暂存失败仍保留 product/base64，file=null 并报既有 `capture_file_unavailable`。无 output 也生成并交付这张图片，按 P0 默认规则保存。
- 六工具成功沿用 action envelope，业务体 `{ok:true,...,evidence:{vision:VisionEvidence}}`。参数/资源/协议失败抛 `BrowserError`，完整证据在 `details.evidence.vision`；不返回 `{ok:false}`。`ok:true` 仅表示工具完成，`verdict` 才是断言结论。

## 2. 六工具与 JSON schema

### 2.1 注册 schema 与类型展开

下面是规范 JSON Schema 2020-12；`$defs` 为契约可复用定义，注册时可按宿主支持的子集内联，运行时仍执行全部约束。各工具根对象 `additionalProperties:false`。`Output`、Query、Assertion 等结构的完整字段在本节对应表中穷举，表中的必填/互斥/边界与 schema 同等规范性，不能自行添加自由对象参数。

```json
{
  "$defs": {
    "Rect": {"type":"object","additionalProperties":false,"required":["x","y","width","height"],"properties":{"x":{"type":"number","minimum":0},"y":{"type":"number","minimum":0},"width":{"type":"number","minimum":1},"height":{"type":"number","minimum":1}}},
    "PixelRect": {"type":"object","additionalProperties":false,"required":["x","y","width","height"],"properties":{"x":{"type":"integer","minimum":0},"y":{"type":"integer","minimum":0},"width":{"type":"integer","minimum":1},"height":{"type":"integer","minimum":1}}},
    "Point": {"type":"object","additionalProperties":false,"required":["x","y"],"properties":{"x":{"type":"number","minimum":0},"y":{"type":"number","minimum":0}}},
    "Source": {"oneOf":[
      {"type":"object","additionalProperties":false,"required":["kind"],"properties":{"kind":{"const":"live"},"scale":{"type":"number","minimum":0.1,"maximum":4},"region":{"$ref":"#/$defs/Rect"}}},
      {"type":"object","additionalProperties":false,"required":["kind","productId"],"properties":{"kind":{"const":"product"},"productId":{"type":"string","pattern":"^v1_[0-9a-f]{32}$"}}},
      {"type":"object","additionalProperties":false,"required":["kind","name"],"properties":{"kind":{"const":"baseline"},"name":{"type":"string","pattern":"^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$"},"revision":{"type":"integer","minimum":1}}}
    ]},
    "Output": {"type":"object","additionalProperties":false,"properties":{"persist":{"type":"boolean"},"out":{"type":"string"}}},
    "Thresholds": {"type":"object","additionalProperties":false,"properties":{"warnRatio":{"type":"number","minimum":0,"maximum":1},"failRatio":{"type":"number","minimum":0,"maximum":1}}},
    "DiffOptions": {"type":"object","additionalProperties":false,"properties":{"threshold":{"type":"number","minimum":0,"maximum":1},"includeAA":{"type":"boolean"},"minRegionPixels":{"type":"integer","minimum":1,"maximum":16000000}}},
    "Mask": {"type":"object","additionalProperties":false,"required":["id","region"],"properties":{"id":{"type":"string","pattern":"^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$"},"region":{"$ref":"#/$defs/PixelRect"}}}
  }
}
```

注册工具的 root `properties` 用下表列出的字段展开；注册 `required` **固定**如下，不将条件必填全塞入 required：

| 工具 | required | root properties（`?` 可省略） |
| --- | --- | --- |
| `browser_vision_image` | `[]` | `source?:Source={kind:live}`, `region?:PixelRect`, `resize?:Resize`, `preprocess?:Preprocess[]=[]`, `annotations?:Annotation[]=[]`, `recognize?:Query`, `output?:Output` |
| `browser_vision_find` | `["query"]` | `source?:Source={kind:live}`, `region?:PixelRect`, `query:Query` |
| `browser_vision_compare` | `["before","after"]` | `before:Source`, `after:Source`, `region?:PixelRect`, `masks?:Mask[]`, `options?:DiffOptions`, `thresholds?:Thresholds`, `output?:Output` |
| `browser_vision_act` | `["productId","action","point"]` | `productId:string`, `action:"move"|"click"|"drag"`, `point:Point`, `to?:Point`, `button?:"left"|"right"|"middle"="left"`, `clickCount?:integer=1`, `modifiers?:string[]=[]`, `steps?:integer=20`, `durationMs?:integer=500` |
| `browser_vision_baseline` | `["action"]` | `action:"list"|"get"|"create"|"update"|"delete"`, `name?:Name`, `revision?:integer`, `source?:Source`, `expectedRevision?:integer`, `caseId?:Name`, `options?:DiffOptions`, `thresholds?:Thresholds`, `masks?:Mask[]` |
| `browser_vision_check` | `["cases"]` | `cases:Case[]`（1–20）、无其他根字段 |

六个 root 的JSON schema如下。与上方$defs合并；Resize/Preprocess/Annotation/Query/Case分别按§2.2/2.3/2.7和Fact §7.1的封闭字段表展开为同名$defs（包括条件oneOf）。数字边界、condition必填和列表上限同时属于执行校验。

```json
{
  "browser_vision_image":{"type":"object","additionalProperties":false,"required":[],"properties":{"source":{"$ref":"#/$defs/Source"},"region":{"$ref":"#/$defs/PixelRect"},"resize":{"$ref":"#/$defs/Resize"},"preprocess":{"type":"array","maxItems":8,"items":{"$ref":"#/$defs/Preprocess"}},"annotations":{"type":"array","maxItems":64,"items":{"$ref":"#/$defs/Annotation"}},"recognize":{"$ref":"#/$defs/Query"},"output":{"$ref":"#/$defs/Output"}}},
  "browser_vision_find":{"type":"object","additionalProperties":false,"required":["query"],"properties":{"source":{"$ref":"#/$defs/Source"},"region":{"$ref":"#/$defs/PixelRect"},"query":{"$ref":"#/$defs/Query"}}},
  "browser_vision_compare":{"type":"object","additionalProperties":false,"required":["before","after"],"properties":{"before":{"$ref":"#/$defs/Source"},"after":{"$ref":"#/$defs/Source"},"region":{"$ref":"#/$defs/PixelRect"},"masks":{"type":"array","maxItems":64,"items":{"$ref":"#/$defs/Mask"}},"options":{"$ref":"#/$defs/DiffOptions"},"thresholds":{"$ref":"#/$defs/Thresholds"},"output":{"$ref":"#/$defs/Output"}}},
  "browser_vision_act":{"type":"object","additionalProperties":false,"required":["productId","action","point"],"properties":{"productId":{"type":"string","pattern":"^v1_[0-9a-f]{32}$"},"action":{"enum":["move","click","drag"]},"point":{"$ref":"#/$defs/Point"},"to":{"$ref":"#/$defs/Point"},"button":{"enum":["left","right","middle"]},"clickCount":{"type":"integer","minimum":1,"maximum":2},"modifiers":{"type":"array","maxItems":4,"uniqueItems":true,"items":{"enum":["alt","ctrl","meta","shift"]}},"steps":{"type":"integer","minimum":1,"maximum":100},"durationMs":{"type":"integer","minimum":0,"maximum":2000}}},
  "browser_vision_baseline":{"type":"object","additionalProperties":false,"required":["action"],"properties":{"action":{"enum":["list","get","create","update","delete"]},"name":{"type":"string","pattern":"^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$"},"revision":{"type":"integer","minimum":1,"maximum":9999999999},"source":{"$ref":"#/$defs/Source"},"expectedRevision":{"type":"integer","minimum":1,"maximum":9999999999},"caseId":{"type":"string","pattern":"^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$"},"options":{"$ref":"#/$defs/DiffOptions"},"thresholds":{"$ref":"#/$defs/Thresholds"},"masks":{"type":"array","maxItems":64,"items":{"$ref":"#/$defs/Mask"}}}},
  "browser_vision_check":{"type":"object","additionalProperties":false,"required":["cases"],"properties":{"cases":{"type":"array","minItems":1,"maxItems":20,"items":{"$ref":"#/$defs/Case"}}}}
}
```

以下规范类型使用 `field:type=default [min,max]` 表示 JSON property、默认值和闭区间；`*` 表示 required。数组顺序具有执行意义；不接受该类型未列出的 key。每一类型均有 `type:object,additionalProperties:false`，列表为 `type:array,items:<类型>`，枚举为 JSON 字符串 enum。

### 2.2 `browser_vision_image`：采集、裁剪、处理、分析与标注

处理顺序固定：解析 source → region 裁剪 → resize → preprocess 按列表 → 统计及可选 recognize → annotations → 编码/校验/发布。分析及 recognize 在标注前执行，避免标注被当页面内容；返回的 regions 坐标相对于最终未标注图，标注不会改变几何。source 本身不改。image 无参数为一张实时截图加统计，未请求断言时 verdict=INCONCLUSIVE/reason=no-assertion。

| 类型/字段 | 完整结构、默认与界限 |
| --- | --- |
| `Resize` | `factor*:number` 连续 [1,4]；`method?:"nearest"|"bilinear"="nearest"`。结果 W/H=round(输入 W/H×factor)；不支持缩小。与 source.scale 分开，前者为事后位图插值，后者为 CDP 光栅密度 |
| `Preprocess` | `op*:"grayscale"|"blur"|"normalize"|"threshold"|"channels"`；blur 才允许 `radius?:integer=1` [1,3]；threshold 才允许 `value?:integer=128` [0,255]；channels 才允许 `order?:"rgba"|"bgra"|"argb"="rgba"`。其他 op 禁止这些字段；最多 8 项 |
| `Annotation` | `kind*:"rect"|"cross"|"number"|"arrow"`、`color?:RGBA=[255,0,0,255]`、`thickness?:integer=2` [1,8]；rect 必须 `region:PixelRect`；cross 必须 `point:PixelPoint`，可 `size?:integer=9` [3,63]；number 必须 `point:PixelPoint` 与 `number:integer` [1,999]；arrow 必须 `point:PixelPoint,to:PixelPoint`。各 kind 禁止其他 kind 字段，最多 64 项 |

**返回** `{product:Product,image:base64,bytes,sha256,attachment,attachmentId,imageDelivery,attachmentError,file,analysis:Analysis,recognition:FindResult|null,evidence}`。attachment 等沿用 P0，可观测字段缺失为 null，不以原始尺寸填附件未知尺寸。`file` 服从 P0；Product 不包含重复 base64。

```text
Product={productId:string,width:integer,height:integer,bytes:integer,sha256:string,
  rgbaSha256:string,createdAt:epochMs,capturedAt:epochMs|null,
  kind:"capture"|"derived"|"diff"|"baseline", mapping:Mapping|null,
  actionable:boolean, parentIds:string[], operations:OperationSummary[]}
OperationSummary={op:"crop"|"resize"|"grayscale"|"blur"|"normalize"|
  "threshold"|"channels"|"annotate"|"diff",parameters:object}
Analysis={pixelCount,transparentPixels,opaquePixels,averageRgba:[number,number,number,number],
  minRgba:RGBA,maxRgba:RGBA,uniform:boolean,
  dominantColors:[{rgba:RGBA,count:integer,fraction:number}], edgePixels:integer,edgeRatio:number}
```

`rgbaSha256=sha256(正规化后按行RGBA字节)`，不包含尺寸或压缩数据；比较时另验宽高。capturedAt来自祖先capture，无采集血统为null；createdAt是本product创建时间。operations只含本product相对直接父图的操作及其已解析参数（参数对象仅相应Resize/Preprocess/Annotation/PixelRect字段；diff为resolvedOptions/Thresholds/Masks），最多74项；完整祖先采集摘要独立存储，不依赖父product仍在LRU，也不无限展开历史operations。无像素变换的image复用原productId和原始PNG；有变换创建derived，recognition.sourceProductId指最终derived（无标注前独立product），若有标注则另存未标注derived供recognition引用、再创建annotated derived。最多一次对外图像交付，内部product均计入store预算。

`transparentPixels`计alpha=0，opaquePixels计alpha=255；0<alpha<255像素仅计pixelCount与平均值。uniform是所有RGBA逐通道完全等首像素；edgeRatio=edgePixels/pixelCount（边缘圈仍在分母）。min/max逐通道而非按颜色元组排序。dominantColors 按 RGBA 四个高 4bit 量化（各通道 `floor(c/16)*16` 作为桶值），只输出最多 8 桶，按 count 降序、RGBA 字典序升序；fraction=count/总像素，min/max/average 用原始 RGBA 全量，平均保留 double。edge 为 §5 的 Sobel 阈值 32，边界不计。所有统计由未标注处理结果得出，不生成“页面正确”的推测。

可一次表达“指定区域裁剪并识别/静态分析”：

```json
{"source":{"kind":"live","scale":1,"region":{"x":0,"y":0,"width":640,"height":400}},"region":{"x":40,"y":30,"width":120,"height":80},"recognize":{"method":"color","color":[255,0,0],"tolerance":0,"minArea":4}}
```

### 2.3 `browser_vision_find`：确定性识别与定位

`Query` 共有 `method*` 与可选 `minArea:integer=4` [1,16000000]、`maxResults:integer=20` [1,100]。按 method 只允许下列额外字段：

| method | 字段及匹配定义 |
| --- | --- |
| `color` | `color*:RGB`, `tolerance?:integer=16` [0,255]；max 通道差≤tolerance 且 alpha>0 的像素为前景 |
| `components` | `background?:RGB=[255,255,255]`, `tolerance?:integer=16` [0,255]；alpha>0 且与背景 max 通道差>tolerance 为前景 |
| `edges` | `edgeThreshold?:integer=32` [0,255]；Sobel 得到前景，再做连通域 |
| `template` | `template*:Source`（仅 product 或 baseline，禁止 live）、`minScore?:number=0.95` [0,1]、`stride?:integer=1` [1,16]；不允许 minArea，允许 maxResults；模板必须不大于搜索 ROI |

可选 region 先裁出 ROI，但 `FindResult` 的图像坐标始终回加 ROI 原点，返回相对于**完整源图**的坐标；image.recognize 相对于 image 处理结果。默认不再生成图片、文件或 product；live 源解析仍会生成可引用源 product。模板 source 会独立解析 pin。

```text
FindResult={method,sourceProductId,searchRegion:PixelRect,candidates:[{
  id:"c1"...,region:PixelRect,documentCss:Rect|null,centroid:{x,y},
  area:integer,score:number,signal:"color"|"component"|"edge"|"template",
  semanticName:null}], totalCandidates:integer,truncated:boolean,
  metrics:{foregroundPixels:integer|null,evaluatedPositions:integer|null,
    pixelComparisons:integer,algorithm:string}}
```

工具成功完整业务体为 `{ok:true,source:Product,result:FindResult,evidence}`；source为完整源图，不是ROI裁剪图。无匹配为成功 `candidates:[],totalCandidates:0`；不抛 TARGET_NOT_FOUND，不把“未发现候选”当组件必然缺失。c1 等仅本次排序编号，不是后续可操作 ref；定位用 bbox 中心、sourceProductId 和坐标 act。排序/分数见 §5。

### 2.4 `browser_vision_compare`：显式两图比较

before/after 必须显式提供，两项均可 live，但**按 before 后 after 各一次独立截图**，不插入动作、不等待动画稳定、不冻结页面。推荐 before product → 外部动作 → after product/live。工具不自动执行 JS，不提供 action 字段。必须记录两图时间；时间差不提供“状态已稳定”保证。

region 是完整图像的同一 PixelRect，在两图上都必须有效；省略为全图。两图必须同像素尺寸，同 scale、同 mapping CSS 大小与原点才允许双 CSS 区域报告；尺寸不同抛错误，不自动 resize/align。mapping 不同但像素尺寸相同允许图像比较，记录 `mapping-compatible:false`、documentCss=null，禁止推断位移或使用基线作 required 布局判断。回归 check 要求 mapping 兼容，见 §8。

`masks` 最多64项、id 唯一。坐标始终相对完整图，不相对 compare region；掩膜必须全部在完整图边界内，可与 ROI 无交集。mask 存储 ID、原始区域，实际像素排除为 ROI 内所有 masks 并集；像素中心落在矩形内才屏蔽（整数矩形与索引一一对应）。`masks` 缺失时继承 before baseline 元数据的 masks（before 非 baseline 则 []）；显式 [] 清空继承；after baseline 不触发继承。options/thresholds 同样逐字段覆盖 before baseline 默认，否则使用本契约默认。返回 resolvedOptions/resolvedThresholds/resolvedMasks，禁止隐式自动 mask 或从连拍估算动态区域。

**返回** `{before:Product,after:Product,product:Product,image,...交付字段,comparison:Comparison,evidence}`。diff product 为不可操作图，parentIds 为二源图。

```text
Comparison={region:PixelRect,resolvedMasks:Mask[],resolvedOptions:DiffOptions,
  resolvedThresholds:{warnRatio,failRatio},metrics:{totalPixels,maskedPixels,
    comparedPixels,diffPixels,aaPixels,diffRatio,similarity},
  regions:[{id,area:integer,imagePixels:PixelRect,beforeDocumentCss:Rect|null,
    afterDocumentCss:Rect|null}],regionCount:integer,regionsTruncated:boolean,
  verdict:"PASS"|"WARN"|"FAIL",reason:"ratio",mappingCompatible:boolean}
```

区域合并/高亮/相似度见 §4；regions 过滤不会改变 diffPixels 与 verdict。全屏蔽无分母，抛 `VISION_EMPTY_COMPARISON`；不能给 similarity=1。比较输出是单张 annotated diff PNG，无额外隐藏文件。

### 2.5 `browser_vision_act`：截图坐标输入

详见 §6。productId 必须源自所属 scope 的 actionable product。clickCount 只对 click，值1–2；button 只对 click/drag；steps/durationMs 只对 drag，steps [1,100]、durationMs [0,2000]；move 禁止 button/clickCount/steps/durationMs。drag 必须 to；其他禁止 to。modifiers 最多4个不重复 alt/ctrl/meta/shift。drag 不接受 clickCount。未显式传入的默认值不算“不适用字段”。

返回 `{dispatched:boolean,action,point:{imagePixels:Point,documentCss:Point,viewportCss:Point},to:同结构|null,dispatch:{eventCount,completed,eventSource:"cdp-input"},beforeProductId,afterProduct:Product|null,evidence}`。after 是**输入结束后立即单次**同原采集矩形/scale 的新截图 product（无额外文件/base64），用于下一次 compare；若导航/取消/断连不能截取则 null、incomplete 记录，不因此重放已完成输入。返回 dispatched=true 不代表点击到业务正确位置、拖拽成功或任何视觉断言通过。action 工具自己的 verdict 固定 INCONCLUSIVE/reason=dispatch-only。

### 2.6 `browser_vision_baseline`：受管基线

| action | 条件必填与禁止字段 | 成功字段 |
| --- | --- | --- |
| list | 禁止全部其他字段 | `baselines:BaselineMeta[]`（最多1000，超过抛 VISION_LIMIT_EXCEEDED）；不存在根返回[]，不创建 |
| get | name 必填；revision 可选，默认逻辑 HEAD；禁止 source/expectedRevision/caseId/options/thresholds/masks | `baseline:BaselineMeta,product:Product`（读入 store，不生成文件/附件） |
| create | name、source 必填；禁止 revision/expectedRevision；caseId 默认 name；options/thresholds/masks 可选 | `baseline:BaselineMeta,product:Product` |
| update | name、source、expectedRevision 必填；禁止 revision；caseId/options/thresholds/masks 缺失继承旧值（显式空 masks 清空） | 同 create |
| delete | name、expectedRevision 必填；禁止其他字段 | `baseline:BaselineMeta`（tombstone=true） |

source 禁止 baseline 指向正在创建/更新的同名 HEAD（避免隐式自更新），可以显式 revision 或其他名字。create 不覆盖已有/已删除名字（名字不能复用）；delete 后 get HEAD 报不存在，显式旧 revision 可审计读取。delete 是逻辑墓碑，不删不可变 PNG；不提供 prune/自动物理清理，用户可离线管理整个根，工具不跨 root 清理。一次 baseline create/update 调用即可完成采集、PNG、元数据和 HEAD 提交，不需要先 image 再保存，不触发额外确认。

```text
BaselineMeta={name,revision:integer,parentRevision:integer|null,parentHeadToken:string|null,headToken:string,
  tombstone:boolean,caseId:string,createdAt:epochMs,
  image:{relativePath:string,sha256,width,height,bytes}|null,
  options:{threshold,includeAA,minRegionPixels},thresholds:{warnRatio,failRatio},masks:Mask[],
  mapping:Mapping|null,source:{productId,sha256,capturedAt:epochMs|null,
    runtimeId:string|null,pageGeneration:integer|null,documentEpoch:integer|null},
  provenanceVersion:1}
```

get读取非墓碑revision时返回kind=baseline、actionable=false的新product；create/update返回本次source product（其原kind与资格不因保存基线改变），并将同份已校验字节写基线。get显式revision恰为墓碑时成功返回metadata及product=null；作为Source读取墓碑revision则报VISION_BASELINE_NOT_FOUND，不能作为图像。list 返回每个名字最新 HEAD 元数据（包括 tombstone），名字字典序；不把 sourceProductId 当重启后仍有效的承诺。headToken 是元数据规范 JSON 字节 sha256；整数 revision 是 CAS 请求字段，token 为审计证据。所有磁盘细节见 §8。

### 2.7 `browser_vision_check`：用例集、缺陷与机器结论

```text
Case={id*:Name,source*:Source,assertions*:Assertion[1..32],facts?:Fact[0..64]=[]}
Assertion={id*:Name,type*:"regression"|"layout"|"occlusion"|"overflow"|
  "truncation"|"color"|"missing",severity?:"required"|"advisory"="required", ...专属字段}
```

每 case 的 assertions ID 唯一；facts ID 唯一；全批 source/facts/assertions 参数先验证，再按 case 数组执行。一次 check 不导航、不改变产品页、不自动建/更新基线；需要多页时调用方逐页导航后分别 check。单 case 解析 source 一次，全部断言共用同一图。发现业务失败仍执行后续断言/用例。合法但无足够事实或资源的断言返回 BLOCKED/INCONCLUSIVE，见 §7；非法字段整批抛错。source 不可读/解码等执行错误保留该 case 为 BLOCKED、errorCode 与 incomplete，不声称 PASS；若 ABORTED/CDP断连/队列超时则整工具抛原错误、携带已完成 cases，不继续取证。

| type | 专属字段（列完所有允许字段） |
| --- | --- |
| regression | `baseline*:Name`,`revision?:integer≥1`,`region?:PixelRect`,`masks?:Mask[]`,`options?:DiffOptions`,`thresholds?:Thresholds`；baseline 是比较 before，case source 是 after |
| layout | `region*:PixelRect`,`factId?:Name`,`expectedRect?:CssRect`,`toleranceCss?:number=1` [0,100]；expectedRect 给定则必须 factId |
| occlusion | `region*:PixelRect`,`factId?:Name`,`maxCoveredRatio?:number=0` [0,1] |
| overflow | `region*:PixelRect`,`factId?:Name`,`toleranceCss?:number=1` [0,100] |
| truncation | `region*:PixelRect`,`factId?:Name`,`toleranceCss?:number=1` [0,100] |
| color | `region*:PixelRect`,`factId?:Name`,`expectedColor*:RGB`,`tolerance?:integer=16` [0,255],`minFraction?:number=0.95` [0,1] |
| missing | `region*:PixelRect`,`factId?:Name`,`query*:Query`（通常 template）、`minCount?:integer=1` [1,100] |

regression 必须兼容 baseline mapping；无 mapping 的输入只能 severity=advisory，否则 BLOCKED/reason=mapping-unavailable。输出每个 regression 可引用 diffProductId，check **不发布图像文件/附件**；需要交付图使用 compare 或 image。各类缺陷规则及 fact 完整 schema 见 §7。

```text
CheckResult={cases:[{id,sourceProductId:string|null,assertions:[{
  id,type,severity,status:"PASS"|"WARN"|"FAIL"|"INCONCLUSIVE"|"BLOCKED",
  reason:string,metrics:object,regions:RegionEvidence[],factIds:string[],
  diffProductId:string|null,errorCode:string|null}],
  verdict:"PASS"|"WARN"|"FAIL"|"INCONCLUSIVE"|"BLOCKED"}],
  summary:{pass,warn,fail,inconclusive,blocked},
  verdict:"PASS"|"WARN"|"FAIL"|"INCONCLUSIVE"|"BLOCKED",exitCode:0|1|2,evidence}
```

check成功业务体为 `{ok:true,...CheckResult}`。每 assertion 的 metrics 只用 §4/§7 明确的有限数值/布尔/null 字段，不开放执行器任意意见文本。regression的metrics除Comparison.metrics外必须附 `{resolvedOptions,resolvedThresholds,resolvedMasks,beforeSha256,afterSha256,baselineRevision,headToken}`，以便结果离开diff product后仍可审计。check里regression使用原compare规则：PASS保持PASS、WARN保持WARN、FAIL在severity=required为FAIL、severity=advisory降WARN；缺mapping的advisory FAIL同样只能WARN。`summary` 按 assertion status 数量计；每 case 和总 verdict 按 FAIL > BLOCKED > INCONCLUSIVE > WARN > PASS 合成。required 的失败信号是 FAIL；advisory 的失败信号降为 WARN、无足够信息则 INCONCLUSIVE，不能由 severity=advisory 将未知变 PASS。exitCode 是返回值，不调用 process.exit：FAIL→1；无 FAIL 但 BLOCKED/INCONCLUSIVE→2；其余 PASS/WARN→0。CI 若要将 WARN 设为失败，应在调用方显式配置，不改变本工具默认。

## 3. 坐标、映射与统一证据

### 3.1 三种空间与边界

1. screenshot image pixels：PNG 实际像素，是 T3 region/mask/annotation/find/act 默认坐标。
2. document CSS pixels：live source.region、外部 DOM facts、基线 mapping 用此空间。
3. viewport CSS pixels：CDP Input 输入；document 坐标减当前 scroll 才能传给 CDP。

源采集矩形 R、p=scale×runtimeDSF（当前 DSF=1）、滚动 S：

```text
W=round(R.width*p), H=round(R.height*p)
documentX=R.x+imageX/p; documentY=R.y+imageY/p
viewportX=documentX-S.x; viewportY=documentY-S.y
```

不能将 window.devicePixelRatio 再乘一次；它是观察字段，不取代已设置 DSF。像素区域换 CSS 使用区域**边缘**，不是像素中心；区域 `{x,y,width,height}` 映射四边后报告。act point 是连续图像坐标；如用户意图第(i,j)个像素中心，应传 `{x:i+0.5,y:j+0.5}`。点击不自动加0.5、不取整。

post-crop 映射原点加 `(crop.x/p,crop.y/p)`；post-resize 用实际 `sx=Wout/Win,sy=Hout/Hin` 而非名义 factor，舍入可使二轴不等：

```text
Mapping={coordinateSpace:"document-css-px",originCss:{x,y},
  cssPerPixel:{x:1/(p*sx),y:1/(p*sy)},imagePixels:{width,height},
  capturedCssRect:Rect,scrollAtCapture:{x,y},viewportAtCapture:{width,height},
  visualViewportScale:number|null,geometryTransform:"axis-aligned"}
```

多次 crop/resize 复合更新 origin/cssPerPixel。预处理/标注不改变 mapping，但取消 actionable；diff mapping=null，不把差异图当页面截图。baseline 保留原 mapping，用途为可解释比较，不使其可操作。CSS rect 的右/下边缘可能因截图尺寸舍入与请求 rect 差不足一个采样像素，应按实际映射报告，不把最后一列拉伸补齐。

PixelRect 小数、负数、零面积、超过图片边界 → INVALID_ARGUMENT；明确指出字段路径与 reason，不暴露值原文。Source.live 的 CssRect 允许小数；其 x/y 非负且完全处于现场 `cssContentSize` 文档边界内（与 P0 既有截图参数独立，本限制仅用于新 source）。读取现场后发现越界也在截图前拒绝；无自动扩展文档。live 的 source.region 与工具顶层 region 可以同时存在，后者是已捕获图像坐标裁剪。

### 3.2 `evidence.vision.version=1`

```text
VisionEvidence={version:1,operation:string,
  provenance:{actionId:string|null,scopeId:string|null,runtimeId:string|null,
    pageGeneration:integer|null,documentEpoch:integer|null,algorithmVersion:"t3-v1"},
  source:[{role:"source"|"before"|"after"|"template",kind:"live"|"product"|"baseline",
    productId:string|null,sha256:string|null,width:integer|null,height:integer|null,
    capturedAt:epochMs|null,mapping:Mapping|null,capture:CaptureV1|null}],
  coordinateSpace:{image:"image-px",document:"document-css-px",input:"viewport-css-px"},
  regions:[{id:string,role:string,imagePixels:PixelRect,
    beforeDocumentCss:Rect|null,afterDocumentCss:Rect|null,area:integer|null}],
  metrics:object,
  baseline:[{name,revision,headToken,tombstone}],
  facts:[{id,sourceActionId,observedAt,documentEpoch,trusted:false}],
  verdict:{status:"PASS"|"WARN"|"FAIL"|"INCONCLUSIVE"|"BLOCKED",reason:string},
  dispatch:{started:boolean,eventCount:integer,completed:boolean,
    eventSource:"cdp-input"|null,hitBackendNodeId:integer|null},
  output:{productId:string|null,sha256:string|null,file:CaptureFile|null,
    delivery:CaptureDelivery|null},
  escalation:{tier:"T4"|null,reason:string|null},
  incomplete:string[],truncated:boolean}
```

evidence.vision 不取代原 capture、T2 evidence 或 action envelope；v1 内全部必填，未观察项 null，非适用列表 []，不可用统计 null。离线分析顶层 runtime/page/document 来自操作现场（无页面则 null），图像出处以 source 内采集记录为准，不把旧记录伪装成当前。成功 analysis/find/act/baseline 的 verdict 默认 INCONCLUSIVE（no-assertion/dispatch-only/baseline-management）；compare 与 check 才输出可判定静态断言。

source.capture 只在直接 live 取得时带完整原始 CaptureV1；product/baseline 只放存储 lineage 摘要，不重复全部祖先截图。derived 图像的 hash 描述派生字节，不能放入原 capture.sha256。每个结论的 metrics、thresholds、mask 和源 hash 必须可追溯。evidence JSON≤262144字节，regions≤100；超限标 truncated，保留所有总计、阈值、错误、dispatch 与判定依据。若截断会丢失 required 判断依据，则改 INCONCLUSIVE，不保留未经证据支持的 PASS。

错误 details 同样带 vision；参数/BUSY/取消早期不得为了补证据启动页面。不能获得图像/事实/分母时 metrics 对应 null、status BLOCKED/INCONCLUSIVE，绝不补 similarity=1 或 diffPixels=0。公开 URL 走既有脱敏；错误不含绝对路径、系统堆栈、selector、事实里的页面文本；截图像素本身不自动脱敏。附件元数据未知不得推断 provider 可见。

### 3.3 新增错误码

所有码抛 BrowserError，category/retryable 固定如下。原 ABORTED/CDP_TIMEOUT/CDP_DISCONNECTED/BUSY/scope/INVALID_ARGUMENT/INVALID_PNG/CAPTURE_*/OUTPUT_* 保持原分类；不能包装为 INTERNAL 或视觉 FAIL。

| code | category / retryable | 条件 |
| --- | --- | --- |
| `VISION_SOURCE_NOT_FOUND` | vision / false | product 不存在/跨 scope/LRU/restart；baseline 内容不可用用专属码 |
| `VISION_FORMAT_UNSUPPORTED` | vision / false | 合法 PNG 为 decoder 不支持格式，不能跳过解码后宣称已分析 |
| `VISION_LIMIT_EXCEEDED` | resource / false | 编码字节/总 store/工作集/候选比较次数/结果个数等预算不足；details.limit/actual/max |
| `VISION_TIMEOUT` | timeout / true | 5s 算法预算耗尽；返回无部分图像、无假结论 |
| `VISION_SIZE_MISMATCH` | vision / false | compare 两图实际宽高不等，details.before/after 尺寸 |
| `VISION_EMPTY_COMPARISON` | vision / false | ROI 内所有像素被 mask 排除 |
| `VISION_STALE_IMAGE` | action / false | act 非 actionable、超过30s、页面代次/scroll/viewport/zoom变化或重新截图 hash 不同 |
| `VISION_HIT_MISMATCH` | action / false | 无命中/disabled/inert/两帧 backend 不同/命中 rect 持续变化，零派发；不回退点 |
| `VISION_BASELINE_ROOT_UNAVAILABLE` | output / false | 无可信持久根、非法 env 根、scope 无工作区身份；不回退暂存 |
| `VISION_BASELINE_NAME_INVALID` | input / false | 基线 name 非 Name（早期预检，零副作用） |
| `VISION_BASELINE_NOT_FOUND` | vision / false | 无 committed 名字/revision，或 HEAD tombstone |
| `VISION_BASELINE_EXISTS` | output / false | create 名字已使用，含 tombstone |
| `VISION_BASELINE_CONFLICT` | concurrency / false | expectedRevision 不等 HEAD，或争抢下一 committed head 槽失败 |
| `VISION_BASELINE_READ_FAILED` | output / true | 元数据损坏、PNG缺失/hash不符、目录读失败；reason 固定 io/corrupt/hash-mismatch |
| `VISION_BASELINE_WRITE_FAILED` | output / true | 权限/只读/fsync/link/write失败；reason permission/read-only/io；不得暴露绝对根 |

警告封闭词表（可同时出现、去重保序）：`bitmap-upscaled`、`mapping-incompatible`、`advisory-only`、`fact-unverified`、`regions-truncated`、`animation-not-evaluated`，加继承的 P0 warnings。warnings 放 metrics.warnings（数组）；它们不能替代 status 与 incomplete。animation-not-evaluated 表示未评估时序，不表示已检测到动画。坐标持续运动才设 escalation T4，普通未知不擅自升级。

## 4. 图像处理、PNG、diff 与相似度

### 4.1 编码与变换

新增纯 JS PNG encoder，CRC32 可复用 P0；压缩仅 Node 内建 zlib。固定 RGBA8/type6、非交错、scanline filter=0（None）、deflate level=9、strategy=Z_DEFAULT_STRATEGY、windowBits=15、memLevel=8，一个 IHDR、一个 IDAT、一个 IEND，禁止 tIME、随机元数据、调色板或字体系统依赖。相同 RGBA 在相同 Node/zlib 版本必须字节/hash 完全相同；跨 zlib 版本仅保证解码像素相同，报告记录 process.versions.node/zlib，不将跨版本压缩字节差当视觉差。每个编码输出重新做 P0 结构/CRC/尺寸验证后才发布；输出尺寸超16M或字节超32MiB提前/编码后分别拒绝。未处理的实时图像返回 Chromium 原始 PNG，不为了统一编码无故重编码。

所有交付图复用 P0 `resolveCapturePath/publishCapture` 或等价守卫；0600、同目录 wx 临时文件、fsync、link no-clobber、提交后不删除 final。产物写出不改源图，不能覆盖任意现存文件。基线写入另遵守 §8。

nearest：输出像素中心映回输入，`ix=min(Win-1,floor((ox+0.5)*Win/Wout))`，iy 同理，复制 RGBA。bilinear：`u=(ox+0.5)*Win/Wout-0.5`，对四个相邻 clamp 输入像素按距离权重插值**预乘 alpha**，alpha=0 的 RGB置0，非零反预乘、每通道 round/clamp。两种 resize 均警告 bitmap-upscaled；不是截图高 DPI重光栅保证。

preprocess 完整清单：

| op | 逐像素定义 |
| --- | --- |
| grayscale | `g=round(0.299r+0.587g+0.114b)`，输出[g,g,g,a] |
| blur | radius 正方形 box blur；边缘 clamp；对预乘 RGB 与 alpha 求窗口均值再反预乘，round；同一输入快照计算，不原地污染邻居 |
| normalize | 对 alpha>0 像素求各 RGB 通道独立 min/max；max=min 原值保留，否则 round(255×(c-min)/(max-min))；alpha不变；全透明输入原样 |
| threshold | 同 grayscale 的 g，`g>=value ? 255:0` 写三通道，a不变 |
| channels | 输出4个通道按 order 对输入 RGBA 索引重排；rgba identity、bgra交换红蓝、argb输出[a,r,g,b]。这是明确字节实验，可能改变透明度，不称作色彩空间转换 |

标注以整数像素 raster，不用系统字体/Canvas。矩形用内边框、十字为中心水平/垂直线、箭头用 Bresenham 主线及末端两条固定45度/长度6像素箭翼（端点 round，clamp）；thickness 为以线中心向两侧扩张的方形笔刷，偶数时多余像素放正方向。编号仅内置数字0–9的3×5位图（0=111/101/101/101/111，1=010/110/010/010/111，2=111/001/111/100/111，3=111/001/111/001/111，4=101/101/111/001/001，5=111/100/111/001/111，6=111/100/111/101/111，7=111/001/010/010/010，8=111/101/111/101/111，9=111/101/111/001/111），无前导0、每字间1像素、固定2倍nearest，point为左上角；无自由文本。color按 straight alpha 的 source-over 合成、round/clamp。几何控制点/rect必须在图内；笔刷/箭翼/编号尾部超出仅裁画到图界，不改变指定区域，无静默坐标修正。annotations 列表顺序即覆盖顺序。

### 4.2 像素差异固定算法 `yiq-v1`

DiffOptions 默认 `{threshold:0.1,includeAA:false,minRegionPixels:1}`。透明像素 RGB 先在**纯白背景**合成 `c'=255+(c-255)*a/255`，不使用随机/棋盘背景；完全透明的不同 RGB 视为无差异。rgba 完全相同可直接跳过。RGB 合成结果保留 double，然后（下式Y是两图亮度差；单图Ybefore另用相同三个亮度系数作用于该图合成RGB）：

```text
dR=Rbefore-Rafter; dG=Gbefore-Gafter; dB=Bbefore-Bafter
Y=0.29889531*dR+0.58662247*dG+0.11448223*dB
I=0.59597799*dR-0.27417610*dG-0.32180189*dB
Q=0.21147017*dR-0.52261711*dG+0.31114694*dB
delta=0.5053*Y*Y+0.299*I*I+0.1957*Q*Q
candidateDiff = delta > 35215*threshold*threshold
```

严格 `>`，等阈值不计差。threshold=0 对任何非零 YIQ 差敏感，threshold=1 依此公式而非保证任意差都相同。

AA 排除：在每张图的3×3邻域用上式 Y亮度（白底合成）与中心比较；相等邻居>2 则非AA；必须同时有较亮和较暗邻居；选最暗/最亮邻居（并列按 y后x升序），若其中任意一个位置在**两图**各有至少3个相等RGBA邻居则中心为AA。边界只枚举有效邻居，并给 equal 计数初值1（与角/边统一），内部初值0。两图任一图符合则排除；mask 邻居按原值读取，不扩张mask。includeAA=true 不排除，aaPixels=0。AA 是启发式，不能保证排除全部字体差异；固定算法、测试黄金像素，不依赖安装版参考库。

### 4.3 分母、区域与高亮

```text
N = ROI.width*ROI.height
M = ROI 内 masks 并集像素数
C = N-M (必须>0)
D = C 中超阈值且未被AA排除的像素数
A = 被AA排除的candidateDiff像素数
diffRatio = D/C
similarity = 1-D/C ∈[0,1]
```

AA 仍在分母 C；mask 不在分母。similarity 是阈值化差异覆盖率相似度，**不是语义相似度、SSIM、模板分数或概率**。仅做这一个公开全图相似度，避免同名指标多口径。空区域不返回1。

D 的二值图做8邻接连通域，area 为实际差异像素数（不是 bbox面积）；minRegionPixels只控制输出区域。bbox 使用完整源图坐标。按 area降序、y升序、x升序、height升序、width升序排序，最多100，regionCount为过滤后总数，截断不修改 D。每区域 before/afterDocumentCss 分别用各自 mapping 映射，mapping不兼容时均 null 并记录原因；无mapping也为null，不套当前滚动坐标。

输出整张原尺寸 PNG：ROI 外和未差异像素取 before 白底合成灰度 `round(255*0.9+Ybefore*0.1)`、alpha255；mask像素=[128,128,128,255]；AA=[255,255,0,255]；D=[255,0,0,255]；区域bbox内边框=[0,128,255,255]厚1，按排序绘制。数值统计在边框绘制前完成。不把 masked 像素画成“相同”绿色。

Thresholds 默认 `{warnRatio:0.001,failRatio:0.01}`，要求 0≤warnRatio≤failRatio≤1。D/C>failRatio→FAIL，否则> warnRatio→WARN，否则 PASS；相等按较低等级处理。原始双精度比较，不以显示四舍五入值判定。pixel threshold 和 verdict ratio 是两个独立阈值，返回二者及分母。

## 5. 无 VLM 识别、定位与限制

color/components/edges 的 foreground 做8邻接 BFS/迭代扫描（禁止深递归），剔除 area<minArea，按 area降序/y/x/height/width升序排序，maxResults截断。centroid 为所有前景像素中心均值（Σ(x+0.5)/area）；score=area/bbox面积；color 若颜色不成实心也按这一分数，不能称置信度。totalCandidates为过滤后、截断前数量。

edges：先用白底合成灰度 g=round(0.299r+0.587g+0.114b)，Sobel `Gx=[-1,0,1;-2,0,2;-1,0,1]`、`Gy=[-1,-2,-1;0,0,0;1,2,1]`；`m=min(255,round((abs(Gx)+abs(Gy))/8))`，m≥edgeThreshold且m>0为前景，图像边缘一圈为0。不做闭运算、自动连字或语义分组。

template：以模板原分辨率不旋转、不缩放滑窗；搜索位置 x/y 按 stride 从ROI左上逐行，最后不足stride的末尾不补点；每位置白底合成RGB的 `score=1-Σ(|dr|+|dg|+|db|)/(255*3*templatePixels)`。保留 score≥minScore 的位置，按 score降序/y/x升序排序，以 IoU>0.3 的贪心NMS保留当前最高项（相等0.3保留），再 maxResults截断。area=模板宽×高，centroid=bbox中心，totalCandidates=NMS后总数。必须在分配候选/扫描前校验50M像素比较次数，不能先跑一半再偷降stride。minScore与公开compare similarity不混用。

无 OCR、无文本内容、无“按钮/头像/错误图标”语义命名；semanticName 固定 null。候选只表明颜色/边缘/模板的图案，不是DOM元素身份。相连组件可合并两个视觉控件，渐变、阴影、反锯齿与透明度可分裂组件；模板不适应字体/缩放/主题变化。canvas/WebGL 可按最终像素识别，但不得推断canvas内部对象、业务含义、深度或可点击性。识别输出不足以单独判定required“组件缺失”，见 §7。

## 6. 坐标交互与 T2 边界

act 不接受 baseline/diff 图或任意文件；只允许本 scope、capture年龄≤30,000ms、同 runtime/pageGeneration/documentEpoch 的 capture 或仅经过crop+nearest resize的derived图。bilinear、preprocess、annotation任何一步使 actionable=false。年龄判定必须沿用祖先capturedAt，不能靠派生createdAt刷新30s期限。两个axis可不同scale，按mapping精确换算，不再次乘DPR。

工具侧 `imagePixels/documentCss/viewportCss` 必须保留连续小数，不能主动取整；CDP `Input.dispatchMouseEvent` 可以传小数，但 Blink 可能把 DOM `MouseEvent.clientX/clientY` 截断为整数。Lead 提供的裸 CDP 实测为 x=104.4/104.5/104 时 DOM clientX 均为104；[验收报告 C25 的证据与 NOT_APPLICABLE 记录](../tests/acceptance/runs/2026-11-01T07-27-41-484Z-163114/run-report.json#L2990-L3005)记录了该限制。验收必须分别核对工具侧连续坐标与 DOM 侧事件：工具映射精度仍按公式，DOM 坐标允许每轴≤1 CSS px误差；“DOM保留小数”子项记 `NOT_APPLICABLE` 并附裸 CDP 证据，不得据此判实现缺陷。这不改变工具侧不取整的要求。

派发前依次执行：

1. 校验 product/pure params，确认当前页存在且同代次。读现场 layout/visual viewport、scroll；viewport宽高/scroll与采集值逐轴差≤0.01 CSS px、visualViewportScale必须为1且与采集一致。其余差异拒绝 VISION_STALE_IMAGE；不自动滚动/缩放。
2. 按祖先原始 capture region/scale重新截一次、验证PNG，并与祖先capture的**原始PNG解码RGBA hash**比较（不能比较压缩字节hash，因为重编码可能同像素）；不改变store里的原图。不同即 VISION_STALE_IMAGE，零输入。该安全比较不受用户mask/threshold影响、不应用AA排除。
3. 将point/to映射document再减现场scroll，必须在当前视口内；否则 NOT_INTERACTABLE/reason=outside-viewport，零输入，不提供force。drag全线点都在视口内。
4. 起点用CDP DOM.getNodeForLocation取得最深可证明backendNodeId（可命中canvas或主frame的shadow host）；用现场CDP节点检查connected/disabled/inert。跨frame命中/无法识别主frame归属为 UNSUPPORTED。连续两次rAF（最多1000ms）命中身份相同、命中节点bbox四项差≤1CSS px，否则 VISION_HIT_MISMATCH；持续运动建议T4。输入之前再次复验page代次、scroll与起点命中。拒绝后不搜别的点。
5. 真实CDP Input.dispatchMouseEvent派发，正确button/buttons/modifiers。move一个mouseMoved；click先move再一/两组pressed/released，双击clickCount依次1、2；drag先move/press，再steps个线性位置mouseMoved，最后release，t_i=i/steps、i=1..steps，合计steps+3事件。durationMs均分到移动步之间（可取消timer），绝不以DOM click/dispatchEvent冒充可信输入。
6. finally 对已按下button尽力release；ABORTED/断连不无限等待。返回实际eventCount、completed与released（放vision.metrics）；部分派发不自动重放。drag终点只验证在视口和frame边界，允许进入另一元素作为drop目标，不要求和起点backend相同；过程不承诺业务拖拽或路径命中每个内部对象。结束后按§2.5取单次after product。

T2 `browser_click` 继续使用ref/唯一selector、自动滚入、语义目标composed descendant命中、禁用/遮挡拒绝；T3 act 用**当前截图中的指定顶层命中点**，不声称知道调用者期望哪个DOM对象。它可以点canvas内部的像素，却不能“穿透”遮挡层：若截图本来含overlay，点击命中的是overlay；若截图后新overlay出现，重采样hash改变而拒绝。要证明点击某语义目标，应优先T2或用外部命中事实验证；T3不是T2 hidden/covered错误的force逃生口。T2 escalation=T3只提示需要视觉分析，不自动授权任何坐标输入，也不证明元素可交互。

单次drag是有限输入原语，可以比较起止静态画面；拖拽动画、路径连续正确性、闪烁、过渡完成时间与多动作策略属于T4。不得以before/after两帧宣称没有中间闪烁。

## 7. 六类缺陷、外部事实与视觉判断

### 7.1 显式事实 schema 与可信度

Fact 不含 selector/HTML/自由文本。由调用方从已有browser_snapshot/node_state/computed_style/eval结果中显式提取；vision工具不重新查询或自动刷新。所有Fact在证据投影标记trusted=false（用户声明事实），保留来源供审计，不能声称插件独立验证DOM。调用方不传trusted字段；provenance的页/代次字段从外部T2工具evidence.provenance及其action envelope取得，computed_style/eval不提供时需同时保存一次T2观察的身份元数据，不能猜测页代次。

```text
Fact={id*:Name,provenance*:{sourceTool*:"browser_snapshot"|"browser_node_state"|
 "browser_computed_style"|"browser_eval",sourceActionId*:string(1..128bytes),
 observedAt*:epochMs,scopeId*:string(1..128bytes),runtimeId*:string(1..128bytes),
 pageGeneration*:integer>=1,documentEpoch*:integer>=0},
 rect?:CssRect,containerRect?:CssRect,visible?:boolean,
 hitSamples?:[{point:Point,covered:boolean}](1..25),
 scroll?:{scrollWidth:number>=0,scrollHeight:number>=0,clientWidth:number>=0,clientHeight:number>=0},
 style?:{overflowX:"visible"|"hidden"|"clip"|"auto"|"scroll",
 overflowY:"visible"|"hidden"|"clip"|"auto"|"scroll",
 whiteSpace:"normal"|"nowrap"|"pre"|"pre-wrap"|"pre-line"|"break-spaces",
 textOverflow:"clip"|"ellipsis",lineClamp:integer>=0,
 color:RGB,backgroundColor:RGBA},
 textMetrics?:{contentWidth:number>=0,contentHeight:number>=0,
 availableWidth:number>=0,availableHeight:number>=0},
 presence?:{expected:boolean,exists:boolean,searchComplete:boolean},
 allowOverflow?:boolean=false,allowTruncation?:boolean=false}
```

所有内层对象拒绝未知字段；style各成员可选但不能空对象，scroll/textMetrics四项均必填；hitSamples.point用文档CSS坐标。epochMs为finite number≥0。Fact rect若来自T2视口bbox，调用方必须先加该次scroll转换文档坐标，并保留原actionId；直接把视口bbox冒充documentCSS是调用方错误。provenance缺失/字段类型错→INVALID_ARGUMENT，合法但与图像scope/runtime/page/document不等，或abs(observedAt-capturedAt)>1000ms→该fact不可融合、INCONCLUSIVE/reason=fact-stale-or-mismatch，不能拿旧fact证明当前页面。基线只图像无当前页来源，不能拿基线provenance作当前fact；required缺陷要求case.source为live/capture lineage，mapping非null。

即使来源匹配，输入事实仍未经独立验证，metrics 加 `factsVerified:false`、warning=fact-unverified。这里required PASS/FAIL含义是“根据调用方声明、匹配出处的事实与图像的规则判定”，不是来源真实性担保；伪造fact不能绕过输入动作校验或访问其他scope。

### 7.2 信号与决策（必须按此实现）

每条缺陷 assertion region 都必须有效。外部事实的rect与region转documentCSS的交集必须正面积；否则INCONCLUSIVE/reason=fact-region-mismatch。下面metrics均同时加 `pixelSignal:boolean|null,factsVerified:false,fusion:"pixels-only"|"external-facts"|"none"`；不适用数值为null，不能省略关键分母。required没有下列必需fact字段时不能PASS/FAIL，返回INCONCLUSIVE/reason=insufficient-facts；advisory可按像素信号给WARN或INCONCLUSIVE，像素无异常也不等于证明无缺陷。

| 类型 | 纯像素信号（仅 advisory） | 外部事实融合与required规则 | 专属 metrics |
| --- | --- | --- | --- |
| layout | components默认背景白/tol16，任意非背景component接触ROI四边为signal；只能提示贴边/裁切风险 | fact.rect + expectedRect；四项绝对差最大值>toleranceCss为FAIL，否则PASS；需fact与region匹配 | `maxDeltaCss,toleranceCss,edgeTouchCount` |
| occlusion | ROI分成4×4整格（边界按floor(i*W/4)），非空格中最大量化主色桶占比≥0.95且覆盖≥一半ROI面积为signal；纯色组件也可能满足 | fact.rect + visible + hitSamples；visible=true，至少5个不重复、位于rect内的点，必须含中心和四象限各一点；coveredRatio=covered/n，>maxCoveredRatio为FAIL，否则PASS；visible=false为INCONCLUSIVE（不可见≠被遮挡） | `samples,coveredSamples,coveredRatio,maxCoveredRatio,dominantFraction` |
| overflow | 与layout同edgeTouchCount信号 | fact.scroll + style.overflowX/Y + allowOverflow；dx=max(0,scrollWidth-clientWidth)，dy同；任一超tolerance且对应轴overflow=visible且allowOverflow=false为FAIL；允许滚动auto/scroll或hidden/clip不因scroll尺寸本身判溢出，PASS（仅本规则） | `overflowXCss,overflowYCss,toleranceCss,allowed` |
| truncation | Sobel边缘像素在ROI右/下边1px带非零为signal；不能识别文字或省略号内容 | fact.textMetrics + style（overflowX/Y、whiteSpace、textOverflow、lineClamp）+ allowTruncation；width/height content超available>tolerance且相应轴hidden/clip，或lineClamp>0且高度超差，为clipped；clipped且!allowTruncation→FAIL，否则PASS | `excessWidthCss,excessHeightCss,clipped,allowed,toleranceCss,boundaryEdgePixels` |
| color | ROI alpha>0像素中与expectedColor maxRGB差≤tolerance比例<minFraction为signal；抗锯齿/文字前景可能触发 | fact.rect + fact.style.backgroundColor（仅该背景区域，不混用文字色）；ROI必须完全落rect内，backgroundColor alpha=255；匹配比例<minFraction且fact背景RGB也超tolerance→FAIL，两者均匹配→PASS；相互冲突/透明背景→INCONCLUSIVE | `sampledPixels,matchingPixels,matchingFraction,minFraction,tolerance,styleMatches` |
| missing | 执行显式Query，count<minCount为signal；无匹配不等于语义组件缺失 | fact.presence.expected=true、searchComplete=true；count<minCount且exists=false→FAIL；count≥minCount且exists=true→PASS；其余冲突/不完整→INCONCLUSIVE | `candidateCount,minCount,expected,exists,searchComplete` |

布局/滚动/截断的required规则依赖显式意图（expectedRect、allowOverflow/allowTruncation）；不是由视觉启发式猜测产品设计。像素信号与几何事实可能不一致：layout/occlusion/overflow/truncation由具备全部字段的外部事实规则决定，并保留pixelSignal，不能把不一致省略；color/missing按双信号一致才PASS/FAIL。required的PASS只证明指定ROI、指定规则，没有覆盖其他区域。

advisory且fact完整时，同规则可给PASS或WARN；没有完整fact时pixelSignal=true→WARN，false/null→INCONCLUSIVE。对于regression无需外部fact，图像阈值本身是显式required断言。最终“视觉缺陷判断”就是这些规则的status汇总及证据，不另造无依据AI结论。

### 7.3 正负例与已知假阳性

| 类型 | 确定性正例（FAIL） | 负例（PASS） | 假阳性/不能判定边界 |
| --- | --- | --- | --- |
| layout | 固定盒从expected x=100移到x=104，tolerance1、事实x=104 | x=100.5其余相同，maxDelta0.5≤1 | 无expected布局；设计允许的负margin、边缘吸附、transform；pixels-only不required FAIL |
| occlusion | 5点中中心+右上被overlay盖住，coveredRatio2/5>0 | 相同目标overlay设pointer-events:none，5点全未covered | 视觉半透明遮挡可能仍命中目标；采样漏掉小角遮挡；disabled/hidden不等于covered；无采样不推断 |
| overflow | overflow:visible且scrollWidth=150/clientWidth100，无allowOverflow | 同尺寸overflow:auto作为可滚容器，或allowOverflow=true | 阴影、装饰、absolute子项、写字方向；scroll差并不证明实际像素越界，精度限声明规则 |
| truncation | nowrap/hidden/textOverflow:ellipsis，contentWidth180/available100，allowTruncation=false | 同盒allowTruncation=true，或availableWidth180 | ellipsis可能是设计；多行字体/line-height/ligature度量不准；无OCR不能识别末尾词是否可读 |
| color | 纯红卡片expected红，图像/声明背景均蓝，tol16/minFraction0.95 | 纯红图像/声明背景均红 | 文字/渐变/图片/混色区域，透明叠加与色彩管理；双方矛盾为INCONCLUSIVE，不能只信style |
| missing | 期望红色模板组件移除，count0，presence exists=false/searchComplete=true | 恢复组件，count1，exists=true | 模板不同缩放/抗锯齿/主题/部分遮挡；DOM存在但透明或离屏、canvas无DOM内部身份，均可能INCONCLUSIVE |

对任何无fact pixels-only正例都必须另跑advisory模式验证WARN，并跑required模式验证INCONCLUSIVE；不能将本表正例的DOM真值偷塞入视觉算法。

## 8. 基线存储、CAS 与回归流程

### 8.1 根、隔离与安全写入

持久根选择与P0一致：非空 `DSH_UI_TESTING_CAPTURE_DIR` 优先，否则可信exec session cwd的realpath。非法env不回退；无可信根报VISION_BASELINE_ROOT_UNAVAILABLE。scopeHash=`sha256(scopeId UTF8).hex.slice(0,32)`，根为该持久根下 `output/vision-baselines/<scopeHash>`，每级realpath守卫，拒绝symlink叶文件与越界父目录。scope身份只用可信解析链，不接受调用方scopeHash。共享env根也因scopeHash隔离。目录0700、PNG及JSON0600。不是对本地恶意进程TOCTOU的完整沙箱，基线是证据而非安全授权边界。

仅显式create/update可创建根/名字目录；导入插件、capabilities、image/find/compare/check、list/get/delete均不mkdir。get读取已有路径是只读行为；baseline Source解析也不得创建目录。list无根成功[]；get/delete不存在报NOT_FOUND。create/update的根/权限失败分类见§3.3，不静默写暂存。

### 8.2 不可变revision与逻辑HEAD

不原地覆盖PNG、JSON或head.json。每名目录：

```text
<name>/images/<revision>-<actionId>.png
<name>/heads/0000000001.json
<name>/heads/0000000002.json
...
```

head文件是规范JSON：UTF8、对象key字典序递归排序、无空白、末尾LF，包含BaselineMeta全部字段（headToken不写入自身，返回时计算精确文件字节hash）。revision1 parentRevision=null；后续parentRevision=n，追加头revision=n+1。逻辑HEAD是连续存在且parent链接与hash验证有效的最大提交revision；不扫描猜“最新mtime”。head文件不连续或损坏为READ_FAILED/corrupt，不跳过损坏记录复活旧HEAD。

create先检查从未使用该名字，写images/1-<actionId>.png，验证hash/尺寸，然后以P0式wx临时+fsync+link no-clobber发布heads/0000000001.json，**head link成功是提交点**。update先读HEAD，expectedRevision必须等于n且非tombstone，写新PNG，再争抢heads/(n+1).json；同一父revision两个写者仅一个link成功，另一个CONFLICT。发布前再次读parent确认；不得rename覆盖。PNG的文件名按actionId唯一，每次发布no-clobber；不因相同hash覆盖旧图。revision2起head JSON另含 `parentHeadToken:string`（上一head文件的sha256），revision1为null；BaselineMeta及list/get亦必须返回此字段，以便验证父链。headToken始终是本head文件字节hash，不写入自身，source的productId不参与访问授权。

delete不创建新目录，在现存heads追加revision n+1墓碑，image=null、保留caseId/options/thresholds/masks/source摘要；expectedRevision同样CAS。它是逻辑HEAD更新，PNG历史保留。更新/删除墓碑HEAD为NOT_FOUND；create同名为EXISTS。revision用安全整数，文件名十位零填充，最大9,999,999,999，耗尽LIMIT_EXCEEDED。仅校验revision<=上限，不与JS unsafe整数混用。

提交前失败清理本次已知临时文件和本次未引用PNG（先验证resolved绝对路径属于此次action及根）；提交后取消/目录fsync异常不删除HEAD或PNG，错误details含committed:true与安全revision，调用方先get核对再决定，不能重放update。正常路径无孤儿；崩溃可能遗留images或临时文件，不自动回收、不占用名字commit语义。读取只认committed heads；磁盘文件被外部篡改/hash不符→READ_FAILED，不提供被篡改product。无锁head CAS只保证本地文件系统原子link支持的并发提交，网络文件系统不额外保证。

### 8.3 用例格式及一调用流程

建立基线（一个工具调用）：

```json
{"action":"create","name":"card-light","caseId":"card-light","source":{"kind":"live","scale":1,"region":{"x":0,"y":0,"width":400,"height":240}},"masks":[{"id":"clock","region":{"x":300,"y":10,"width":80,"height":20}}],"options":{"threshold":0.1,"includeAA":false,"minRegionPixels":1},"thresholds":{"warnRatio":0.001,"failRatio":0.01}}
```

显式更新（一个调用；expectedRevision来自前次返回/get/list）：

```json
{"action":"update","name":"card-light","expectedRevision":1,"source":{"kind":"live","scale":1,"region":{"x":0,"y":0,"width":400,"height":240}}}
```

回归用例集是check参数本身，可存为外部JSON文件由调用方加载；工具不接收文件路径、不exec shell：

```json
{"cases":[{"id":"card-light","source":{"kind":"live","scale":1,"region":{"x":0,"y":0,"width":400,"height":240}},"assertions":[{"id":"pixels","type":"regression","baseline":"card-light"}]}]}
```

baseline不存在→该assertion BLOCKED/errorCode=VISION_BASELINE_NOT_FOUND，总exitCode2，不自动接受当前图。颜色/布局主题、字体、Chromium/OS版本及viewport由调用方固定，本文不自动改页面。required regression要求相同图像尺寸及兼容mapping（cssPerPixel、originCss、capturedCssRect逐轴差≤1e-9），否则BLOCKED/reason=mapping-incompatible、errorCode=VISION_SIZE_MISMATCH（仅实际尺寸不同）或null（映射不同）；compare本身仍可图像模式比较。case source缺mapping但severity=advisory允许像素比较，状态PASS/WARN而非required PASS。

mask ID、PixelRect、options、thresholds存于基线head；无覆盖时复用，调用方覆盖须完整体现在resolved字段，不能静默变更基线。mask区域只代表调用方明确排除的空间，不证明所有动态内容已排除。两个时间点无法发现中间闪烁、动画轨迹、偶发加载；需帧序列时升级T4并记录animation-not-evaluated。

CI/Agent使用同一个CheckResult verdict/exitCode；验收runner才将exitCode映射操作系统退出码。回归FAIL是产品断言失败，不抛工具错误；参数错误/环境无法运行应作为runner exit2，不能计作视觉FAIL。报告保留source hash、baseline revision/headToken、resolved阈值/mask、metric、区域与状态，避免仅凭“通过/失败”文字。

## 9. 编号验收条件（56条）

以下每条是独立criterion，报告用 `criteria:["§9.C1"]` 等精确引用；每条可有多项requiredChecks，任何必需断言失败则criterion FAIL。**B=真实Chromium进程内**：真实apply(ctx)+fake Cordis ctx+真实插件工具+所属无头Chromium，不启动DSH实例、不直接用测试CDP替换被测路径。**U=纯算法单测**：受控RGBA/PNG/临时文件与可注入时钟/故障，无须Chromium；不能拿U声称页面行为已验证。B类可同时配U，但B required不能被U代替。

**实现期裁决摘要（2026-11-01，Lead裁决；作者只读报告，未重跑）**：以下限定说明适用于后续复跑，并优先于原验收表中对应子项的简写。[实现验收报告](../tests/acceptance/runs/2026-11-01T07-27-41-484Z-163114/run-report.json#L17195-L17223)记录56/56 criteria、389项required全过、exit0。C4 live小数尺寸允许每轴floor/round差1（Chrome实测79.5×59.5得到79×59）；仅限该小数clip子项，mapping仍覆盖请求rect，101×50@1.11仍要求112×56，不改既有P0截图契约。C42/C50在本验收中以B类覆盖，表内U保留为原契约分类，报告注明implemented as B。C28 viewport子项允许使用插件自身 `POST /plugins/ui-testing/viewport` 路由（scopeVersion=1及sessionId）做setup，断言仍来自vision_act。C31因ABORTED关页而无法读页面级downs/ups时，该子项记 `NOT_APPLICABLE`（取代早期NOT_RUN记录），仍核对取消不重放、button释放、dispatch计数及after null。成功业务体证据固定嵌套为 `evidence:{vision:...}`，错误仍为 `details.evidence.vision`，不接受扁平形式。C25的工具/DOM坐标精度及裸CDP证据按§6区分，不能把DOM小数不可观测记作实现缺陷。

实施者新增确定性靶机 [web-t3.html](../tests/ui_test_fixture/web-t3.html)（待实现）及server路由、README真值表：默认1280×800，document高1600，所有盒绝对整数CSS位置、无外链/随机/自动动画；区域：`#t3-red`=(40,40,80,60)纯红、`#t3-blue`=(160,40,80,60)纯蓝；`#t3-canvas`=(40,140,160,80)内部左右红蓝各80×80；`#t3-click`=(300,40,80,60)点击计数；`#t3-drag`起点=(300,160)，drop中心=(420,160)；`#t3-overlay`覆盖click中心（默认hidden）；`#t3-clock`=(500,40,80,20)仅显式toggle变色；六缺陷容器在y=400–750之间，分别固定id `t3-layout/occluded/overflow/truncated/color/missing` 与对应正常副本。window.__t3记录事件type/isTrusted/clientX/clientY/buttons/modifiers和输入计数，提供显式reset/设置场景函数与声明真值（只能用于验收取证，视觉工具不得读取插桩）。动画用专属显式启动场景；其他测试一律静止。

| 编号 | 跑法 | 断言点 | 确定性场景与正负例 |
| --- | --- | --- | --- |
| §9.C1 | B | 注册恰好22工具，新6名称/required数组符合§2.1，原16名称/schema required及参数语义不回归；capabilities仅诊断 | 冷启动fake ctx查注册表及capabilities，运行原T1/T2关键输入/截图探针 |
| §9.C2 | U | root及嵌套未知字段、非有限/错误类型、非法Name、条件字段冲突拒绝；纯参数错误零ensure/文件/CDP | 对六工具参数注入未知字段、负尺寸、小数PixelRect、NaN、Source.path/base64 |
| §9.C3 | B | live默认/scale1.25/source.region允许，P0实际尺寸、原始hash与mapping正确；不改变viewport/scroll | 红块80×60 @1.25=100×75；对同区域@1读回纯红 |
| §9.C4 | B | live CSS小数合法，越文档边界/零面积/负原点在capture前拒绝；顶层PixelRect整数且越界拒绝 | document1600高，region底边1601；101×50@1.11=112×56；顶层x=0.5拒绝 |
| §9.C5 | B | product仅所属scope可读；跨scope同ID为SOURCE_NOT_FOUND，page导航后可离线读但act失效 | A采红图，B读取拒绝；A导航第二页后image读取旧图成功 |
| §9.C6 | U | store16项/128MiB/32MiB/16M限额，LRU读刷新、pin不淘汰、restart/dispose ID失效 | 合成17小图验证最旧项；填满pin后拒绝；超过编码/像素预算分别拒绝 |
| §9.C7 | U | inflate输出上限、RGBA1/2/3/4通道转换、unsupported/error拒绝、不伪造分析 | G/GA/RGB/RGBA PNG黄金样本；palette/16bit/interlace格式；CRC错/压缩炸弹 |
| §9.C8 | U | PNG encoder filter0/level9/chunk顺序/CRC/decodedRGBA确定，同运行重复字节相同 | 透明、单像素、条纹、alpha混色；两次编码hash等、再decode逐像素等 |
| §9.C9 | U | crop像素精确、nearest/bilinear公式、实际sx/sy mapping和16M预算 | 小色格crop后factor1.25；奇数宽高，半透明两像素bilinear避免黑边 |
| §9.C10 | U | 五种preprocess公式、顺序、alpha、常量通道、边缘clamp正确 | 3×3已知RGBA矩阵；全透明normalize；channels argb改变alpha；顺序交换结果不同 |
| §9.C11 | U | 四类annotation、数字字形/覆盖顺序/边界/source-over可复现，不依赖字体 | rect/cross/arrow/编号1/10/999叠加到4色图，黄金RGBA和重复hash |
| §9.C12 | B | image一次裁剪+recognize与analysis同图标注前统计；像素/文档bbox及region坐标正确 | red图所在ROI裁剪，recognize color红；添加蓝编号后统计仍红 |
| §9.C13 | U | analysis全量average/min/max/alpha/量化桶顺序/edgeRatio正确 | 4×4已知RGBA、透明图、两桶同count验证字典序，不稀疏抽样 |
| §9.C14 | B | color/tolerance/components/edges确定候选、ROI回加、未命中成功[]、semanticName=null | red/blue与canvas图；tol0精确红，color绿无候选；只选red ROI |
| §9.C15 | U | 8邻接/area/minArea/centroid/排序/maxResults和truncated正确 | 对角相连2像素、小噪点、同area异y/x、环形连通域 |
| §9.C16 | U | Sobel边界/阈值和template评分/stride/NMS/50M预检完全符合§5 | 黑白阶跃；复制模板两个位置；IoU恰0.3与>0.3；超比较预算零扫描 |
| §9.C17 | B | before product→真实click→after live取得不同时间/不同hash，无隐式动作/等待；双live恰两次 | click改变固定纯色卡片；事件日志仅外部click一条；compare两live在静止页相同 |
| §9.C18 | U | YIQ公式/严格阈值/透明白底/threshold0/1测试，公式黄金数值 | 1×1白黑/透明红透明蓝/alpha128；恰阈值边界构造，断言D |
| §9.C19 | U | AA3×3排除及includeAA=true翻转、边角equal初值与tie顺序 | 预构造亮暗ramp/相等邻居≥3/边界ramp；断言A/D和分母 |
| §9.C20 | U | diffRatio与similarity正确；mask并集不重计；AA仍在分母；全mask抛EMPTY | 100×100变化100像素，mask重叠；0/1相似度；N=M拒绝不返回1 |
| §9.C21 | U | fail/warn阈值默认与等号、ratio不四舍五入、错误顺序拒绝 | 10000像素D=10 PASS、11 WARN、100 WARN、101 FAIL；warn>fail拒绝 |
| §9.C22 | B | diff双坐标mapping、scroll与scale换算、尺寸不等错误、不兼容mapping不伪CSS | 红块scale2截图对，改其中10CSS×10CSS；另一原点同尺寸compare CSS=null |
| §9.C23 | U | 差异8邻接区域/area排序/过滤/100截断/高亮黄金像素，过滤不改D | 孤立101色块、对角diff；minRegionPixels过滤小噪点仍计入ratio |
| §9.C24 | B | clock动态区域显式mask复用，mask不改变源图，不自动侦测动态 | clock显式toggle：无mask非PASS，恰mask PASS；漏一像素仍计差 |
| §9.C25 | B | act screenshot point→document→viewport映射及isTrusted；工具侧imagePixels/documentCss/viewportCss保留连续小数，不主动取整 | scroll y=100再capture canvas region@1.25；工具映射坐标误差≤0.01CSS，DOM clientX/clientY每轴误差≤1CSS；Blink截断时“DOM保留小数”记NOT_APPLICABLE并附§6裸CDP证据 |
| §9.C26 | B | move/click/right/middle/doubleclick/modifiers真实事件序列及eventCount | click盒日志验证buttons、ctrl/shift，double click两组clickCount1/2 |
| §9.C27 | B | drag steps+3事件、to/时间/线性路径、finally释放与after product | 静态canvas拖起止，steps4/duration0，日志每步坐标与isTrusted；drop真值另核对 |
| §9.C28 | B | 旧图页面代次/scroll/viewport/像素变化拒绝零输入，不自动scroll | 截图后overlay显示、scroll+1、resize、reload分别STALE；日志计数不增 |
| §9.C29 | U | 年龄>30000、派生年龄不刷新、非actionable各处理/基线/diff拒绝 | 注入时钟30000允许/30001拒绝；crop+nearest可、bilinear/annotation/threshold不可 |
| §9.C30 | B | 无命中/disabled/inert/不稳定/iframe拒绝零输入，不穿overlay，T2边界保持 | 现存overlay被截图后act命中overlay而非下层；新overlay触发STALE；移动靶建议T4 |
| §9.C31 | B | 部分拖拽取消不重放、button释放/dispatch计数和after null正确 | fixture首个mousemove触发可控中止；断言无自动第二次press，error保留partial |
| §9.C32 | U | 全成功/失败均vision.version1纯JSON，缺失null/incomplete，限制与错误taxonomy正确 | 参数/BUSY/算法超时/CDP断连故障；JSON往返、无undefined/Buffer/绝对错误路径 |
| §9.C33 | U | 只有create/update mkdir；root env优先/坏env不回退/无root/名字非法/只读失败码 | 临时目录，计数fs调用；list空/get缺失/compare缺baseline均不创建 |
| §9.C34 | U | baseline PNG/JSON0600、目录0700、原子no-clobber/realpath守卫、历史字节不变 | 预置symlink/../名字/同目标；同revision已有时冲突，记录inode/hash不变 |
| §9.C35 | B | 单create调用采live提交revision1，get/list可列PNG元数据、case/options/mask/provenance | 创建card-light；无需先image；解码磁盘PNG与sourcehash核对 |
| §9.C36 | U | update继承/显式覆盖、不可变revision、CAS两个写者仅一个HEAD成功 | 两独立store以expected1抢revision2；一成功一CONFLICT，旧PNG不变 |
| §9.C37 | U | delete tombstone/CAS、get HEAD不可用/旧revision可审计、名字不可复用 | create→update→delete；list含tombstone；create同名EXISTS，不删PNG |
| §9.C38 | U | 提交前清理、提交后不回滚、hash/metadata损坏READ_FAILED、不猜旧HEAD | 在PNG写/headlink/提交后fsync注入故障；缺号、篡改PNG、JSON坏各拒绝 |
| §9.C39 | B | baseline跨工作区不可见、重启product失效基线仍可get、dispose不删显式数据 | 共享env根A/B；新插件实例同可信scope读A基线，旧product拒绝 |
| §9.C40 | B | regression继承baseline masks/options/thresholds，显式[]清空，图像diffProduct可后续使用 | card-light clock变化继承PASS，清空mask为WARN/FAIL，get metadata不变 |
| §9.C41 | B | check无baseline=BLOCKED/2、不自动建立；required尺寸/mapping不兼容阻塞 | 名称missing；同尺寸不同origin；不同scale；查看根无新增 |
| §9.C42 | U | Cases/assertions/facts长度/ID/字段验证，FAIL/BLOCKED/INCONCLUSIVE/WARN/PASS优先及summary/exitCode | 混合五状态批；WARN only exit0，FAIL+BLOCKED exit1，未知无FAIL exit2 |
| §9.C43 | B | layout正负例required基于声明fact，pixels-only required未知/advisory提示 | x100→104 FAIL、100.5 PASS；贴边组件纯像素WARN且required INCONCLUSIVE |
| §9.C44 | B | occlusion5点覆盖比例/visible/样本完整，正负例及无fact未知 | overlay盖2/5 FAIL；pointer-events:none全false PASS；只1点或hidden INCONCLUSIVE |
| §9.C45 | B | overflow visible超量FAIL、auto/allowOverflow负例PASS；像素不冒required | scrollWidth150/client100，visible→FAIL；auto→PASS；无facts贴边WARN/未知 |
| §9.C46 | B | truncation度量+clip/lineClamp/allowTruncation，设计省略负例 | 单行180/100隐藏FAIL；allow=true PASS；无textMetrics只边缘信号未知 |
| §9.C47 | B | color图像+声明背景一致才PASS/FAIL、冲突/透明未知 | expected红实际蓝/事实蓝FAIL；红/红PASS；图红事实蓝、alpha128 INCONCLUSIVE |
| §9.C48 | B | missing template count与presence完整性一致规则、缺失与恢复正负例 | 移除固定红图标count0/existsfalse FAIL；恢复PASS；DOM存在模板不匹配未知 |
| §9.C49 | B | facts显式提供、来源标记trusted=false、vision不读DOM事实；无facts六类不伪required结论 | 工具CDP日志只截图无getComputedStyle/eval取事实；事实由外部T2/eval调用提供 |
| §9.C50 | U | fact scope/runtime/epoch/时间>1000/ROI不交拒融合、类型缺字段预检 | 1000ms允许/1001未知，换scope/epoch未知，缺provenance INVALID_ARGUMENT |
| §9.C51 | B | output默认暂存/显式持久/env触发、0600/no-clobber/hash/附件元数据符合P0 | 派生crop输出读文件等base64；同out重试OUTPUT_EXISTS；持久根坏不回退 |
| §9.C52 | U | 算法工作集/5s取消/让出事件循环不半交付、不修改基线；检查已完成case保留 | 大矩阵触发可控预算与ABORT；确认无输出正式文件、无伪PASS、已提交HEAD不回滚 |
| §9.C53 | B | 原图/派生/diff附件image delivery和capture源hash独立，不能以metadata证明provider可见 | 假附件服务返回下采样/缺width；warnings/null正确，base64依旧原尺寸 |
| §9.C54 | B | canvas静态识别与点选可用，scale不承诺backing-store细节，不输出语义/OCR | canvas左右色块候选；文字图像semanticName=null；内部位图放大仍相同源细节 |
| §9.C55 | B | single-owner BUSY/队列串行/scope隔离；失败/取消不串store或输入 | ownerA持有，B page/离线vision均BUSY；两个scope各自产品/基线与页面操作独立 |
| §9.C56 | B | 完整闭环与报告诚实：capture→find→act→compare→baseline→check，22能力映射可追溯，T4仍unsupported | 一次静态canvas点击变色闭环；显式短暂闪烁场景两端一致仅静态PASS，不声称无闪烁；真实宿主/provider仍NOT_RUN直到另证 |

报告路径沿用 [验收套件](../tests/acceptance/t2-structured.mjs) 范式：`tests/acceptance/runs/<iso>-<pid>/run-report.json`、run.log，包含56项criteria、requiredChecks、工具注册信息、Chromium/Node/zlib版本、图像hash/尺寸、每类正负例、未运行项及清理结果。算法单测可独立报告但需合并追溯criterion，不能重复计数替代B类。验收runner exit0=全部required通过，1=任何required失败，2=套件无法运行；NOT_RUN不是PASS。真实宿主加载/provider专项不能由B类替代。测试只清理此次创建的fixture、browser/profile、product暂存及临时持久根，不触及3080/3081或用户历史基线。

## 10. 22 项能力到工具、参数和证据的映射

| 序号/能力 | 工具/参数入口 | 必需证据与边界 |
| --- | --- | --- |
| 1 静态截图分析 | image.source、analysis；可加recognize | Analysis全量统计、source hash/采集时间；无断言INCONCLUSIVE |
| 2 区域裁剪与放大 | Source.live.region/scale；image.region/resize | mapping、原始与派生尺寸、bitmap-upscaled区分光栅与插值 |
| 3 截图标注 | image.annotations | 四类确定性raster、输出PNG hash、source lineage |
| 4 图像预处理 | image.preprocess | 五op顺序、operations及输出hash；不自动判正确 |
| 5 视觉元素识别 | find.query或image.recognize | color/components/edges/template与score公式；无OCR/语义 |
| 6 视觉元素定位 | find.region/query | candidates.region/documentCss/centroid，非DOM身份 |
| 7 坐标交互 | act.productId/action/point/to | CDP可信dispatch、双坐标、freshness/hit/after product |
| 8 操作前后对比 | image → 外部T1/T2/act → compare.before/after | 两源product/hash/timestamp，act自身不代替compare |
| 9 像素级差异检测 | compare.options.threshold/includeAA | YIQ D/A/C、diffRatio，固定算法版本 |
| 10 差异区域高亮 | compare输出PNG/regions | 红diff/黄AA/灰mask/蓝bbox、完整源图坐标 |
| 11 图像相似度计算 | compare.comparison.metrics.similarity | 1-D/C∈[0,1]、不是语义/SSIM/模板score |
| 12 动态区域屏蔽 | compare.masks；baseline.masks | ID+PixelRect并集、maskedPixels与分母、无自动时序学习 |
| 13 视觉基线管理 | baseline五action | scoped根、revision/headToken/CAS/元数据、墓碑 |
| 14 视觉回归测试 | check cases/assertions.type=regression | resolved阈值/mask、PASS/WARN/FAIL/BLOCKED及exitCode |
| 15 布局异常检测 | check assertion layout | edgeTouch advisory；显式expectedRect+fact.maxDeltaCss |
| 16 元素遮挡检测 | check assertion occlusion | 像素主色advisory；外部命中采样覆盖率 |
| 17 内容溢出检测 | check assertion overflow | 贴边advisory；外部scroll/style/允许溢出意图 |
| 18 文字截断检测 | check assertion truncation | 边缘advisory；外部文本度量/clip/允许截断意图，无OCR |
| 19 颜色异常检测 | check assertion color | ROI颜色比例+外部背景色一致性，否则未知 |
| 20 组件缺失检测 | check assertion missing/query | 候选数量+完整presence事实，无匹配本身仅advisory |
| 21 视觉缺陷判断 | check多assertions与summary/verdict | 各类型规则证据与status合成，截图成功不自动PASS |
| 22 裁剪指定区域识别 | image.region={x,y,width,height}+recognize，或find.region+query | 同一工具调用的裁剪/识别/统计，crop回映射，越界拒绝 |

## 11. 实施交接与非目标

实施边界沿用现有模块职责：Host注册/Runtime/队列在 [index.js](../index.js)；PNG校验/路径在 [capture-p0.js](../capture-p0.js)；新增纯算法与store/基线模块由执行者合理拆分，不要求将所有逻辑塞入Host；错误分类接 [browser-safety.js](../browser-safety.js)。不得改 [client.js](../client.js)。新增工具名/schema、总数22、web.t3.image/find/compare/act/baseline/check与22能力映射需同步Skill、declared-capabilities、验收harness/check-skill及项目状态。`browser_capabilities`新增 `vision:{version:1,algorithmVersion:"t3-v1",tools:[六名],sourceKinds:["live","product","baseline"],limits:{...本文全部预算},observed:null|{observedAt,lastOperation,lastVerdict}}`，observed不含图像/绝对路径/页面文本；冷启动不生成observed。六能力及静态聚合按实现和BUSY状态报告，不因文档存在就available；T4仍unsupported。

非目标及不能外推的保证：无VLM语义理解、OCR/文字命名/可读性理解、任意图片导入、跨frame坐标输入、跨workspace访问、跨重启product恢复、自动基线接受/更新、自动阈值学习、自动动态mask、图像配准/透视/旋转/模板缩放、SSIM/感知模型、色彩profile转换、动画时序、连续视觉推理、无中间闪烁保证。Canvas/WebGL已有内部位图不会因scale新增细节；输出图可分析内部最终像素，不能识别其内部对象语义。外部facts是调用方声明的证据，不能当插件独立读取DOM；采样命中、AA、连通域和模板都有明确假阴性/假阳性边界。像素相等只支持指定截图区域、分辨率、时间和阈值下相等，不证明业务、交互、可访问性或整个页面正确。

本次文档交付没有新增待Lead裁决的技术选择。开放的运行风险必须由实施报告覆盖：纯JS大图时延与内存预算、透明/字体抗锯齿假差、文件系统link/fsync支持及崩溃孤儿、TOCTOU、截图与外部事实非原子采样、真实宿主/图像provider交付。尚未实施与验证时，一律记录NOT_RUN，不宣称T3已完成。
