# WEB-T4 实施契约

> 2026-11-04 · task-1 · 冻结接口第一版。本文仅为静态分析与实施交接，未运行实现、浏览器或验收。
> 权威语义为 [动态行为契约](t4-dynamic-behavior.md)；本文固定其中未展开的实现名字和形状。Lead 本轮明确裁决记录在 §10。遇未裁决冲突以权威文件为准，不由执行者改变口径。
> 本文作者唯一写入范围是本文。索引、状态、权威契约、实现和测试由 Lead/执行者持有；不因文档通用规则扩大写入范围。文档无需重启；后续 Host/schema/Skill 变更需宿主重新加载，进程内验收不证明 3080 已更新。

## 1. 公共 schema、预算和执行边界

所有根与嵌套对象均 `type:object,additionalProperties:false`。下表中 `*` 表示执行期必填；注册 required 仅按 §2 固定数组。缺失应用默认，显式 null 不代表省略；拒绝隐式类型转换、非有限数、重复 ID、未知字段和不适用字段。纯校验先于 ensure、队列激活、文件创建、控制与 CDP 派发。

| 公共类型 | 固定字段与边界 |
| --- | --- |
| `Id` | 非空 string，UTF-8 ≤128 字节；不透明会话/事件身份，不接受路径、调用方 base64、JS 表达式；未知、跨 scope、已淘汰同形处理 |
| `Ids` | `Id[]`，1–200，无重复；targetIds 专用上限 20 |
| `Name` | 非空 string，UTF-8 ≤64 字节；只对 start 适用，默认 `default` |
| `Rect` | `{x*:number,y*:number,width*:number,height*:number}`；有限 canvas CSS px，x/y 可负，width/height≥1 |
| `PixelRect` | `{x*:integer,y*:integer,width*:integer,height*:integer}`；x/y≥0，width/height≥1，左闭右开、完全处于实际图内，不 clamp |
| `Window` | `{fromMs*:number,toMs*:number}`；同动态会话轴、有限、fromMs≤toMs，不用墙钟充数 |
| `Mask` | `{id*:string,region*:PixelRect}`；id 沿 T3 Name，最多64个，ID唯一；像素排除为并集 |
| `Direction` | `operation->visual`、`operation->network`、`network->visual`、`visual->network`、`network->network`、`visual->visual` 六个固定字符串 |

常量冻结为 `T4_VERSION=1`、`T4_ALGORITHM_VERSION="t4-draft-v1"`、`DC_ALGORITHM_VERSION="dc-draft-v1"`。不改 T3 `t3-v1` 或其 `yiq-v1` 默认值。

`T4_LIMITS` 必须导出以下具体名字，并原样投影到 `limits.dynamic`（default/max成对保留，不把默认值说成硬上限）：

```text
{
  maxActiveSessions:1, retainedSessions:4,
  durationMs:3000, durationMsHard:60000, sessionCapMs:300000,
  maxFrames:180, maxFramesHard:300,
  maxBytes:33554432, maxBytesHard:67108864,
  maxFramePixels:4000000, maxFrameBytes:8388608,
  maxEvents:5000, maxEventsHard:20000,
  maxRegions:100, maxEvidenceBytes:262144,
  maxWorkingSetBytes:268435456, algorithmBudgetMs:5000,
  correlationPageSize:200, maxCandidateCompares:40000,
  correlationBeforeMs:250, correlationAfterMs:1000,
  maxCorrelationBeforeMs:5000, maxCorrelationAfterMs:5000,
  maxCalibrationSamples:5, maxClockUncertaintyMs:10,
  recalibrateAfterMs:10000, maxImagesPerObserve:3,
  sampleIntervalMsMin:50, sampleIntervalMsMax:1000,
  scaleMin:0.1, scaleMax:2, maxControlTargets:20,
  maxAssertions:20, maxIds:200, maxMasks:64
}
```

视觉 start/stop/reset、fresh 和真实 control 走既有 Runtime 串行队列与 owner。start 立即返回，后台任务跨调用受 duration 限制；不能把整段采集占在一个队列调用内。后台 callback 不嵌套申请队列，不续租成永久 owner；每次实际页面采样复验 owner、页面身份与取消状态，冲突停止本段并列 incomplete，不抢占新 owner。extend与status同属纯Host内存类；extend只调整本scope运行会话的到期定时器与审计记录，不ensure、不占页面租约、不发CDP、不是页面动作，不申请/续页面owner租约。存储 observe/analyze/correlate、status 与无待恢复页面控制的纯网络视图 start/stop/reset 仅 Host 内存与 scope 检查，不 ensure、不发 CDP、不申请/续租、不改 recent/error；scope stop/reset发现retained待恢复控制时转既有页面队列/owner检查，恢复仅使用现有原页面，不ensure新页面。保留既有 T3 离线 owner 语义，不顺手改旧工具。

## 2. 五工具根 schema 与条件校验

### 2.1 `browser_dynamic_session`

注册 required 固定 `["action"]`。根 properties 仅：

```text
action*:string enum(start,stop,status,reset,extend)
name?:Name
config?:DynamicConfig
durationMs?:integer [1,60000] (仅extend条件必填；表示本次追加毫秒)
```

`DynamicConfig` 封闭字段：

```text
captureVisual?:boolean=true
networkSessionId?:Id
source?:string enum(screencast,screenshot-loop)
encoding?:string enum(png,jpeg) (缺省按source派生：screencast=jpeg，screenshot-loop=png)
durationMs?:integer=3000 [1,60000]
maxFrames?:integer=180 [1,300]
maxBytes?:integer=33554432 [1,67108864]
region?:Rect
scale?:number=1 [0.1,2]
sampleIntervalMs?:integer [50,1000]
```

- name/config仅start接受；根durationMs仅extend接受。extend仅接受action/durationMs，durationMs条件必填；name/config及任何其他根字段均DYNAMIC_INVALID_ARGUMENT。start/stop/status/reset携带根durationMs也拒绝；start的初始时长仍在config.durationMs，不混淆两层字段。注册required保持["action"]。start无config等价 `{captureVisual:true}`，随后因缺source拒绝，不暗选帧源。
- `captureVisual:true` 必给 source。encoding缺省合法，按source派生：screencast唯一合法jpeg、screenshot-loop唯一合法png。显式不匹配抛 `DYNAMIC_SOURCE_UNAVAILABLE`，details固定 `{reason:"encoding-conflict",activeEncoding:"jpeg"|"png",supported:["jpeg"]|["png"]}`，零start/stop、预览不变。
- screenshot-loop 必给 sampleIntervalMs；region 可省略为该次真实 canvas viewport；scale 在 start 冻结，不随面板变化。逐帧实际输出不超过 4M px/8MiB，不隐式缩小。
- screencast 禁止 sampleIntervalMs。首版只接受 `scale:1`（缺失即1）、region 缺失；共享流不提供 clip/重光栅。参数合法但该源不能满足的 region/scale 要求以 `DYNAMIC_SOURCE_UNAVAILABLE` 拒绝，不能改预览。其模式检查与恢复详 §4。
- `captureVisual:false` 只接受 config 的 captureVisual/networkSessionId；networkSessionId 必填且为已有本 scope P0 会话。创建纯网络关联视图，motionSessionId=null；不启动浏览器或 P0，不停止/reset引用的 P0。
- 视觉和已有网络会话可同时引用。start 始终创建 dynamicSessionId，视觉启用才分配 motionSessionId。同 scope 已有活动会话：同 name + 归一化 config 完全一致幂等 changed=false；否则 `DYNAMIC_SESSION_ACTIVE`。
- 初始config.durationMs默认3000、单次硬上限durationMsHard=60000；Agent跨调用取running证据显式start配置durationMs=60000，并可在截止前显式extend追加时长。累计自startedAt起不超过sessionCapMs=300000。单调截止驱动实际定时器，同名幂等start、observe fresh/status/correlate均不续期。帧数/字节/算法预算、maxFrames/maxBytes不随时长自动增加；recalibrateAfterMs=10000以及timeMs/异常阈值0–10000边界全部保持。时长到界关闭本sink并执行本会话待恢复控制；reason仍duration，stop事件payload带最终cumulativeMs；仅有retained身份不延长采集。
- extend定位本scope当前会话，仅running且提交时尚未达到既有单调截止才允许；无本scope会话→DYNAMIC_SESSION_NOT_FOUND，已有stopped/retained或已到期→DYNAMIC_SESSION_NOT_ACTIVE。拒绝不复活会话、不重装sink、不生成新segment或跨段空档，不ensure、不占页面租约、不发CDP；不能通过续约绕过后台采样既有owner/文档检查。与到期回调在同一Host内存状态更新中串行裁决；到期已先成立不得以尚未运行回调为由延期。
- extend的durationMs为本次追加extendMs，不是新总长或从当前时刻重新计时：newDeadlineMs=previousDeadlineMs+extendMs，newCumulativeMs=previousCumulativeMs+extendMs。newCumulativeMs>300000时抛DYNAMIC_LIMIT_EXCEEDED，details固定 `{limit:"sessionCapMs",max:300000,actual:newCumulativeMs}` 并附统一evidence.dynamic；原期限/累计量/定时器/成功事件保持。整数[1,60000]外仍为DYNAMIC_INVALID_ARGUMENT。连续相同extend独立追加与记事件，不幂等合并；重复start仍幂等且不续期。
- 每次成功extend追加§7.2的session.extend事件，保持dynamicSessionId/motionSessionId/startedAt/segment身份与所有原始时间戳，成功恒changed=true、extended=true。纯网络关联视图如处running同样遵守本动态会话期限规则，续约不启动/延长/重置其P0采集，也不修改网络来源生命周期。
- stop是本scope显式收尾：关闭当前活动sink/定时器，并恢复本scope全部仍有待恢复控制的活动及stopped/retained会话；无活动采集不等于无控制。停止采集后新发的retained control会重新形成待恢复责任，后续stop仍须执行恢复，不能仅按state=stopped跳过。status仅返回缓存。
- reset先停止本scope采集，随后尽力恢复本scope全部未结控制（包含所有retained及帧数据已淘汰但仍有恢复记录的会话），再清成功收尾的数据/索引/pin/游标/token；不删除持久文件、不重置P0。恢复失败/冲突不得先删恢复账本或返回not-needed，按§3.1/§3.3/§5报告。仅无页面控制责任的纯网络视图reset可保持Host内存操作；存在待恢复目标时须按页面操作复验owner与文档，绝不越权抢占或ensure另起页面补恢复。

### 2.2 `browser_motion_observe`

注册 required 固定 `["motionSessionId"]`。根 properties 仅：

```text
motionSessionId*:Id
fresh?:boolean=false
sinceSeq?:integer>=0
cursor?:string (nonempty, UTF-8<=2048)
limit?:integer=50 [1,200]
window?:Window
frameIds?:Ids
includeImages?:boolean=false
region?:PixelRect (仅includeImages=true可给，交付阶段裁剪)
```

cursor/sinceSeq 互斥；frameIds 与 window/cursor/sinceSeq 互斥。fresh=true 禁止 sinceSeq/cursor/window/frameIds，必须为当前活动视觉会话和原页面身份；做一次该会话固定采样规格的真实采样，返回采样 begin/end。不以旧缓存冒充 fresh。includeImages=true 最多选中3帧，未显式限制而选中更多时参数拒绝；不自动只取前三帧藏截断。元数据查询不解码、不生成 T3 product，不落盘。

region为帧自身图像像素空间的PixelRect，与motion_analyze.region同一类型/坐标系；x/y/width/height均integer、x/y≥0、width/height≥1，只允许这四个键。region仅在显式includeImages:true时合法；includeImages缺省或false仍给region→DYNAMIC_INVALID_ARGUMENT。observe不接受masks，遮挡判定继续用analyze.masks。

region必须完全处于每个选中帧的实际dimensions内，不clamp、不缩放、不静默丢弃越界帧。纯参数错误先于fresh采样；存量帧在任何解码/交付前按元数据整批校验边界，任一越界整次DYNAMIC_INVALID_ARGUMENT。fresh:true可同时给region/includeImages:true，仍只按会话原始采样规格取一次真实整帧，待实际dimensions取得后验证边界再裁剪；若现场尺寸导致越界，抛参数错误并保留已发生采样的证据，不重复采样补救。

region是crop-on-delivery，只改变此次交付图片，不改变采集source/scale、存储整帧、帧ID/seq/原始hash/mapping、采样间隔或analyze输入。带region交付裁剪后PNG（mediaType=image/png，宽高严格等于region）；不带region沿原始编码交付（screencast仍为原JPEG base64），交付路径零解码、零重编码，不为统一流程付出额外解码成本。JPEG解码后裁出的RGBA以PNG无损编码，仅指此次RGBA→PNG无损，不能恢复JPEG已丢细节或将源帧precise=false升级为true。

### 2.3 `browser_motion_control`

注册 required 固定 `["motionSessionId","action"]`。根 properties 仅：

```text
motionSessionId*:Id
action*:string enum(pause,resume,seek,rate,restore)
adapterId?:Id
targetIds?:Id[] [1,20], unique
timeMs?:number [0,10000]
rate?:number [0.1,4]
restoreToken?:Id
```

非 restore 必给 adapterId/targetIds，禁止 restoreToken；seek 必给 timeMs且禁rate，rate必给rate且禁timeMs，pause/resume禁timeMs/rate。restore仅接受 motionSessionId/action/restoreToken，restoreToken必给，禁止其他根字段。适配器实际可 seek 范围还须预检，不以公共10000ms放宽目标范围。时间轴浏览仅通过 observe 的 window/frameIds；本工具不新增回放游标 action，也不把seek当已存证据翻页。

整批预检顺序固定：根字段 → action专属字段 → 会话/文档 → adapter能力/恢复能力 → 按targetIds顺序解析全部目标 → 全部范围/唯一性/身份 → 执行。任何纯预检失败 applied=[]/failedIndex=null，无控制派发。执行按 targetIds 顺序，不重排；每个目标写前保存before、写后读回after；失败停止后续目标并尽力恢复已变更项。没有可验证恢复能力的目标默认拒绝控制。

### 2.4 `browser_motion_analyze`

注册 required 固定 `["motionSessionId","assertions"]`。根 properties 仅：

```text
motionSessionId*:Id
window?:Window
frameIds?:Ids
assertions*:MotionAssertion[] [1,20]
```

window/frameIds 恰好一个。整批纯校验先完成，assertion id唯一；只分析已有不可变快照，运算期间pin所需帧/模板，用完释放。

```text
MotionAssertion={id*:string(nonempty,UTF-8<=64),type*:MotionType,
  region?:PixelRect,masks?:Mask[],thresholds?:object,
  expectedIntervalMs?:number>0,query?:TrajectoryQuery,expectation?:FreezeExpectation}
MotionType=frame-diff|region-change|flicker|freeze|jank|trajectory|transition
FreezeExpectation={motionExpected*:true,sourceEventId*:Id,referenceEventIds*:Ids}
TrajectoryQuery={method*:"color",color*:RGB,tolerance?:integer=16[0,255],
                 minArea?:integer=4[1,4000000],maxResults?:integer=20[1,100]}
              |{method*:"template",productId*:T3ProductId,
                 minScore?:number=0.95[0,1],stride?:integer=1[1,16],
                 maxResults?:integer=20[1,100]}
```

RGB为三个整数0–255。template只接受本scope受管不可变 product，禁路径/URL/live/base64。maxResults沿T3上限100；默认20。不新增severity、facts、精确模式、采样率或自由JS参数。expectation仅freeze必给；声明运动的 sourceEventId和至少一个独立推进旁证必须能核验，否则 INCONCLUSIVE，不凭motionExpected=true自证。query仅trajectory必给，expectedIntervalMs仅jank必给；其余type携带这些字段均拒绝。

| type | thresholds 仅允许下列键，括号内默认值 |
| --- | --- |
| frame-diff | pixelThreshold(0.1)、changeRatio(0.01) |
| region-change | pixelThreshold(0.1)、changeRatio(0.01)、minArea(4) |
| flicker | pixelThreshold(0.1)、changeRatio(0.2)、stableRatio(0.01)、brightnessDelta(64)、maxDurationMs(100) |
| freeze | pixelThreshold(0.1)、stableRatio(0.001)、minDurationMs(500) |
| jank | intervalFactor(2) |
| trajectory | maxStep(80) |
| transition | pixelThreshold(0.1)、changeRatio(0.01)、stableRatio(0.001)、stableSamples(3) |

pixelThreshold/changeRatio/stableRatio/minScore为[0,1]，brightnessDelta为[0,255]，DurationMs为[0,10000]，minArea为[1,4000000]整数，maxStep有限>0，intervalFactor为[1,10]，stableSamples为[2,20]整数。不改变权威§3.4的语义：changeRatio达阈值为观察到变化，异常检测正例为FAIL；frame-diff/region-change达到changeRatio为FAIL、否则覆盖足够时PASS；flicker/freeze/jank发现满足定义的异常为FAIL；trajectory唯一且连续跟踪为PASS，歧义为INCONCLUSIVE、观测到超过maxStep且身份确定为FAIL；transition观测到启动且连续stableSamples稳定为PASS，未观测完整边界为INCONCLUSIVE。这些是信号断言，不解释业务好坏。

### 2.5 `browser_dynamic_correlate`

注册 required 固定 `["dynamicSessionId"]`。根 properties 仅：

```text
dynamicSessionId*:Id
motionSessionId?:Id
networkSessionId?:Id
window?:Window
directions?:Direction[] [1,6], unique (缺失为全部六向)
eventIds?:Ids
includeTemporal?:boolean=false
beforeMs?:number=250 [0,5000]
afterMs?:number=1000 [0,5000]
limit?:integer=50 [1,200]
cursor?:string(nonempty,UTF-8<=2048)
```

首次查询必须显式提供 motionSessionId/networkSessionId 至少一个，须属于指定 dynamicSessionId及本scope；即使session已引用P0也不替调用方补来源。window缺失用已收集范围，不伪造采集开始前覆盖。eventIds是候选端点过滤，非因果声明。续页只接受 dynamicSessionId/cursor/limit；cursor绑定首次归一化参数、来源、highWater、段与scope，不允许改window/来源/方向后复用。分页只切pairs，unresolved/计数/完整性来自同一快照；late事件不进入后页。首次与续页都不ensure、不续租、不补抓body。

## 3. 五工具业务返回与统一证据

所有成功是 `{ok:true,...}`，并带既有action envelope和 `evidence.dynamic`；不新增 `{ok:false,error}`。业务工具使用 dynamicSessionId/motionSessionId/networkSessionId，不覆写envelope.sessionId。所有未知观测用null、非适用数组用[]，禁止undefined/Buffer/函数/非有限数。元数据/附件不等于provider可见。

```text
DynamicEvidence={version:1,operation:string,
  provenance:{actionId,scopeId,runtimeId,pageGeneration,documentEpoch,
              algorithmVersion:T4_ALGORITHM_VERSION},
  sessionIds:{dynamicSessionId,motionSessionId,networkSessionId},
  highWater:{operation:null|integer,visual:null|integer,network:null|integer},
  clockAnchors:ClockAnchor[],integrity:object,
  control:null|{requested,applied,failedIndex,fields,restoreStatus},
  redaction:{applied:string[],rules:string[]},
  incomplete:string[],truncated:boolean}
```

`operation`固定采用 `session.start|session.extend|session.stop|session.status|session.reset|motion.observe|motion.control|motion.analyze|dynamic.correlate`。错误放 `details.evidence.dynamic`，早期参数/BUSY错误用null与空记录，不能为补证据启动页面。协议平台原错误保留code/category/retryable，仅加证据。256KiB结果预算截断若影响结论依据必须INCONCLUSIVE，不能先裁反例再PASS。

### 3.1 session

```text
{ok:true,changed:boolean,session:DynamicSession|null,sessions:SessionSummary[],
 limits:T4_LIMITS,integrity:DynamicIntegrity|null,restoreStatus:RestoreStatus}
DynamicSession={dynamicSessionId,motionSessionId:null|Id,networkSessionId:null|Id,
 name,state:"running"|"stopped",startedAt:number,stoppedAt:null|number,
 deadlineMs:number,cumulativeMs:integer,
 config:ResolvedDynamicConfig,highWater:{operation,visual,network},
 counters:{frames,events,bytes,dropped,evicted,ackFailures},retained:boolean}
SessionSummary={dynamicSessionId,motionSessionId,networkSessionId,name,state,
 startedAt,stoppedAt,retained,counters}
```

extend成功形状固定 `{ok:true,changed:true,extended:true,session:DynamicSession,limits:T4_LIMITS,integrity:DynamicIntegrity,restoreStatus:RestoreStatus}`，session.state恒running，返回更新后的deadlineMs/cumulativeMs；extend不执行恢复，restoreStatus如实保持已有pending责任或not-needed，不伪造restored。start/status及其他返回非null session的动作同样输出deadlineMs/cumulativeMs，status不更新两值。deadlineMs为与startedAt同一固定会话墙钟锚点的epoch毫秒投影，deadlineMs=startedAt+cumulativeMs；实际到期判断使用startedAt对应Host单调锚点+cumulativeMs，不随Date.now跳变或重新校准移动期限。cumulativeMs表示初始配置时长+所有成功追加之和，不是已经流逝时间；stopped会话保留最终期限及累计值。

无当前会话且本scope无待恢复控制时status/stop/reset均session=null、changed=false，不抛not-found；存在retained待恢复责任时stop/reset必须执行收尾，不能套用该空分支。只有明确传入未知ID的工具抛not-found。retained=false只保留摘要，不假称帧还可读。duration到界为stopped，记录stop reason与实际区段，不继续后台采集。

stop/reset结果增加 `restores:[{dynamicSessionId,motionSessionId,restoreStatus:RestoreStatus}]`，逐会话保留恢复事实；顶层restoreStatus为这些事实的汇总，attempted/restored列表按实际身份去重，不用同名selector混淆目标。reset另有 `cleared:integer`（实际清除会话数）及 `resetCompleted:boolean`；成功清完才true。没有任何待恢复控制才允许not-needed；全部应恢复字段经回读确认恢复才restored；部分恢复为partial，全部失败为failed，仅身份/外改冲突为conflict，失败与冲突混合且无恢复成功为failed并保留conflicts。

显式reset/stop若恢复失败，完成其余可安全恢复项后抛DYNAMIC_RESTORE_FAILED；若仅冲突则抛DYNAMIC_CONTROL_CONFLICT。details必须含 `restoreStatus,restores,cleared,resetCompleted:false,evidence.dynamic`（stop的cleared为0），不能返回ok:true误导清理完成。保留未解决控制的原身份/before/lastWritten/token与错误摘要供显式重试或诊断，其他已成功收尾数据可清；整个调用因BUSY/ABORTED/CDP_*失败时保持原平台码。dispose不能返工具结果，须在生命周期证据记录相同逐项事实，不能把记录销毁当恢复成功。

### 3.2 observe

```text
{ok:true,frames:FrameMeta[],events:DynamicEventV1[],fromSeq:null|integer,
 toSeq:null|integer,cursor:{next:null|string},integrity:DynamicIntegrity,
 sample:null|{beginMonoMs,endMonoMs,fromMs:null|number,toMs:null|number},
 incomplete:string[]}
FrameMeta={frameId,seq,segmentId,source:"screencast"|"screenshot-loop",
 sourceTimestamp:null|number,receivedMonoMs,encoding:"png"|"jpeg",sha256,
 encodedSha256:string,rgbaSha256:null|string,dimensions:{width,height},bytes:integer,
 decode:{failed:boolean,code:null|string,decoder:null|string,
         decoderProvenance:null|{kind:"host-node-pure-js",version:1}},
 mapping:Mapping,provenance:object,
 sample:{beginMonoMs,endMonoMs}|null,
 imageRef:{frameId,sha256},image:null|ImageDelivery,
 crop:null|CropDelivery,incomplete:string[]}
CropDelivery={region:PixelRect,sourceSha256:string,
 sourceDimensions:{width:integer,height:integer},sourceEncoding:"png"|"jpeg",
 roiSha256:string,outputBytes:integer}
 |{failed:true,code:"decoder-unavailable"|"crop-failed"}
ImageDelivery={image:string,bytes,sha256,width,height,mediaType,
 attachment:null|object,attachmentId:null|string,imageDelivery,
 attachmentError:null|string,file:null|CaptureFile,delivery:object}
```

image默认null；只有includeImages才返回base64与可用附件，保留源帧hash/尺寸和附件真实性字段。不带region时crop=null，交付原始PNG或JPEG，JPEG仍标image/jpeg，零解码/零重编码；带region时image为裁剪PNG且mediaType=image/png、width=region.width、height=region.height。帧元数据dimensions/bytes/sha256/encodedSha256/rgbaSha256及imageRef仍指整帧，不因交付改变；不因交付创建T3 product。内部帧默认仅内存，不自动落盘；若环境配置明确触发P0持久意图，则按P0持久根/0600/原子no-clobber处理，不能绕过环境意图。无out/persist根参数，不提供任意序列导出。未具备可靠时间映射仍返回原帧，sample.fromMs/toMs可null，incomplete列clock-uncertain。

crop成功字段逐帧固定：sourceSha256=整帧encodedSha256=imageRef.sha256，sourceDimensions=整帧实际dimensions，sourceEncoding=整帧原始encoding；roiSha256=sha256(按行排列的裁剪RGBA8字节)，outputBytes=实际交付PNG编码字节数。image.sha256与delivery.original.sha256描述裁剪PNG编码字节，不能用roiSha256或整帧hash替代；附件元数据仍不证明provider最终可见。裁剪源仍由frameId及hash可追溯，不把ROI当新的T4采样帧。原始mapping不重写，ROI原点由crop.region精确说明。

解码不可用/失败：该帧image=null、crop={failed:true,code:"decoder-unavailable"}；解码后裁剪/PNG转换失败：image=null、crop={failed:true,code:"crop-failed"}。这两类是逐帧证据缺失，observe继续返回其余帧，ok:true，该帧incomplete及顶层incomplete/evidence.dynamic.incomplete去重加入crop-unavailable，不抛BrowserError、不补原整页图、不静默跳过帧、不重新采样。源帧原始decode事实/完整性不因交付失败伪改成功；若实际发生源解码失败，coverage.decodeFailures如实计入。

裁剪PNG计入maxEvidenceBytes=262144：outputBytes用于记录PNG字节量，实际交付编码/元数据按既有证据序列化预算核算，不能以base64或附件形式绕过。includeImages最多3帧保持；解码/裁剪/编码活缓冲仍受256MiB工作集和单调用5000ms预算约束。明确资源超限仍按§5抛DYNAMIC_LIMIT_EXCEEDED或DYNAMIC_TIMEOUT，不归为crop-failed藏掉；不得静默交付不完整PNG、自动缩图或变更region。裁剪只减少交付图，不减少帧采集数量或保证降低JPEG整帧解码成本。

### 3.3 control、部分应用和恢复

```text
{ok:true,requested:{action,adapterId,targetIds,timeMs:null|number,rate:null|number},
 applied:Id[],failedIndex:null|integer,fields:ControlField[],
 targets:Id[],before:TargetState[],after:TargetState[],
 restoreToken:null|Id,restoreStatus:RestoreStatus,sideEffects:string[]}
ControlField={index:integer,targetId,field:"playState"|"currentTime"|"playbackRate",
 status:"pending"|"applied"|"failed"|"restored"|"conflict",errorCode:null|string}
TargetState={targetId,documentEpoch,playState:null|string,
 currentTimeMs:null|number,playbackRate:null|number,observedAtMonoMs}
RestoreStatus={status:"not-needed"|"pending"|"restored"|"partial"|"failed"|"conflict",
 attempted:Id[],restored:Id[],failed:[{targetId,code,reason}],
 conflicts:[{targetId,field}],lastObserved:TargetState[]}
```

fields按targetIds索引升序，同target按playState/currentTime/playbackRate固定顺序；applied按实际开始改写的target顺序，写后回读失败的目标仍进入applied。failedIndex是第一个失败目标的零基索引，预检无派发为null；不得把fields排序覆盖真实执行顺序。部分执行失败抛对应BrowserError，以上业务事实放 `details`（requested/applied/failedIndex/fields/before/after/restoreToken/restoreStatus/sideEffects），不会伪返回成功。成功仅表示控制和回读完成，不含业务PASS。

restoreToken绑定scope/dynamic/motion/document/adapter/目标原身份与最后写入值。恢复责任由实际控制写入产生，与采集running/stopped、帧retained/evicted无关；retained会话control与running会话承担相同收尾义务，控制不重启采集。恢复账本不得随帧LRU/会话摘要淘汰或reset盲清；容量不足且不能安全收尾时拒绝新控制，不能遗忘旧副作用。stop/reset/dispose须覆盖所属scope全部未结控制，禁止只扫current/active会话；duration自动到界收尾本会话，显式scope stop按§2.1扫全部。

恢复前比较当前字段与该控制链最后写入值；外部已改则conflict，不覆盖新状态；新同名目标不能替换旧目标。相同原目标/字段被多次或多会话控制，按实际成功写入的反序解开已记录的本scope控制链，最终回到最早未结控制前的原状态；必须能证明新值来自同一Host控制链才解链，不能把另一调用的任意改动一律当可覆盖。恢复原暂停/运行状态与原rate/时间，不一律play；已完成恢复幂等，不再次写回。成功收尾、失败、stop/reset、取消、disconnect、dispose均尽力恢复仍属于本scope的控制字段；已经发生的请求、服务端状态、声音、事件副作用不回滚。断连无法读回时如实记录failed，不把“已尝试”写restored。retained control成功的返回status=pending表示恢复义务存在，不能因此立刻把刚请求的pause/resume撤回。

### 3.4 analyze

```text
{ok:true,results:MotionResult[],summary:{pass,warn,fail,inconclusive,blocked},
 verdict:Status,exitCode:0|1|2,integrity:DynamicIntegrity,
 algorithmVersion:"t4-draft-v1"}
MotionResult={id,type,status:"resolved"|"inconclusive"|"blocked",verdict:Status,
 algorithmVersion,frameIds:Id[],fromMs:null|number,toMs:null|number,
 sampleCount:integer,region:PixelRect|null,masks:Mask[],resolvedThresholds:object,
 encoding:"png"|"jpeg"|"mixed"|null,precise:boolean,
 metrics:object,evidenceIds:Id[],limitations:string[],reasons:string[]}
Status=PASS|WARN|FAIL|INCONCLUSIVE|BLOCKED
```

results保持assertions输入顺序；所有metrics用原始有限数，不先舍入。metrics至少带样本/间隔/分母实际可得项；不得用null推0。统一判定优先级 `FAIL > BLOCKED > INCONCLUSIVE > WARN > PASS`；exitCode=FAIL→1，无FAIL但BLOCKED/INCONCLUSIVE→2，其余→0，不调用process.exit。无有效帧为BLOCKED，样本/时钟/覆盖/身份歧义为INCONCLUSIVE；发生时序异常但归因仅为采集拥塞不得直接FAIL页面。全mask/分母0不返回similarity=1：纯参数即可确定的非法组合拒绝，进入分析后缺有效分母返回INCONCLUSIVE/empty-comparison。

### 3.5 correlate

返回固定 `{ok:true,...CorrelationResult}`，字段与映射详 §7；不得另加顶层complete或把verdict对象改字符串。该工具没有assertions入口，成功query固定 `verdict:{status:"INCONCLUSIVE",reason:"no-assertion"}`；不新增exitCode字段。动态套件对pairs做独立断言，不把query的INCONCLUSIVE解释为引擎失败；机器汇总时未完成必需关系证据仍exit2。

## 4. 帧源、协调器与独立存储

Lead冻结：本轮不改 [帧缓存](../frame-source.js)、[推送](../frame-push.js) 或客户端。T1现有 `Page.startScreencast({format:"jpeg",quality:72,maxWidth:1600,maxHeight:1200})` 参数保持。唯一start/stop/ACK协调器是 [Host](../index.js) 现有 `#onEvent` screencast分支及其运行态生命周期；T4没有第二份start/stop控制器。

1. screencast事件进入时，在 `frames.accept()` / latest-frame覆盖前，给T4 sink不可变原始编码引用与原始metadata。先做有界入队；不能引用面板WS合并后结果、轮询结果或metrics。没有T4会话则不保存动态序列。
2. **ACK仅协调器尝试一次，T4绝不发ACK。** 协调器不等待解码、算法、磁盘、Agent、网络订阅或面板；其成功/失败通知T4 `recordAck(ok)`。接收但入队失败仍ACK并计dropped；ACK失败计ackFailures，不重发掩盖失败。
3. T4 screencast stop仅注销本sink，不能停T1预览；dispose/页面关闭的共同生命周期由协调器停流。T4不得改format/quality/maxWidth/maxHeight、everyNthFrame或预览时序；没有隐式抢占/暂停预览，也没有本轮预览模式切换恢复动作。
4. encoding缺省按source派生，screencast=jpeg、screenshot-loop=png；显式编码不匹配统一 `DYNAMIC_SOURCE_UNAVAILABLE`、details={reason:"encoding-conflict",activeEncoding,supported}，零start/stop/重配置。显式region/scale要求共享流不能满足时同码、reason=`screencast-mode-conflict`，不悄悄接受后缩水；未来显式切换分支本轮不可达。共享JPEG尺寸以实际帧为准，不能用CSS viewport假装其像素尺寸。
5. screenshot-loop每次只调用一次内部P0 PNG采集；保留beginMonoMs/endMonoMs和实际间隔，单次不重试择优。sampleIntervalMs是请求间隔，单flight、前一次未结束不排积压任务；错过tick计采样缺口，不伪造固定FPS。原始sourceTimestamp=null，不把begin/end/接收时刻填作呈现时刻。capture调用区间用于动态轴不确定度，不能假称原始源时间。
6. 两源都遵守4M/8MiB动态单帧上限、P0 PNG CRC/尺寸守卫、固定scale与每帧geometry记录。screenshot-loop负canvas region/非零O走既有白底合成并标capture.canvas.composite；screencast存原始page帧，不把客户端blank/annotation overlay混进页面证据。
7. `DynamicFrameStore`独立于T3 16图LRU、T1单帧缓存及P0网络库；screencast帧由原始编码bytes与真实解码RGBA双份证据组成，分别记录encodedSha256/rgbaSha256、mapping、provenance。元数据sha256等于encodedSha256；引用imageRef指原始编码，算法evidence可追到同frameId下RGBA hash。两份存活内存均计预算：maxBytes限编码存储，保留RGBA与临时算法缓冲合计不得超过maxWorkingSetBytes=256MiB；分配前检查，超限先淘汰最旧未pin帧并同步删其双份数据/索引，全pin仍放不下则拒收并计dropped，不能以默认180帧承诺一定保留180张大图。分析快照pin后callback可继续接收，不阻塞可信输入。Host只传原始CDP编码bytes与metadata，由核心解码并返回证据元数据。
8. DynamicIntegrity固定 `{complete,captured,retained,dropped,evicted,truncated,ackFailures,gaps,issues,coverage}`；coverage固定 `{source,segments,maxAdjacentIntervalMs,missingSourceTimestamps,samplingFailures,decodeFailures,adapters,unknownSourceDrops}`。unknownSourceDrops=null表示协议无法观测，不填0；complete只表示约定记录无已知丢失，绝不表示收齐全部渲染帧。
9. geometry包含viewport、scroll、visualViewport、DPR、viewRevision、canvas offset和输出dimensions。尺寸/scroll/scale/O/zoom/document变化切segment；跨segment分析不自动resize/align，不把旧动态frame变actionable T3 product。

JPEG粗判结果带encoding=jpeg、precise=false、limitations含jpeg-compression-noise；只有真实可核验的JPEG→RGBA解码才允许像素计算，M1必需decodeJpegRgba路径详§6.2。JPEG帧的编码hash不同不证明像素变化。精确颜色/像素等值在仅有JPEG时INCONCLUSIVE/jpeg-non-precise，不静默换PNG。JPEG容差与实际亮度/changeRatio阈值进入resolvedThresholds，不反向挑阈值让靶机变绿。PNG screenshot-loop结果precise=true仅描述编码/算法精度，不保证源时间精确或浏览器零丢帧。

## 5. DYNAMIC_* 分类表与异常边界

[BrowserError](../browser-safety.js) 构造函数从私有TAXONOMY查category/retryable，未登记会落internal。因此**必须由Host实现者登记全部下表名字**，不创建局部DynamicError子类覆写category，也不把未知错误统包INTERNAL。即使分类标记不抛，也登记其固定语义，避免未来错误引用变internal。**登记顺序与码表唯一来源是本节下表，自上而下逐码登记；不能从各模块局部出现的码推导删减版。**

| code | category | retryable | 触发与返回/抛出规则 |
| --- | --- | --- | --- |
| DYNAMIC_INVALID_ARGUMENT | input | false | 未知字段、类型/边界/互斥/格式错误、不可适用字段；observe.region非整数/负坐标/零面积/越界、未显式includeImages:true仍给region、向observe加masks均抛BrowserError。纯预检零页面/控制副作用；fresh实际尺寸取得后才发现ROI越界时保留已发生的单次采样证据，不追加派发 |
| DYNAMIC_SESSION_NOT_FOUND | scope | false | 显式动态/视觉会话未知、淘汰、跨scope，或extend时本scope没有会话；同形抛BrowserError；不用于仍存在但已停止的会话 |
| DYNAMIC_SESSION_NOT_ACTIVE | scope | true | extend遇已有stopped/retained会话或提交时原期限已到；抛BrowserError并附evidence.dynamic，零续期/复活/重装sink。retryable仅表示调用方可另建新会话后重新决策，不表示重试同一次extend可复活；不复用表示start冲突的DYNAMIC_SESSION_ACTIVE |
| DYNAMIC_EVENT_NOT_FOUND | scope | false | 显式帧/事件ID或token所指记录未知/淘汰/跨scope；直接寻址抛BrowserError；断言内部引用缺失保留unresolved/INCONCLUSIVE，不能中断整批 |
| DYNAMIC_SESSION_ACTIVE | concurrency | false | 同scope活动会话name/config冲突；抛BrowserError，原会话不动；同名同配置幂等 |
| DYNAMIC_SOURCE_UNAVAILABLE | capability | false | 显式源/编码/适配器/目标/可恢复能力不支持，或共享流模式不兼容；前置拒绝抛BrowserError，不隐式回退；已采帧解码证据缺失则BLOCKED/INCONCLUSIVE |
| DYNAMIC_CLOCK_UNCERTAIN | evidence | false | **仅分类标记，不抛BrowserError**。缺锚点/偏差超限/源时间回退/区间重叠/负延迟；保留原记录，incomplete=clock-uncertain，时序断言INCONCLUSIVE |
| DYNAMIC_MAPPING_INCOMPATIBLE | evidence | false | **仅分类标记，不抛BrowserError**。不兼容几何段、缺可靠mapping；保留原帧，incomplete=mapping-incompatible，相关断言INCONCLUSIVE/BLOCKED |
| DYNAMIC_LIMIT_EXCEEDED | resource | false | 请求配额超硬限、分配前工作集/候选比较预算无空间；抛BrowserError，details={limit,actual,max}；采集callback拒收改计dropped/issue，不向已结束的start异步抛错 |
| DYNAMIC_TIMEOUT | timeout | true | 单次累计算法CPU墙钟>5000ms；抛BrowserError，不交付半成品图像/假结论；已完成results放details，不自动重算 |
| DYNAMIC_CONTROL_CONFLICT | state | false | 控制前/执行间页面代次、目标原身份、最后写入字段被外部改动；抛BrowserError并附applied/failedIndex/fields/restoreStatus，零覆盖外部新值 |
| DYNAMIC_RESTORE_FAILED | state | false | 显式restore、scope stop/reset或控制收尾恢复失败；抛BrowserError并附逐项restoreStatus/restores、实际cleared/resetCompleted事实；disconnect/abort已有原平台错误时不覆盖原码，恢复失败记restoreStatus |

observe交付裁剪的decoder-unavailable/crop-failed仅为逐帧crop.code，均不新增BrowserError码：返回image=null与crop.failed=true、crop-unavailable完整性标记，详§3.2；格式/解码/裁剪失败不得被包装成工具错误。这里不吞掉独立的输入、scope、采集协议、资源或取消错误；资源仍DYNAMIC_LIMIT_EXCEEDED/DYNAMIC_TIMEOUT，取消/断连等保原码。

“证据不足”是合法结果：缺帧、未知源丢帧、无可靠解码、body unavailable、未采网络、未核验声明、候选歧义、精确性不足、时钟或mapping不可比→INCONCLUSIVE/BLOCKED、incomplete/unresolved，不抛上述evidence类标记。合法query没断言固定no-assertion。已确认异常信号→FAIL，不抛工具错误。

协议/输入/身份/资源前置拒绝→BrowserError带evidence.dynamic。现成P0调用抛 `NET_*` 与平台 `BUSY/ABORTED/CDP_*/RUNTIME_LIMIT` 原码/category/retryable透传；P0 body三态仍captured/empty/unavailable。P0网络引用不存在仍NET_SESSION_NOT_FOUND，不重包DYNAMIC_SESSION_NOT_FOUND。已有PNG结构/CRC/采集协议失败保留 `INVALID_PNG/CAPTURE_*` 原码并加动态证据；仅动态预算用DYNAMIC_LIMIT_EXCEEDED。retryable不授权自动重复控制、采样、写请求或覆盖文件。

### 5.5 同域候选预筛与预算（2026-11-04 Lead 裁决）

同域方向（`visual->visual`、`network->network`）天然 O(n²)：180 retained 帧满量 32220 对，593 帧会话实测 32764 次比较仅 42ms。因此：

- 同域候选**先按时间窗口预筛**（`|Δt| ≤ beforeMs + afterMs`，默认 1250ms，含双方 uncertainty），只有窗口内配对才累加 `candidateComparisons`；跨域方向（`operation->*`、`*->operation`、network↔visual）保持完整枚举，不因同域预筛而减少。
- `suppressedTemporal` 与 temporal pair 走**同一预筛路径**；同一对端点已有更强关系时反向 temporal 不重复计数。
- `maxCandidateCompares` = **40000**（有界上限；300 帧 @17ms 预筛后 38398 不截断，300 帧 @10ms 或跨域 220×220 触顶并如实标 `truncated:true` + `candidate-budget-exhausted`）。
- 结果 `diagnostics` 暴露 `estimatedPairComparisons`（核心实际比较数）、`upperBoundPairComparisons`（预筛前上界）、`directionComparisons`、`sameDomainPrefilter{applied,windowMs,skippedPairComparisons}`、`candidateBudgetExhausted`；Host 侧自算上界单列为 `hostUpperBoundPairComparisons`，`enforcedMaxCandidateCompares` 必须等于核心生效值。

## 6. dynamic-t4.js 模块 API 与职责

模块仅纯JavaScript、Node内置与仓库既有模块，零CDP、零浏览器启动、零页面eval、零文件系统副作用、零npm依赖。Host负责采集、适配器读写、P0网络订阅/快照、可信身份、租约、附件与error envelope；核心只消费已提供的有界不可变数据。纯API不返回Buffer到工具边界。

导出名固定：

```text
T4_VERSION, T4_ALGORITHM_VERSION, DC_ALGORITHM_VERSION, T4_LIMITS,
T4_THRESHOLDS, MOTION_TYPES, DC_DIRECTIONS, DC_BASIS, DC_GRADE_MAP, DC_CONFIDENCE,
DynamicFrameStore, DynamicEventLog,
createClockAnchor, mergeClockAnchors, buildEventTime, isClockUncertain,
intervalsOverlap, compareTimelineEvents, normalizeDynamicEvent,
decodeJpegRgba, analyzeFrameDiff, analyzeRegionChange, analyzeFlicker, analyzeFreeze,
analyzeJank, analyzeTrajectory, analyzeTransition,
validateMotionAssertions, runMotionAssertions,
validateCorrelationInput, correlateDynamic,
encodeCorrelationCursor, decodeCorrelationCursor
```

### 6.1 store/log/clock

```text
new DynamicFrameStore({scopeId,dynamicSessionId,now,limits})
.addFrame(frame) -> {ok:boolean,frameId:null|Id,seq:integer,evicted:Id[],
                    reason:null|"queue-full"|"oversize"|"pixels"}
.pin(frameId), .unpin(frameId), .getFrame(frameId)
.getFrames({frameIds?,sinceSeq?,limit?,window?}), .listFrames(opts)
.recordAck(ok:boolean), .markGap({fromSeq,toSeq,reason})
.setAdapter({id,available}), .highWater (integer getter), .integrity(), .dispose()
frame={sourceTimestamp:null|number,receivedMonoMs,encoding,bytes:Uint8Array,
       sha256?,dimensions:{width,height},mapping,provenance,
       image?:{width,height,rgba:Uint8Array},segmentId?}

new DynamicEventLog({scopeId,dynamicSessionId,now,limits})
.append(event) -> DynamicEventV1
.get(eventId), .bySeq(seq), .sinceSeq(seq,limit)
.query({sinceSeq?,untilSeq?,fromMs?,toMs?,domains?,kinds?,limit?,cursor?})
.timeline(opts), .highWater (integer getter), .integrity(), .dispose()

createClockAnchor({sendMonoMs,receiveMonoMs,pageNowMs,pageOriginMs?,resolutionMs?,
                  calibratedAtMonoMs?,anchorId?}) -> ClockAnchor
mergeClockAnchors(samples:ClockAnchor[]) -> ClockAnchor
buildEventTime({sourceTimestamp,receivedMonoMs,wallMs?,logicalMs?,anchor}) -> EventTs
isClockUncertain(anchorOrMs,{maxUncertaintyMs=10}) -> boolean
intervalsOverlap(a:{timelineMs,uncertaintyMs},b:{timelineMs,uncertaintyMs}) -> boolean
compareTimelineEvents(a,b) -> number
normalizeDynamicEvent(event) -> DynamicEventV1
```

now为Host注入单调毫秒函数，不能在核心用墙钟冒充单调轴。事件seq/receiveSeq会话内单调，eventId随机不透明；DynamicEventV1字段逐字沿权威§2.2，不额外内联body或像素。log达到配置maxEvents淘汰最旧，硬界不是“存到20000才计数”；拒收与淘汰分列、记录gaps，索引同步删除。帧get/pin未知统一DYNAMIC_EVENT_NOT_FOUND，details={idKind:"frame"}，不回显跨scope存在性。

ClockAnchor固定 `{clockId,anchorId,offsetMs,uncertaintyMs,resolutionMs,calibratedAtMonoMs,samples,maxDeviationMs}`。offsetMs把来源相对时间映到会话Host单调轴；单样本中点估计、uncertainty至少半RTT，最多5样本选最小RTT并保留最大偏差。sourceClock必须由Host连同来源类型核验，不能拿pageNow的offset直接加epoch秒；screencast epoch秒先经wall/mono锚点，P0经每target首请求锚点。buildEventTime只投影已核验anchor，不猜单位；缺失sourceTimestamp仍null。初次/新文档/墙钟跳变/采集区段>10s边界重校准，并记录operation。重叠时钟区间不能仅凭展示排序宣称先后。

### 6.2 JPEG 解码、七原语和断言

`decodeJpegRgba(bytes:Uint8Array)` 是核心必需导出。成功返回 `{ok:true,image:{width,height,rgba:Uint8Array},encodedSha256,rgbaSha256,decoder:"t4-jpeg-baseline-v1",decoderProvenance:{kind:"host-node-pure-js",version:1}}`；不支持返回 `{ok:false,code:"DECODER_UNSUPPORTED"}`，损坏/解码失败返回 `{ok:false,code:"DECODER_FAILED"}`。输入预算在分配前检查，资源拒绝仍按§5抛；格式不支持和解码失败不猜像素、不抛格式异常。

首版自研baseline/extended sequential JPEG（SOF0/SOF1），覆盖Chromium实际输出的4:2:0/4:2:2/4:4:4及标准Huffman表；progressive SOF2/arithmetic明确不支持。只借格式知识，不复制第三方decoder、不引入依赖。每帧decode元数据带failed/code/decoder/decoderProvenance；失败增加coverage.decodeFailures，依赖该帧的像素断言INCONCLUSIVE/decoder-unavailable，不由编码hash填像素结论。

U必需断言 `U-JPEG-CHROMIUM-RGB`：内嵌本机Chromium canvas.toDataURL一次性生成32×24三块纯色与一个像素已知值的固定JPEG字节，保留字节sha256、生成环境和预先冻结坐标/expected RGB，容差±2，明确JPEG有损；断言真实输出宽高/RGBA/hash及unsupported拒绝。该fixture不能由待测decoder生成expected。B帧Host仅base64解出原始params.data字节和metadata交核心，不在Host另造像素。

```text
analyzeFrameDiff({frames,region?,masks?,thresholds?}) -> MotionSignalResult
analyzeRegionChange({frames,region?,masks?,thresholds?}) -> MotionSignalResult
analyzeFlicker({frames,region?,masks?,thresholds?}) -> MotionSignalResult
analyzeFreeze({frames,region?,masks?,thresholds?,expectation,advancingEvidence?})
  -> MotionSignalResult
analyzeJank({frames,expectedIntervalMs,intervalFactor?}) -> MotionSignalResult
analyzeTrajectory({frames,query,region?,thresholds?}) -> MotionSignalResult
analyzeTransition({frames,region?,masks?,thresholds?}) -> MotionSignalResult
validateMotionAssertions(assertions:MotionAssertion[]) -> MotionAssertion[]
runMotionAssertions({frames,assertions,window?,frameIds?,events?,clockAnchor?,integrity?})
  -> {ok,results,summary,verdict,exitCode,integrity,algorithmVersion}
```

trajectory的maxStep仅从thresholds.maxStep解析（默认80），不存在顶层maxStep入口；runMotionAssertions不另拷出第二份阈值。MotionSignalResult为§3.4 MotionResult去掉id，frames输入至少含 `{frameId,timelineMs:null|number,sourceTimestamp:null|number,receivedMonoMs,image?:{width,height,rgba},mapping,encoding,segmentId}`。image对六个像素原语必需，对jank不要求且不得触发解码。raw sourceTimestamp始终秒，timelineMs为映射后的毫秒。核心内部运行上下文可接收signal/累计budget，不新增公共工具参数。每最多65536像素/比较检查取消并让出；累计5s跨全部assertions，不能每个assertion重置。七原语保留frameIds、采样区间、ROI/mask、实际阈值、样本数/限制，不读fixture anomalies/oracle。

- frame-diff复用T3白底YIQ、AA排除、mask并集、C=N-M；region-change复用8邻接区域/minArea，最多100个，区域裁剪不改总分母。
- flicker至少三帧A→B→A、双侧变化≥0.2、两侧差≤0.01、亮度≥64/255、中间持续≤100ms；没采到中间帧无阴性证明。
- freeze至少3个实际像素、持续≥500ms且diffRatio≤0.001，必须另有仍推进旁证，主动pause/静态不算冻结。
- jank记录p50/p95/max与ACK/采样缺口；目标周期只能显式给，>factor计疑似；Host拥塞不能直接证明页面卡顿。
- trajectory只用显式颜色/模板，候选和分数逐帧保留，遮挡/多候选不换对象；mapping不兼容降级。
- transition从首次越changeRatio到连续3样本≤stableRatio，起止都是区间而非精确业务时刻；缺任一边界降级。

T3复用点固定为 [vision-t3.js](../vision-t3.js) 的 `decodePngToRgba/decodePngToRgbaAsync`（统一RGBA8）、`diffImages/diffImagesAsync`、`findInImage/findInImageAsync`（颜色/模板）、`mappingCompatible`、`validateMasks`、`validatePixelRect`、`validateQuery`。使用返回metrics/regions，丢弃不需要的highlight，不复制YIQ/PNG/连通域第三方实现。T4资源上下文限制在4M、8MiB、256MiB、5s，不能借T3更大上限绕过。T3抛空分母在合法分析路径转INCONCLUSIVE/empty-comparison；原协议/取消错误保持原码。template product由Host解析pin为不可变image后传核心，核心不接路径。

### 6.3 DC API

```text
validateCorrelationInput(input) -> normalizedInput
correlateDynamic({dynamicSessionId,scopeId,window?,directions?,eventIds?,
  sources:{operation:null|SourceSnapshot,visual:null|SourceSnapshot,
           network:null|SourceSnapshot},
  includeTemporal=false,beforeMs=250,afterMs=1000,limit=50,cursor?})
  -> CorrelationResult
SourceSnapshot={events:DynamicEventV1[],integrity:object,highWater:integer}
encodeCorrelationCursor(snapshotDescriptor) -> string
decodeCorrelationCursor(cursor) -> snapshotDescriptor
```

Host在一次内存读事务锁定各来源highWater，P0经本DC独立订阅读取/ack，不能替别人ack或阻塞采集；源未采集传null。核心不回写源数据，不修改P0时间/seq。游标必须绑定scope/session/query/hash/highWater/offset；公开opaque，不能接受任意历史上界伪造。失效快照不转新查询，返回同形NOT_FOUND或完整性不足，绝不混入新事件。

## 7. DC 逐字段映射与因果约束

### 7.1 CorrelationResult 与因果约束

```text
CorrelationResult={version:1,algorithmVersion:"dc-draft-v1",dynamicSessionId,
 window:{fromMs,toMs,beforeMs,afterMs},highWater:{operation,visual,network},
 pairs:[{id,direction,fromEventId,toEventId,basis,grade,confidence,reasons:[],
         joinKeys:[],evidenceIds:[],provenance:[],limitations:[],
         timeDeltaMs:null|number,uncertaintyMs:null|number,
         candidateIds:[],ambiguous:false}],
 unresolved:[{eventId,reason,candidateIds:[],declaredLink:null|object,evidenceIds:[]}],
 suppressedTemporal:integer,integrity:{operation,visual,network,complete},
 incomplete:[],truncated:false,cursor:{next:null|string},
 verdict:{status:"INCONCLUSIVE",reason:"no-assertion"}}
```

| 输出字段 | 唯一实现来源/含义 |
| --- | --- |
| version / algorithmVersion | T4_VERSION / DC_ALGORITHM_VERSION；不沿用NET_PROTOCOL_VERSION充DC版本 |
| dynamicSessionId | scope已验的关联视图ID，不是agent sessionId |
| window.fromMs/toMs | 归一化窗口或实际快照覆盖范围；无可靠时间为null并标incomplete；beforeMs/afterMs为实际候选窗口 |
| highWater.operation/visual/network | 三来源冻结seq上界，未收集为null；network保留P0原seq |
| pairs.id | 本快照内确定性关系ID，同游标复现不变化，不充当事件ID |
| direction | 从/到domain映射§1六枚举，不能输出visual->operation等第七方向 |
| fromEventId/toEventId | DynamicEventV1不可变端点ID，不能以requestId/frameId/actionId代替 |
| basis | explicit来自核验声明/链接；redirect/initiator来自协议父端点；observed为共组/传播；temporal仅时间邻近 |
| grade | DC_GRADE_MAP固定：explicit/redirect/initiator→confirmed-causal；observed→observed-association；temporal→temporal-proximity |
| confidence | direct=协议或核验显式端点；supported=有可追溯独立旁证的observed；weak=纯时间邻近/有限旁证；unknown=声明或端点不足。不是概率，不升级grade |
| reasons | 固定短原因码数组，说明依据及核验范围，不写自由页面文本 |
| joinKeys | `[{kind,valueHash,namespace,sourceEventIds}]`；kind=action-op/op-request/request-hop/trace/object/transition-parent；只存已验证映射或同命名空间hash，不用脱敏***、URL/文本/坐标当身份 |
| evidenceIds | 能由Host证据索引回溯的真实ID，指向帧hash、tool action、P0原seq/hop、adapter声明；未验证引用进unresolved，禁止生成假证据ID |
| provenance | 端点与桥接的 `{producer,sourceKind,adapterId,adapterVersion,trust,evidenceIds,rawHash}`；不把page/caller-declared改host-observed |
| limitations | caller-declared/page-declared/clock-uncertain/mapping-incompatible等适用限制；explicit只证其provenance范围 |
| timeDeltaMs / uncertaintyMs | 映射后to-from及双方误差界；缺锚点/来源量化不明为null，不用receive时间伪填 |
| candidateIds / ambiguous | 所有同级候选端点ID与是否非唯一；无唯一键不能挑最近的 |
| unresolved | 无端点/缺帧/未知ID/不可靠时钟/未核验声明的eventId、reason和候选；declaredLink保留封闭声明及producer，不藏成confirmed边 |
| suppressedTemporal | includeTemporal=false时从同一完整快照过滤掉的temporal pair数；不混入causality |
| integrity | 各源原integrity或null；complete只在所需已采集来源完整且查询无截断时true；未采网络不配空complete=true |
| incomplete / truncated | 传播源缺口、missing-body/endpoint、预算/区域证据截断，不能丢反例后PASS |
| cursor.next | 同highWater不可变快照下一页token，尾页null；迟到数据不改变已页结果 |
| verdict | query固定INCONCLUSIVE/no-assertion，独立业务断言由验收调用方执行 |

**无共同ID或协议明确父子端点不得判因果；共同trace/hash本身也不充分。includeTemporal默认false。** P0 action mark/步骤窗口/截图nearest仅temporal；不同HMAC会话hash不得join。RequestKey固定 `{networkSessionId,targetId,cdpSessionId,requestId,hopId}`，应用t4-req-*须通过头/账本映到它；P0 frameId只投影为documentFrameId，ids.frameId是T4视觉帧。

action→op需可信派发目标/接收记录/唯一匹配；op→request需头、ops.requestIds、P0与ledger交叉核验；network→UI消费声明需ui.cause与实际transition，像素只为observed结果。视觉→网络必须逐边经状态→真实操作→请求；当前fixture缺完整父桥只observed/unresolved。视觉→视觉共同clock/causeOpId只observed；没有parent字段不得虚构显式因果。不默认传递闭包，混合链不强于最弱边，循环不推根因。

### 7.2 会话续约与到期事件信封

每次成功extend必须写入不可变DynamicEventV1，沿用本scope/dynamicSessionId、operation序号及可信actionId；以下字段固定：

```text
{domain:"operation",kind:"session.extend",phase:"end",
 payload:{extendMs:integer,previousDeadlineMs:number,newDeadlineMs:number,
          cumulativeMs:integer}}
```

extendMs等于本次根durationMs，previousDeadlineMs为提交前期限，newDeadlineMs为成功追加后期限，cumulativeMs为成功后的累计总时长。previousDeadlineMs/newDeadlineMs与§3.1的固定会话墙钟锚点投影一致，cumulativeMs为毫秒时长而非epoch时刻；事件ts.timelineMs/receivedMonoMs仍来自真实Host单调接收/提交时刻，provenance.trust="host-observed"，不把新期限写成事件发生时刻，不重写旧事件。

首次start冻结会话起点，extend只重挂原会话内部到期定时器，不新建帧源、段、页面动作、校准或P0会话。成功期限变更与成功事件记账属于同次Host内存状态提交；失败不记录成功session.extend。相同追加参数的两次调用产生两个不同eventId/seq且分别累计；事件仍受原事件存储预算/淘汰完整性规则约束，不能为续约无限保留日志。

最终自然到期仍是原有stop事件，reason="duration"，payload保留最终cumulativeMs；不因经过extend改成别的停止原因。已冻结DC查询highWater不因后续extend改变，续约事件只进入之后的新查询快照；时间上邻近其他事件不因续约获得confirmed-causal等级。

## 8. 能力报告及 30→33→34→35 过渡

能力报告是纯诊断：不ensure、不创建目录、product、session、校准或截图。工具真实注册之前对应capability不得available；统计注册表而非manifest期望值。M1/M2/M3每个已注册工具必须是可调用实现，不用stub撑计数。

| 里程碑 | 真实工具数 | 本阶段新增与能力 |
| --- | --- | --- |
| M0 | 30 | 旧30；T4 unsupported，observed=null |
| M1 | 33 | dynamic_session、motion_observe、motion_control；三项available，analyze/correlate仍unsupported |
| M2 | 34 | motion_analyze真实注册，七原语按已实现路径报告 |
| M3/M4 | 35 | dynamic_correlate注册，M4独立验收不再新增工具 |

逐工具项固定 `web.t4.dynamic-session`、`web.t4.motion-observe`、`web.t4.motion-control`、`web.t4.motion-analyze`、`web.t4.correlate`，tool指向对应browser_*原名。聚合 `web.t4.dynamic-behavior` M1起available，constraints列实际已注册集合和未实现子项，不假称全T4验收通过。保留 `web.t4.dynamic-vision`，`aliasOf:"web.t4.dynamic-behavior"`，status随聚合，constraints含“alias不代表独立工具”；别名不增加工具数。

BUSY按动作分类：session视觉变更/control/fresh页面动作unavailable(BUSY)；extend/status/observe存量/analyze/correlate/纯网络视图仍available。extend仅为本scope动态期限内存操作，不因另一session持有页面owner租约降BUSY；该声明不放宽后续页面动作的owner检查。聚合声明动作差异，不把未启动running=false写unsupported。帧源不支持与owner冲突分开，能力查询不为探测而调用CDP。

```text
dynamic={version:1,
 tools:[实际注册的完整工具名],
 visual:{sources:["screencast","screenshot-loop"],
   screencast:{available:true,encoding:"jpeg",precisePixelAnalysis:false},
   screenshotLoop:{available:true,encoding:"png",sampleIntervalMs:[50,1000]},
   precisePixelAnalysis:"screenshot-loop-only",
   adapters:[{id,version,available,actions,restorable,reason:null|string}],
   algorithms:[实际已实现的MotionType],
   observationDelivery:{region:true,regionSpace:"image-px",
     cropOnDelivery:true,cropFormat:"png",requiresIncludeImages:true,
     fullFrameDeliveryDecode:false,maxImages:3,masks:false},
   limitations:[实际限制]},
 networkReuse:{tools:[P0七工具完整名],startsNetwork:false,
               resetsNetwork:false,subTargets:"partial"},
 correlation:{algorithmVersion:"dc-draft-v1",directions:DC_DIRECTIONS,
              basis:DC_BASIS,gradeMap:DC_GRADE_MAP,
              confidence:DC_CONFIDENCE,includeTemporalDefault:false},
 limits:T4_LIMITS,
 observed:null|{observedAt,operation,dynamicSessionId,motionSessionId,
   source:null|string,encoding:null|string,frames:integer,
   highWater:{operation,visual,network},verdict:null|Status,
   integrity:object,restoreStatus:null|RestoreStatus}}
```

encoding未给时按source派生，screencast=jpeg、screenshot-loop=png，不要求调用方重复指定唯一合法编码；显式不匹配的encoding-conflict沿§2.1。各段available/algorithms只反映当前里程碑实际实现；未注册阶段sources/adapters不能被静态模板冒充实测。dynamic.observed初始null，仅来自本Runtime真实新工具调用，带时间不保证当前页状态；不含像素、原URL、页面自由文本、token或绝对证据根。`limits.dynamic`与dynamic.limits相同。旧工具30的schema/required/错误不改。

## 9. 40 条验收的负责模块与断言归属

本契约写成时以下均**未运行**。B=真实插件注册工具+真实无头Chromium；U=纯核心/存储/schema单测。所有明确要求running的B/真实宿主检查（DV07–DV08采集/fresh、DV10–DV13运行采样、DV15运行控制以及DC01–DC06/DC08/DC10–DC11中需活会话取证的子项）可显式start config.durationMs=60000，并在截止前用extend追加[1,60000]毫秒、累计≤300000达成；实际动作/采样时仍核对running、deadlineMs/cumulativeMs及Host单调截止。stopped/retained验证单列，不能充当running通过；非运行取证子项不被强制改成running。延迟跨过截止则如实记录并用新有界会话复验，extend不能补回过期区间，不隐式续期。B脚本目标 [动态验收套件](../tests/acceptance/) 中 `t4-dynamic.mjs`（由测试执行者创建）；U脚本目标 `tests/dynamic-t4.test.mjs`（由核心执行者创建）。B不可由U替代；fixture oracle只做独立expected，不进算法输入自证。

| 编号 | 负责模块 | 本仓库必须断言的归属 | 必须保留的NOT_RUN子项/边界 |
| --- | --- | --- | --- |
| DV01 | Host capabilities + fixture | B：四卡/version/媒体来源/无外网；按当前里程碑真实注册数与capabilities一致 | 真实宿主加载另记，不能由fixture准备通过替代 |
| DV02 | Host控制adapter + fixture | B：真实WAAPI对象/transform/opacity变化 | SVG/独立JS适配器无冻结专项靶机，NOT_RUN |
| DV03 | 视觉sink + frame-diff | B：24粒子、同t/异t实际RGBA与draws分列，300/900正负例 | 跨运行固定checksum不在承诺 |
| DV04 | source + fixture GPU | B：WebGL context/renderer同运行checksum；披露WebGPU available/reason | WebGPU真实渲染无专项证据NOT_RUN；跨进程/跨GPU固定hash禁止当PASS |
| DV05 | media adapter + PNG采样 | B：readyState、时长3s±.15、三检查点主色/真实frameCount | fallback=canvas-capture-stream时文件seek子项NOT_RUN |
| DV06 | 控制adapter | B：pause/seek/resume回读，300→900→300、漂移/暂停无重绘 | 无实际受支持adapter目标时对应动作NOT_RUN，不用fixture函数冒充工具 |
| DV07 | Host事件分支 + FrameStore + observe交付 | B：独立sink，sourceTimestamp/null、编码hash/mapping/原图附件；B-DV07-OBSERVE-ROI验证PixelRect裁动画本体、交付PNG宽高等于region、整帧imageRef不变/三类hash可追、源JPEG仍非精确；B-DV07-FRESH-ROI验证fresh真实整帧单采后裁、sample区间保留；U-DV07-ROI-INVALID验证整数/负值/零面积/越界及includeImages依赖、observe拒绝masks，不能clamp或静默丢帧；排除latest-frame/metrics | provider是否看见裁剪图另列NOT_RUN；ROI内容无文字须独立核验，不能由裁剪成功推定 |
| DV08 | 唯一ACK协调器 + FrameStore + observe交付预算 | U：pin/淘汰/预算/gaps；B：每帧ACK一次、慢消费者压力、ackFailures、有限内存；U-DV08-ROI-BUDGET验证PNG/base64/元数据计maxEvidenceBytes、最多3帧及工作集/CPU预算；U-DV08-ROI-FAILURE验证decoder-unavailable/crop-failed逐帧image=null/crop.failed与crop-unavailable、不抛解码裁剪错误且其余帧保留；B-DV08-NO-ROI-REGRESSION验证原JPEG bytes/base64/hash/mediaType不变且交付零解码，region不改变采集数量/ACK/抽帧成本 | 未实测Chromium内部未知丢帧不填0；Lead提供的14.7倍缩图实测不是跨页面性能承诺 |
| DV09 | 七原语/T3复用 | U-DV09-PREFLIGHT-ALL-MASK：显式region已给且mask并集完全覆盖它，纯预检可算C=0→DYNAMIC_INVALID_ARGUMENT零派发；U-DV09-EMPTY-DENOMINATOR：未给region、待读实际图尺寸后才发现全mask/C=0→INCONCLUSIVE/empty-comparison且similarity非1；其余U断言YIQ/并集/区域；B-DV09-PNG：PNG loop正常负例/尺寸不偷偷resize | JPEG精确像素子项不适用，不得替代PNG |
| DV10 | analyzeFlicker + screencast sink | B：经必需JPEG解码粗判flash三样本、独立[640,656)oracle与normal负例；输出encoding/precise/限制 | 未覆盖16ms闪白→INCONCLUSIVE，不写“无闪烁”；不得提前将decoder列NOT_RUN |
| DV11 | analyzeFreeze + adapter旁证 | B：经必需JPEG解码检≥800ms冻结/≥500ms三像素样本、CSS/clock推进；主动pause负例 | 实际解码失败或旁证无法核验→INCONCLUSIVE；不得提前豁免像素项 |
| DV12 | analyzeJank + clock/ACK | U-DV12-INTERVALS-WITHOUT-PIXELS：移除image仍能计算采样间隔；B：显式周期、真实间隔分布与jankFrames独立旁证；分离采样缺口。jank仅依赖可核验采样时间，不依赖JPEG像素解码 | Host拥塞不等于页面卡顿，归因不足INCONCLUSIVE |
| DV13 | media adapter + analyzeFreeze | B：经必需JPEG解码检≈1.2s停滞、400ms后漂移<80ms、其他区域仍变 | 实际解码/媒体帧证据不足→INCONCLUSIVE，buffer/decoder/control原因分列，不提前NOT_RUN |
| DV14 | trajectory/transition/mapping | U：候选/歧义/maxStep/分段；B：PNG loop真实颜色/模板轨迹与双ROI过渡区间 | 无完整过渡起止或mapping即INCONCLUSIVE，不补帧 |
| DV15 | control/restore + Host lifecycle | U：token/身份/外改冲突/字段顺序、多会话控制链反序收尾；B：pause/seek/rate恢复原状态、部分失败、取消/断连；新增B-DV15-RETAINED-RESET/B-DV15-RETAINED-STOP/B-DV15-RETAINED-DISPOSE，验证retained pause后scope收尾恢复running；U-DV15-RESET-PARTIAL验证失败不报not-needed、保留未结账本；B-DV15-EXTEND-RUNNING验证成功追加/无sink重装/无空档、status期限与审计事件；U-DV15-EXTEND-CAP验证累计恰300000合法、超限拒绝及details；B-DV15-EXTEND-INACTIVE验证stopped/retained抛DYNAMIC_SESSION_NOT_ACTIVE不复活；U-DV15-EXTEND-INDEPENDENT验证相同extend执行两次、同配置start不续期；U-DV15-EXTEND-SCHEMA验证durationMs整数边界/根字段封闭；U-DV15-EXTEND-DEADLINE-RACE验证原期限已到但回调未执行仍拒绝；B-DV15-EXTEND-MEMORY验证不ensure/CDP/续owner、帧与字节预算不变 | 无法读回的恢复不记restored；真实宿主生命周期另测 |
| DV16 | clock + mapping + Host | U-DV16-SCREENCAST-MISSING-SOURCE-TIMESTAMP：screencast sourceTimestamp=null原样保留，sourceClock不被receivedMonoMs覆盖，DYNAMIC_CLOCK_UNCERTAIN仅标记/incomplete=clock-uncertain，精确时序结论INCONCLUSIVE不抛；其余U断言锚点/回退/量化/重叠；B：scale/scroll/O/geometry分段与实际误差 | 跨进程时钟精度无实测不能PASS |
| DN01 | P0 session/events + network projection | B：导航前start、初cart GET/WS握手帧/页面账本 | 采集晚启动不证明零请求 |
| DN02 | Host动作桥 + DC | B：可信action/op、POST后GET、RequestKey↔应用号与ledger | 只有trace则observed，不放宽explicit |
| DN03 | P0 WS + UI consumer | B：远程加购基线、增量/revision/ui.cause | 不假定绝对count=1 |
| DN04 | P0 patterns + ledger | B：dup双POST/同key/deduped/server仅+1/UI一次 | 重复请求不自动证明重复副作用 |
| DN05 | P0 SSE/poll + DC候选 | B：orders POST/SSE≥2/poll≥3/真实consumer/最终状态 | 长期SSE稳定性不由短fixture证明 |
| DN06 | P0 WS + visual/adapter | B：方向/content/ui cause=ws与实际画面独立核对 | 收到消息不等于可见变化 |
| DN07 | P0 response/body + DC | B：500/CART_REJECTED/body/errors/banner/cause逐证 | body unavailable保三态，字符串不硬填数值businessCode |
| DN08 | P0 patterns + trusted retry + DC | B：500→真实retry→同key成功/retried/错误消失 | fixture无retryFrom父桥，显式重试因果子项NOT_RUN，仅observed/unresolved |
| DN09 | P0 timing + UI | B：800ms真值、duration≥700ms容差、最终UI | 无业务阈值不得自动判慢请求FAIL |
| DN10 | P0 trace/body/redaction + DC | B：begin/end/query/同trace≥3/正文三态；U：temporal默认过滤、证据无敏感原值 | P0 mark窗口不升级因果 |
| DN11 | Host runGeneration + fixture lifecycle | B：reset前后ledger/revision、SSE/WS关闭、旧ID不串链 | 不改变P0 reset语义 |
| DN12 | P0/chain回归 + 旧30工具 | B：独立复跑P0 C1–C52/chain报告，旧30/schema/错误；U：命名空间/三态 | HTTPS无TLS靶机、OOPIF未单独实证、shared/service worker拒采、modify-response未实测支持、真实宿主和长连接稳定性逐项NOT_RUN |
| DC01 | Host动作桥 + correlateDynamic | U：声明不升级/弱证据负例；B：pause action↔op↔cause及状态帧 | page-declared不能称Host独立证明 |
| DC02 | RequestKey投影 + correlateDynamic | U：应用/CDP ID分离；B：action/op/头/requestIds/ledger逐桥 | 仅mark邻近不explicit |
| DC03 | network→UI桥 + visual证据 | U：分边等级；B：500→ui cause→banner真实结果 | 只重叠帧为temporal |
| DC04 | visual→operation→request链 | U：缺父桥unresolved；B：错误帧/retry操作/新请求同key | 当前缺状态父桥，confirmed-causal子项NOT_RUN，observed可验 |
| DC05 | P0 redirect/initiator + DC | U：协议父端点/同trace降级；B：redirect正例、可用initiator和retry负例 | CDP无initiator.requestId时该正例NOT_RUN，不能用script栈自证 |
| DC06 | visual parent/clock规则 | U：共同clock/op仅observed；B：真实双区域同步 | 当前无visual parent字段，显式visual→visual因果子项NOT_RUN |
| DC07 | DC枚举/等级过滤 | U：basis/grade全表、confidence不能升级、默认temporal不返回 | 无环境豁免 |
| DC08 | DC候选/歧义 | U：并发/模糊ID保全部候选；B：SSE/poll实际竞争consumer | 不挑最近当唯一根因 |
| DC09 | DC隔离/身份 | U：scope/target/hop/document/run/HMAC负例；B：导航/reset实际边界 | 不跨scope聚合；跨进程GPU hash不作身份 |
| DC10 | DC完整性/证据索引 | U：缺端点/帧/body/时钟/截断传播、证据可追；B：实际body unavailable/丢帧路径 | 不存在的evidence进入unverifiable，不造链接 |
| DC11 | Host快照 + cursor + join预算 | U：highWater稳定/候选预算/来源null；B：查询无启动/续租、晚到不污染、P0独立订阅 | 源未采不算“零请求” |
| DC12 | 注册/capabilities/harness/错误 | U：schema/required/错误码与JSON；B：M1=33/M2=34/M3=35可调用、旧30回归、未注册名不available | 3080加载/Agent工具发现/provider图像可见性无真实会话证据一律NOT_RUN |

Skill引用的方法论红线：**「不要用整页截图理解动画（页面可能自述答案）；算力靠抽帧不靠 region；采样没覆盖 ≠ 没有异常」**。先用结构化几何/定位获得动画本体的帧像素ROI，再对明确抽取的少量帧用observe region交付；避开标题、数值状态行和fixture oracle。region不改变帧率/采样覆盖，也不保证降低解码成本；同帧裁图可减少图像交付体积，不能据此声称时序分析已通过或未采区间没有异常。Lead给出的61824B整页JPEG→4198B、243×139 PNG仅为本次使用反馈，不是本文作者复测结果或固定压缩比阈值。

报告沿 [网络验收惯例](../tests/acceptance/network-p0.mjs)：`schemaVersion/suite/contract/generatedAt/command/environment/probes/criteria/findings/notRun/evidenceFiles/screenshots/resources/summary`，40个criteria唯一编号，B与U合并到对应criterion不双计。每check列 `{id,criteria,kind,required,expected,actual,status,reason,evidenceIds}`，并记录构建指纹、Node/Chromium/平台、参数/阈值、源编码、sampling区间、hash与notRun子项。PNG/报告写 `tests/acceptance/runs/<ISO>-<pid>/`，不向仓库output写证据。单驱动 `flock /tmp/dsh-t4-browser.lock`；进程0=所有已要求可运行项通过、1=必需断言失败、2=套件不可运行或必需证据不足。允许的范围外/平台不支持子项NOT_RUN单列，不计PASS；不能将分析INCONCLUSIVE/BLOCKED改PASS来获得exit0。真实宿主/provider列单独证据域，进程内通过不能代填。

## 10. Lead 裁决、待裁决与参考来源

已收到并冻结的Lead裁决：

1. 权威DV01/DC12的unsupported/30是准备阶段快照。本轮按实际M1=33、M2=34、M3/M4=35断言；旧fixture套件30计数由Lead改，本文作者不改测试。
2. clock/mapping是分析/观测分类标记，不抛；缺证据保原始记录并INCONCLUSIVE/BLOCKED，必需证据不足进入exit2。参数/身份/资源/协议前置拒绝才抛BrowserError。
3. 保留旧web.t4.dynamic-vision为动态聚合别名，M1起随真实进度，alias不是工具；limits.dynamic与observed真实性按§8。
4. 预览JPEG参数一律不改；现有Host事件分支唯一ACK，T4只收原始引用和ACK结果，绝不ACK。PNG精确路径仅screenshot-loop，不做模式切换。JPEG粗判必须公开precision/limitations。
5. includeImages沿P0附件/落盘安全规则，内部采集和普通图片交付不因有帧就自动写文件；显式环境持久规则保持。

6. M1新增核心自研 `decodeJpegRgba`（SOF0/SOF1顺序JPEG、三种采样、零依赖），Host只传CDP原始编码与metadata；每帧编码/RGBA双份证据可追，双hash分列；unsupported/失败不猜像素。DV10/11/13像素项必须实现并运行，不提前预设NOT_RUN；仅实际被证明decoder不可行时单独报Lead再裁。
7. encoding按source派生缺省（screencast=jpeg、screenshot-loop=png），显式不匹配为encoding-conflict、零start/stop；trajectory仅thresholds.maxStep。DV09/DV12/DV16的具体断言ID见§9。

### 10.1 第三轮真实宿主反馈后的契约收口

本节为顾问依据Lead提供的实测事实作出的契约裁决，不声称本文作者执行了真实宿主验证；权威文本由Lead同步后生效。

- 初始采集时长及单次追加硬限60000ms，初始默认3000ms保持；**原“不新增extend/keepalive”裁决已由用户批准的§10.2显式extend覆盖**。fresh或幂等start仍不续期。§1/§2.1/§8 limits与§9 running类前置按新规则；算法、帧/字节预算及10000ms时钟重校准边界独立保持。
- retained控制必须由scope stop/reset/dispose收尾，范围是本scope全部未结控制，非仅当前活动会话。reset先尽力恢复后清理，失败/冲突按§3.1/§3.3/§5逐项报告并保留未结恢复记录；not-needed仅在确无恢复义务时使用。§9 DV15新增retained与部分恢复断言。

### 10.2 用户批准会话续约后的Lead冻结语义

用户批准在现有browser_dynamic_session增加extend action，不新增工具。根参数仅action/durationMs，durationMs为本次追加整数[1,60000]；累计sessionCapMs=300000。只允许running且未到期，已有stopped/retained抛新增DYNAMIC_SESSION_NOT_ACTIVE(scope,true)，不存在仍DYNAMIC_SESSION_NOT_FOUND。纯Host内存更新期限/内部定时器，不能ensure、发CDP、续owner租约、复活会话或重装sink。每次成功均changed=true/extended=true，记录§7.2审计事件；重复extend独立追加，重复start仍幂等不续期。成功及status返回deadlineMs/cumulativeMs，最终duration停止带最终累计量。其余预算/阈值/校准周期原样保持。

与既有会话/页面租约模型无硬冲突：动态会话到期续约和页面owner续租分开，后台采样仍执行原owner/文档检查。旧版本权威文件的action枚举/时长文字须由Lead同步本次已授权加法变更；本文不反向改其余权威口径。实施条款为§1/§2.1/§3.1/§5/§7.2/§8/§9。

### 10.3 用户批准 observe region 交付裁剪

observe新增region:PixelRect，仅显式includeImages:true合法，fresh同样适用；带region交付裁剪PNG，不带保持原始JPEG/PNG零交付解码。整帧imageRef与原元数据不变，crop显式区分sourceSha256、sourceDimensions、sourceEncoding、roiSha256及outputBytes；roiSha256为裁后RGBA，不是整帧编码或交付PNG编码hash。逐帧解码/裁剪失败以crop.failed/code和crop-unavailable返回，不加BrowserError码；输入/资源/取消边界仍按§5。maxEvidenceBytes与最多3帧保持，不加observe masks。实施条款为§2.2/§3.2/§5/§8/§9，Skill方法论红线见§9。

与原observe/fresh/budget无硬冲突：crop发生于同次采样完成后的交付阶段，存量查询仍不ensure，fresh仍单采且保留区间，预算原样执行。裁剪PNG的无损仅相对于解码RGBA，不提升JPEG源精确度；资源预算超限与逐帧解码/裁剪失败分开，前者保既有资源BrowserError。权威schema/能力/Skill的同步由Lead持有。

### 待 Lead 裁决

当前无阻塞实现的新待决项。此前JPEG入口已由上项及§6.2解除；以下两处保留权威边界记录，由Lead同步权威文件，执行者不得自行扩schema：

- **精确请求字段**：权威§7 MotionAssertion未提供precise/encoding条件参数；本轮不加公共字段。JPEG固定precise=false，PNG路径及能力声明表达精确度边界。若未来新增公共precise请求，先修权威字段表再实现。
- **全mask表述**：显式region被mask并集完全覆盖、纯预检已可算C=0→DYNAMIC_INVALID_ARGUMENT（U-DV09-PREFLIGHT-ALL-MASK）；未给region、仅读实际图尺寸才知C=0→INCONCLUSIVE/empty-comparison（U-DV09-EMPTY-DENOMINATOR）。均不得similarity=1，不要求T3原VISION_EMPTY_COMPARISON从T4透出。

只读参考已核对，**只借模型，不复制代码、不引入依赖**：

- [Playwright screencast](../reference/web-t4/playwright/packages/playwright-core/src/server/screencast.ts)：多消费者生命周期/背压与ACK协作；本仓库采用更严格的协调器立即一次ACK，不复制其等待消费者逻辑。
- [Playwright tracing](../reference/web-t4/playwright/packages/playwright-core/src/server/trace/recorder/tracing.ts)：callId贯穿before/input/after、单调时间与资源引用分离；映到actionId与不可变operation事件。
- [rrweb事件类型](../reference/web-t4/rrweb/packages/types/src/index.ts)：事件类型/data与timestamp组合、全量/增量分离；不移植DOM录制或页面插桩。
- [OpenReplay timeline](../reference/web-t4/openreplay/frontend/app/components/Session_/Player/Controls/Timeline.tsx)：会话startedAt、回放相对时间与UI游标分列；不将回放seek当真实页面时间控制。
- [DevTools screencast](../reference/web-t4/devtools-frontend/front_end/panels/screencast/ScreencastView.ts) 与 [timeline目录](../reference/web-t4/devtools-frontend/front_end/panels/timeline)：target绑定、模型释放、视觉/网络/动画分轨；不新增本轮面板。
- [Perfetto track event](../reference/web-t4/perfetto/protos/perfetto/trace/track_event/track_event.proto)：独立轨道身份、begin/end区段及显式关系；时间轴并排本身不证因果。

交接范围：核心执行者实现§6纯模块/U；Host执行者实现§2–5/§8采集、控制、投影、注册、taxonomy；测试执行者完成§9 B与旧套件回归；Lead维护权威文本、索引/状态/Skill及独立复跑，并处理上述待决项。本文交付不宣称任何T4门槛已通过。
