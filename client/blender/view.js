      function blenderViewBody() {
        const viewportScope = blenderSessionScope ?? blenderRecentScope;
        const viewportKey = viewportScope.sessionId || 'recent';
        const frameWidth = blenderStatus.width || blenderSize.width;
        const frameHeight = blenderStatus.height || blenderSize.height;
        const displayScale = blenderFit ? blenderFitScale(frameWidth, frameHeight) : blenderZoom / 100;
        const viewportIcon = (path) => h('svg', { width: 18, height: 18, viewBox: '0 0 24 24', 'aria-hidden': true },
          h('path', { d: path, fill: 'none', stroke: 'currentColor', strokeWidth: 1.6, strokeLinecap: 'round', strokeLinejoin: 'round' }));
        function openEditor(id, trigger) {
          if (!(id in blenderEditors)) {
            const rect = trigger.getBoundingClientRect();
            const anchor = id === 'properties' ? null : { x: rect.left, y: rect.bottom + 4 };
            setBlenderEditors((current) => id in current ? current : { ...current, [id]: anchor });
          }
          setActiveBlenderEditor(id);
        }
        const openEditorButton = (id, label, content, disabled = false) => {
          const open = id in blenderEditors;
          return button(label, content, (event) => openEditor(id, event.currentTarget), disabled, {
            key: id, 'aria-haspopup': 'dialog', 'aria-expanded': open, 'aria-pressed': open,
            'data-utb-blender-editor-open': id });
        };
        const preferencesItem = h('button', {
          type: 'button', className: 'utb-menu-item', role: 'menuitem',
          'aria-haspopup': 'dialog', 'data-utb-blender-editor-open': 'preferences',
          onClick: (event) => {
            openEditor('preferences', event.currentTarget);
            setMenu(false);
          },
        }, BLENDER_PREFERENCES_LABEL);
        const referenceItem = h('button', {
          type: 'button', className: 'utb-menu-item', role: 'menuitem',
          'aria-haspopup': 'dialog', 'aria-expanded': Boolean(blenderReferenceAnchor?.open),
          onClick: (event) => {
            const rect = event.currentTarget.getBoundingClientRect();
            const trigger = event.currentTarget.closest('.utb-more')?.querySelector('button');
            setBlenderReferenceAnchor({ x: rect.left, y: rect.bottom + 4, trigger, open: true });
            setActiveBlenderEditor('references');
            setMenu(false);
          },
        }, BLENDER_REFERENCES_LABEL);
        const referenceWindow = visible && blenderReferenceAnchor && h(BlenderReferencesWindow, {
          key: viewportKey, scope: viewportScope, viewportGeneration: blenderStatus.generation,
          viewportChanging: !!blenderStatus.changingViewport, open: blenderReferenceAnchor.open,
          stage, anchor: blenderReferenceAnchor, active: activeBlenderEditor === 'references',
          onActivate: () => setActiveBlenderEditor('references'), onClose: () => {
            setBlenderReferenceAnchor((current) => current && { ...current, open: false });
            blenderReferenceAnchor.trigger?.focus({ preventScroll: true });
          },
        });
        const editorButtons = Object.entries(BLENDER_EDITORS).map(([id, { label, path }]) => openEditorButton(id, label, viewportIcon(path)));
        const displaySettingsToggle = button('显示设置', viewportIcon('M2.5 12s3.6-6 9.5-6 9.5 6 9.5 6-3.6 6-9.5 6-9.5-6-9.5-6Zm12 0a2.5 2.5 0 1 0-5 0 2.5 2.5 0 0 0 5 0Z'),
          () => setBlenderDisplaySettingsVisible((visible) => !visible), false, {
            key: 'display-settings', 'aria-expanded': blenderDisplaySettingsVisible, 'aria-pressed': blenderDisplaySettingsVisible,
            'data-utb-blender-display-toggle': '',
          });
        return [
          shellBarPublic(h(BlenderProjectBar, {
            key: viewportKey, scope: viewportScope,
            project: blenderStatus.projectScope === viewportScope ? blenderStatus.project ?? null : null,
            disabled: annotOn || !visible || !!blenderStatus.changingViewport,
            onLoad: (project) => blenderViewportControl.current?.({ reload: true, project }),
          }),
            [displaySettingsToggle, ...editorButtons, button('工作区切换', h('span', { className: 'utb-tabs-glyph', 'aria-hidden': true }, '▤'),
              () => setBlenderWorkspacesVisible((value) => !value), false, {
                key: 'workspaces',
                'aria-expanded': blenderWorkspacesVisible,
                'aria-pressed': blenderWorkspacesVisible,
                'data-utb-blender-workspaces-toggle': '',
              })], h(React.Fragment, null, preferencesItem, referenceItem)),
          referenceWindow && (reactDom?.createPortal ? reactDom.createPortal(referenceWindow, document.body, `references:${viewportKey}`) : referenceWindow),
          blenderDisplaySettingsVisible && h('div', { key: 'display-settings-bar', className: 'utb-tabs utb-blender-display-bar',
            role: 'group', 'aria-label': '显示设置', 'data-utb-blender-display-settings': '' },
          Object.entries(BLENDER_DISPLAY_SETTINGS).map(([id, label]) => openEditorButton(id, label, label,
            !(id in blenderEditors) && (!blenderStatus.shading || blenderStatus.changingViewport || blenderStatus.phase === 'error')))),
          blenderWorkspacesVisible && blenderWorkspaceTabs({ active: blenderStatus.workspace,
            busy: !!blenderStatus.changingViewport, onSelect: (change) => blenderViewportControl.current?.(change) }),
          shellAnnotBar(),
          shellSizeBar(),
          h(BlenderViewport, {
            key: viewportKey, scope: viewportScope, visible, stage, box: blenderBoxRef, imageRef: blenderImageRef,
            size: blenderSize, display: { width: frameWidth * displayScale, height: frameHeight * displayScale },
            annotating: annotOn, onStatus: setBlenderStatus, viewportControl: blenderViewportControl,
            editors: blenderEditors, activeEditor: activeBlenderEditor, onActivateEditor: setActiveBlenderEditor,
            onCloseEditor: (id) => setBlenderEditors((open) => {
              const remaining = { ...open };
              delete remaining[id];
              return remaining;
            }),
          }, shellAnnotLayer(), shellAnnotTextInput()),
        ];
      }
