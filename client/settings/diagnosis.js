    const SETTINGS_EXPANDED_KEY = 'dsh.ui-testing.settings.expanded';
    const AXIS_ORDER = ['support', 'enabled', 'dependency', 'connection', 'target', 'capability'];
    const AXIS_LABEL = {
      support: '工程支持', enabled: '用户启用', dependency: '依赖可用',
      connection: '连接可信', target: '目标绑定', capability: '能力就绪',
    };
    /** M0 §5.2 status vocabulary → the short text the page shows. Unknown values fall through. */
    const AXIS_TEXT = {
      support: { supported: '已实现', unsupported: '未支持', planned: '未接入', 'not-probed': '未探测' },
      enabled: { true: '已启用', false: '未启用', 'not-probed': '未知' },
      dependency: { ok: '可用', degraded: '降级', failed: '不可用', 'not-probed': '未探测' },
      connection: { ok: '可信', failed: '失败', 'not-probed': '未探测' },
      target: { bound: '已绑定', unbound: '未绑定', stale: '已失效', 'not-probed': '未探测' },
      capability: { available: '可用', partial: '部分可用', unavailable: '不可用', unsupported: '不支持', 'not-probed': '未探测' },
    };
    function axisText(axis, status) {
      const table = AXIS_TEXT[axis] || {};
      return table[status] || status || '未知';
    }

    /** One-line, human-readable detail for an axis tooltip (never invents missing facts). */
    function axisDetail(axis) {
      const parts = [];
      if (axis.targetId) parts.push('目标 ' + axis.targetId);
      if (axis.checkedAt) {
        const at = new Date(axis.checkedAt);
        parts.push('检查时间 ' + (Number.isNaN(at.getTime()) ? String(axis.checkedAt) : at.toISOString()));
      }
      if (axis.evidenceKind) parts.push('证据 ' + axis.evidenceKind);
      if (axis.checks && typeof axis.checks === 'object') {
        // readiness 轴历史上的 check 用 `ok`，诊断 run 的探测用 `pass`：两种都算通过（大小写不敏感），
        // 只有真正没通过的项才列进提示，别再把「六条全 pass」说成「未通过」。
        const statusOf = (check) => {
          if (typeof check === 'string') return check;
          if (check && typeof check === 'object' && typeof check.status === 'string') return check.status;
          return '';
        };
        const passed = (status) => ['ok', 'pass'].includes(String(status || '').toLowerCase());
        const rows = Object.entries(axis.checks).map(([name, check]) => ({
          name,
          status: statusOf(check),
          reason: check && typeof check === 'object' ? check.reason || '' : '',
        }));
        const failed = rows.filter((row) => !passed(row.status));
        if (failed.length) {
          parts.push('未通过 ' + failed.map((row) => row.name + '=' + (row.status || 'unknown') + (row.reason ? '(' + row.reason + ')' : '')).join(', '));
        } else if (rows.length) {
          parts.push('全部通过 ' + rows.map((row) => row.name + '=' + row.status).join(', '));
        }
      }
      return parts.join(' · ');
    }

    /* ---- Provider diagnostics page: topology / six axes / event stream / duties ---------------- */

    /**
     * Prototype display order for the six axes on the diagnostics page. `AXIS_ORDER` stays the
     * data/probe order (other code and the acceptance script read it), this one is presentation
     * only: it reorders the same six keys, it never adds or drops an axis.
     */
    const DIAG_AXIS_ORDER = ['support', 'target', 'enabled', 'capability', 'dependency', 'connection'];
    /** Diagnostics page polls the existing `/config?view=global`; no new Host endpoint. */
    const DIAG_POLL_MS = 5000;
    const DIAG_EVENT_LIMIT = 30;
    const DIAG_EVENT_ROWS = 8;

    /** Node ids are fixed by the prototype: five logical links from agent to target. */
    const DIAG_DUTY_TEXT = {
      agent: '理解任务目标，发起工具调用并消费诊断结果',
      controller: '统一调度，选择能力与执行路径',
      interface: '通过通信接口传递命令、事件与会话数据',
      backend: '调用浏览器调试执行后端执行操作',
      target: '提供实际运行状态与调试证据',
    };

    /** 14px inline SVG per axis/node — inline paths, never an external font, image or sprite. */
    function diagSvg(children) {
      return h('svg', {
        width: 14, height: 14, viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor',
        strokeWidth: 1.7, strokeLinecap: 'round', strokeLinejoin: 'round', 'aria-hidden': true,
      }, ...children);
    }
    function diagAxisIcon(axisKey) {
      if (axisKey === 'support') {
        return diagSvg([h('path', { key: 'a', d: 'm12 3 8 4v5c0 5-3.5 8-8 9-4.5-1-8-4-8-9V7l8-4Z' }),
          h('path', { key: 'b', d: 'm8 12 2.5 2.5L16 9' })]);
      }
      if (axisKey === 'target') {
        return diagSvg([h('path', { key: 'a', d: 'M10 13a5 5 0 0 0 7.1 0l2-2a5 5 0 0 0-7.1-7.1l-1.1 1.1' }),
          h('path', { key: 'b', d: 'M14 11a5 5 0 0 0-7.1 0l-2 2A5 5 0 0 0 12 20.1l1.1-1.1' })]);
      }
      if (axisKey === 'enabled') {
        return diagSvg([h('circle', { key: 'a', cx: 12, cy: 12, r: 9 }), h('path', { key: 'b', d: 'M12 7v5l3 2' })]);
      }
      if (axisKey === 'capability') {
        return diagSvg([h('path', { key: 'a', d: 'M4 5h16v14H4z' }),
          h('path', { key: 'b', d: 'M8 9h8M8 12.5h5M8 16h7' })]);
      }
      if (axisKey === 'dependency') {
        return diagSvg([h('circle', { key: 'a', cx: 12, cy: 12, r: 4 }),
          h('path', { key: 'b', d: 'M12 3v3M5.6 5.6l2.1 2.1M3 12h3M5.6 18.4l2.1-2.1M12 18v3M18.4 18.4l-2.1-2.1M18 12h3M18.4 5.6l-2.1 2.1' })]);
      }
      return diagSvg([h('path', { key: 'a', d: 'M12 3 20 7v5c0 4.5-3.2 7.5-8 9-4.8-1.5-8-4.5-8-9V7l8-4Z' }),
        h('path', { key: 'b', d: 'M9 12h6' })]);
    }
    function diagNodeIcon(nodeId) {
      if (nodeId === 'agent') {
        return diagSvg([h('path', { key: 'a', d: 'M12 3 14 8l5-2-2 5 4 3-5 1-1 5-3-4-5 2 2-5-4-3 5-1 2-5Z' }),
          h('circle', { key: 'b', cx: 12, cy: 12, r: 2 })]);
      }
      if (nodeId === 'controller') {
        return diagSvg([h('rect', { key: 'a', x: 4, y: 4, width: 16, height: 16, rx: 3 }),
          h('path', { key: 'b', d: 'M8 9h8M8 13h5M8 17h8' })]);
      }
      if (nodeId === 'interface') {
        return diagSvg([h('path', { key: 'a', d: 'M8 8 4 12l4 4M16 8l4 4-4 4M14 5l-4 14' })]);
      }
      if (nodeId === 'backend') {
        return diagSvg([h('rect', { key: 'a', x: 3, y: 4, width: 18, height: 13, rx: 2 }),
          h('path', { key: 'b', d: 'M8 21h8M12 17v4M7 9h4M7 12h8' })]);
      }
      return diagSvg([h('circle', { key: 'a', cx: 12, cy: 12, r: 8 }),
        h('path', { key: 'b', d: 'M4 12h16M12 4a13 13 0 0 1 0 16M12 4a13 13 0 0 0 0 16' })]);
    }

    /**
     * A Host readiness `checkedAt` (ms number, numeric string or ISO string) as an ISO string, or
     * `''` when the value cannot be parsed. Timestamps are never invented: an unusable value shows
     * as `--:--:--` instead of the current clock.
     */
    function diagIsoAt(value) {
      if (value === null || value === undefined || value === '') return '';
      const numeric = typeof value === 'number' ? value : (/^\d{6,}$/u.test(String(value)) ? Number(value) : null);
      const at = numeric === null ? new Date(String(value)) : new Date(numeric);
      return Number.isNaN(at.getTime()) ? '' : at.toISOString();
    }
    /** `HH:MM:SS` for the local clock; `--:--:--` when the timestamp is missing or unparseable. */
    function diagClock(iso) {
      const at = new Date(String(iso || ''));
      if (!iso || Number.isNaN(at.getTime())) return '--:--:--';
      const pad = (value) => String(value).padStart(2, '0');
      return pad(at.getHours()) + ':' + pad(at.getMinutes()) + ':' + pad(at.getSeconds());
    }
    /**
     * The machine-readable shape of a non-ready node: the Host's own reason code when it sent one
     * (`no-target`, `executable-missing`, `provider-not-selected`, …), else `<axis>-<status>`.
     */
    function diagReasonCode(axisKey, axis) {
      const reason = axis && axis.reason ? String(axis.reason).trim() : '';
      if (/^[a-z][a-z0-9-]{1,}$/iu.test(reason)) return reason;
      return axisKey + '-' + ((axis && axis.status) || 'not-probed');
    }
    /** What a node says under its name: the Host's reason code, else the axis status text. */
    function diagStatusText(axisKey, axis) {
      const reason = axis && axis.reason ? String(axis.reason).trim() : '';
      if (/^[a-z][a-z0-9-]{1,}$/iu.test(reason)) return reason;
      if (axis && axis.status) return axisText(axisKey, axis.status);
      return '未探测';
    }

    /* ---- Provider diagnostics: one real Host run (NDJSON) → five states ------------------ */

    /**
     * 五态：本页所有节点/边只说这五个词，且只由 Host 的 stage 事件决定。
     *
     * 中文按英语状态本身直译，**不用**「待处理」这类动作语气：`WARN` 是本次 run 已经得出的
     * 结论（后面紧跟 `provider-mismatch`、`executable-missing` 这类原因码），写成「待处理」
     * 会被读成「还没点开始诊断」。还没跑出结论的那一屏另有独立说法（`待诊断` / `诊断未完成`），
     * 见 `diagRunlessText`，与五态不共用词。
     */
    const DIAG_STATES = ['PASS', 'WARN', 'FAIL', 'SKIPPED', 'UNKNOWN'];
    const DIAG_STATE_TEXT = { PASS: '正常', WARN: '警告', FAIL: '异常', SKIPPED: '跳过', UNKNOWN: '未知' };
    const DIAG_STAGE_IDS = ['1', '2', '3', '4', '5'];
    const DIAG_RUN_ROWS = 8;
    /** 能力就绪的检查项最多显示三行；每张卡片都按三行占位（悬停看全部）。 */
    const DIAG_CHECK_LINES = 3;
    /** 最近一次 run，按 envId/providerId 保留：重进诊断页显示它，但不重放动画、不自动重跑。 */
    const DIAG_RUNS = new Map();
    const diagRunKey = (groupId, providerId) => (groupId || '') + '/' + (providerId || '');
    /**
     * 五态在界面上**只写中文**：大写状态码是给调用方 agent 的，留在 `data-uts-*-state` 属性与
     * NDJSON 里，不挤进可见文案。没有中文的非五态值（如事件流的 `INFO`）原样返回，不编造。
     */
    function diagStateLabel(state) {
      const key = String(state || '').toUpperCase();
      return DIAG_STATE_TEXT[key] || String(state || '');
    }
    /**
     * 还没有 run 结果时的说法，**不是第六个状态**，只是「本轮还没有结论」：
     * `待诊断` = 这一屏还没跑过任何 run；`诊断未完成` = 跑过但没拿到结果（错误另起一行说明）。
     * 有结论时返回空串，调用方回落到五态文案。这样「没开始」和「已经诊断出问题」用词不同，
     * 不会再把 `WARN · provider-mismatch` 读成「等你操作」。
     */
    function diagRunlessText(run) {
      const current = run || {};
      if ((current.events || []).length) return '';
      if (current.phase === 'running') return '';
      return current.error ? '诊断未完成' : '待诊断';
    }

    /**
     * 状态码的中英对照：**英文码是 Host 的机器契约**（`data-uts-*`、NDJSON、工具返回值里一律
     * 保持原样，agent 直接读），**中文只给前端客户看**。界面上渲染成 `中文（english-code）`，
     * 两种写法同时在场：人读得懂，agent 也解析得到。
     *
     * 收录范围 = 诊断页可能出现的一切码：① `integration/diagnose.js` 五阶段的原因；
     * ② 就绪六轴来自 `core/readiness.js` / `integration/cross-environment.js` 的原因；
     * ③ 页面自身造的两个（`no-run`、`run-in-progress`）。工具级错误码（`index.js` 里的
     * `reason`）不进这张表——它们不出现在本页。
     *
     * 表没收录的码**不猜**：原样显示英文；`tool-call-*`、`stage-<n>` 这两个动态族按前缀兜底。
     * 词表与 `docs/diagnose-reason-codes.md` 必须逐条一致，由
     * `tests/contracts/diagnose-status-text.test.mjs` 强制。
     */
    const DIAG_REASON_ZH = {
      // ① 诊断 run 的五个阶段
      'scope-unresolved': '无法确定当前作用域（不知道要查哪个工作区）',
      'registration-unreadable': '读取工具注册信息失败',
      'registration-broken': '工具声明与实际注册对不上',
      'tool-call-not-attempted': '没能发起工具调用',
      'tool-call-failed': '工具调用失败',
      'tool-not-admitted': '本作用域未放行这些工具',
      'config-invalid': '宿主配置无效',
      'adapter-unresolved': '没取到该运行环境的执行适配器',
      'no-runtime-entry': '插件还没建立运行时入口',
      'busy': '插件正在处理别的操作，稍后再试',
      'browser-not-running': '浏览器未运行',
      'provider-mismatch': '实际在跑的浏览器与所选运行环境不一致',
      'cdp-protocol-error': '浏览器调试协议返回错误',
      'cancelled': '本轮检查已被取消',
      'executable-missing': '没找到该浏览器的可执行文件',
      'identity-mismatch': '启动起来的浏览器不是所选的那一个',
      'identity-unverified': '拿不到浏览器版本信息，无法确认身份',
      'blocked-by-provider-mismatch': '上游运行环境不一致，这一段没执行',
      'blocked-by-stage-1': '第 1 段未通过，这一段没执行',
      'blocked-by-stage-2': '第 2 段未通过，这一段没执行',
      'environment-has-no-execution-adapter': '该环境只有视图（`status: view`），没有 Agent 执行适配器',
      'blocked-by-stage-3': '第 3 段未通过，这一段没执行',
      'stage-timeout': '这一段超时，没拿到结果',
      'target-list-failed': '读取标签页列表失败',
      'no-bound-target': '还没有绑定调试目标',
      'readonly-eval-failed': '只读求值失败（在页面里跑只读脚本出错）',
      'readonly-eval-unexpected': '只读求值的结果不是预期的 1',
      'target-not-in-list': '目标已不在标签页列表里（可能已被关闭）',
      'capability-partial': '部分能力不可用',
      // ② 就绪六轴（readiness / cross-environment / 运行环境自身）
      'not-probed': '未探测',
      'probe-failed': '探测失败',
      'environment-disabled': '环境总开关已关闭',
      'adapter-not-registered': '该环境还没接入适配器',
      'no-capabilities': '没有上报能力清单',
      'no-runtime': '宿主里还没有这个环境的运行时',
      'no-target': '还没有目标',
      'target-not-bound': '目标未绑定',
      'target-unbound': '目标已解绑',
      'target-gone': '调试目标已消失',
      'cdp-not-attached': '还没连上浏览器调试端口',
      'collector-missing': '缺少网络采集器',
      'frame-source-missing': '没有可用的帧来源',
      'input-unsupported': '该浏览器后端不支持模拟输入',
      'provider-not-selected': '未选择该运行环境',
      'provider-disabled': '该运行环境已停用',
      'provider-driver-pending': '该运行环境的驱动待接入',
      'provider-not-implemented': '该运行环境尚未实现',
      'provider-dependency-not-verified': '还没验证该运行环境的依赖',
      'provider-missing': '没有这个运行环境',
      'capability-disabled': '该能力已关闭',
      'capability-unknown': '未知的能力名',
      'cold': '浏览器还没启动',
      'host-idle-no-transport': '宿主空闲，没有可用的传输通道',
      'session-missing': '调试会话已不存在',
      'no-session': '没有调试会话',
      'aborted': '已中止',
      // core/contracts.js 的 WEB_PROVIDER_REASONS（驱动拒绝 / 就绪 / 工具错误共用同一批拼写）
      'driver-pending': '该运行环境的驱动待接入',
      'unknown-provider': '没有这个运行环境',
      'provider-unsupported': '该运行环境不受支持',
      'override-invalid': '指定的浏览器路径不可用',
      // ③ 页面自身造的状态（不是 Host 的码）
      'no-run': '还没有诊断结果',
      'run-in-progress': '诊断进行中',
    };
    /**
     * 术语对照：这些词在**界面上一律用中文**，英文原样只留在 `data-uts-*`、NDJSON 和代码里
     * （agent 与排障用）。翻译按上下文取用户能看懂的词，不做字对字直译。
     */
    const DIAG_TERM_ZH = {
      'run': '本轮',
      'Host': '宿主',
      'Failed to fetch': '连不上宿主（请求失败）',
      'stage-start': '阶段开始',
      'stage-end': '阶段结束',
      'readonly-eval': '只读求值',
      'target-list': '目标列表',
      'snapshot': '快照',
      'screenshot': '截图',
      'computed-style': '计算样式',
      'network-read': '网络记录',
      'pass': '通过',
      'fail': '失败',
      'skip': '跳过',
      'ok': '通过',
      'PASS': '正常',
    };
    /** 术语 / 原因码 / 检查项 → 中文；都没有译文时原样返回英文。 */
    function diagTermLabel(term) {
      const key = String(term || '').trim();
      if (!key) return '';
      if (Object.prototype.hasOwnProperty.call(DIAG_TERM_ZH, key)) return DIAG_TERM_ZH[key];
      return diagReasonLabel(key);
    }
    /** 码 → 中文；动态族按前缀兜底，未收录返回空串（调用方原样显示英文）。 */
    function diagReasonZh(code) {
      const key = String(code || '').trim();
      if (!key) return '';
      if (Object.prototype.hasOwnProperty.call(DIAG_REASON_ZH, key)) return DIAG_REASON_ZH[key];
      if (/^tool-call-/u.test(key)) return '工具调用失败';
      if (/^stage-\d$/u.test(key)) return '该段没有给出原因';
      return '';
    }
    /**
     * 原因码在界面上**只写中文**；英文原码是给调用方 agent 的，留在 `data-uts-stage-reason` /
     * `data-uts-axis-reason-code` / `data-uts-event-reason` 与 NDJSON 的 `reason` 里。
     * 没有译文时原样显示英文码，绝不编造中文。
     */
    function diagReasonLabel(code) {
      const key = String(code || '').trim();
      if (!key) return '';
      return diagReasonZh(key) || key;
    }
    /* ---- Diagnostics overlay (frame-wide `shell.overlay`) ---------------------------------- */
    // The diagnostics page used to live inside the settings modal, which is far too narrow for the
    // five-node chain. It now opens in its own frame-wide overlay; the settings page only keeps the
    // entry buttons. State is module-level so both entry points live in the same bundle.
    const diagOverlayStore = {
      state: { open: false, groupId: '', providerId: '', trigger: null },
      listeners: new Set(),
    };
    function diagOverlayGet() { return diagOverlayStore.state; }
    function diagOverlaySet(next) {
      diagOverlayStore.state = Object.assign({}, diagOverlayStore.state, next);
      for (const listener of Array.from(diagOverlayStore.listeners)) {
        try { listener(); } catch { /* ignore */ }
      }
    }
    function diagOverlaySubscribe(listener) {
      diagOverlayStore.listeners.add(listener);
      return () => { diagOverlayStore.listeners.delete(listener); };
    }
    function openDiagnostics(groupId, providerId, trigger) {
      // Prefer the element that actually opened the overlay (the card button): a keyboard/secondary
      // activation may leave document.activeElement on <body>, and focus must come back to the card.
      const active = trigger || (typeof document !== 'undefined' ? document.activeElement : null);
      diagOverlaySet({ open: true, groupId: groupId || '', providerId: providerId || '', trigger: active || null });
    }
    function closeDiagnostics() {
      diagOverlaySet({ open: false });
    }
    function useDiagnosticsOverlay() {
      if (typeof React.useSyncExternalStore === 'function') {
        return React.useSyncExternalStore(diagOverlaySubscribe, diagOverlayGet, diagOverlayGet);
      }
      const [state, setState] = React.useState(diagOverlayGet);
      React.useEffect(() => diagOverlaySubscribe(() => setState(diagOverlayGet())), []);
      return state;
    }

    const diagEmptyRun = (providerId) => ({
      runId: '', provider: providerId || '', mode: '', phase: 'idle',
      events: [], stages: {}, stagePhase: {}, axes: null, overall: null,
      actualCalls: [], sideEffects: [], configRevision: null,
      startedAt: null, finishedAt: null, error: '',
    });

    function diagRequestId() {
      try {
        if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') return crypto.randomUUID();
      } catch { /* fall through */ }
      return 'diag-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 10);
    }

    /**
     * Start one real diagnosis run and stream its NDJSON events.
     *
     * `observe` (default) never starts a browser; `start` is only used after the user explicitly
     * asks for it. The caller owns the AbortController: leaving the page aborts the stream (the
     * Host then stops the run — it does not keep executing behind a closed page).
     */
    async function startDiagnoseRun({ provider, environment, mode, signal, onEvent }) {
      const response = await fetch(HOST_BASE + '/diagnose', {
        method: 'POST',
        credentials: 'same-origin',
        cache: 'no-store',
        // `/diagnose` is a scoped-GUI surface (an unscoped call is 401 by design). The settings page
        // works on the global/default scope, so it asks for `unassigned` explicitly and never lets
        // the Host guess with `recent`.
        headers: {
          'content-type': 'application/json',
          'X-UI-Testing-Scope-Version': SCOPE_VERSION,
          'X-UI-Testing-Scope': 'unassigned',
        },
        // `environment` 是"要诊断哪个目标环境"：诊断不该被面板当前的视图选择影响
        // （没有选项时快照会解析成空态视图，那会让阶段 2 报 adapter-unresolved）。
        body: JSON.stringify({
          provider: provider || undefined,
          environment: environment || undefined,
          mode: mode || 'observe',
          requestId: diagRequestId(),
        }),
        signal,
      });
      if (!response.ok) {
        const payload = await response.json().catch(() => ({}));
        const error = new Error(payload.error || ('诊断请求失败：' + response.status));
        error.code = payload.code || 'DIAGNOSE_REQUEST_FAILED';
        error.status = response.status;
        throw error;
      }
      if (!response.body || typeof response.body.getReader !== 'function') {
        throw Object.assign(new Error('诊断响应不是可读流'), { code: 'DIAGNOSE_STREAM_UNAVAILABLE' });
      }
      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        let index;
        while ((index = buffer.indexOf('\n')) >= 0) {
          const line = buffer.slice(0, index).trim();
          buffer = buffer.slice(index + 1);
          if (!line) continue;
          let event;
          try { event = JSON.parse(line); } catch { continue; }
          if (event && typeof event === 'object' && typeof onEvent === 'function') onEvent(event);
        }
      }
      return true;
    }

    /** Fold one NDJSON event into the run state (pure; used by both live streaming and replay). */
    function diagApplyEvent(run, event) {
      const next = Object.assign({}, run);
      next.events = (run.events || []).concat([event]);
      next.stagePhase = Object.assign({}, run.stagePhase);
      next.stages = Object.assign({}, run.stages);
      if (event.type === 'run-start') {
        next.runId = event.runId || '';
        next.provider = event.provider || run.provider;
        next.mode = event.mode || run.mode;
        next.phase = 'running';
        next.startedAt = event.startedAt || null;
        next.configRevision = event.configRevision ?? null;
        next.error = '';
      } else if (event.type === 'stage-start') {
        next.stagePhase[event.stageId] = 'running';
      } else if (event.type === 'stage-end') {
        next.stagePhase[event.stageId] = 'finished';
        next.stages[event.stageId] = {
          stageId: event.stageId,
          phase: 'finished',
          status: DIAG_STATES.includes(event.status) ? event.status : 'UNKNOWN',
          reason: event.reason || null,
          blockedBy: event.blockedBy ?? null,
          startedAt: event.startedAt ?? null,
          finishedAt: event.finishedAt ?? null,
          durationMs: event.durationMs === undefined ? null : event.durationMs,
          checks: Array.isArray(event.checks) ? event.checks : [],
          evidenceRef: event.evidenceRef || null,
          seq: event.seq,
        };
      } else if (event.type === 'run-end') {
        next.phase = 'finished';
        next.finishedAt = event.finishedAt || null;
        next.axes = event.axes || null;
        next.overall = event.overall || null;
        next.actualCalls = Array.isArray(event.actualCalls) ? event.actualCalls : [];
        next.sideEffects = Array.isArray(event.sideEffects) ? event.sideEffects : [];
        next.stages = Object.assign({}, next.stages, event.stages || {});
        next.stagePhase = Object.assign({}, next.stagePhase);
        for (const stageId of DIAG_STAGE_IDS) next.stagePhase[stageId] = 'finished';
      }
      return next;
    }

    /**
     * Node/edge model for one run.
     *
     * Node state = that stage's own status (UNKNOWN until the stage reports). An edge is decided by
     * **both** ends: a FAIL above stops the flow (FAIL), a skipped downstream segment is SKIPPED, and
     * anything still unknown keeps the edge UNKNOWN. Nothing here can turn green without a stage
     * that actually finished PASS.
     */
    /**
     * 诊断日志左侧的「操作名」：界面写中文，`data-uts-event-operation` 仍保留英文 id
     * （`run-start` / `stage-N` / `run-end`），agent 与排障不受影响。
     */
    function diagOperationLabel(operation) {
      const key = String(operation || '');
      if (key === 'run-start') return '本轮开始';
      if (key === 'run-end') return '本轮结束';
      const stage = /^stage-(\d+)$/u.exec(key);
      return stage ? '第 ' + stage[1] + ' 段' : key;
    }

    /** 调试节点的完整信息（悬停提示）：角色/名称、职责、状态、原因码、阻塞与耗时。 */
    function diagNodeTitle(node, statusText, stage, phase) {
      return [
        String(node.role || '') + ' · ' + String(node.name || ''),
        String(node.sub || ''),
        '状态：' + String(statusText || ''),
        stage && stage.reason ? '原因码：' + String(stage.reason) : '',
        stage && stage.blockedBy !== null && stage.blockedBy !== undefined ? '阻塞于阶段 ' + String(stage.blockedBy) : '',
        stage && stage.durationMs !== null && stage.durationMs !== undefined ? '耗时 ' + String(stage.durationMs) + 'ms' : '',
        phase === 'running' ? '本段正在检查' : '',
      ].filter(Boolean).join('\n');
    }

    function diagRunModel(run, target) {
      const current = run || diagEmptyRun(target && target.id);
      const stages = current.stages || {};
      const stageOf = (id) => stages[id] || null;
      const stateOf = (id) => (stageOf(id) ? stageOf(id).status : 'UNKNOWN');
      const chain = (target && target.chain) || {};
      const interfaceName = chain.communication ? String(chain.communication) : 'CDP';
      const interfaceNameWithSuffix = /接口$/.test(interfaceName) ? interfaceName : interfaceName + '接口';
      const backendName = chain.backend ? String(chain.backend) : 'Chromium DevTools';
      const targetName = target && (target.name || target.id) ? String(target.name || target.id) : 'Chrome';
      const nodeSubs = {
        1: '检查宿主集成、工具注册及调用通道',
        2: '检查插件 Core、配置和调度能力',
        3: '执行通信接口探测',
        4: '检查执行后端及依赖可用性',
        5: '查询目标列表，验证目标绑定与连接状态',
      };
      const nodes = [
        { index: 1, id: 'agent', name: 'DeepSeekHarness', role: 'AI代理', sub: nodeSubs[1], state: stateOf('1'), stage: stageOf('1') },
        { index: 2, id: 'controller', name: 'dsh-agent-team-ui-testing', role: '调试控制器', sub: nodeSubs[2], state: stateOf('2'), stage: stageOf('2') },
        { index: 3, id: 'interface', name: interfaceNameWithSuffix, role: '通信接口', sub: nodeSubs[3], state: stateOf('3'), stage: stageOf('3') },
        { index: 4, id: 'backend', name: backendName, role: '调试后端', sub: nodeSubs[4], state: stateOf('4'), stage: stageOf('4') },
        { index: 5, id: 'target', name: targetName + '页面', role: '目标运行环境', sub: nodeSubs[5], state: stateOf('5'), stage: stageOf('5') },
      ];
      const edgeState = (up, down) => {
        if (up === 'FAIL' || down === 'FAIL') return 'FAIL';
        if (down === 'SKIPPED') return 'SKIPPED';
        if (up === 'UNKNOWN' || down === 'UNKNOWN') return 'UNKNOWN';
        if (up === 'WARN' || down === 'WARN') return 'WARN';
        return 'PASS';
      };
      // A dot only runs on a segment whose downstream stage really finished PASS in this run.
      const liveEdge = (downIndex) => {
        const stage = stageOf(String(downIndex));
        return Boolean(stage && stage.status === 'PASS' && (current.stagePhase || {})[String(downIndex)] === 'finished');
      };
      const edges = [
        { index: 1, state: edgeState(nodes[0].state, nodes[1].state), label: '指令', live: liveEdge(2) },
        { index: 2, state: edgeState(nodes[1].state, nodes[2].state), label: '标准化命令', live: liveEdge(3) },
        { index: 3, state: edgeState(nodes[2].state, nodes[3].state), label: interfaceName + ' 通信', live: liveEdge(4) },
        { index: 4, state: edgeState(nodes[3].state, nodes[4].state), label: liveEdge(5) ? interfaceName + ' 会话正常' : '等待目标绑定', live: liveEdge(5) },
      ];
      for (const edge of edges) if (edge.state !== 'PASS') edge.live = false;
      const duties = nodes.map((node) => ({ node: node.id, name: node.name, text: DIAG_DUTY_TEXT[node.id] || '' }));
      const overall = current.overall
        ? { status: current.overall.status || 'UNKNOWN', reason: current.overall.reason || '' }
        : { status: current.phase === 'running' ? 'UNKNOWN' : 'UNKNOWN', reason: current.phase === 'running' ? 'run-in-progress' : 'no-run' };
      return { run: current, nodes, edges, duties, overall, stageOf };
    }

    /** Event rows: one per stage-end plus the run markers, newest first, bounded to 8. */
    function diagRunRows(run) {
      const current = run || diagEmptyRun('');
      const rows = [];
      for (const event of current.events || []) {
        if (event.type === 'run-start') {
          rows.push({ kind: 'run-start', seq: event.seq, at: event.startedAt || null, operation: 'run-start', runId: event.runId || '', status: 'UNKNOWN', reason: null, blockedBy: null, durationMs: null, evidenceRef: null });
        } else if (event.type === 'stage-end') {
          rows.push({
            kind: 'stage', stageId: event.stageId, seq: event.seq, at: event.finishedAt || event.startedAt || null,
            operation: 'stage-' + event.stageId, runId: event.runId || '',
            status: DIAG_STATES.includes(event.status) ? event.status : 'UNKNOWN',
            reason: event.reason || null, blockedBy: event.blockedBy ?? null,
            durationMs: event.durationMs === undefined ? null : event.durationMs,
            evidenceRef: event.evidenceRef || null,
          });
        } else if (event.type === 'run-end') {
          rows.push({ kind: 'run-end', seq: event.seq, at: event.finishedAt || null, operation: 'run-end', runId: event.runId || '', status: (event.overall && event.overall.status) || 'UNKNOWN', reason: (event.overall && event.overall.reason) || null, blockedBy: null, durationMs: event.durationMs === undefined ? null : event.durationMs, evidenceRef: null });
        }
      }
      return rows
        .sort((left, right) => (right.seq || 0) - (left.seq || 0))
        .slice(0, DIAG_RUN_ROWS);
    }

    /**
     * Normalize the Host readiness payload (`{checkedAt, environments:[...]}` or a map keyed by
     * environment id). Each axis may be a bare status or `{status, reason}`; missing axes stay
     * absent so the page can say "not probed" instead of inventing a value.
     */
    /**
     * Read the six axes out of one Host readiness entry (environment-level or provider-level).
     * The Host returns a nested `axes` object (M4 contract); older/defensive shapes may still be
     * flat, so the nested value is read first and the flat field is the fallback.
     */
    function axesOfHostEntry(entry) {
      const axes = {};
      if (!entry || typeof entry !== 'object') return axes;
      for (const axis of AXIS_ORDER) {
        const rawValue = entry.axes && entry.axes[axis] !== undefined
          ? entry.axes[axis]
          : entry[axis];
        if (rawValue === undefined || rawValue === null) continue;
        if (typeof rawValue === 'object') {
          const status = rawValue.status === undefined || rawValue.status === null ? '' : String(rawValue.status);
          if (!status) continue;
          // A13: keep the *evidence* the Host measured, not just a status word. Dropping
          // target/evidence/expiresAt here made "which capability is missing / which target was
          // probed / when" unanswerable in the page even though the Host had measured it.
          axes[axis] = {
            status,
            reason: rawValue.reason ? String(rawValue.reason) : '',
            checkedAt: Number.isFinite(rawValue.checkedAt) ? rawValue.checkedAt : null,
            expiresAt: Number.isFinite(rawValue.expiresAt) ? rawValue.expiresAt : null,
            targetId: rawValue.target && typeof rawValue.target === 'object' && rawValue.target.targetId
              ? String(rawValue.target.targetId)
              : '',
            evidenceKind: rawValue.evidence && typeof rawValue.evidence === 'object' && rawValue.evidence.kind
              ? String(rawValue.evidence.kind)
              : '',
            checks: rawValue.evidence && typeof rawValue.evidence === 'object'
              && rawValue.evidence.checks && typeof rawValue.evidence.checks === 'object'
              ? rawValue.evidence.checks
              : null,
          };
        } else {
          axes[axis] = { status: String(rawValue), reason: '', checkedAt: null, expiresAt: null, targetId: '', evidenceKind: '', checks: null };
        }
      }
      return axes;
    }

    function normalizeReadiness(readiness) {
      const map = {};
      if (!readiness || typeof readiness !== 'object') return map;
      const raw = readiness.environments;
      let list = null;
      if (Array.isArray(raw)) list = raw;
      else if (raw && typeof raw === 'object') list = Object.keys(raw).map((id) => Object.assign({ environment: id }, raw[id]));
      if (!list) return map;
      for (const entry of list) {
        if (!entry || typeof entry !== 'object') continue;
        const id = String(entry.environment || entry.id || entry.env || '');
        if (!id) continue;
        const axes = axesOfHostEntry(entry);
        // Slice ② also reports per-provider axes (`readiness.environments[web].providers.<id>.axes`).
        // Each card reads its own provider's result instead of sharing Chrome's connection/target/
        // capability axes — a disabled provider is therefore not rendered as "ready".
        const providers = {};
        const rawProviders = entry.providers && typeof entry.providers === 'object' ? entry.providers : null;
        if (rawProviders) {
          for (const [providerId, providerEntry] of Object.entries(rawProviders)) {
            if (!providerEntry || typeof providerEntry !== 'object') continue;
            providers[providerId] = {
              axes: axesOfHostEntry(providerEntry),
              checkedAt: String(providerEntry.checkedAt || entry.checkedAt || readiness.checkedAt || ''),
              reason: providerEntry.reason ? String(providerEntry.reason) : '',
            };
          }
        }
        map[id] = {
          axes,
          providers,
          checkedAt: String(entry.checkedAt || readiness.checkedAt || ''),
          reason: entry.reason ? String(entry.reason) : '',
        };
      }
      return map;
    }

    /** Static engineering support, used only when the Host sends no support axis. */
    function staticSupportOf(groupId) {
      const group = TARGET_ENV_GROUPS.find((item) => item.id === groupId);
      if (!group) return 'planned';
      if (group.targets.some((target) => target.state === 'supported')) return 'supported';
      if (group.targets.some((target) => target.state === 'unsupported')) return 'unsupported';
      return 'planned';
    }

    /** `true`/`false` from the Host config, or `null` when the config carries no environment map. */
    function enabledFromConfig(config, envId) {
      const envs = config && config.global && config.global.environments;
      if (!envs || typeof envs !== 'object') return null;
      const entry = envs[envId];
      return Boolean(entry && entry.enabled === true);
    }

    /**
     * Per-provider switch values straight from the Host config.
     *
     * Returns `null` when the config carries no provider map at all (old Host / unreadable config),
     * so the page can say "unknown" instead of pretending the switch is off. The map is the single
     * source of truth: closing the target-environment master switch never rewrites these values.
     */
    function providersFromConfig(config, envId) {
      const envs = config && config.global && config.global.environments;
      const entry = envs && typeof envs === 'object' ? envs[envId] : null;
      const providers = entry && typeof entry.providers === 'object' && entry.providers ? entry.providers : null;
      if (!providers) return null;
      const out = {};
      for (const [providerId, value] of Object.entries(providers)) {
        out[providerId] = Boolean(value && value.enabled === true);
      }
      return out;
    }

    /**
     * The execution provider the Host resolved for this scope. Read from `resolved.provider`, never
     * inferred from the checkboxes: the switch says "may use", this says "will use".
     */
    function currentProviderFromState(state) {
      const resolved = state && state.resolved && typeof state.resolved === 'object' ? state.resolved : null;
      return resolved && typeof resolved.provider === 'string' ? resolved.provider : '';
    }

    /**
     * Six axes for one provider card, read from `readiness.environments[env].providers.<id>.axes`.
     * When the Host reports nothing for that provider, every axis stays `not-probed` with a reason —
     * a card never borrows another provider's connection/target/capability evidence.
     */
    function providerAxes(state, envId, providerId) {
      const entry = state && state.readiness ? state.readiness[envId] : null;
      const providerEntry = entry && entry.providers ? entry.providers[providerId] : null;
      const hostAxes = providerEntry && providerEntry.axes ? providerEntry.axes : null;
      const configLoaded = Boolean(state && state.revision !== null && !state.error);
      return AXIS_ORDER.map((axis) => {
        if (axis === 'enabled') {
          if (configLoaded) {
            const providers = providersFromConfig(state.config, envId);
            if (providers === null) {
              return { axis, status: 'not-probed', reason: '宿主配置未包含运行环境清单', source: 'unavailable' };
            }
            return providers[providerId] === true
              ? { axis, status: 'true', reason: '宿主配置已启用该运行环境', source: 'host' }
              : { axis, status: 'false', reason: '宿主配置未启用该运行环境', source: 'host' };
          }
          return { axis, status: 'not-probed', reason: '宿主配置不可用，未读取到该运行环境的启用状态', source: 'unavailable' };
        }
        const host = hostAxes ? hostAxes[axis] : null;
        if (host && host.status) {
          return {
            axis,
            status: host.status,
            reason: host.reason || '来自宿主就绪结果',
            source: 'host',
            checkedAt: host.checkedAt ?? null,
            expiresAt: host.expiresAt ?? null,
            targetId: host.targetId || '',
            evidenceKind: host.evidenceKind || '',
            checks: host.checks || null,
          };
        }
        return { axis, status: 'not-probed', reason: '宿主未提供该运行环境的探测结果', source: 'unavailable' };
      });
    }

    /**
     * Six independent axes for one environment. Nothing is merged into a single "valid" flag:
     * unsupported, disabled and not-probed stay distinguishable, and a missing Host answer is
     * reported as not-probed with a reason rather than a ready state.
     */
    function environmentAxes(state, groupId) {
      const entry = state && state.readiness ? state.readiness[groupId] : null;
      const hostAxes = entry && entry.axes ? entry.axes : {};
      const configLoaded = Boolean(state && state.revision !== null && !state.error);
      return AXIS_ORDER.map((axis) => {
        // `enabled` is the user's saved intent: the Host config revision wins over a readiness
        // snapshot, so a successful PUT is visible immediately (the write response has no readiness).
        if (axis === 'enabled') {
          if (configLoaded) {
            const enabled = enabledFromConfig(state.config, groupId);
            if (enabled === null) {
              return { axis, status: 'not-probed', reason: '宿主配置未包含环境策略', source: 'unavailable' };
            }
            return {
              axis,
              status: enabled ? 'true' : 'false',
              reason: enabled ? '宿主配置已启用该环境' : '宿主配置未启用该环境',
              source: 'host',
            };
          }
          if (state && state.error) {
            return { axis, status: 'not-probed', reason: '宿主配置读取失败，无法确认用户启用状态', source: 'unavailable' };
          }
          const hostEnabled = hostAxes.enabled;
          if (hostEnabled && hostEnabled.status) {
            return { axis, status: hostEnabled.status, reason: hostEnabled.reason || '来自宿主就绪结果', source: 'host' };
          }
          return { axis, status: 'not-probed', reason: '宿主配置不可用，未读取到用户启用状态', source: 'unavailable' };
        }
        const host = hostAxes[axis];
        if (host && host.status) {
          // Carry the measured detail through to the DOM: which target was probed, when it was
          // checked, and (for the capability axis) which per-capability checks passed (A13).
          return {
            axis,
            status: host.status,
            reason: host.reason || '来自宿主就绪结果',
            source: 'host',
            checkedAt: host.checkedAt ?? null,
            expiresAt: host.expiresAt ?? null,
            targetId: host.targetId || '',
            evidenceKind: host.evidenceKind || '',
            checks: host.checks || null,
          };
        }
        if (axis === 'support') {
          return { axis, status: staticSupportOf(groupId), reason: '静态候选清单（宿主未提供 support 探测）', source: 'static' };
        }
        return { axis, status: 'not-probed', reason: '宿主未提供该轴的探测结果', source: 'unavailable' };
      });
    }

    const EMPTY_HOST_CONFIG = Object.freeze({
      loading: true, error: '', revision: null, config: null, resolved: null, readiness: {}, checkedAt: '',
      // Host-declared environment catalog (id / label / short / status). The panel's selector and
      // settings groups derive from it; an empty catalog means "the Host has not answered yet".
      catalog: Object.freeze([]),
      // Local observation time of the last *successful* read (ms). `checkedAt` is the Host's probe
      // time; this one answers "how long ago did this page last hear from the Host".
      lastReadAt: 0,
    });

    /**
     * Normalize one catalog row from the Host.
     *
     * Only well-formed rows survive; an unknown `status` is reported as `planned`, never as
     * `supported`, so a newer Host cannot make this panel treat an unimplemented environment as
     * executable. `testOnly` rows are kept (flagged) and filtered by the surface that renders them.
     */
    function normalizeCatalogRow(row) {
      if (!row || typeof row !== 'object') return null;
      const id = typeof row.id === 'string' ? row.id.trim() : '';
      if (!id) return null;
      // 状态词表必须原样保留：`empty`（默认视图）与 `view`（只有视图的环境）都不是 planned，
      // 也不能被降级成 supported。未知值仍然按 planned 处理（宁可不执行，也不猜成可用）。
      const status = ['supported', 'view', 'planned', 'empty'].includes(row.status) ? row.status : 'planned';
      // `kind: 'view'` 的行是空态视图，不是目标环境：它没有开关，永远可选。丢掉这个字段会让
      // 默认视图在组合框里被"未启用"过滤掉——这正是它一开始不出现的原因。
      const kind = row.kind === 'view' ? 'view' : 'environment';
      return {
        id,
        label: typeof row.label === 'string' && row.label ? row.label : id,
        short: typeof row.short === 'string' && row.short ? row.short : id,
        status,
        kind,
        planned: status === 'planned',
        testOnly: row.testOnly === true,
      };
    }

    /** Adopt one Host config payload; a payload without a numeric revision is a failed read. */
    function mergeHostConfig(previous, payload) {
      const revision = payload && typeof payload.revision === 'number' ? payload.revision : null;
      if (revision === null) {
        return Object.assign({}, previous, {
          loading: false,
          error: '宿主未提供配置接口（响应缺少 revision）',
        });
      }
      const readiness = payload.readiness !== undefined ? normalizeReadiness(payload.readiness) : previous.readiness;
      const checkedAt = payload.readiness && payload.readiness.checkedAt
        ? String(payload.readiness.checkedAt)
        : previous.checkedAt;
      const catalog = Array.isArray(payload.catalog)
        ? payload.catalog.map(normalizeCatalogRow).filter(Boolean)
        : previous.catalog;
      return {
        loading: false,
        error: '',
        revision,
        config: payload.config !== undefined ? payload.config : previous.config,
        resolved: payload.resolved !== undefined ? payload.resolved : previous.resolved,
        readiness,
        checkedAt,
        catalog,
        lastReadAt: previous.lastReadAt || 0,
      };
    }

    /**
     * 宿主配置类错误的英文原因 → 中文。宿主返回的是机器可读英文（`environment android is
     * planned and cannot be selected in v1` 等），直接上屏对用户没有信息量；这里按已知模式翻译，
     * 未识别的原样保留（不猜），原文仍留在悬停提示里。
     */
