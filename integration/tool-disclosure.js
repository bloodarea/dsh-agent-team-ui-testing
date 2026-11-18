/** Agent-local schema selection. This cache grants no environment or tool permissions. */
export const DISCOVERY_TOOL = 'browser_tools';
export const DIAGNOSTIC_TOOLS = Object.freeze(['browser_state', 'browser_capabilities']);

// Recipes follow operation dependencies: advanced work retains navigation, target selection,
// structured observation and input. Network is optional for purely visual dynamic work.
export const TOOL_GROUPS = Object.freeze({
  basic: Object.freeze({
    description: '网页导航、结构化观察与输入、截图、样式、标签页和标注',
    requires: Object.freeze([]),
    tools: Object.freeze([
      'browser_navigate', 'browser_eval', 'browser_screenshot', 'browser_input',
      'browser_computed_style', 'browser_viewport', 'browser_tabs', 'browser_annotation',
      'browser_snapshot', 'browser_click', 'browser_type', 'browser_scroll',
      'browser_fill_form', 'browser_node_state', 'browser_wait_for',
    ]),
  }),
  network: Object.freeze({
    description: '请求元数据、独立 HTTP、网络采集/正文/链路/控制/证据/订阅',
    requires: Object.freeze(['basic']),
    tools: Object.freeze([
      'browser_network', 'browser_http_request', 'browser_network_session',
      'browser_network_events', 'browser_network_detail', 'browser_network_trace',
      'browser_network_control', 'browser_network_evidence', 'browser_network_subscribe',
    ]),
  }),
  security: Object.freeze({
    description: '安全测试边界（Origin 白名单/预算/停止）、Cookie 元数据读取、受控凭据导出/导入（导出需人类签发授权，HttpOnly 需专项授权）',
    requires: Object.freeze(['basic']),
    tools: Object.freeze([
      'browser_security_scope', 'browser_cookies', 'browser_surface', 'browser_script', 'browser_findings',
      'browser_biz',
    ]),
  }),
  vision: Object.freeze({
    description: '静态图像处理、定位、差异、视觉输入、基线和验收',
    requires: Object.freeze(['basic']),
    tools: Object.freeze([
      'browser_vision_image', 'browser_vision_find', 'browser_vision_compare',
      'browser_vision_act', 'browser_vision_baseline', 'browser_vision_check',
    ]),
  }),
  dynamic: Object.freeze({
    description: '动态采帧、观察/分析、时间轴控制；网络关联或纯网络会话另选 network',
    requires: Object.freeze(['basic']),
    tools: Object.freeze([
      'browser_dynamic_session', 'browser_motion_observe', 'browser_motion_analyze',
      'browser_motion_control', 'browser_dynamic_correlate',
    ]),
  }),
});

const GROUP_FOR_TOOL = new Map(Object.entries(TOOL_GROUPS)
  .flatMap(([id, group]) => group.tools.map((name) => [name, id])));
const objectAgent = (agent) => agent !== null && typeof agent === 'object';

export function createToolDisclosure({ snapshotForAgent, environmentAdmitted, scopeVisible, ErrorClass = Error }) {
  let states = new WeakMap();
  const tracked = new Set();
  const fail = (code, message, details = {}) => { throw new ErrorClass(code, message, details); };

  function fingerprint(agent) {
    const snapshot = snapshotForAgent(agent);
    // A revision alone would reset A when B changes configuration. Compare only A's effective
    // admission, workspace and provider. Target navigation/selection does not end a task stage.
    return JSON.stringify([
      agent.id ?? null, agent.session?.header?.cwd ?? null,
      snapshot.environment, snapshot.executionAdapterId, snapshot.provider,
      snapshot.source?.degraded === true, snapshot.source?.rejectedProviderReason ?? null,
      snapshot.enabledEnvironments, snapshot.capabilities, snapshot.environmentConfig?.enabled,
      snapshot.providerConfig,
    ]);
  }

  function stateOf(agent) {
    if (!objectAgent(agent)) return null;
    const key = fingerprint(agent);
    let state = states.get(agent);
    if (!state) {
      state = { fingerprint: key, selected: new Set() };
      states.set(agent, state);
      tracked.add(new WeakRef(agent));
    } else if (state.fingerprint !== key) {
      state.fingerprint = key;
      state.selected.clear();
    }
    return state;
  }

  function selectedTools(state) {
    const tools = new Set([DISCOVERY_TOOL, ...DIAGNOSTIC_TOOLS]);
    for (const id of state?.selected ?? []) for (const name of TOOL_GROUPS[id].tools) tools.add(name);
    return tools;
  }

  function disclosed(agent, name) {
    if (name === DISCOVERY_TOOL || DIAGNOSTIC_TOOLS.includes(name)) return true;
    // The fake adapter's single test operation has no deferred group.
    if (name === 'browser_fake_probe') return true;
    const group = GROUP_FOR_TOOL.get(name);
    return group !== undefined && stateOf(agent)?.selected.has(group) === true;
  }

  function status(agent) {
    const state = stateOf(agent);
    const snapshot = snapshotForAgent(agent);
    const selected = Object.keys(TOOL_GROUPS).filter((id) => state?.selected.has(id));
    const wanted = selectedTools(state);
    return {
      ok: true, environment: snapshot.environment, provider: snapshot.provider ?? null,
      selected,
      catalog: Object.entries(TOOL_GROUPS).map(([id, group]) => ({
        id, description: group.description, requires: [...group.requires], count: group.tools.length,
        available: group.tools.some((name) => environmentAdmitted(agent, name) && scopeVisible(agent, name)),
      })),
      // These are presentation candidates, not a permission verdict or the frozen current step.
      nextRequestTools: [...wanted].filter((name) => environmentAdmitted(agent, name) && scopeVisible(agent, name)),
      effective: 'next-step', lifetime: 'agent-memory; reset on environment/provider/admission change, restore or plugin reload',
    };
  }

  function execute(args, agent) {
    if (!args || typeof args !== 'object' || Array.isArray(args)
      || Object.keys(args).some((key) => !['action', 'groups'].includes(key))) {
      fail('INVALID_ARGUMENT', 'browser_tools 只接受 action 和 groups');
    }
    const action = args.action;
    if (!['status', 'activate', 'reset'].includes(action)) fail('INVALID_ARGUMENT', '未知的 browser_tools action');
    if (action !== 'activate' && args.groups !== undefined) fail('INVALID_ARGUMENT', 'groups 仅适用于 activate');
    if (action === 'activate') {
      if (!objectAgent(agent) || typeof agent.id !== 'string' || !agent.id) {
        fail('TOOL_DISCLOSURE_AGENT_REQUIRED', '激活工具需要当前 Agent 身份');
      }
      if (!Array.isArray(args.groups) || args.groups.length === 0 || args.groups.length > Object.keys(TOOL_GROUPS).length
        || args.groups.some((id) => typeof id !== 'string' || !Object.hasOwn(TOOL_GROUPS, id))) {
        fail('TOOL_DISCLOSURE_UNKNOWN_GROUP', 'groups 必须是 basic、network、security、vision、dynamic 的非空数组');
      }
      const requested = new Set();
      const add = (id) => {
        for (const dependency of TOOL_GROUPS[id].requires) add(dependency);
        requested.add(id);
      };
      for (const id of args.groups) add(id);
      // Validate the entire request before changing state. A whitelist may expose only part of
      // a group; selecting it never adds the missing definitions or disposes a restriction.
      for (const id of requested) {
        if (!TOOL_GROUPS[id].tools.some((name) => environmentAdmitted(agent, name) && scopeVisible(agent, name))) {
          fail('TOOL_DISCLOSURE_UNAVAILABLE', `能力组 ${id} 在当前环境或工具作用域不可用`, { group: id });
        }
      }
      const state = stateOf(agent);
      for (const id of requested) state.selected.add(id);
    } else if (action === 'reset') {
      if (!objectAgent(agent)) fail('TOOL_DISCLOSURE_AGENT_REQUIRED', '重置工具需要当前 Agent 身份');
      stateOf(agent).selected.clear();
    }
    return status(agent);
  }

  return {
    disclosed, execute, status,
    // Called on every config write, even when an Agent makes no request between away/back changes.
    refresh() {
      for (const ref of tracked) {
        const agent = ref.deref();
        if (agent) stateOf(agent);
        else tracked.delete(ref);
      }
    },
    dispose() { states = new WeakMap(); tracked.clear(); },
  };
}
