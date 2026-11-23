      /**
       * A wheel notch is a fire-and-forget adjustment, not a draft: once the request settled (in
       * either direction) the field must follow the Host again. A typed draft keeps its flag until
       * the user commits or cancels it.
       */
      function clearSettledWheelDrafts(submitted) {
        for (const field of Object.keys(submitted)) {
          const wheelVersion = viewWheelRef.current[field];
          if (wheelVersion && viewEditRef.current[field] === wheelVersion) {
            viewDirtyRef.current[field] = null;
          }
        }
      }

      function logViewReject(code) {
        console.warn('ui-testing: viewport patch rejected (' + code + ')');
      }

      function noteViewEdit(field, draftValue) {
        viewEditRef.current[field] += 1;
        viewWheelRef.current[field] = 0;
        viewDirtyRef.current[field] = Number.isFinite(Number(draftValue)) && String(draftValue).trim() !== ''
          ? Number(draftValue)
          : NaN;
      }

      /** Numeric value of one field as the Host last accepted it (null when unknown). */
      function hostFieldValue(field) {
        const view = viewRef.current;
        if (!view) return null;
        if (field === 'scale') return Number(view.scale) * 100;
        if (field === 'width') return Number(view.width);
        if (field === 'height') return Number(view.height);
        const canvas = canvasPosition();
        if (field === 'x') return canvas ? canvas.x : observedScroll().x;
        if (field === 'y') return canvas ? canvas.y : observedScroll().y;
        return null;
      }

      /** Legal draft → number, otherwise null (nothing is sent for an illegal intermediate state). */
      function fieldLegal(field, text) {
        const raw = String(text === undefined || text === null ? '' : text).trim();
        if (!raw) return null;
        const number = Number(raw);
        if (!Number.isFinite(number)) return null;
        if (field === 'width' || field === 'height') {
          const range = VIEW_LIMITS[field];
          if (!Number.isInteger(number) || number < range[0] || number > range[1]) return null;
          return number;
        }
        if (field === 'x' || field === 'y') {
          // Canvas coordinates are signed; the legacy fallback keeps the non-negative scroll range.
          const range = canvasActive() ? VIEW_LIMITS.canvas : VIEW_LIMITS.scroll;
          if (number < range[0] || number > range[1]) return null;
          return Math.round(number * 100) / 100;
        }
        if (field === 'scale') {
          const range = VIEW_LIMITS.scalePercent;
          if (number < range[0] || number > range[1]) return null;
          return Math.round(number);
        }
        return null;
      }

      function patchForField(field, numeric) {
        if (field === 'scale') return { scale: Math.round(numeric) / 100 };
        const patch = {};
        patch[field] = numeric;
        return patch;
      }

      function pushField(field, numeric) {
        // An old Host (no shared view) has no scale/x/y field: its ratio stays a local preference,
        // so only width/height are ever written through the legacy `{width,height}` body.
        if (!viewRef.current && field !== 'width' && field !== 'height') return;
        // A size-bar scale edit supersedes a pan-wheel zoom accumulator.
        if (field === 'scale') { clearZoomIntent(); resetZoomAnchor(); }
        if (field === 'width' || field === 'height') pendingGeomRef.current = { since: Date.now() };
        queueViewPatch(patchForField(field, numeric));
      }

      function changeSizeField(field, value) {
        if (field === 'width') setWidth(value); else setHeight(value);
        const numeric = fieldLegal(field, value);
        noteViewEdit(field, numeric === null ? value : numeric);
        if (numeric !== null) pushField(field, numeric);
      }

      function changePositionField(field, value) {
        if (field === 'x') setPosX(value); else setPosY(value);
        const numeric = fieldLegal(field, value);
        noteViewEdit(field, numeric === null ? value : numeric);
      }

      function changeScaleField(value) {
        fitRef.current = false;
        setFit(false);
        setZoom(value);
        const numeric = fieldLegal('scale', value);
        noteViewEdit('scale', numeric === null ? value : numeric);
        if (numeric !== null) pushField('scale', numeric);
      }

      /** Enter/blur: commit a legal draft; an illegal draft reverts to the accepted Host fact. */
      function commitViewField(field) {
        if (field === 'scale' && fitRef.current) {
          // The input currently displays the *local* fit percentage: there is no manual draft to
          // commit, so focusing and leaving it must not cancel fit or publish a ratio.
          viewDirtyRef.current.scale = null;
          viewFocusRef.current = '';
          return;
        }
        const text = field === 'x' ? posX
          : field === 'y' ? posY
            : field === 'width' ? width
              : field === 'height' ? height
                : zoom;
        const numeric = fieldLegal(field, text);
        if (numeric === null) {
          cancelViewField(field);
          return;
        }
        const hostValue = hostFieldValue(field);
        const base = hostValue === null ? numeric : hostValue;
        const unchanged = Math.abs(numeric - base) < 0.0001;
        if (field === 'scale') {
          fitRef.current = false;
          setFit(false);
        }
        viewDirtyRef.current[field] = null;
        viewFocusRef.current = '';
        if (!unchanged) pushField(field, numeric);
        syncViewDrafts();
      }

      function cancelViewField(field) {
        viewDirtyRef.current[field] = null;
        viewFocusRef.current = '';
        syncViewDrafts();
      }

      function sizeFieldKey(event, field) {
        if (event.key === 'Enter') {
          event.preventDefault();
          commitViewField(field);
          return;
        }
        if (event.key === 'Escape') {
          event.preventDefault();
          cancelViewField(field);
        }
      }

      /** One size-bar wheel notch: bounded step, clamp, then the same debounced patch path. */
      function stepViewField(field, direction, event) {
        const steps = WHEEL_STEPS[field];
        if (!steps) return;
        if ((field === 'x' || field === 'y') && !viewRef.current) return;
        const alt = Boolean(event && event.altKey);
        const shift = Boolean(event && event.shiftKey) && !alt;
        const step = alt ? steps.alt : shift ? steps.shift : steps.normal;
        if (blenderView) {
          if (field === 'scale') {
            const base = blenderFit ? Math.round(blenderFitScale(blenderSize.width, blenderSize.height) * 100) : blenderZoom;
            setBlenderFit(false);
            setBlenderZoom(clampNumber(base + direction * step, ...VIEW_LIMITS.scalePercent));
          } else if (field === 'width' || field === 'height') {
            commitBlenderSize({ ...blenderSize, [field]: clampNumber(blenderSize[field] + direction * step, ...VIEW_LIMITS[field]) });
          }
          return;
        }
        let base;
        if (field === 'scale' && fitRef.current) {
          base = Math.round(fitScaleValue() * 100);
        } else {
          const text = field === 'x' ? posX
            : field === 'y' ? posY
              : field === 'width' ? width
                : field === 'height' ? height
                  : zoom;
          const legal = fieldLegal(field, text);
          if (legal !== null) base = legal;
          else {
            const hostValue = hostFieldValue(field);
            base = hostValue === null ? Number(text) || 0 : hostValue;
          }
        }
        const range = field === 'scale' ? VIEW_LIMITS.scalePercent
          : field === 'width' ? VIEW_LIMITS.width
            : field === 'height' ? VIEW_LIMITS.height
              : (canvasActive() ? VIEW_LIMITS.canvas : VIEW_LIMITS.scroll);
        const next = clampNumber(base + direction * step, range[0], range[1]);
        const rounded = field === 'scale' ? Math.round(next) : Math.round(next * 100) / 100;
        if (field === 'x') setPosX(String(rounded));
        else if (field === 'y') setPosY(String(rounded));
        else if (field === 'width') setWidth(String(rounded));
        else if (field === 'height') setHeight(String(rounded));
        else {
          fitRef.current = false;
          setFit(false);
          setZoom(String(rounded));
        }
        noteViewEdit(field, rounded);
        viewWheelRef.current[field] = viewEditRef.current[field];
        pushField(field, rounded);
      }

      function onSizeWheel(event) {
        if (annotRef.current.on) {
          event.preventDefault();
          event.stopPropagation();
          return;
        }
        const node = event.target && event.target.closest ? event.target.closest('[data-utb-field]') : null;
        if (!node) return;
        const field = node.getAttribute('data-utb-field');
        if (!WHEEL_STEPS[field]) return;
        if (event.ctrlKey || event.metaKey) {
          // Ctrl/Meta+wheel never edits a size field. It is still consumed here: letting the
          // browser default run would step a focused `input[type=number]` natively (a second,
          // unsynchronised write path). Browser zoom stays available everywhere else in the panel.
          event.preventDefault();
          event.stopPropagation();
          return;
        }
        event.preventDefault();
        event.stopPropagation();
        if (!event.deltaY) return;
        markHuman();
        stepViewField(field, event.deltaY < 0 ? 1 : -1, event);
      }

      /** 用户 2026-11-03 第 5 条：粗细输入滚轮（非 passive，clamp 1–20，即时提交，不 markHuman）。 */
      function onAnnotWidthWheel(event) {
        if (!annotRef.current.on) return;
        const node = event.target && event.target.closest ? event.target.closest('[data-utb-annot-field="width"]') : null;
        if (!node) return; // let the narrow bar scroll normally elsewhere
        event.preventDefault();
        event.stopPropagation();
        if (event.ctrlKey || event.metaKey) return;
        if (!event.deltaY) return;
        const current = annotRef.current;
        if (current.tool === 'text' || current.tool === 'eraser') return;
        const alt = Boolean(event.altKey);
        const shift = Boolean(event.shiftKey) && !alt;
        const step = alt ? 1 : shift ? 5 : 1;
        const base = Number(current.width);
        const next = clampNumber(Math.round(base + (event.deltaY < 0 ? step : -step)), 1, 20);
        if (next === base) return;
        changeAnnotStyle({ width: next });
      }

      /**
       * Current painted rect of the displayed frame (contract §5.1); null disables input.
       * The measurement uses the *box* (never the transformed <img>): under canvas compositing the
       * image is translated inside the clipping box, and pointer mapping stays in viewport space.
       */
      function frameGeometry() {
        const img = frameImgRef.current;
        const box = frameBoxRef.current;
        if (!img || !box) return null;
        return paintedRect(box.getBoundingClientRect(), img.naturalWidth, img.naturalHeight);
      }

      /** Is the displayed frame provably the accepted viewport? */
      function geometryMatches(size) {
        const frame = frameGeomRef.current;
        if (!frame || !(frame.naturalW > 0) || !(frame.naturalH > 0)) return false;
        const pageWidth = Number(frame.pageWidth);
        const pageHeight = Number(frame.pageHeight);
        if (Number.isFinite(pageWidth) && pageWidth > 0 && Number.isFinite(pageHeight) && pageHeight > 0) {
          return Math.abs(pageWidth - size.w) <= 1 && Math.abs(pageHeight - size.h) <= 1;
        }
        return Math.abs(frame.naturalW / frame.naturalH - size.w / size.h) <= 0.02;
      }

      /**
       * Pause pointer/wheel input after a width/height change while the displayed frame cannot be
       * proven to match the accepted viewport. Best-effort and bounded (≤250ms); the frame protocol
       * is not extended, so this is a barrier, not a guarantee.
       */
      function inputGeomReady() {
        const pending = pendingGeomRef.current;
        if (!pending) return true;
        if (!geometryMatches(acceptedViewSize())) {
          if (Date.now() - pending.since >= GEOMETRY_WAIT_MS) {
            pendingGeomRef.current = null;
            return true;
          }
          return false;
        }
        pendingGeomRef.current = null;
        return true;
      }

      /** Event → target page CSS point in the accepted viewport (half-open painted rect). */
      function frameInputReady() {
        return readyRef.current && !writesPausedRef.current && inputGeomReady() && canvasBarrier().ready;
      }

      /** 拖拽偏移（宿主 CSS px）→ 画布原点 C：内容跟手（右/下拖 → C 减小，可进入负值）。 */
      function panViewPoint(event, pan) {
        const geom = pan.geom;
        if (!geom || !(geom.width > 0) || !(geom.height > 0)) return { x: pan.startX, y: pan.startY };
        const dx = event.clientX - pan.startClientX;
        const dy = event.clientY - pan.startClientY;
        return {
          x: clampNumber(pan.startX - (dx / geom.width) * pan.viewW, VIEW_LIMITS.canvas[0], VIEW_LIMITS.canvas[1]),
          y: clampNumber(pan.startY - (dy / geom.height) * pan.viewH, VIEW_LIMITS.canvas[0], VIEW_LIMITS.canvas[1]),
        };
      }

      /** One-shot, low-disturbance canvas-blank hint; never a modal or a Runtime error. */
      function showBlankHint() {
        setBlankHint('此处是画布空白，请在页面区域操作');
        window.clearTimeout(blankHintTimerRef.current);
        blankHintTimerRef.current = window.setTimeout(() => setBlankHint(''), 2400);
      }

      /**
       * A blank band can be the .utb-box itself when the live frame is translated away by O. That
       * surface has no page target, so it only gets the one-shot hint (never a dispatch).
       */
      function onBoxPointerDown(event) {
        if (annotRef.current.on || panMode) return;
        if (event.button !== 0) return;
        if (event.target && event.target.closest && event.target.closest('.utb-frame')) return;
        // 选元素模式：点画布空白 = 清悬浮框（零页面派发，也不弹空白提示抢注意力）。
        if (pickRef.current.on) {
          pickClearOverlay();
          return;
        }
        const geom = frameGeometry();
        if (!geom) return;
        const point = mapEventPoint(event, geom);
        if (point.blank) showBlankHint();
      }
