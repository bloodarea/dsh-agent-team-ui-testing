      function changeFit(checked) {
        if (annotRef.current.on) return; // size-bar controls are disabled in annotation mode
        fitRef.current = checked;
        setFit(checked);
        clearZoomIntent();
        resetZoomAnchor();
        if (checked) {
          viewDirtyRef.current.scale = null;
          syncViewDrafts();
          return;
        }
        // Unchecking fit is a display-preference change only: the input falls back to the
        // shared Host ratio (or the local fit ratio on an old Host) without publishing.
        const view = viewRef.current;
        const percent = view
          ? Math.round(clampNumber(Number(view.scale) * 100, VIEW_LIMITS.scalePercent[0], VIEW_LIMITS.scalePercent[1]))
          : Math.round(fitScale * 100);
        viewDirtyRef.current.scale = null;
        setZoom(String(percent));
      }
      /**
       * 用户 2026-11-03 第 4 条：拖拽/适应窗口分页选择器（互斥，最多一个 aria-pressed）。
       * 选拖拽先关 fit（不发布），选适应窗口先退拖拽（保留既有 flush 语义），再各自切换。
       */
      function pressPanMode() {
        if (panModeRef.current) {
          changePanMode(false);
          return;
        }
        if (fitRef.current) changeFit(false);
        changePanMode(true);
      }
      function pressFitMode() {
        if (fitRef.current) {
          changeFit(false);
          return;
        }
        if (panModeRef.current) changePanMode(false);
        changeFit(true);
      }
      /** 用户 2026-11-03 追加：三选一的「默认」——既非拖拽也非适应窗口，只回落共享比例。 */
      function pressPanFitDefault() {
        if (!panModeRef.current && !fitRef.current) return; // already default: no-op
        if (panModeRef.current) changePanMode(false);
        if (fitRef.current) changeFit(false);
      }
      /**
       * 仅 Web 视图的“无头/有头”切换：Host 会关闭共享 Chromium 再按新模式重启（有头=可见窗口+
       * 持久 profile）。切换成功后所有页面都没了：清掉 binding，让面板回到默认空态，需重新打开页面。
       */
      function changeDisplayMode(next) {
        if (next !== 'headless' && next !== 'headed') return;
        if (displaySwitching || next === displayMode || annotRef.current.on) return;
        setDisplaySwitching(true);
        setTabNotice('');
        callHost('display', { mode: next }, { scope: scopeRef.current }).then(() => {
          setDisplaySwitching(false);
          setBindingState({ identityKey, value: '' });
          setActiveViewId('primary');
          showTabNotice(next === 'headed'
            ? '已切换到有头模式：浏览器窗口可见，页面已关闭，请重新打开'
            : '已切换到无头模式：页面已关闭，请重新打开');
        }).catch((error) => {
          setDisplaySwitching(false);
          const code = String((error && error.code) || '');
          showTabNotice(code === 'DISPLAY_UNAVAILABLE'
            ? '有头模式需要图形显示（DISPLAY）'
            : '切换运行模式失败');
        });
      }

      /** 套用某环境的默认尺寸（只发布 width/height；scale 回落到共享比例）。 */
      function applyEnvDefaultSize(next) {
        const target = envDefaultSize(next);
        const dirty = viewDirtyRef.current;
        dirty.width = target.width;
        dirty.height = target.height;
        dirty.scale = null;
        setWidth(String(target.width));
        setHeight(String(target.height));
        // 无视图环境只改本地布局：选择空白画布不得改写仍在运行的目标的视口。
        if (hasExecutionView(next)) queueViewPatch({ width: target.width, height: target.height });
        changePanMode(false);
        changeFit(target.fit);
      }
      /**
       * 用户 2026-11-03 第 3 条 + M4：切换运行环境先提交 Host 会话选择（POST /config/select，
       * 带本面板 scope），成功后才改本地状态；失败保留旧值并显示错误，不静默切换。
       * 未实现环境（!ready）仍不可选，也不会因为选择而启动任何探测。
       */

      function changeEnv(next) {
        if (annotRef.current.on || envBusy) return;
        const option = ENVIRONMENTS.find((item) => item.id === next);
        if (!option) return;
        if (next === env) return;
        // 默认视图没有开关，永远可选；其他环境必须已在设置页启用。
        if (option.kind !== 'view' && enabledFromConfig(hostConfig.state.config, next) === false) {
          setEnvNotice('该目标环境还没有启用：请先在设置页打开它的开关');
          return;
        }
        const config = hostConfig.state;
        if (config.revision === null) {
          setEnvNotice(config.loading
            ? '正在读取宿主配置，请稍后重试'
            : (config.error || '宿主未提供配置接口，无法保存视图选择'));
          return;
        }
        setEnvBusy(true);
        setEnvNotice('');
        // 选择先落到 Host（会话 + 所属工作区），成功后才改本地视图：换工作区/换会话时读到的
        // 就是各自存下的那一个，不会被"当前执行环境"重新拉走。
        selectHostEnvironment(next, config.revision, scopeRef.current).then((payload) => {
          hostConfig.adopt(payload);
          setEnvBusy(false);
          // A new view instance: anything still in flight for the previous view must not be adopted.
          bumpPanelGeneration();
          setEnv(next);
          setMenu(false);
          setAnnotShotNotice('');
          if (VIEW_ONLY.has(next)) {
            annotRetainDirty(true);
            annotUnsubscribePublisher();
            annotCandidateRef.current = null;
            setBlenderStatus({ phase: 'idle' });
          } else {
            // 有视图的环境与空态都按各自默认分辨率铺视图窗，公共视图组件才有真实尺寸可用。
            applyEnvDefaultSize(next);
          }
        }).catch((error) => {
          setEnvBusy(false);
          if (error && error.code === 'CONFIG_CONFLICT') {
            adoptHostConflict(hostConfig, error);
            setEnvNotice('配置已被其他窗口修改（CONFIG_CONFLICT）；已按最新 revision 重新读取，本次切换未保存');
            return;
          }
          setEnvNotice('保存视图选择失败：' + (configErrorText(error && error.message) || '未知错误'));
        });
      }
      /**
       * 用户 2026-11-03 第 5/7 条：左侧四个分辨率预设不再只是宽高——点任一预设同时把 X/Y 归零，
       * 并按当前模式处理右侧 `拖拽|适应窗口|默认` 分页选择器（上下文相关，互斥联动）：
       *   - 拖拽中 → 只退出拖拽（fit 本就是 false），右侧落到「默认」；
       *   - 适应窗口中 → **保持**「适应窗口」（fit 是本地显示偏好，不发布比例；新尺寸自动适应）；
       *   - 已是「默认」→ 仍是「默认」。
       * 不改 `scale`/`%`（「默认」语义 = `%` 回落到共享 view.scale）。
       *
       * 宽高与坐标合并进同一个 120ms 的 v1 patch（一次 /viewport，带 expectedRevision）：画布
       * Host 写 `canvasX/canvasY`，无画布但有共享 view 的 Host 写文档滚动 `x/y`，旧 Host（无
       * 共享 view）只写宽高。X/Y 草稿立即显示 0，不等 Host 回显。
       */
      function applySizePreset(preset) {
        if (annotRef.current.on) return; // size-bar controls are disabled in annotation mode
        // 只退出拖拽（会 flush 待发平移写入，其 x/y 随后被本 patch 的 0 覆盖）；绝不关闭
        // 「适应窗口」——它是本地显示偏好，用户从适应窗口点预设应继续适应新尺寸。
        if (panModeRef.current) changePanMode(false);
        changeSizeField('width', String(preset.w));
        changeSizeField('height', String(preset.h));
        if (!viewRef.current) return; // old Host: only width/height are writable
        changePositionField('x', '0');
        changePositionField('y', '0');
        // changePositionField 只改草稿（与输入框一致）；归零必须搭同一合并 patch 提交。
        queueViewPatch({ x: 0, y: 0 });
      }
      function changeZoom(value) {
        changeScaleField(value);
      }
      stageWheelRef.current = onStageWheel;
      sizeWheelRef.current = onSizeWheel;
      annotWidthWheelRef.current = onAnnotWidthWheel;
      const button = (label, children, onClick, disabled, extra) =>
        h('button', Object.assign({ type: 'button', className: 'utb-btn', title: label, 'aria-label': label, onClick, disabled }, extra || {}), children);
      /**
       * 用户 2026-11-03 追加：每个分页选项左侧的固定 8×8 标记位；只有选中项显示绿色小球，
       * 未选中项 visibility:hidden 保留占位（切换时文字不左右跳动）。纯视觉，不参与计算/上报。
       */
      const segDot = (on, group) => h('svg', {
        className: 'utb-seg-dot',
        width: 8,
        height: 8,
        viewBox: '0 0 8 8',
        'aria-hidden': 'true',
        focusable: 'false',
        'data-utb-seg-dot': on ? 'on' : 'off',
        'data-utb-seg-group': group,
        style: { visibility: on ? 'visible' : 'hidden' },
      }, h('circle', { cx: 4, cy: 4, r: 3, fill: '#22c55e' }));
      const annotToolButton = (tool, label) =>
        h('button', {
          type: 'button',
          className: 'utb-btn utb-annot-tool',
          title: label,
          'aria-label': label,
          'data-utb-annot-tool': tool,
          'aria-pressed': annotTool === tool,
          onClick: () => chooseAnnotTool(tool),
        }, h(IconAnnotTool, { tool }));

      // Status priority: a failed seed is more actionable than the generic syncing hint; an input
      // rejection is more urgent than the one-shot blank hint. All are panel-local.
      const syncNotice = (() => {
        if (seedStatus) return { kind: 'seed-failed', text: '画面未同步，请重试同步或重新加载页面', retry: true, reason: seedStatus.reason };
        if (canvasOn && syncMismatch) return { kind: 'syncing', text: '画面同步中，暂时无法操作', retry: true, reason: canvasBarrierState ? canvasBarrierState.reason : '' };
        if (inputNotice) return { kind: 'input-error', text: inputNotice, retry: false, reason: '' };
        if (blankHint) return { kind: 'blank', text: blankHint, retry: false, reason: '' };
        return null;
      })();
      /**
       * Component-local tabs providers, separate from environment body/annotation registration.
       * Missing providers (or null models) expose no targets or actions; never fall back to Web.
       */
      const tabsProvider = ENV_TABS[env];
      const envTabs = typeof tabsProvider === 'function' ? tabsProvider() : null;
      const tabsSupported = Boolean(envTabs);
      // Preference is independent of the item count: a single tab still occupies its own row.
      const showTabs = tabsSupported && tabsVisible;

      /** Web adapter: Host views, browser labels and runtime binding stay outside the shell. */
      function webTabsProvider() {
        if (!stableViews) return null;
        const tabText = (view) => {
          const text = String((view && (view.title || view.hostLabel)) || '新页面').replace(/[\u0000-\u001f\u007f]/gu, '');
          return text.slice(0, 80) || '新页面';
        };
        return {
          label: '浏览器标签页',
          items: readyViewList.map((view) => ({
            id: String(view.id),
            label: tabText(view),
            title: tabText(view),
            closeLabel: (view.kind === 'primary' ? '重置标签 ' : '关闭标签 ') + tabText(view),
            closeTitle: view.kind === 'primary' ? '关闭标签（回到空态）' : '关闭标签',
            closeKind: view.kind === 'primary' ? 'primary' : 'popup',
            locked: view.locked === true,
            // Human keep-alive lock: `locked` comes from the Host row, never derived locally.
            onLock: (id) => toggleTabLock(readyViewList.find((item) => String(item.id) === id)),
            lockLabel: (view.locked ? '解除保活锁 ' : '锁定保活 ') + tabText(view),
            lockTitle: view.locked
              ? '已锁定：这个标签不会被自动回收，点一下解除'
              : '锁定这个标签：阻止 idle/LRU 自动回收，持续保活',
          })),
          activeId: activeView ? String(activeView.id) : '',
          canCreate: true,
          creating: tabOpening,
          createLabel: '新建标签页',
          createTitle: '新建空白标签页',
          onSelect: switchView,
          onClose: (id) => closeView(readyViewList.find((view) => String(view.id) === id)),
          onCreate: newTab,
        };
      }
      const POPUP_REASON_TEXT = {
        'no-opener': '无法确认来源', 'no-source': '无法确认来源', 'no-human-input': '需要真人点击',
        'automatic-popup': '自动弹窗已拦截', 'source-stale': '来源已过期', 'target-forbidden': '目标地址不允许',
        'popup-limit': '子页数量已达上限', 'busy': 'Agent 正在操作', 'initialize-failed': '页面初始化失败',
      };
      const activeBusy = Boolean(activeView && activeView.busy);
      const latestPopupNotice = stableViews && Array.isArray(stableViews.popupNotices) && stableViews.popupNotices.length
        ? stableViews.popupNotices[stableViews.popupNotices.length - 1] : null;
      function retrySync() {
        if (remoteRef.current?.running !== true) return;
        const transport = transportRef.current;
        if (!transport || typeof transport.retrySeedRefresh !== 'function') return;
        try { transport.retrySeedRefresh(seedContext()); } catch { /* transport must not break UI */ }
      }

      /**
       * 环境视图注册表：右上角组合框选哪个目标环境，下面就渲染哪个视图。
       * 目前只有 web 实现了视图；其余目标环境在表里缺席 → 走「视图层暂不支持」占位。
       * 接新环境时只加一项（或改成按宿主适配器声明注册），外壳不用动。
       */
