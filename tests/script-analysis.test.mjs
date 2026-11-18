/**
 * script-analysis.test.mjs — FR-03/FR-04 JS 静态分析纯核心（JS-01..JS-08）。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  SCRIPT_LIMITS, analyzeScript, buildScriptInventory, classifyScriptSource,
  decodeBase64, decodeHex, decodeStringCandidate, decodeUnicodeEscapes,
  detectArrayRotation, extractStringTables, findSourceToSink, formatScript,
  normalizeScriptDescriptor, scriptMapStatus,
} from '../script-analysis.js';

const ok = (condition, message) => assert.ok(condition, message);

const b64 = (s) => Buffer.from(s, 'utf8').toString('base64');

/* ----------------------------------------------------------------------------------------------- */

test('JS-01 normalizeScriptDescriptor + source classification', () => {
  const inline = normalizeScriptDescriptor({ scriptId: '1', url: '', length: 100 });
  ok(inline.source === 'inline' && inline.scriptId === '1');
  const external = normalizeScriptDescriptor({ scriptId: '2', url: 'https://a/x.js', length: 50 });
  ok(external.source === 'external');
  const dynamic = normalizeScriptDescriptor({ scriptId: '3', url: 'blob:https://a/uuid' });
  ok(dynamic.source === 'dynamic');
  ok(classifyScriptSource({ url: 'data:text/js,1' }) === 'dynamic');
  ok(classifyScriptSource({ url: 'https://a/w.js', auxData: { type: 'worker' } }) === 'external', 'http URL wins first');
  ok(normalizeScriptDescriptor({ url: 'no-id' }) === null, 'scriptId required');
});

test('JS-01 buildScriptInventory dedupes by URL and reports bySource', () => {
  const inventory = buildScriptInventory([
    normalizeScriptDescriptor({ scriptId: '1', url: 'https://a/x.js', length: 10 }),
    normalizeScriptDescriptor({ scriptId: '2', url: 'https://a/x.js', length: 10 }),
    normalizeScriptDescriptor({ scriptId: '3', url: '', length: 5 }),
    normalizeScriptDescriptor({ scriptId: '4', url: 'https://a/y.js', length: 8, sourceMapURL: 'https://a/y.js.map' }),
  ]);
  ok(inventory.counts.scripts === 3, 'two entries for one URL collapse');
  ok(inventory.counts.withSourceMap === 1);
  const x = inventory.scripts.find((s) => s.url === 'https://a/x.js');
  ok(x.occurrences === 2 && x.scriptIds.length === 2, 'reload occurrences recorded');
  ok(inventory.counts.bySource.external === 2 && inventory.counts.bySource.inline === 1);
});

test('JS-03 scriptMapStatus: absent / present-unverified / accessible / inaccessible', () => {
  ok(scriptMapStatus({ sourceMapUrl: null }).status === 'absent');
  ok(scriptMapStatus({ sourceMapUrl: 'x.map' }).status === 'present-unverified', 'presence is not reachability');
  ok(scriptMapStatus({ sourceMapUrl: 'x.map' }, { fetched: { ok: true, bytes: 10 } }).status === 'accessible');
  ok(scriptMapStatus({ sourceMapUrl: 'x.map' }, { fetched: { ok: false, reason: '404' } }).status === 'inaccessible');
});

test('JS-02 formatScript keeps a precise original line map and flags non-original', () => {
  const source = 'var a=1;var b=2;\nfunction f(){return a+b;}';
  const formatted = formatScript(source);
  ok(formatted.ok === true && formatted.isOriginalSource === false, 'must declare it is not the original');
  ok(formatted.text.includes('var a=1;'));
  ok(formatted.lineMap.length === formatted.text.split('\n').length, 'one map entry per formatted line');
  // The map points back into the original: line 0 for the first lines, line 1 for the function.
  const functionLine = formatted.text.split('\n').findIndex((line) => line.includes('function f()'));
  ok(functionLine >= 0 && formatted.lineMap[functionLine].line === 1, 'function maps to original line 1');
  ok(formatScript('') .ok === false, 'empty refused');
});

test('JS-04 decode primitives are deterministic and refuse uncertainty', () => {
  ok(decodeBase64(b64('/api/login')) === '/api/login');
  ok(decodeBase64('not-base64!!') === null);
  ok(decodeHex('2f617069') === '/api');
  ok(decodeHex('abc') === null, 'odd hex refused');
  ok(decodeUnicodeEscapes('\\u002fapi') === '/api');
  ok(decodeUnicodeEscapes('plain') === null, 'nothing to decode = null, not the same string');
  // binary garbage must not decode as base64 text
  ok(decodeBase64(Buffer.from([0, 1, 2, 3]).toString('base64')) === null);
});

test('JS-04 decodeStringCandidate labels decoded/plain/unknown without faking', () => {
  ok(decodeStringCandidate(b64('/api/login')).status === 'decoded');
  ok(decodeStringCandidate(b64('/api/login')).method === 'base64');
  ok(decodeStringCandidate('/api/plain').status === 'plain', 'readable text is plain, not "restored"');
  ok(decodeStringCandidate('\u0001\u0002').status === 'unknown');
  ok(decodeStringCandidate('').status === 'unknown');
});

test('JS-04 extractStringTables finds the obfuscated table and decodes entries', () => {
  const source = `const _0x5a=['${b64('/api/login')}','${b64('/api/products')}','plainPath'];`;
  const tables = extractStringTables(source);
  ok(tables.length === 1 && tables[0].name === '_0x5a' && tables[0].count === 3);
  ok(tables[0].decoded[0].value === '/api/login' && tables[0].decoded[0].method === 'base64');
  ok(tables[0].decoded[2].status === 'plain');
});

test('JS-04 detectArrayRotation reports patterns without executing anything', () => {
  const rotating = 'const _0x=[a,b];(function(){while(true){try{_0x.push(_0x.shift());break}catch(e){}}})();';
  const result = detectArrayRotation(rotating);
  ok(result.detected === true && result.patterns.shiftPushLoop === true);
  ok(detectArrayRotation('const x=1;').detected === false);
});

test('JS-07 findSourceToSink locates sinks with conservative confidence', () => {
  const source = [
    'const q = location.search;',
    'document.getElementById("o").innerHTML = q;',
    'eval("1");',
    'document.write("<b>x</b>");',
  ].join('\n');
  const { findings } = findSourceToSink(source);
  const innerHTML = findings.find((f) => f.sink === 'innerHTML');
  ok(innerHTML !== undefined && innerHTML.confidence === 'medium', 'source 1 line above = medium');
  const evalFinding = findings.find((f) => f.sink === 'eval');
  ok(evalFinding !== undefined && evalFinding.confidence === 'medium', 'nearby source = medium');
  ok(findings.every((f) => f.evidence === 'static-pattern'), 'static evidence only');
});

test('JS-07 same-line source+sink is high confidence; sink-only is low', () => {
  const high = findSourceToSink('el.innerHTML = location.hash;').findings[0];
  ok(high.confidence === 'high' && high.source === 'location');
  const low = findSourceToSink('\n\n\n\n\n\n\n\n\n\n\n\n\n\n\n\n\n\n\n\n\n\n\n\n\n\n\n\n\n\n\n\n\n\n\n\n\n\n\n\n\n\nel.innerHTML = x;').findings[0];
  ok(low.confidence === 'low' && low.source === null, 'no source found = low, never claimed exploitable');
});

test('JS-08 analyzeScript summarizes and compares against runtime values', () => {
  const source = `const _0x5a=['${b64('/api/login')}'];\nel.innerHTML = location.hash;`;
  const report = analyzeScript({
    descriptor: { scriptId: '1', url: 'https://a/app.js', source: 'external' },
    source,
    runtime: { discoveredPath: '/api/login' },
  });
  ok(report.counts.stringTables === 1 && report.counts.decoded === 1);
  ok(report.counts.sinks >= 1);
  ok(report.consistency.total === 1 && report.consistency.consistent === 1, 'static value matches runtime');
  ok(report.consistency.rate === 1);
});

test('JS-08 analyzeScript admits unknown entries instead of fabricating', () => {
  const source = `const t=['\u0001\u0002'];`;
  const report = analyzeScript({ source });
  ok(report.counts.unknown >= 1);
  ok(report.limitations.some((line) => line.includes('unknown')), 'limitation states the unknown count');
});

test('JS-02 budget: over-large source refused, not silently truncated', () => {
  const huge = 'a'.repeat(SCRIPT_LIMITS.maxSourceBytes + 1);
  const result = formatScript(huge);
  ok(result.ok === false && result.reason === 'source-too-large');
});
