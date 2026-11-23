    const BLENDER_WORKSPACES = [
      { id: 'layout', label: '布局' },
      { id: 'modeling', label: '建模' },
      { id: 'sculpting', label: '雕刻' },
      { id: 'uv-editing', label: 'UV 编辑' },
      { id: 'texture-paint', label: '纹理绘制' },
      { id: 'shading', label: '着色 / 材质' },
      { id: 'animation', label: '动画' },
      { id: 'rendering', label: '渲染' },
      { id: 'compositing', label: '合成' },
    ];

    const BLENDER_SHADING = [
      { id: 'WIREFRAME', label: '线框' },
      { id: 'SOLID', label: '实体' },
      { id: 'MATERIAL', label: '材质预览' },
      { id: 'RENDERED', label: '渲染' },
    ];

    function BlenderShadingIcon({ mode }) {
      const sphere = h('circle', { cx: 12, cy: 12, r: 8.5 });
      const glyph = {
        WIREFRAME: h('g', { fill: 'none', stroke: 'currentColor', strokeWidth: 1.3 }, sphere,
          h('ellipse', { cx: 12, cy: 12, rx: 3.7, ry: 8.5 }),
          h('path', { d: 'M3.5 12h17M5.6 6.8q6.4 3.4 12.8 0M5.6 17.2q6.4-3.4 12.8 0' })),
        SOLID: h('g', { fill: 'currentColor' }, sphere),
        MATERIAL: h('g', { fill: 'none', stroke: 'currentColor', strokeWidth: 1.4 }, sphere,
          h('path', { fill: 'currentColor', stroke: 'none', d: 'M12 3.5a8.5 8.5 0 0 1 0 17c-3.6-4.6 3.6-12.4 0-17Z' })),
        RENDERED: h('g', { fill: 'none', stroke: 'currentColor', strokeWidth: 1.4 }, sphere,
          h('path', { fill: 'currentColor', stroke: 'none', d: 'M6 17.9 18.2 6.3a8.5 8.5 0 0 1-12.2 11.6Z' }),
          h('path', { d: 'M6.8 11.1a5.2 5.2 0 0 1 4.3-4.3', strokeLinecap: 'round' })),
      };
      return h('svg', { width: 18, height: 18, viewBox: '0 0 24 24', 'aria-hidden': true, focusable: false }, glyph[mode]);
    }

    const BLENDER_EDITORS = {
      outliner: { label: '大纲视图', path: 'M4 4h4v4H4z M8 6h11M6 8v10h5m0-7h8m-8 7h8' },
      properties: { label: '属性编辑器', path: 'M4 6h16m-16 6h16m-16 6h16 M8 4v4m8 2v4m-6 2v4' },
    };
    const BLENDER_DISPLAY_SETTINGS = {
      'select-visibility': '可选择性&可见性',
      gizmos: '视图操控器',
      overlays: '视图叠加层',
      'shading-settings': '视图着色方式',
    };

    const BLENDER_PREFERENCES_LABEL = 'Blender设置';

    async function readBlenderImages(response, editors) {
      const type = response.headers.get('Content-Type');
      if (type === 'image/png' && !editors.length) return { viewport: await response.blob() };
      const ids = ['viewport', ...editors];
      const parts = JSON.parse(response.headers.get('X-DSH-Blender-Images') || 'null');
      if (type !== 'application/octet-stream' || !Array.isArray(parts) || parts.length !== ids.length
          || !parts.every((part, index) => Array.isArray(part) && part.length === 2 && part[0] === ids[index]
            && Number.isSafeInteger(part[1]) && part[1] >= 33)) {
        throw new Error('Blender 编辑器画面格式无效，请确认 Host 已重新加载。');
      }
      const blob = await response.blob();
      if (parts.reduce((sum, [, length]) => sum + length, 0) !== blob.size) {
        throw new Error('Blender 编辑器画面不完整。');
      }
      let offset = 0;
      return Object.fromEntries(parts.map(([id, length]) => {
        const image = blob.slice(offset, offset + length, 'image/png');
        offset += length;
        return [id, image];
      }));
    }

    function BlenderEditorWindow({ id, image, onInput, ...windowProps }) {
      const preferences = id === 'preferences';
      const displaySetting = BLENDER_DISPLAY_SETTINGS[id];
      const label = preferences ? BLENDER_PREFERENCES_LABEL : BLENDER_EDITORS[id]?.label || displaySetting;
      return h(BlenderFloatingWindow, { ...windowProps, id, label, contentSized: preferences || Boolean(displaySetting) },
        h(BlenderEditorFrame, { id, label, image, onInput, className: 'utb-blender-editor-frame' }));
    }

    function BlenderFloatingWindow({ id, label, contentSized, stage, anchor, active, onActivate, onClose, autoFocus, children }) {
      const panel = React.useRef(null);
      const drag = React.useRef(null);
      const [initialPosition] = React.useState(() => {
        if (anchor) return anchor;
        const top = stage.current?.getBoundingClientRect().top || 0;
        return { x: Math.max(32, window.innerWidth - 412), y: Math.max(16, top + 48) };
      });
      const [dragPosition, setDragPosition] = React.useState(null);
      const position = dragPosition ?? initialPosition;
      // Leave room for the title and some content even when the button is near the bottom edge.
      const minimumClearance = id === 'references' ? 160 : 88;
      const anchorTop = anchor ? `clamp(0px, ${anchor.y}px, max(0px, calc(100dvh - ${minimumClearance}px)))` : undefined;
      const [bounds, setBounds] = React.useState({ width: 382, height: 36 });
      React.useLayoutEffect(() => {
        const element = panel.current;
        const measure = () => {
          const { width, height } = element.getBoundingClientRect();
          setBounds((current) => current.width === width && current.height === height ? current : { width, height });
        };
        const observer = new ResizeObserver(measure);
        observer.observe(element);
        measure();
        return () => observer.disconnect();
      }, []);

      React.useEffect(() => {
        if (autoFocus) panel.current?.focus({ preventScroll: true });
      }, [autoFocus, anchor]);

      return h('section', { ref: panel, className: `utb-blender-editor${contentSized ? ' is-content-sized' : ''}`,
        role: 'dialog', 'aria-label': label, 'data-utb-blender-editor': id, onPointerDown: onActivate, onFocus: onActivate,
        tabIndex: autoFocus ? -1 : undefined,
        onKeyDown: autoFocus ? (event) => {
          if (event.key !== 'Escape') return;
          event.preventDefault();
          event.stopPropagation();
          onClose();
        } : undefined,
        style: { '--utb-blender-editor-anchor-top': anchorTop,
          left: `clamp(0px, ${position.x}px, max(0px, calc(100vw - ${bounds.width}px)))`,
          top: !dragPosition && anchorTop ? anchorTop : `clamp(0px, ${position.y}px, max(0px, calc(100dvh - ${bounds.height}px)))`,
          zIndex: active ? 2901 : 2900 } },
        h('div', { className: 'utb-blender-editor-bar',
          onPointerDown: (event) => {
            if (event.button !== 0 || event.target.closest('button')) return;
            const rect = panel.current.getBoundingClientRect();
            drag.current = { id: event.pointerId, x: event.clientX - rect.left, y: event.clientY - rect.top };
            event.currentTarget.setPointerCapture(event.pointerId);
          },
          onPointerMove: (event) => {
            const start = drag.current;
            if (start?.id !== event.pointerId) return;
            setDragPosition({ x: event.clientX - start.x, y: event.clientY - start.y });
          },
          onLostPointerCapture: () => { drag.current = null; },
        }, h('span', null, label),
        h('button', { type: 'button', className: 'utb-blender-editor-close', 'aria-label': `关闭${label}`, onClick: onClose }, '×')),
        children);
    }

    function BlenderEditorFrame({ id, label, image, onInput, className }) {
      const frame = React.useRef(null);
      const imageElement = React.useRef(null);
      const pressed = React.useRef(null);
      function point(event, clamp = false) {
        const img = imageElement.current;
        const rect = img?.getBoundingClientRect();
        if (!img?.complete || !img.naturalWidth || !rect?.width || !rect.height) return null;
        const x = (event.clientX - rect.left) / rect.width;
        const y = (event.clientY - rect.top) / rect.height;
        if (!clamp && (x < 0 || x >= 1 || y < 0 || y >= 1)) return null;
        return { x: Math.max(0, Math.min(1, x)), y: Math.max(0, Math.min(1, y)),
          shift: event.shiftKey, ctrl: event.ctrlKey, alt: event.altKey };
      }
      function send(event) { onInput({ ...event, editor: id }, image?.generation); }
      function cancel() {
        if (!pressed.current) return;
        pressed.current = null;
        send({ kind: 'cancel' });
      }
      React.useEffect(() => {
        const element = frame.current;
        const wheel = (event) => {
          const coordinates = point(event);
          const delta = Math.sign(event.deltaY);
          if (!coordinates || !delta) return;
          event.preventDefault();
          send({ kind: 'wheel', delta, ...coordinates });
        };
        element.addEventListener('wheel', wheel, { passive: false });
        return () => element.removeEventListener('wheel', wheel);
      }, [id, image?.generation, onInput]);

      return h('div', { ref: frame, className, tabIndex: 0, 'aria-label': `${label}画布`,
          onPointerDown: (event) => {
            if (pressed.current || ![0, 1, 2].includes(event.button)) return;
            const coordinates = point(event);
            if (!coordinates) return;
            event.preventDefault();
            event.currentTarget.focus({ preventScroll: true });
            event.currentTarget.setPointerCapture(event.pointerId);
            pressed.current = { id: event.pointerId, button: event.button };
            send({ kind: 'down', button: event.button, ...coordinates });
          },
          onPointerMove: (event) => {
            const coordinates = point(event, pressed.current?.id === event.pointerId);
            if (coordinates) send({ kind: 'move', ...coordinates });
          },
          onPointerUp: (event) => {
            const hit = pressed.current;
            if (hit?.id !== event.pointerId) return;
            const coordinates = point(event, true);
            if (!coordinates) { cancel(); return; }
            pressed.current = null;
            send({ kind: 'up', button: hit.button, ...coordinates });
          },
          onPointerCancel: cancel, onLostPointerCapture: cancel, onBlur: cancel,
          onContextMenu: (event) => event.preventDefault(),
          onKeyDown: (event) => {
            if (event.key !== 'Escape' || !image) return;
            event.preventDefault();
            event.stopPropagation();
            pressed.current = null;
            send({ kind: 'escape' });
          },
        }, image ? h('img', { ref: imageElement, src: image.url, alt: `Blender ${label}`, draggable: false })
          : h('span', { className: 'utb-blender-editor-loading', role: 'status' }, '正在连接 Blender…'));
    }
