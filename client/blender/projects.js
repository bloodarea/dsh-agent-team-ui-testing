    const BLENDER_DEFAULT_PROJECT = '默认场景';

    function BlenderProjectBar({ scope, project, disabled, onLoad }) {
      const [open, setOpen] = React.useState(false);
      const [draft, setDraft] = React.useState(null);
      const [listing, setListing] = React.useState(null);
      const [error, setError] = React.useState('');
      const field = React.useRef(null);
      const menu = React.useRef(null);
      const id = React.useId();

      React.useEffect(() => {
        if (!open || disabled) return undefined;
        const controller = new AbortController();
        getHost('/blender/projects', scope, AbortSignal.any([controller.signal, AbortSignal.timeout(8000)]))
          .then((value) => { if (!controller.signal.aborted) setListing(value); })
          .catch((reason) => {
            if (!controller.signal.aborted) setError(reason.message || '无法读取工作区工程。');
          });
        return () => controller.abort();
      }, [open, disabled, scope]);

      function close() {
        setOpen(false);
        setDraft(null);
        setError('');
      }
      function show() {
        if (open) return;
        setListing(null);
        setError('');
        setOpen(true);
      }
      function load(name) {
        close();
        onLoad(name);
      }
      const query = draft?.trim().replaceAll('\\', '/') || '';
      const projects = listing?.projects ?? [];
      const visible = projects.filter((name) => name.toLowerCase().includes(query.toLowerCase()));
      function submit(event) {
        event.preventDefault();
        if (disabled || draft === null) return;
        if (!query || query === BLENDER_DEFAULT_PROJECT) return load(null);
        const match = projects.find((name) => name === query);
        if (match) load(match);
        else if (listing) setError('请选择工作区中的 .blend 工程。');
      }
      const option = (name) => h('button', {
        key: name ?? '', type: 'button', className: 'utb-menu-item', role: 'menuitemradio',
        'aria-checked': name === project, title: name ?? BLENDER_DEFAULT_PROJECT,
        'data-utb-blender-project-option': name ?? '', onClick: () => load(name),
      }, h('span', { className: 'utb-addr-label' }, name ?? BLENDER_DEFAULT_PROJECT));

      return h('form', { className: 'utb-blender-project', onSubmit: submit,
        onBlur: (event) => { if (!event.currentTarget.contains(event.relatedTarget)) close(); },
        onKeyDown: (event) => {
          if (event.key === 'Escape' && open) {
            event.preventDefault();
            event.stopPropagation();
            field.current.focus();
            close();
          } else if (event.key === 'ArrowDown' && event.target === field.current) {
            event.preventDefault();
            if (open) menu.current?.querySelector('button')?.focus();
            else show();
          }
        } },
      h('div', { className: 'utb-addr-wrap' },
        h('input', { ref: field, type: 'text', className: 'utb-addr', 'aria-label': 'Blender 工程',
          placeholder: BLENDER_DEFAULT_PROJECT, title: project ?? BLENDER_DEFAULT_PROJECT,
          spellCheck: false, autoComplete: 'off', disabled, value: draft ?? project ?? '',
          onChange: (event) => { setDraft(event.target.value); setError(''); show(); } }),
        h('button', { type: 'button', className: 'utb-blender-project-toggle', disabled,
          'aria-label': '工作区 Blender 工程', title: '工作区 Blender 工程',
          'aria-haspopup': 'menu', 'aria-expanded': open, 'aria-controls': open ? id : undefined,
          onClick: () => { if (open) close(); else show(); } }, h(IconChevron, null)),
        open && h('div', { id, ref: menu, className: 'utb-pop utb-addr-pop', role: 'menu', 'aria-label': '工作区 Blender 工程' },
          option(null), visible.map(option),
          error ? h('div', { className: 'utb-addr-pop-empty', role: 'alert' }, error)
            : !listing ? h('div', { className: 'utb-addr-pop-empty', role: 'status' }, '正在扫描工作区…')
            : !visible.length ? h('div', { className: 'utb-addr-pop-empty' }, '没有匹配的 .blend 工程') : null,
          listing?.truncated && h('div', { className: 'utb-addr-pop-empty' }, '仅显示扫描范围内的工程'))),
      h('button', { type: 'button', className: 'utb-btn', disabled, 'aria-label': '重载 Blender',
        title: '重载 Blender', onClick: () => load(project) }, h(IconReload, null)));
    }
