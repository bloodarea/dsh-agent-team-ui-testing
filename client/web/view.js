      function webViewBody() {
        return [
h('div', { className: 'utb-bar' },
          button('后退', h(IconArrow, { dir: 'back' }), () => move('back'), backDisabled),
          button('前进', h(IconArrow, { dir: 'forward' }), () => move('forward'), forwardDisabled),
          button('刷新', h(IconReload, null), reload, reloadDisabled),
          h('form', { onSubmit: submit, style: { flex: '1 1 auto', minWidth: 0, display: 'flex', position: 'relative' } },
            h('div', { className: 'utb-addr-wrap' },
              h('input', { className: 'utb-addr', type: 'text', value: draft, spellCheck: false, 'aria-label': '网址', placeholder: '输入网址，例如 https://example.com', 'aria-invalid': error ? 'true' : undefined, 'data-invalid': error ? 'true' : 'false', title: error || undefined, disabled: annotOn, onChange: changeAddress, onFocus: () => { focusedRef.current = true; dirtyRef.current = false; }, onBlur: blurAddress, onKeyDown: keyAddress }),
              h('button', {
                type: 'button',
                className: 'utb-addr-audio',
                'aria-label': audioState.enabled ? '关闭页面声音' : '打开页面声音',
                'aria-pressed': audioState.enabled,
                title: audioState.enabled
                  ? (audioState.live ? '页面声音：开（正在播放）' : '页面声音：开（页面当前没有声音）')
                  : '页面声音：静音（点一下开启；浏览器要求由这次点击来允许播放）',
                'data-utb-audio': audioState.enabled ? 'on' : 'off',
                'data-utb-audio-live': audioState.live ? 'live' : 'idle',
                // 保住地址栏的输入焦点与草稿，和「转到」按钮同一处理。
                onMouseDown: (event) => event.preventDefault(),
                onClick: toggleAudio,
              }, h(IconSound, { muted: !audioState.enabled })),
              h('button', {
                type: 'button',
                className: 'utb-addr-hist',
                'aria-label': '最近访问的网址',
                'aria-haspopup': 'menu',
                'aria-expanded': historyOpen,
                title: addressHistory.length
                  ? '最近访问（最多 7 条，最近的在上面）'
                  : '还没有访问记录：先在地址栏打开一个网址',
                'data-utb-history-toggle': historyOpen ? 'open' : 'closed',
                'data-utb-history-count': String(addressHistory.length),
                disabled: annotOn,
                onMouseDown: (event) => event.preventDefault(), // keep the address caret/draft untouched
                onClick: () => setHistoryOpen((value) => !value),
              }, h(IconHistory, null)),
              historyOpen && h('div', {
                className: 'utb-pop utb-addr-pop',
                role: 'menu',
                'aria-label': '最近访问的网址',
                'data-utb-history-list': 'true',
                'data-utb-history-size': String(addressHistory.length),
              },
                h('div', { className: 'utb-addr-pop-head' }, '最近访问（' + addressHistory.length + '/' + ADDRESS_HISTORY_LIMIT + '）'),
                addressHistory.length
                  ? addressHistory.map((url, index) => h('button', {
                    key: url,
                    type: 'button',
                    className: 'utb-menu-item utb-addr-item',
                    role: 'menuitem',
                    title: url,
                    'data-utb-history-item': String(index),
                    'data-utb-history-url': url,
                    onClick: () => chooseHistory(url),
                  }, h('span', { className: 'utb-addr-label' }, addressHistoryLabel(url))))
                  : h('div', { className: 'utb-addr-pop-empty' }, '还没有访问记录')))),
          button('转到', h(IconGo, null), () => submit(undefined), annotOn || busy, {
            'data-utb-go': annotOn || busy ? 'disabled' : 'ready',
            title: '转到地址栏里的网址（等同回车）',
            // Keep the address field focused: a blur would cancel the draft (the input would snap
            // back to the accepted address) before this click could submit what the user typed.
            onMouseDown: (event) => event.preventDefault(),
          }),
          tabsSupported && button('标签页', h('span', { className: 'utb-tabs-glyph', 'aria-hidden': true }, '▤'), () => setTabsVisible((value) => !value), false, {
            'aria-pressed': tabsVisible,
            'data-utb-tabs-toggle': tabsVisible ? 'on' : 'off',
            title: tabsVisible ? '隐藏标签页（页面保持）' : '显示标签页',
          }),
          button('标注', h(IconAnnot, null), toggleAnnotMode, !annotReady || sizing || pickOn, {
            ref: annotButtonRef,
            title: pickOn
              ? '选择元素模式下不可进入标注（先退出选元素）'
              : sizing
                ? '尺寸调整模式下不可进入标注（先关闭尺寸调整）'
                : '标注（标注按工作区保留，导航/刷新会清除当前页面标注）',
            'aria-pressed': annotOn,
            'aria-controls': annotPanelId,
            'data-utb-annot-entry': annotOn ? 'on' : pickOn ? 'pick' : sizing ? 'sizing' : annotReady ? 'ready' : 'unsupported',
            // Closing the mode via this button must cancel an active text edit *before* the
            // focus change blurs the editor (otherwise the blur would submit it).
            onPointerDown: () => {
              if (!annotRef.current.on || !annotEditRef.current.active) return;
              annotEditRef.current.cancel = true;
              annotEditRef.current.active = false;
              setAnnotText(null);
            },
          }),
          button('尺寸调整', h(IconSize, null), toggleSizing, annotOn || pickOn, {
            'aria-pressed': sizing,
            title: pickOn ? '选择元素模式下不可调整尺寸（先退出选元素）' : '尺寸调整',
            'data-utb-size-entry': sizing ? 'on' : pickOn ? 'pick' : 'ready',
          }),
          h('span', { className: 'utb-sr', role: 'alert' }, error || ''),
          button('选择元素发送到聊天框', h(IconInspect, null), togglePickMode, pickEntryDisabled, {
            ref: pickButtonRef,
            title: pickEntryTitle,
            'aria-pressed': pickOn,
            'data-utb-pick-entry': pickEntryState,
          }),
          h('div', { className: 'utb-more' },
            button('更多', h(IconMore, null), () => setMenu((v) => !v), annotOn, { 'aria-expanded': menu, 'aria-haspopup': 'menu' }),
            menu && h('div', { className: 'utb-pop', role: 'menu' },
              h('button', {
                type: 'button',
                className: 'utb-menu-item',
                role: 'menuitem',
                disabled: !devtoolsInfo.enabled,
                title: devtoolsInfo.title,
                'data-utb-devtools': devtoolsInfo.enabled ? 'ready' : 'disabled',
                onClick: openDevtools,
              }, '打开调试工具'),
              openUrl
                ? h('a', { className: 'utb-menu-item', role: 'menuitem', href: openUrl, target: '_blank', rel: 'noopener noreferrer', style: { textDecoration: 'none' }, onClick: () => setMenu(false) }, '在默认浏览器中打开')
                : h('button', { type: 'button', className: 'utb-menu-item', role: 'menuitem', disabled: true }, '在默认浏览器中打开')))),
        // 提示横条常驻（用户 2026-11-19 要求）：容器与背景始终存在，占位高度固定，
        // 只有**文字**会按计时自行消失。以前的 `tabNotice && ...` 让整条横条一起消失，
        // 视图的高度随之跳动；现在横条是稳定的一行，内容为空时保留空行与分隔线。
        h('div', {
          className: 'utb-sync-note utb-tab-note',
          role: 'status',
          'aria-live': 'polite',
          'data-utb-tab-notice': 'true',
          'data-utb-tab-notice-state': tabNotice ? 'text' : 'empty',
        }, h('span', { className: 'utb-tab-note-text' }, tabNotice || '')),
        selectPop && selectPop.reason && h('div', {
          className: 'utb-sync-note utb-select-note',
          role: 'status',
          'aria-live': 'polite',
          'data-utb-select-unsupported': selectPop.reason,
        }, '该下拉不支持浮层，请用键盘 ↑↓ + Enter'),
        activeBusy && h('div', { className: 'utb-sync-note utb-agent-note', role: 'status', 'aria-live': 'polite', 'data-utb-agent-busy': 'true' }, 'Agent 正在操作此标签；预览继续，输入暂不可用'),
        latestPopupNotice && h('div', {
          className: 'utb-sync-note utb-popup-note',
          role: 'status',
          'aria-live': 'polite',
          'data-utb-popup-notice': String(latestPopupNotice.reason || ''),
          'data-utb-popup-notice-id': String(latestPopupNotice.id || ''),
        }, h('span', null, '已阻止新页面：' + (POPUP_REASON_TEXT[latestPopupNotice.reason] || '来源或目标不允许'))),
        // Local popup-blocked fallback: aria-live text + a real link that loads the same front end.
        // No automatic retry, no Runtime lastError, no claim that DevTools connected.
        devtoolsNotice && h('div', { className: 'utb-devtools-note', role: 'status', 'aria-live': 'polite' },
          h('span', null, devtoolsNotice.message),
          devtoolsNotice.url && h('a', {
            href: devtoolsNotice.url,
            target: '_blank',
            rel: 'noopener noreferrer',
            onClick: () => setDevtoolsNotice(null),
          }, '在新标签页打开调试工具')),
        syncNotice && h('div', {
          className: 'utb-sync-note',
          role: 'status',
          'aria-live': 'polite',
          'data-utb-sync-state': syncNotice.kind,
          'data-utb-sync-reason': String(syncNotice.reason || ''),
        },
          h('span', null, syncNotice.text),
          syncNotice.retry && h('button', {
            type: 'button',
            className: 'utb-sync-retry',
            title: '重新请求画面同步',
            onClick: retrySync,
          }, '重试同步')),
        shellAnnotBar(),
        shellSizeBar(),
        (pickOn || pickStatus) && h('div', {
          className: 'utb-sync-note utb-pick-note',
          role: 'status',
          'aria-live': 'polite',
          'data-utb-pick-status': pickStatus ? pickStatus.kind : 'mode',
        }, pickStatus ? pickStatus.text : '选元素模式：点击画面中的元素加入聊天框 · 滚轮可滚动页面 · Esc 退出'),
        // The whole preview area swallows the host context menu (page clicks only); see
        // onFrameContextMenu. Outside this element the host menu keeps its normal behaviour.
        h('div', { className: 'utb-stage', ref: setWebStage, onContextMenu: onFrameContextMenu },
          activeUrl
            ? (shot
              ? h('div', {
                className: 'utb-box',
                ref: frameBoxRef,
                'data-fitted': fit && scale < 1 ? 'true' : 'false',
                'data-utb-annot': annotOn ? 'on' : 'off',
                // Stable read-only hooks for layout/state assertions when the size bar is closed
                // (the annotation mode and the size bar are mutually exclusive, user 2026-11-03).
                'data-utb-fit': fit ? 'true' : 'false',
                'data-utb-pan-state': panMode ? 'on' : 'off',
                'data-utb-canvas': canvasOn ? 'on' : 'off',
                'data-utb-canvas-ready': canvasOn ? (canvasInputReady ? 'true' : 'false') : 'off',
                'data-utb-canvas-blank': canvasOn ? 'checkerboard' : 'off',
                'data-utb-canvas-zoom': panMode && canvasOn ? 'wheel' : 'off',
                'data-utb-canvas-zoom-anchor': panMode && canvasOn ? zoomAnchor : 'off',
                'data-utb-canvas-zoom-anchor-state': panMode && canvasOn ? zoomAnchorState : 'off',
                'data-utb-view-revision': viewRef.current ? String(Number(viewRef.current.revision)) : '',
                'data-utb-canvas-checker': canvasOn
                  ? `${CANVAS_CHECKER.size}px ${CANVAS_CHECKER.dark} ${CANVAS_CHECKER.light}`
                  : 'off',
                onPointerDown: onBoxPointerDown,
                // Diagnostic reason for the fail-closed barrier (never a page fact).
                'data-utb-canvas-barrier': canvasOn ? String(canvasBarrierState.reason || '') : 'off',
                // Bounded diagnostic numbers for acceptance failures (safe, no page content).
                'data-utb-canvas-detail': canvasOn ? JSON.stringify({
                  reason: canvasBarrierState.reason,
                  frameScrollX: frameGeom ? finiteOrNull(frameGeom.scrollX) : null,
                  frameScrollY: frameGeom ? finiteOrNull(frameGeom.scrollY) : null,
                  sX: observedScroll().x,
                  sY: observedScroll().y,
                  pageW: frameGeom ? frameGeom.pageWidth : null,
                  pageH: frameGeom ? frameGeom.pageHeight : null,
                  naturalW: frameGeom ? frameGeom.naturalW : null,
                  naturalH: frameGeom ? frameGeom.naturalH : null,
                  frameAgeMs: frameGeom && frameGeom.at ? Date.now() - frameGeom.at : null,
                  viewW: w,
                  viewH: ht,
                  seed: Boolean(frameGeom && frameGeom.seed),
                  seedRev: frameGeom ? frameGeom.seedViewRevision : null,
                  viewRev: viewRef.current ? Number(viewRef.current.revision) : null,
                }) : 'off',
                style: {
                  width: w * scale,
                  height: ht * scale,
                  position: 'relative',
                  // Blank paint comes from the CSS checkerboard rule above; with O=0 the frame
                  // covers the box and the old pixels stay identical.
                },
              },
                // Pan-only transparent layer UNDER the frame: it makes the composited blank
                // draggable even when the frame is translated entirely out of the clipping box.
                // Content keeps hitting the <img> (z-index 1) so frame wheel and normal hit-testing
                // are unchanged; the layer exists only while 拖拽 is checked.
                panMode && canvasOn ? h('div', {
                  className: 'utb-pan-layer',
                  'data-utb-pan-layer': 'true',
                  'aria-hidden': true,
                  style: {
                    position: 'absolute', inset: 0, zIndex: 0,
                    cursor: panDragging ? 'grabbing' : 'grab',
                    touchAction: 'none', userSelect: 'none',
                  },
                  onPointerDown: onFramePointerDown,
                  onPointerMove: onFramePointerMove,
                  onPointerUp: onFramePointerUp,
                  onPointerCancel: releaseFrameDrag,
                  onLostPointerCapture: releaseFrameDrag,
                }) : null,
                h('img', {
                  className: 'utb-frame',
                  ref: frameImgRef,
                  src: shot,
                  alt: '内嵌浏览器画面',
                  onLoad: onFrameLoad,
                  tabIndex: 0,
                  draggable: false,
                  'data-utb-pan': panMode ? 'on' : 'off',
                  'data-utb-pan-drag': panDragging ? 'true' : 'false',
                  'data-utb-canvas-seed-clip': seedClip || 'off',
                  style: {
                    display: 'block', width: '100%', height: '100%', objectFit: 'contain', objectPosition: '50% 50%',
                    userSelect: 'none', touchAction: 'none',
                    position: 'relative', zIndex: 1,
                    cursor: pickOn ? 'crosshair' : panMode ? (panDragging ? 'grabbing' : 'grab') : frameCursor,
                    transform: frameShift ? `translate(${frameShiftX}px, ${frameShiftY}px)` : 'none',
                    clipPath: seedClip || undefined,
                  },
                  onPointerDown: onFramePointerDown,
                  onPointerUp: onFramePointerUp,
                  onPointerMove: onFramePointerMove,
                  onPointerCancel: releaseFrameDrag,
                  onLostPointerCapture: releaseFrameDrag,
                  onPointerLeave: () => {
                    if (pickRef.current.on) pickClearOverlay();
                    resetFrameCursor();
                  },
                  onKeyDown: (event) => {
                    if (annotRef.current.on) return; // annotation mode: zero page input
                    if (pickRef.current.on) return; // pick mode: zero page keyboard input
                    if (event.isComposing) return; // IME 组合中：别抢字符
                    if (event.key === 'Escape' && selectPopRef.current?.reason) selectPopClose();
                    const commandKey = event.ctrlKey === true || event.metaKey === true;
                    const keyName = String(event.key || '').toLowerCase();
                    if (commandKey && event.altKey !== true && (keyName === 'c' || keyName === 'x')) {
                      // 复制/剪切：页面照常处理，同时把选区文本写进系统剪贴板（读要在转发前，剪切会删掉选区）。
                      event.preventDefault();
                      const events = panelKeyEvents(event);
                      sendEvents(async ({ scope, signal }) => {
                        const text = await pageSelectionText(signal, scope);
                        if (text) await clipboardWriteText(text);
                        return events;
                      });
                      return;
                    }
                    if (commandKey && event.altKey !== true && keyName === 'v') {
                      // 粘贴：系统剪贴板可读就由我们插入文本，避免浏览器内部剪贴板插入旧内容。
                      event.preventDefault();
                      const events = panelKeyEvents(event);
                      const textRead = clipboardReadText();
                      sendEvents(async () => {
                        const text = await textRead;
                        if (text === null) return events;
                        return text === '' ? [] : [{ kind: 'text', text }];
                      });
                      return;
                    }
                    const events = panelKeyEvents(event);
                    if (!events.length) return;
                    event.preventDefault();
                    // 记下"还按着"的键：真实 keyup 由 onKeyUp 转发，焦点离开时由 onBlur 兜底松开。
                    const identity = event.code || event.key;
                    if (identity && !event.repeat) {
                      panelHeldKeysRef.current.set(identity, {
                        key: String(event.key || ''),
                        code: event.code || undefined,
                        virtualKeyCode: Number.isFinite(event.keyCode) && event.keyCode > 0 ? event.keyCode : undefined,
                      });
                    }
                    sendEvents(events);
                  },
                  // 松开：只转发 keyUp。少这一条时页面永远看不到"按住"，按住 W+A 斜向移动这类
                  // 连续输入全部失效（用户实测）。
                  onKeyUp: (event) => {
                    if (annotRef.current.on) return;
                    if (pickRef.current.on) return;
                    if (event.isComposing) return;
                    const identity = event.code || event.key;
                    if (identity) panelHeldKeysRef.current.delete(identity);
                    const events = panelKeyReleaseEvents(event);
                    if (!events.length) return;
                    event.preventDefault();
                    sendEvents(events);
                  },
                  onBlur: () => { releasePanelKeys(); },
                }),
                // 原生 <select> 的面板侧浮层：绝对定位在画面框内、点击点附近。
                // 浏览器自己的弹层在 UI 图层（帧里看不到），所以选项列表由面板绘制；
                // 写回走 POST /select（与 /input 同一套门禁）。
                selectPop && !selectPop.reason ? (() => {
                  const rowCount = (selectPop.select.options || []).length;
                  const layout = selectPopLayout(selectPop.anchor, rowCount, selectPop.bounds);
                  return h('div', {
                    className: 'utb-select-pop',
                    ref: (node) => {
                      selectPopElementRef.current = node;
                      if (node && node.dataset.utbSelectFocused !== '1') {
                        node.dataset.utbSelectFocused = '1';
                        try { node.focus({ preventScroll: true }); } catch { /* focus 是 best-effort */ }
                      }
                    },
                    role: 'listbox',
                    tabIndex: -1,
                    'aria-label': '下拉选项',
                    'data-utb-select-pop': selectPop.reason || 'ready',
                    'data-utb-select-reason': selectPop.reason || '',
                    'data-utb-select-side': layout.side,
                    'data-utb-select-layout': JSON.stringify({
                      left: layout.left, top: layout.top, width: layout.width,
                      maxHeight: layout.maxHeight, flippedUp: layout.flippedUp, shiftedLeft: layout.shiftedLeft,
                    }),
                    style: {
                      position: 'absolute',
                      left: layout.left,
                      top: layout.top,
                      width: layout.width,
                      maxHeight: layout.maxHeight,
                      zIndex: 6,
                    },
                    onKeyDown: onSelectPopKeyDown,
                  }, (selectPop.select.options || []).map((option, index) => h('div', {
                        key: `${index}:${option.value}`,
                        className: 'utb-select-pop-item',
                        role: 'option',
                        'aria-selected': index === selectPop.activeIndex ? 'true' : 'false',
                        'aria-disabled': option.disabled ? 'true' : 'false',
                        'data-utb-select-item': option.disabled ? 'disabled'
                          : (index === selectPop.activeIndex ? 'active' : 'ready'),
                        'data-utb-select-value': option.value,
                        title: option.label || option.value,
                        // 浮层内的按下不许穿透成页面鼠标事件（否则又是一次 select 点击）。
                        onPointerDown: (event) => { event.preventDefault(); event.stopPropagation(); },
                        onPointerEnter: () => {
                          if (option.disabled) return;
                          setSelectPop((current) => (current && current.seq === selectPop.seq
                            ? Object.assign({}, current, { activeIndex: index })
                            : current));
                        },
                        onClick: () => selectPopChoose(option),
                      }, option.label || option.value || '（空值）')));
                })() : null,
                pageContext ? (() => {
                  const layout = selectPopLayout(pageContext.anchor, pageContext.items.length, pageContext.bounds);
                  return h('div', {
                    className: 'utb-select-pop utb-context-menu',
                    'data-utb-context-menu': 'default',
                    role: 'menu', tabIndex: -1, 'aria-label': '页面右键菜单',
                    'aria-activedescendant': `utb-context-item-${pageContext.seq}-${pageContext.activeIndex}`,
                    ref: node => {
                      pageContextElementRef.current = node;
                      if (node && node.dataset.utbFocused !== '1') {
                        node.dataset.utbFocused = '1';
                        node.focus({ preventScroll: true });
                      }
                    },
                    style: { position: 'absolute', left: layout.left, top: layout.top, width: layout.width, maxHeight: layout.maxHeight, zIndex: 7 },
                    onPointerDown: event => { event.preventDefault(); event.stopPropagation(); },
                    onKeyDown: onPageContextKeyDown,
                  }, pageContext.items.map((item, index) => h('button', {
                    key: item.id, id: `utb-context-item-${pageContext.seq}-${index}`,
                    className: 'utb-select-pop-item', type: 'button', role: 'menuitem', tabIndex: -1,
                    disabled: item.disabled === true, 'aria-disabled': item.disabled ? 'true' : 'false',
                    'data-utb-context-action': item.id,
                    'data-utb-select-item': item.disabled ? 'disabled' : index === pageContext.activeIndex ? 'active' : 'ready',
                    style: { border: 0, textAlign: 'left' },
                    onPointerEnter: () => { if (!item.disabled) setPageContext(current => current ? { ...current, activeIndex: index } : current); },
                    onClick: () => choosePageContext(item),
                  }, item.label)));
                })() : null,
                // P0-D annotation layer: covers the untranslated painted rect, viewBox = accepted
                // canvas window. Committed shapes are React nodes; the live draft is one imperative
                // <g> updated by rAF (never re-rendered per pointer move).
                shellAnnotLayer(),
                shellAnnotTextInput(),
                // 选元素悬浮框：纯面板 DOM，pointer-events:none，被 .utb-box 裁剪，不进 Host 截图。
                pickOn ? h('div', {
                  className: 'utb-pick-layer',
                  'data-utb-pick-layer': 'true',
                  'data-utb-pick-state': pickOverlay ? 'hover' : 'idle',
                  'aria-hidden': 'true',
                },
                  pickScreenNow && pickOverlay ? h('div', {
                    className: 'utb-pick-outline',
                    'data-utb-pick-outline': 'true',
                    'data-utb-pick-selector': pickOverlay.selector || '',
                    'data-utb-pick-rect': JSON.stringify(pickOverlay.rect),
                    style: {
                      left: pickScreenNow.left,
                      top: pickScreenNow.top,
                      width: pickScreenNow.width,
                      height: pickScreenNow.height,
                    },
                  }) : null,
                  pickTagNow && pickOverlay ? h('span', {
                    className: 'utb-pick-tag',
                    'data-utb-pick-tag': pickOverlay.label,
                    title: pickOverlay.selector || pickOverlay.label,
                    style: { left: pickTagNow.left, top: pickTagNow.top },
                  }, pickOverlay.label) : null) : null)
              : h('div', { className: 'utb-empty' },
                h('strong', null, '正在启动内嵌浏览器'),
                '首次打开需要启动无头 Chromium，通常一两秒；完成后这里会显示实时画面。'))
            : h('div', { className: 'utb-empty' },
              h('strong', null, '预览网页'),
              error
                ? h('span', { role: 'alert', className: 'utb-empty-error' }, error)
                : '在上方输入 HTTP 或 HTTPS 网址。页面由内嵌的无头浏览器渲染，不会抢占桌面焦点；尺寸模式可模拟 393 × 852 等移动视口。')),
        ];
      }
      const envOption = ENVIRONMENTS.find((item) => item.id === env) || { id: env, label: env, short: env };
      const envViewTitle = (envOption.short || envOption.label || env) + ' · 调试视图';
      const envViewSupported = hasEnvironmentView(env);

      /**
       * 空态与"没有视图"的占位。
       *
       * - 默认视图（`env === 'default'`）是**正常状态**，不是缺陷：没有目标环境时面板落在这里，
       *   公共视图组件（尺寸栏 / 标注栏 / 状态栏）照常可用。
       * - 其他环境走到这里只剩"宿主登记了、视图层还没接"这一种情况，措辞不当成异常。
       */
      function noEnvView() {
        if (env === 'default') {
          return h('div', { className: 'utb-noview', 'data-utb-noview': 'default', 'data-utb-default-view': 'true' },
            h('span', { className: 'utb-noview-icon', 'aria-hidden': true },
              h('svg', { viewBox: '0 0 24 24', width: 28, height: 28, fill: 'none', stroke: 'currentColor', strokeWidth: 1.6, strokeLinecap: 'round', strokeLinejoin: 'round' },
                h('rect', { x: 3.5, y: 5, width: 17, height: 14, rx: 2.5 }),
                h('path', { d: 'M3.5 10h17' }),
                h('circle', { cx: 6.6, cy: 7.5, r: .8, fill: 'currentColor', stroke: 'none' }))),
            h('div', { className: 'utb-noview-text' },
              h('strong', null, '默认视图'),
              h('p', null, '当前没有选择目标环境，这里是公共视图组件的空态画布。'),
              h('p', { className: 'utb-noview-hint' }, '在右上角的组合框里选一个已启用的目标环境即可开始调试。'),
              h('p', { className: 'utb-noview-hint' }, '新会话、以及还没有存过选择的会话会落在这里；选择会按会话保存。')));
        }
        return h('div', { className: 'utb-noview', 'data-utb-noview': env },
          h('span', { className: 'utb-noview-icon', 'aria-hidden': true },
            h('svg', { viewBox: '0 0 24 24', width: 28, height: 28, fill: 'none', stroke: 'currentColor', strokeWidth: 1.6, strokeLinecap: 'round', strokeLinejoin: 'round' },
              h('circle', { cx: 12, cy: 12, r: 9 }),
              h('path', { d: 'M9.6 9.4a2.5 2.5 0 1 1 3.5 2.3c-.6.3-1 .8-1 1.5v.4' }),
              h('circle', { cx: 12, cy: 17, r: .95, fill: 'currentColor', stroke: 'none' }))),
          h('div', { className: 'utb-noview-text' },
            h('strong', null, '视图层暂不支持'),
            h('p', null, (envOption.label || env) + ' 的调试视图还没有实现（适配器未接入）。'),
            h('p', { className: 'utb-noview-hint' }, '可以在设置页查看该环境的适配器与依赖状态，或换成默认视图。')));
      }

      /* =====================================================================================
       * 公共区（跨环境共享）：标注栏与状态栏。任何目标环境都能直接调用这两个组件；
       * 它们不含 web 专有语义，放置位置由各环境视图自己决定（web 仍放在原位置）。
       * ===================================================================================== */
      /** 公共区：标注栏。仅在标注模式开启时出现；工具集、颜色、粗细、清除为跨环境通用能力。 */
