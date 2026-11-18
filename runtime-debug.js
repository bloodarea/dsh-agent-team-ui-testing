/**
 * runtime-debug.js — FR-05 JavaScript 运行时分析（RT-01..RT-07）的纯核心。
 *
 * CDP 调用（Debugger.setBreakpointByUrl / Debugger.paused / Debugger.resume /
 * Debugger.removeBreakpoint）由 Host 层组合；本模块只做可单测的状态机与投影：
 *
 *  - 断点簿记：id → {url, lineNumber, columnNumber, condition, enabled, hits}，命中计数与
 *    RT-01「指定断点命中率」的可观测基础；
 *  - 暂停状态：一次 paused 事件的 reason/callFrames/scopeChain 规范化，**变量值必须经脱敏投影**
 *    （RT-07：Cookie/Token/密码/Authorization 类变量值不进入日志与 Agent 上下文）；
 *  - 恢复守卫：暂停超时后必须自动 resume（RT-06），本模块给出超时判定与"必须恢复"的结论，
 *    Host 层负责真正发送 Debugger.resume；
 *  - 调用栈 ↔ 请求关联（RT-02/RT-04）：把一次 paused 的栈帧与网络请求（requestId/url/method）
 *    按 element 事件或时间窗口关联，输出可复核的关联记录；
 *  - 签名运行时验证（RT-05）：把运行时观测到的参数序列与静态逆向结论逐项比对。
 */

export const RUNTIME_DEBUG_VERSION = 1;

/** 运行时分析上限。 */
export const DEBUG_LIMITS = Object.freeze({
  maxBreakpoints: 32,
  maxCallFrames: 64,
  maxScopeObjects: 32,
  maxVariablesPerScope: 64,
  /** 暂停最长挂起时间：超时后 Host 必须无条件 resume（RT-06）。 */
  pauseTimeoutMs: 5000,
  maxStringBytes: 2048,
});

/** 敏感变量名（RT-07）：值不进入任何输出，只保留类型与长度。 */
export const SENSITIVE_VARIABLE = /(cookie|token|secret|password|passwd|authorization|auth|session|credential|api[-_]?key|signature|salt|proof|x-lab)/i;

/* -----------------------------------------------------------------------------------------------
 * RT-01：断点簿记
 * ---------------------------------------------------------------------------------------------- */

/**
 * 规范化一个断点定义。URL 断点（setBreakpointByUrl）是本模块唯一支持的形态：
 * 位置断点需要 scriptId（CDP 的 setBreakpoint 语义），而全盲测试通常先知道 URL。
 */
export function normalizeBreakpoint(input) {
  if (typeof input !== 'object' || input === null) return null;
  const url = typeof input.url === 'string' && input.url !== '' ? input.url : null;
  if (url === null) return null;
  const lineNumber = Number.isInteger(input.lineNumber) ? input.lineNumber : null;
  if (lineNumber === null || lineNumber < 0 || lineNumber > 10_000_000) return null;
  const columnNumber = Number.isInteger(input.columnNumber) && input.columnNumber >= 0 ? input.columnNumber : 0;
  return {
    url,
    lineNumber,
    columnNumber,
    condition: typeof input.condition === 'string' && input.condition.trim() !== '' ? input.condition.slice(0, 512) : null,
    label: typeof input.label === 'string' ? input.label.slice(0, 64) : null,
  };
}

/**
 * 断点集合状态机：登记/移除/命中计数。
 * 命中计数是 RT-01 的可观测基础：没有命中就是 0，不能推断成"命中过"。
 */
export class BreakpointBook {
  constructor({ now = Date.now } = {}) {
    this._now = typeof now === 'function' ? now : () => now;
    this.byId = new Map(); // cdpBreakpointId -> record
    this.byLabel = new Map();
    this.order = [];
  }

  /** 登记一次 CDP 已确认的断点（id 来自 setBreakpointByUrl 的 breakpointId）。 */
  register(cdpBreakpointId, definition, { locations = [] } = {}) {
    if (typeof cdpBreakpointId !== 'string' || cdpBreakpointId === '') return null;
    if (this.byId.size >= DEBUG_LIMITS.maxBreakpoints) {
      return { ok: false, code: 'DEBUG_LIMIT_REACHED', message: '断点数量达到上限', details: { max: DEBUG_LIMITS.maxBreakpoints } };
    }
    const record = {
      cdpBreakpointId,
      label: definition.label ?? null,
      url: definition.url,
      lineNumber: definition.lineNumber,
      columnNumber: definition.columnNumber,
      condition: definition.condition,
      resolved: Array.isArray(locations) && locations.length > 0,
      locations: (Array.isArray(locations) ? locations : []).slice(0, 16).map((loc) => ({
        scriptId: loc?.scriptId ?? null,
        lineNumber: Number.isInteger(loc?.lineNumber) ? loc.lineNumber : null,
        columnNumber: Number.isInteger(loc?.columnNumber) ? loc.columnNumber : null,
      })),
      hits: 0,
      createdAt: this._now(),
      lastHitAt: null,
    };
    this.byId.set(cdpBreakpointId, record);
    if (record.label !== null) this.byLabel.set(record.label, record);
    this.order.push(cdpBreakpointId);
    return { ok: true, record };
  }

  /** 一次 Debugger.paused 命中（按 CDP 的 hitBreakpoints 列表归因）。 */
  recordHit(cdpBreakpointIds) {
    const ids = Array.isArray(cdpBreakpointIds) ? cdpBreakpointIds : [];
    const hit = [];
    for (const id of ids) {
      const record = this.byId.get(id);
      if (!record) continue;
      record.hits += 1;
      record.lastHitAt = this._now();
      hit.push(record);
    }
    return hit;
  }

  remove(cdpBreakpointId) {
    const record = this.byId.get(cdpBreakpointId);
    if (!record) return { ok: false, code: 'DEBUG_BREAKPOINT_NOT_FOUND' };
    this.byId.delete(cdpBreakpointId);
    if (record.label !== null) this.byLabel.delete(record.label);
    return { ok: true, record };
  }

  findByLabel(label) {
    return this.byLabel.get(String(label)) ?? null;
  }

  /** RT-01 投影：每个断点的命中情况（0 命中必须如实报告为 0）。 */
  /**
   * Re-register a breakpoint after a document navigation replaced the CDP breakpoint.
   * `setBreakpointByUrl` is bound to the current document's scripts: after a navigation the old
   * locations are gone, so a breakpoint set BEFORE the script existed could never hit. Replaying
   * the stored definition under the new id makes "break at load time" actually work.
   */
  replaceId(oldId, newId, { locations = [] } = {}) {
    const record = this.byId.get(oldId);
    if (!record) return null;
    this.byId.delete(oldId);
    if (record.label !== null) this.byLabel.delete(record.label);
    const next = {
      ...record,
      cdpBreakpointId: newId,
      resolved: Array.isArray(locations) && locations.length > 0,
      locations: (Array.isArray(locations) ? locations : []).slice(0, 16).map((loc) => ({
        scriptId: loc?.scriptId ?? null,
        lineNumber: Number.isInteger(loc?.lineNumber) ? loc.lineNumber : null,
        columnNumber: Number.isInteger(loc?.columnNumber) ? loc.columnNumber : null,
      })),
    };
    this.byId.set(newId, next);
    if (next.label !== null) this.byLabel.set(next.label, next);
    return next;
  }

  /** Every stored definition (used to replay after navigation). */
  definitions() {
    return [...this.byId.values()].map((record) => ({
      cdpBreakpointId: record.cdpBreakpointId,
      url: record.url,
      lineNumber: record.lineNumber,
      columnNumber: record.columnNumber,
      condition: record.condition,
      label: record.label,
    }));
  }

  projection() {
    return [...this.byId.values()].map((record) => ({
      cdpBreakpointId: record.cdpBreakpointId,
      label: record.label,
      url: record.url,
      lineNumber: record.lineNumber,
      condition: record.condition,
      resolved: record.resolved,
      hitCount: record.hits,
      createdAt: record.createdAt,
      lastHitAt: record.lastHitAt,
    }));
  }
}

/* -----------------------------------------------------------------------------------------------
 * RT-07：变量脱敏投影
 * ---------------------------------------------------------------------------------------------- */

/**
 * 把 CDP RemoteObject 投影成安全形态：敏感名只报类型与长度，普通值截断到 maxStringBytes。
 * 任何输入都不抛错（调试数据不可信）。
 */
export function projectRemoteObject(object, { name = null } = {}) {
  const value = object !== null && typeof object === 'object' ? object : {};
  const type = typeof value.type === 'string' ? value.type : 'unknown';
  const sensitive = name !== null && SENSITIVE_VARIABLE.test(String(name));
  const base = { name: name === null ? null : String(name), type, sensitive };
  if (sensitive) {
    // Never echo the value: only its type and (for strings) its length.
    return {
      ...base,
      value: null,
      valueOmitted: true,
      valueLength: typeof value.value === 'string' ? value.value.length : null,
      description: typeof value.description === 'string' ? `[redacted ${type}]` : null,
    };
  }
  if (value.value === undefined) {
    return {
      ...base,
      value: null,
      valueOmitted: value.type !== 'undefined',
      description: typeof value.description === 'string' ? value.description.slice(0, DEBUG_LIMITS.maxStringBytes) : null,
      objectId: null, // object handles never leave the Host
    };
  }
  if (typeof value.value === 'string' && value.value.length > DEBUG_LIMITS.maxStringBytes) {
    return {
      ...base,
      value: value.value.slice(0, DEBUG_LIMITS.maxStringBytes),
      valueOmitted: false,
      truncated: true,
      originalLength: value.value.length,
    };
  }
  return { ...base, value: value.value, valueOmitted: false };
}

/**
 * 作用域投影：把 CDP scopeChain 的每个 scope 的变量列表脱敏。
 * `variablesOf(scopeIndex)` 由 Host 层提供（Runtime.getProperties），本函数只做投影。
 */
export function projectScopes(scopeChain, { variablesOf = null } = {}) {
  const scopes = Array.isArray(scopeChain) ? scopeChain.slice(0, DEBUG_LIMITS.maxScopeObjects) : [];
  return scopes.map((scope, index) => {
    const type = typeof scope?.type === 'string' ? scope.type : 'unknown';
    const object = scope?.object ?? null;
    const variables = typeof variablesOf === 'function'
      ? (variablesOf(index) ?? []).slice(0, DEBUG_LIMITS.maxVariablesPerScope).map((entry) => projectRemoteObject(entry.value ?? entry, { name: entry.name ?? null }))
      : [];
    return {
      index,
      type,
      name: typeof object?.description === 'string' ? object.description.slice(0, 128) : null,
      variables,
      variablesAvailable: typeof variablesOf === 'function',
    };
  });
}

/* -----------------------------------------------------------------------------------------------
 * RT-02/RT-04：调用栈规范化与请求关联
 * ---------------------------------------------------------------------------------------------- */

/** 规范化一个调用栈帧（只保留可复核的位置信息，不含局部变量）。 */
export function projectCallFrame(frame, { index = 0 } = {}) {
  const location = frame?.location ?? {};
  const fn = frame?.functionLocation ?? null;
  return {
    index,
    callFrameId: null, // never exposed: it is a live handle
    functionName: typeof frame?.functionName === 'string' && frame.functionName !== '' ? frame.functionName.slice(0, 128) : '(anonymous)',
    url: typeof frame?.url === 'string' ? frame.url : '',
    scriptId: typeof frame?.location?.scriptId === 'string' ? frame.location.scriptId : null,
    lineNumber: Number.isInteger(location.lineNumber) ? location.lineNumber : null,
    columnNumber: Number.isInteger(location.columnNumber) ? location.columnNumber : null,
    functionLine: Number.isInteger(fn?.lineNumber) ? fn.lineNumber : null,
    scopeCount: Array.isArray(frame?.scopeChain) ? frame.scopeChain.length : 0,
  };
}

/**
 * 关联一次暂停与一个网络请求（RT-02/RT-04）。
 *
 * 关联规则（保守，逐级降级）：
 *  - `element`：请求的 initiator stack 里出现与栈帧相同的 scriptId+行号 → confirmed；
 *  - `stack-url`：请求 URL 与某个栈帧的 URL 相同（同脚本发起）→ likely；
 *  - `temporal`：暂停与请求在 beforeMs 内 → possible（**不是因果**）。
 *
 * 返回 { grade, basis, evidence }；grade 为 null 表示无法关联（绝不硬凑）。
 */
export function correlatePauseWithRequest(pause, request, { beforeMs = 250, afterMs = 1000 } = {}) {
  const frames = Array.isArray(pause?.callFrames) ? pause.callFrames : [];
  const requestUrl = typeof request?.url === 'string' ? request.url : '';
  // 1. initiator stack (CDP: request.initiator.stack.callFrames[])
  const stack = request?.initiator?.stack?.callFrames;
  if (Array.isArray(stack) && stack.length > 0) {
    for (const stackFrame of stack) {
      const matched = frames.find((frame) => frame?.location?.scriptId === stackFrame?.scriptId
        && Number.isInteger(stackFrame?.lineNumber)
        && Number.isInteger(frame?.location?.lineNumber)
        && Math.abs(frame.location.lineNumber - stackFrame.lineNumber) <= 1);
      if (matched) {
        return {
          grade: 'confirmed',
          basis: 'initiator',
          evidence: {
            stackScriptId: stackFrame.scriptId,
            stackLine: stackFrame.lineNumber,
            frameUrl: matched.url ?? null,
            requestUrl,
          },
        };
      }
    }
  }
  // 2. same-script URL
  if (requestUrl !== '') {
    const sameUrl = frames.find((frame) => typeof frame?.url === 'string' && frame.url !== '' && frame.url === requestUrl);
    if (sameUrl) {
      return { grade: 'likely', basis: 'stack-url', evidence: { frameUrl: sameUrl.url, requestUrl } };
    }
  }
  // 3. temporal proximity only — explicitly NOT causality
  const pauseAt = Number.isFinite(pause?.pausedAtMs) ? pause.pausedAtMs : null;
  const requestAt = Number.isFinite(request?.atMs) ? request.atMs : null;
  if (pauseAt !== null && requestAt !== null) {
    const delta = requestAt - pauseAt;
    if (delta >= -beforeMs && delta <= afterMs) {
      return { grade: 'possible', basis: 'temporal', evidence: { deltaMs: delta, note: '时间邻近不等于因果' } };
    }
  }
  return { grade: null, basis: null, evidence: { note: '无共同脚本/initiator，且不在时间窗口内' } };
}

/* -----------------------------------------------------------------------------------------------
 * RT-06：暂停恢复守卫
 * ---------------------------------------------------------------------------------------------- */

/**
 * 暂停状态机：paused → (resumed) 或 (超时 → 必须强制 resume)。
 * `mustResume` 是硬结论：Host 层看到它就必须发送 Debugger.resume，否则页面永久挂起。
 */
export class PauseGuard {
  constructor({ now = Date.now, timeoutMs = DEBUG_LIMITS.pauseTimeoutMs } = {}) {
    this._now = typeof now === 'function' ? now : () => now;
    this.timeoutMs = timeoutMs;
    this.active = null;
    this.history = [];
  }

  /** 进入暂停。重复 paused（未 resume）覆盖为新的暂停并记录冲突。 */
  enter({ reason = null, callFrames = [], hitBreakpoints = [], atMs = null } = {}) {
    const conflict = this.active !== null;
    const record = {
      pausedAtMs: Number.isFinite(atMs) ? atMs : this._now(),
      reason: typeof reason === 'string' ? reason : null,
      callFrameCount: Array.isArray(callFrames) ? callFrames.length : 0,
      hitBreakpoints: Array.isArray(hitBreakpoints) ? hitBreakpoints.slice(0, 16) : [],
      conflict,
    };
    this.active = record;
    this.history.push(record);
    if (this.history.length > 100) this.history.shift();
    return record;
  }

  /** 检查超时：超时则标记 mustResume 并清空 active（Host 必须立刻 resume）。 */
  checkTimeout(atMs = null) {
    if (this.active === null) return { paused: false, mustResume: false, elapsedMs: null };
    const now = Number.isFinite(atMs) ? atMs : this._now();
    const elapsed = now - this.active.pausedAtMs;
    if (elapsed > this.timeoutMs) {
      const timedOut = this.active;
      this.active = null;
      timedOut.timedOut = true;
      timedOut.mustResume = true;
      return { paused: false, mustResume: true, elapsedMs: elapsed, timedOutReason: 'pause-timeout', record: timedOut };
    }
    return { paused: true, mustResume: false, elapsedMs: elapsed };
  }

  /** 正常恢复。 */
  resume() {
    if (this.active === null) return { ok: true, wasPaused: false };
    this.active = null;
    return { ok: true, wasPaused: true };
  }

  projection() {
    return {
      paused: this.active !== null,
      active: this.active === null ? null : { ...this.active },
      timeouts: this.history.filter((record) => record.timedOut === true).length,
      pauses: this.history.length,
    };
  }
}

/* -----------------------------------------------------------------------------------------------
 * RT-05：签名运行时验证（静态结论 vs 运行时参数）
 * ---------------------------------------------------------------------------------------------- */

/**
 * 比对静态逆向出的签名参数与运行时观测到的参数。
 * `expected` 与 `observed` 都是 {name: value}；返回值逐项标记 match/mismatch/missing。
 * 一致率只统计「双方都有值」的项——缺项不算一致（防止用缺失刷高一致率）。
 */
export function verifySignatureAtRuntime({ expected = {}, observed = {} } = {}) {
  const names = [...new Set([...Object.keys(expected), ...Object.keys(observed)])];
  const comparisons = names.map((name) => {
    const exp = Object.hasOwn(expected, name) ? expected[name] : undefined;
    const obs = Object.hasOwn(observed, name) ? observed[name] : undefined;
    const sensitive = SENSITIVE_VARIABLE.test(name);
    // Sensitive values are compared by presence/type only, never echoed (RT-07).
    const shape = (value) => (value === undefined ? 'absent' : (typeof value === 'string' ? 'string:' + value.length : typeof value));
    let verdict;
    if (exp === undefined || obs === undefined) verdict = 'missing';
    else if (sensitive) verdict = shape(exp) === shape(obs) ? 'match-shape' : 'mismatch';
    else verdict = String(exp) === String(obs) ? 'match' : 'mismatch';
    return {
      name,
      verdict,
      sensitive,
      expected: sensitive ? shape(exp) : (exp === undefined ? null : String(exp).slice(0, 256)),
      observed: sensitive ? shape(obs) : (obs === undefined ? null : String(obs).slice(0, 256)),
    };
  });
  const comparable = comparisons.filter((entry) => entry.verdict !== 'missing');
  const matched = comparable.filter((entry) => entry.verdict === 'match' || entry.verdict === 'match-shape');
  return {
    comparisons,
    matched: matched.length,
    comparable: comparable.length,
    missing: comparisons.length - comparable.length,
    consistent: comparable.length > 0 && matched.length === comparable.length,
    rate: comparable.length === 0 ? null : matched.length / comparable.length,
    note: '一致率只统计双方都有值的项；缺失项不算一致。敏感值只比较形态（存在性/类型/长度），不回显。',
  };
}
