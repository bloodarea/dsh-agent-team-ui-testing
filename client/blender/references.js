    const BLENDER_REFERENCES_LABEL = '参考图设置';
    const BLENDER_REFERENCES_ROUTE = '/blender/references';

    async function requestBlenderReference(path, scope, generation, signal, { method = 'GET', file } = {}) {
      const headers = { ...scopeHeaders(scope), 'X-DSH-Blender-Generation': generation };
      if (file) {
        let physicalPath = '';
        try { physicalPath = window.__DSH_HOST_PATHS__?.pathFor(file) || ''; } catch { /* browser files can lack a path */ }
        headers['Content-Type'] = 'application/octet-stream';
        headers['X-DSH-Blender-Reference-Name'] = encodeURIComponent(file.name);
        if (physicalPath) headers['X-DSH-Blender-Reference-Path'] = encodeURIComponent(physicalPath);
      }
      const response = await fetch(HOST_BASE + BLENDER_REFERENCES_ROUTE + path, {
        method, credentials: 'same-origin', headers, body: file,
        signal: AbortSignal.any([signal, AbortSignal.timeout(file ? 65_000 : 15_000)]),
      });
      if (!response.ok) {
        const payload = await response.json().catch(() => ({}));
        throw Object.assign(new Error(payload.error || '无法读取或保存参考图。'), { code: payload.code });
      }
      return method === 'GET' ? response.blob() : response.json();
    }

    function BlenderReferencePreview({ scope, generation, item, label }) {
      const [url, setUrl] = React.useState('');
      const [failed, setFailed] = React.useState(false);
      React.useEffect(() => {
        const controller = new AbortController();
        let previewUrl;
        requestBlenderReference(`/${item.id}`, scope, generation, controller.signal).then((blob) => {
          if (controller.signal.aborted) return;
          previewUrl = URL.createObjectURL(blob);
          setUrl(previewUrl);
        }).catch(() => { if (!controller.signal.aborted) setFailed(true); });
        return () => {
          controller.abort();
          if (previewUrl) URL.revokeObjectURL(previewUrl);
        };
      }, [scope, generation, item.id]);
      if (failed) return h('span', { role: 'status' }, '无法显示这张参考图。');
      if (!url) return h('span', { role: 'status' }, '正在加载参考图…');
      return h('img', { src: url, alt: label, draggable: false, onError: () => setFailed(true) });
    }

    function BlenderReferenceRow({ scope, generation, item, number, canRemove, onRemove }) {
      const [open, setOpen] = React.useState(false);
      const label = `参考图-${number}`;
      return h('div', { className: 'utb-blender-reference-row' },
        h('details', { className: 'utb-blender-reference', onToggle: (event) => setOpen(event.currentTarget.open) },
          h('summary', null, h('span', null, label),
            h('small', { title: item.path || '浏览器仅提供文件名' }, item.path || item.name)),
          open && h(BlenderReferencePreview, { scope, generation, item, label })),
        h('button', { type: 'button', className: 'utb-blender-editor-close utb-blender-reference-remove',
          'aria-label': `移除${label}`, title: `移除${label}`, disabled: !canRemove,
          onClick: () => void onRemove(item.id),
        }, '×'));
    }

    function BlenderReferencesWindow({ scope, viewportGeneration, viewportChanging, open, ...windowProps }) {
      const [state, setState] = React.useState(null);
      const [uploading, setUploading] = React.useState(false);
      const [dragging, setDragging] = React.useState(false);
      const [loadError, setLoadError] = React.useState('');
      const [mutationError, setMutationError] = React.useState('');
      const [removing, setRemoving] = React.useState(false);
      const input = React.useRef(null);
      const dropZone = React.useRef(null);
      const mutation = React.useRef(null);
      const revision = React.useRef(0);
      React.useEffect(() => () => mutation.current?.abort(), []);
      React.useLayoutEffect(() => {
        setState((current) => current?.generation === viewportGeneration ? current : null);
      }, [viewportGeneration]);
      React.useEffect(() => {
        if (!open) return undefined;
        const controller = new AbortController();
        let timer;
        async function refresh() {
          const checkpoint = revision.current;
          if (!mutation.current) {
            try {
              const signal = AbortSignal.any([controller.signal, AbortSignal.timeout(10_000)]);
              const result = await getHost(BLENDER_REFERENCES_ROUTE, scope, signal);
              if (controller.signal.aborted || checkpoint !== revision.current) return;
              setState(result);
              setLoadError('');
            } catch (error) {
              if (controller.signal.aborted || checkpoint !== revision.current) return;
              if (['ADAPTER_DISABLED', 'SCOPE_NOT_FOUND', 'SCOPE_FORBIDDEN'].includes(error.code)) setState(null);
              setLoadError(error.message || '无法读取参考图列表。');
            } finally {
              if (!controller.signal.aborted) timer = setTimeout(refresh, 2000);
            }
          } else {
            timer = setTimeout(refresh, 2000);
          }
        }
        void refresh();
        return () => { controller.abort(); clearTimeout(timer); };
      }, [open, scope, viewportGeneration]);

      const generation = state?.generation;
      const ready = Boolean(generation && !loadError && !viewportChanging);
      const canEdit = ready && !uploading && !removing;
      const addFiles = React.useCallback(async (files) => {
        if (!ready || mutation.current || !files.length) return;
        const controller = new AbortController();
        mutation.current = controller;
        revision.current++;
        setUploading(true);
        setMutationError('');
        try {
          for (const file of files) {
            if (controller.signal.aborted) return;
            if (file.size > 32 * 1024 * 1024) {
              setMutationError(`${file.name}：参考图不能超过 32 MiB。`);
              continue;
            }
            try {
              const { item } = await requestBlenderReference('', scope, generation, controller.signal, { method: 'POST', file });
              if (controller.signal.aborted) return;
              setState((current) => current?.generation === generation ? { ...current, items: [...current.items, item] } : current);
            } catch (error) {
              if (controller.signal.aborted) return;
              setMutationError(`${file.name}：${error.message}`);
              if (['BLENDER_STALE_FRAME', 'ADAPTER_DISABLED', 'SCOPE_NOT_FOUND'].includes(error.code)) {
                setState(null);
                break;
              }
            }
          }
        } finally {
          mutation.current = null;
          if (!controller.signal.aborted) setUploading(false);
        }
      }, [generation, ready, scope]);

      async function removeFile(id) {
        if (!canEdit || mutation.current) return;
        const controller = new AbortController();
        mutation.current = controller;
        revision.current++;
        setRemoving(true);
        setMutationError('');
        try {
          const result = await requestBlenderReference(`/${id}`, scope, generation, controller.signal, { method: 'DELETE' });
          if (controller.signal.aborted) return;
          setState((current) => current?.generation === generation ? result : current);
        } catch (error) {
          if (controller.signal.aborted) return;
          if (['BLENDER_STALE_FRAME', 'ADAPTER_DISABLED', 'SCOPE_NOT_FOUND'].includes(error.code)) setState(null);
          setMutationError(error.message || '无法移除参考图。');
        } finally {
          mutation.current = null;
          if (!controller.signal.aborted) setRemoving(false);
        }
      }

      React.useLayoutEffect(() => {
        if (!open) {
          setDragging(false);
          return undefined;
        }
        const zone = dropZone.current;
        const events = ['dragenter', 'dragover', 'dragleave', 'drop'];
        // DSH listens on document for attachment drops. Claim file drags at capture
        // only when the reference drop zone is in the event path.
        function handleFileDrag(event) {
          const transfer = event.dataTransfer;
          if (!transfer?.types.includes('Files') || !event.composedPath().includes(zone)) return;
          event.stopPropagation();
          if (event.type === 'dragleave') {
            setDragging(false);
            return;
          }
          event.preventDefault();
          if (event.type === 'drop') {
            setDragging(false);
            if (canEdit) void addFiles(Array.from(transfer.files));
            return;
          }
          transfer.dropEffect = canEdit ? 'copy' : 'none';
          setDragging(canEdit);
        }
        for (const type of events) window.addEventListener(type, handleFileDrag, true);
        return () => {
          for (const type of events) window.removeEventListener(type, handleFileDrag, true);
        };
      }, [open, canEdit, addFiles]);

      if (!open) return null;
      const errors = loadError || mutationError;
      return h(BlenderFloatingWindow, { ...windowProps, id: 'references', label: BLENDER_REFERENCES_LABEL, autoFocus: true },
        h('div', { className: 'utb-blender-reference-body' },
          state?.items.length > 0 && h('div', { className: 'utb-blender-reference-list' },
            state.items.map((item, index) => h(BlenderReferenceRow, {
              key: `${state.generation}:${item.id}`, scope, generation: state.generation, item,
              number: index + 1, canRemove: canEdit, onRemove: removeFile,
            }))),
          errors && h('p', { className: 'utb-blender-reference-message', role: 'alert' }, errors),
          h('input', { type: 'file', ref: input, hidden: true, multiple: true,
            accept: 'image/png,image/jpeg,image/webp,image/gif,image/bmp,image/avif,.png,.jpg,.jpeg,.webp,.gif,.bmp,.avif',
            onChange: (event) => {
              const files = Array.from(event.currentTarget.files);
              event.currentTarget.value = '';
              void addFiles(files);
            } }),
          h('button', { type: 'button', ref: dropZone,
            className: 'utb-blender-reference-drop' + (dragging && canEdit ? ' is-dragging' : ''),
            'aria-disabled': !canEdit, onClick: () => { if (canEdit) input.current?.click(); },
          }, uploading ? '正在添加参考图…' : ready ? '拖入图片，或点击选择文件'
            : loadError ? '参考图暂不可用' : '等待 Blender 实例…')));
    }
