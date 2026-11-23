      function shellStatusBar() {
        const blenderActivity = blenderSizeError || (blenderStatus.phase === 'error' ? 'Blender · 视口不可用'
          : blenderStatus.width ? 'Blender · 可操作' : 'Blender · 连接中');
        return h('div', { className: 'utb-status' },
          h('span', { className: 'utb-mode', 'data-mode': mode, title: '当前控制权归属' },
            h('span', { className: 'utb-dot', 'aria-hidden': true }),
            blenderView ? (annotOn ? '标注中' : '预览') : MODE_LABEL[remote.mode === 'agent' ? 'agent' : mode]),
          h('span', { className: 'utb-sep', 'aria-hidden': true }),
          blenderView
            ? h('span', { className: 'utb-perf', title: '实际图像分辨率、最近一帧加载耗时及近一秒显示帧数' },
              blenderStatus.width ? `${blenderStatus.width} × ${blenderStatus.height} ${blenderStatus.ms} ms ${blenderStatus.fps || 0} FPS` : '')
            : h('span', { className: 'utb-perf', title: `实际显示帧率与端到端显示延迟（测量值）；传输：${transportKind === 'ws' ? 'WebSocket 推送' : 'HTTP 轮询'}` }, `${fps} FPS ${frameMs} ms`),
          // 选中数量是状态信息：放在底部延迟之后，而不是标注栏里的按钮/胶囊。
          annotSelectionCount() > 0 && h('span', {
            className: 'utb-annot-selected-status',
            role: 'status',
            'aria-live': 'polite',
            'data-utb-annot-selection-chip': String(annotSelectionCount()),
            title: '已选标注：拖动选框内任意位置移动，Delete / Backspace 删除，Esc 取消选择',
          }, '已选 ' + annotSelectionCount() + ' 个'),
          // v2 §11.3：标注同步状态（title + aria-live='polite'），不弹 modal、不写页面 lastError。
          h('span', {
            className: 'utb-annot-sync',
            'data-utb-annot-sync-status': annotSyncState,
            'data-utb-annot-sync-revision': String(annotSyncRevision),
            role: 'status',
            'aria-live': 'polite',
            title: annotSyncTitle,
            style: { display: annotSyncText ? 'inline' : 'none' },
          }, annotSyncText),
          h('span', { className: 'utb-gap' }),
          h('span', { className: 'utb-activity', role: blenderView ? 'status' : undefined,
            'data-utb-blender-state': blenderView ? blenderStatus.phase : undefined,
            title: !blenderView && remote.activity ? `运行时：${remote.activity}` : '视图状态' },
            blenderView ? blenderActivity : remote.activity || activity));
      }

      /**
       * 公共标签栏：只消费 provider 的展示模型和意图回调，不解析目标身份或请求 Host。
       * model = { label, items: [{ id, label, title, closeLabel, closeTitle, closeKind,
       *   locked, lockLabel, lockTitle }],
       *   activeId, canCreate, creating, createLabel, createTitle,
       *   onSelect(id), onClose(id), onLock(id), onCreate() }; null = 当前环境未提供标签能力。
       */
      function shellTabsBar(model, visible) {
        if (!model || !visible) return null;
        return h('div', {
          className: 'utb-tabs',
          role: 'tablist',
          'aria-label': model.label,
          'data-utb-tabs': 'true',
        }, model.items.map((item) => h('div', {
          key: item.id,
          id: 'utb-tab-' + item.id,
          className: 'utb-tab',
          role: 'tab',
          'aria-selected': model.activeId === item.id,
          'aria-label': item.label,
          'data-utb-tab': item.id,
          tabIndex: model.activeId === item.id ? 0 : -1,
          title: item.title || item.label,
          onClick: () => { if (typeof model.onSelect === 'function') model.onSelect(item.id); },
        },
          // 保活锁在标签最左侧（用户要求）：纯 SVG 图标，只有人类点得动；开启时不改选中。
          // The capability check must read the ITEM, not the model: `onLock` is per-row intent (a
          // provider that cannot lock simply omits it), while `model.onSelect/onClose/onCreate`
          // stay model-level. Checking `model.onLock` made this button render for nobody.
          typeof item.onLock === 'function' && h('button', {
            type: 'button',
            className: 'utb-tab-lock',
            'aria-label': item.lockLabel,
            'aria-pressed': item.locked === true,
            title: item.lockTitle,
            'data-utb-tab-lock': item.id,
            'data-utb-tab-locked': item.locked === true ? 'true' : 'false',
            onClick: (event) => { event.stopPropagation(); item.onLock(item.id); },
          }, h(IconTabLock, { locked: item.locked === true })),
          h('span', { className: 'utb-tab-label' }, item.label),
          typeof model.onClose === 'function' && h('button', {
            type: 'button',
            className: 'utb-tab-close',
            'aria-label': item.closeLabel,
            title: item.closeTitle,
            'data-utb-tab-close': item.id,
            'data-utb-tab-close-kind': item.closeKind,
            onClick: (event) => { event.stopPropagation(); model.onClose(item.id); },
          }, '×'))),
          model.canCreate && h('button', {
            type: 'button',
            className: 'utb-tab-new',
            'data-utb-tab-new': 'strip',
            'aria-label': model.createLabel,
            title: model.createTitle,
            disabled: model.creating || typeof model.onCreate !== 'function',
            onClick: model.onCreate,
          }, '+'));
      }

      function blenderShadingButton() {
        const index = BLENDER_SHADING.findIndex(({ id }) => id === blenderStatus.shading);
        const current = BLENDER_SHADING[index];
        const next = BLENDER_SHADING[(index + 1) % BLENDER_SHADING.length];
        const label = current ? `视口着色：${current.label}，单击切换到${next.label}` : '视口着色';
        return button(label, h(BlenderShadingIcon, { mode: current?.id || 'SOLID' }),
          () => blenderViewportControl.current?.({ shading: next.id }),
          !current || annotOn || blenderStatus.changingViewport || blenderStatus.phase === 'error', {
            'data-utb-blender-shading': current?.id || '',
            'aria-busy': !!blenderStatus.changingViewport,
          });
      }

      function blenderWorkspaceTabs({ active, busy, onSelect }) {
        return h('div', { className: 'utb-tabs', role: 'group', 'aria-label': 'Blender 工作区',
          'aria-busy': busy, 'data-utb-blender-workspaces': '' },
          BLENDER_WORKSPACES.map(({ id, label }) => h('button', {
            key: id, type: 'button', className: 'utb-tab',
            'aria-pressed': active === id, 'data-utb-blender-workspace': id,
            disabled: !active || busy || annotOn || blenderStatus.phase === 'error',
            onClick: () => { if (active !== id) onSelect({ workspace: id }); },
          }, h('span', { className: 'utb-tab-label' }, label))));
      }

      /** 公共区：3D 视图与空白画布的工具栏。 */
      function shellBarPublic(leading, beforeShading, moreItem) {
        return h('div', { className: 'utb-bar', 'data-utb-shell': 'public' },
          leading || h('span', { className: 'utb-gap' }),
          beforeShading,
          blenderView ? blenderShadingButton() : button('标签页', h('span', { className: 'utb-tabs-glyph', 'aria-hidden': true }, '▤'),
            tabsSupported ? () => setTabsVisible((value) => !value) : undefined, !tabsSupported, {
            'aria-pressed': tabsSupported && tabsVisible,
            'data-utb-tabs-toggle': tabsSupported ? (tabsVisible ? 'on' : 'off') : 'unsupported',
            title: tabsSupported ? (tabsVisible ? '隐藏标签页（页面保持）' : '显示标签页') : '该环境未提供标签页',
          }),
          button('标注', h(IconAnnot, null), toggleAnnotMode, !annotReady || sizing || pickOn, {
            'aria-pressed': annotOn,
            ref: annotButtonRef,
            'aria-controls': annotPanelId,
            'data-utb-annot-entry': annotOn ? 'on' : annotReady ? 'ready' : 'unsupported',
          }),
          button('尺寸调整', h(IconSize, null), toggleSizing, annotOn || pickOn, { 'aria-pressed': sizing }),
          h('div', { className: 'utb-more' },
            button('更多', h(IconMore, null), () => setMenu((v) => !v), false, { 'aria-expanded': menu, 'aria-haspopup': 'menu' }),
            menu && h('div', { className: 'utb-pop', role: 'menu' }, moreItem ||
              h('button', { type: 'button', className: 'utb-menu-item', role: 'menuitem', onClick: () => setMenu(false) },
                '该环境适配器未接入，暂无更多操作'))));
      }

      /** 公共区：尺寸栏（跨环境共享）。预设 / 宽高 / 坐标 / 缩放；无视图环境同样渲染。 */
      function blenderFitScale(width, height) {
        return Math.min(1, (room.w || width) / width, (room.h || height) / height);
      }

      function commitBlenderSize(next) {
        if (next.width * next.height > 8 * 1024 * 1024) {
          setBlenderSizeError('分辨率总面积不能超过 8,388,608 像素');
          return;
        }
        setBlenderSizeError('');
        setBlenderSize((current) => next.width === current.width && next.height === current.height ? current : next);
      }

      function commitBlenderField(field) {
        if (blenderDraft[field] === undefined) return;
        const value = fieldLegal(field, blenderDraft[field]);
        setBlenderDraft((draft) => ({ ...draft, [field]: undefined }));
        if (value === null) return;
        if (field === 'scale') {
          setBlenderFit(false);
          setBlenderZoom(value);
        } else {
          commitBlenderSize({ ...blenderSize, [field]: value });
        }
      }

      function shellSizeBar() {
        const inputValue = (field, fallback) => blenderView ? blenderDraft[field] ?? fallback : fallback;
        const setSizeDraft = (field, value) => blenderView
          ? setBlenderDraft((draft) => ({ ...draft, [field]: value }))
          : field === 'scale' ? changeZoom(value) : changeSizeField(field, value);
        const commitSize = (field) => blenderView ? commitBlenderField(field) : commitViewField(field);
        const sizeKey = (event, field) => {
          if (!blenderView) { sizeFieldKey(event, field); return; }
          if (event.key === 'Enter') { event.preventDefault(); commitBlenderField(field); }
          if (event.key === 'Escape') {
            event.preventDefault();
            setBlenderDraft((draft) => ({ ...draft, [field]: undefined }));
          }
        };
        const displayFit = blenderView ? blenderFit : fit;
        const displayPan = !blenderView && panMode;
        const displayPercent = blenderView
          ? String(blenderFit ? Math.round(blenderFitScale(blenderSize.width, blenderSize.height) * 100) : blenderZoom)
          : fit ? String(Math.round(fitScale * 100)) : zoom;
        return sizing && h('div', { className: 'utb-size', ref: sizeBarRef },
          h('div', { className: 'utb-size-left' },
            // The active preset matches the current output dimensions exactly.
            h('div', {
              className: 'utb-seg utb-presets',
              role: 'group',
              'aria-label': blenderView ? '画质预设' : '分辨率预设',
              'data-utb-preset': '',
            },
              (blenderView ? BLENDER_PRESETS : PRESETS).map((preset) => {
                const selected = !displayPan && (blenderView ? blenderSize.width : w) === preset.w
                  && (blenderView ? blenderSize.height : ht) === preset.h;
                return h('button', {
                  key: preset.id,
                  type: 'button',
                  className: 'utb-seg-btn utb-preset',
                  title: `${preset.label} ${preset.w} × ${preset.h}`,
                  'data-utb-preset-opt': preset.id,
                  'aria-label': preset.label,
                  'aria-pressed': selected,
                  disabled: annotOn,
                  onClick: () => blenderView ? commitBlenderSize({ width: preset.w, height: preset.h }) : applySizePreset(preset),
                }, segDot(selected, 'preset'), preset.label);
              }))),
          h('span', { className: 'utb-gap' }),
          h('div', { className: 'utb-size-right' },
            !blenderView && h('span', { className: 'utb-pos-label', 'aria-hidden': true }, 'X'),
            !blenderView && h('input', {
              className: 'utb-num utb-pos',
              type: 'number',
              min: posRange[0],
              max: posRange[1],
              step: 10,
              value: posX,
              'data-utb-field': 'x',
              'aria-label': '视口 X 坐标（像素）',
              title: canvasOn
                ? '画布坐标 X（画布 CSS px，可为负）；滚轮调整（Shift ×10，Alt ×1），Enter 提交，Esc 恢复'
                : viewSync
                  ? '页面顶层滚动位置 X（文档 CSS px）；滚轮调整（Shift ×10，Alt ×1），Enter 提交，Esc 恢复'
                  : '旧宿主不支持视口坐标同步',
              disabled: !viewSync || annotOn,
              onChange: (e) => changePositionField('x', e.target.value),
              onFocus: () => { viewFocusRef.current = 'x'; },
              onBlur: () => { viewFocusRef.current = ''; commitViewField('x'); },
              onKeyDown: (e) => sizeFieldKey(e, 'x'),
            }),
            !blenderView && h('span', { className: 'utb-pos-label', 'aria-hidden': true }, 'Y'),
            !blenderView && h('input', {
              className: 'utb-num utb-pos',
              type: 'number',
              min: posRange[0],
              max: posRange[1],
              step: 10,
              value: posY,
              'data-utb-field': 'y',
              'aria-label': '视口 Y 坐标（像素）',
              title: canvasOn
                ? '画布坐标 Y（画布 CSS px，可为负）；滚轮调整（Shift ×10，Alt ×1），Enter 提交，Esc 恢复'
                : viewSync
                  ? '页面顶层滚动位置 Y（文档 CSS px）；滚轮调整（Shift ×10，Alt ×1），Enter 提交，Esc 恢复'
                  : '旧宿主不支持视口坐标同步',
              disabled: !viewSync || annotOn,
              onChange: (e) => changePositionField('y', e.target.value),
              onFocus: () => { viewFocusRef.current = 'y'; },
              onBlur: () => { viewFocusRef.current = ''; commitViewField('y'); },
              onKeyDown: (e) => sizeFieldKey(e, 'y'),
            }),
            h('input', {
              className: 'utb-num',
              type: 'number',
              min: VIEW_LIMITS.width[0],
              max: VIEW_LIMITS.width[1],
              value: inputValue('width', blenderView ? String(blenderSize.width) : width),
              'data-utb-field': 'width',
              'aria-label': '视口宽度（像素）',
              title: '视口宽度（200–4096 px）；滚轮调整（Shift ×10，Alt ×1）',
              disabled: annotOn,
              onChange: (e) => setSizeDraft('width', e.target.value),
              onFocus: () => { viewFocusRef.current = 'width'; },
              onBlur: () => { viewFocusRef.current = ''; commitSize('width'); },
              onKeyDown: (e) => sizeKey(e, 'width'),
            }),
            h('span', { 'aria-hidden': true }, '×'),
            h('input', {
              className: 'utb-num',
              type: 'number',
              min: VIEW_LIMITS.height[0],
              max: VIEW_LIMITS.height[1],
              value: inputValue('height', blenderView ? String(blenderSize.height) : height),
              'data-utb-field': 'height',
              'aria-label': '视口高度（像素）',
              title: '视口高度（200–4096 px）；滚轮调整（Shift ×10，Alt ×1）',
              disabled: annotOn,
              onChange: (e) => setSizeDraft('height', e.target.value),
              onFocus: () => { viewFocusRef.current = 'height'; },
              onBlur: () => { viewFocusRef.current = ''; commitSize('height'); },
              onKeyDown: (e) => sizeKey(e, 'height'),
            }),
            h('span', null, 'px'),
            h('div', {
              className: 'utb-seg utb-panfit',
              role: 'group',
              'aria-label': '拖拽与适应',
              'data-utb-panfit': '',
              'data-utb-panfit-state': blenderView ? (displayFit ? 'fit' : 'default') : panfitState,
            },
              !blenderView && h('button', {
                type: 'button',
                className: 'utb-seg-btn',
                'data-utb-panfit-opt': 'pan',
                'aria-label': '拖拽视口',
                title: panMode
                  ? '拖拽视口：按住画面拖动平移页面（内容跟手，X/Y 随之更新）；再点一次关闭并恢复页面交互'
                  : '拖拽视口：点击后按住画面拖动可平移页面（内容跟手，X/Y 随之更新）；关闭后恢复页面交互',
                'aria-pressed': panMode,
                disabled: !viewSync || !canvasOn || annotOn,
                onClick: pressPanMode,
              }, segDot(panMode, 'panfit'), '拖拽'),
              h('button', {
                type: 'button',
                className: 'utb-seg-btn',
                'data-utb-panfit-opt': 'fit',
                'aria-label': '适应窗口',
                title: '适应窗口仅本地显示，不改变共享比例/Agent 截图比例',
                'aria-pressed': displayFit,
                disabled: annotOn,
                onClick: blenderView ? () => setBlenderFit(true) : pressFitMode,
              }, segDot(displayFit, 'panfit'), '适应窗口'),
              h('button', {
                type: 'button',
                className: 'utb-seg-btn',
                'data-utb-panfit-opt': 'default',
                'aria-label': '默认',
                title: '默认：不拖拽、不自动适应，按共享比例显示（不发布视口）',
                'aria-pressed': !displayPan && !displayFit,
                disabled: annotOn,
                onClick: blenderView ? () => { setBlenderFit(false); setBlenderZoom(100); } : pressPanFitDefault,
              }, segDot(!displayPan && !displayFit, 'panfit'), '默认')),
            h('input', {
              className: 'utb-num utb-zoom',
              type: 'number',
              min: VIEW_LIMITS.scalePercent[0],
              max: VIEW_LIMITS.scalePercent[1],
              step: 5,
              value: inputValue('scale', displayPercent),
              'data-utb-field': 'scale',
              'aria-label': '预览缩放比例（百分比）',
              title: fit
                ? '适应窗口仅本地显示，不改变共享比例/Agent 截图比例'
                : '预览缩放比例（10–200%）；手动修改会关闭适应窗口，并作为共享比例（Agent 截图默认密度）',
              disabled: annotOn,
              onChange: (e) => setSizeDraft('scale', e.target.value),
              onFocus: () => { viewFocusRef.current = 'scale'; },
              onBlur: () => { viewFocusRef.current = ''; commitSize('scale'); },
              onKeyDown: (e) => sizeKey(e, 'scale'),
            }),
            h('span', { className: 'utb-dim', 'aria-hidden': true }, '%')))
      }
      /** 公共区：无视图环境的预览区——空白画布，标注直接画在上面。 */
      function shellBlankStage() {
        const bw = Math.max(1, Number(width) || 1024);
        const bh = Math.max(1, Number(height) || 768);
        // 视图窗必须完整落在预览区内：fit 时按 room 等比缩放（与 web 的“适应窗口”同语义）。
        const roomW = Number(room && room.w) || bw;
        const roomH = Number(room && room.h) || bh;
        const fitScale = Math.max(0.1, Math.min(1, roomW / bw, roomH / bh));
        const winScale = fit ? fitScale : scale;
        // 挂同一个 stage ref：复用已有的 ResizeObserver 量预览区尺寸，视图窗才能等比适应。
        return h('div', { className: 'utb-stage', 'data-utb-shell': 'blank', ref: stage },
          h('div', {
            className: 'utb-box',
            'data-utb-shell': 'blank-box',
            'data-fitted': winScale < 1 ? 'true' : 'false',
            'data-utb-annot': annotOn ? 'on' : 'off',
            style: { width: bw * winScale, height: bh * winScale, position: 'relative' },
          },
            annotOn
              ? shellAnnotLayer()
              : h('div', { className: 'utb-blank-hint' },
                '该环境暂无画面。点上方「标注」即可在这块空白画布上画，形状按画布坐标为所有环境共用。')));
      }

      /** 公共区：无视图环境的行集合（工具栏 / 标注栏 / 空白画布）；状态栏由根返回统一渲染。 */
      function shellNoViewRows() {
        return [
          shellBarPublic(),
          shellAnnotBar(),
          shellSizeBar(),
          shellBlankStage(),
        ];
      }
