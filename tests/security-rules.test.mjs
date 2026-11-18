/**
 * security-rules.test.mjs — FR-09 安全规则引擎（VULN-01..07、VULN-10/11）。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  RULE_IDS, SECURITY_HEADERS, evaluateRules, ruleAnonAccess, ruleClientTrust, ruleCors,
  ruleDebugEndpoint, ruleDomXss, ruleFunctionAuthorization, ruleInjection, ruleInjectionBoolean,
  ruleObjectAuthorization, ruleParamBoundary, ruleParamType, ruleSecurityHeaders,
  ruleStoredXss, ruleVerboseError, headerValue,
} from '../security-rules.js';
import { deriveStatus } from '../finding.js';

const ok = (condition, message) => assert.ok(condition, message);

/* ----------------------------------------------------------------------------------------------- */

test('VULN-01 anonymous access to a protected endpoint is a differential candidate', () => {
  const candidate = ruleAnonAccess({
    endpoint: '/api/orders', anon: { status: 200 }, authed: { status: 200 },
  });
  ok(candidate !== null && candidate.ruleId === 'AUTH-ANON-ACCESS');
  ok(candidate.basis === 'differential');
  ok(deriveStatus({ basis: candidate.basis }).status === 'likely', 'differential alone is likely');
  ok(ruleAnonAccess({ endpoint: '/api/orders', anon: { status: 401 }, authed: { status: 200 } }) === null,
    '401 to anonymous is the correct behaviour, no finding');
  ok(ruleAnonAccess({ endpoint: '/api/login', anon: { status: 200 }, authed: { status: 200 } }) === null,
    'public endpoint excluded');
});

test('VULN-01 verbose error signature is observed-once (never confirmed)', () => {
  const candidate = ruleVerboseError({ endpoint: '/api/x', response: { body: 'Traceback (most recent call last):' } });
  ok(candidate !== null && candidate.ruleId === 'AUTH-VERBOSE-ERROR');
  ok(deriveStatus({ basis: candidate.basis }).status === 'likely');
  ok(ruleVerboseError({ endpoint: '/x', response: { body: 'ok' } }) === null);
});

test('VULN-02 object authorization is critical but still needs reproduction+contrast', () => {
  const candidate = ruleObjectAuthorization({
    endpoint: '/api/orders/42',
    asOwner: { status: 200 }, asOther: { status: 200 }, objectLooksLikeOther: true,
  });
  ok(candidate !== null && candidate.ruleId === 'AUTHZ-OBJECT' && candidate.severity === 'critical');
  ok(deriveStatus({ basis: candidate.basis, reproductions: 2, hasContrast: true }).status === 'confirmed');
  ok(deriveStatus({ basis: candidate.basis, reproductions: 1, hasContrast: true }).status === 'likely');
  ok(ruleObjectAuthorization({ endpoint: '/x', asOwner: { status: 200 }, asOther: { status: 403 } }) === null,
    '403 for the other identity is correct behaviour');
});

test('VULN-03 function authorization needs both roles to succeed', () => {
  const candidate = ruleFunctionAuthorization({
    endpoint: '/api/admin/reports', asUser: { status: 200 }, asAdmin: { status: 200 },
  });
  ok(candidate !== null && candidate.severity === 'high');
  ok(ruleFunctionAuthorization({ endpoint: '/api/admin/reports', asUser: { status: 403 }, asAdmin: { status: 200 } }) === null);
});

test('VULN-04 parameter type abuse is only a finding on a 5xx', () => {
  const candidate = ruleParamType({
    endpoint: '/api/orders', param: 'qty',
    observations: [{ variant: 'string', status: 500 }, { variant: 'array', status: 400 }],
  });
  ok(candidate !== null && candidate.ruleId === 'PARAM-TYPE');
  ok(ruleParamType({ endpoint: '/x', param: 'q', observations: [{ variant: 'a', status: 400 }] }) === null,
    '4xx rejections are correct behaviour');
});

test('VULN-04 boundary acceptance is reported without claiming business impact', () => {
  const candidate = ruleParamBoundary({
    endpoint: '/api/cart/add', param: 'qty',
    observations: [{ variant: '-1', boundary: true, accepted: true }],
  });
  ok(candidate !== null && candidate.ruleId === 'PARAM-BOUNDARY');
  ok(candidate.basis === 'observed-once');
  ok(ruleParamBoundary({ endpoint: '/x', param: 'q', observations: [{ variant: '-1', boundary: true, accepted: false }] }) === null);
});

test('VULN-05 injection is only claimed on a real error signature', () => {
  const candidate = ruleInjection({
    endpoint: '/api/search', param: 'q', payload: { kind: 'sqli' },
    response: { body: 'sqlite3.OperationalError: near "1"', status: 500 },
  });
  ok(candidate !== null && candidate.ruleId === 'INJ-ERROR-SIGNATURE');
  ok(ruleInjection({ endpoint: '/api/search', param: 'q', payload: {}, response: { body: 'normal results' } }) === null,
    'a normal response is not injection evidence');
});

test('VULN-06 DOM XSS stays potential because it is static evidence', () => {
  const candidate = ruleDomXss({ scriptUrl: 'app.js', sink: 'innerHTML', source: 'location', confidence: 'high' });
  ok(candidate !== null && candidate.severity === 'medium');
  ok(deriveStatus({ basis: candidate.basis }).status === 'potential', 'static pattern can never be confirmed');
  ok(deriveStatus({ basis: candidate.basis, reproductions: 5, hasContrast: true }).status === 'potential',
    'even repeated reproduction does not promote static evidence');
});

test('VULN-06 stored XSS requires the payload to be rendered back', () => {
  const candidate = ruleStoredXss({ endpoint: '/api/tickets', submitted: '<img src=x onerror=alert(1)>', renderedIn: 'tickets: <img src=x onerror=alert(1)>' });
  ok(candidate !== null && candidate.severity === 'high');
  ok(ruleStoredXss({ endpoint: '/x', submitted: '<b>', renderedIn: 'tickets: &lt;b&gt;' }) === null,
    'escaped output is not a finding');
});

test('VULN-07 CORS: wildcard vs credentials have different severities', () => {
  const credentials = ruleCors({ endpoint: '/api/me', headers: { 'access-control-allow-origin': '*', 'access-control-allow-credentials': 'true' } });
  ok(credentials !== null && credentials.ruleId === 'CORS-CREDENTIALS' && credentials.severity === 'high');
  const plain = ruleCors({ endpoint: '/api/public', headers: { 'access-control-allow-origin': '*' } });
  ok(plain !== null && plain.ruleId === 'CORS-WILDCARD' && plain.severity === 'medium');
  const pinned = ruleCors({ endpoint: '/api/x', headers: { 'access-control-allow-origin': 'https://app.localhost:8088' }, origin: 'https://app.localhost:8088' });
  ok(pinned !== null && pinned.evidence.originEchoed === true, 'echoing an arbitrary origin is reported');
  ok(ruleCors({ endpoint: '/api/x', headers: { 'access-control-allow-origin': 'https://trusted.example' }, origin: 'https://evil.example' }) === null,
    'a pinned non-matching origin is not a finding');
});

test('VULN-07 security headers: missing list is reported; HSTS only for HTTPS', () => {
  const http = ruleSecurityHeaders({ url: 'http://a:1', headers: { 'content-security-policy': "default-src 'self'" } });
  ok(http !== null && http.ruleId === 'HEADER-MISSING');
  ok(http.evidence.missing.includes('x-frame-options'));
  ok(!http.evidence.missing.includes('strict-transport-security'), 'HSTS not required on plain HTTP');
  const https = ruleSecurityHeaders({ url: 'https://a:1', headers: {}, isHttps: true });
  ok(https.evidence.missing.includes('strict-transport-security'), 'HSTS required on HTTPS');
  const all = ruleSecurityHeaders({
    url: 'https://a:1', isHttps: true,
    headers: Object.fromEntries(SECURITY_HEADERS.map((header) => [header.name, 'x'])),
  });
  ok(all === null, 'all headers present = no finding');
});

test('information disclosure: debug endpoints only when actually reachable', () => {
  const candidate = ruleDebugEndpoint({ endpoint: '/api/debug/config', response: { status: 200, body: '{"debug":true}' } });
  ok(candidate !== null && candidate.ruleId === 'DISC-DEBUG-ENDPOINT');
  ok(ruleDebugEndpoint({ endpoint: '/api/debug/config', response: { status: 404, body: '' } }) === null);
  ok(ruleDebugEndpoint({ endpoint: '/api/products', response: { status: 200, body: '[]' } }) === null);
});

test('BIZ: client-trusted amount is a differential business finding', () => {
  const candidate = ruleClientTrust({ endpoint: '/api/checkout/commit', submitted: { amount: 1 }, serverTruth: { amount: 99 } });
  ok(candidate !== null && candidate.ruleId === 'BIZ-CLIENT-TRUST' && candidate.severity === 'critical',
    'a client-trusted amount is critical (same severity as business-logic.js)');
  ok(ruleClientTrust({ endpoint: '/api/checkout/commit', submitted: { amount: 99 }, serverTruth: { amount: 99 } }) === null,
    'server recomputing the same value is correct behaviour');
});

test('evaluateRules runs every rule and labels candidates as non-confirmed', () => {
  const result = evaluateRules({
    anonAccess: { endpoint: '/api/orders', anon: { status: 200 }, authed: { status: 200 } },
    domXss: { scriptUrl: 'a.js', sink: 'innerHTML', source: 'location', confidence: 'high' },
    cors: { endpoint: '/api/me', headers: { 'access-control-allow-origin': '*', 'access-control-allow-credentials': 'true' } },
  });
  ok(result.candidates.length === 3, 'three facts produce three candidates');
  ok(result.ruleIds.length === 3);
  ok(RULE_IDS.length >= 15, 'rule catalogue is declared');
  for (const candidate of result.candidates) {
    const derived = deriveStatus({ basis: candidate.basis });
    ok(derived.status !== 'confirmed', 'no candidate may be born confirmed: ' + candidate.ruleId);
  }
  ok(result.note.includes('不得直接标 confirmed'));
});

test('evaluateRules with no facts yields no candidates', () => {
  const empty = evaluateRules({});
  ok(empty.candidates.length === 0 && empty.ruleIds.length === 0);
});

/* -----------------------------------------------------------------------------------------------
 * ruleClientTrust：两种观测形状必须都能识别（同名缺陷不该有两套入参语义）
 * ---------------------------------------------------------------------------------------------- */

test('BIZ client-trust accepts the business-logic shape and the rules shape', () => {
  // business-logic shape: server followed the client and diverged from the correct amount
  const fromBusiness = ruleClientTrust({
    endpoint: '/api/checkout/commit', submittedTotal: 0.01, serverTotal: 0.01, expectedServerTotal: 1,
  });
  ok(fromBusiness !== null && fromBusiness.ruleId === 'BIZ-CLIENT-TRUST', 'business shape detected');
  ok(fromBusiness.severity === 'critical', 'a trusted client amount is critical');
  // rules shape
  const fromRules = ruleClientTrust({ endpoint: '/x', submitted: { amount: 1 }, serverTruth: { amount: 99 } });
  ok(fromRules !== null && fromRules.ruleId === 'BIZ-CLIENT-TRUST', 'rules shape detected');
  // Correct behaviour must stay silent in both shapes.
  ok(ruleClientTrust({ submittedTotal: 99, serverTotal: 99, expectedServerTotal: 99 }) === null,
    'server recomputing the right amount is not a finding');
  ok(ruleClientTrust({ submitted: { amount: 5 }, serverTruth: { amount: 5 } }) === null,
    'client and server agreeing is not a finding (no expected value to compare)');
  ok(ruleClientTrust({}) === null, 'an empty fact produces nothing');
});

test('BIZ client-trust through evaluateRules', () => {
  const result = evaluateRules({
    clientTrust: { endpoint: '/api/checkout/commit', submittedTotal: 0.01, serverTotal: 0.01, expectedServerTotal: 1 },
  });
  ok((result.candidates ?? []).some((candidate) => candidate.ruleId === 'BIZ-CLIENT-TRUST'),
    'evaluateRules forwards the fact without needing the caller to know the shape');
});

/* -----------------------------------------------------------------------------------------------
 * 布尔型注入：受控三组对照，缺一不算
 * ---------------------------------------------------------------------------------------------- */

test('INJ-BOOLEAN-DIFF requires all three observations and both directions', () => {
  const hit = ruleInjectionBoolean({
    endpoint: '/api/search', param: 'q',
    baseline: { count: 1 }, alwaysTrue: { rows: [1, 2, 3, 4, 5] }, alwaysFalse: { count: 0 },
  });
  ok(hit !== null && hit.ruleId === 'INJ-BOOLEAN-DIFF', 'widening + narrowing together is injection');
  ok(hit.severity === 'high' && hit.basis === 'differential');
  ok(hit.evidence.counts.baseline === 1 && hit.evidence.counts.alwaysTrue === 5 && hit.evidence.counts.alwaysFalse === 0);
});

test('INJ-BOOLEAN-DIFF stays silent without a real differential', () => {
  // True payload does not widen → probably fuzzy match, not injection.
  ok(ruleInjectionBoolean({ baseline: { count: 1 }, alwaysTrue: { count: 1 }, alwaysFalse: { count: 0 } }) === null,
    'no widening is not injection');
  // False payload does not narrow → not a controlled condition.
  ok(ruleInjectionBoolean({ baseline: { count: 3 }, alwaysTrue: { count: 5 }, alwaysFalse: { count: 3 } }) === null,
    'no narrowing is not injection');
  // Missing an observation means no conclusion at all.
  ok(ruleInjectionBoolean({ baseline: { count: 1 }, alwaysTrue: { count: 5 } }) === null,
    'a missing observation yields null, never a guess');
  ok(ruleInjectionBoolean({}) === null);
});

test('evaluateRules reports boolean injection alongside the error-signature rule', () => {
  const result = evaluateRules({
    injectionBoolean: { endpoint: '/api/search', param: 'q',
      baseline: { count: 1 }, alwaysTrue: { count: 5 }, alwaysFalse: { count: 0 } },
  });
  ok((result.candidates ?? []).some((candidate) => candidate.ruleId === 'INJ-BOOLEAN-DIFF'));
});

/* -----------------------------------------------------------------------------------------------
 * 响应头是多值的：规则必须归一，不能把"存在"当"缺失"
 * ---------------------------------------------------------------------------------------------- */

test('VULN-07 headerValue normalizes arrays, strings and junk', () => {
  ok(headerValue({ 'x-a': ['v1', 'v2'] }, 'x-a') === 'v1', 'array takes the first non-empty value');
  ok(headerValue({ 'x-a': ['', 'v2'] }, 'x-a') === 'v2', 'an empty first entry is skipped');
  ok(headerValue({ 'X-A': 'v' }, 'x-a') === 'v', 'lookup is case-insensitive via the raw key');
  ok(headerValue({ 'x-a': [] }, 'x-a') === null, 'an empty array is absent');
  ok(headerValue({ 'x-a': '' }, 'x-a') === null, 'an empty string is absent');
  ok(headerValue({}, 'x-a') === null);
  ok(headerValue(null, 'x-a') === null);
});

test('VULN-07 CORS fires on an array-valued ACAO header (the shape the collector returns)', () => {
  const headers = {
    'access-control-allow-origin': ['http://evil.invalid'],
    'access-control-allow-credentials': ['true'],
  };
  const candidate = ruleCors({ endpoint: '/api/me', headers, origin: 'http://evil.invalid' });
  ok(candidate !== null && candidate.ruleId === 'CORS-CREDENTIALS',
    'a reflected origin with credentials is high severity, not silently ignored');
  ok(candidate.severity === 'high');
});

test('VULN-07 a present-but-array security header is NOT reported missing', () => {
  const result = ruleSecurityHeaders({ url: 'http://a:1', headers: { 'content-security-policy': ['default-src self'] } });
  ok(result !== null);
  ok(!result.evidence.missing.includes('content-security-policy'),
    'a multi-value CSP counts as present (previously it was reported missing)');
  ok(result.evidence.missing.includes('x-frame-options'), 'the genuinely absent ones are still listed');
});
