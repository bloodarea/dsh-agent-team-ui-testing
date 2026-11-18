/**
 * business-logic.test.mjs — FR-08 业务逻辑纯核心（BIZ-01..05）。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  BIZ_INVARIANTS, checkClientTrust, checkCouponReuse, checkDuplicateSubmission,
  checkQuantityBoundaries, checkStateTransition, evaluateBusinessLogic, reproducibility,
} from '../business-logic.js';

const ok = (condition, message) => assert.ok(condition, message);

/* ----------------------------------------------------------------------------------------------- */

test('BIZ-01 negative quantity making the cart negative is a high finding', () => {
  const candidate = checkQuantityBoundaries([{
    input: { qty: -5 }, accepted: true,
    cartState: { items: [{ qty: -3, name: 'Desk Lamp', price: 29.9 }], subtotal: -89.7, total: -89.7 },
  }]);
  ok(candidate !== null && candidate.ruleId === 'BIZ-QTY-BOUNDARY');
  ok(candidate.severity === 'high', 'negative money escalates to high');
  ok(candidate.evidence.violations[0].negativeMoney.length === 2);
});

test('BIZ-01 quantities above the cap are a medium finding; normal carts are clean', () => {
  const over = checkQuantityBoundaries([{
    input: { qty: 100000 }, accepted: true,
    cartState: { items: [{ qty: 100000, price: 1 }], subtotal: 100000, total: 100000 },
  }]);
  ok(over !== null && over.severity === 'medium' && over.evidence.violations[0].tooLargeQty.length === 1);
  const normal = checkQuantityBoundaries([{
    input: { qty: 2 }, accepted: true,
    cartState: { items: [{ qty: 2, price: 29.9 }], subtotal: 59.8, total: 59.8 },
  }]);
  ok(normal === null, 'a valid cart produces no finding');
  ok(BIZ_INVARIANTS.minQty === 0 && BIZ_INVARIANTS.maxQty === 999);
});

test('BIZ-02 repeated coupon application with accumulating discount is flagged', () => {
  const candidate = checkCouponReuse([
    { code: 'WELCOME10', ok: true, discount: 10 },
    { code: 'WELCOME10', ok: true, discount: 20 },
  ]);
  ok(candidate !== null && candidate.ruleId === 'BIZ-COUPON-REUSE' && candidate.severity === 'high');
  ok(candidate.evidence.offenders[0].accumulated === true, 'accumulation detected');
});

test('BIZ-02 a rejected second application is NOT a finding', () => {
  const clean = checkCouponReuse([
    { code: 'WELCOME10', ok: true, discount: 10 },
    { code: 'WELCOME10', ok: false, discount: 10 },
  ]);
  ok(clean === null, 'rejecting the repeat is correct behaviour');
  ok(checkCouponReuse([{ code: 'WELCOME10', ok: true, discount: 10 }]) === null, 'single use is fine');
});

test('BIZ-03 server following the client amount is critical', () => {
  const candidate = checkClientTrust({ submittedTotal: 0.01, serverTotal: 0.01, expectedServerTotal: 89.7 });
  ok(candidate !== null && candidate.ruleId === 'BIZ-CLIENT-TRUST' && candidate.severity === 'critical');
  ok(candidate.basis === 'differential');
  ok(checkClientTrust({ submittedTotal: 0.01, serverTotal: 89.7, expectedServerTotal: 89.7 }) === null,
    'recomputing on the server is correct behaviour');
  ok(checkClientTrust({ submittedTotal: 10, serverTotal: 10 }) === null,
    'without an expected value there is nothing to compare against');
});

test('BIZ-04 duplicate submission creating multiple resources is flagged', () => {
  const candidate = checkDuplicateSubmission([
    { ok: true, createdId: 101 }, { ok: true, createdId: 102 },
  ]);
  ok(candidate !== null && candidate.ruleId === 'BIZ-DUPLICATE-SUBMIT');
  ok(candidate.evidence.createdIds.length === 2);
  ok(checkDuplicateSubmission([{ ok: true, createdId: 101 }, { ok: true, createdId: 101 }]) === null,
    'idempotent repeat (same id) is correct');
});

test('BIZ-04 illegal state transitions are flagged; legal ones are not', () => {
  const illegal = checkStateTransition([
    { from: 'cancelled', to: 'paid', accepted: true },
    { from: 'new', to: 'paid', accepted: true },
  ]);
  ok(illegal !== null && illegal.ruleId === 'BIZ-STATE-TRANSITION');
  ok(illegal.evidence.illegal.length === 1 && illegal.evidence.illegal[0].to === 'paid');
  ok(checkStateTransition([{ from: 'cancelled', to: 'paid', accepted: false }]) === null,
    'a refused transition is correct behaviour');
  const withMap = checkStateTransition(
    [{ from: 'new', to: 'cancelled', accepted: true }],
    { allowedTransitions: [{ from: 'new', to: 'paid' }] },
  );
  ok(withMap !== null, 'a declared business map is enforced strictly');
});

test('BIZ-05 reproducibility requires 2 real reproductions', () => {
  ok(reproducibility({ attempts: [{ reproduced: true }] }).repeatable === false, 'one attempt is not repeatable');
  const two = reproducibility({ attempts: [{ reproduced: true }, { reproduced: true }, { reproduced: false }] });
  ok(two.repeatable === true && two.reproduced === 2 && two.attempts === 3);
  ok(two.rate === 2 / 3);
  ok(reproducibility({}).rate === null, 'no attempts = null rate');
});

test('evaluateBusinessLogic runs only supplied facts and reports confirmability', () => {
  const result = evaluateBusinessLogic({
    quantityBoundaries: [{
      input: { qty: -5 }, accepted: true,
      cartState: { items: [{ qty: -3 }], subtotal: -89.7, total: -89.7 },
    }],
    couponReuse: [{ code: 'W', ok: true, discount: 10 }, { code: 'W', ok: true, discount: 20 }],
    reproducibility: { attempts: [{ reproduced: true }, { reproduced: true }] },
  });
  ok(result.candidates.length === 2);
  ok(result.reproducibility.repeatable === true);
  ok(result.confirmable.length === 2, 'both candidates are confirmable with repeatability');
  ok(result.candidates.every((candidate) => candidate.category === 'business-logic'));
});

test('evaluateBusinessLogic with no facts yields nothing (no false positives)', () => {
  const empty = evaluateBusinessLogic({});
  ok(empty.candidates.length === 0 && empty.evaluated === 0);
  ok(empty.reproducibility === null);
});

test('evaluateBusinessLogic marks candidates non-confirmable without repeatability', () => {
  const result = evaluateBusinessLogic({
    couponReuse: [{ code: 'W', ok: true, discount: 10 }, { code: 'W', ok: true, discount: 20 }],
    reproducibility: { attempts: [{ reproduced: true }] },
  });
  ok(result.candidates.length === 1);
  ok(result.confirmable.length === 0, 'a single attempt cannot confirm a business finding (BIZ-05)');
});
