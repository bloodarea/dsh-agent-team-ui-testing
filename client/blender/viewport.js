    function BlenderViewport({ scope, visible, stage, box, imageRef, size, display, annotating, onStatus, viewportControl,
      editors, activeEditor, onActivateEditor, onCloseEditor, children }) {
      const [frame, setFrame] = React.useState(null);
      const [failure, setFailure] = React.useState('');
      const editorIds = React.useRef([]);
      editorIds.current = Object.keys(editors ?? {});
      const editorKey = editorIds.current.join(',');
      const frameTimes = React.useRef([]);
      const framePaint = React.useRef(0);
      const requestSize = React.useRef(size);
      requestSize.current = size;
      const annotationMode = React.useRef(annotating);
      annotationMode.current = annotating;
      const geometry = React.useRef(null);
      const gesture = React.useRef(null);
      const pendingChange = React.useRef(null);
      const sendInput = React.useRef(() => {});
      const redraw = React.useRef(() => {});

      function pointerPosition(event, clamp = false) {
        const view = geometry.current;
        const rect = imageRef.current?.getBoundingClientRect();
        if (!view || !rect?.width || !rect.height) return null;
        const [left, top, width, height] = view.content;
        const x = ((event.clientX - rect.left) / rect.width * view.width - left) / width;
        const y = ((event.clientY - rect.top) / rect.height * view.height - top) / height;
        if (!clamp && (x < 0 || x >= 1 || y < 0 || y >= 1)) return null;
        return { x: Math.max(0, Math.min(1, x)), y: Math.max(0, Math.min(1, y)),
          shift: event.shiftKey, ctrl: event.ctrlKey, alt: event.altKey };
      }

      function releaseGesture() {
        if (!gesture.current) return;
        gesture.current = null;
        sendInput.current({ kind: 'cancel' });
      }

      function handleEscape(event) {
        if (annotating || event.isComposing || event.key !== 'Escape'
            || event.target !== event.currentTarget || !geometry.current) return;
        event.preventDefault();
        event.stopPropagation();
        gesture.current = null;
        sendInput.current({ kind: 'escape' });
      }

      const [presentation, setPresentation] = React.useState(null);

      React.useEffect(() => {
        if (!frame) return undefined;
        const urls = Object.fromEntries(Object.entries(frame.images).map(([id, image]) => [id, URL.createObjectURL(image)]));
        setPresentation({ ...frame, url: urls.viewport, editorUrls: urls });
        return () => Object.values(urls).forEach((url) => URL.revokeObjectURL(url));
      }, [frame]);

      React.useEffect(() => {
        if (!visible) return undefined;
        const controller = new AbortController();
        let busy = false;
        let dirty = false;
        let retry;
        let hoverRefresh;
        let shadingRefresh;
        let playbackRefresh;
        let queuedChange;
        let queue = [];
        async function refresh() {
          dirty = true;
          if (busy || retry || controller.signal.aborted) return;
          clearTimeout(playbackRefresh);
          dirty = false;
          busy = true;
          const started = performance.now();
          const requested = requestSize.current;
          const generation = geometry.current?.generation;
          const change = queuedChange;
          queuedChange = undefined;
          const openEditors = [...editorIds.current, 'timeline'];
          const input = change?.workspace || change?.reload ? [] : queue.splice(0, 32)
            .filter((event) => !event.editor || openEditors.includes(event.editor));
          const project = change?.reload ? change.project : undefined;
          onStatus((current) => ({ ...current, phase: 'rendering' }));
          try {
            const response = await fetch(HOST_BASE + '/blender/frame', {
              method: 'POST', credentials: 'same-origin', signal: controller.signal,
              headers: Object.assign({ 'content-type': 'application/json' }, scopeHeaders(scope)),
              body: JSON.stringify({ input, generation, ...change, project, size: [requested.width, requested.height], editors: openEditors }),
            });
            if (response.status === 409) {
              const payload = await response.json();
              if (payload.code === 'BLENDER_BUSY') {
                queue.unshift(...input);
                if (change) queuedChange = change;
                retry = setTimeout(() => { retry = undefined; void refresh(); }, 150);
                return;
              }
              if (payload.code === 'BLENDER_STALE_FRAME') {
                geometry.current = null;
                gesture.current = null;
                queuedChange = undefined;
                pendingChange.current = null;
                clearTimeout(shadingRefresh);
                queue = [];
                onStatus((current) => ({ ...current, shading: null, workspace: null, changingViewport: false }));
                dirty = true;
                return;
              }
              throw new Error(payload.error || 'Blender 视口不可用。');
            }
            if (!response.ok) {
              const payload = await response.json().catch(() => ({}));
              throw new Error(payload.error || 'Blender 视口连接失败。');
            }
            const frameGeneration = response.headers.get('X-DSH-Blender-Generation');
            const content = response.headers.get('X-DSH-Blender-Content')?.split(',').map(Number);
            if (!/^[a-f0-9]{32}$/u.test(frameGeneration || '') || content?.length !== 4
                || !content.every((value) => Number.isInteger(value) && value >= 0) || !content[2] || !content[3]
                || content[0] + content[2] > requested.width || content[1] + content[3] > requested.height) {
              throw new Error('Blender 交互视口未就绪，请确认 Host 和面板已重新加载。');
            }
            const shading = response.headers.get('X-DSH-Blender-Shading');
            const workspace = response.headers.get('X-DSH-Blender-Workspace');
            const reportedProject = response.headers.get('X-DSH-Blender-Project');
            const currentProject = reportedProject ? decodeURIComponent(reportedProject) : null;
            if ((change?.shading && change.shading !== shading) || (change?.workspace && change.workspace !== workspace)
                || (change?.reload && (currentProject !== project || generation === frameGeneration))) {
              throw new Error('Blender 未确认视口切换。');
            }
            const images = await readBlenderImages(response,
              workspace === 'layout' ? openEditors : openEditors.filter((id) => id !== 'timeline'));
            if (!controller.signal.aborted) {
              setFrame({ images, started, generation: frameGeneration, content, shading, workspace, project: currentProject });
              setFailure('');
              if (response.headers.get('X-DSH-Blender-Playing') === '1') {
                playbackRefresh = setTimeout(() => { void refresh(); }, 50);
              }
              const shadingEdited = input.some((event) => event.editor === 'shading-settings' && event.kind === 'up');
              if ((change || shadingEdited) && (shading === 'MATERIAL' || shading === 'RENDERED')) {
                clearTimeout(shadingRefresh);
                shadingRefresh = setTimeout(() => { void refresh(); }, 500);
              }
            }
          } catch (error) {
            if (!controller.signal.aborted) {
              geometry.current = null;
              gesture.current = null;
              queue = [];
              queuedChange = undefined;
              pendingChange.current = null;
              clearTimeout(hoverRefresh);
              clearTimeout(shadingRefresh);
              setFailure(error.message || 'Blender 视口连接失败。');
              onStatus((current) => ({ ...current, phase: 'error', changingViewport: false }));
            }
          } finally {
            busy = false;
            if ((dirty || queue.length) && !retry && !controller.signal.aborted) void refresh();
          }
        }
        function enqueue(event, editorGeneration) {
          if (!geometry.current || pendingChange.current?.workspace || pendingChange.current?.reload || controller.signal.aborted) return;
          if (event.editor) {
            const active = event.editor === 'timeline' ? geometry.current.workspace === 'layout' : editorIds.current.includes(event.editor);
            if (!active || geometry.current.generation !== editorGeneration) return;
          }
          const last = queue.at(-1);
          if (event.kind === 'move' && last?.kind === 'move' && last.editor === event.editor) queue[queue.length - 1] = event;
          else if (event.kind === 'wheel' && last?.kind === 'wheel' && last.editor === event.editor && last.x === event.x && last.y === event.y
              && last.shift === event.shift && last.ctrl === event.ctrl && last.alt === event.alt
              && Math.sign(last.delta) === event.delta && Math.abs(last.delta) < 8) last.delta += event.delta;
          else queue.push(event);
          clearTimeout(hoverRefresh);
          if (event.kind === 'move' && !gesture.current) {
            // Blender may open a submenu after its hover delay, even with the pointer stationary.
            hoverRefresh = setTimeout(() => { void refresh(); }, 350);
          }
          void refresh();
        }
        function wheel(event) {
          const delta = Math.sign(event.deltaY);
          if (!delta || annotationMode.current || event.target !== imageRef.current) return;
          const point = pointerPosition(event);
          if (!point) return;
          event.preventDefault();
          enqueue({ kind: 'wheel', delta, ...point });
        }
        const element = stage.current;
        element.addEventListener('wheel', wheel, { passive: false });
        redraw.current = refresh;
        sendInput.current = enqueue;
        if (viewportControl) viewportControl.current = (change) => {
          if ((!geometry.current && !change.reload) || pendingChange.current || controller.signal.aborted || annotationMode.current) return;
          if (change.workspace || change.reload) {
            queue = [];
            const pointerId = gesture.current?.id;
            gesture.current = null;
            if (pointerId !== undefined && element.hasPointerCapture(pointerId)) element.releasePointerCapture(pointerId);
            clearTimeout(hoverRefresh);
          }
          pendingChange.current = { ...change, generation: geometry.current?.generation };
          queuedChange = change;
          clearTimeout(shadingRefresh);
          onStatus((current) => ({ ...current, changingViewport: true }));
          void refresh();
        };
        return () => {
          controller.abort();
          clearTimeout(retry);
          clearTimeout(hoverRefresh);
          clearTimeout(shadingRefresh);
          clearTimeout(playbackRefresh);
          element.removeEventListener('wheel', wheel);
          gesture.current = null;
          pendingChange.current = null;
          geometry.current = null;
          redraw.current = () => {};
          sendInput.current = () => {};
          if (viewportControl) viewportControl.current = null;
        };
      }, [scope, visible, stage, imageRef, onStatus, viewportControl]);
      React.useEffect(() => { void redraw.current(); }, [scope, size, visible, editorKey]);
      React.useEffect(() => { if (annotating) releaseGesture(); }, [annotating]);
      React.useEffect(() => {
        if (!visible) return undefined;
        const sample = () => {
          const earliest = performance.now() - 1000;
          frameTimes.current = frameTimes.current.filter((time) => time > earliest);
          const fps = frameTimes.current.length;
          onStatus((current) => (current.fps === fps ? current : { ...current, fps }));
        };
        sample();
        const timer = window.setInterval(sample, 250);
        return () => {
          window.clearInterval(timer);
          window.cancelAnimationFrame(framePaint.current);
          frameTimes.current = [];
        };
      }, [scope, size, visible, onStatus]);

      const floatingEditors = visible && editorKey && editorIds.current.map((id) => {
        const url = presentation?.editorUrls[id];
        return h(BlenderEditorWindow, { key: id, id, stage, anchor: editors[id], active: activeEditor === id,
          image: url ? { url, generation: presentation.generation } : null,
          onActivate: () => onActivateEditor(id), onClose: () => onCloseEditor(id), onInput: sendInput.current });
      });
      const timeline = visible && presentation?.workspace === 'layout' && presentation.editorUrls.timeline;
      return h(React.Fragment, null, h('div', {
        className: 'utb-stage utb-blender-stage', ref: stage, 'data-utb-blender-viewport': '',
        tabIndex: 0, 'aria-label': 'Blender 3D 视口',
        onPointerDown: (event) => {
          if (annotating || pendingChange.current?.workspace || event.target !== imageRef.current
              || gesture.current || ![0, 1, 2].includes(event.button)) return;
          const point = pointerPosition(event);
          if (!point) return;
          event.preventDefault();
          event.currentTarget.focus({ preventScroll: true });
          event.currentTarget.setPointerCapture(event.pointerId);
          gesture.current = { id: event.pointerId, button: event.button };
          sendInput.current({ kind: 'down', button: event.button, ...point });
        },
        onPointerMove: (event) => {
          const captured = gesture.current?.id === event.pointerId;
          if (annotating || (!captured && event.target !== imageRef.current)) return;
          const point = pointerPosition(event, captured);
          if (point) sendInput.current({ kind: 'move', ...point });
        },
        onPointerUp: (event) => {
          const pressed = gesture.current;
          if (pressed?.id !== event.pointerId) return;
          const point = pointerPosition(event, true);
          if (!point) { releaseGesture(); return; }
          gesture.current = null;
          sendInput.current({ kind: 'up', button: pressed.button, ...point });
        },
        onPointerCancel: releaseGesture,
        onLostPointerCapture: releaseGesture,
        onBlur: releaseGesture,
        onAuxClick: (event) => {
          if (!annotating && event.button === 1 && pointerPosition(event)) event.preventDefault();
        },
        onContextMenu: (event) => {
          if (!annotating && pointerPosition(event)) event.preventDefault();
        },
        onKeyDown: handleEscape,
      }, h('div', { className: 'utb-blender-box', ref: box, style: display },
        presentation && h('img', {
          ref: imageRef, src: presentation.url, alt: 'Blender 3D 视口', draggable: false,
          onLoad: (event) => {
            const image = event.currentTarget;
            const { naturalWidth, naturalHeight } = image;
            const source = image.currentSrc || image.src;
            if (!visible || source !== presentation.url || geometry.current?.source === source) return;
            if (geometry.current?.generation !== presentation.generation) frameTimes.current = [];
            geometry.current = { content: presentation.content, generation: presentation.generation, source,
              width: naturalWidth, height: naturalHeight, workspace: presentation.workspace };
            const ms = Math.round(performance.now() - presentation.started);
            const { shading, workspace } = presentation;
            const change = pendingChange.current;
            if ((change?.workspace && change.workspace === workspace) || (change?.shading && change.shading === shading)
                || (change?.reload && change.project === presentation.project && change.generation !== presentation.generation)) {
              pendingChange.current = null;
            }
            const changingViewport = !!pendingChange.current;
            onStatus((current) => ({ ...current, phase: 'ready', width: naturalWidth, height: naturalHeight, ms,
              shading, workspace, project: presentation.project, projectScope: scope,
              generation: presentation.generation, changingViewport }));
            window.cancelAnimationFrame(framePaint.current);
            framePaint.current = window.requestAnimationFrame((time) => {
              if (document.visibilityState === 'hidden' || !image.isConnected
                  || (image.currentSrc || image.src) !== source
                  || naturalWidth !== requestSize.current.width || naturalHeight !== requestSize.current.height) return;
              frameTimes.current.push(time);
            });
          },
          onError: () => {
            pendingChange.current = null;
            setFailure('无法显示 Blender 视口图像。');
            onStatus((current) => ({ ...current, phase: 'error', changingViewport: false }));
          },
        }), children),
      failure ? h('div', { role: 'alert', className: 'utb-blank-hint' }, failure + ' ',
        h('button', { type: 'button', className: 'utb-btn', onClick: () => {
          setFailure('');
          void redraw.current();
        } }, '重试')) : !presentation && h('div', { role: 'status', className: 'utb-blank-hint' }, '正在连接 Blender…')),
        timeline && h(BlenderEditorFrame, { id: 'timeline', label: '时间轴', className: 'utb-blender-timeline',
          image: { url: timeline, generation: presentation.generation }, onInput: sendInput.current }),
        floatingEditors && (reactDom?.createPortal ? reactDom.createPortal(floatingEditors, document.body) : floatingEditors));
    }
