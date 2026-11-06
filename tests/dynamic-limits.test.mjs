/**
 * T4 limits must not drift (docs/t4-dynamic-behavior.md).
 *
 * `dynamic-t4.js` owns the frozen `T4_LIMITS` used by the frame store and analyses. The Host keeps
 * its own copy because it is imported lazily (first T4 call), but `browser_capabilities.limits.dynamic`
 * reports the Host copy — if the two ever disagree, the declared budgets and the enforced ones stop
 * matching. This test makes the copies one contract.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { DYNAMIC_LIMITS } from '../index.js';
import { T4_LIMITS } from '../dynamic-t4.js';

test('the Host copy of T4 limits equals the dynamic-t4 module contract', () => {
  assert.deepEqual(DYNAMIC_LIMITS, T4_LIMITS);
});

test('the limit projection keeps its documented keys', () => {
  for (const key of [
    'maxActiveSessions', 'retainedSessions', 'durationMs', 'durationMsHard', 'maxFrames',
    'maxBytes', 'maxFramePixels', 'maxFrameBytes', 'maxEvents', 'algorithmBudgetMs',
    'maxSessionExtendMs', 'sessionCapMs', 'maxImagesPerObserve', 'maxAssertions',
  ]) {
    assert.ok(Object.prototype.hasOwnProperty.call(DYNAMIC_LIMITS, key), `missing ${key}`);
  }
});
