# 道具 Workflow

```json
{"id":"prop","version":"1.0.0","requiredOps":[]}
```

## 输入与输出

输入为 `assetType=prop` 阶段 brief、规范化部件/尺寸/材质规格片段与 specRef、参考图与用途、枢轴/连接关系、交付镜头、预算、已绑定对象 ID、已有工程 revision 和实际 op 版本。桌灯归此 Workflow；不因为存在灯罩而跳过道具几何阶段。

输出为 `version=1.0.0` 的阶段 DAG、带版本和 stepId 的操作提案、验收 assertions、发现的 dependencies/limitations/blockers 和 checkpoint。沿用 Director 的 briefId/stageId/specRef/boundObjectIds/proposal/checks 合同。Workflow 空 requiredOps 按下表 System 展开，执行始终通过 Tools plan → 租约下 apply，不直接写 Blender。

## 阶段顺序与门槛

| stageId / needs | System 与产物 | 指标、单位、来源、容差与证据 |
| --- | --- | --- |
| reference-purpose / 无 | 参考、用途与枢轴 brief | 尺度 m、枢轴空间/轴向 degree，来自用户/规格及公差；源摘要和绑定 ID |
| parts-connections / reference-purpose | modeling-topology：部件及连接拆分 | 部件个数、父子/连接关系；规格计数容差 0；重新枚举层级，材质和运动部件分别声明 |
| primary-form / parts-connections | modeling-topology：主形与硬尺寸白模 | 轮廓 px/比值、尺寸 m，按 acceptance；固定镜头图、局部无缩放与世界读数 |
| secondary-uv / primary-form | modeling-topology、modifiers-geometry-nodes、uv-material-texture：次形、倒角与 UV 方案 | 间隙 m、triangles、px/m/重叠 %，按 brief；拓扑统计、UV/棋盘格证据 |
| materials / secondary-uv，或明确无需该步的 primary-form | uv-material-texture：已确认材质及槽位 | 参数 0–1、槽索引、外观评审，按规格公差；节点读回、使用者清单与独立标准照明图 |
| optimize-save / materials | optimization-export-qa：优化方案、保存与交付 | triangles/bytes、m/degree、hash，按交付预算；独立重开、引用检查和持久摘要 |

没有倒角/UV 需求的原语道具可明确省略 secondary-uv，更新 needs，不把未运行步骤记成 pass。先过轮廓和硬尺寸再进入外观。底面接触、手握、铰链或插槽枢轴以用途确认，不能一律放几何中心。所有 checks 记录 metric/unit/source/tolerance/observed/evidenceIds/verdict，verdict 为 pass|fail|unknown。

## 桌灯的独立门槛

对采用这些验收值的桌灯 brief，分别建立几何与材质检查，不将一个通过推成另一个通过：

| 检查 | 指标/单位/来源/容差 | 独立证据与判定 |
| --- | --- | --- |
| 底座尺寸 | 规格底座半径 0.080 m，绝对容差 ±0.001 m | 从局部无缩放圆柱和实际世界边界分别读回；固定段数并将离散化误差控制在公差内，记录 segments、父变换与单位 |
| 灯罩/共享涂层修订 | 已确认修订的 roughness=0.60，无量纲，绝对误差 ≤1e-6 | 先提交规格并读回新 revision/hash，重新 plan 列出同材质受影响的部件；apply 后独立读 shader 节点，不用图片亮度代替数值 |
| 持久结构 | 指定规格的 ID/层级/材质/外链，计数容差 0 | 保存后在独立 Blender 读取器重开同一摘要文件，检查局部/世界变换和引用 |
| 固定镜头地标 | 已标定且冻结的验收相机，至少 8 个可见保留地标，重投影 RMSE ≤2 px | 独立保留图及内外参；样例 cam_front 外参未知时相应结论 unknown |
| 固定镜头轮廓 | 独立 foreground mask 与保留 mask 的 IoU ≥0.90 | 固定引擎、照明、背景、分辨率、裁切和色彩管理；缺 mask、标定或足够覆盖时 unknown |

这些数值仅用于采纳了该规格的桌灯任务，其他道具取本任务 brief。共享涂层仍为候选时阻塞材质步骤，几何可单独计划；白模占位仅在明确许可后执行。灯罩观感若可同时由光照和涂层解释，分别保留候选并获取补充证据。

## 能力缺口与返修

原语、TRS、层级与确定材质参数只用真实注册 op。倒角、UV、复杂拓扑、物理、相机编译和格式导出无可用 op 时保留方案并阻塞对应阶段，不能将其混入 ops 或用 shell/Python 直写。静态桌灯不要求动画/物理。

尺寸失败回 primary-form；枢轴/连接失败回 parts-connections；材质修订失败回 materials。每次修订在新规格/工程基线上重新 plan，复验受影响的几何、共享使用者与持久化检查。硬约束 fail 必须返修，证据缺失 unknown，任何受限交付都记录用户接受的范围。
