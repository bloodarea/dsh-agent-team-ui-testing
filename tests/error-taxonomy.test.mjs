/**
 * Error taxonomy coverage (browser-safety.js).
 *
 * Every code a tool actually throws must be registered, otherwise `BrowserError` falls back to
 * `internal/false` and callers that branch on `category` / `retryable` silently misjudge (a
 * retryable `scope` refusal looks like a bug, an `authorization` refusal looks like a crash).
 * The contract codes live in docs/multi-tab.md, docs/t4-dynamic-behavior.md and
 * docs/network-p0.md; this test makes the literal throws in the source the source of truth.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { ERROR_TAXONOMY } from '../browser-safety.js';

const SOURCES = [
  'index.js', 'client.js', 'browser-safety.js', 'capture-p0.js', 'vision-t3.js',
  'vision-baseline.js', 'network-p0.js', 'dynamic-t4.js', 'frame-source.js', 'frame-push.js',
];

/** Literal `new BrowserError('CODE' …)` throws; dynamic code variables are out of scope. */
function literalCodes() {
  const codes = new Map();
  for (const file of SOURCES) {
    const source = readFileSync(new URL(`../${file}`, import.meta.url), 'utf8');
    for (const match of source.matchAll(/new BrowserError\(\s*'([A-Z][A-Z0-9_]*)'/g)) {
      if (!codes.has(match[1])) codes.set(match[1], []);
      codes.get(match[1]).push(file);
    }
  }
  return codes;
}

test('every literal BrowserError code is registered in the taxonomy', () => {
  const missing = [...literalCodes().keys()].filter((code) => !(code in ERROR_TAXONOMY));
  assert.deepEqual(missing, [], `unregistered codes: ${missing.join(', ')}`);
});

test('a literal throw never falls back to the internal category', () => {
  const offenders = [];
  for (const [code] of literalCodes()) {
    const entry = ERROR_TAXONOMY[code];
    if (!entry) continue;
    const [category] = entry;
    if (code !== 'INTERNAL' && category === 'internal') offenders.push(code);
  }
  assert.deepEqual(offenders, [], `codes classified as internal: ${offenders.join(', ')}`);
});

test('taxonomy entries are [category, retryable] pairs', () => {
  for (const [code, entry] of Object.entries(ERROR_TAXONOMY)) {
    assert.equal(Array.isArray(entry), true, code);
    assert.equal(entry.length, 2, code);
    assert.equal(typeof entry[0], 'string', code);
    assert.equal(typeof entry[1], 'boolean', code);
  }
});

test('page-group and dynamic codes keep their documented classification', () => {
  // docs/multi-tab.md: TAB_NOT_FOUND / TAB_FORBIDDEN / TAB_LIMIT + popup adoption.
  assert.deepEqual(ERROR_TAXONOMY.TAB_NOT_FOUND, ['scope', false]);
  assert.deepEqual(ERROR_TAXONOMY.TAB_FORBIDDEN, ['authorization', false]);
  assert.deepEqual(ERROR_TAXONOMY.TAB_LIMIT, ['resource', false]);
  assert.deepEqual(ERROR_TAXONOMY.POPUP_UNSUPPORTED, ['capability', false]);
  // docs/t4-dynamic-behavior.md §extend: stopped/retained session, a new start may recover.
  assert.deepEqual(ERROR_TAXONOMY.DYNAMIC_SESSION_NOT_ACTIVE, ['scope', true]);
});
