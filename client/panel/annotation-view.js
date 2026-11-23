      function shellAnnotBar() {
        return annotOn && h('div', { className: 'utb-annot-bar', id: annotPanelId, role: 'group', 'aria-label': '标注工具', ref: annotBarRef },
          h('div', { className: 'utb-annot-group', role: 'group', 'aria-label': '标注工具选择' },
            ANNOT_TOOLS.map((tool) => annotToolButton(tool.id, tool.label))),
          h('div', {
            className: 'utb-seg utb-annot-seg',
            role: 'group',
            'aria-label': '填充与外框',
            'data-utb-annot-seg': 'fill-stroke',
          },
            h('button', {
              type: 'button',
              className: 'utb-seg-btn',
              'data-utb-annot-mode': 'fill',
              'aria-label': '填充',
              title: '填充（仅圆形/矩形；当前色不透明）',
              'aria-pressed': annotStyleMode === 'fill',
              disabled: !annotIsClosedTool(annotTool),
              onClick: () => changeAnnotStyleMode('fill'),
            }, segDot(annotStyleMode === 'fill', 'fill-stroke'), '填充'),
            h('button', {
              type: 'button',
              className: 'utb-seg-btn',
              'data-utb-annot-mode': 'stroke',
              'aria-label': '外框',
              title: '外框（仅圆形/矩形；当前色 + 粗细）',
              'aria-pressed': annotStyleMode === 'stroke',
              disabled: !annotIsClosedTool(annotTool),
              onClick: () => changeAnnotStyleMode('stroke'),
            }, segDot(annotStyleMode === 'stroke', 'fill-stroke'), '外框')),
          h('label', { className: 'utb-annot-check', title: '颜色' },
            h('span', null, '颜色'),
            h('input', {
              type: 'color',
              className: 'utb-annot-color',
              value: annotColor,
              'aria-label': '颜色',
              disabled: annotTool === 'eraser' || annotIsSelectionTool(annotTool),
              onChange: (e) => changeAnnotStyle({ color: String(e.target.value || '').toLowerCase() }),
            })),
          h('label', { className: 'utb-annot-check', title: '粗细（1–20 画布 px）' },
            h('span', null, '粗细'),
            h('input', {
              type: 'number',
              className: 'utb-num utb-annot-width',
              min: 1,
              max: 20,
              step: 1,
              value: String(annotWidth),
              'aria-label': '粗细',
              'data-utb-annot-field': 'width',
              disabled: annotTool === 'text' || annotTool === 'eraser' || annotIsSelectionTool(annotTool),
              onChange: (e) => {
                const numeric = Number(e.target.value);
                if (!Number.isFinite(numeric) || String(e.target.value).trim() === '') return;
                changeAnnotStyle({ width: clampNumber(Math.round(numeric), 1, 20) });
              },
            })),
          // v2 §11.4：横栏右侧（粗细之后）的可见文案按钮；仅模式内可见、无二次确认、空态禁用。
          // 「粗细」之后：把当前页面连同标注截成一张图，加入聊天框附件。
          // 禁用条件与「清除画布」同源（没有可视画面 / 正在截图都不派发）。
          h('button', {
            type: 'button',
            className: 'utb-btn utb-annot-shot',
            'aria-label': '截图（含标注）',
            title: '把当前画面连同标注一起截图，加入聊天框附件',
            'data-utb-annot-action': 'capture',
            'data-utb-annot-shot': annotShotBusy ? 'busy' : (annotReady ? 'ready' : 'unsupported'),
            disabled: !annotReady || annotShotBusy,
            onClick: captureAnnotationShot,
          }, annotShotBusy ? '截图中…' : '截图'),
          annotShotNotice && h('span', {
            className: 'utb-annot-sync',
            role: 'status',
            'aria-live': 'polite',
            'data-utb-annot-shot-notice': 'true',
          }, annotShotNotice),
          annotSelectionCount() > 0 && h('button', {
            type: 'button',
            className: 'utb-btn utb-annot-delete',
            'aria-label': '删除选中的标注',
            title: '删除选中的标注（Delete / Backspace）',
            'data-utb-annot-action': 'delete-selection',
            'data-utb-annot-selection': String(annotSelectionCount()),
            disabled: !annotReady,
            onClick: () => annotDeleteSelection(),
          }, '删除选中（' + annotSelectionCount() + '）'),
          h('button', {
            type: 'button',
            className: 'utb-btn utb-annot-clear',
            'aria-label': '清除画布',
            title: '清除画布',
            'data-utb-annot-action': 'clear',
            disabled: !annotReady || (!annotShapesRef.current.length && !annotBusy && !annotText),
            onPointerDown: annotClearPointerDown,
            onClick: clearAnnotCanvas,
          }, '清除画布'))
      }

      /** 公共区：状态栏。控制权 / 实测帧率与延迟 / 已选标注 / 同步状态 / 活动摘要。 */
      /** 公共区：标注图层（跨环境共用）。无页面环境下由合成映射覆盖空白画布。 */
      function shellAnnotTextInput() {
        return annotText ? h('input', {
         key: 'annot-text-input-' + annotText.id,
         className: 'utb-annot-text-input',
         ref: annotInputRef,
         type: 'text',
         maxLength: 200,
         defaultValue: '',
         'aria-label': '标注文字',
         autoFocus: true,
         style: {
           left: annotText.left,
           top: annotText.top,
           width: 220,
           height: Math.max(18, annotText.fontSize * 1.4),
           fontSize: annotText.fontSize,
           color: annotText.color,
           borderColor: annotText.color,
         },
         onKeyDown: annotTextKey,
         onBlur: () => commitAnnotText(),
         onCompositionStart: () => { annotComposingRef.current = true; },
         onCompositionEnd: () => { annotComposingRef.current = false; },
        }) : null;
      }

      function shellAnnotLayer() {
        return h('svg', {
                  className: 'utb-annot-layer',
                  ref: annotSvgRef,
                  'data-utb-annot-layer': 'true',
                  'data-utb-annot-space': 'canvas-css-px',
                  'data-utb-annot-sync': annotSyncState,
                  'data-utb-annot-revision': String(annotSyncRevision),
                  'data-utb-annot-active-tool': annotTool,
                  'data-utb-annot-selection-count': String(annotSelectionCount()),
                  role: 'img',
                  'aria-label': '标注画布',
                  tabIndex: annotOn ? 0 : -1,
                  viewBox: annotMapNow
                    ? `${annotMapNow.cx} ${annotMapNow.cy} ${annotMapNow.w} ${annotMapNow.h}`
                    : '0 0 1 1',
                  preserveAspectRatio: 'none',
                  style: {
                    position: 'absolute',
                    left: annotMapNow ? annotMapNow.painted.left - annotMapNow.boxRect.left : 0,
                    top: annotMapNow ? annotMapNow.painted.top - annotMapNow.boxRect.top : 0,
                    width: blenderView ? '100%' : annotMapNow ? annotMapNow.painted.width : 1,
                    height: blenderView ? '100%' : annotMapNow ? annotMapNow.painted.height : 1,
                    overflow: 'hidden',
                    zIndex: 2,
                    display: annotMapNow ? 'block' : 'none',
                    pointerEvents: annotOn ? 'auto' : 'none',
                    cursor: annotOn
                      ? (annotMoveRef.current.active && annotMoveRef.current.dragging ? 'grabbing'
                        : annotTool === 'select' || annotTool === 'marquee' ? annotHoverRef.current
                          : annotTool === 'text' ? 'text'
                            : 'crosshair')
                      : 'default',
                    touchAction: 'none',
                    userSelect: 'none',
                  },
                  onPointerDown: onAnnotPointerDown,
                  onPointerMove: onAnnotPointerMove,
                  onPointerUp: onAnnotPointerUp,
                  onPointerCancel: onAnnotPointerCancel,
                  onLostPointerCapture: onAnnotPointerCancel,
                  onPointerLeave: () => annotSetHoverCursor('default'),
                },
                  // 选中光晕先画：同一几何用品牌色加粗描边垫在图形下面，图形本体仍保持原色。
                  annotVisibleShapes.map((shape) => (annotSelectionRef.current.has(shape.id)
                    ? renderAnnotShape(shape, {
                      key: 'annot-halo-' + shape.id,
                      className: 'utb-annot-select-halo',
                      'data-utb-annot-halo': shape.id,
                      'data-utb-annot-state': 'halo',
                      'data-utb-annot-selected': 'true',
                    })
                    : null)),
                  annotVisibleShapes.map((shape) => renderAnnotShape(shape, {
                    'data-utb-annot-selected': annotSelectionRef.current.has(shape.id) ? 'true' : 'false',
                  })),
                  // 选中态：每个选中图形一组「行进蚂蚁」框（白底 + 蓝色虚线 + 蓝色淡填充），
                  // 保证在浅色/深色页面上都能一眼看出；纯面板视觉，不进 Host 截图、不改图形数据。
                  annotVisibleShapes.map((shape) => {
                    if (!annotSelectionRef.current.has(shape.id)) return null;
                    const box = annotShapeBounds(shape);
                    if (!box) return null;
                    const rect = { x: box.x, y: box.y, width: box.w, height: box.h, rx: 2 };
                    return h('g', {
                      key: 'annot-select-' + shape.id,
                      className: 'utb-annot-select-group',
                      'data-utb-annot-select-box': shape.id,
                    },
                      h('rect', Object.assign({}, rect, { className: 'utb-annot-select-fill' })),
                      h('rect', Object.assign({}, rect, { className: 'utb-annot-select-edge' })),
                      h('rect', Object.assign({}, rect, { className: 'utb-annot-select-ants' })));
                  }),
                  annotSelectionCount() > 1 && (() => {
                     const box = annotSelectionBounds();
                     if (!box) return null;
                     const rect = { x: box.x, y: box.y, width: box.w, height: box.h, rx: 2 };
                     return h('g', { key: 'annot-group-bounds', className: 'utb-annot-select-group', 'data-utb-annot-group-box': 'true' },
                       h('rect', Object.assign({}, rect, { className: 'utb-annot-select-edge' })),
                       h('rect', Object.assign({}, rect, { className: 'utb-annot-select-ants' })));
                   })(),
                   h('g', { key: 'annot-draft', 'data-utb-annot-state': 'draft', ref: annotDraftRef }));
      }

      /** 公共区：无页面环境的合成标注映射——画布即视图尺寸，painted 覆盖整块。 */
      function annotBlenderMap() {
        const box = blenderBoxRef.current;
        if (!box || !blenderStatus.width) return null;
        const boxRect = box.getBoundingClientRect();
        if (!(boxRect.width > 0) || !(boxRect.height > 0)) return null;
        const { width: w, height: h } = envDefaultSize('three-d');
        return { painted: boxRect, boxRect, cx: 0, cy: 0, w, h, sx: boxRect.width / w, sy: boxRect.height / h };
      }

      function annotBlankMap() {
        const box = document.querySelector('.utb-box[data-utb-shell="blank-box"]');
        if (!box) return null;
        const boxRect = box.getBoundingClientRect();
        if (!(boxRect.width > 0) || !(boxRect.height > 0)) return null;
        const bw = Math.max(1, Number(width) || 1024);
        const bh = Math.max(1, Number(height) || 768);
        // painted 与 boxRect 同为视口坐标：annotInside 直接用 clientX 比较，annotToCanvas 再除以 sx/sy。
        const painted = { left: boxRect.left, top: boxRect.top, width: boxRect.width, height: boxRect.height };
        return { painted, boxRect, cx: 0, cy: 0, w: bw, h: bh, sx: painted.width / bw, sy: painted.height / bh };
      }
