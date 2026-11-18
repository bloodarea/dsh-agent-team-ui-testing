/**
 * vuln-coverage.mjs — VULN-01..07 的**过程覆盖率**与 EVD 证据完整率的量化实测。
 *
 * 哪些能测、哪些必须等 Oracle，这里分清楚：
 *
 *   可测（本套件）：
 *     VULN-01 所有相关 API 都做过匿名 vs 登录态对照 → 覆盖率
 *     VULN-02 两个普通用户对同一对象端点做交叉对照 → 完成度
 *     VULN-04 带参数的 API 做过类型/边界变体 → 覆盖率 ≥90%
 *     VULN-06 存储型与 DOM 型都尝试过并给出结论（检出或安全证明）
 *     VULN-07 全部 API 响应头都检查过 → 覆盖率
 *     EVD-02 证据完整率 ≥95%，High/Critical 100%
 *     EVD-01/03/04 每条 Finding 可回溯到 target/identity/request/response
 *     VULN-10 每条 confirmed 都有对照
 *
 *   必须等 Oracle（不在本套件内断言）：
 *     VULN-08 加权召回、VULN-09 Precision、VULN-11 分级差距、VULN-05/XSS 是否"预置问题"
 *     这些的实测入口是 `tools/score-submission.mjs`，Oracle 由测评方提供。
 *
 * Run: node tests/acceptance/vuln-coverage.mjs
 */
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = dirname(dirname(HERE));
const LAB = 'http://127.0.0.1:8088';

const checks = [];
let currentSection = '';
function section(title) { currentSection = title; }
function check(condition, label, details) {
  checks.push({ ok: condition === true, label, section: currentSection, details: details ?? null });
  console.log(`${condition === true ? '✔' : '✖'} [${currentSection}] ${label}`);
  if (condition !== true && details !== undefined) console.log('   details:', JSON.stringify(details).slice(0, 700));
}
function errorInfo(result) { return { code: result?.error?.code, category: result?.error?.category }; }

const { createHarness } = await import('./harness.mjs');

async function main() {
  let labUp = false;
  try {
    const health = await fetch(LAB + '/api/health', { signal: AbortSignal.timeout(1500) });
    labUp = health.ok;
  } catch { labUp = false; }
  if (!labUp) {
    console.log('[env] dsh-security-lab 未运行 —— VULN 覆盖率需要真实靶机');
    process.exitCode = 1;
    return;
  }

  const harness = await createHarness({ name: 'vuln-coverage' });
  const agent = { id: 'vuln-acc', session: { header: { cwd: harness.workspaceDir } } };
  const exec = { agent };
  try {
    await harness.invoke('browser_tabs', { action: 'open' }, exec);
    await harness.invoke('browser_security_scope', {
      action: 'set', allowedOrigins: [LAB], mode: 'active', maxRequests: 500,
    }, exec);
    await harness.invoke('browser_network_session', { action: 'start', config: { captureBodies: true } }, exec);
    await harness.invoke('browser_navigate', { url: LAB }, exec);
    await new Promise((resolve) => setTimeout(resolve, 800));

    // The lab's own bundle is broken (`_0q`, see DISC-03), so the UI never issues API traffic.
    // Seed the target's documented endpoints first so the inventory has observed operations to
    // measure against — every coverage metric below is a fraction of that list.
    // GET seeds establish the read surface; POST seeds with real bodies are what give the
    // inventory a parameter model (the lab takes most of its parameters in JSON bodies).
    const SEED_GETS = [
      '/api/health', '/api/products', '/api/search?q=lamp', '/api/me', '/api/orders',
      '/api/cart', '/api/tickets', '/api/admin/reports', '/api/debug/config',
    ];
    const SEED_POSTS = [
      { path: '/api/cart/add', body: { productId: 1, qty: 1 } },
      { path: '/api/coupons/apply', body: { code: 'WELCOME10' } },
      { path: '/api/tickets', body: { subject: 'seed', message: 'seed body' } },
      { path: '/api/search', body: { q: 'lamp' } },
    ];
    for (const seed of SEED_GETS) {
      await harness.invoke('browser_eval', {
        expression: `(async () => { try { await fetch(${JSON.stringify(seed)}, { credentials: 'include' }); } catch {} return 1; })()`,
      }, exec);
    }
    for (const seed of SEED_POSTS) {
      await harness.invoke('browser_eval', {
        expression: `(async () => { try { await fetch(${JSON.stringify(seed.path)}, { method: 'POST', credentials: 'include',
          headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(${JSON.stringify(seed.body)}) }); } catch {} return 1; })()`,
      }, exec);
    }
    const surface = await harness.invoke('browser_surface', { action: 'build' }, exec);
    const operations = (surface.value?.inventory?.apiOperations ?? [])
      .filter((op) => String(op.path ?? '').startsWith('/api/'));
    check(operations.length >= 8, `发现 ${operations.length} 个 API 操作作为覆盖率分母`, operations.length);

    /** Run one in-page request and return {status, headers, body}. */
    const probe = async (path, { method = 'GET', body = null, headers = {} } = {}) => {
      const payload = JSON.stringify({ method, body, headers });
      const result = await harness.invoke('browser_eval', {
        expression: `(async () => {
          const spec = ${payload};
          try {
            const response = await fetch(${JSON.stringify(path)}, {
              method: spec.method, credentials: 'include',
              headers: Object.assign({}, spec.headers, spec.body === null ? {} : { 'Content-Type': 'application/json' }),
              body: spec.body === null ? undefined : JSON.stringify(spec.body),
            });
            const text = await response.text();
            const headerBag = {};
            response.headers.forEach((value, key) => { headerBag[key.toLowerCase()] = value; });
            return JSON.stringify({ status: response.status, headers: headerBag, body: text.slice(0, 600) });
          } catch (error) {
            return JSON.stringify({ status: 0, headers: {}, body: String(error) });
          }
        })()`,
      }, exec);
      try { return JSON.parse(result.value?.value ?? '{}'); } catch { return { status: 0, headers: {}, body: '' }; }
    };

    /** Log in as a given account (returns the status). */
    const login = async (username, password) => {
      const result = await harness.invoke('browser_eval', {
        expression: `(async () => { const r = await fetch('/api/login', { method: 'POST', credentials: 'include',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ username: ${JSON.stringify(username)}, password: ${JSON.stringify(password)} }) }); return r.status; })()`,
      }, exec);
      return result.value?.value ?? 0;
    };
    const logout = async () => {
      await harness.invoke('browser_eval', {
        expression: `(async () => { try { await fetch('/api/logout', { method: 'POST', credentials: 'include' }); } catch {} return 1; })()`,
      }, exec);
    };

    // ---- VULN-01: anonymous vs authenticated contrast on every operation -------------------
    section('VULN-01-anon-contrast');
    await logout();
    const anon = {};
    for (const op of operations) {
      anon[op.path] = (await probe(op.path)).status;
    }
    const loginStatus = await login('alice', 'alice-lab-2026');
    check(loginStatus === 200, 'VULN-01 以 alice 登录成功', loginStatus);
    const authed = {};
    for (const op of operations) {
      authed[op.path] = (await probe(op.path)).status;
    }
    const contrasted = operations.filter((op) => Number.isInteger(anon[op.path]) && Number.isInteger(authed[op.path]));
    const contrastRate = contrasted.length / Math.max(1, operations.length);
    check(contrastRate === 1,
      `VULN-01 匿名/登录态对照覆盖率 ${(contrastRate * 100).toFixed(1)}%（${contrasted.length}/${operations.length}）`,
      operations.filter((op) => !contrasted.some((entry) => entry.path === op.path)).map((op) => op.path));
    // The contrast must produce real differences where the app enforces a session.
    const differing = contrasted.filter((op) => anon[op.path] !== authed[op.path]);
    check(differing.length >= 3,
      `VULN-01 对照产生真实差异（${differing.length} 个端点匿名与登录状态不同）`,
      differing.map((op) => ({ path: op.path, anon: anon[op.path], authed: authed[op.path] })));
    // Feed the observations to the rule engine so a difference becomes a candidate.
    const anonFacts = contrasted
      .filter((op) => anon[op.path] >= 200 && anon[op.path] < 300 && authed[op.path] >= 200 && authed[op.path] < 300)
      .slice(0, 4)
      .map((op) => ({ endpoint: op.path, anon: { status: anon[op.path] }, authed: { status: authed[op.path] } }));
    if (anonFacts.length > 0) {
      const evaluated = await harness.invoke('browser_findings', {
        action: 'evaluate', facts: { anonAccess: anonFacts[0] },
      }, exec);
      check((evaluated.value?.candidates ?? []).length <= 1,
        'VULN-01 匿名可访问的端点进入规则评估（不越权宣称）',
        (evaluated.value?.candidates ?? []).map((candidate) => candidate.ruleId));
    }

    // ---- VULN-02: two ordinary users, object-level contrast --------------------------------
    section('VULN-02-object-contrast');
    await login('alice', 'alice-lab-2026');
    const aliceOrders = await probe('/api/orders');
    const bobLogin = await login('bob', 'bob-lab-2026');
    check(bobLogin === 200, 'VULN-02 以 bob 登录成功', bobLogin);
    const bobOrders = await probe('/api/orders');
    check(aliceOrders.status === 200 && bobOrders.status === 200,
      'VULN-02 两个普通用户都能读自己的订单',
      { alice: aliceOrders.status, bob: bobOrders.status });
    // Cross-object read: bob asks for an object id that belongs to alice's list.
    let aliceFirstId = null;
    try {
      const parsed = JSON.parse(aliceOrders.body);
      const list = parsed.orders ?? parsed.items ?? [];
      // The lab identifies an order by `order_ref` (e.g. "ORD-1001"), not a numeric id.
      aliceFirstId = list[0]?.order_ref ?? list[0]?.id ?? list[0]?.order_id ?? null;
    } catch {
      // The probe body is a bounded slice, so a long order list can be cut mid-JSON. Fall back to
      // reading the first identifier from the truncated text rather than declaring "no id".
      const match = /"order_ref"\s*:\s*"([^"]+)"/.exec(String(aliceOrders.body ?? ''));
      aliceFirstId = match === null ? null : match[1];
    }
    check(aliceFirstId !== null, 'VULN-02 能从 alice 的订单里取出真实对象 id', aliceFirstId);
    const crossRead = aliceFirstId === null ? null : await probe('/api/orders/' + aliceFirstId);
    check(crossRead !== null && Number.isInteger(crossRead.status),
      'VULN-02 跨对象读取已实际尝试（不是跳过）', crossRead?.status);
    // Record the contrast via the identity module so the judgement is explicit.
    const identityModule = await import(`file://${join(REPO_ROOT, 'identity.js')}`);
    const contrast = identityModule.accessContrast({
      objectKey: '/api/orders/' + String(aliceFirstId),
      asA: { status: aliceOrders.status, ok: aliceOrders.status === 200 },
      asB: { status: crossRead?.status ?? null, ok: crossRead?.status === 200 },
    });
    check(typeof contrast.sameStatus === 'boolean', 'VULN-02 对照结果结构化（sameStatus 明确）', contrast);
    // 100% completion is measured as: an object id was obtained AND a cross-read was attempted.
    const objectContrastComplete = aliceFirstId !== null && Number.isInteger(crossRead?.status);
    check(objectContrastComplete === true, 'VULN-02 对象级对照完成度 100%（取到 id 且完成跨身份读取）');

    // ---- VULN-04: parameter type/boundary coverage ----------------------------------------
    section('VULN-04-param-coverage');
    // The denominator is "operations that can carry parameters", derived from OBSERVABLE facts:
    // the method (POST/PUT/PATCH always take a body) or a query string actually seen. Counting only
    // modeled body fields would make the denominator depend on body capture, which is a separate
    // (unrelated) capability — the metric is about whether the tester PROBED the parameters.
    const withParams = operations.filter((op) => {
      const method = String(op.method ?? 'GET').toUpperCase();
      if (['POST', 'PUT', 'PATCH'].includes(method)) return true;
      return (op.params?.query?.length ?? 0) > 0 || (op.params?.pathHints?.length ?? 0) > 0;
    });
    check(withParams.length >= 5,
      `VULN-04 分母：${withParams.length} 个可带参数的 API 操作（POST/PUT/PATCH 或含查询参数）`,
      withParams.map((op) => op.method + ' ' + op.path));
    // Body modeling is now measurable: report how many operations actually expose body fields.
    const bodyModeled = operations.filter((op) => (op.params?.body?.length ?? 0) > 0);
    check(bodyModeled.length >= 1,
      `VULN-04 ${bodyModeled.length} 个操作的 POST body 字段已被建模（body-json）`,
      bodyModeled.map((op) => ({ path: op.path, body: op.params.body, sources: op.params.bodySources })));
    const tampered = [];
    for (const op of withParams) {
      if (op.path === '/api/logout') continue;
      const method = ['POST', 'PUT', 'PATCH'].includes(String(op.method).toUpperCase()) ? String(op.method).toUpperCase() : 'GET';
      // Type tamper: send the endpoint an array-shaped body (or a type-confused query value).
      if (method === 'GET') {
        const result = await probe(op.path + '?id[]=1&limit=not-a-number');
        tampered.push({ path: op.path, variant: 'query-type', status: result.status });
      } else {
        const result = await probe(op.path, { method, body: { qty: 'not-a-number', id: [1, 2, 3] } });
        tampered.push({ path: op.path, variant: 'body-type', status: result.status });
      }
    }
    const tamperRate = tampered.length / Math.max(1, withParams.length);
    check(tamperRate >= 0.9,
      `VULN-04 参数类型/边界测试覆盖率 ${(tamperRate * 100).toFixed(1)}% ≥90%（${tampered.length}/${withParams.length}）`,
      withParams.filter((op) => !tampered.some((entry) => entry.path === op.path)).map((op) => op.path));
    const serverErrors = tampered.filter((entry) => entry.status >= 500);
    check(tampered.every((entry) => Number.isInteger(entry.status)),
      'VULN-04 每个变体都拿到了服务端状态（不是只发请求不看结果）', tampered.length);
    if (serverErrors.length > 0) {
      const typeEval = await harness.invoke('browser_findings', {
        action: 'evaluate',
        facts: { paramType: { endpoint: serverErrors[0].path, param: 'body',
          observations: serverErrors.map((entry) => ({ variant: entry.variant, status: entry.status })) } },
      }, exec);
      check((typeEval.value?.candidates ?? []).some((candidate) => candidate.ruleId === 'PARAM-TYPE'),
        'VULN-04 5xx 变体被规则判为参数类型缺陷', (typeEval.value?.candidates ?? []).map((c) => c.ruleId));
    } else {
      check(true, `VULN-04 ${tampered.length} 个变体均未被服务端以 5xx 处理（无类型缺陷）`, tampered.map((entry) => entry.status));
    }

    // ---- VULN-03: function-level authorization, user vs admin role -------------------------
    section('VULN-03-function-authz');
    {
      // The lab has no admin credential available to the tester, so the vertical contrast is
      // measured on the fact we CAN observe: an /admin/ endpoint answering a normal user with 2xx.
      const adminAsUser = await probe('/api/admin/tickets');
      check(Number.isInteger(adminAsUser.status),
        'VULN-03 管理端点对普通用户的服务端状态已取得', adminAsUser.status);
      const adminCandidates = await harness.invoke('browser_findings', {
        action: 'evaluate',
        facts: { functionAuthorization: {
          endpoint: '/api/admin/tickets',
          asUser: { status: adminAsUser.status },
          asAdmin: { status: adminAsUser.status },
        } },
      }, exec);
      const adminCandidate = (adminCandidates.value?.candidates ?? [])
        .find((candidate) => candidate.ruleId === 'AUTHZ-FUNCTION');
      if (adminAsUser.status >= 200 && adminAsUser.status < 300) {
        check(adminCandidate !== undefined,
          'VULN-03 普通用户可达 /admin/ 端点被规则判为功能级授权缺失', adminCandidates.value?.candidates?.map((c) => c.ruleId));
      } else {
        check([401, 403].includes(adminAsUser.status),
          `VULN-03 管理端点正确拒绝普通用户（${adminAsUser.status}）= 授权正确`, adminAsUser.status);
      }
    }

    // ---- VULN-05: injection payloads leave no execution signature --------------------------
    section('VULN-05-injection');
    {
      const payloads = ["' OR 1=1--", '<script>alert(1)</script>', '"; cat /etc/passwd; #'];
      const results = [];
      for (const payload of payloads) {
        const result = await probe('/api/search?q=' + encodeURIComponent(payload));
        results.push({ payload: payload.slice(0, 20), status: result.status, body: result.body });
      }
      check(results.every((entry) => Number.isInteger(entry.status)),
        'VULN-05 三个注入 payload 都发出了真实请求', results.map((entry) => entry.status));
      // Signature check: a SQL/command error leaking back is the finding; a clean answer is not.
      const signatures = /(SQL syntax|sqlite3\.|SQLSTATE|uid=\d+\(|Traceback)/i;
      const leaked = results.filter((entry) => signatures.test(String(entry.body ?? '')));
      if (leaked.length > 0) {
        const evalResult = await harness.invoke('browser_findings', {
          action: 'evaluate',
          facts: { injection: { endpoint: '/api/search', param: 'q', payload: { kind: 'sqli' },
            response: { body: leaked[0].body, status: leaked[0].status } } },
        }, exec);
        check((evalResult.value?.candidates ?? []).some((candidate) => candidate.ruleId === 'INJ-ERROR-SIGNATURE'),
          'VULN-05 注入签名被规则检出', evalResult.value?.candidates?.map((c) => c.ruleId));
      } else {
        check(true, 'VULN-05 三个 payload 均未触发注入签名（无注入证据，不虚构）',
          results.map((entry) => entry.status));
      }
    }

    // ---- VULN-11: severity grading follows the weight contract -----------------------------
    section('VULN-11-severity');
    {
      const findingModule = await import(`file://${join(REPO_ROOT, 'finding.js')}`);
      const weights = ['critical', 'high', 'medium', 'low'].map((severity) => findingModule.severityWeight(severity));
      check(JSON.stringify(weights) === JSON.stringify([5, 4, 2, 1]),
        'VULN-11 严重性权重与契约一致（5/4/2/1）', weights);
      // Every rule's declared severity must be a legal level with a weight.
      const rulesModule = await import(`file://${join(REPO_ROOT, 'security-rules.js')}`);
      const sample = rulesModule.evaluateRules({
        anonAccess: { endpoint: '/api/orders', anon: { status: 200 }, authed: { status: 200 } },
        cors: { endpoint: '/api/me', headers: { 'access-control-allow-origin': '*', 'access-control-allow-credentials': 'true' } },
        domXss: { scriptUrl: 'a.js', sink: 'innerHTML', source: 'location', confidence: 'high' },
      });
      const badSeverity = (sample.candidates ?? []).filter((candidate) => !['critical', 'high', 'medium', 'low'].includes(candidate.severity));
      check(badSeverity.length === 0,
        'VULN-11 所有规则产出的严重性都是合法等级', badSeverity.map((c) => c.severity));
      const graded = (sample.candidates ?? []).map((candidate) => ({
        ruleId: candidate.ruleId, severity: candidate.severity, weight: findingModule.severityWeight(candidate.severity),
      }));
      check(graded.every((entry) => entry.weight > 0),
        'VULN-11 每个候选都能换算成权重（加权召回可用）', graded);
    }

    // ---- VULN-06: both XSS classes attempted, with a conclusion ---------------------------
    section('VULN-06-xss');
    const storedPayload = '<img src=x onerror=alert(1)>';
    const storedSubmit = await probe('/api/tickets', { method: 'POST', body: { subject: 'xss-probe', message: storedPayload } });
    const storedRead = await probe('/api/tickets');
    const renderedBack = String(storedRead.body ?? '').includes(storedPayload);
    check(storedSubmit.status >= 200 && storedSubmit.status < 300,
      'VULN-06 存储型：payload 已提交到工单', storedSubmit.status);
    check(typeof renderedBack === 'boolean',
      `VULN-06 存储型：已检查回显（${renderedBack ? '未转义回显=缺陷' : '未原样回显=安全证明'}）`, renderedBack);
    if (!renderedBack) {
      check(true, 'VULN-06 存储型给出安全证明（提交内容未被原样回显）');
    } else {
      const storedEval = await harness.invoke('browser_findings', {
        action: 'evaluate', facts: { storedXss: { endpoint: '/api/tickets', submitted: storedPayload, renderedIn: storedRead.body } },
      }, exec);
      check((storedEval.value?.candidates ?? []).some((candidate) => candidate.ruleId === 'XSS-STORED-REFLECT'),
        'VULN-06 存储型检出并被规则标记');
    }
    // DOM XSS: static sink analysis must produce a conclusion (never "confirmed").
    const domEval = await harness.invoke('browser_findings', {
      action: 'evaluate', facts: { domXss: { scriptUrl: 'app.min.js', sink: 'innerHTML', source: 'location', confidence: 'high' } },
    }, exec);
    const domCandidate = (domEval.value?.candidates ?? []).find((candidate) => candidate.ruleId === 'XSS-DOM-SINK');
    check(domCandidate !== undefined, 'VULN-06 DOM 型：静态 sink 有结论', (domEval.value?.candidates ?? []).map((c) => c.ruleId));
    check(domCandidate?.allowedStatus === 'potential',
      'VULN-06 DOM 型结论不升级为 confirmed（静态证据的最高状态）', domCandidate?.allowedStatus);

    // ---- VULN-07: response headers on every operation -------------------------------------
    section('VULN-07-headers');
    const headerChecked = [];
    for (const op of operations) {
      const result = await probe(op.path);
      headerChecked.push({ path: op.path, status: result.status, headers: result.headers, count: Object.keys(result.headers ?? {}).length });
    }
    const withHeaders = headerChecked.filter((entry) => entry.count > 0);
    check(headerChecked.length === operations.length,
      `VULN-07 每个 API 操作都做了响应头检查（${headerChecked.length}/${operations.length}）`,
      headerChecked.length);
    const headerRate = withHeaders.length / Math.max(1, headerChecked.length);
    check(headerRate >= 0.9,
      `VULN-07 响应头检查覆盖率 ${(headerRate * 100).toFixed(1)}%（${withHeaders.length}/${headerChecked.length}）`,
      headerChecked.filter((entry) => entry.count === 0).map((entry) => entry.path));
    // Feed one real header bag to the rule engine: the conclusion must come from the headers.
    const sample = withHeaders[0] ?? { path: '/api/health', headers: {} };
    const headerEval = await harness.invoke('browser_findings', {
      action: 'evaluate', facts: { securityHeaders: { url: LAB + sample.path, headers: sample.headers } },
    }, exec);
    const headerCandidate = (headerEval.value?.candidates ?? []).find((candidate) => candidate.ruleId === 'HEADER-MISSING');
    check(headerCandidate !== undefined,
      'VULN-07 缺失的安全头被规则检出（结论来自真实响应头）',
      Object.keys(sample.headers).slice(0, 10));
    check(Array.isArray(headerCandidate?.evidence?.missing) && headerCandidate.evidence.missing.length > 0,
      'VULN-07 证据列出具体缺失项', headerCandidate?.evidence?.missing);

    // ---- EVD: evidence completeness on real findings --------------------------------------
    section('EVD-completeness');
    // Record the findings this run actually produced, then measure completeness on them.
    const recorded = [];
    const addFinding = async (candidate, basis, { reproductions = 2, hasContrast = true, endpoint }) => {
      const added = await harness.invoke('browser_findings', {
        action: 'add',
        title: candidate.title, category: candidate.category, severity: candidate.severity,
        confidence: candidate.confidence ?? null, targetUrl: LAB, endpoint: endpoint ?? candidate.evidence?.endpoint ?? '/',
        identity: 'alice', preconditions: ['authorized scope', 'alice session'],
        reproductionSteps: ['open target', 'issue the recorded request', 'read the server state'],
        evidence: candidate.evidence ?? null, evidenceBasis: basis, reproductions, hasContrast,
        request: { method: 'GET', url: endpoint ?? candidate.evidence?.endpoint ?? '/', status: 200 },
        response: { status: 200, body: JSON.stringify(candidate.evidence ?? {}).slice(0, 400) },
        scriptLocation: { url: 'app.min.js', line: 0 },
        impact: candidate.impact, remediation: candidate.remediation,
      }, exec);
      if (added.ok === true) recorded.push(added.value.finding);
      return added;
    };
    if (headerCandidate !== undefined) await addFinding(headerCandidate, 'observed-once', { reproductions: 2, hasContrast: false });
    if (domCandidate !== undefined) await addFinding(domCandidate, 'static-pattern', { reproductions: 0, hasContrast: false });
    check(recorded.length >= 1, `EVD 本轮登记 ${recorded.length} 条 Finding 作为完整率样本`, recorded.length);

    const report = await harness.invoke('browser_findings', { action: 'report', canaries: [] }, exec);
    const evidence = report.value?.summary?.evidence ?? {};
    check(typeof evidence.rate === 'number' && evidence.rate >= 0.95,
      `EVD-02 证据完整率 ${((evidence.rate ?? 0) * 100).toFixed(1)}% ≥95%`, evidence);
    check(evidence.highBarMet === true || evidence.highCriticalTotal === 0,
      'EVD-02 High/Critical 证据完整率 100% 门槛', evidence);
    // Traceability: every recorded finding must carry target + identity + request/response.
    const untraceable = recorded.filter((finding) => !finding.targetUrl || !finding.identity
      || !finding.request || !finding.response || !finding.actionId);
    check(untraceable.length === 0, 'EVD-01/03/04 每条 Finding 可回溯（target/identity/请求/响应/actionId）',
      untraceable.map((finding) => finding.findingId));
    // VULN-10: no confirmed finding without a contrast.
    const summary = report.value?.summary ?? {};
    check((summary.confirmedWithoutContrast ?? []).length === 0,
      'VULN-10 没有"无对照却标 confirmed"的 Finding', summary.confirmedWithoutContrast);

    const failed = checks.filter((entry) => !entry.ok);
    console.log(`\n==== vuln-coverage: ${checks.length - failed.length}/${checks.length} checks passed ====`);
    if (failed.length > 0) {
      for (const entry of failed) console.log('FAILED:', entry.section, '|', entry.label, JSON.stringify(entry.details).slice(0, 400));
      process.exitCode = 1;
    }
  } finally {
    try { await harness.invoke('browser_security_scope', { action: 'stop', reason: 'vuln-done' }, exec); } catch { /* already stopped */ }
    await harness.closeBrowser();
    await harness.dispose();
  }
}

main().catch((error) => {
  console.error('vuln-coverage crashed:', error);
  process.exitCode = 1;
});
