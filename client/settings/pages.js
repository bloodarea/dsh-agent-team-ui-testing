    function TargetEnvSwitch(props) {
      const [on, setOn] = React.useState(props.checked === true);
      const controlled = typeof props.onChange === 'function';
      const title = props.title || (props.disabled
        ? '当前不可启用'
        : controlled ? '仅筛选当前页面显示的目标' : '前端预览：启用状态暂不保存');
      return h('label', {
        className: 'uts-switch',
        title,
        'data-uts-switch-busy': props.busy ? 'true' : 'false',
      },
        h('input', {
          type: 'checkbox',
          role: 'switch',
          className: 'uts-switch-input',
          'aria-label': props.label,
          checked: controlled ? props.checked === true : on,
          disabled: props.disabled,
          onChange: (event) => controlled ? props.onChange(event.target.checked) : setOn(event.target.checked),
        }),
        h('span', { className: 'uts-switch-track', 'aria-hidden': true }, h('span', { className: 'uts-switch-thumb' })));
    }

    /**
     * 第五节点目标卡片：名称 + 启用分开关，页脚左侧「可用」（已实现）/「未支持 · 未接入」（灰字占位）、右侧「诊断」。
     *
     * 不再显示的东西：当前使用 / 未选中标签（开关已经反映启用状态）、已实现 / 未支持 / 未接入
     * 标签（改用「可用」一枚）、接口 / 执行端（③④，在诊断页）、依赖状态（诊断页六轴之一）。
     * 不显示任何写死版本：启用状态来自 Host 配置，目标状态来自 Host 就绪结果。
     */
    function TargetEnvCard(props) {
      const target = props.target || {};
      const configReady = props.configReady === true;
      const busy = props.busy === true;
      const providerSupported = target.state === 'supported';
      // 可启用 ≠ 已能执行：`preview`（纯视口已接入、无 Agent 执行适配器）也允许用户单独启用/停用这个
      // 运行环境——Host 的纯视口门禁（如 /blender/frame）读的正是这个开关值。
      const providerSwitchable = providerSupported || target.state === 'preview';
      // 未实现卡片左槽位的灰色占位：工程未支持 vs 还没接入，措辞不混用。
      const stateText = target.state === 'preview' ? '纯视口' : target.state === 'unsupported' ? '未支持' : '未接入';
      // 总闸（目标环境）与分开关（运行环境）是两层：分开关只在总闸打开时才可操作，
      // 但关闭总闸不会改写各 provider 已保存的值。
      const masterEnabled = props.masterEnabled === true;
      const providerCurrent = props.providerCurrent === true;
      const switchDisabled = !providerSwitchable || !configReady || busy || !masterEnabled;
      const switchTitle = !providerSwitchable
        ? '当前运行环境未实现，不能启用'
        : !configReady
          ? (props.configError || '宿主配置不可用，无法提交启用状态')
          : busy ? '正在提交到宿主…'
            : !masterEnabled ? '目标环境总开关已关闭：已保存的开关值保留，重新打开后恢复'
              : target.state === 'preview'
                ? '提交到宿主（纯视口：可读画面、可标注截图；同一目标环境只启用一种运行环境）'
                : '提交到宿主（同一目标环境只启用一种运行环境，打开这个会自动关闭其它）';
      return h('div', {
        className: 'uts-item',
        'data-uts-target': target.id,
        'data-uts-provider': target.id,
        'data-uts-provider-state': providerSupported ? 'supported' : providerSwitchable ? 'preview' : 'disabled',
        'data-uts-provider-current': providerCurrent ? 'true' : 'false',
        'data-uts-state': target.state,
        'data-uts-node': 'target',
      },
        h('div', { className: 'uts-card' },
          h('div', { className: 'uts-card-head' },
            h('span', { className: 'uts-card-title' },
              h('span', { className: 'uts-card-name' }, target.name)),
            // 开关挪到卡片右上角：卡片里不再有“用户启用：”这类说明文字；
            // 「当前使用 / 未选中」也不再单独标一枚标签——开关本身就反映了启用状态。
            // （provider 仍是 Host 解析出来的单选值，只是不再在卡片上重复写一遍。）
            h('span', { className: 'uts-card-switch', 'data-uts-switch-provider': target.id },
              h(TargetEnvSwitch, {
                label: '是否启用运行环境：' + target.name,
                checked: props.providerEnabled === true,
                disabled: switchDisabled,
                busy,
                title: switchTitle,
                onChange: (next) => {
                  if (typeof props.onToggleProvider === 'function') props.onToggleProvider(target.id, next);
                },
              }))),
          // 说明统一压到两行（超出省略，完整文字在 title 里）：卡片不再因为说明多一行就高低不齐。
          target.note ? h('div', { className: 'uts-card-note', title: target.note }, target.note) : null,
          // 卡片页脚：左边是状态槽（已实现一枚绿色「可用」；未实现一行灰字「未支持 / 未接入」），
          // 右边固定「诊断」按钮，永远贴右下角。原来的 已实现/未支持/未接入 标签样式（药丸）不再用，
          // 未实现只作灰字占位，避免它和「可用」抢同一层的视觉重量。
          h('div', { className: 'uts-card-foot' },
            providerSupported
              ? h('span', {
                className: 'uts-tag uts-available-tag',
                'data-uts-tag': 'supported',
                'data-uts-available': 'true',
              }, '可用')
              // 未实现也占住左槽位（灰色小字，非标签）：不然整行只剩右侧按钮，左轻右重。
              : h('span', {
                className: 'uts-card-state',
                'data-uts-card-state': target.state || 'planned',
              }, stateText),
            h('div', { className: 'uts-card-actions' },
              h('button', {
                type: 'button',
                className: 'uts-diagnose-btn',
                'data-uts-diagnose': target.id,
                title: '单独查看 ' + target.name + ' 的六轴诊断',
                onClick: (event) => {
                  if (typeof props.onDiagnose === 'function') props.onDiagnose(target.id, event && event.currentTarget);
                },
              }, '诊断')))));
    }

    /**
     * 一个环境分组：默认收齐（用户 2026-11-07 要求），点分组标题展开/收起该环境的候选卡片。
     * 六轴就绪条始终可见（不受折叠影响）；标题是 h4 里的 button（`aria-expanded`/`aria-controls`），
     * 卡片区域按需渲染为 region。
     */
    function TargetEnvGroup(props) {
      const group = props.group;
      const expanded = props.expanded === true;
      const axes = props.axes || [];
      const regionId = 'uts-group-' + group.id;
      return h('div', {
        className: 'uts-group',
        'data-uts-group': group.id,
        'data-uts-expanded': expanded ? 'true' : 'false',
      },
        h('h4', { className: 'uts-group-heading' },
          h('button', {
            type: 'button',
            className: 'uts-group-toggle',
            'aria-expanded': expanded,
            'aria-controls': regionId,
            'data-uts-group-toggle': group.id,
            onClick: () => props.onToggle(group.id),
          },
            h('span', { className: 'uts-group-title' }, group.title),
            h('span', { className: 'uts-group-count' }, group.targets.length + ' 个目标'),
            h('span', { className: 'uts-group-chevron', 'aria-hidden': true }, h(IconChevron, null))),
          // 目标环境总开关：与上面的展开/收起是两个不同控件（不同节点、不同属性），
          // 关闭它只停用整块执行，不抹掉各运行环境已保存的开关值。
          h('div', {
            className: 'uts-group-env',
            'data-uts-env-switch': group.id,
            'data-uts-env-enabled': props.envEnabled === true ? 'true' : 'false',
          },
            h(TargetEnvSwitch, {
              label: '目标环境总开关：' + group.title,
              checked: props.envEnabled === true,
              disabled: props.configReady !== true || props.busy === true,
              busy: props.busy === true,
              title: props.configReady !== true
                ? (props.configError || '宿主配置不可用，无法提交启用状态')
                : props.busy === true
                  ? '正在提交到宿主…'
                  : '关闭后停用整块执行；各运行环境已保存的开关值保留',
              onChange: (next) => {
                if (typeof props.onToggleEnv === 'function') props.onToggleEnv(next);
              },
            }))),
        expanded
          ? h('div', { className: 'uts-cards', id: regionId, role: 'region', 'aria-label': group.title },
              group.targets.length
                ? group.targets.map((target) => {
                    // 卡片只读 Host 配置（启用开关）与静态实现状态；六轴与 ③④ 在它自己的诊断页，
                    // 因此这里不再把 axes 传下去——同一事实只在一处渲染。
                    return h(TargetEnvCard, {
                      key: target.id,
                      target,
                      masterEnabled: props.envEnabled === true,
                      providerEnabled: props.providers ? props.providers[target.id] === true : false,
                      providerCurrent: props.currentProvider === target.id,
                      configReady: props.configReady,
                      configError: props.configError,
                      busy: props.busy,
                      onDiagnose: props.onDiagnose,
                      onToggleProvider: props.onToggleProvider,
                    });
                  })
                : h('p', { className: 'uts-empty' }, '暂未接入'))
          : null);
    }

    /**
     * 二级页：单个运行环境（provider）的诊断。
     *
     * 打开就**真实跑一次 Host 诊断**（`POST /plugins/ui-testing/diagnose`，NDJSON）：节点/边只用
     * Host 的五个 stage 结果说话（PASS/WARN/FAIL/SKIPPED/UNKNOWN），动画只由 stage-start /
     * stage-end 推动，六轴与事件流都来自本 run 的 run-end。没有 run 就没有绿色：这里不拿
     * readiness 快照冒充「已检查」。
     */
    function TargetEnvDiagnostics(props) {
      const group = props.group || { id: '', title: '', targets: [] };
      const target = props.target || {};
      const runKey = diagRunKey(group.id, target.id);
      const [run, setRun] = React.useState(() => DIAG_RUNS.get(runKey) || diagEmptyRun(target.id));
      // readiness 只用于「就绪快照」时间戳与（没有 run 时的）六轴兜底，run 期间不轮询。
      const hostConfig = useHostConfig(null, 'global', {
        pollMs: run.phase === 'running' ? 0 : DIAG_POLL_MS,
        initial: props.initialState,
        silent: true,
      });
      const state = hostConfig.state;
      const lastGoodRef = React.useRef(
        props.initialState && props.initialState.revision !== null && !props.initialState.error
          ? props.initialState
          : null,
      );
      if (!state.error && state.revision !== null) lastGoodRef.current = state;
      const stateError = String(state.error || '');
      const live = stateError ? (lastGoodRef.current || state) : state;
      const abortRef = React.useRef(null);
      const aliveRef = React.useRef(true);

      const applyRun = React.useCallback((next) => {
        if (!aliveRef.current) return;
        setRun(next);
        DIAG_RUNS.set(runKey, next);
      }, [runKey]);

      const startRun = React.useCallback((mode) => {
        try {
          startRunUnsafe(mode);
        } catch (error) {
          const message = '诊断 run 启动失败：' + String((error && error.message) || error);
          try { console.error('[ui-testing] ' + message, error); } catch { /* ignore */ }
          applyRun(Object.assign(diagEmptyRun(target.id), { phase: 'finished', error: message }));
        }
      }, [applyRun, target.id]);
      // The run keeps its own AbortController: the readiness polling controller must never abort it.
      const startRunUnsafe = React.useCallback((mode) => {
        if (abortRef.current) { try { abortRef.current.abort(); } catch { /* ignore */ } }
        const controller = typeof AbortController === 'function' ? new AbortController() : null;
        abortRef.current = controller;
        let current = Object.assign(diagEmptyRun(target.id), { phase: 'running', provider: target.id, mode });
        applyRun(current);
        startDiagnoseRun({
          provider: target.id,
          environment: group.id,
          mode,
          signal: controller ? controller.signal : undefined,
          onEvent: (event) => {
            current = diagApplyEvent(current, event);
            applyRun(Object.assign({}, current));
          },
        }).then(() => {
          if (!aliveRef.current) return;
          if (current.phase !== 'finished') {
            current = Object.assign({}, current, { phase: 'finished' });
            applyRun(current);
          }
        }).catch((error) => {
          if (!aliveRef.current) return;
          if (error && error.name === 'AbortError') return;
          current = Object.assign({}, current, { phase: 'finished', error: hostConfigError(error) });
          applyRun(current);
        });
      }, [applyRun, target.id]);

      React.useEffect(() => {
        aliveRef.current = true;
        // 每次进入诊断页（= 每次点卡片「诊断」）都发起一次新的 observe run：用户点诊断就是要
        // 真实走一遍工具调用，缓存只用于「离开/失败时把上次结果回显出来」，绝不阻止新 run。
        // 旧动画不会被重放：动画只由本次 run 的 stage 事件打开。
        const stored = DIAG_RUNS.get(runKey);
        if (stored && stored.phase === 'finished' && stored.error) setRun(stored);
        startRun('observe');
        return () => {
          aliveRef.current = false;
          if (abortRef.current) { try { abortRef.current.abort(); } catch { /* ignore */ } }
        };
      }, [runKey, startRun]);

      const model = diagRunModel(run, target);
      const rows = diagRunRows(run);
      const overall = model.overall;
      // 本轮还没有结论时（没跑过 / 没跑出结果）统一说 `待诊断` / `诊断未完成`，不用五态里的词。
      const runless = diagRunlessText(run);
      const activeStage = DIAG_STAGE_IDS.find((stageId) => (run.stagePhase || {})[stageId] === 'running') || '';
      // 胶囊文案（可见）与标题共用同一份文本：胶囊窄的时候悬停仍能看到全句。
      const overallText = run.phase === 'running'
        ? '诊断进行中 · 第 ' + (activeStage || '?') + ' 阶段'
        : (runless || (diagStateLabel(overall.status) + (overall.reason ? ' · ' + diagReasonLabel(overall.reason) : '')));
      // ③ WARN browser-not-running 时才提供「启动浏览器后继续诊断」，用户点之前绝不启动。
      const coldBrowser = (run.stages || {})['3'] && run.stages['3'].status === 'WARN'
        && String(run.stages['3'].reason || '').includes('browser-not-running');
      // A run is in flight until its stream closes: the action is disabled meanwhile.
      const runBusy = run.phase === 'running';
      // "Already connected" = this run really reached the CDP stage (③ PASS).
      const hasConnection = Boolean((run.stages || {})['3'] && run.stages['3'].status === 'PASS');
      const runId = run.runId || '';
      const axesSource = run.axes
        ? DIAG_AXIS_ORDER.map((axisKey) => {
          const value = run.axes[axisKey];
          const status = typeof value === 'string' ? value : (value && value.status) || 'not-probed';
          // `run-end.axes.checks` is keyed by *check id* (`readonly-eval`, `target-list`), never by
          // axis: it is only evidence for the capability axis (which is what those checks measured).
          const rawChecks = run.axes.checks && typeof run.axes.checks === 'object' && !Array.isArray(run.axes.checks)
            ? run.axes.checks : null;
          return {
            axis: axisKey,
            status,
            reason: '来自本轮诊断',
            source: 'run',
            runId,
            checkedAt: run.finishedAt || null,
            checks: axisKey === 'capability' && rawChecks
              ? Object.fromEntries(Object.entries(rawChecks).map(([name, value]) => [name, { status: typeof value === 'string' ? value : String((value && value.status) || 'unknown') }]))
              : null,
            targetId: '',
          };
        })
        : providerAxes(live, group.id || '', target.id || '');
      // 没有真正读过 readiness 时不要编一个时间（06:00 那种 epoch 文案会被当成真实读数）。
      const updatedIso = live.lastReadAt ? diagIsoAt(live.lastReadAt) : '';
      const runTimeIso = diagIsoAt(run.finishedAt || run.startedAt || 0);

      return h('section', {
        className: 'uts-diagnostics-body',
        'data-uts-diagnostics': target.id || '',
        'data-uts-diagnostics-group': group.id || '',
        'data-uts-diagnostics-state': target.state || '',
        'data-uts-diag-poll': String(DIAG_POLL_MS),
        'data-uts-diag-stale': stateError ? 'true' : 'false',
        'data-uts-diag-updated': updatedIso,
        'data-uts-run-id': runId,
        'data-uts-run-phase': run.phase || 'idle',
        'data-uts-run-mode': run.mode || '',
        'data-uts-run-source': run.axes ? 'run' : 'readiness',
      },
        h('p', { className: 'uts-page-desc', 'data-uts-diag-scope': 'run' },
          '打开本页会真实执行一次诊断检查（不会启动浏览器），结果按五个阶段逐条返回；'
          + '需要浏览器时可用下方动作显式启动，离开本页会中止本次检查。'
          + '本页只反映当前作用域这一次诊断的结果，不代表其它会话中的调试目标不可用。'),
        h('div', { className: 'uts-diag-summary' },
          h('span', {
            className: 'uts-diag-overall',
            'data-uts-diag-overall': 'true',
            'data-uts-overall': overall.status,
            'data-uts-overall-reason': overall.reason || '',
            // 证据不删只收：本次 run / 就绪快照 / 副作用 / 实际调用 从可见文本挪到胶囊的悬停提示与
            // 机器可读属性上，界面保持干净但读得到同样的值。
            'data-uts-run-mode': run.mode || '',
            'data-uts-diag-updated-clock': updatedIso ? diagClock(updatedIso) : '',
            'data-uts-diag-side-effects': (run.sideEffects || []).map((effect) => effect.kind).join(','),
            'data-uts-diag-actual-calls': (run.actualCalls || []).map((call) => call.tool).join(','),
            title: [
              '状态：' + overallText,
              run.phase === 'running'
                ? '正在读取宿主事件流'
                : (run.mode ? '本轮：' + run.mode + (runTimeIso ? ' · ' + diagClock(runTimeIso) : '') : '尚无诊断记录'),
              updatedIso ? '就绪快照 ' + diagClock(updatedIso) : '',
              (run.sideEffects || []).length ? '副作用 ' + (run.sideEffects || []).map((effect) => effect.kind).join(' · ') : '',
              (run.actualCalls || []).length ? '实际调用 ' + (run.actualCalls || []).map((call) => call.tool).join(' · ') : '',
            ].filter(Boolean).join('；'),
            role: 'status',
          },
            h('i', { className: 'uts-diag-overall-dot', 'aria-hidden': true }),
            h('span', { 'data-uts-overall-text': 'true' }, overallText)),
          run.error
            ? h('p', { className: 'uts-diag-stale', 'data-uts-diag-error': 'true' }, run.error)
            : null,
          stateError
            ? h('p', { className: 'uts-diag-stale', 'data-uts-diag-error': 'true' },
              '就绪快照读取失败（不影响本轮结果）：' + stateError)
            : null,
          // 常驻动作：打开页面本身只做 observe（不启动浏览器），"开始诊断"才手动触发一轮 start。
          // 浏览器没在跑时由这一轮自己启动；已连接时只重新检查，不重启。run 进行中禁用，避免并发两轮。
          h('div', { className: 'uts-diag-action', 'data-uts-diag-action': 'start' },
            h('button', {
              type: 'button',
              className: 'uts-link-btn',
              'data-uts-diag-start': 'true',
              'data-uts-diag-run': 'start',
              'data-uts-action-disabled': runBusy ? 'true' : 'false',
              'data-uts-diag-action-note': runBusy ? 'busy' : coldBrowser || !hasConnection ? 'cold' : 'warm',
              // 说明文字不再占版面：搬到按钮的悬停提示里（三种分支同一套文案）。
              title: runBusy
                ? '本次诊断正在进行中，完成后再开始下一轮。'
                : (coldBrowser || !hasConnection
                  ? '会启动所选浏览器（' + (target.name || target.id) + '）并创建受管调试页；不会接管其它会话的标签。'
                  : '会重新执行五个阶段的检查，不会重启浏览器。'),
              disabled: runBusy,
              onClick: () => { if (!runBusy) startRun('start'); },
            }, '开始诊断'))),

        /* ① 实时调试拓扑：五节点 + 四条边（横排），全部取本次 run 的 stage 结果 */
        h('section', { className: 'uts-diag-panel', 'data-uts-diag-section': 'topology' },
          h('div', { className: 'uts-diag-panel-head' },
            h('h3', { className: 'uts-diag-panel-title' }, '调试流程')),
          h('div', { className: 'uts-diag-chain-scroll' },
            h('div', {
              className: 'uts-diag-chain',
              'data-uts-topology': 'true',
              'data-uts-topology-state': overall.status,
              'data-uts-run-phase': run.phase || 'idle',
            }, (() => {
              const cells = [h('div', {
                key: 'rail',
                className: 'uts-diag-rail',
                'data-uts-diag-rail': 'true',
                'aria-hidden': true,
              }, h('i', { className: 'uts-diag-rail-dot', 'data-uts-diag-rail-dot': 'true' }))];
              model.nodes.forEach((node, index) => {
                const stage = node.stage || null;
                const phase = (run.stagePhase || {})[String(node.index)] || 'idle';
                // 没有 run 结果时说「待诊断 / 诊断未完成」，有结果才用五态 + 原因码（中文在前、
                // 英文码在括号里，agent 仍可从 data-uts-stage-reason 读到原码）。
                const nodeStatusText = phase === 'running'
                  ? '检查中…'
                  : (runless || (diagStateLabel(node.state) + (stage && stage.reason ? ' · ' + diagReasonLabel(stage.reason) : '')));
                cells.push(h('div', {
                  key: 'node-' + node.index,
                  className: 'uts-diag-node',
                  'data-uts-node': String(node.index),
                  'data-uts-node-id': node.id,
                  'data-uts-node-state': node.state,
                  'data-uts-node-note': node.sub,
                  'data-uts-stage': String(node.index),
                  'data-uts-stage-status': node.state,
                  'data-uts-stage-phase': phase,
                  'data-uts-stage-reason': (stage && stage.reason) || '',
                  'data-uts-stage-blocked-by': stage && stage.blockedBy !== null && stage.blockedBy !== undefined ? String(stage.blockedBy) : '',
                  'data-uts-stage-duration': stage && stage.durationMs !== null && stage.durationMs !== undefined ? String(stage.durationMs) : '',
                  // 卡片里 name / 职责 / 状态都可能被截断：悬停给出完整四行，不留信息黑洞。
                  title: diagNodeTitle(node, nodeStatusText, stage, phase),
                },
                  h('div', { className: 'uts-diag-node-top' },
                    h('span', { className: 'uts-diag-node-index' }, '步骤 ' + node.index),
                    h('span', { className: 'uts-diag-node-glyph', 'aria-hidden': true }, diagNodeIcon(node.id))),
                  h('div', { className: 'uts-diag-node-role' }, node.role),
                  h('div', { className: 'uts-diag-node-name', 'data-uts-node-name': node.name, title: node.name }, node.name),
                  h('div', { className: 'uts-diag-node-sub', 'data-uts-node-sub': node.sub, title: node.sub }, node.sub),
                  h('div', { className: 'uts-diag-node-status' },
                    h('i', { className: 'uts-diag-dot', 'aria-hidden': true }),
                    h('span', { 'data-uts-node-status': node.state }, nodeStatusText))));
                const edge = model.edges[index];
                if (edge) {
                  cells.push(h('div', {
                    key: 'edge-' + edge.index,
                    className: 'uts-diag-edge',
                    'data-uts-edge': String(edge.index),
                    'data-uts-edge-state': edge.state,
                    'data-uts-edge-label': edge.label,
                    'data-uts-edge-live': edge.live ? 'true' : 'false',
                  },
                    h('span', { className: 'uts-diag-edge-line', 'aria-hidden': true },
                      h('i', { className: 'uts-diag-edge-dot', 'data-uts-edge-dot': 'true' })),
                    edge.state === 'FAIL'
                      ? h('span', { className: 'uts-diag-edge-break', 'aria-hidden': true }, '×')
                      : null,
                    h('span', { className: 'uts-diag-edge-label' }, edge.label)));
                }
              });
              return cells;
            })())),
          h('p', { className: 'uts-diag-flow' },
            '动画只跟随宿主事件回填：这一段开始检查时对应步骤脉冲，检查结束后该段静止；'
            + '只有本轮结论为「正常」的段才继续走球；结论是「异常」的，小球停在那个步骤上并写明原因。')),

        /* ② 六轴：来自 run-end.axes（原词表），没有 run 时才回退 readiness */
        h('section', { className: 'uts-diag-panel', 'data-uts-diag-section': 'axes' },
          h('div', { className: 'uts-diag-panel-head' },
            h('h3', { className: 'uts-diag-panel-title' }, '各模块诊断状态')),
          h('div', { className: 'uts-diag-axes', 'data-uts-axes': target.id || '' },
            axesSource.map((axis, order) => h('div', {
              key: axis.axis,
              className: 'uts-diag-axis',
              'data-uts-axis': axis.axis,
              'data-uts-status': axis.status,
              'data-uts-axis-order': String(order),
              'data-uts-axis-provider': target.id || '',
              'data-uts-axis-source': axis.source || 'readiness',
              'data-uts-axis-run-id': axis.runId || '',
              'data-uts-axis-target': axis.targetId || '',
              'data-uts-axis-checked-at': axis.checkedAt ? String(axis.checkedAt) : '',
              title: axisDetail(axis),
            },
              h('span', { className: 'uts-diag-axis-icon', 'aria-hidden': true }, diagAxisIcon(axis.axis)),
              h('div', { className: 'uts-diag-axis-body' },
                h('div', { className: 'uts-diag-axis-head' },
                  h('span', { className: 'uts-diag-axis-name' }, AXIS_LABEL[axis.axis] || axis.axis),
                  h('span', { className: 'uts-diag-axis-value' }, axisText(axis.axis, axis.status))),
                h('code', {
                  className: 'uts-diag-axis-reason',
                  'data-uts-axis-reason': axis.axis,
                  // 英文码单独留一个属性：界面上是「中文（code）」，agent 读这个属性拿纯码。
                  'data-uts-axis-reason-code': axis.reason || '',
                }, diagReasonLabel(axis.reason) || '无附加原因'),
                (() => {
                    // 六条探测逐行列出；完整列表（含英文 id）在悬停提示里。
                    // 没有检查项的卡片也渲染这块（空内容），保证六张卡片都按三行占位。
                    const rawChecks = axis.checks && typeof axis.checks === 'object' ? axis.checks : {};
                    const rows = Object.entries(rawChecks)
                      .map(([name, check]) => ({ name, status: String(check && check.status ? check.status : check) }));
                    // 界面上的检查项名与状态都写中文（只读求值：跳过），英文 id 留给属性与悬停提示。
                    const zh = rows.map((row) => diagTermLabel(row.name) + '：' + diagTermLabel(row.status));
                    // 一行一项、最多三行；还有几条用 `+n` 写在第三行末尾（完整列表见悬停提示）。
                    const shown = zh.slice(0, DIAG_CHECK_LINES);
                    const hidden = zh.length - shown.length;
                    const truncated = hidden > 0;
                    const pieces = shown.map((textValue, index) => {
                      const last = index === shown.length - 1;
                      if (!(truncated && last)) {
                        return h('span', { key: 'item-' + index, className: 'uts-diag-axis-checks-item' }, textValue);
                      }
                      // 「+n」单独一个 span：更小字号 + 更淡的颜色，读起来是计数标签，不是又一条描述。
                      return h('span', { key: 'item-' + index, className: 'uts-diag-axis-checks-item' },
                        textValue,
                        h('span', {
                          className: 'uts-diag-axis-checks-more',
                          'data-uts-axis-checks-more': String(hidden),
                        }, '+' + hidden));
                    });
                    return h('code', {
                      className: 'uts-diag-axis-checks',
                      'data-uts-axis-checks': axis.axis,
                      'data-uts-axis-checks-total': String(rows.length),
                      // agent 读纯英文对：readonly-eval: skip · target-list: skip · …
                      'data-uts-axis-checks-en': rows.map((row) => row.name + ': ' + row.status).join(' · '),
                      // 被省略的条数：界面上写成「+n」，外部断言可读这个值
                      'data-uts-axis-checks-truncated': truncated ? String(hidden) : '',
                      title: rows.map((row) => diagTermLabel(row.name) + '（' + row.name + '）：' + diagTermLabel(row.status)).join(' · '),
                    }, pieces);
                })()))))),

        /* ③ 诊断日志 + ④ 调试节点职责 */
        h('div', { className: 'uts-diag-bottom' },
          h('section', { className: 'uts-diag-panel', 'data-uts-diag-section': 'events' },
            h('div', { className: 'uts-diag-panel-head' },
              h('h3', { className: 'uts-diag-panel-title' }, '诊断日志')),
            h('div', {
              className: 'uts-diag-events',
              'data-uts-events': 'true',
              'data-uts-event-count': String((run.events || []).length),
            },
              rows.length
                ? rows.map((row) => {
                  // Host 的时间戳是 Date.now() 的数字，先统一转 ISO，否则 `diagClock` 解析失败 →
                  // 每行都显示 `--:--:--`。DOM 属性也写 ISO，方便外部核对。
                  const atIso = diagIsoAt(row.at);
                  const observedIso = diagIsoAt(run.finishedAt);
                  // run-start 不是检查结果，别拿「未知」冒充状态：文案「开始」+ INFO 中性灰点。
                  const statusKey = row.kind === 'run-start' ? 'INFO' : row.status;
                  const statusText = row.kind === 'run-start' ? '开始' : diagStateLabel(row.status);
                  return h('div', {
                    key: 'event-' + (row.seq || 0),
                    className: 'uts-diag-event',
                    'data-uts-event': 'true',
                    'data-uts-event-kind': row.kind,
                    'data-uts-event-axis': row.operation,
                    'data-uts-event-time': atIso,
                    'data-uts-event-time-source': 'host',
                    'data-uts-event-host-checked-at': atIso,
                    'data-uts-event-observed-at': observedIso,
                    'data-uts-event-from': '',
                    'data-uts-event-to': statusKey,
                    'data-uts-event-status': statusKey,
                    'data-uts-event-run-id': row.runId || '',
                    'data-uts-event-seq': String(row.seq || ''),
                    'data-uts-event-operation': row.operation,
                    'data-uts-event-evidence-ref': row.evidenceRef || '',
                    // 英文码单独留属性（agent 读纯码），可见文本走中英对照。
                    'data-uts-event-reason': row.reason || '',
                    title: diagOperationLabel(row.operation) + ' · ' + statusText + (row.reason ? ' · ' + diagReasonLabel(row.reason) : ''),
                  },
                    // SKIPPED 阶段从未执行，Host 就没有 finishedAt：显示「—」而不是假时间或占位符。
                    h('time', { className: 'uts-diag-event-time' }, atIso ? diagClock(atIso) : '—'),
                    h('i', { className: 'uts-diag-event-pin', 'data-uts-event-status': statusKey, 'aria-hidden': true }),
                    h('div', { className: 'uts-diag-event-text' },
                      diagOperationLabel(row.operation) + ' · ' + statusText
                      + (row.reason ? ' · ' + diagReasonLabel(row.reason) : '')
                      // 上游阻塞：写中文，英文键 blockedBy 只留在属性与 NDJSON 里。
                      + (row.blockedBy ? ' · 阻塞于第 ' + row.blockedBy + ' 段' : '')
                      + ' · ' + (row.durationMs === null || row.durationMs === undefined ? '—' : Math.round(row.durationMs * 10) / 10 + 'ms')));
                })
                : h('p', { className: 'uts-diag-empty', 'data-uts-events-empty': 'true' }, '尚未取得宿主诊断结果'))),
          h('section', { className: 'uts-diag-panel', 'data-uts-diag-section': 'duties' },
            h('div', { className: 'uts-diag-panel-head' },
              h('h3', { className: 'uts-diag-panel-title' }, '步骤职责')),
            h('div', { className: 'uts-diag-duties', 'data-uts-duties': 'true' },
              model.duties.map((duty) => h('div', {
                key: 'duty-' + duty.node,
                className: 'uts-diag-duty',
                'data-uts-duty': 'true',
                'data-uts-duty-node': duty.node,
              },
                h('span', { className: 'uts-diag-duty-arrow', 'aria-hidden': true }, '↗'),
                h('span', { className: 'uts-diag-duty-text' },
                  h('strong', null, duty.name),
                  ' ' + duty.text)))))));
    }

    /**
     * 诊断弹层（DSH 的 frame-wide `shell.overlay` 插槽）。
     *
     * 设置弹层太窄，横排五节点链路放不下；这里用一个独立的全宽覆盖层。插槽层本身是
     * click-through，所以条目自己开 `pointer-events`。关闭方式：✕ 按钮、Esc、点遮罩；
     * 关闭即中止进行中的 run（内容组件卸载时 abort）。
     */
    function DiagnosticsOverlay() {
      const overlay = useDiagnosticsOverlay();
      const open = overlay.open === true;
      const closeRef = React.useRef(null);
      React.useEffect(() => {
        if (!open) return undefined;
        const trigger = overlay.trigger;
        const previousOverflow = document.body.style.overflow;
        document.body.style.overflow = 'hidden';
        const onKeyDown = (event) => {
          if (event.key === 'Escape' || event.key === 'Esc') {
            event.stopPropagation();
            event.preventDefault();
            closeDiagnostics();
          }
        };
        document.addEventListener('keydown', onKeyDown, true);
        const focusTimer = setTimeout(() => {
          if (closeRef.current && typeof closeRef.current.focus === 'function') closeRef.current.focus();
        }, 0);
        return () => {
          document.removeEventListener('keydown', onKeyDown, true);
          document.body.style.overflow = previousOverflow;
          clearTimeout(focusTimer);
          if (trigger && trigger.isConnected && typeof trigger.focus === 'function') trigger.focus();
        };
      }, [open, overlay.trigger]);
      if (!open) return null;
      const group = TARGET_ENV_GROUPS.find((item) => item.id === overlay.groupId)
        || { id: overlay.groupId, title: overlay.groupId, targets: [] };
      const target = (group.targets || []).find((item) => item.id === overlay.providerId)
        || { id: overlay.providerId, name: overlay.providerId, state: 'planned' };
      const titleText = (target.name || target.id) + ' 诊断';
      const tag = target.state === 'preview' ? '纯视口' : target.state === 'supported' ? '已实现' : target.state === 'unsupported' ? '未支持' : '未接入';
      const tree = h('div', {
        className: 'uts-diag-modal-overlay',
        'data-uts-diag-modal-overlay': 'true',
        onClick: (event) => {
          if (event.target === event.currentTarget) closeDiagnostics();
        },
      },
        h('div', {
          className: 'uts-diag-modal-panel',
          'data-uts-diag-modal': target.id || '',
          role: 'dialog',
          'aria-modal': 'true',
          'aria-label': titleText,
          onClick: (event) => event.stopPropagation(),
        },
          h('header', { className: 'uts-diag-modal-head' },
            h('div', { className: 'uts-diag-modal-title' },
              h('h2', { className: 'uts-page-title' }, titleText),
              h('span', { className: 'uts-tag', 'data-uts-tag': target.state || 'planned' }, tag)),
            h('button', {
              type: 'button',
              className: 'uts-link-btn uts-diag-modal-close',
              'data-uts-diagnostics-back': 'true',
              ref: closeRef,
              onClick: () => closeDiagnostics(),
            }, '关闭')),
          h('div', { className: 'uts-diag-modal-body' },
            h(TargetEnvDiagnostics, { group, target }))));
      // `shell.overlay` items can end up inside a stacking context that sits below the settings
      // modal; portalling to <body> is the only placement that is reliably on top.
      if (reactDom && typeof reactDom.createPortal === 'function' && typeof document !== 'undefined') {
        return reactDom.createPortal(tree, document.body);
      }
      return tree;
    }

    /**
     * 设置页正文（DSH 设置弹层的独立分区）。标题/描述在这里渲染，因为 settings.section
     * 只提供导航标签，不提供页面标题；下面才是「目标环境配置」分组。
     * 配置真值来自 Host：读取失败显示 `[data-uts-config-error]`，启用开关按 revision 提交。
     */
    function TargetEnvSettingsPage() {
      const hostConfig = useHostConfig(null, 'global');
      const state = hostConfig.state;
      const [hideUnimplemented, setHideUnimplemented] = React.useState(false);
      const [expanded, setExpanded] = React.useState(readExpandedGroups);
      const [submittingEnv, setSubmittingEnv] = React.useState('');
      const [submittingProvider, setSubmittingProvider] = React.useState('');
      const [notice, setNotice] = React.useState(null);
      // 二级诊断页：记录 (环境, 运行环境)，为空时显示环境分组列表。
      const [diagnosing, setDiagnosing] = React.useState(null);
      const aliveRef = React.useRef(true);
      React.useEffect(() => () => { aliveRef.current = false; }, []);
      const configReady = state.revision !== null && !state.error;
      const groups = hideUnimplemented
        ? TARGET_ENV_GROUPS.map((group) => ({ ...group, targets: group.targets.filter((target) => target.state === 'supported') }))
          .filter((group) => group.targets.length > 0)
        : TARGET_ENV_GROUPS;
      function toggleGroup(id) {
        setExpanded((current) => {
          const next = Object.assign({}, current);
          if (next[id]) delete next[id];
          else next[id] = true;
          writeExpandedGroups(next);
          return next;
        });
      }
      function toggleEnvironment(group, next) {
        if (!configReady || submittingEnv) return;
        setSubmittingEnv(group.id);
        setNotice(null);
        putHostConfig({ environments: { [group.id]: { enabled: next } } }, state.revision).then((payload) => {
          if (!aliveRef.current) return;
          const merged = hostConfig.adopt(payload);
          if (payload.config === undefined) hostConfig.reload();
          publishHostConfigChange();
          setSubmittingEnv('');
          setNotice(merged.error
            ? { kind: 'error', text: configErrorText(merged.error) }
            : { kind: 'ok', text: (next ? '已启用 ' : '已禁用 ') + group.title + ' · revision ' + merged.revision });
        }).catch((error) => {
          if (!aliveRef.current) return;
          setSubmittingEnv('');
          if (error && error.code === 'CONFIG_CONFLICT') {
            adoptHostConflict(hostConfig, error);
            setNotice({
              kind: 'conflict',
              text: '配置已被其他窗口修改（CONFIG_CONFLICT）；已按最新 revision 重新读取，本次切换未保存',
            });
            return;
          }
          setNotice({
            kind: 'error',
            text: '保存失败，已回滚为宿主当前值：' + (configErrorText(error && error.message) || '未知错误'),
          });
        });
      }
      /**
       * 运行环境分开关：只写 `environments.<env>.providers.<id>.enabled`，与总开关互不影响。
       * 关闭总开关时不会调用这里，因此各 provider 的已保存值保持不变。
       */
      function toggleProvider(group, providerId, next) {
        if (!configReady || submittingEnv || submittingProvider) return;
        setSubmittingProvider(providerId);
        setNotice(null);
        const patch = { environments: { [group.id]: { providers: { [providerId]: { enabled: next } } } } };
        putHostConfig(patch, state.revision).then((payload) => {
          if (!aliveRef.current) return;
          const merged = hostConfig.adopt(payload);
          if (payload.config === undefined) hostConfig.reload();
          publishHostConfigChange();
          setSubmittingProvider('');
          const target = (group.targets || []).find((item) => item.id === providerId);
          const name = target && target.name ? target.name : providerId;
          setNotice(merged.error
            ? { kind: 'error', text: configErrorText(merged.error) }
            : { kind: 'ok', text: (next ? '已启用运行环境 ' : '已禁用运行环境 ') + name + ' · revision ' + merged.revision });
        }).catch((error) => {
          if (!aliveRef.current) return;
          setSubmittingProvider('');
          if (error && error.code === 'CONFIG_CONFLICT') {
            adoptHostConflict(hostConfig, error);
            setNotice({
              kind: 'conflict',
              text: '配置已被其他窗口修改（CONFIG_CONFLICT）；已按最新 revision 重新读取，本次切换未保存',
            });
            return;
          }
          setNotice({
            kind: 'error',
            text: '保存失败，已回滚为宿主当前值：' + (configErrorText(error && error.message) || '未知错误'),
          });
        });
      }
      const errorText = notice && notice.kind !== 'ok' ? notice.text : state.error;
      return h('section', {
        className: 'uts-settings',
        'data-uts-settings': 'page',
        'data-uts-hide-unimplemented': String(hideUnimplemented),
        'data-uts-config-revision': state.revision === null ? '' : String(state.revision),
        'data-uts-config-status': state.error ? 'error' : state.revision === null ? 'loading' : 'ready',
      },
        h('style', null, TARGET_ENV_CSS),
        h('header', { className: 'uts-head' },
          h('div', { className: 'uts-head-row' },
            h('h2', { className: 'uts-page-title' }, 'UI 测试'),
            // 不再提供「重新读取」按钮：面板一打开就会自动读一次 Host 配置
            // （useHostConfig 挂载即 GET /config?view=global），CONFIG_CONFLICT 时也会自动 adopt/reload。
            h('div', { className: 'uts-config-actions' },
              h('div', { className: 'uts-filter' },
                h('span', null, '隐藏未实现'),
                h(TargetEnvSwitch, { label: '隐藏未实现', checked: hideUnimplemented, onChange: setHideUnimplemented })))),
          h('p', { className: 'uts-page-desc' }, '面向 DeepSeekHarness 的前端 GUI 调试与测试插件：Web / Chromium 已实现；Windows/Linux/macOS 桌面、Android、TUI、HarmonyOS、小程序、游戏与 3D 共九种调试环境规划中。'),
          errorText
            ? h('p', {
                className: 'uts-config-error',
                role: 'alert',
                'data-uts-config-error': notice && notice.kind ? notice.kind : 'read',
              }, errorText)
            : null,
          notice && notice.kind === 'ok'
            ? h('p', { className: 'uts-config-meta', role: 'status', 'data-uts-config-notice': 'ok' }, notice.text)
            : null),
        h('div', { className: 'uts-body' },
          h('div', { className: 'uts-groups' }, groups.length
            ? groups.map((group) => {
                const axes = environmentAxes(state, group.id);
                const targetAxis = axes.find((axis) => axis.axis === 'target') || { status: 'not-probed', reason: '' };
                const readinessEntry = state.readiness ? state.readiness[group.id] : null;
                return h(TargetEnvGroup, {
                  key: group.id,
                  group,
                  axes,
                  checkedAt: readinessEntry ? readinessEntry.checkedAt : '',
                  expanded: expanded[group.id] === true,
                  onToggle: toggleGroup,
                  envEnabled: enabledFromConfig(state.config, group.id) === true,
                  providers: providersFromConfig(state.config, group.id),
                  currentProvider: currentProviderFromState(state),
                  configReady,
                  configError: state.loading ? '正在读取宿主配置…' : state.error,
                  busy: submittingEnv === group.id || submittingProvider !== '',
                  targetAxis,
                  onDiagnose: (providerId, trigger) => openDiagnostics(group.id, providerId, trigger),
                  onToggleEnv: (next) => toggleEnvironment(group, next),
                  onToggleProvider: (providerId, next) => toggleProvider(group, providerId, next),
                });
              })
            : h('p', { className: 'uts-empty' }, '暂无已实现的目标'))));
    }
