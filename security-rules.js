/**
 * security-rules.js — FR-09 安全规则引擎（VULN-01..VULN-07、VULN-10/VULN-11）。
 *
 * 规则是**纯函数**：输入已观测的事实（请求/响应/头/DOM/CORS 结果），输出候选项（candidate），
 * 绝不自己发请求、也绝不把静态推断升级成 confirmed（状态由 finding.deriveStatus 强制约束）。
 *
 * 每条规则输出统一结构：
 *   { ruleId, category, severity, title, basis, evidence, impact, remediation, confidence }
 * 其中 `basis` 决定最高状态（static-pattern → potential；observed-once → likely；
 * differential/reproduced → 可到 confirmed，但仍需 finding.js 的复现+对照门槛）。
 */

export const RULES_VERSION = 1;

/**
 * 读取响应头值并归一成字符串。
 *
 * 采集器的 header 包是多值的（`{ 'access-control-allow-origin': ['http://x'] }`），
 * 只做 `typeof value === 'string'` 判断会把**存在的头当成缺失**：CORS 因此永远不触发，
 * 安全头也可能被误报缺失。这里统一归一：数组取首个非空值，字符串原样，其它类型视为缺失。
 */
export function headerValue(headers, name) {
  if (headers === null || typeof headers !== 'object') return null;
  const wanted = String(name).toLowerCase();
  let raw = headers[wanted];
  if (raw === undefined) raw = headers[name];
  if (raw === undefined) {
    // Header bags reach us with varying casing; match case-insensitively instead of missing a
    // header just because it arrived as `X-A` rather than `x-a`.
    for (const key of Object.keys(headers)) {
      if (key.toLowerCase() === wanted) { raw = headers[key]; break; }
    }
  }
  if (typeof raw === 'string') return raw === '' ? null : raw;
  if (Array.isArray(raw)) {
    const first = raw.find((entry) => typeof entry === 'string' && entry !== '');
    return first ?? null;
  }
  if (raw !== null && raw !== undefined && typeof raw !== 'object') return String(raw);
  return null;
}

/** 安全响应头基线（VULN-07 的判定依据；缺失才报，存在即通过）。 */
export const SECURITY_HEADERS = Object.freeze([
  { name: 'content-security-policy', severity: 'medium', title: '缺少 Content-Security-Policy' },
  { name: 'x-content-type-options', severity: 'low', title: '缺少 X-Content-Type-Options' },
  { name: 'x-frame-options', severity: 'low', title: '缺少 X-Frame-Options' },
  { name: 'strict-transport-security', severity: 'low', title: '缺少 Strict-Transport-Security（HTTPS 目标）', httpsOnly: true },
  { name: 'referrer-policy', severity: 'low', title: '缺少 Referrer-Policy' },
]);

/** 规则 id 一览（报告与验收引用）。 */
export const RULE_IDS = Object.freeze([
  'AUTH-VERBOSE-ERROR', 'AUTH-ANON-ACCESS', 'AUTHZ-OBJECT', 'AUTHZ-FUNCTION',
  'PARAM-TYPE', 'PARAM-BOUNDARY', 'PARAM-REPEAT',
  'INJ-ERROR-SIGNATURE', 'INJ-BOOLEAN-DIFF', 'XSS-DOM-SINK', 'XSS-STORED-REFLECT',
  'CORS-WILDCARD', 'CORS-CREDENTIALS', 'HEADER-MISSING',
  'DISC-DEBUG-ENDPOINT', 'BIZ-CLIENT-TRUST',
]);

/* -----------------------------------------------------------------------------------------------
 * VULN-01：认证与会话
 * ---------------------------------------------------------------------------------------------- */

/**
 * 匿名访问受保护资源：同一端点在"登录态"返回 2xx、在"匿名态"也返回 2xx 且内容非空。
 * `anon`/`authed` 都是观测事实；只有确实两者都成功才成立。
 */
export function ruleAnonAccess({ endpoint, anon, authed }) {
  if (!anon || !authed) return null;
  if (!(anon.status >= 200 && anon.status < 300) || !(authed.status >= 200 && authed.status < 300)) return null;
  // A login-required endpoint that answers 200 to an anonymous caller is the finding.
  const lookup = /\/api\/(login|health|public)/i.test(endpoint ?? '');
  if (lookup) return null;
  return {
    ruleId: 'AUTH-ANON-ACCESS',
    category: 'authentication',
    severity: 'high',
    title: '受保护接口可匿名访问',
    basis: 'differential',
    confidence: 0.9,
    evidence: { endpoint, anonStatus: anon.status, authedStatus: authed.status },
    impact: '未登录即可读取受保护资源，可能造成数据泄露。',
    remediation: '在该端点强制会话校验；对未认证请求返回 401/403。',
  };
}

/** 错误信息泄露（VULN-01/信息泄露）：响应体含堆栈/调试/SQL 等特征。 */
export function ruleVerboseError({ endpoint, response }) {
  const body = typeof response?.body === 'string' ? response.body : '';
  if (body === '') return null;
  const signatures = [
    { id: 'traceback', pattern: /Traceback \(most recent call last\)/i },
    { id: 'stack-frame', pattern: /\bat\s+[\w$.]+\s+\([^)]*:\d+:\d+\)/ },
    { id: 'sql-error', pattern: /(SQL syntax|sqlite3\.|psycopg2|SQLSTATE)/i },
    { id: 'debug-flag', pattern: /"?(debug|DEBUG)"?\s*[:=]\s*true/ },
  ];
  const hit = signatures.find((signature) => signature.pattern.test(body));
  if (!hit) return null;
  return {
    ruleId: 'AUTH-VERBOSE-ERROR',
    category: 'information-disclosure',
    severity: 'medium',
    title: '错误响应泄露内部实现细节',
    basis: 'observed-once',
    confidence: 0.8,
    evidence: { endpoint, signature: hit.id, status: response?.status ?? null },
    impact: '堆栈/SQL 细节可帮助攻击者定位后端结构与注入点。',
    remediation: '生产环境关闭调试输出，返回通用错误页并记录服务端日志。',
  };
}

/* -----------------------------------------------------------------------------------------------
 * VULN-02/03：授权（横向/纵向）
 * ---------------------------------------------------------------------------------------------- */

/**
 * 对象级授权（AUTHZ-OBJECT）：身份 A 与身份 B 对同一对象端点各自请求，A 能读到 B 的对象。
 * 入参是两次真实观测（不同会话），所以 basis=differential。
 */
export function ruleObjectAuthorization({ endpoint, asOwner, asOther, objectLooksLikeOther }) {
  if (!asOwner || !asOther) return null;
  if (!(asOther.status >= 200 && asOther.status < 300)) return null;
  if (objectLooksLikeOther !== true) return null;
  return {
    ruleId: 'AUTHZ-OBJECT',
    category: 'authorization-object',
    severity: 'critical',
    title: '对象级授权缺失（可越权读取他人对象）',
    basis: 'differential',
    confidence: 0.95,
    evidence: { endpoint, ownerStatus: asOwner.status, otherStatus: asOther.status },
    impact: '任意登录用户可读取他人业务对象（IDOR），属高危数据泄露。',
    remediation: '在服务端按当前会话主体校验对象归属，不依赖客户端传入的 id。',
  };
}

/** 功能级授权（AUTHZ-FUNCTION）：普通用户访问管理端端点成功。 */
export function ruleFunctionAuthorization({ endpoint, asUser, asAdmin }) {
  if (!asUser || !asAdmin) return null;
  const userOk = asUser.status >= 200 && asUser.status < 300;
  const adminOk = asAdmin.status >= 200 && asAdmin.status < 300;
  if (!(userOk && adminOk)) return null;
  return {
    ruleId: 'AUTHZ-FUNCTION',
    category: 'authorization-function',
    severity: 'high',
    title: '功能级授权缺失（普通用户可访问管理端点）',
    basis: 'differential',
    confidence: 0.9,
    evidence: { endpoint, userStatus: asUser.status, adminStatus: asAdmin.status },
    impact: '普通用户可执行管理操作，可能造成配置篡改或全量数据泄露。',
    remediation: '在管理端路由上校验角色，服务端强制而非隐藏按钮。',
  };
}

/* -----------------------------------------------------------------------------------------------
 * VULN-04：参数篡改（类型/边界/重复）
 * ---------------------------------------------------------------------------------------------- */

/**
 * 参数类型篡改：同一参数用不同类型反复请求，服务端出现 5xx 或异常响应。
 * `observations` 是 [{variant, status, body}]；只有出现 5xx 才算（4xx 是正常拒绝）。
 */
export function ruleParamType({ endpoint, param, observations }) {
  const list = Array.isArray(observations) ? observations : [];
  const crashes = list.filter((entry) => Number.isInteger(entry?.status) && entry.status >= 500);
  if (crashes.length === 0) return null;
  return {
    ruleId: 'PARAM-TYPE',
    category: 'parameter-tampering',
    severity: 'medium',
    title: '参数类型处理不当导致服务端 5xx',
    basis: 'observed-once',
    confidence: 0.75,
    evidence: {
      endpoint, param,
      variants: list.map((entry) => ({ variant: entry.variant, status: entry.status })),
      crashes: crashes.length,
    },
    impact: '类型未校验可触发异常路径，可能被用于拒绝服务或进一步注入。',
    remediation: '对参数做严格类型/范围校验，异常输入返回 4xx 而非 5xx。',
  };
}

/** 边界值：负数/零/超上限被接受（业务影响由 BIZ 规则判定；这里只报"接受异常值"）。 */
export function ruleParamBoundary({ endpoint, param, observations }) {
  const list = Array.isArray(observations) ? observations : [];
  const accepted = list.filter((entry) => entry?.accepted === true && entry?.boundary === true);
  if (accepted.length === 0) return null;
  return {
    ruleId: 'PARAM-BOUNDARY',
    category: 'parameter-tampering',
    severity: 'medium',
    title: '边界值未被拒绝',
    basis: 'observed-once',
    confidence: 0.7,
    evidence: { endpoint, param, accepted: accepted.map((entry) => entry.variant) },
    impact: '异常边界值被接受可能导致金额/数量类业务错误。',
    remediation: '对数量/金额类参数做上下界校验并在服务端重算。',
  };
}

/* -----------------------------------------------------------------------------------------------
 * VULN-05：注入类（错误签名法）
 * ---------------------------------------------------------------------------------------------- */

/** 注入响应签名（VULN-05）：把 payload 打进参数后，响应里出现注入成功的结构痕迹。 */
export function ruleInjection({ endpoint, param, payload, response }) {
  const body = typeof response?.body === 'string' ? response.body : '';
  if (body === '') return null;
  const signatures = [
    { id: 'sql-error-leak', pattern: /(SQL syntax|sqlite3\.OperationalError|SQLSTATE\[)/i },
    { id: 'template-eval', pattern: /\b(49|7\*7)\b/ },
    { id: 'command-echo', pattern: /(uid=\d+\(|total\s+\d+\s+$)/m },
  ];
  const hit = signatures.find((signature) => signature.pattern.test(body));
  if (!hit) return null;
  return {
    ruleId: 'INJ-ERROR-SIGNATURE',
    category: 'injection',
    severity: 'high',
    title: '注入 payload 触发服务端错误/执行签名',
    basis: 'observed-once',
    confidence: 0.7,
    evidence: { endpoint, param, payloadKind: payload?.kind ?? null, signature: hit.id, status: response?.status ?? null },
    impact: '参数未安全处理，可能被利用执行注入攻击。',
    remediation: '使用参数化查询/白名单校验，禁止拼接 SQL 与 shell。',
  };
}

/**
 * 布尔型注入（VULN-05 的第二类证据）：错误签名不出现时，用**受控三组对照**证明。
 *
 * 三组观测缺一不可：
 *   - `baseline`  正常值的返回条数
 *   - `alwaysTrue`  恒真 payload（`' OR '1'='1`）的条数 → 必须**多于**正常值
 *   - `alwaysFalse` 恒假 payload（`AND '1'='2`）的条数 → 必须**少于**正常值
 * 三组同时成立才算注入：单看"返回变多了"可能只是模糊匹配，单看"变少了"可能只是没匹配到。
 */
export function ruleInjectionBoolean({ endpoint, param, baseline, alwaysTrue, alwaysFalse, payloads = {} } = {}) {
  const count = (observation) => {
    if (Number.isInteger(observation?.count)) return observation.count;
    if (Array.isArray(observation?.rows)) return observation.rows.length;
    return null;
  };
  const base = count(baseline);
  const yes = count(alwaysTrue);
  const no = count(alwaysFalse);
  if (base === null || yes === null || no === null) return null;
  if (!(yes > base) || !(no < base)) return null;
  return {
    ruleId: 'INJ-BOOLEAN-DIFF',
    category: 'injection',
    severity: 'high',
    title: '布尔型注入：恒真/恒假 payload 改变结果集',
    basis: 'differential',
    confidence: 0.9,
    evidence: {
      endpoint,
      param,
      counts: { baseline: base, alwaysTrue: yes, alwaysFalse: no },
      payloads: {
        alwaysTrue: typeof payloads.alwaysTrue === 'string' ? payloads.alwaysTrue : null,
        alwaysFalse: typeof payloads.alwaysFalse === 'string' ? payloads.alwaysFalse : null,
      },
    },
    impact: '查询条件可被注入，攻击者可绕过过滤条件读取全部数据。',
    remediation: '使用参数化查询；对查询参数做类型与长度校验。',
  };
}

/* -----------------------------------------------------------------------------------------------
 * VULN-06：XSS
 * ---------------------------------------------------------------------------------------------- */

/** DOM XSS：静态 source→sink（来自 JS 分析），永远只能是 potential/likely。 */
export function ruleDomXss({ scriptUrl, sink, source, confidence }) {
  if (!sink) return null;
  return {
    ruleId: 'XSS-DOM-SINK',
    category: 'xss-dom',
    severity: 'medium',
    title: 'DOM XSS 危险 sink 存在可注入数据流',
    basis: 'static-pattern',
    confidence: confidence === 'high' ? 0.6 : 0.4,
    evidence: { scriptUrl, sink, source, staticConfidence: confidence },
    impact: '若 source 可控，攻击者可在受害者浏览器执行脚本。',
    remediation: '使用 textContent/安全模板，避免 innerHTML/eval；必要时做显式转义与 CSP。',
  };
}

/** 存储型 XSS：提交的 payload 在后续读取中原样出现（观测两次，属 differential）。 */
export function ruleStoredXss({ endpoint, submitted, renderedIn }) {
  if (typeof submitted !== 'string' || submitted === '') return null;
  const rendered = typeof renderedIn === 'string' ? renderedIn : '';
  if (!rendered.includes(submitted)) return null;
  return {
    ruleId: 'XSS-STORED-REFLECT',
    category: 'xss-stored',
    severity: 'high',
    title: '用户输入未转义回显（存储型/反射型 XSS）',
    basis: 'differential',
    confidence: 0.85,
    evidence: { endpoint, payloadLength: submitted.length, renderedLength: rendered.length },
    impact: '攻击者可注入脚本并在其他用户会话中执行。',
    remediation: '输出编码（按上下文）+ CSP；富文本使用白名单净化。',
  };
}

/* -----------------------------------------------------------------------------------------------
 * VULN-07：CORS 与安全头
 * ---------------------------------------------------------------------------------------------- */

/**
 * CORS：目标对任意 Origin 回显 Access-Control-Allow-Origin 且允许 credentials。
 * 入参是真实响应头（小写键）。
 */
export function ruleCors({ endpoint, headers, origin }) {
  const allowOrigin = headerValue(headers, 'access-control-allow-origin');
  if (allowOrigin === null) return null;
  const allowCredentials = String(headerValue(headers, 'access-control-allow-credentials') ?? '').toLowerCase() === 'true';
  const wildcard = allowOrigin === '*';
  const echo = typeof origin === 'string' && allowOrigin === origin;
  if (!wildcard && !echo) return null;
  return {
    ruleId: allowCredentials ? 'CORS-CREDENTIALS' : 'CORS-WILDCARD',
    category: 'cors',
    severity: allowCredentials ? 'high' : 'medium',
    title: allowCredentials
      ? 'CORS 允许任意 Origin 携带凭据（跨站读取会话数据）'
      : 'CORS 允许任意 Origin',
    basis: 'observed-once',
    confidence: 0.85,
    evidence: { endpoint, allowOrigin, allowCredentials, originEchoed: echo },
    impact: allowCredentials
      ? '任意站点可读取当前用户受保护响应，等同会话劫持的读取面。'
      : '任意站点可读取无需凭据的响应内容。',
    remediation: '使用精确 Origin 白名单校验；不要把 * 与 credentials 组合。',
  };
}

/** 安全响应头缺失（VULN-07）。isHttps 决定是否要求 HSTS。 */
export function ruleSecurityHeaders({ url, headers, isHttps = false }) {
  // An absent observation is NOT "all headers missing": with no url and no headers object we
  // simply have nothing to judge (fabricating a finding from an empty fact would be a false
  // positive, which VULN-09 penalises).
  if (typeof url !== 'string' || url === '') return null;
  if (headers === null || typeof headers !== 'object') return null;
  const h = headers;
  const missing = SECURITY_HEADERS.filter((header) => {
    if (header.httpsOnly && isHttps !== true) return false;
    return headerValue(h, header.name) === null;
  });
  if (missing.length === 0) return null;
  const worst = missing.reduce((unused, header) => (['critical', 'high', 'medium', 'low'].indexOf(header.severity)
    < ['critical', 'high', 'medium', 'low'].indexOf(unused.severity) ? header : unused), missing[0]);
  return {
    ruleId: 'HEADER-MISSING',
    category: 'security-headers',
    severity: worst.severity,
    title: '安全响应头缺失：' + missing.map((header) => header.name).join(', '),
    basis: 'observed-once',
    confidence: 0.95,
    evidence: { url, missing: missing.map((header) => header.name) },
    impact: '缺少纵深防御头会放大 XSS/点击劫持/MIME 嗅探风险。',
    remediation: '在网关/应用层统一注入上述安全头。',
  };
}

/* -----------------------------------------------------------------------------------------------
 * 信息泄露：调试/内部端点
 * ----------------------------------------------------------------------------------------------- */

/** 暴露的调试/内部配置端点（VULN-03 相关，DISC 发现后由规则判定）。 */
export function ruleDebugEndpoint({ endpoint, response }) {
  const body = typeof response?.body === 'string' ? response.body : '';
  const status = Number.isInteger(response?.status) ? response.status : null;
  if (status === null || status < 200 || status >= 300) return null;
  if (!/\/(debug|internal|admin\/config|_profiler|actuator)/i.test(endpoint ?? '')) return null;
  return {
    ruleId: 'DISC-DEBUG-ENDPOINT',
    category: 'information-disclosure',
    severity: 'medium',
    title: '暴露调试/内部配置端点',
    basis: 'observed-once',
    confidence: 0.8,
    evidence: { endpoint, status, bodyLength: body.length },
    impact: '配置/环境信息可帮助攻击者规划后续攻击。',
    remediation: '生产环境移除或在网关层阻断调试端点。',
  };
}

/* -----------------------------------------------------------------------------------------------
 * 业务逻辑（BIZ-03 的规则面）
 * ---------------------------------------------------------------------------------------------- */

/**
 * 客户端金额被信任：提交的金额/数量与服务端最终状态不一致（服务端采用了客户端值）。
 * `submitted` 与 `servertruth` 都是观测事实。
 */
export function ruleClientTrust(input = {}) {
  // Two observation shapes describe the SAME defect:
  //   { submitted:{amount}, serverTruth:{amount} }                     — "server echoed the client"
  //   { submittedTotal, serverTotal, expectedServerTotal }             — business-logic shape
  // Accepting only the first silently produced `null` for the second, which is how a real
  // client-trusted-amount defect stayed undetected.
  const endpoint = input.endpoint ?? null;
  const submittedAmount = Number(input.submitted?.amount ?? input.submittedTotal);
  const serverAmount = Number(input.serverTruth?.amount ?? input.serverTotal);
  const expectedAmount = Number(input.expectedServerTotal);
  if (!Number.isFinite(submittedAmount) || !Number.isFinite(serverAmount)) return null;
  // With an expected value the check is "server followed the client AND diverged from the truth";
  // without one it is the stricter "server value differs from what the client sent".
  if (Number.isFinite(expectedAmount)) {
    const followsClient = Math.abs(serverAmount - submittedAmount) < 0.005;
    const diverges = Math.abs(serverAmount - expectedAmount) > 0.005;
    if (!followsClient || !diverges) return null;
  } else if (submittedAmount === serverAmount) {
    return null;
  }
  return {
    ruleId: 'BIZ-CLIENT-TRUST',
    category: 'business-logic',
    // Same defect as `business-logic.js#checkClientTrust`, so the severity must match: letting a
    // client dictate the amount charged is a direct financial loss, hence critical.
    severity: 'critical',
    title: '服务端信任客户端提交的金额/数量',
    basis: 'differential',
    confidence: 0.85,
    evidence: { endpoint, submittedAmount, serverAmount },
    impact: '攻击者可篡改价格/数量造成资金损失。',
    remediation: '服务端依据商品与规则重算金额，忽略客户端金额字段。',
  };
}

/* -----------------------------------------------------------------------------------------------
 * 规则执行入口
 * ---------------------------------------------------------------------------------------------- */

/**
 * 对一组观测事实执行全部规则，返回 { candidates, evaluated, ruleIds }。
 * `facts` 的每个键可选；缺事实的规则返回 null（不评估，也不产生候选）。
 */
export function evaluateRules(facts = {}) {
  const candidates = [];
  const push = (candidate) => { if (candidate !== null && candidate !== undefined) candidates.push(candidate); };
  // A rule only runs when its fact group was actually supplied: an absent observation must not be
  // evaluated as an empty one (that turns "not looked at" into a false positive).
  const has = (key) => facts[key] !== undefined && facts[key] !== null;
  if (has('anonAccess')) push(ruleAnonAccess(facts.anonAccess));
  if (has('verboseError')) push(ruleVerboseError(facts.verboseError));
  if (has('objectAuthorization')) push(ruleObjectAuthorization(facts.objectAuthorization));
  if (has('functionAuthorization')) push(ruleFunctionAuthorization(facts.functionAuthorization));
  if (has('paramType')) push(ruleParamType(facts.paramType));
  if (has('paramBoundary')) push(ruleParamBoundary(facts.paramBoundary));
  if (has('injection')) push(ruleInjection(facts.injection));
  if (has('injectionBoolean')) push(ruleInjectionBoolean(facts.injectionBoolean));
  if (has('domXss')) push(ruleDomXss(facts.domXss));
  if (has('storedXss')) push(ruleStoredXss(facts.storedXss));
  if (has('cors')) push(ruleCors(facts.cors));
  if (has('securityHeaders')) push(ruleSecurityHeaders(facts.securityHeaders));
  if (has('debugEndpoint')) push(ruleDebugEndpoint(facts.debugEndpoint));
  if (has('clientTrust')) push(ruleClientTrust(facts.clientTrust));
  return {
    version: RULES_VERSION,
    evaluated: Object.keys(facts).length,
    ruleIds: [...new Set(candidates.map((candidate) => candidate.ruleId))],
    candidates,
    note: '候选只描述观测到的事实；状态必须经 finding.deriveStatus 按证据类型推导，不得直接标 confirmed。',
  };
}
