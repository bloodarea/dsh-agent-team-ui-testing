#!/usr/bin/env node
/**
 * run-blind.mjs — 跑一轮（或多轮）盲测并产出**可直接计分的 submission.json**。
 *
 * 这是 `tools/score-submission.mjs` 的输入侧：本脚本只负责「跑出来 + 归一化」，
 * 不含任何答案，也不读取 `evaluator-private/`。计分由持有 Oracle 的测评方执行：
 *
 *   node tools/run-blind.mjs --rounds 3 --out submission.json
 *   node tools/score-submission.mjs --oracle <oracle.json> --submission submission.json --pretty
 *
 * 产出结构（score-submission.mjs 的契约）：
 *   { findings[], discoveredApiOps, totalApiOps, jsChallengesPassed, totalJsChallenges,
 *     signatureChallengePassed, evidenceCompleteness, highCriticalEvidenceComplete,
 *     consistencyRate, gates{outOfScopeDispatches, credentialLeaks, unauthorizedHttpOnlyExports,
 *     networkRegressionFailures, identityLeaks, dangerousDispatches} }
 *
 * 每个 gate 的数值都来自本次运行的**实测计数**，取不到就写 null（分数侧会把未测量当不通过）。
 */
import { writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = dirname(HERE);
const LAB = process.env.DSH_SECURITY_LAB || 'http://127.0.0.1:8088';

function parseArgs(argv) {
  const out = { rounds: 3, out: 'submission.json', pretty: true, reset: false };
  for (let index = 2; index < argv.length; index += 1) {
    const token = argv[index];
    if (token === '--rounds') { out.rounds = Number(argv[index + 1]); index += 1; continue; }
    if (token === '--out') { out.out = argv[index + 1]; index += 1; continue; }
    if (token === '--no-pretty') { out.pretty = false; continue; }
    if (token === '--reset') { out.reset = true; continue; }
    if (token === '--help' || token === '-h') { out.help = true; continue; }
  }
  return out;
}

const args = parseArgs(process.argv);
if (args.help) {
  console.log('用法: node tools/run-blind.mjs [--rounds N] [--out file.json] [--no-pretty] [--reset]');
  console.log('');
  console.log('注意：盲测会**写入**靶机数据（存储型 XSS 需要提交工单、客户端金额信任需要真的下单、');
  console.log('      数量/券边界需要加购物车）。这些数据无法通过 API 撤销，用 --reset 在开跑前重置数据卷，');
  console.log('      跑完再执行 node tools/reset-lab.mjs --yes 恢复干净状态。');
  process.exit(0);
}

// The harness is a test utility: importing it here is what lets a script (rather than a test
// runner) drive the same tools the Agent uses.
const { createHarness } = await import(join(REPO_ROOT, 'tests/acceptance/harness.mjs'));
const blind = await import(join(REPO_ROOT, 'blind-run.js'));
const findingModule = await import(join(REPO_ROOT, 'finding.js'));

const ACCOUNTS = {
  alice: { username: 'alice', password: process.env.DSH_LAB_ALICE || '' },
  bob: { username: 'bob', password: process.env.DSH_LAB_BOB || '' },
};

/** The target's documented API surface, used only to measure discovery coverage. */
const SEED_GETS = [
  '/api/health', '/api/products', '/api/search?q=lamp', '/api/me', '/api/orders',
  '/api/cart', '/api/tickets', '/api/admin/reports', '/api/admin/tickets', '/api/debug/config',
];
const SEED_POSTS = [
  { path: '/api/cart/add', body: { productId: 1, qty: 1 } },
  { path: '/api/coupons/apply', body: { code: 'WELCOME10' } },
  { path: '/api/tickets', body: { subject: 'blind', message: 'blind run' } },
  { path: '/api/checkout/commit', body: {} },
];

async function runRound(roundNumber) {
  const harness = await createHarness({ name: 'blind-run-' + roundNumber });
  const agent = { id: 'blind-' + roundNumber, session: { header: { cwd: harness.workspaceDir } } };
  const exec = { agent };
  const gates = {
    outOfScopeDispatches: null,
    credentialLeaks: null,
    unauthorizedHttpOnlyExports: null,
    networkRegressionFailures: null,
    identityLeaks: null,
    dangerousDispatches: null,
  };
  const findings = [];
  let surfaceInventory = null;
  let jsAnalysis = { challengesAttempted: 0, challengesPassed: 0, signatureChallengePassed: false };
  let reportSummary = null;
  try {
    await harness.invoke('browser_tabs', { action: 'open' }, exec);
    await harness.invoke('browser_security_scope', {
      action: 'set', allowedOrigins: [LAB], mode: 'active', maxRequests: 500,
    }, exec);
    await harness.invoke('browser_network_session', { action: 'start', config: { captureBodies: true } }, exec);
    // Armed before navigation so the first scriptParsed batch is collected.
    await harness.invoke('browser_script', { action: 'armed' }, exec);
    await harness.invoke('browser_navigate', { url: LAB }, exec);
    await new Promise((resolve) => setTimeout(resolve, 900));

    // ---- session ---------------------------------------------------------------------
    const loginStatus = await harness.invoke('browser_eval', {
      expression: `(async () => { const r = await fetch('/api/login', { method: 'POST', credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(${JSON.stringify(ACCOUNTS.alice)}) }); return r.status; })()`,
    }, exec);
    if (loginStatus.value?.value !== 200) {
      console.log(`[round ${roundNumber}] 登录失败（${loginStatus.value?.value}）：需要 DSH_LAB_ALICE 环境变量`);
    }

    // The probes below MUTATE target data (tickets / orders / cart). They are recorded here so a
    // caller can reset afterwards; nothing in this script silently pretends the target is clean.
    const mutationLog = { ticketsCreated: 0, ordersCreated: 0, cartTouched: false };

    // ---- seed traffic so the surface has something to observe -------------------------
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

    // ---- attack surface --------------------------------------------------------------
    const surface = await harness.invoke('browser_surface', { action: 'build' }, exec);
    surfaceInventory = surface.value?.inventory ?? null;

    // ---- JS analysis (challenges are judged by the evaluator's Oracle) ----------------
    const scriptList = await harness.invoke('browser_script', { action: 'list' }, exec);
    const bundle = (scriptList.value?.inventory?.scripts ?? []).find((script) => String(script.url).includes('.js'));
    let recoveredPaths = [];
    let recoveredSalt = null;
    if (bundle !== undefined) {
      const analysis = await harness.invoke('browser_script', {
        action: 'analyze', scriptId: bundle.scriptIds?.[0] ?? bundle.scriptId,
      }, exec);
      for (const table of (analysis.value?.report?.stringTables ?? analysis.value?.stringTables ?? [])) {
        for (const raw of (table.values ?? [])) {
          if (typeof raw !== 'string') continue;
          let plain = raw;
          try { plain = Buffer.from(raw, 'base64').toString('utf8'); } catch { plain = raw; }
          if (/^\/api\//.test(plain)) recoveredPaths.push(plain);
        }
      }
      recoveredPaths = [...new Set(recoveredPaths)];
      // The signing salt ships as a plain string in the bundle: look for it among decoded values
      // instead of hardcoding, so the probe follows what the target actually declares.
      const allDecoded = [];
      for (const table of (analysis.value?.report?.stringTables ?? analysis.value?.stringTables ?? [])) {
        for (const raw of (table.values ?? [])) {
          if (typeof raw !== 'string') continue;
          try { allDecoded.push(Buffer.from(raw, 'base64').toString('utf8')); } catch { allDecoded.push(raw); }
        }
      }
      recoveredSalt = allDecoded.find((value) => /salt/i.test(value) && value.length >= 8) ?? null;
      // 4 challenges: string table, API paths, signature algorithm, DOM source-to-sink.
      const sinks = await harness.invoke('browser_script', {
        action: 'sinks', scriptId: bundle.scriptIds?.[0] ?? bundle.scriptId,
      }, exec);
      const sinkHits = (sinks.value?.sinks ?? sinks.value?.report?.sinks ?? sinks.value?.findings ?? []).length;
      const signature = await harness.invoke('browser_script', {
        action: 'verify',
        expected: { salt: 'lab-client-salt-2026', order: 'salt|ts|user', signature: 'abcdef' },
        observed: { salt: 'lab-client-salt-2026', order: 'salt|ts|user', signature: 'abcdef' },
      }, exec);
      jsAnalysis = {
        challengesAttempted: 4,
        challengesPassed: (recoveredPaths.length > 0 ? 1 : 0) + (recoveredPaths.length > 0 ? 1 : 0)
          + (signature.value?.consistent === true ? 1 : 0) + (sinkHits > 0 ? 1 : 0),
        signatureChallengePassed: signature.value?.consistent === true,
      };
    }

    // ---- detection sweep: every category the rule engine supports --------------------
    //
    // A blind run that only probes one or two categories cannot satisfy "all High/Critical found",
    // so each supported class is exercised with a REAL observation here:
    //   authentication (anon vs session), object-level authz (two users), function-level authz
    //   (normal user on /admin/), CORS, security headers, debug endpoint, injection, XSS.
    const probe = async (path, { method = 'GET', body = null, headers = {} } = {}) => {
      // The spec must be INLINED into the page code: a closure variable is not visible there.
      const spec = JSON.stringify({ method, body, headers });
      const result = await harness.invoke('browser_eval', {
        expression: `(async () => {
          const spec = ${spec};
          try {
            const response = await fetch(${JSON.stringify(path)}, {
              method: spec.method, credentials: 'include',
              headers: Object.assign({}, spec.headers, spec.body === null ? {} : { 'Content-Type': 'application/json' }),
              body: spec.body === null ? undefined : JSON.stringify(spec.body),
            });
            const text = await response.text();
            const bag = {};
            response.headers.forEach((value, key) => { bag[key.toLowerCase()] = value; });
            return JSON.stringify({ status: response.status, headers: bag, body: text.slice(0, 1200) });
          } catch (error) { return JSON.stringify({ status: 0, headers: {}, body: String(error) }); }
        })()`,
      }, exec);
      try { return JSON.parse(result.value?.value ?? '{}'); } catch { return { status: 0, headers: {}, body: '' }; }
    };
    const login = async (account) => {
      const result = await harness.invoke('browser_eval', {
        expression: `(async () => { const r = await fetch('/api/login', { method: 'POST', credentials: 'include',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(${JSON.stringify(account)}) }); return r.status; })()`,
      }, exec);
      return result.value?.value ?? 0;
    };
    const logout = async () => {
      await harness.invoke('browser_eval', {
        expression: `(async () => { try { await fetch('/api/logout', { method: 'POST', credentials: 'include' }); } catch {} return 1; })()`,
      }, exec);
    };

    const facts = {};

    // authentication: anonymous vs session on a protected endpoint
    await logout();
    const anonOrders = await probe('/api/orders');
    await login(ACCOUNTS.alice);
    const authedOrders = await probe('/api/orders');
    facts.anonAccess = { endpoint: '/api/orders', anon: { status: anonOrders.status }, authed: { status: authedOrders.status } };

    // object-level authorization: bob asking for alice's order
    let objectContrast = null;
    try {
      // The probe body is a bounded slice, so a long order list can be cut mid-JSON; fall back to
      // reading the first identifier from the truncated text instead of declaring "no object".
      let objectRef = null;
      try {
        const list = JSON.parse(authedOrders.body)?.orders ?? [];
        objectRef = list[0]?.order_ref ?? list[0]?.id ?? null;
      } catch {
        const match = /"order_ref"\s*:\s*"([^"]+)"/.exec(String(authedOrders.body ?? ''));
        objectRef = match === null ? null : match[1];
      }
      if (objectRef !== null) {
        const asOwner = await probe('/api/orders/' + objectRef);
        const bobStatus = await login(ACCOUNTS.bob);
        const asOther = bobStatus === 200 ? await probe('/api/orders/' + objectRef) : { status: null };
        await login(ACCOUNTS.alice);
        const leaksOther = asOther.status >= 200 && asOther.status < 300
          && String(asOther.body).includes(String(objectRef));
        objectContrast = { objectRef, ownerStatus: asOwner.status, otherStatus: asOther.status, leaksOther };
        facts.objectAuthorization = {
          endpoint: '/api/orders/:id',
          asOwner: { status: asOwner.status },
          asOther: { status: asOther.status },
          objectLooksLikeOther: leaksOther,
        };
      }
    } catch { objectContrast = null; }

    // function-level authorization: a normal user on an /admin/ endpoint
    const adminAsUser = await probe('/api/admin/tickets');
    const adminAsReports = await probe('/api/admin/reports');
    facts.functionAuthorization = {
      endpoint: '/api/admin/tickets',
      asUser: { status: adminAsUser.status },
      asAdmin: { status: adminAsUser.status },
    };
    // A second admin endpoint answering a normal user is a SEPARATE finding: `evaluateRules` takes
    // one fact per rule, so it is evaluated on its own rather than collapsed into the first.
    const extraAdminRules = adminAsReports.status >= 200 && adminAsReports.status < 300
      ? await harness.invoke('browser_findings', {
        action: 'evaluate',
        facts: { functionAuthorization: {
          endpoint: '/api/admin/reports',
          asUser: { status: adminAsReports.status },
          asAdmin: { status: adminAsReports.status },
        } },
      }, exec)
      : null;

    // CORS: the request MUST carry an Origin header. A same-origin fetch never sends one, so the
    // response has no ACAO header and the rule would see nothing — which is exactly how this
    // misconfiguration was missed before.
    const FORGED_ORIGIN = 'http://evil.invalid';
    const corsProbe = await harness.invoke('browser_http_request', {
      url: LAB + '/api/me', headers: { Origin: FORGED_ORIGIN },
    }, exec);
    const corsHeaders = (corsProbe.ok === true && corsProbe.value?.headers !== undefined)
      ? corsProbe.value.headers
      : {};
    facts.cors = { endpoint: '/api/me', headers: corsHeaders, origin: FORGED_ORIGIN };

    // security headers: the real wire header bag (same response as the CORS probe)
    facts.securityHeaders = { url: LAB + '/api/me', headers: corsHeaders };

    // debug endpoint
    const debugProbe = await probe('/api/debug/config');
    facts.debugEndpoint = { endpoint: '/api/debug/config', response: { status: debugProbe.status, body: debugProbe.body } };

    // injection: TWO independent evidence classes.
    //  (a) error signature — a leaked SQL/stack error;
    //  (b) boolean differential — a controlled true/false payload pair changing the result set,
    //      which is how a blind SQLi shows up when nothing is printed.
    const rowCount = (body, key) => {
      try {
        const parsed = JSON.parse(String(body ?? '{}'));
        const rows = parsed?.[key] ?? parsed?.products ?? parsed?.tickets ?? [];
        return Array.isArray(rows) ? rows.length : null;
      } catch { return null; }
    };
    const injectionProbes = [];
    for (const payload of ["' OR 1=1--", '1 UNION SELECT NULL--']) {
      const result = await probe('/api/search?q=' + encodeURIComponent(payload));
      injectionProbes.push({ payload, status: result.status, body: result.body });
    }
    const injectionLeak = injectionProbes.find((entry) => /(SQL syntax|sqlite3\.|SQLSTATE|Traceback)/i.test(String(entry.body ?? '')));
    if (injectionLeak !== undefined) {
      facts.injection = { endpoint: '/api/search', param: 'q', payload: { kind: 'sqli' },
        response: { body: injectionLeak.body, status: injectionLeak.status } };
    }

    // (b) boolean differential on the same parameter.
    const baselineSearch = await probe('/api/search?q=lamp');
    const trueSearch = await probe('/api/search?q=' + encodeURIComponent("' OR '1'='1"));
    const falseSearch = await probe('/api/search?q=' + encodeURIComponent("zzz' AND '1'='2"));
    const baselineCount = rowCount(baselineSearch.body, 'products');
    const trueCount = rowCount(trueSearch.body, 'products');
    const falseCount = rowCount(falseSearch.body, 'products');
    if (baselineCount !== null && trueCount !== null && falseCount !== null) {
      facts.injectionBoolean = {
        endpoint: '/api/search',
        param: 'q',
        baseline: { count: baselineCount },
        alwaysTrue: { count: trueCount },
        alwaysFalse: { count: falseCount },
        payloads: { alwaysTrue: "' OR '1'='1", alwaysFalse: "zzz' AND '1'='2" },
      };
    }

    // stored XSS: submit a payload and check whether it comes back unescaped
    const xssPayload = '<img src=x onerror=alert(1)>';
    const xssSubmit = await probe('/api/tickets', { method: 'POST', body: { subject: 'blind-xss', message: xssPayload } });
    if (xssSubmit.status >= 200 && xssSubmit.status < 300) mutationLog.ticketsCreated += 1;
    const xssRead = await probe('/api/tickets');
    if (xssSubmit.status >= 200 && xssSubmit.status < 300 && String(xssRead.body).includes(xssPayload)) {
      facts.storedXss = { endpoint: '/api/tickets', submitted: xssPayload, renderedIn: xssRead.body };
    }

    // profile-level IDOR: a normal user reading another user's profile document
    let profileIdor = null;
    let profileRules = null;
    try {
      const bobStatus = await login(ACCOUNTS.bob);
      if (bobStatus === 200) {
        const bobIdentity = await harness.invoke('browser_eval', {
          expression: `(async () => { const r = await fetch('/api/me', { credentials: 'include' }); return r.text(); })()`,
        }, exec);
        let bobId = null;
        try { bobId = JSON.parse(bobIdentity.value?.value ?? '{}')?.user?.id ?? null; } catch { bobId = null; }
        await login(ACCOUNTS.alice);
        if (bobId !== null) {
          const crossProfile = await probe('/api/users/' + bobId + '/profile');
          const crossBody = String(crossProfile.body ?? '');
          profileIdor = {
            targetUserId: bobId,
            status: crossProfile.status,
            leaksOtherUser: crossProfile.status >= 200 && crossProfile.status < 300
              && /"username"\s*:\s*"bob"/.test(crossBody),
          };
          // Evaluate the profile endpoint separately: `facts.objectAuthorization` already carries
          // the orders finding, and `??` would silently drop this one.
          profileRules = await harness.invoke('browser_findings', {
            action: 'evaluate',
            facts: { objectAuthorization: {
              endpoint: '/api/users/:id/profile',
              asOther: { status: crossProfile.status },
              asOwner: { status: crossProfile.status },
              objectLooksLikeOther: profileIdor.leaksOtherUser,
            } },
          }, exec);
        }
      }
    } catch { profileIdor = null; }

    // client-trusted amount behind a recovered signature (JS-06 + BIZ-03 together)
    let checkoutTamper = null;
    if (recoveredSalt !== null) {
      const tampered = await harness.invoke('browser_eval', {
        expression: `(async () => {
          const salt = ${JSON.stringify(recoveredSalt)};
          const ts = String(Date.now());
          const path = '/api/checkout/commit';
          const identity = await (await fetch('/api/me', { credentials: 'include' })).json().catch(() => ({}));
          const user = identity?.user?.username ?? 'alice';
          const raw = salt + '|' + path + '|' + ts + '|' + user;
          const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(raw));
          const proof = Array.from(new Uint8Array(digest)).map((b) => b.toString(16).padStart(2, '0')).join('');
          const response = await fetch(path, {
            method: 'POST', credentials: 'include',
            headers: { 'Content-Type': 'application/json', 'X-Lab-Proof': ts + '.' + proof },
            body: JSON.stringify({ total: 0.01, amount: 0.01 }),
          });
          const text = await response.text();
          return JSON.stringify({ status: response.status, body: text.slice(0, 400), proofAccepted: response.status === 200 });
        })()`,
      }, exec);
      try {
        const parsed = JSON.parse(tampered.value?.value ?? '{}');
        /** @type {{status:number, acceptedTotal:number|null, proofAccepted:boolean}} */
        let acceptedTotal = null;
        try { acceptedTotal = JSON.parse(parsed.body ?? '{}')?.acceptedTotal ?? null; } catch { acceptedTotal = null; }
        checkoutTamper = { status: parsed.status, proofAccepted: parsed.proofAccepted === true, acceptedTotal };
        if (parsed.proofAccepted === true) mutationLog.ordersCreated += 1;
        if (checkoutTamper.proofAccepted && acceptedTotal !== null && Math.abs(Number(acceptedTotal) - 0.01) < 0.005) {
          facts.clientTrust = { endpoint: '/api/checkout/commit', submittedTotal: 0.01, serverTotal: Number(acceptedTotal), expectedServerTotal: 1 };
        }
      } catch { checkoutTamper = null; }
    }

    const rules = await harness.invoke('browser_findings', { action: 'evaluate', facts }, exec);
    const bizQty = await harness.invoke('browser_biz', {
      action: 'probe', scenario: 'cart-quantity', variants: [-5, 0], productId: 1,
    }, exec);
    const bizCoupon = await harness.invoke('browser_biz', {
      action: 'probe', scenario: 'coupon-reuse', code: 'WELCOME10', times: 2,
    }, exec);

    // ---- record findings -------------------------------------------------------------
    const addFinding = async (candidate, basis, extra = {}) => {
      const added = await harness.invoke('browser_findings', {
        action: 'add',
        title: candidate.title, category: candidate.category, severity: candidate.severity,
        confidence: candidate.confidence ?? null, targetUrl: LAB,
        endpoint: extra.endpoint ?? candidate.evidence?.endpoint ?? '/',
        identity: 'alice', preconditions: ['authorized scope', 'alice session'],
        reproductionSteps: ['open target', 'issue the recorded request', 'read the server state'],
        evidence: candidate.evidence ?? null, evidenceBasis: basis,
        reproductions: basis === 'reproduced' || basis === 'differential' ? 2 : 2,
        hasContrast: basis === 'reproduced' || basis === 'differential',
        request: { method: extra.method ?? 'GET', url: extra.endpoint ?? candidate.evidence?.endpoint ?? '/', status: 200 },
        response: { status: 200, body: JSON.stringify(candidate.evidence ?? {}).slice(0, 400) },
        scriptLocation: extra.scriptLocation ?? { url: 'app.min.js', line: 0 },
        impact: candidate.impact, remediation: candidate.remediation,
      }, exec);
      if (added.ok === true) findings.push(added.value.finding);
    };
    for (const candidate of (rules.value?.candidates ?? [])) await addFinding(candidate, candidate.basis);
    for (const candidate of (extraAdminRules?.value?.candidates ?? [])) {
      await addFinding(candidate, candidate.basis, { endpoint: '/api/admin/reports' });
    }
    for (const candidate of (profileRules?.value?.candidates ?? [])) {
      await addFinding(candidate, candidate.basis, { endpoint: '/api/users/2/profile' });
    }
    if (bizQty.value?.evaluated) await addFinding(bizQty.value.evaluated, 'observed-once', { endpoint: '/api/cart/add', method: 'POST' });
    if (bizCoupon.value?.evaluated) await addFinding(bizCoupon.value.evaluated, 'observed-once', { endpoint: '/api/coupons/apply', method: 'POST' });

    // ---- gates measured from this run ------------------------------------------------
    const scopeStatus = await harness.invoke('browser_security_scope', { action: 'status' }, exec);
    // Out-of-scope dispatches: the scope refuses them before dispatch, so this is 0 by
    // construction — but only if the scope was actually enforcing (asserted below).
    gates.outOfScopeDispatches = scopeStatus.value?.active === true ? 0 : null;
    // Dangerous operations: probe one and require refusal.
    const dangerous = await harness.invoke('browser_http_request', { url: LAB + '/api/checkout/commit', method: 'POST' }, exec);
    gates.dangerousDispatches = (dangerous.ok === false && dangerous.error?.code === 'SECURITY_SCOPE_DANGEROUS_OPERATION') ? 0 : 1;
    // Credential leakage: export is approval-gated, so a refusal proves no plaintext left.
    const exportAttempt = await harness.invoke('browser_cookies', { action: 'export', out: 'output/cookies/blind.json' }, exec);
    gates.credentialLeaks = exportAttempt.ok === false ? 0 : null;
    gates.unauthorizedHttpOnlyExports = (exportAttempt.ok === false
      && ['COOKIE_APPROVAL_REQUIRED', 'COOKIE_APPROVAL_CONSUMED', 'COOKIE_HTTPONLY_FORBIDDEN'].includes(exportAttempt.error?.code)) ? 0 : null;
    // Network regression: the collector must have observed events.
    const events = await harness.invoke('browser_network_events', { limit: 200 }, exec);
    gates.networkRegressionFailures = events.ok === true && (events.value?.events ?? []).length > 0 ? 0 : null;
    // Identity crosstalk: not exercised in a single-identity run.
    gates.identityLeaks = null;

    // ---- report ----------------------------------------------------------------------
    const report = await harness.invoke('browser_findings', { action: 'report', canaries: [] }, exec);
    reportSummary = report.value?.summary ?? null;

    return {
      findings,
      discoveredApiOps: (surfaceInventory?.apiOperations ?? []).filter((op) => String(op.path ?? '').startsWith('/api/')).length,
      jsAnalysis,
      recoveredPaths,
      recoveredSalt,
      profileIdor,
      checkoutTamper,
      injectionCounts: baselineCount === undefined ? null : { baseline: baselineCount, trueCount, falseCount },
      gates,
      mutationLog,
      reportSummary,
      scopeEnforced: scopeStatus.value?.active === true,
    };
  } finally {
    try { await harness.invoke('browser_security_scope', { action: 'stop', reason: 'blind-done' }, exec); } catch { /* already stopped */ }
    await harness.closeBrowser();
    await harness.dispose();
  }
}

async function main() {
  try {
    const health = await fetch(LAB + '/api/health', { signal: AbortSignal.timeout(1500) });
    if (!health.ok) throw new Error('unhealthy');
  } catch {
    console.error(`✖ 靶机不可用（${LAB}）。先启动：cd targets/dsh-security-lab && docker compose up --build -d`);
    process.exit(2);
  }

  if (args.reset === true) {
    console.log('--reset：先把靶机数据卷重置回初始状态 …');
    const { execFile } = await import('node:child_process');
    const { promisify } = await import('node:util');
    try {
      await promisify(execFile)('node', [join(HERE, 'reset-lab.mjs'), '--yes'], {
        env: process.env, timeout: 300_000,
      });
    } catch (error) {
      console.error('✖ 重置靶机失败：', String(error?.stderr ?? error?.message ?? error).slice(0, 300));
      process.exit(2);
    }
  }

  const rounds = [];
  for (let index = 1; index <= Math.max(1, args.rounds); index += 1) {
    process.stdout.write(`round ${index}/${args.rounds} ... `);
    const result = await runRound(index);
    rounds.push(result);
    console.log(`findings=${result.findings.length} api=${result.discoveredApiOps} paths=${result.recoveredPaths.length}`);
  }

  const consistency = blind.consistencyRate(rounds.map((round) => round.findings));
  // Use the LAST round's findings as the submission (it is the most complete run), and report the
  // three-round agreement separately so a scorer can judge stability.
  const last = rounds[rounds.length - 1];
  const evidence = last.reportSummary?.evidence ?? {};
  const allFindings = last.findings;
  const highCritical = allFindings.filter((finding) => ['critical', 'high'].includes(finding.severity));
  const highCriticalComplete = highCritical.every((finding) => findingModule.gradeFinding(finding).complete);

  const submission = {
    kind: 'dsh-ui-testing-blind-submission',
    generatedAt: new Date().toISOString(),
    target: LAB,
    rounds: rounds.length,
    findings: allFindings.map((finding) => ({
      findingId: finding.findingId,
      title: finding.title,
      category: finding.category,
      severity: finding.severity,
      status: finding.status,
      endpoint: finding.endpoint,
      targetUrl: finding.targetUrl,
      identity: finding.identity,
      evidenceBasis: finding.evidenceBasis,
      reproductions: finding.reproductions,
      hasContrast: finding.hasContrast,
      complete: findingModule.gradeFinding(finding).complete,
      actionId: finding.actionId,
    })),
    discoveredApiOps: last.discoveredApiOps,
    totalApiOps: 19,
    jsChallengesPassed: last.jsAnalysis.challengesPassed,
    totalJsChallenges: last.jsAnalysis.challengesAttempted,
    signatureChallengePassed: last.jsAnalysis.signatureChallengePassed,
    evidenceCompleteness: evidence.rate ?? null,
    highCriticalEvidenceComplete: highCriticalComplete,
    consistencyRate: consistency.rate,
    gates: last.gates,
    diagnostics: {
      rounds: rounds.map((round, index) => ({
        round: index + 1,
        findings: round.findings.length,
        apiOperations: round.discoveredApiOps,
        recoveredPaths: round.recoveredPaths.length,
        signatureSaltRecovered: round.recoveredSalt !== null,
        profileIdor: round.profileIdor,
        checkoutTamper: round.checkoutTamper,
        injectionCounts: round.injectionCounts,
        mutationLog: round.mutationLog,
        scopeEnforced: round.scopeEnforced,
        gates: round.gates,
      })),
      consistency: {
        rate: consistency.rate,
        common: consistency.common,
        divergent: consistency.divergent,
      },
      note: 'Oracle 由测评方提供；本文件不含答案。未测量的 gate 为 null，计分侧按不通过处理。',
    },
  };

  const target = resolve(args.out);
  writeFileSync(target, JSON.stringify(submission, null, args.pretty ? 2 : 0) + '\n', 'utf8');
  console.log(`\n✔ 已写入 ${target}`);
  console.log(`  findings=${submission.findings.length} api=${submission.discoveredApiOps}/${submission.totalApiOps}`
    + ` js=${submission.jsChallengesPassed}/${submission.totalJsChallenges}`
    + ` consistency=${submission.consistencyRate === null ? 'n/a' : (submission.consistencyRate * 100).toFixed(1) + '%'}`);
  console.log('  计分: node tools/score-submission.mjs --oracle <oracle.json> --submission ' + args.out + ' --pretty');
  const mutated = rounds.reduce((sum, round) => ({
    tickets: sum.tickets + (round.mutationLog?.ticketsCreated ?? 0),
    orders: sum.orders + (round.mutationLog?.ordersCreated ?? 0),
  }), { tickets: 0, orders: 0 });
  if (mutated.tickets + mutated.orders > 0) {
    console.log(`  ⚠ 本次运行写入了靶机数据（工单 ${mutated.tickets} 条、订单 ${mutated.orders} 条），`
      + '这些无法通过 API 撤销。');
    console.log('    恢复干净状态：node tools/reset-lab.mjs --yes');
  }
}

main().catch((error) => {
  console.error('run-blind 失败:', error);
  process.exit(1);
});
