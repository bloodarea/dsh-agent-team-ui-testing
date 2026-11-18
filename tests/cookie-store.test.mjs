/**
 * cookie-store.test.mjs — U-class unit checks for the FR-11 Cookie Store core (acceptance CRED-01..CRED-10).
 *
 * Pure-module invariants only (no browser, no CDP): origin matching, metadata whitelist, approval
 * binding, controlled-file writing, whole-snapshot failure semantics, import validation and the
 * canary scan. Every check maps to an acceptance row in the security-testing acceptance list.
 */
import { mkdtempSync, readFileSync, rmSync, statSync, existsSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  APPROVALS_FILE, APPROVAL_REQUIRED_FIELDS, COOKIE_ERROR_CODES, COOKIE_MAX_COUNT,
  COOKIE_MAX_VALUE_BYTES, COOKIE_METADATA_FIELDS, buildApprovalQuery, buildExportSnapshot,
  canaryScan, cookieSetParams, exportEntryOf, findApproval, markApprovalConsumed,
  metadataOf, normalizeCookie, originOf, parseCookieImport, publishCookieExport,
  readApprovals, redactCookieValue, resolveCookieExportPath, isSameOrigin,
} from '../cookie-store.js';

const ok = (condition, message) => assert.ok(condition, message);

function tempRoot() {
  return mkdtempSync(join(tmpdir(), 'cookie-store-test-'));
}

function sampleCookie(overrides = {}) {
  return {
    name: 'lab_session', value: 'v3ry-s3cret-session-value-42', domain: '127.0.0.1', path: '/',
    expires: -1, size: 27, httpOnly: true, secure: false, session: true,
    sameSite: 'Lax', priority: 'Medium', sourceScheme: 'NonSecure', sourcePort: 8088,
    ...overrides,
  };
}

function sampleApproval(overrides = {}) {
  return {
    approvalId: 'ap-001', origin: 'http://127.0.0.1:8088', tabId: 'primary',
    workspaceId: null, runtimeId: 'rt-1', allowHttpOnly: true,
    issuedAt: Date.now() - 1000, expiresAt: Date.now() + 60_000,
    ...overrides,
  };
}

/* -----------------------------------------------------------------------------------------------
 * CRED-01 前置：精确 Origin
 * ---------------------------------------------------------------------------------------------- */

test('C01 originOf extracts exact origins and refuses non-HTTP', () => {
  ok(originOf('http://127.0.0.1:8088') === 'http://127.0.0.1:8088');
  ok(originOf('http://app.localhost:8088/x/y?z=1') === 'http://app.localhost:8088');
  ok(originOf('https://example.com:443/a') === 'https://example.com');
  ok(originOf('file:///tmp/x') === null, 'file:// must be refused');
  ok(originOf('about:blank') === null);
  ok(originOf('') === null);
  ok(originOf('not a url') === null);
  ok(originOf(null) === null);
});

test('C01 same-site (different port/protocol) is NOT same-origin', () => {
  ok(isSameOrigin('http://127.0.0.1:8088/a', 'http://127.0.0.1:8088/b') === true);
  ok(isSameOrigin('http://127.0.0.1:8088', 'http://127.0.0.1:9999') === false, 'port mismatch');
  ok(isSameOrigin('http://127.0.0.1:8088', 'https://127.0.0.1:8088') === false, 'protocol mismatch');
  ok(isSameOrigin('http://app.localhost:8088', 'http://evil.localhost:8088') === false, 'host mismatch');
  ok(isSameOrigin('http://127.0.0.1:8088', 'garbage') === false, 'unparsable side fails closed');
});

/* -----------------------------------------------------------------------------------------------
 * CRED-02：metadata 白名单投影，value 结构性排除
 * ---------------------------------------------------------------------------------------------- */

test('CRED-02 metadata projection never contains value or derived value keys', () => {
  const cookie = sampleCookie();
  const view = metadataOf(cookie);
  for (const field of COOKIE_METADATA_FIELDS) {
    ok(field in view === ['name', 'domain', 'path', 'expires', 'size', 'httpOnly', 'secure', 'session', 'sameSite', 'priority', 'sourceScheme', 'sourcePort'].includes(field));
  }
  ok(!('value' in view), 'value must be structurally excluded');
  const serialized = JSON.stringify(view);
  ok(!serialized.includes(cookie.value), 'serialized metadata must not contain the value');
  ok(!serialized.toLowerCase().includes('value'), 'no value key of any form');
});

test('CRED-02 export entry adds value but metadata/redacted views never do', () => {
  const cookie = sampleCookie();
  const entry = exportEntryOf(cookie);
  ok(entry.value === cookie.value, 'export entry carries value (file only)');
  const redacted = redactCookieValue(cookie);
  ok(!('value' in redacted) && redacted.valueLength === cookie.value.length, 'redacted view exposes only length');
  ok(!JSON.stringify(redacted).includes(cookie.value), 'redacted view never leaks value');
});

test('CRED-02 normalizeCookie refuses over-long values and malformed entries', () => {
  ok(normalizeCookie({ name: 'x', value: '' }) !== null, 'empty value is legal');
  ok(normalizeCookie({ name: 'x', value: 'a'.repeat(COOKIE_MAX_VALUE_BYTES + 1) }) === null, 'over-long value refused');
  ok(normalizeCookie({ value: 'v' }) === null, 'missing name refused');
  ok(normalizeCookie({ name: 'x' }) === null, 'missing value refused');
  ok(normalizeCookie('nope') === null, 'non-object refused');
});

/* -----------------------------------------------------------------------------------------------
 * GATE-03 / CRED-03：人类授权记录
 * ---------------------------------------------------------------------------------------------- */

test('GATE-03 approval validates only on exact four-tuple match', () => {
  const approval = sampleApproval();
  const query = buildApprovalQuery({ workspaceId: null, runtimeId: 'rt-1', tabId: 'primary', origin: 'http://127.0.0.1:8088', allowHttpOnly: true });
  ok(validate(approval, query).ok === true);

  ok(validate(approval, { ...query, origin: 'http://127.0.0.1:9999' }).ok === false, 'origin mismatch refused');
  ok(validate(approval, { ...query, runtimeId: 'rt-2' }).ok === false, 'runtime mismatch refused');
  ok(validate(approval, { ...query, tabId: 'other' }).ok === false, 'tab mismatch refused');
  ok(validate(approval, { ...query, workspaceId: 'ws-x' }).ok === false, 'workspace mismatch refused');
});

test('GATE-03 approval windows, revocation and one-shot consumption are enforced', () => {
  const query = buildApprovalQuery({ workspaceId: null, runtimeId: 'rt-1', tabId: 'primary', origin: 'http://127.0.0.1:8088', allowHttpOnly: true });
  ok(validate(sampleApproval({ expiresAt: Date.now() - 1 }), query).code === COOKIE_ERROR_CODES.APPROVAL_EXPIRED, 'expired refused');
  ok(validate(sampleApproval({ issuedAt: Date.now() + 100_000, expiresAt: Date.now() + 200_000 }), query).code === COOKIE_ERROR_CODES.APPROVAL_INVALID, 'not yet valid refused');
  ok(validate(sampleApproval({ revoked: true }), query).code === COOKIE_ERROR_CODES.APPROVAL_INVALID, 'revoked refused');
  ok(validate(sampleApproval({ consumedAt: Date.now() }), query).code === COOKIE_ERROR_CODES.APPROVAL_CONSUMED, 'consumed refused');
  ok(validate(sampleApproval({ issuedAt: 1, expiresAt: 2 }), query).code === COOKIE_ERROR_CODES.APPROVAL_EXPIRED, 'tiny window expires');
  ok(validate({}, query).ok === false, 'missing fields refused');
});

test('GATE-03 HttpOnly needs explicit allowHttpOnly in the approval record', () => {
  const query = buildApprovalQuery({ workspaceId: null, runtimeId: 'rt-1', tabId: 'primary', origin: 'http://127.0.0.1:8088', allowHttpOnly: true });
  const verdict = validate(sampleApproval({ allowHttpOnly: false }), query);
  ok(verdict.ok === false && verdict.code === COOKIE_ERROR_CODES.HTTP_ONLY_FORBIDDEN, 'httpOnly without grant refused');
});

test('GATE-03 Agent confirm strings never participate (not even in the query shape)', () => {
  // buildApprovalQuery has no confirm field by construction; assert it stays that way.
  const query = buildApprovalQuery({ workspaceId: null, runtimeId: 'rt-1', tabId: 'primary', origin: 'http://127.0.0.1:8088', allowHttpOnly: false });
  ok(!('confirm' in query), 'query shape must not carry a confirm field');
  ok(Object.keys(query).length === 5, 'exactly workspaceId/runtimeId/tabId/origin/allowHttpOnly');
});

function validate(approval, query, options) {
  // local import indirection keeps the test table compact
  return validateApprovalImpl(approval, query, options);
}
import { validateApproval as validateApprovalImpl } from '../cookie-store.js';

test('CRED-03 findApproval: fail closed on empty/corrupt lists; ambiguous lists refuse', () => {
  const query = buildApprovalQuery({ workspaceId: null, runtimeId: 'rt-1', tabId: 'primary', origin: 'http://127.0.0.1:8088', allowHttpOnly: true });
  ok(findApproval([], query).ok === false, 'empty list refused');
  ok(findApproval(null, query).ok === false, 'null list refused');
  const approval = sampleApproval();
  ok(findApproval([approval], query).ok === true);
  ok(findApproval([approval, { ...approval, approvalId: 'ap-002' }], query).ok === false, 'ambiguous approvals refused');
});

test('CRED-03 approvals file read is fail-closed and consume marking is atomic', () => {
  const dir = tempRoot();
  try {
    ok(readApprovals(dir).length === 0, 'missing file = zero approvals');
    writeFileSync(join(dir, APPROVALS_FILE), '{broken json', 'utf8');
    ok(readApprovals(dir).length === 0, 'corrupt file = zero approvals (fail closed)');
    writeFileSync(join(dir, APPROVALS_FILE), JSON.stringify({ approvals: [sampleApproval()] }), 'utf8');
    ok(readApprovals(dir).length === 1, 'valid file read');
    const consumed = markApprovalConsumed(dir, 'ap-001');
    ok(consumed.ok === true, 'consume marking succeeds');
    const after = readApprovals(dir);
    ok(after[0].consumedAt !== undefined, 'consumedAt written');
    const again = markApprovalConsumed(dir, 'ap-001');
    ok(again.ok === false, 'double consume refused');
    ok(markApprovalConsumed(dir, 'no-such').ok === false, 'unknown id refused');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

/* -----------------------------------------------------------------------------------------------
 * CRED-05/06/07：受控文件写入
 * ---------------------------------------------------------------------------------------------- */

test('CRED-05 export file is written with POSIX 0600, no-clobber', () => {
  const root = tempRoot();
  try {
    const resolved = resolveCookieExportPath({ root, out: 'output/cookies/snap.json', defaultName: 'output/cookies/auto.json' });
    ok(resolved.ok === true, 'path resolves inside root');
    const published = publishCookieExport(resolved.dir, resolved.absolutePath, Buffer.from('{"kind":"x"}'));
    ok(published.ok === true && published.mode === '0600', 'publish reports 0600');
    const mode = statSync(resolved.absolutePath).mode & 0o777;
    ok(mode === 0o600, 'actual file mode is 0600, got 0' + mode.toString(8));
    const again = publishCookieExport(resolved.dir, resolved.absolutePath, Buffer.from('{"kind":"x"}'));
    ok(again.ok === false && again.code === COOKIE_ERROR_CODES.OUTPUT_EXISTS, 'second write refused (no-clobber)');
    ok(readFileSync(resolved.absolutePath, 'utf8') === '{"kind":"x"}', 'first content intact');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('CRED-06 path traversal escapes are refused', () => {
  const root = tempRoot();
  try {
    const cases = [
      'output/../escape.json',
      '..',
      '/etc/passwd.json',
      'C:/x.json',
      'output/x/../../escape.json',
      '.hidden/../up.json',
      'a\\b.json',
      'out\0put/x.json',
      '',
    ];
    for (const out of cases) {
      const resolved = resolveCookieExportPath({ root, out, defaultName: null });
      ok(resolved.ok === false, 'refused: ' + JSON.stringify(out));
    }
    const wrongExt = resolveCookieExportPath({ root, out: 'output/cookies/snap.txt', defaultName: null });
    ok(wrongExt.ok === false, 'non-.json extension refused');
    const okCase = resolveCookieExportPath({ root, out: undefined, defaultName: 'output/cookies/auto.json' });
    ok(okCase.ok === true, 'default name allowed');
    ok(okCase.absolutePath.startsWith(root), 'stays inside root');
    ok(!existsSync(okCase.absolutePath), 'resolve alone creates no file');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

/* -----------------------------------------------------------------------------------------------
 * CRED-07：整批失败语义
 * ---------------------------------------------------------------------------------------------- */

test('CRED-07 snapshot build fails whole on any over-long entry (no truncation)', () => {
  const cookies = [sampleCookie(), sampleCookie({ name: 'big', value: 'v'.repeat(COOKIE_MAX_VALUE_BYTES + 1) })];
  const built = buildExportSnapshot(cookies, { scope: {}, approvalId: 'ap-001', includeHttpOnly: true });
  ok(built.ok === false && built.code === COOKIE_ERROR_CODES.QUOTA_EXCEEDED, 'whole export refused');
  ok(!('snapshot' in built) && !('bytes' in built), 'no partial snapshot is produced');
});

test('CRED-07 snapshot build fails whole on an unauthorized HttpOnly entry', () => {
  const built = buildExportSnapshot([sampleCookie()], { scope: {}, approvalId: 'ap-001', includeHttpOnly: false });
  ok(built.ok === false && built.code === COOKIE_ERROR_CODES.HTTP_ONLY_FORBIDDEN, 'HttpOnly without grant refused whole');
});

test('CRED-07 count budget: over COOKIE_MAX_COUNT fails whole', () => {
  const cookies = Array.from({ length: COOKIE_MAX_COUNT + 1 }, (_, index) => sampleCookie({ name: 'c' + index, value: 'v', httpOnly: false }));
  const built = buildExportSnapshot(cookies, { scope: {}, approvalId: 'ap-001', includeHttpOnly: false });
  ok(built.ok === false && built.code === COOKIE_ERROR_CODES.QUOTA_EXCEEDED, 'over-count refused whole');
});

test('CRED-07 valid snapshot carries scope/approval/counts and zero canary hits in metadata', () => {
  const cookies = [sampleCookie({ httpOnly: false }), sampleCookie({ name: 'lab_hint', value: 'hint-plain-value-ok', httpOnly: false })];
  const built = buildExportSnapshot(cookies, { scope: { origin: 'http://127.0.0.1:8088', workspaceId: null, runtimeId: 'rt-1', tabId: 'primary' }, approvalId: 'ap-001', includeHttpOnly: false });
  ok(built.ok === true, 'build succeeds');
  const snapshot = built.snapshot;
  ok(snapshot.kind === 'dsh-ui-testing-cookie-export' && snapshot.version === 1);
  ok(snapshot.counts.total === 2 && snapshot.counts.httpOnly === 0);
  ok(snapshot.approval.approvalId === 'ap-001' && snapshot.approval.oneShot === true);
  for (const entry of snapshot.cookies) {
    ok(typeof entry.value === 'string', 'file entries carry value (file only)');
  }
});

/* -----------------------------------------------------------------------------------------------
 * 导入（回填）
 * ---------------------------------------------------------------------------------------------- */

test('CRED-04 import validation: kind/version/shape checked; HttpOnly needs explicit opt-in', () => {
  const good = { kind: 'dsh-ui-testing-cookie-export', version: 1, cookies: [sampleCookie({ httpOnly: false })], scope: {}, exportedAt: 1 };
  const parsed = parseCookieImport(JSON.stringify(good));
  ok(parsed.ok === true && parsed.counts.total === 1 && parsed.counts.httpOnly === 0, 'plain import ok');
  const withHttpOnly = { ...good, cookies: [sampleCookie()] };
  const refused = parseCookieImport(JSON.stringify(withHttpOnly), { importHttpOnly: false });
  ok(refused.ok === false && refused.code === COOKIE_ERROR_CODES.HTTP_ONLY_FORBIDDEN, 'HttpOnly import without opt-in refused');
  const allowed = parseCookieImport(JSON.stringify(withHttpOnly), { importHttpOnly: true });
  ok(allowed.ok === true && allowed.counts.httpOnly === 1, 'HttpOnly import with opt-in ok');
  ok(parseCookieImport('not json').ok === false, 'invalid JSON refused');
  ok(parseCookieImport(JSON.stringify({ kind: 'other', version: 1, cookies: [] })).ok === false, 'kind mismatch refused');
  ok(parseCookieImport(JSON.stringify({ ...good, version: 99 })).ok === false, 'version mismatch refused');
  ok(parseCookieImport(JSON.stringify({ ...good, cookies: 'no' })).ok === false, 'cookies not array refused');
  ok(parseCookieImport(JSON.stringify({ ...good, cookies: [{ name: 'x' }] })).ok === false, 'entry without value refused');
});

test('CRED-04 cookieSetParams produce per-entry CDP args with url pinned to origin', () => {
  const cookies = [
    sampleCookie({ httpOnly: false, expires: 1700000000 }),
    sampleCookie({ name: 'hint', httpOnly: false, expires: -1, sameSite: 'no_restriction' }),
  ];
  const params = cookieSetParams(cookies, { url: 'http://127.0.0.1:8088' });
  ok(params.length === 2, 'one param per cookie');
  for (const entry of params) ok(entry.url === 'http://127.0.0.1:8088', 'each entry pinned to exact origin');
  ok(params[0].expires === 1700000000, 'persistent cookie carries expires');
  ok(!('expires' in params[1]), 'session cookie has no expires');
  ok(params[0].httpOnly === false && params[1].sameSite === 'no_restriction', 'flags carried');
});

/* -----------------------------------------------------------------------------------------------
 * CRED-08：canary 扫描
 * ---------------------------------------------------------------------------------------------- */

test('CRED-08 canaryScan detects value and name leaks; silence on clean payloads', () => {
  const cookies = [sampleCookie(), sampleCookie({ name: 'lab_hint', value: 'plain-hint-value-123', httpOnly: false })];
  ok(canaryScan({ note: 'all clean' }, cookies) === null, 'clean payload: no hits');
  const valueHit = canaryScan({ leaked: 'x' + cookies[0].value + 'y' }, cookies);
  ok(valueHit !== null && valueHit.hits[0].kind === 'value' && valueHit.hits[0].name === 'lab_session', 'value leak detected');
  const nameHit = canaryScan({ text: 'cookie lab_hint was set' }, cookies);
  ok(nameHit !== null && nameHit.hits[0].kind === 'name', 'name leak detected');
  ok(canaryScan(null, cookies) === null && canaryScan('x', []) === null, 'degenerate inputs are silent');
});

/* -----------------------------------------------------------------------------------------------
 * 错误码契约（REG-04：category/retryable 一致）
 * ---------------------------------------------------------------------------------------------- */

test('REG-04 every COOKIE_* code appears in the browser-safety taxonomy with a category', async () => {
  const safety = await import('../browser-safety.js');
  for (const code of Object.values(COOKIE_ERROR_CODES)) {
    ok(Object.hasOwn(safety.ERROR_TAXONOMY, code), 'taxonomy entry exists for ' + code);
    const error = new safety.BrowserError(code, 'probe');
    ok(typeof error.category === 'string' && error.category.length > 0, 'category resolves for ' + code);
    ok(typeof error.retryable === 'boolean', 'retryable resolves for ' + code);
    ok(!error.message.includes('secret-value'), 'message redaction keeps working');
  }
});
