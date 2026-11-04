# 证据契约（M0–M2 + T2）

每次工具调用返回并 render `actionId/sessionId/startedAt/finishedAt/target/args` 摘要，关联业务结果；失败 BrowserError 的 `[CODE]` message 含该次证据。不能只留在 execute value：只有 render 内容可进入 durable transcript。实际字段与附件必须来自本轮工具，不伪造路径/ID。

| 证据 | 能说明什么 | 限制 |
| --- | --- | --- |
| state/capabilities | 页面/owner 与实际可用性诊断 | 不启动；不证明业务正确或加载完成 |
| eval | 顶层页面可序列化 JS 值、异常描述/栈 | 无 frame 选择，不冒充 UI/网络/像素证据 |
| computed_style | 首个匹配元素计算样式 | 无伪元素/iframe/Shadow DOM 定位，不证明画面无遮挡 |
| network | URL 脱敏后的响应与 loadingFailed 元数据 | 有界、跨导航可能累积，close 清空；无头/正文，不保证全部业务敏感字段已消除 |
| screenshot | PNG base64、capturedAt、sha256、attachmentId、capture v1（结构/尺寸/全量均匀统计、文档映射、file/delivery/warnings） | 可连续scale/文档clip/安全落盘；不提供T3差异/阈值/VLM或T4序列，附件metadata不自证provider |

## T2 结构化证据（version=1）

每个 T2 调用成功或抛错都产生 evidence：成功在 `result.evidence`，失败在 `BrowserError.details.evidence`（纯参数预检/BUSY/队列前取消不启动页面，未观察字段为 null 并在 `incomplete` 说明原因）。

```text
version=1, operation,
provenance{runtimeId,pageGeneration,documentEpoch,snapshotId,digest,source:ref|selector|document|snapshot},
targets[{fieldIndex,requested:{kind},resolved:{ref,role,name,bbox,frameId,
         identity{backendNodeId,objectResolved,connected,ownerDocumentMatched,backendNodeMatched}},
         nodeBefore,nodeAfter}],
before/after{observedAt,url,title,focus,scroll,viewport},
dispatch{started,eventCount,completed},
networkDelta{from,to,total,dropped,entries[≤20]},
escalation{tier:"T3"|"T4"|null,reason}, incomplete[], truncated
```

- `snapshotId/digest` 是 **minted provenance**（该 ref 首次被分配时的已发布快照），不是“当前快照”；selector/document 来源用最近一次成功 capture，无则 null，且 `source` 不得伪称快照定位。
- `resolved.role/name/bbox` 是现场读数；`identity.*` 是身份证明（Element/connected/ownerDocument/backendNodeId 一致）。`nodeAfter:null` + `incomplete` 含 `node-after-document-changed` 表示动作触发了文档切换，不能用新页节点冒充旧身份。
- `networkDelta` 用 Runtime 单调 `seq` 统计一次动作期间的新增/响应/失败事件，最多回 20 条，`total`/`dropped` 说明窗口总量与丢弃（缓冲覆盖+输出截断），不是因果归属。
- `escalation` 只表示建议层级（hidden/covered → T3，unstable → T4），**不等于**该层可用。
- 脱敏：可编辑控件 `value:null` + `valueRedacted:true`；密码类控件连 text/AX value 一并屏蔽；`requested` 不含 selector 原文；args 只保留结构摘要；页面自由文本仍可能敏感。

截图保留 image base64；可用时 `ctx.attachments.saveImage` 保存附件并 render image block。缺少附件服务明确 render base64-fallback 文本。附件 ID 不是文件路径，保存成功不等于 provider 已显示图像；真实可见性需在视觉 provider 会话实测。不能宣称已落本地证据文件，除非有实际返回/授权保存证据。截图与 eval 内容不自动脱敏，image block 可能进入 provider 上下文。

P0的 `capture.version=1` 与T2 evidence独立：含request/environment/png/expected/sizeCheck/mapping/anomaly/file/delivery/warnings，mapping仅JSON+公式；DPR未知null、DSF来源runtime-override，headlessSource来自product/userAgent。原图尺寸/hash/文件是采集事实，delivery仅附件metadata，不自证provider。默认staging（绝对path/ephemeral=true，插件dispose清理）；out/persist:true/非空env才persistent（env或cwd根相对path/ephemeral=false）。file含pathKind/persistence/root/ephemeral，暂存不能当持久证据；observed.file只含persistence/relativePath|null不公开绝对路径。仅file非null且hash匹配可声明已有文件，暂存失败file=null+既有warning。路径规则见 [安全边界](../core/safety.md)。≤16M像素全量均匀/透明统计不替代视觉判定；C13前后布局相同不排除瞬时LBI，canvas位图细节不增加，TOCTOU未解决。真实宿主与 provider 行为需单独证据。

没有独立JSONL证据包、自动assertion_status、帧序列或视觉差异分析；原始PNG落盘不等于独立证据包。`/metrics` 是预览管线诊断，不能替代页面断言。close 清空网络/URL/标题/帧缓存**与 T2 的 snapshot/ref 表**；引用记录仍要核对本轮 action 时序。

原始截图可见也不把 T3/T4 升为已实现；T2 断言必须给出 `snapshotId/digest` + `targets[].resolved` + `dispatch` 与页面真值读数：**`dispatched:true` 不是 PASS**，`dispatch.completed` 也只说明派发过程。
