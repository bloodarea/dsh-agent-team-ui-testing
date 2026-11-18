/**
 * attack-surface.js — FR-02 攻击面自动发现（DISC-01..DISC-05、DISC-07）。
 *
 * 纯函数核心：从 Network P0 事件流与 DOM 事实提取结构化 Attack Surface Inventory。
 * 数据源与证据分级（需求说明书 FR-02）：
 *  - `observed`  —— 网络实发（Network.requestWillBeSent 记录到的真实请求）；
 *  - `inferred`  —— 从页面 DOM/表单 action 推断（尚未观测到实发）；
 *  - `unverified`—— 仅从 JS 字符串/静态线索推断（本模块不主动生成 JS 推断层，调用方可以注入）。
 *
 * 硬性规则：
 *  - 不把"前端 JS 字符串里有这个路径"当作接口真实可用的证据——那只能是 unverified/inferred；
 *  - 每个 API 操作必须带首次观测的 seq（证据回链）与 initiator 类型；
 *  - 认证状态只按已观测的请求头标记（带 Cookie/Authorization 头 → authenticated-observed），
 *    不做"这个接口应该需要登录"式的猜测；
 *  - 参数来源识别（DISC-04）：query / body-json / body-form / header / path 段。
 */

/** 证据级别（DISC-07）。 */
export const SURFACE_EVIDENCE_LEVELS = Object.freeze(['observed', 'inferred', 'unverified']);

/** 参数来源（DISC-04）。 */
export const SURFACE_PARAM_SOURCES = Object.freeze(['query', 'path', 'body-json', 'body-form', 'header']);

/** Inventory 上限（软预算；超出如实标记 truncated）。 */
export const SURFACE_LIMITS = Object.freeze({
  maxOperations: 200,
  maxRoutes: 100,
  maxForms: 50,
  maxParamsPerOperation: 24,
  maxEventsScanned: 20000,
});

/* -----------------------------------------------------------------------------------------------
 * URL / 事件解析原语
 * ---------------------------------------------------------------------------------------------- */

/** 解析 URL 为 {origin, path, query:{name:[…]}, ok}；解析失败 ok:false（不猜）。 */
export function parseSurfaceUrl(url) {
  if (typeof url !== 'string' || url === '') return { ok: false };
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return { ok: false };
    const query = {};
    for (const [name, value] of parsed.searchParams) {
      (query[name] ??= []).push(value);
    }
    return { ok: true, origin: parsed.origin, path: parsed.pathname, query };
  } catch {
    return { ok: false };
  }
}

/**
 * 事件的认证观测：只按已记录的请求头判断。
 * 头在事件上是脱敏投影（值可能是 '***'），但**头名存在**就是认证事实。
 */
export function observedAuthState(event) {
  const headers = event?.requestHeaders;
  if (headers && typeof headers === 'object') {
    const names = Object.keys(headers).map((name) => name.toLowerCase());
    if (names.includes('authorization')) return 'authorization-header';
    if (names.includes('cookie')) return 'cookie-header';
  }
  return 'no-auth-header-observed';
}

/* -----------------------------------------------------------------------------------------------
 * API 操作提取（DISC-01/04/05）
 * ---------------------------------------------------------------------------------------------- */

/**
 * 从事件数组提取 API 操作清单。
 *
 * 输入：Network P0 事件数组（phase='request' 的 http 事件；response 事件用于补充状态观测）。
 * 输出：{ operations, truncated, scanned }。每个操作：
 *   { key, method, origin, path, params:{query:[names], pathParamHints:[…]},
 *     evidence:'observed', firstSeq, lastSeq, requestCount, statusObserved:[…],
 *     authObserved, initiatorTypes:[…], resourceTypes:[…] }
 *
 * path 参数提示（DISC-04 的 path 来源）：形如 /users/123 的数字/uuid 尾段标记为 hint，
 * 不改写 path 本身——真实模板需要多观测对照，这里是提示不是结论。
 */
export function extractApiOperations(events, { originFilter = null, readHeaders = null, readBody = null } = {}) {
  if (!Array.isArray(events)) {
    return { operations: [], truncated: false, scanned: 0 };
  }
  const scanned = Math.min(events.length, SURFACE_LIMITS.maxEventsScanned);
  const requestEvents = [];
  for (const event of events.slice(0, scanned)) {
    if (event?.kind !== 'http' || event.phase !== 'request') continue;
    const parsed = parseSurfaceUrl(event.url);
    if (!parsed.ok) continue;
    if (originFilter && parsed.origin !== originFilter) continue;
    requestEvents.push({ event, parsed });
  }
  const byKey = new Map();
  const statusByRequestId = new Map();
  // 先扫 response：状态观测按 requestId 归并（同一请求可能多跳）。
  for (const event of events.slice(0, scanned)) {
    if (event?.kind === 'http' && event.phase === 'response' && event.requestId
      && Number.isInteger(event.status)) {
      const list = statusByRequestId.get(event.requestId) ?? [];
      list.push(event.status);
      statusByRequestId.set(event.requestId, list);
    }
  }
  for (const { event, parsed } of requestEvents) {
    const method = String(event.method || 'GET').toUpperCase();
    const key = method + ' ' + parsed.origin + parsed.path;
    let op = byKey.get(key);
    if (!op) {
      if (byKey.size >= SURFACE_LIMITS.maxOperations) {
        return { operations: [...byKey.values()], truncated: true, scanned };
      }
      op = {
        key,
        method,
        origin: parsed.origin,
        path: parsed.path,
        evidence: 'observed',
        // `body` and `header` are declared sources in SURFACE_PARAM_SOURCES; keeping them off the
        // record made DISC-04 unmeasurable for POST endpoints (their parameters live in the body).
        params: { query: [], pathHints: [], body: [], bodySources: [], header: [] },
        firstSeq: event.seq,
        lastSeq: event.seq,
        requestCount: 0,
        statusObserved: [],
        authObserved: null,
        initiatorTypes: [],
        resourceTypes: [],
        requestIds: [],
      };
      byKey.set(key, op);
    }
    op.requestCount += 1;
    op.lastSeq = Math.max(op.lastSeq, event.seq);
    if (op.firstSeq === null || event.seq < op.firstSeq) op.firstSeq = event.seq;
    for (const name of Object.keys(parsed.query)) {
      if (!op.params.query.includes(name) && op.params.query.length < SURFACE_LIMITS.maxParamsPerOperation) {
        op.params.query.push(name);
      }
    }
    // path 段提示：任何数字/uuid 段都是参数位提示（/users/123/orders → /api/users/{users-id}/orders）。
    // 提示不改写 path 本身——真实模板需要多观测对照，这里是提示不是结论。
    const segments = parsed.path.split('/').filter(Boolean);
    for (let i = 0; i < segments.length; i += 1) {
      const segment = segments[i];
      if (/^\d+$/.test(segment) || /^[0-9a-f]{8}-[0-9a-f]{4}/i.test(segment)) {
        const label = (segments[i - 1] || 'id').replace(/[^a-zA-Z0-9_-]/g, '') || 'id';
        const hint = '/' + segments.slice(0, i).join('/') + '/{' + label + '-id}' + (segments.length > i + 1 ? '/…' : '');
        if (!op.params.pathHints.includes(hint) && op.params.pathHints.length < 8) {
          op.params.pathHints.push(hint);
        }
      }
    }
    // Body parameters (DISC-04): FIELD NAMES ONLY, never values — a body routinely carries
    // tokens and passwords, so the inventory must not copy them. JSON and form-urlencoded are
    // recorded separately because they are different sources (body-json / body-form).
    // Bodies live in the collector's SEPARATE store (exactly like headers): the event does not
    // carry them, so the caller passes readBody(requestId) -> string. Reading only `event.postData`
    // silently produced an empty parameter model for every POST endpoint.
    let rawBody = typeof event.requestBody === 'string'
      ? event.requestBody
      : (typeof event.postData === 'string' ? event.postData : '');
    if (rawBody === '' && typeof readBody === 'function' && event.requestId) {
      try {
        const stored = readBody(event.requestId, event);
        if (typeof stored === 'string') {
          rawBody = stored;
        } else if (stored !== null && typeof stored === 'object') {
          // Accept either a plain text field or the collector's body block (`data`).
          if (typeof stored.text === 'string') rawBody = stored.text;
          else if (typeof stored.data === 'string' && stored.available !== false) rawBody = stored.data;
        }
      } catch { /* a body-store miss is "not observed", never a fabricated body */ }
    }
    if (rawBody !== '') {
      let bodyNames = [];
      let bodySource = null;
      const trimmed = rawBody.trim();
      if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
        const collect = (value, prefix) => {
          if (value === null || typeof value !== 'object') return;
          for (const [key, child] of Object.entries(value)) {
            const name = prefix === '' ? key : prefix + '.' + key;
            bodyNames.push(name);
            if (child !== null && typeof child === 'object' && !Array.isArray(child) && prefix === '') {
              collect(child, name);
            }
          }
        };
        try {
          const parsedBody = JSON.parse(trimmed);
          collect(Array.isArray(parsedBody) ? parsedBody[0] : parsedBody, '');
          bodySource = 'body-json';
        } catch { bodyNames = []; }
      } else if (/^[^=&#\s]+=[^&#]*/.test(trimmed)) {
        bodyNames = trimmed.split('&')
          .map((pair) => pair.split('=')[0])
          .map((key) => { try { return decodeURIComponent(key); } catch { return key; } })
          .filter((key) => key !== '');
        bodySource = 'body-form';
      }
      for (const name of bodyNames) {
        if (!op.params.body.includes(name) && op.params.body.length < SURFACE_LIMITS.maxParamsPerOperation) {
          op.params.body.push(name);
        }
      }
      if (bodySource !== null && !op.params.bodySources.includes(bodySource)) {
        op.params.bodySources.push(bodySource);
      }
    }
    // Request headers live in the collector's SEPARATE header store (not on the event): the
    // caller passes readHeaders(requestId) -> { headers } so auth is an observed fact, not a guess.
    let headers = event.requestHeaders ?? null;
    if (headers === null && typeof readHeaders === 'function' && event.requestId) {
      try {
        const found = readHeaders(event.requestId, event);
        if (found && found.headers) headers = found.headers;
      } catch { /* header store miss is "not observed", never a fabricated state */ }
    }
    // Header parameter names (DISC-04): names only, values are never copied.
    if (headers !== null && typeof headers === 'object') {
      for (const name of Object.keys(headers)) {
        const key = String(name).toLowerCase();
        if (op.params.header.includes(key) || op.params.header.length >= SURFACE_LIMITS.maxParamsPerOperation) continue;
        op.params.header.push(key);
      }
    }
    const auth = observedAuthState({ requestHeaders: headers });
    if (auth !== 'no-auth-header-observed') {
      // 任一次带认证头的观测就标记（保守：不推断"其余几次没带"）。
      op.authObserved = op.authObserved ?? auth;
    }
    const initiatorType = event.initiator?.type;
    if (initiatorType && !op.initiatorTypes.includes(initiatorType) && op.initiatorTypes.length < 8) {
      op.initiatorTypes.push(initiatorType);
    }
    const resourceType = event.resourceType;
    if (resourceType && !op.resourceTypes.includes(resourceType) && op.resourceTypes.length < 8) {
      op.resourceTypes.push(resourceType);
    }
    if (event.requestId && op.requestIds.length < 16) op.requestIds.push(event.requestId);
  }
  // 状态观测归并到操作（按 requestId → 最近一次所属 op；同一 requestId 属于一个操作）。
  const requestByRequestId = new Map();
  for (const { event } of requestEvents) {
    if (event.requestId) requestByRequestId.set(event.requestId, byKey.get(String(event.method || 'GET').toUpperCase() + ' ' + parseSurfaceUrl(event.url).origin + parseSurfaceUrl(event.url).path));
  }
  for (const [requestId, statuses] of statusByRequestId) {
    const op = requestByRequestId.get(requestId);
    if (!op) continue;
    for (const status of statuses) {
      if (!op.statusObserved.includes(status) && op.statusObserved.length < 16) op.statusObserved.push(status);
    }
  }
  const operations = [...byKey.values()].sort((a, b) => a.firstSeq - b.firstSeq);
  return { operations, truncated: false, scanned };
}

/* -----------------------------------------------------------------------------------------------
 * 页面路由提取（DISC-02）
 * ---------------------------------------------------------------------------------------------- */

/**
 * 从事件提取页面路由（resourceType=Document 的导航）。
 * 输出 { routes:[{path, origin, firstSeq, navigations, titles?}], truncated, scanned }。
 */
export function extractPageRoutes(events, { originFilter = null } = {}) {
  if (!Array.isArray(events)) return { routes: [], truncated: false, scanned: 0 };
  const scanned = Math.min(events.length, SURFACE_LIMITS.maxEventsScanned);
  const byPath = new Map();
  for (const event of events.slice(0, scanned)) {
    if (event?.kind !== 'http' || event.phase !== 'request') continue;
    if (event.resourceType !== 'Document') continue;
    const parsed = parseSurfaceUrl(event.url);
    if (!parsed.ok) continue;
    if (originFilter && parsed.origin !== originFilter) continue;
    const key = parsed.origin + parsed.path;
    let route = byPath.get(key);
    if (!route) {
      if (byPath.size >= SURFACE_LIMITS.maxRoutes) {
        return { routes: [...byPath.values()], truncated: true, scanned };
      }
      route = { key, origin: parsed.origin, path: parsed.path, evidence: 'observed', firstSeq: event.seq, navigations: 0 };
      byPath.set(key, route);
    }
    route.navigations += 1;
    route.lastSeq = event.seq;
  }
  return { routes: [...byPath.values()].sort((a, b) => a.firstSeq - b.firstSeq), truncated: false, scanned };
}

/* -----------------------------------------------------------------------------------------------
 * 表单提取（DISC-03）—— 调用方传 DOM 事实，本模块只做规范化
 * ---------------------------------------------------------------------------------------------- */

/**
 * 规范化一个表单事实（来自页面 DOM 读取，不是猜测）：
 * { action, method, fields:[{name, type, required?}], submitText? }
 * 返回 null 表示该事实不可用（不猜）。
 */
export function normalizeFormFact(raw) {
  if (typeof raw !== 'object' || raw === null) return null;
  const action = typeof raw.action === 'string' && raw.action !== '' ? raw.action : null;
  const method = String(raw.method || 'GET').toUpperCase();
  if (!['GET', 'POST', 'PUT', 'PATCH', 'DELETE'].includes(method)) return null;
  const fields = Array.isArray(raw.fields)
    ? raw.fields
      .filter((field) => field && typeof field === 'object' && typeof field.name === 'string')
      .slice(0, 24)
      .map((field) => ({
        name: field.name,
        type: typeof field.type === 'string' ? field.type : 'text',
        required: field.required === true,
      }))
    : [];
  return {
    action,
    method,
    fields,
    evidence: 'inferred', // DOM 里的 form 是"可发起"的证据，不是"已实发"
    submitText: typeof raw.submitText === 'string' ? raw.submitText.slice(0, 64) : null,
  };
}

/* -----------------------------------------------------------------------------------------------
 * Inventory 组装
 * ---------------------------------------------------------------------------------------------- */

/**
 * DISC-06：WebSocket / SSE 观测状态。
 * 能力声明必须与实测一致——采集器声明支持但从没观测到，与"目标不用 WS/SSE"是两件事，
 * 必须分开报告（`declared` 是采集器能力，`observed` 是本次真实采集到的事件）。
 */
export function transportObservation({ events = [], collectorDeclared = null } = {}) {
  const list = Array.isArray(events) ? events : [];
  const ws = list.filter((event) => event?.kind === 'ws');
  const sse = list.filter((event) => event?.kind === 'sse');
  const declared = collectorDeclared === null || typeof collectorDeclared !== 'object'
    ? { websocket: null, sse: null }
    : {
      websocket: collectorDeclared.websocket === true,
      sse: collectorDeclared.sse === true,
    };
  const status = (declaredFlag, observedCount) => {
    if (declaredFlag === null) return observedCount > 0 ? 'observed-unverified-declaration' : 'unknown';
    if (observedCount > 0) return 'observed';
    return declaredFlag ? 'declared-not-observed' : 'unsupported';
  };
  return {
    websocket: {
      declared: declared.websocket,
      observedEvents: ws.length,
      status: status(declared.websocket, ws.length),
      // frames arrive as `kind:'ws'` events with their own phase; only count real frames
      frames: ws.filter((event) => event?.ws?.direction === 'sent' || event?.ws?.direction === 'received').length,
    },
    sse: {
      declared: declared.sse,
      observedEvents: sse.length,
      status: status(declared.sse, sse.length),
    },
    note: 'declared 是采集器能力声明；observed 是本次真实采集。声明为真但未观测 ≠ 目标不使用 WS/SSE。',
  };
}

/**
 * 组装完整 Attack Surface Inventory。
 * @param {{events?:Array, forms?:Array, origin?:string|null, unverifiedPaths?:Array}} input
 */
export function buildSurfaceInventory({ events = [], forms = [], origin = null, unverifiedPaths = [], documentTitle = null, documentUrl = null, readHeaders = null, readBody = null, collectorDeclared = null } = {}) {
  const api = extractApiOperations(events, { readHeaders, readBody });
  const routes = extractPageRoutes(events, { originFilter: origin });
  const normalizedForms = [];
  for (const raw of forms.slice(0, SURFACE_LIMITS.maxForms)) {
    const fact = normalizeFormFact(raw);
    if (fact) normalizedForms.push(fact);
  }
  const unverified = (Array.isArray(unverifiedPaths) ? unverifiedPaths : [])
    .filter((path) => typeof path === 'string' && path.startsWith('/'))
    .slice(0, SURFACE_LIMITS.maxRoutes)
    .map((path) => ({ path, evidence: 'unverified', note: '来自静态线索（JS 字符串等）；未观测到实发' }));
  return {
    kind: 'dsh-ui-testing-surface-inventory',
    version: 1,
    generatedAt: Date.now(),
    scope: { origin },
    document: { url: documentUrl ?? null, title: documentTitle ?? null },
    counts: {
      apiOperations: api.operations.length,
      pageRoutes: routes.routes.length,
      forms: normalizedForms.length,
      unverifiedPaths: unverified.length,
    },
    apiOperations: api.operations,
    pageRoutes: routes.routes,
    forms: normalizedForms,
    unverifiedPaths: unverified,
    transports: transportObservation({ events, collectorDeclared }),
    truncated: { events: api.truncated || routes.truncated },
    scannedEvents: api.scanned,
  };
}

/* -----------------------------------------------------------------------------------------------
 * DISC-07 证据分级校验（供验收抽样）
 * ---------------------------------------------------------------------------------------------- */

/**
 * 校验 Inventory 中每条记录的 evidence 标记与来源一致：
 *  - apiOperations/pageRoutes 必须全部 observed（它们只来自网络实发）；
 *  - forms 必须 inferred；
 *  - unverifiedPaths 必须 unverified。
 * 返回 { ok, violations:[…] }；验收 Oracle 抽样用。
 */
export function checkEvidenceLevels(inventory) {
  const violations = [];
  if (typeof inventory !== 'object' || inventory === null) {
    return { ok: false, violations: [{ where: 'root', reason: 'inventory-missing' }] };
  }
  for (const op of inventory.apiOperations ?? []) {
    if (op.evidence !== 'observed') violations.push({ where: 'apiOperations', key: op.key, evidence: op.evidence });
  }
  for (const route of inventory.pageRoutes ?? []) {
    if (route.evidence !== 'observed') violations.push({ where: 'pageRoutes', key: route.key, evidence: route.evidence });
  }
  for (const form of inventory.forms ?? []) {
    if (form.evidence !== 'inferred') violations.push({ where: 'forms', action: form.action, evidence: form.evidence });
  }
  for (const path of inventory.unverifiedPaths ?? []) {
    if (path.evidence !== 'unverified') violations.push({ where: 'unverifiedPaths', path: path.path, evidence: path.evidence });
  }
  return { ok: violations.length === 0, violations };
}
