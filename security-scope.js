/**
 * security-scope.js — FR-01 Scope & Safety Controller（GATE-01 / INF-01..INF-08）。
 *
 * 安全测试会话的授权边界：每个 Runtime 挂一个 ScopeStore；所有主动派发（导航、页面内 fetch、
 * 独立 HTTP、导出写入）在派发前过 checkDispatch。纯函数核心无 CDP 无文件依赖。
 *
 * 硬性规则（需求说明书 FR-01 / §6，验收清单 INF-01..INF-08）：
 *  - Origin allowlist 为精确 Origin 匹配（协议+主机+端口）；路径约束可进一步收紧（前缀匹配）。
 *  - 重定向每一跳都要重新校验（Host 层在 CDP 帧里逐跳调用 checkDispatch）。
 *  - 请求预算：maxRequests / maxConcurrent / timeWindow；超预算 0 次实际派发。
 *  - 默认被动探索（passive）；主动测试（active）需要显式 set 并留下策略记录。
 *  - stop() 之后 0 次新派发（INF-07）；stop 是幂等且不可撤销的（必须重建会话）。
 *  - 每次接受/拒绝都产生审计记录（actionId 由调用方携带），拒绝记录包含原因码。
 */

/** 错误码字符串（browser-safety.js TAXONOMY 注册 SCOPE_* 后生效）。 */
export const SCOPE_ERROR_CODES = Object.freeze({
  INVALID_ARGUMENT: 'SECURITY_SCOPE_INVALID',
  NOT_CONFIGURED: 'SECURITY_SCOPE_NOT_CONFIGURED',
  STOPPED: 'SECURITY_SCOPE_STOPPED',
  ORIGIN_VIOLATION: 'SECURITY_SCOPE_ORIGIN_VIOLATION',
  PATH_VIOLATION: 'SECURITY_SCOPE_PATH_VIOLATION',
  BUDGET_EXCEEDED: 'SECURITY_SCOPE_BUDGET_EXCEEDED',
  PASSIVE_MODE: 'SECURITY_SCOPE_PASSIVE_MODE',
  CONCURRENCY_EXCEEDED: 'SECURITY_SCOPE_CONCURRENCY_EXCEEDED',
  DANGEROUS_OPERATION: 'SECURITY_SCOPE_DANGEROUS_OPERATION',
  RATE_EXCEEDED: 'SECURITY_SCOPE_RATE_EXCEEDED',
});

/** Scope 会话配置的默认值。 */
export const SCOPE_DEFAULTS = Object.freeze({
  maxRequests: 500,
  maxConcurrent: 4,
  /** INF-05 rate limit: dispatches allowed per rolling second. 0 disables the limiter. */
  maxRequestsPerSecond: 20,
  timeWindowMs: 30 * 60 * 1000,
  mode: 'passive', // 'passive' | 'active'
  allowedOrigins: Object.freeze([]),
  allowedPaths: Object.freeze([]), // 前缀约束（作用于 pathname）；空数组 = 不收紧
});

/** 审计记录保留上限（滚动丢弃最旧的，审计计数保持完整）。 */
export const SCOPE_AUDIT_MAX = 2000;

/* -----------------------------------------------------------------------------------------------
 * 纯函数：Origin / 路径匹配
 * ---------------------------------------------------------------------------------------------- */

/** 精确 Origin（协议+主机+端口）；非 http/https 或解析失败 → null（fail closed）。 */
export function originOf(url) {
  if (typeof url !== 'string' || url.trim() === '') return null;
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return null;
  return parsed.origin;
}

/** 归一化路径约束：必须以 / 开头，去尾部斜杠（根除外）。 */
export function normalizePathPrefix(prefix) {
  if (typeof prefix !== 'string' || !prefix.startsWith('/')) return null;
  const trimmed = prefix.length > 1 ? prefix.replace(/\/+$/, '') : '/';
  if (trimmed.length > 256) return null;
  return trimmed;
}

/** 路径前缀匹配：allowedPaths 为空 = 不收紧；'/x' 匹配 '/x' 与 '/x/y'，不匹配 '/xy'。 */
export function pathMatches(pathname, allowedPaths) {
  if (!Array.isArray(allowedPaths) || allowedPaths.length === 0) return true;
  for (const prefix of allowedPaths) {
    if (prefix === '/') return true;
    if (pathname === prefix) return true;
    if (pathname.startsWith(prefix + '/')) return true;
  }
  return false;
}

/* -----------------------------------------------------------------------------------------------
 * 配置规范化
 * ---------------------------------------------------------------------------------------------- */

/**
 * 校验并归一化 scope 配置。非法输入抛 { code, message }（不含 url 等敏感内容）。
 * allowedOrigins 每条都必须是可解析的 http/https Origin；allowedPaths 每条都必须是合法前缀。
 */
export function normalizeScopeConfig(input) {
  if (typeof input !== 'object' || input === null) {
    throw { code: SCOPE_ERROR_CODES.INVALID_ARGUMENT, message: 'scope 配置必须是对象' };
  }
  const out = { ...SCOPE_DEFAULTS, allowedOrigins: [], allowedPaths: [] };
  // A scope without a whitelist is no scope at all: missing or empty allowedOrigins must refuse
  // (fail closed) — "configure nothing, allow everything" is the opposite of this controller.
  const origins = input.allowedOrigins ?? input.origins;
  if (!Array.isArray(origins) || origins.length === 0) {
    throw { code: SCOPE_ERROR_CODES.INVALID_ARGUMENT, message: 'allowedOrigins 必须是非空数组（无白名单等于无 scope）' };
  }
  if (origins.length > 16) {
    throw { code: SCOPE_ERROR_CODES.INVALID_ARGUMENT, message: 'allowedOrigins 最多 16 条' };
  }
  const seen = new Set();
  for (const raw of origins) {
    const origin = originOf(raw);
    if (origin === null || origin !== raw) {
      throw { code: SCOPE_ERROR_CODES.INVALID_ARGUMENT, message: 'allowedOrigins 每条必须是完整精确 Origin（协议+主机+端口）' };
    }
    if (seen.has(origin)) continue;
    seen.add(origin);
    out.allowedOrigins.push(origin);
  }
  if (input.allowedPaths !== undefined) {
    if (!Array.isArray(input.allowedPaths) || input.allowedPaths.length > 16) {
      throw { code: SCOPE_ERROR_CODES.INVALID_ARGUMENT, message: 'allowedPaths 必须是 ≤16 条的数组' };
    }
    for (const prefix of input.allowedPaths) {
      const normalized = normalizePathPrefix(prefix);
      if (normalized === null) {
        throw { code: SCOPE_ERROR_CODES.INVALID_ARGUMENT, message: 'allowedPaths 每条必须是以 / 开头的路径前缀' };
      }
      if (!out.allowedPaths.includes(normalized)) out.allowedPaths.push(normalized);
    }
  }
  for (const key of ['maxRequests', 'maxConcurrent', 'maxRequestsPerSecond', 'timeWindowMs']) {
    if (input[key] !== undefined) {
      const value = Number(input[key]);
      // maxRequestsPerSecond = 0 is the explicit "no rate limit" setting; everything else positive.
      if (key === 'maxRequestsPerSecond' && value === 0) { out[key] = 0; continue; }
      if (!Number.isInteger(value) || value <= 0) {
        throw { code: SCOPE_ERROR_CODES.INVALID_ARGUMENT, message: key + ' 必须是正整数（maxRequestsPerSecond 可为 0 = 关闭）' };
      }
      out[key] = value;
    }
  }
  if (out.maxConcurrent > 16) {
    throw { code: SCOPE_ERROR_CODES.INVALID_ARGUMENT, message: 'maxConcurrent 上限 16' };
  }
  if (out.maxRequestsPerSecond > 1000) {
    throw { code: SCOPE_ERROR_CODES.INVALID_ARGUMENT, message: 'maxRequestsPerSecond 上限 1000' };
  }
  if (out.timeWindowMs > 6 * 60 * 60 * 1000) {
    throw { code: SCOPE_ERROR_CODES.INVALID_ARGUMENT, message: 'timeWindowMs 上限 6 小时' };
  }
  if (input.mode !== undefined) {
    if (input.mode !== 'passive' && input.mode !== 'active') {
      throw { code: SCOPE_ERROR_CODES.INVALID_ARGUMENT, message: "mode 必须是 'passive' 或 'active'" };
    }
    out.mode = input.mode;
  }
  return out;
}

/* -----------------------------------------------------------------------------------------------
 * INF-08：危险操作识别（GATE-07/INF-08）。对 method+path 的破坏性组合给出确定性判定。
 * 依据需求 §2.2 非目标：支付提交、数据删除、账号注册轰炸、外部回连是默认禁止项。
 * 这是"模式识别"不是"内容审查"：DELETE/PUT 到任何 path、POST 到支付/注册语义 path、
 * 以及目标 Origin 之外的绝对 URL 回连，都是结构级危险信号。
 */

/** 危险 path 语义词根（英文为主；命中即危险，大小写不敏感）。 */
export const DANGEROUS_PATH_PATTERNS = Object.freeze([
  /pay/i, /checkout\/commit/i, /purchase/i, /order\/?confirm/i,
  /register/i, /signup/i,
  /delete/i, /\/destro/i, /purge/i, /reset(-|_)?all/i,
  /admin\/?users?\/?delete/i,
]);

/** 结构性危险 method：任何资源上都是破坏信号（即使 path 无语义词）。 */
export const DANGEROUS_METHODS = Object.freeze(['DELETE']);

/** 外部回连判定：URL 的 Origin 不在白名单内(由 store 的白名单决定)即视为回连候选。 */
export function classifyDanger({ method = 'GET', url = '', allowedOrigins = [] } = {}) {
  const origin = originOf(url);
  if (origin === null) return { dangerous: false, reason: null };
  if (!allowedOrigins.includes(origin)) {
    return { dangerous: true, reason: 'out-of-scope-origin', origin };
  }
  let pathname = '/';
  try { pathname = new URL(url).pathname; } catch { /* unreachable: originOf parsed it */ }
  const methodUpper = String(method || 'GET').toUpperCase();
  if (DANGEROUS_METHODS.includes(methodUpper)) {
    return { dangerous: true, reason: 'destructive-method', method: methodUpper };
  }
  const pathLower = pathname.toLowerCase();
  for (const pattern of DANGEROUS_PATH_PATTERNS) {
    if (pattern.test(pathLower)) {
      return { dangerous: true, reason: 'dangerous-path:' + pattern.source, path: pathname };
    }
  }
  // POST/PUT/PATCH 到语义写路径之外的路径不算危险（主动测试的正常面），但记录为写操作。
  if (['POST', 'PUT', 'PATCH'].includes(methodUpper)) {
    return { dangerous: false, reason: null, writeOperation: true, method: methodUpper };
  }
  return { dangerous: false, reason: null };
}

/* -----------------------------------------------------------------------------------------------
 * ScopeStore：一个 Runtime 一个实例
 * ---------------------------------------------------------------------------------------------- */

/**
 * 会话级 Scope 状态机。
 *
 * 生命周期：configure（或 reconfigure，CAS expectedConfigRevision）→ dispatch 计数/校验 → stop。
 * stop 之后 stopAll=true 不可撤销；重新 configure 抛 SECURITY_SCOPE_STOPPED，必须换新实例
 * （Runtime 重建时自然获得）。
 */
export class ScopeStore {
  constructor({ scopeId = 'unscoped', now = Date.now } = {}) {
    this.scopeId = String(scopeId);
    this._now = typeof now === 'function' ? now : () => now;
    this.config = null;
    this.configRevision = 0;
    this.stopped = false;
    this.stoppedAt = null;
    this.stopReason = null;
    this.startedAt = null;
    this.dispatches = 0;
    this.rejected = 0;
    this.inFlight = 0;
    this.windowStart = null;
    this.windowDispatches = 0;
    /** Timestamps of recent dispatches inside the current 1s rate window (INF-05). */
    this.recentDispatches = [];
    this.audit = [];
    this.auditDropped = 0;
  }

  #audit(event) {
    this.audit.push({ ...event, seq: this.auditDropped + this.audit.length + 1, at: this._now() });
    if (this.audit.length > SCOPE_AUDIT_MAX) {
      const drop = this.audit.length - SCOPE_AUDIT_MAX;
      this.audit.splice(0, drop);
      this.auditDropped += drop;
    }
  }

  /** status 投影用的审计尾部：剥掉 target（探索轨迹不进状态投影，只进 evidence 导出）。 */
  #auditTailProjection() {
    if (this.audit.length === 0) return null;
    const { target, ...rest } = this.audit[this.audit.length - 1];
    return rest;
  }

  /** 当前是否已配置且未停止（Host 层据此决定 checkDispatch 是否可用）。 */
  get active() {
    return this.config !== null && !this.stopped;
  }

  /**
   * 配置（首次）或重配置（CAS）。重配置不重置预算计数（预算是会话事实，不是配置事实），
   * 但 mode/origins/paths 立即生效——下一次 dispatch 就按新边界校验。
   */
  configure(input, { expectedConfigRevision, actionId = null } = {}) {
    if (this.stopped) {
      throw { code: SCOPE_ERROR_CODES.STOPPED, message: 'scope 会话已停止；配置不可变更', details: { stoppedAt: this.stoppedAt, reason: this.stopReason } };
    }
    if (this.config !== null && expectedConfigRevision !== undefined) {
      if (expectedConfigRevision !== this.configRevision) {
        throw { code: SCOPE_ERROR_CODES.INVALID_ARGUMENT, message: '配置版本冲突', details: { expected: expectedConfigRevision, actual: this.configRevision } };
      }
    }
    const next = normalizeScopeConfig(input);
    const first = this.config === null;
    this.config = next;
    this.configRevision += 1;
    if (first) {
      this.startedAt = this._now();
      this.windowStart = this.startedAt;
    }
    this.#audit({ kind: 'configure', actionId, configRevision: this.configRevision, mode: next.mode, origins: [...next.allowedOrigins], paths: [...next.allowedPaths] });
    return this.config;
  }

  /** 停止：幂等、不可撤销；停止后 0 次新派发（INF-07）。 */
  stop({ reason = null, actionId = null } = {}) {
    if (this.stopped) {
      this.#audit({ kind: 'stop-already', actionId });
      return { ok: true, alreadyStopped: true, stoppedAt: this.stoppedAt };
    }
    this.stopped = true;
    this.stoppedAt = this._now();
    this.stopReason = reason === null || typeof reason === 'string' ? reason : String(reason);
    this.#audit({ kind: 'stop', actionId, reason: this.stopReason, dispatches: this.dispatches, rejected: this.rejected });
    return { ok: true, alreadyStopped: false, stoppedAt: this.stoppedAt, dispatches: this.dispatches, rejected: this.rejected };
  }

  /**
   * 派发前校验（GATE-01：所有请求在派发前 100% 校验）。
   *
   * @param {string} url 目标 URL
   * @param {{actionId?:string, kind?:string, active?:boolean}} options
   *   kind: 'navigate'|'request'|'redirect-hop'|'export'|'eval' 等（审计用途）
   *   active: 本次派发是否为主动测试（默认按 kind 判断：navigate/request 是主动）
   * @returns {{ok:true, origin, pathname}} 或抛 { code, message, details }
   */
  checkDispatch(url, { actionId = null, kind = 'request', active, method = 'GET', allowDangerous = false } = {}) {
    // stop 之后一切拒绝（INF-07：0 次新派发），包括被动读取。
    if (this.stopped) {
      this.rejected += 1;
      this.#audit({ kind: 'reject', actionId, code: SCOPE_ERROR_CODES.STOPPED, target: url, dispatchKind: kind });
      throw { code: SCOPE_ERROR_CODES.STOPPED, message: 'scope 会话已停止；不派发任何新请求', details: { stoppedAt: this.stoppedAt } };
    }
    if (!this.config) {
      this.rejected += 1;
      this.#audit({ kind: 'reject', actionId, code: SCOPE_ERROR_CODES.NOT_CONFIGURED, target: url, dispatchKind: kind });
      throw { code: SCOPE_ERROR_CODES.NOT_CONFIGURED, message: 'scope 会话未配置；先用 browser_security_scope set 建立 Origin 白名单', details: {} };
    }
    const origin = originOf(url);
    if (origin === null) {
      this.rejected += 1;
      this.#audit({ kind: 'reject', actionId, code: SCOPE_ERROR_CODES.ORIGIN_VIOLATION, target: url, dispatchKind: kind });
      throw { code: SCOPE_ERROR_CODES.ORIGIN_VIOLATION, message: '目标 URL 不可解析或非 http/https', details: { dispatchKind: kind } };
    }
    if (!this.config.allowedOrigins.includes(origin)) {
      this.rejected += 1;
      this.#audit({ kind: 'reject', actionId, code: SCOPE_ERROR_CODES.ORIGIN_VIOLATION, target: url, dispatchKind: kind, origin });
      throw { code: SCOPE_ERROR_CODES.ORIGIN_VIOLATION, message: '目标 Origin 不在授权白名单内；0 次派发', details: { origin, dispatchKind: kind } };
    }
    let pathname;
    try {
      pathname = new URL(url).pathname;
    } catch {
      pathname = '/';
    }
    if (!pathMatches(pathname, this.config.allowedPaths)) {
      this.rejected += 1;
      this.#audit({ kind: 'reject', actionId, code: SCOPE_ERROR_CODES.PATH_VIOLATION, target: url, dispatchKind: kind, origin });
      throw { code: SCOPE_ERROR_CODES.PATH_VIOLATION, message: '目标路径超出授权路径约束；0 次派发', details: { origin, dispatchKind: kind } };
    }
    // ---- INF-08 / GATE-07：危险操作闸门 -------------------------------------------------------
    // Default-closed: payment/registration/purge/DELETE and out-of-scope origins refuse with 0
    // dispatches. `allowDangerous:true` is the explicit per-call escalation (still audited) —
    // it never becomes a session-wide switch, so one permitted destructive probe cannot silently
    // authorise the next one.
    const danger = classifyDanger({ method, url, allowedOrigins: this.config.allowedOrigins });
    if (danger.dangerous && allowDangerous !== true) {
      this.rejected += 1;
      this.#audit({ kind: 'reject', actionId, code: SCOPE_ERROR_CODES.DANGEROUS_OPERATION, target: url, dispatchKind: kind, reason: danger.reason });
      throw {
        code: SCOPE_ERROR_CODES.DANGEROUS_OPERATION,
        message: '危险操作被默认禁止；0 次派发。确需验证时用 allowDangerous=true 显式升级（会留审计）',
        details: { reason: danger.reason, method: String(method || 'GET').toUpperCase(), dispatchKind: kind },
      };
    }
    // ---- 预算与并发（INF-04/INF-05） ---------------------------------------------------------
    const now = this._now();
    if (this.windowStart === null || now - this.windowStart >= this.config.timeWindowMs) {
      this.windowStart = now;
      this.windowDispatches = 0;
    }
    if (this.windowDispatches + 1 > this.config.maxRequests) {
      this.rejected += 1;
      this.#audit({ kind: 'reject', actionId, code: SCOPE_ERROR_CODES.BUDGET_EXCEEDED, target: url, dispatchKind: kind });
      throw { code: SCOPE_ERROR_CODES.BUDGET_EXCEEDED, message: '请求预算已用尽；0 次派发', details: { maxRequests: this.config.maxRequests, windowDispatches: this.windowDispatches } };
    }
    if (this.inFlight + 1 > this.config.maxConcurrent) {
      this.rejected += 1;
      this.#audit({ kind: 'reject', actionId, code: SCOPE_ERROR_CODES.CONCURRENCY_EXCEEDED, target: url, dispatchKind: kind });
      throw { code: SCOPE_ERROR_CODES.CONCURRENCY_EXCEEDED, message: '并发超出 scope 上限；0 次派发', details: { maxConcurrent: this.config.maxConcurrent, inFlight: this.inFlight } };
    }
    // ---- 速率（INF-05）：滚动 1 秒窗口内的派发上限 -------------------------------------------
    // `maxRequestsPerSecond` is the fine-grained companion to the coarse time-window budget: a
    // burst of 200 requests inside one second is "within budget" yet still abusive, so the rate
    // limiter refuses it with its own code and 0 dispatches.
    const rateLimit = this.config.maxRequestsPerSecond;
    if (Number.isInteger(rateLimit) && rateLimit > 0) {
      const oneSecondAgo = now - 1000;
      this.recentDispatches = this.recentDispatches.filter((at) => at > oneSecondAgo);
      if (this.recentDispatches.length >= rateLimit) {
        this.rejected += 1;
        this.#audit({ kind: 'reject', actionId, code: SCOPE_ERROR_CODES.RATE_EXCEEDED, target: url, dispatchKind: kind });
        throw {
          code: SCOPE_ERROR_CODES.RATE_EXCEEDED,
          message: '请求速率超出 scope 上限（1 秒窗口）；0 次派发',
          details: { maxRequestsPerSecond: rateLimit, inWindow: this.recentDispatches.length, dispatchKind: kind },
        };
      }
      this.recentDispatches.push(now);
    }
    // ---- 被动/主动模式（INF-06） -------------------------------------------------------------
    const isActive = active === undefined ? (kind !== 'redirect-hop' && kind !== 'eval') : active === true;
    if (isActive && this.config.mode !== 'active') {
      this.rejected += 1;
      this.#audit({ kind: 'reject', actionId, code: SCOPE_ERROR_CODES.PASSIVE_MODE, target: url, dispatchKind: kind });
      throw { code: SCOPE_ERROR_CODES.PASSIVE_MODE, message: 'scope 处于被动模式；主动派发需先 set mode=active', details: { dispatchKind: kind } };
    }
    this.dispatches += 1;
    this.windowDispatches += 1;
    this.inFlight += 1;
    this.#audit({ kind: 'dispatch', actionId, target: url, dispatchKind: kind, origin, seq: this.dispatches });
    return { ok: true, origin, pathname };
  }

  /** 派发完成（成功或失败都调用）；配对 checkDispatch 的 inFlight 计数。 */
  completeDispatch() {
    if (this.inFlight > 0) this.inFlight -= 1;
  }

  /**
   * 状态投影（工具 status 动作的返回值）。不含任何目标 URL——审计里的是允许域内的地址，
   * 但投影只给计数与边界，避免把探索轨迹泄漏给无关调用方。
   */
  status() {
    return {
      ok: true,
      scopeId: this.scopeId,
      active: this.active,
      stopped: this.stopped,
      ...(this.stopped ? { stoppedAt: this.stoppedAt, stopReason: this.stopReason } : {}),
      config: this.config === null ? null : {
        allowedOrigins: [...this.config.allowedOrigins],
        allowedPaths: [...this.config.allowedPaths],
        maxRequests: this.config.maxRequests,
        maxConcurrent: this.config.maxConcurrent,
        maxRequestsPerSecond: this.config.maxRequestsPerSecond,
        timeWindowMs: this.config.timeWindowMs,
        mode: this.config.mode,
      },
      configRevision: this.configRevision,
      counters: {
        dispatches: this.dispatches,
        rejected: this.rejected,
        inFlight: this.inFlight,
        windowDispatches: this.windowDispatches,
        windowStart: this.windowStart,
        startedAt: this.startedAt,
      },
      audit: {
        kept: this.audit.length,
        dropped: this.auditDropped,
        last: this.#auditTailProjection(),
      },
    };
  }

  /** 最近审计条目（按 kind 过滤，可选）。用于证据导出与越界审计复核。 */
  auditEntries({ kind = null, limit = 50 } = {}) {
    let entries = this.audit;
    if (kind !== null) entries = entries.filter((entry) => entry.kind === kind);
    return entries.slice(-limit);
  }
}
