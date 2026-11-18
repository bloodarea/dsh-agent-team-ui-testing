/**
 * identity.test.mjs — FR-07 多身份隔离纯核心（AUTH-01/02/03/04）。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  accessContrast, assertIsolation, leakageCheck, logoutCleanup, normalizeIdentity,
  privilegeContrast, serverSideAuthorization, switchRecord,
} from '../identity.js';

const ok = (condition, message) => assert.ok(condition, message);

const cookie = (name, domain = '127.0.0.1', path = '/') => ({ name, domain, path, httpOnly: true, sameSite: 'Lax' });

test('AUTH-01 normalizeIdentity: shape enforced, junk refused', () => {
  ok(normalizeIdentity({ name: 'alice', role: 'user' }).name === 'alice');
  ok(normalizeIdentity({ name: '  bob ' }).name === 'bob', 'trimmed');
  ok(normalizeIdentity({}) === null, 'no name refused');
  ok(normalizeIdentity(null) === null);
  ok(normalizeIdentity({ name: 'x'.repeat(65) }) === null, 'name too long refused');
});

test('AUTH-01 assertIsolation partitions cookie keys into aOnly/bOnly/shared', () => {
  const a = [cookie('lab_session'), cookie('common_hint')];
  const b = [cookie('bob_session'), cookie('common_hint')];
  const result = assertIsolation(a, b);
  ok(result.aOnly.includes('lab_session|127.0.0.1|/'));
  ok(result.bOnly.includes('bob_session|127.0.0.1|/'));
  ok(result.shared.includes('common_hint|127.0.0.1|/'));
  ok(result.isolated === true && result.leakage.length === 0);
});

test('AUTH-01 leakageCheck: login cookie appearing in the other identity is leakage', () => {
  const loginKeys = ['lab_session'];
  ok(leakageCheck(loginKeys, [cookie('lab_hint')]).isolated === true, 'no leak when absent');
  const leak = leakageCheck(loginKeys, [cookie('lab_session')]);
  ok(leak.isolated === false && leak.count === 1 && leak.leaked[0] === 'lab_session', 'leak detected');
});

test('AUTH-02 switchRecord: initial vs switch, actor and time recorded', () => {
  const initial = switchRecord({ to: 'alice', actor: 'agent-1', at: 1000 });
  ok(initial.kind === 'initial' && initial.to === 'alice' && initial.at === 1000);
  const sw = switchRecord({ from: 'alice', to: 'admin', actor: 'agent-1', runtimeId: 'rt-2', at: 2000 });
  ok(sw.kind === 'switch' && sw.from === 'alice' && sw.runtimeId === 'rt-2');
});

test('AUTH-03 accessContrast: normalizes both observations and flags sameStatus', () => {
  const result = accessContrast({
    objectKey: 'order/42',
    asA: { status: 200, ok: true },
    asB: { status: 403, ok: false },
  });
  ok(result.sameStatus === false && result.asA.status === 200 && result.asB.status === 403);
  const same = accessContrast({ objectKey: 'x', asA: { status: 404 }, asB: { status: 404 } });
  ok(same.sameStatus === true);
});

test('AUTH-04 privilegeContrast: user vs admin on an admin endpoint', () => {
  const result = privilegeContrast({
    endpoint: '/api/admin/reports',
    asUser: { status: 403 },
    asAdmin: { status: 200 },
  });
  ok(result.endpoint === '/api/admin/reports' && result.asUser.status === 403 && result.asAdmin.status === 200);
  ok(result.sameStatus === false);
});

/* ----------------------------------------------------------------------------------------------- *
 * AUTH-05 / AUTH-06
 * ----------------------------------------------------------------------------------------------- */

test('AUTH-05 UI visibility alone can never decide authorization', () => {
  const uiOnly = serverSideAuthorization({ endpoint: '/api/admin/users', uiVisibleAs: false, uiVisibleAsOther: true });
  ok(uiOnly.decided === false, 'UI-only evidence is undetermined');
  ok(uiOnly.uiOnly === true && uiOnly.basis === 'ui-only');
  ok(uiOnly.note.includes('不构成授权'), 'the note explains why hiding a button is not evidence');
  const nothing = serverSideAuthorization({ endpoint: '/x' });
  ok(nothing.decided === false && nothing.basis === 'no-evidence');
});

test('AUTH-05 server-side status decides: deny = authorized, both 2xx = missing authorization', () => {
  const correct = serverSideAuthorization({ endpoint: '/api/admin', serverStatusAs: 200, serverStatusAsOther: 403 });
  ok(correct.decided === true && correct.verdict === 'authorized');
  const missing = serverSideAuthorization({ endpoint: '/api/admin', serverStatusAs: 200, serverStatusAsOther: 200 });
  ok(missing.decided === true && missing.verdict === 'missing-authorization');
  ok(missing.note.includes('隐藏按钮'), 'it names the UI-hiding trap explicitly');
  const weird = serverSideAuthorization({ endpoint: '/x', serverStatusAs: 200, serverStatusAsOther: 500 });
  ok(weird.decided === false && weird.verdict === 'undetermined');
});

test('AUTH-06 logout cleanup: zero successful reuse is the only pass', () => {
  const clean = logoutCleanup({ logoutStatus: 200, attempts: [{ status: 401 }, { status: 403 }] });
  ok(clean.clean === true && clean.reuseSucceeded === 0);
  const broken = logoutCleanup({ logoutStatus: 200, attempts: [{ status: 401 }, { status: 200 }] });
  ok(broken.clean === false && broken.reuseSucceeded === 1, 'one successful reuse fails the check');
  const unmeasured = logoutCleanup({ logoutStatus: 200, attempts: [] });
  ok(unmeasured.clean === false, 'no attempts = cannot claim cleaned');
  ok(unmeasured.note.includes('不得判定'), 'the note refuses to overclaim');
});
