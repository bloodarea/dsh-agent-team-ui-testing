      function panelKeyEvents(event) {
        const key = String((event && event.key) || '');
        if (!key || key === 'Dead' || key === 'Unidentified') return [];
        const modifiers = (event.altKey ? 1 : 0) | (event.ctrlKey ? 2 : 0)
          | (event.metaKey ? 4 : 0) | (event.shiftKey ? 8 : 0);
        const virtualKeyCode = Number.isFinite(event.keyCode) && event.keyCode > 0
          ? event.keyCode
          : PANEL_KEY_CODES[key];
        const printable = key.length === 1;
        // 命令修饰键（Ctrl/Cmd/Alt）按下时这是**快捷键**而不是输入：必须发 rawKeyDown 且不带
        // text——带 text 时 Chrome 按字符插入处理，页面只看到「打了个字母」，全选/复制/粘贴/剪切
        // 这些编辑命令不会执行（用户实测：组合键是分开的、不能真正全选）。
        const altGraph = typeof event.getModifierState === 'function' && event.getModifierState('AltGraph');
        const command = !altGraph && (event.ctrlKey === true || event.metaKey === true || event.altKey === true);
        const text = command ? '' : (printable ? key : (key === 'Enter' ? '\r' : ''));
        const base = {
          kind: 'key',
          key,
          code: event.code || undefined,
          virtualKeyCode,
          modifiers,
          location: Number.isFinite(event.location) ? event.location : undefined,
          autoRepeat: event.repeat === true ? true : undefined,
        };
        const down = Object.assign({}, base, { type: command ? 'rawKeyDown' : 'keyDown' });
        if (text) {
          down.text = text;
          down.unmodifiedText = text;
        }
        // 只发按下。旧实现这里顺手补一个 keyUp（"按下即松开"），于是页面永远看不到"按住"：
        // 游戏里按住 W+A 斜向移动、按住方向键连续走动全部失效（用户实测：WASD 斜向移动没用）。
        // 真实的 keyup 由 onKeyUp 转发，焦点离开预览时由 releasePanelKeys 兜底松开。
        return [down];
      }

      /** 松开：只发 keyUp（与上面的 keyDown 成对，不再凭空补一个）。 */
      function panelKeyReleaseEvents(event) {
        const key = String((event && event.key) || '');
        if (!key || key === 'Dead' || key === 'Unidentified') return [];
        const modifiers = (event.altKey ? 1 : 0) | (event.ctrlKey ? 2 : 0)
          | (event.metaKey ? 4 : 0) | (event.shiftKey ? 8 : 0);
        const virtualKeyCode = Number.isFinite(event.keyCode) && event.keyCode > 0
          ? event.keyCode
          : PANEL_KEY_CODES[key];
        return [{
          kind: 'key',
          type: 'keyUp',
          key,
          code: event.code || undefined,
          virtualKeyCode,
          modifiers,
          location: Number.isFinite(event.location) ? event.location : undefined,
        }];
      }

      /**
       * 焦点离开预览时把"面板以为还按着"的键松开。
       *
       * 少了这一步，用户在预览里按住 W、鼠标点聊天框之后，页面会一直认为 W 还按着（Host 侧现在
       * 也有按键状态表，会把后续事件继续标成 shift/… 位）。只发 keyUp，不产生任何其它副作用。
       */
      function releasePanelKeys() {
        const held = panelHeldKeysRef.current;
        if (!held || !held.size) return;
        const events = [];
        for (const entry of held) {
          events.push({ kind: 'key', type: 'keyUp', key: entry.key, code: entry.code, virtualKeyCode: entry.virtualKeyCode });
        }
        held.clear();
        if (events.length) sendEvents(events);
      }

      /* ---- 系统剪贴板桥：面板里的 Ctrl+C/X/V 与宿主系统共用剪贴板 -------------------------- */
      // 页面跑在宿主的 Chromium 里，它的剪贴板是浏览器内部的；面板（GUI 页面）才有真正的系统
      // 剪贴板 API。所以复制/剪切时把选区文本写进系统剪贴板，粘贴时把系统剪贴板的内容插进页面。
      async function clipboardWriteText(text) {
        const value = String(text || '');
        if (!value) return false;
        try {
          if (navigator.clipboard && typeof navigator.clipboard.writeText === 'function') {
            await navigator.clipboard.writeText(value);
            return true;
          }
        } catch { /* 权限被拒：保持浏览器内部剪贴板行为 */ }
        return false;
      }

      /** 返回 `null` 表示"读不到"（权限/不支持），空串表示"确实是空的"。 */
      async function clipboardReadText() {
        try {
          if (navigator.clipboard && typeof navigator.clipboard.readText === 'function') {
            const text = await navigator.clipboard.readText();
            return typeof text === 'string' ? text : '';
          }
        } catch { /* 权限被拒 */ }
        return null;
      }

      /** 页面当前选区文本（只读评估；输入框/文本域按 selectionStart..End 取，否则取 document 选区）。 */
      function pageSelectionText(signal, scope = scopeRef.current) {
        const expression = "(() => { const el = document.activeElement; "
          + "if (el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA')) { const s = el.selectionStart, e = el.selectionEnd; "
          + "return (typeof s === 'number' && typeof e === 'number' && e > s) ? String(el.value).slice(s, e) : ''; } "
          + "return window.getSelection ? String(window.getSelection()) : ''; })()";
        return callHost('eval', { expression }, { scope, signal })
          .then((payload) => {
            if (!payload) return '';
            if (typeof payload.value === 'string') return payload.value;
            if (payload.result && typeof payload.result.value === 'string') return payload.result.value;
            return '';
          })
          .catch(() => '');
      }

      function sendEvents(events, options) {
        const scope = scopeRef.current;
        const epoch = scopeEpochRef.current;
        const documentKey = selectPopDocument();
        const signal = abortRef.current ? abortRef.current.signal : undefined;
        const current = () => epoch === scopeEpochRef.current && documentKey === selectPopDocument()
          && !signal?.aborted && readyRef.current && !writesPausedRef.current
          && !annotRef.current.on && (!pickRef.current.on || options?.wheel === true);
        const pending = inputQueueRef.current.then(async () => {
          if (!current()) return false;
          const prepared = typeof events === 'function' ? await events({ scope, signal }) : events;
          if (!current() || !prepared?.length) return false;
          await callHost('input', { events: prepared }, { scope, signal });
          const clearsNotice = prepared.some((entry) => entry
            && (entry.kind !== 'mouse' || ['mousePressed', 'mouseReleased', 'mouseClicked'].includes(String(entry.type))));
          if (current() && clearsNotice) setInputNotice('');
          return true;
        }).catch((error) => {
          if (current()) noteInputError(error);
          return false;
        });
        inputQueueRef.current = pending;
        return pending;
      }

      // 人类接管：真实输入后 4 秒内标记，其余时间回落到空闲
      const markHuman = () => {
        setMode((current) => (current === 'agent' ? current : 'human'));
        window.clearTimeout(humanTimer.current);
        humanTimer.current = window.setTimeout(() => setMode((current) => (current === 'agent' ? current : 'idle')), 4000);
      };
      React.useEffect(() => () => window.clearTimeout(humanTimer.current), []);

      React.useEffect(() => {
        if (!menu) return;
        const close = (event) => { if (!event.target.closest || !event.target.closest('.utb-more')) setMenu(false); };
        const escape = (event) => { if (event.key === 'Escape') setMenu(false); };
        document.addEventListener('mousedown', close);
        document.addEventListener('keydown', escape);
        return () => { document.removeEventListener('mousedown', close); document.removeEventListener('keydown', escape); };
      }, [menu]);

      // Annotation mode: Delete removes the selection; Esc order is
      // composition → move/marquee cancel → selection clear → editor/draft cancel → exit.
      // Both listeners live only while the mode is on.
      React.useEffect(() => {
        if (!annotOn) return undefined;
        const updateModifiers = (event) => {
          if (!['Shift', 'Alt', 'Control', 'Meta'].includes(event.key)) return;
          const move = annotMoveRef.current;
          const marquee = annotMarqueeRef.current;
          const gesture = move.active ? move : marquee.active ? marquee : null;
          if (!gesture) return;
          const point = move.active ? move.last : marquee.end;
          const map = gesture.map;
          const input = {
            clientX: map.painted.left + (point.x - map.cx) * map.sx,
            clientY: map.painted.top + (point.y - map.cy) * map.sy,
            shiftKey: event.shiftKey, altKey: event.altKey, ctrlKey: event.ctrlKey, metaKey: event.metaKey,
          };
          if (move.active) moveAnnotSelection(input);
          else moveAnnotMarquee(input);
        };
        const onKeyDown = (event) => {
          if (annotComposingRef.current || event.isComposing) return;
          updateModifiers(event);
          const editable = annotEditRef.current.active || pickEditableTarget(event.target)
            || pickEditableTarget(document.activeElement);
          const svg = annotSvgRef.current;
          const canvasFocused = svg && (document.activeElement === svg || svg.contains(document.activeElement));
          const idle = !annotMoveRef.current.active && !annotMarqueeRef.current.active && !annotGestureRef.current.active;
          if (!editable && canvasFocused && idle && !event.altKey) {
            const key = event.key.toLowerCase();
            const command = event.ctrlKey || event.metaKey;
            if ((!command && (key === 'v' || key === 'm'))
              || (command && annotIsSelectionTool(annotRef.current.tool) && (key === 'a' || key === 'd'))) {
              event.preventDefault();
              event.stopPropagation();
              if (command) {
                if (annotIsSelectionTool(annotRef.current.tool)) {
                  if (key === 'a') annotSetSelection(annotShapesRef.current.map((shape) => shape.id), false);
                  else annotClearSelection();
                }
              } else chooseAnnotTool(key === 'v' ? 'select' : 'marquee');
              return;
            }
            const directions = { ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, -1], ArrowDown: [0, 1] };
            const direction = directions[event.key];
            if (!command && direction && annotIsSelectionTool(annotRef.current.tool) && annotSelectionRef.current.size) {
              event.preventDefault();
              event.stopPropagation();
              const step = event.shiftKey ? 10 : 1;
              annotShapesRef.current = annotShapesRef.current.map((shape) => annotSelectionRef.current.has(shape.id)
                ? annotTranslateShape(shape, direction[0] * step, direction[1] * step) : shape);
              annotContentSeqRef.current += 1;
              annotDirtyRef.current = true;
              annotPublishSchedule();
              annotSelectionScheduleRender();
              return;
            }
          }
          if (event.key === 'Delete' || event.key === 'Backspace') {
            // 输入框/可编辑区里的 Backspace 属于编辑，不劫持；没有选中时不消费按键。
            if (annotEditRef.current.active || pickEditableTarget(event.target)
              || pickEditableTarget(document.activeElement)) return;
            if (!annotSelectionRef.current.size) return;
            event.preventDefault();
            event.stopPropagation();
            annotDeleteSelection();
            return;
          }
          if (event.key !== 'Escape') return;
          if (annotEditRef.current.active) {
            event.preventDefault();
            cancelAnnotText();
            return;
          }
          if (annotMoveRef.current.active) {
            event.preventDefault();
            cancelAnnotMove();
            return;
          }
          if (annotMarqueeRef.current.active) {
            event.preventDefault();
            cancelAnnotMarquee();
            return;
          }
          if (annotEraseRef.current.active) {
            // 擦掉的对象不回滚；这里只结束手势，不退出模式（§11.4）。
            event.preventDefault();
            finishAnnotErase();
            return;
          }
          if (annotGestureRef.current.active) {
            event.preventDefault();
            cancelAnnotDraft();
            return;
          }
          if (annotSelectionRef.current.size) {
            // 选择不是持久状态：第一下 Esc 只取消选择，再按才退出模式。
            event.preventDefault();
            annotClearSelection();
            return;
          }
          event.preventDefault();
          exitAnnotMode();
          const button = annotButtonRef.current;
          if (button) { try { button.focus({ preventScroll: true }); } catch { /* ignore */ } }
        };
        document.addEventListener('keydown', onKeyDown, true);
        document.addEventListener('keyup', updateModifiers, true);
        return () => {
          document.removeEventListener('keydown', onKeyDown, true);
          document.removeEventListener('keyup', updateModifiers, true);
        };
      }, [annotOn]);

      // A stage scroll changes the painted rect without a React render: an active gesture/edit must
      // not keep drawing against a stale screen mapping.
      React.useEffect(() => {
        const node = stage.current;
        if (!node || typeof node.addEventListener !== 'function') return undefined;
        const onScroll = () => {
          if (!annotRef.current.on) return;
          if (annotGestureRef.current.active || annotEditRef.current.active
            || annotMoveRef.current.active || annotMarqueeRef.current.active) {
            cancelAnnotDraft();
            cancelAnnotMove();
            cancelAnnotMarquee();
            cancelAnnotText();
          }
        };
        node.addEventListener('scroll', onScroll, { passive: true });
        return () => node.removeEventListener('scroll', onScroll);
      }, []);

      /** Adopt a navigation response snapshot; a newer edit made while it was in flight wins. */
      function finishNavigation(state, submittedVersion) {
        if (state) acceptRemote(state);
        if (submittedVersion !== undefined && submittedVersion !== editVersionRef.current) {
          // The user typed a new address while this submit was running: keep that draft.
          pendingRef.current = { active: false };
          setPending(false);
          return;
        }
        if (pendingRef.current.active) {
          pendingRef.current = { active: false };
          setPending(false);
        }
        syncDraft();
      }

      function submit(event, overrideAddress) {
        if (event) event.preventDefault();
        if (annotRef.current.on) return; // annotation mode: local navigation is disabled
        if (pendingRef.current.active) return;
        if (writesPausedRef.current) {
          console.warn('ui-testing: navigation paused while the main view is loading or ambiguous');
          return;
        }
        // A local navigation initiated outside the mode invalidates the drawing immediately and
        // submits a normal empty document under the old identity (§12.1).
        annotNavigationClear();
        // `overrideAddress` lets the history dropdown navigate a stored URL without waiting for a
        // React state round-trip through the draft (the go button and Enter pass the draft).
        const source = typeof overrideAddress === 'string' ? overrideAddress : draft;
        let parsed;
        try {
          const raw = source.trim();
          if (!raw) throw new Error('请输入网址。');
          parsed = new URL(/^[a-z][a-z\d+.-]*:\/\//i.test(raw) ? raw : 'https://' + raw);
          if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') throw new Error('仅支持 HTTP 和 HTTPS 网址。');
          if (parsed.origin === window.location.origin || parsed.href.replace(/^[a-z][a-z\d+.-]*:\/\//i, '').split('/')[0].includes('@')) throw new Error('不支持应用自身地址或包含凭据的网址。');
        } catch (err) {
          setError((err && err.message) || '请输入有效网址。');
          return;
        }
        const version = editVersionRef.current + 1;
        editVersionRef.current = version;
        pendingRef.current = { active: true, editVersion: version, address: parsed.href };
        dirtyRef.current = false;
        setPending(true);
        setDraft(parsed.href);
        setError('');
        setActivity('正在加载 ' + parsed.host);
        requestGenerationRef.current += 1;
        const generation = requestGenerationRef.current;
        const signal = abortRef.current ? abortRef.current.signal : undefined;
        let scopeNow = scopeRef.current;
        const needsBinding = scopeNow.kind === 'recent' && !scopeNow.binding && !scopeNow.legacy;
        const ensure = needsBinding
          ? callHost('ensure', {}, { scope: scopeNow, signal }).then((payload) => {
              // A real operation on recent must return the binding used by the rest of the chain.
              if (generation !== requestGenerationRef.current) return payload;
              const ensuredState = payload && payload.state ? payload.state : payload;
              const runtimeId = runtimeIdOf(payload) || runtimeIdOf(ensuredState);
              if (runtimeId && hasScopeEvidence(payload)) {
                scopeNow = scopeSnapshot('recent', '', runtimeId, false);
                adoptBinding(runtimeId);
              } else if (!hasScopeEvidence(payload)) {
                markLegacyHost();
              } else {
                throw new Error('运行时不可用');
              }
              return payload;
            })
          : callHost('ensure', {}, { scope: scopeNow, signal });
        ensure
          .then((payload) => {
            // A Host with a shared view is authoritative: navigation must not re-apply this
            // panel's local 393×852. Only an old Host (no ui.view) keeps the legacy write.
            const sharedView = viewOf(payload && payload.state ? payload.state : payload)
              || viewOf(payload);
            if (sharedView) return null;
            return callHost('viewport', { width: pageSize.w, height: pageSize.h }, { scope: scopeNow, signal });
          })
          .then(() => callHost('navigate', { url: parsed.href }, { scope: scopeNow, signal }))
          .then((payload) => {
            // A newer action superseded this submit: its response must not touch loading/error.
            if (generation !== requestGenerationRef.current) return;
            noteHostScope(payload && payload.state);
            noteLegacyHost(payload && payload.state);
            finishNavigation(payload && payload.state, version);
          })
          .catch((err) => {
            if (generation !== requestGenerationRef.current) return;
            if (err && err.name === 'AbortError') return;
            pendingRef.current = { active: false };
            setPending(false);
            dirtyRef.current = true; // keep the failed input until edit / Escape / blur
            setError((err && err.message) || '运行时不可用');
          });
      }

      function reload() {
        if (annotRef.current.on) return; // annotation mode: local navigation is disabled
        if (reloadDisabled || writesPausedRef.current || !readyRef.current) return;
        annotNavigationClear();
        cancelDraft();
        setError('');
        setNavBusy(true);
        setActivity(host ? '正在重新加载 ' + host : '正在重新加载');
        requestGenerationRef.current += 1;
        const generation = requestGenerationRef.current;
        const scopeNow = scopeRef.current;
        const signal = abortRef.current ? abortRef.current.signal : undefined;
        callHost('reload', {}, { scope: scopeNow, signal })
          .then((payload) => {
            if (generation !== requestGenerationRef.current) return;
            setNavBusy(false);
            noteHostScope(payload && payload.state);
            noteLegacyHost(payload && payload.state);
            finishNavigation(payload && payload.state);
          })
          .catch((err) => {
            if (generation !== requestGenerationRef.current) return;
            if (err && err.name === 'AbortError') return;
            setNavBusy(false);
            setError((err && err.message) || '运行时不可用');
          });
      }

      function move(direction) {
        if (annotRef.current.on) return; // annotation mode: local navigation is disabled
        const disabled = direction === 'back' ? backDisabled : forwardDisabled;
        if (disabled || writesPausedRef.current || !readyRef.current) return;
        annotNavigationClear();
        cancelDraft();
        setError('');
        setNavBusy(true);
        setActivity(direction === 'back' ? '正在后退' : '正在前进');
        requestGenerationRef.current += 1;
        const generation = requestGenerationRef.current;
        const scopeNow = scopeRef.current;
        const signal = abortRef.current ? abortRef.current.signal : undefined;
        callHost('history', { direction }, { scope: scopeNow, signal })
          .then((payload) => {
            if (generation !== requestGenerationRef.current) return;
            setNavBusy(false);
            noteHostScope(payload && payload.state);
            noteLegacyHost(payload && payload.state);
            finishNavigation(payload && payload.state);
          })
          .catch((err) => {
            if (generation !== requestGenerationRef.current) return;
            if (err && err.name === 'AbortError') return;
            setNavBusy(false);
            setError((err && err.message) || '运行时不可用');
          });
      }

      // The Host view (when shared) is the display truth; local drafts only feed a legacy Host and
      // the in-progress edit. `fit` stays a local preference: the box always renders W×scale,
      // including while the size bar is collapsed (contract §4.3).
