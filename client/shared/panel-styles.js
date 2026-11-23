    const CSS = `
.utb { height: 100%; min-height: 0; display: flex; flex-direction: column; color: var(--dsw-alias-label-primary); background: var(--dsw-alias-bg-base); font: 13px/1.5 system-ui, -apple-system, "Segoe UI", sans-serif; }
.utb * { box-sizing: border-box; }
.utb-top { display: flex; align-items: center; gap: 10px; flex: 0 0 auto; min-height: 44px; padding: 6px 10px; background: var(--dsw-alias-bg-layer-1); border-bottom: 1px solid var(--dsw-alias-border-l1); }
.utb-env-icon { display: grid; place-items: center; width: 30px; height: 30px; flex: 0 0 auto; color: var(--dsw-alias-label-secondary); background: var(--dsw-alias-bg-base); border: 1px solid var(--dsw-alias-border-l1); border-radius: 9px; }
.utb-env-text { display: flex; align-items: center; min-height: 30px; min-width: 0; }
.utb-env-title { font-size: 13px; font-weight: 600; line-height: 17px; color: var(--dsw-alias-label-primary); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.utb-env-pick { position: relative; display: inline-flex; align-items: center; flex: 0 0 auto; }
.utb-select { appearance: none; -webkit-appearance: none; height: 26px; padding: 0 26px 0 10px; font: inherit; font-size: 12px; color: var(--dsw-alias-label-primary); background: var(--dsw-alias-bg-base); border: 1px solid var(--dsw-alias-border-l2); border-radius: 8px; cursor: pointer; }
.utb-select:focus-visible { outline: 2px solid var(--dsw-alias-brand-primary); outline-offset: 1px; }
.utb-select option:disabled { color: var(--dsw-alias-label-secondary); }
.utb-env-caret { position: absolute; right: 7px; display: grid; place-items: center; pointer-events: none; color: var(--dsw-alias-label-secondary); }
.utb-env-error { max-width: 220px; font-size: 11px; line-height: 14px; color: #f59e0b; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.utb-sr { position: absolute; width: 1px; height: 1px; margin: -1px; padding: 0; overflow: hidden; clip: rect(0 0 0 0); white-space: nowrap; border: 0; }
.utb-bar { display: flex; align-items: center; gap: 4px; padding: 6px 8px; flex: 0 0 auto; background: var(--dsw-alias-bg-layer-1); border-bottom: 1px solid var(--dsw-alias-border-l1); }
.utb-btn { display: inline-flex; align-items: center; justify-content: center; width: 28px; height: 28px; padding: 0; flex: 0 0 auto; color: var(--dsw-alias-label-secondary); background: transparent; border: 1px solid transparent; border-radius: 6px; cursor: pointer; }
.utb-btn:hover:not(:disabled) { color: var(--dsw-alias-label-primary); background: var(--dsw-alias-bg-layer-2); }
.utb-btn[aria-pressed="true"] { color: var(--dsw-alias-brand-primary); background: var(--dsw-alias-bg-layer-2); }
.utb-btn:disabled { opacity: .38; cursor: not-allowed; }
.utb-addr { flex: 1 1 auto; min-width: 0; height: 28px; padding: 0 10px; font: inherit; color: var(--dsw-alias-label-primary); background: var(--dsw-alias-bg-base); border: 1px solid var(--dsw-alias-border-l1); border-radius: 6px; }
.utb-addr::placeholder { color: var(--dsw-alias-label-secondary); }
.utb-addr[data-invalid="true"] { border-color: var(--dsw-alias-state-error-primary); outline-color: var(--dsw-alias-state-error-primary); }
.utb-addr:focus-visible, .utb-btn:focus-visible, .utb-menu-item:focus-visible, .utb-num:focus-visible, .utb-addr-hist:focus-visible, .utb-addr-audio:focus-visible { outline: 2px solid var(--dsw-alias-brand-primary); outline-offset: 1px; }
.utb-addr-wrap { position: relative; display: flex; align-items: center; flex: 1 1 auto; min-width: 0; }
.utb-addr-wrap .utb-addr { flex: 1 1 auto; padding-right: 56px; }
/* 地址栏内侧的两个按钮：历史（最右，right:2px）与声音（左邻，right:26px）。 */
.utb-addr-hist, .utb-addr-audio { position: absolute; top: 2px; bottom: 2px; display: inline-flex; align-items: center; justify-content: center; width: 24px; padding: 0; border: 0; border-radius: 4px; background: transparent; color: var(--dsw-alias-label-secondary); cursor: pointer; }
.utb-addr-hist { right: 2px; }
.utb-addr-audio { right: 26px; }
.utb-addr-hist:hover, .utb-addr-audio:hover { background: var(--dsw-alias-bg-layer-2); color: var(--dsw-alias-label-primary); }
.utb-addr-hist:disabled, .utb-addr-audio:disabled { opacity: .45; cursor: not-allowed; }
.utb-addr-hist[data-utb-history-toggle="open"] { background: var(--dsw-alias-bg-layer-2); color: var(--dsw-alias-label-primary); }
.utb-addr-audio[aria-pressed="true"], .utb-addr-audio[aria-pressed="true"]:hover { color: var(--dsw-alias-brand-primary); }
.utb-addr-pop { right: 0; left: auto; min-width: 100%; max-width: 560px; max-height: 264px; overflow: auto; }
.utb-addr-pop-head { padding: 4px 8px 6px; font-size: 12px; line-height: 16px; color: var(--dsw-alias-label-secondary); }
.utb-addr-pop-empty { padding: 8px; font-size: 12px; color: var(--dsw-alias-label-secondary); }
.utb-addr-label { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.utb-more { position: relative; flex: 0 0 auto; }
.utb-pop { position: absolute; right: 0; top: calc(100% + 4px); z-index: 20; min-width: 208px; padding: 4px; background: var(--dsw-alias-bg-overlay); border: 1px solid var(--dsw-alias-border-l1); border-radius: 8px; box-shadow: 0 8px 24px rgba(0,0,0,.28); }
.utb-menu-item { display: flex; align-items: center; gap: 8px; width: 100%; padding: 7px 10px; font: inherit; text-align: left; color: var(--dsw-alias-label-primary); background: transparent; border: 0; border-radius: 6px; cursor: pointer; }
.utb-menu-item:hover:not(:disabled) { background: var(--dsw-alias-bg-layer-2); }
.utb-menu-item:disabled { color: var(--dsw-alias-label-secondary); opacity: .6; cursor: not-allowed; }
/* 原生 <select> 的面板侧浮层（浏览器弹层在 UI 图层，帧里看不到）。
   观感复用 .utb-pop 那一套 token；定位由 selectPopLayout 纯函数给出。 */
.utb-select-pop { overflow-y: auto; overflow-x: hidden; padding: 4px; background: var(--dsw-alias-bg-overlay); border: 1px solid var(--dsw-alias-border-l1); border-radius: 8px; box-shadow: 0 8px 24px rgba(0,0,0,.28); outline: none; }
.utb-select-pop:focus-visible { outline: 2px solid var(--dsw-alias-brand-primary); outline-offset: 1px; }
.utb-select-pop-item { display: block; width: 100%; padding: 4px 8px; font-size: 12px; line-height: 18px; color: var(--dsw-alias-label-primary); border-radius: 6px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; cursor: pointer; }
.utb-context-menu button { background: transparent; font-family: inherit; }
.utb-select-pop-item:hover { background: var(--dsw-alias-bg-layer-2); }
.utb-select-pop-item[data-utb-select-item="active"] { background: var(--dsw-alias-bg-layer-3, var(--dsw-alias-bg-layer-2)); color: var(--dsw-alias-brand-primary); }
.utb-select-pop-item[data-utb-select-item="disabled"] { color: var(--dsw-alias-label-secondary); opacity: .55; cursor: not-allowed; }
/* 调试工具弹窗被拦截时的本地提示 + 可点击降级链接（不写 Runtime lastError）。 */
.utb-devtools-note { display: flex; align-items: center; gap: 8px; flex: 0 0 auto; flex-wrap: wrap; row-gap: 4px; padding: 6px 8px; font-size: 12px; color: var(--dsw-alias-label-secondary); background: var(--dsw-alias-bg-layer-1); border-bottom: 1px solid var(--dsw-alias-border-l1); }
.utb-devtools-note a { color: var(--dsw-alias-brand-primary); text-decoration: underline; }
/* Canvas 同步/输入本地提示：纯客户端状态，不写 Runtime lastError，不伪造 view revision。 */
.utb-sync-note { display: flex; align-items: center; gap: 8px; flex: 0 0 auto; flex-wrap: wrap; row-gap: 4px; padding: 6px 8px; font-size: 12px; color: var(--dsw-alias-label-secondary); background: var(--dsw-alias-bg-layer-1); border-bottom: 1px solid var(--dsw-alias-border-l1); }
.utb-sync-note button { font: inherit; padding: 2px 8px; border-radius: 6px; border: 1px solid var(--dsw-alias-border-l1); background: var(--dsw-alias-bg-layer-2); color: var(--dsw-alias-label-primary); cursor: pointer; }
/* 内部浏览器标签栏（同一个调试视图内，地址栏下方；仅由开关控制显隐，单标签也占行）。 */
.utb-tabs { display: flex; align-items: center; gap: 4px; flex: 0 0 auto; padding: 4px 6px; overflow-x: auto; overflow-y: hidden; border-bottom: 1px solid var(--dsw-alias-border-l1); background: var(--dsw-alias-bg-layer-1); scrollbar-width: thin; }
.utb-tab { display: inline-flex; align-items: center; gap: 4px; flex: 0 0 auto; max-width: 220px; padding: 3px 6px; border: 1px solid var(--dsw-alias-border-l1); border-radius: 6px; background: var(--dsw-alias-bg-layer-2); color: var(--dsw-alias-label-secondary); font: 12px/1.5 inherit; white-space: nowrap; cursor: pointer; }
.utb-tab[aria-selected="true"], .utb-tab[aria-pressed="true"] { color: var(--dsw-alias-label-primary); border-color: var(--dsw-alias-brand-primary); background: var(--dsw-alias-bg-layer-3, var(--dsw-alias-bg-layer-2)); }
.utb-tab-label { overflow: hidden; text-overflow: ellipsis; }
.utb-tab-close { flex: 0 0 auto; width: 18px; height: 18px; padding: 0; border: 0; border-radius: 4px; background: transparent; color: inherit; font: 14px/18px inherit; cursor: pointer; }
.utb-tab-close:hover { background: var(--dsw-alias-bg-layer-2); }
/* 标签保活锁（人力开关，仅面板）：每个标签最左侧，未锁定为弱色描边，锁定为品牌色实心。 */
.utb-tab-lock { display: inline-flex; align-items: center; justify-content: center; flex: 0 0 auto; width: 18px; height: 18px; padding: 0; border: 0; border-radius: 4px; background: transparent; color: var(--dsw-alias-label-tertiary); cursor: pointer; }
.utb-tab-lock:hover { background: var(--dsw-alias-bg-layer-2); color: var(--dsw-alias-label-primary); }
.utb-tab-lock[data-utb-tab-locked="true"] { color: var(--dsw-alias-brand-primary); }
.utb-tab-lock:disabled { opacity: .45; cursor: default; }
.utb-tab-new { display: inline-flex; align-items: center; justify-content: center; flex: 0 0 auto; width: 24px; height: 22px; padding: 0; border: 1px solid var(--dsw-alias-border-l1); border-radius: 6px; background: var(--dsw-alias-bg-layer-2); color: var(--dsw-alias-label-secondary); font: 16px/20px inherit; cursor: pointer; }
.utb-tab-new:hover { color: var(--dsw-alias-label-primary); }
.utb-tab-new:disabled { opacity: .45; cursor: default; }
.utb-tab-note { border-bottom: 1px solid var(--dsw-alias-border-l1); background: var(--dsw-alias-bg-layer-1); padding: 4px 8px; color: var(--dsw-alias-label-secondary); font: 12px/1.5 inherit; }
/* 常驻提示横条（用户 2026-11-19）：固定单行高度，空文本也保留占位与分隔线，视图不随文字出现/消失跳动。 */
.utb-tab-note { height: 28px; padding-top: 0; padding-bottom: 0; align-items: center; }
.utb-tab-note-text { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; min-width: 0; line-height: 18px; }
.utb-agent-note { color: var(--dsw-alias-label-secondary); }
.utb-tabs-glyph { font-size: 13px; line-height: 1; }
.utb-size { display: flex; align-items: center; gap: 8px; padding: 6px 8px; flex: 0 0 auto; flex-wrap: wrap; row-gap: 4px; font-size: 12px; color: var(--dsw-alias-label-secondary); background: var(--dsw-alias-bg-layer-1); border-bottom: 1px solid var(--dsw-alias-border-l1); }
/* P0-D 标注栏（用户 2026-11-02 要求）：独立横栏，正常单行 41px，窄面板换行不覆盖预览区。 */
.utb-annot-bar { display: flex; align-items: center; gap: 6px; padding: 6px 8px; flex: 0 0 auto; flex-wrap: wrap; row-gap: 4px; min-height: 41px; font-size: 12px; color: var(--dsw-alias-label-secondary); background: var(--dsw-alias-bg-layer-1); border-bottom: 1px solid var(--dsw-alias-border-l1); }
.utb-annot-group { display: inline-flex; align-items: center; gap: 4px; flex: 0 0 auto; flex-wrap: wrap; row-gap: 4px; }
.utb-annot-tool { width: 28px; height: 28px; }
.utb-annot-check { display: inline-flex; align-items: center; gap: 4px; flex: 0 0 auto; white-space: nowrap; cursor: pointer; }
.utb-annot-check input:disabled { cursor: not-allowed; }
.utb-annot-color { width: 30px; height: 24px; padding: 0; flex: 0 0 auto; background: var(--dsw-alias-bg-base); border: 1px solid var(--dsw-alias-border-l1); border-radius: 6px; cursor: pointer; }
.utb-annot-color:disabled { opacity: .55; cursor: not-allowed; }
.utb-annot-width { width: 54px; }
/* v2：横栏右侧的可见文案按钮「清除画布」（§11.4）与状态栏同步提示（§11.3）。 */
.utb-annot-shot { width: auto; min-width: 0; height: 28px; padding: 0 10px; font-size: 12px; line-height: 1; white-space: nowrap; border-color: var(--dsw-alias-border-l1); background: var(--dsw-alias-bg-base); }
.utb-annot-clear { width: auto; min-width: 0; height: 28px; padding: 0 10px; margin-left: auto; font-size: 12px; line-height: 1; white-space: nowrap; border-color: var(--dsw-alias-border-l1); background: var(--dsw-alias-bg-base); }
.utb-annot-delete { width: auto; min-width: 0; height: 28px; padding: 0 10px; font-size: 12px; line-height: 1; white-space: nowrap; border-color: var(--dsw-alias-border-l1); background: var(--dsw-alias-bg-base); }
/* 选中态（选择/框选）：品牌色光晕 + 半透明包围框 + 并行胶囊；纯面板 SVG 视觉，不进截图、不改图形数据。 */
.utb-annot-select-halo { opacity: .4; pointer-events: none; }
.utb-annot-select-halo * { stroke: #0b6bff !important; fill: none !important; stroke-width: 8 !important; vector-effect: non-scaling-stroke; }
.utb-annot-select-halo polygon { fill: #0b6bff !important; stroke: #0b6bff !important; }
.utb-annot-select-halo text { fill: #0b6bff !important; stroke: none !important; }
.utb-annot-select-group { pointer-events: none; }
.utb-annot-select-fill { fill: rgba(11, 107, 255, .16); stroke: none; pointer-events: none; }
.utb-annot-select-edge { fill: none; stroke: #fff; stroke-width: 3; vector-effect: non-scaling-stroke; pointer-events: none; }
.utb-annot-select-ants { fill: none; stroke: #0b6bff; stroke-width: 1.6; stroke-dasharray: 5 3; vector-effect: non-scaling-stroke; pointer-events: none; animation: utb-annot-ants 1s linear infinite; }
@keyframes utb-annot-ants { to { stroke-dashoffset: -8; } }
@media (prefers-reduced-motion: reduce) { .utb-annot-select-ants { animation: none; } }
.utb-annot-selected-status { flex: 0 0 auto; color: var(--dsw-alias-brand-primary); font-variant-numeric: tabular-nums; white-space: nowrap; }
.utb-annot-marquee-box { fill: color-mix(in srgb, var(--dsw-alias-brand-primary) 10%, transparent); stroke: var(--dsw-alias-brand-primary); stroke-width: 1; stroke-dasharray: 4 3; vector-effect: non-scaling-stroke; pointer-events: none; }
.utb-annot-sync { flex: 0 1 auto; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; color: var(--dsw-alias-state-warn-primary); }
.utb-annot-layer { display: block; overflow: hidden; }
.utb-annot-layer:focus-visible { outline: 2px solid var(--dsw-alias-brand-primary); outline-offset: -2px; }
.utb-annot-text-input { position: absolute; margin: 0; padding: 0 2px; font-family: system-ui, -apple-system, "Segoe UI", sans-serif; font-weight: 400; line-height: 1.2; background: var(--dsw-alias-bg-base); border: 1px dashed currentColor; border-radius: 2px; outline: none; z-index: 3; }
/* 选元素模式：纯面板 DOM 的悬浮框（pointer-events:none，被 .utb-box 裁剪，不进 Host 截图）。 */
.utb-pick-layer { position: absolute; inset: 0; overflow: hidden; pointer-events: none; z-index: 3; }
.utb-pick-outline { position: absolute; pointer-events: none; border: 2px solid var(--dsw-alias-brand-primary); border-radius: 1px; background: color-mix(in srgb, var(--dsw-alias-brand-primary) 12%, transparent); box-shadow: 0 0 0 1px rgba(0, 0, 0, .28); }
.utb-pick-tag { position: absolute; max-width: 100%; padding: 1px 5px; font: 11px/1.5 ui-monospace, SFMono-Regular, Menlo, monospace; color: #fff; background: var(--dsw-alias-brand-primary); border-radius: 4px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; pointer-events: none; }
.utb-pick-note { color: var(--dsw-alias-brand-primary); }
.utb-pick-note[data-utb-pick-status="ok"] { color: var(--dsw-alias-state-success-primary); }
.utb-pick-note[data-utb-pick-status="error"] { color: var(--dsw-alias-state-error-primary); }
.utb-num { width: 62px; height: 26px; padding: 0 6px; font: inherit; font-size: 12px; color: var(--dsw-alias-label-primary); background: var(--dsw-alias-bg-base); border: 1px solid var(--dsw-alias-border-l1); border-radius: 6px; }
.utb-num:disabled { opacity: .55; cursor: not-allowed; }
.utb-size-left { display: flex; align-items: center; gap: 6px; flex: 0 0 auto; flex-wrap: wrap; row-gap: 4px; }
.utb-size-right { display: flex; align-items: center; gap: 6px; flex: 1 1 auto; flex-wrap: wrap; row-gap: 4px; justify-content: flex-end; min-width: 0; }
.utb-pos { width: 58px; }
.utb-pos-label { flex: 0 0 auto; font-variant-numeric: tabular-nums; }
.utb-check { display: inline-flex; align-items: center; gap: 5px; cursor: pointer; }
/* 用户 2026-11-03 第 1/4 条：分页选择器（填充/外框、拖拽/适应窗口）。 */
.utb-seg { display: inline-flex; align-items: stretch; height: 24px; flex: 0 0 auto; border: 1px solid var(--dsw-alias-border-l1); border-radius: 7px; overflow: hidden; background: var(--dsw-alias-bg-base); }
.utb-seg-btn { display: inline-flex; align-items: center; justify-content: center; gap: 2px; height: 100%; padding: 0 5px; font: inherit; font-size: 12px; line-height: 22px; color: var(--dsw-alias-label-secondary); background: transparent; border: 0; border-right: 1px solid var(--dsw-alias-border-l1); cursor: pointer; white-space: nowrap; }
.utb-seg-dot { width: 8px; height: 8px; flex: 0 0 8px; display: block; }
.utb-seg-btn:last-child { border-right: 0; }
.utb-seg-btn:hover:not(:disabled) { color: var(--dsw-alias-label-primary); background: var(--dsw-alias-bg-layer-2); }
.utb-seg-btn[aria-pressed="true"] { color: var(--dsw-alias-brand-primary); background: color-mix(in srgb, var(--dsw-alias-brand-primary) 12%, transparent); }
.utb-seg-btn:disabled { opacity: .38; cursor: not-allowed; }
.utb-seg-btn:focus-visible { outline: 2px solid var(--dsw-alias-brand-primary); outline-offset: -2px; }
.utb-dim { font-variant-numeric: tabular-nums; }
.utb-num.utb-zoom { width: 54px; text-align: right; }
.utb-stage { position: relative; flex: 1 1 auto; min-height: 0; overflow: auto; display: flex; align-items: safe center; justify-content: safe center; background: var(--dsw-alias-bg-layer-2); }
.utb-box { flex: 0 0 auto; overflow: hidden; background: var(--dsw-alias-bg-base); }
.utb-box[data-fitted="true"] { box-shadow: 0 0 0 1px var(--dsw-alias-border-l2); }
/* Canvas blank = dark checkerboard (user request). Fixed host px, not view.scale. The <img>
   above it covers the box whenever the frame proves the whole viewport (O=0), so old pixels
   are unchanged; only true composited blank shows through. */
.utb-box[data-utb-canvas="on"] {
  background-color: ${CANVAS_CHECKER.dark};
  background-image: repeating-conic-gradient(${CANVAS_CHECKER.dark} 0% 25%, ${CANVAS_CHECKER.light} 0% 50%);
  background-size: ${CANVAS_CHECKER.size * 2}px ${CANVAS_CHECKER.size * 2}px;
  background-position: 0 0;
}
.utb-frame { display: block; border: 0; background: #fff; }
.utb-empty { max-width: 320px; padding: 24px; text-align: center; color: var(--dsw-alias-label-secondary); }
.utb-empty strong { display: block; margin-bottom: 6px; color: var(--dsw-alias-label-primary); font-weight: 600; }
.utb-empty-error { color: var(--dsw-alias-state-error-primary); }
.utb-status { display: flex; align-items: center; gap: 8px; flex: 0 0 auto; height: 26px; padding: 0 10px; font-size: 11.5px; color: var(--dsw-alias-label-secondary); background: var(--dsw-alias-bg-layer-1); border-top: 1px solid var(--dsw-alias-border-l1); }
.utb-mode { display: inline-flex; align-items: center; gap: 6px; flex: 0 0 auto; font-weight: 500; }
.utb-mode[data-mode="idle"] { color: var(--dsw-alias-state-success-primary); }
.utb-mode[data-mode="human"] { color: var(--dsw-alias-state-warn-primary); }
.utb-mode[data-mode="agent"] { color: var(--dsw-alias-brand-primary); }
.utb-dot { width: 6px; height: 6px; border-radius: 50%; background: currentColor; box-shadow: 0 0 0 2px color-mix(in srgb, currentColor 22%, transparent); }
.utb-mode[data-mode="agent"] .utb-dot { animation: utb-pulse 1.4s ease-in-out infinite; }
@keyframes utb-pulse { 0%, 100% { opacity: 1; } 50% { opacity: .35; } }
.utb-sep { width: 1px; height: 11px; flex: 0 0 auto; background: var(--dsw-alias-border-l1); }
.utb-perf { flex: 0 0 auto; font-variant-numeric: tabular-nums; color: var(--dsw-alias-label-secondary); }
.utb-gap { flex: 1 1 auto; min-width: 8px; }
.utb-activity { flex: 0 1 auto; min-width: 0; max-width: 62%; overflow: hidden; white-space: nowrap; text-overflow: ellipsis; color: var(--dsw-alias-label-secondary); }
@media (prefers-reduced-motion: reduce) { .utb-mode[data-mode="agent"] .utb-dot { animation: none; } }
.utb-menu-row.utb-menu-row { display: flex; flex-direction: row; align-items: center; justify-content: flex-start; align-self: stretch; gap: 6px; width: 100%; min-height: 34px; margin: 0; padding: 6px 8px; font: inherit; font-size: 13px; line-height: 20px; text-align: left; color: var(--dsw-alias-label-primary); background: transparent; border: 0; border-radius: 12px; cursor: pointer; }
.utb-menu-row.utb-menu-row > span { flex: 1 1 auto; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; text-align: left; }
.utb-menu-row.utb-menu-row > svg { flex: 0 0 auto; }
.utb-menu-row.utb-menu-row:hover { background: rgba(164, 183, 229, 0.14); background: color-mix(in srgb, var(--dsw-alias-label-primary) 14%, transparent); }
.utb-menu-row.utb-menu-row:focus-visible { outline: 2px solid var(--dsw-alias-brand-primary); outline-offset: -2px; }
/* 视图层没有该环境时的占位：问号图标 + 说明，不留空白面板 */
/* 公共区：无视图环境的禁用态外壳（渲染结构，不派发操作）。 */
/* 公共区：无视图环境的空白画布（可画标注）。 */
.utb-box[data-utb-shell="blank-box"] {
  display: grid;
  place-items: center;
  /* 视图窗：与 web 的页面框同语义——独立表面 + 边框 + 不超出预览区，标注只画在窗内。 */
  max-width: 100%;
  max-height: 100%;
  background: var(--dsw-alias-bg-base);
  box-shadow: 0 0 0 1px var(--dsw-alias-border-l2), 0 8px 24px rgba(0, 0, 0, .32);
}
.utb-blank-hint { max-width: calc(100% - 16px); padding: 12px; text-align: center; font-size: 12px; line-height: 18px; color: var(--dsw-alias-label-secondary); overflow-wrap: anywhere; }
.utb-stage.utb-blender-stage { position: relative; display: flex; min-height: 0; overflow: auto; }
.utb-blender-box { position: relative; flex: none; margin: auto; }
.utb-blender-timeline { flex: none; width: 100%; min-width: 0; }
.utb-blender-timeline img { display: block; width: 100%; height: auto; touch-action: none; user-select: none; }
.utb-blender-box img { display: block; width: 100%; height: 100%; touch-action: none; user-select: none; }
.utb-blender-stage > .utb-blank-hint { position: absolute; top: 50%; left: 50%; transform: translate(-50%, -50%); width: max-content; z-index: 3; background: var(--dsw-alias-bg-shell); }
.utb-blender-stage > .utb-blank-hint .utb-btn { padding-inline: 6px; width: auto; white-space: nowrap; }
.utb-blender-project { display: flex; flex: 1 1 180px; min-width: 0; align-items: center; gap: 4px; }
.utb-blender-project .utb-addr { padding-right: 28px; }
.utb-blender-project-toggle { position: absolute; right: 2px; top: 2px; bottom: 2px; display: grid; place-items: center; width: 24px; padding: 0; border: 0; border-radius: 4px; background: transparent; color: var(--dsw-alias-label-secondary); cursor: pointer; }
.utb-blender-project-toggle:hover, .utb-blender-project-toggle[aria-expanded="true"] { background: var(--dsw-alias-bg-layer-2); color: var(--dsw-alias-label-primary); }
.utb-blender-project-toggle:focus-visible { outline: 2px solid var(--dsw-alias-brand-primary); }
.utb-blender-project-toggle:disabled { opacity: .45; cursor: not-allowed; }
.utb-blender-project .utb-addr-pop { left: 0; right: auto; width: max-content; max-width: min(360px, calc(100vw - 24px)); }
.utb-blender-display-bar { justify-content: safe flex-end; }
.utb-blender-display-bar .utb-btn { flex: 0 0 auto; width: auto; padding-inline: 8px; font-size: 12px; white-space: nowrap; }
.utb-blender-editor { position: fixed; width: min(380px, calc(100vw - 16px)); overflow: hidden; border: 1px solid var(--dsw-alias-border-l1, #454545); border-radius: 8px; background: var(--dsw-alias-bg-layer-2, #262626); color: var(--dsw-alias-label-primary, #eee); box-shadow: 0 10px 28px #0006; font: 13px/1.5 system-ui, sans-serif; }
.utb-blender-editor.is-content-sized { width: max-content; min-width: min(180px, calc(100vw - 16px)); max-width: calc(100vw - 16px); }
.utb-blender-editor-bar { display: flex; align-items: center; justify-content: space-between; min-height: 32px; padding-left: 10px; background: var(--dsw-alias-bg-layer-1, #303030); cursor: grab; touch-action: none; user-select: none; }
.utb-blender-editor-bar:active { cursor: grabbing; }
.utb-blender-editor-close { align-self: stretch; width: 32px; padding: 0; border: 0; background: transparent; color: inherit; font: 20px/1 system-ui, sans-serif; cursor: pointer; }
.utb-blender-editor-close:hover, .utb-blender-editor-close:focus-visible { background: var(--dsw-alias-bg-layer-3, #454545); }
.utb-blender-editor-frame { display: grid; justify-items: center; outline-offset: -2px; }
.utb-blender-editor-frame img { display: block; max-width: 100%; max-height: calc(100dvh - max(62px, var(--utb-blender-editor-anchor-top, 0px) + 40px)); touch-action: none; user-select: none; }
.utb-blender-editor-loading { display: block; padding: 12px; }

.utb-noview { flex: 1 1 auto; display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 10px; padding: 24px; text-align: center; }
.utb-noview-icon { display: grid; place-items: center; width: 44px; height: 44px; border-radius: 12px; color: var(--dsw-alias-label-tertiary); background: color-mix(in srgb, var(--dsw-alias-label-primary) 6%, transparent); }
.utb-noview-text { display: flex; flex-direction: column; gap: 4px; font-size: 12px; line-height: 18px; }
.utb-noview-text strong { font-size: 13px; color: var(--dsw-alias-label-primary); }
.utb-noview-text p { margin: 0; color: var(--dsw-alias-label-tertiary); }

`;
