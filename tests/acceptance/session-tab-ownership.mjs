#!/usr/bin/env node
/**
 * G1 reproduction / G2 fix-verification runner — primary/child cross-session tab takeover.
 *
 * WHAT THIS FILE IS
 *   The executable form of the plan's §11.6 attack protocol against the *frozen working-tree
 *   baseline* (HEAD 4667044 + the user's existing dirty files). It loads the real plugin entry
 *   (index.js) through tests/acceptance/harness.mjs, starts the plugin's own headless Chromium and
 *   drives only the registered agent tools — no CDP shim, no owner injection, no permission
 *   removal, no lease manipulation.
 *
 *   It is both the G1 defect-reproduction runner and the G2 fix-verification runner for the SAME
 *   attack protocol: identical tool calls, identical order, identical real 16 s idles. Only the
 *   expectations are swapped, and the phase is chosen on the command line, never inferred from the
 *   result (§11.4: G1 "pass" = BUG_REPRODUCED, G2 "pass" = FIX_VERIFIED; the two are never mixed).
 *
 * PHASES (must be chosen explicitly, never inferred from the outcome)
 *   --phase=reproduce     run P1 + P2 against the frozen baseline; exit 0 only on BUG_REPRODUCED
 *                         (reproductionVerified:true, fixedVerified:false)
 *   --phase=verify-fixed  run the SAME protocol against whatever code is loaded and judge it by the
 *                         §11.6 post-fix requirements; exit 0 only on FIX_VERIFIED
 *                         (fixedVerified:true, reproductionVerified:false), otherwise NOT_FIXED
 *
 * SCENARIOS (§11.6, each in its own clean harness + own fixture server)
 *   P1  two independent roots contend for the same primary: A navigates and writes a random
 *       document nonce, B's first attempt is either refused (baseline: BUSY) or given its own page
 *       (post-fix), then after a real 16 s idle B navigates again. The baseline reuses A's runtime
 *       and destroys A's document, and A is then refused on its own page. Fix-side probes: A's
 *       document/ownership must survive, and B must not see or address A's tab.
 *   P2  the user's direction: B (blocked on the shared primary) opens a child and works in it;
 *       A keeps using its own page; then A is handed B's real child tabId as a known attack
 *       target at two time points (inside the lease and after a real 16 s idle). The baseline lets
 *       A select, read, navigate and CLOSE B's child after the lapse, and B is then blocked on its
 *       own tab. Fix-side probes: every one of those attempts must be refused with zero fixture
 *       dispatch and B's document left intact.
 *
 * STRONG OWNERSHIP EVIDENCE (M2a fields)
 *   P1-3b  after the idle window A's tab row must still carry ownerSessionId/controllerSessionId/
 *          rootSessionId === A with ownershipRevision and controlRevision unchanged. A missing
 *          field fails the check and is also listed as an explicit NOT_RUN — never a soft pass.
 *   P1-7   three rounds of cross-root observation (list + state) must leave every ownership field,
 *          including the controller, exactly as it was: reading never becomes write rights.
 *   P2-6   close / navigate / eval against B's known tab id are each judged separately, with the
 *          fixture request count as dispatch proof and B's own page compared byte-for-byte
 *          (url/title/nonce/form/counters/scroll/visibility/documentLength) before and after.
 *
 * HONESTY RULES BAKED IN (plan §11.5/§11.6/§11.8)
 *   - Identities: two distinct agent ids in the SAME registered workspace; the run fails as
 *     invalid if `scope.kind !== 'workspace'` or `scope.degraded !== false`.
 *   - Waits: real, monotonic, uncut 16000 ms. A run whose measured idle is < 15000 ms is marked
 *     invalid and can never be signed off.
 *   - Nonces: random per run, written to page memory only (`window.__g1Nonce`), never localStorage.
 *   - Dispatch evidence: the fixture HTTP server logs every request it actually serves, so "a
 *     navigation really happened" is proven by the target, not by a tool return value alone.
 *   - Fields the baseline does not expose (root, role, targetId, controlRevision, targetEpoch,
 *     queue/dispatch timestamps) are written as null with a reason — never invented.
 *   - No result is ever re-labelled: every step records expected vs observed, and any mismatch
 *     exits 1 with NOT_REPRODUCED plus the measured values.
 *
 * EVIDENCE (tests/acceptance/runs/<run-id>/, git-ignored)
 *   manifest.json      phase + expectationMode, runId, git HEAD + dirty file list, source
 *                      fingerprints (plan §2.1), driver/harness hashes, node/browser versions,
 *                      fixture + provider facts
 *   identities.json    per scenario: actors, scope, canonical tab/runtime ids, version fields
 *   calls.jsonl        one JSON line per tool call: actionId, actor, timestamps, target, result,
 *                      error code and real dispatch evidence
 *   before-after.json  per scenario: ordered observations (url, document nonce, form value, page
 *                      counters, selection, lease owner, tab rows, capacity)
 *   report.json        phase, verdict, reproductionVerified, fixedVerified, every check with BOTH
 *                      its bug-side and fix-side expectation, waits, failures, fixedRequirements
 *                      (the M2/M3 implementation checklist), NOT_RUN items and cleanup results
 *
 * EXIT CODES
 *   reproduce:     0 all checks matched the buggy baseline  (last line: BUG_REPRODUCED)
 *                  1 at least one did not, or the run was invalid (last line: NOT_REPRODUCED)
 *   verify-fixed:  0 every post-fix requirement passed        (last line: FIX_VERIFIED)
 *                  1 at least one check did not                 (last line: NOT_FIXED)
 *                  2 checks passed but the run cannot be signed (last line: BLOCKED_CLEANUP;
 *                    e.g. a leftover plugin Chromium, an unstable worktree, missing evidence)
 *   reproduce:     0 BUG_REPRODUCED / 1 NOT_REPRODUCED / 2 BLOCKED_CLEANUP
 *   2 is also the usage / cannot-start code: in every case it means "not signable", never
 *   "the fix failed". §11.8 keeps those apart on purpose.
 *
 * Usage:
 *   node tests/acceptance/session-tab-ownership.mjs --phase=reproduce [--run-id=<id>] [--runs-dir=<dir>]
 *
 * A single run costs ~50 s by construction: three real, uncut 16 s idle windows (P1-3, P2-3c,
 * P2-6-idle). Nothing is accelerated and no lease is renewed by the driver.
 */
import { execFileSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { createHash } from 'node:crypto';
import { appendFileSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { performance } from 'node:perf_hooks';
import {
  createFakeConnectionService,
  createHarness,
  PROFILE_PREFIX,
  scanPluginChromeProcesses,
} from './harness.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = dirname(dirname(HERE));

/**
 * §11.8 keeps "not verified" and "verified but not signable" apart, so the verdict is DERIVED from
 * independent booleans and never written by hand. Three states, mutually exclusive and exhaustive:
 *
 *   a check failed                          → NOT_FIXED / NOT_REPRODUCED      exit 1  verified:false
 *   checks pass, a non-check gate blocks    → BLOCKED_CLEANUP                 exit 2  verified:true
 *   everything passes                       → FIX_VERIFIED / BUG_REPRODUCED   exit 0  verified:true
 *
 * `blockedKind` and `blockedBy` say *which* gate blocked, because the block state name is fixed by
 * the contract (§11.8) while the cause can be cleanup, the worktree or missing evidence.
 */
const BLOCKED_KINDS = Object.freeze({ cleanup: 'cleanup', evidence: 'evidence' });

function deriveVerdict({ phase, checksAllPassed, blockedBy = [] }) {
  const verifyFixed = phase === 'verify-fixed';
  const successVerdict = verifyFixed ? 'FIX_VERIFIED' : 'BUG_REPRODUCED';
  const failureVerdict = verifyFixed ? 'NOT_FIXED' : 'NOT_REPRODUCED';
  if (checksAllPassed !== true) {
    return { verdict: failureVerdict, exitCode: 1, fixedVerified: false, reproductionVerified: false, blockedKind: null, blockedBy: [] };
  }
  if (blockedBy.length > 0) {
    const blockedKind = blockedBy.includes('cleanupLeakFree') ? BLOCKED_KINDS.cleanup : BLOCKED_KINDS.evidence;
    return { verdict: 'BLOCKED_CLEANUP', exitCode: 2, fixedVerified: verifyFixed, reproductionVerified: !verifyFixed, blockedKind, blockedBy: [...blockedBy] };
  }
  return { verdict: successVerdict, exitCode: 0, fixedVerified: verifyFixed, reproductionVerified: !verifyFixed, blockedKind: null, blockedBy: [] };
}

/** The phase decides the expectation set; never the observed outcome (§11.4). */
function expectationModeFor(phase) {
  return phase === 'verify-fixed' ? 'fixed' : 'bug';
}

/** The baseline's agent hold window (index.js AGENT_HOLD_MS). Documented, never shortened here. */
const AGENT_HOLD_MS = 15000;
/** Real idle window required by §11.5/§11.6 before the second attempt. */
const REAL_IDLE_MS = 16000;
/** A measured idle below this makes the whole run invalid. */
const MIN_VALID_IDLE_MS = 15000;
const FIXTURE_VERSION = 'g1-session-tab-ownership/2';
/** Quiet period required before a dispatch-attribution window opens, and its hard ceiling. */
const QUIESCE_MIN_QUIET_MS = 300;
const QUIESCE_MAX_MS = 2000;

const PLAN_FINGERPRINT_FILES = Object.freeze([
  'index.js', 'client.js', 'integration/cross-environment.js', 'integration/diagnose.js',
  'targets/web/adapter.js', 'targets/web/provider.js', 'core/identity.js', 'core/p0.js',
]);

/* ------------------------------------------------------------------------------------------------
 * Small utilities
 * ---------------------------------------------------------------------------------------------- */

const monoNow = () => performance.now();
const wallNow = () => Date.now();
const sleep = (ms) => new Promise((done) => setTimeout(done, ms));

/** Real monotonic idle: sleeps in bounded slices and reports what actually elapsed. */
async function realIdle(ms) {
  const started = monoNow();
  const deadline = started + ms;
  for (;;) {
    const left = deadline - monoNow();
    if (left <= 0) break;
    await sleep(Math.min(left, 100));
  }
  return monoNow() - started;
}

function sha256File(path) {
  try {
    return createHash('sha256').update(readFileSync(path)).digest('hex');
  } catch {
    return null;
  }
}

function git(args) {
  try {
    return execFileSync('git', args, { cwd: REPO_ROOT, encoding: 'utf8' }).trim();
  } catch {
    return null;
  }
}

/** Porcelain status keeps its two-column prefix (a leading space is part of the record). */
function gitStatusLines() {
  try {
    return execFileSync('git', ['status', '--porcelain'], { cwd: REPO_ROOT, encoding: 'utf8' })
      .split('\n').filter((line) => line.trim() !== '');
  } catch {
    return null;
  }
}

/** Directories/files whose contents are loaded by the plugin at run time. */
const MODULE_SOURCE_DIRS = Object.freeze(['core', 'integration', 'targets']);
const MODULE_SOURCE_ROOT_SKIP = new Set(['node_modules', 'docs', 'tests', 'output', 'reference', 'locale', 'skills', 'assets']);

/**
 * Hash every module source file the plugin can load (root *.js + core/ + integration/ + targets/)
 * plus this driver. Used to prove the code under test did not move while the run was executing.
 */
function hashSourceTree() {
  const out = {};
  const record = (absolute, relative) => {
    const digest = sha256File(absolute);
    if (digest) out[relative] = digest.slice(0, 16);
  };
  const walk = (dir, prefix) => {
    let entries;
    try { entries = readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      if (entry.name.startsWith('.')) continue;
      const absolute = join(dir, entry.name);
      const relative = `${prefix}${entry.name}`;
      if (entry.isDirectory()) walk(absolute, `${relative}/`);
      else if (entry.isFile() && /\.[cm]?js$/u.test(entry.name)) record(absolute, relative);
    }
  };
  let rootEntries;
  try { rootEntries = readdirSync(REPO_ROOT, { withFileTypes: true }); } catch { rootEntries = []; }
  for (const entry of rootEntries.sort((a, b) => a.name.localeCompare(b.name))) {
    if (entry.isFile() && /\.js$/u.test(entry.name) && !MODULE_SOURCE_ROOT_SKIP.has(entry.name)) record(join(REPO_ROOT, entry.name), entry.name);
  }
  for (const dir of MODULE_SOURCE_DIRS) walk(join(REPO_ROOT, dir), `${dir}/`);
  record(fileURLToPath(import.meta.url), 'tests/acceptance/session-tab-ownership.mjs');
  record(join(HERE, 'harness.mjs'), 'tests/acceptance/harness.mjs');
  return out;
}

function browserVersion() {
  for (const candidate of ['/usr/bin/google-chrome', 'google-chrome', 'chromium']) {
    try {
      return { path: candidate, version: execFileSync(candidate, ['--version'], { encoding: 'utf8' }).trim() };
    } catch { /* try the next candidate */ }
  }
  return { path: null, version: null };
}

/**
 * Requests a browser issues *by itself*, which can never be attributed to a tool call: a favicon
 * fetch, a robots probe, a well-known probe. Counting them as "dispatch" turns a late arrive-after
 * -window request from a PREVIOUS action into a false red (measured: /favicon.ico landing 19 ms
 * after an unrelated navigate). They are excluded from attribution but stay in the evidence as
 * `ignoredPassive`, so nothing disappears.
 */
const PASSIVE_REQUEST_PREFIXES = Object.freeze(['/favicon.ico', '/robots.txt', '/.well-known/']);
const PASSIVE_REQUEST_POLICY = 'passive browser-generated requests (favicon/robots/well-known) are excluded from dispatch attribution and listed under ignoredPassive';

function isPassiveRequest(url) {
  const value = String(url || '');
  return PASSIVE_REQUEST_PREFIXES.some((prefix) => value === prefix || value.startsWith(prefix));
}

/** Compact attribution record for a check's `observed` block. */
function dispatchEvidenceOf(call) {
  const quiesce = call && call.quiesce
    ? {
      status: call.quiesce.quiet ? 'quiet' : 'timeout',
      waitedMs: call.quiesce.waitedMs,
      sinceLastRequestMs: call.quiesce.sinceLastRequestMs,
      arrivedDuringQuiesce: call.quiesce.arrivedDuringQuiesce.map((entry) => entry.url),
    }
    : null;
  return {
    fixtureDispatch: call ? call.activeHits.length : null,
    dispatchUrls: call ? call.activeHits.map((hit) => hit.url) : [],
    ignoredPassive: call ? call.passiveHits.map((hit) => hit.url) : [],
    rawRequestCount: call ? call.hits.length : null,
    quiesce,
  };
}

/** Split one window's raw hits into attributable (active) and browser-generated (passive) ones. */
function classifyHits(hits) {
  const active = [];
  const passive = [];
  for (const hit of hits) (isPassiveRequest(hit.url) ? passive : active).push(hit);
  return { active, passive };
}

/**
 * Refusal codes that mean "you do not own this tab" (§11.6 P2, plan §6.3). A BUSY answer is
 * deliberately NOT in this set: on the baseline BUSY only reflects a 15 s lease, so accepting it
 * would let the very defect under test pass as a fix.
 */
const OWNERSHIP_REFUSAL_CODES = Object.freeze(['TAB_FORBIDDEN', 'TAB_NOT_FOUND', 'TAB_CONTROL_CHANGED']);

/** A structured refusal that is not the transient single-owner BUSY (P1-2 fix path (b)). */
function isStructuredNonBusyRefusal(code) {
  return typeof code === 'string' && code.length > 0 && code !== 'BUSY';
}

function errorCode(result) {
  return result && result.error ? (result.error.code ?? null) : null;
}

function errorMessage(result) {
  return result && result.error ? String(result.error.message || '') : null;
}

/** Plane value of a normalised read: the payload the tool itself returned. */
function payload(result) {
  return result && result.value !== undefined ? result.value : null;
}

/* ------------------------------------------------------------------------------------------------
 * Fixture server: a loopback-only靶机 that records every request it really served.
 * The request log is the independent proof that a navigation physically reached a page.
 * ---------------------------------------------------------------------------------------------- */

function fixtureDocument(title) {
  return `<!doctype html><html><head><meta charset="utf-8"><title>${title}</title></head><body>
<h1 id="h">${title}</h1>
<input id="login" value="fixture-login-${title.replace(/[^a-z0-9]/gi, '')}">
<button id="btn">${title} button</button>
<script>
window.__g1 = { input: 0, click: 0, loadedAt: Date.now() };
(function () {
  var input = document.getElementById('login');
  var button = document.getElementById('btn');
  if (input) input.addEventListener('input', function () { window.__g1.input += 1; });
  if (button) button.addEventListener('click', function () { window.__g1.click += 1; });
})();
</script></body></html>`;
}

async function startFixture(label) {
  const requests = [];
  let lastRequestMonoMs = null;
  const server = createServer((req, res) => {
    lastRequestMonoMs = monoNow();
    requests.push({ seq: requests.length + 1, atMonoMs: lastRequestMonoMs, atWallMs: wallNow(), method: req.method, url: req.url });
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
    res.end(fixtureDocument(req.url || '/'));
  });
  const sockets = new Set();
  server.on('connection', (socket) => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
  });
  await new Promise((done, fail) => server.once('error', fail).listen(0, '127.0.0.1', done));
  const { port } = server.address();
  return {
    label,
    base: `http://127.0.0.1:${port}`,
    requests,
    get count() { return requests.length; },
    get lastRequestMonoMs() { return lastRequestMonoMs; },
    since(seq) { return requests.filter((entry) => entry.seq > seq); },
    /**
     * Wait until the fixture has served nothing for `minQuietMs` (bounded by `maxMs`). This is not
     * a sleep used to hide a dispatch: it happens BEFORE the measurement window is opened, so a
     * real write still produces its target request inside the window and is counted. A window that
     * cannot be quieted is reported as `quiet:false` (callers record `quiesce:'timeout'`), never
     * silently skipped.
     */
    async quiesce({ minQuietMs = 300, maxMs = 2000, pollMs = 25, sinceSeq = null } = {}) {
      const startedAt = monoNow();
      const deadline = startedAt + maxMs;
      for (;;) {
        const last = lastRequestMonoMs;
        const sinceLast = last === null ? Number.POSITIVE_INFINITY : monoNow() - last;
        if (sinceLast >= minQuietMs) {
          return {
            quiet: true, waitedMs: round(monoNow() - startedAt),
            sinceLastRequestMs: Number.isFinite(sinceLast) ? round(sinceLast) : null,
            arrivedDuringQuiesce: sinceSeq === null ? [] : requests.filter((entry) => entry.seq > sinceSeq).map((entry) => ({ seq: entry.seq, url: entry.url })),
          };
        }
        if (monoNow() >= deadline) {
          return {
            quiet: false, waitedMs: round(monoNow() - startedAt),
            sinceLastRequestMs: Number.isFinite(sinceLast) ? round(sinceLast) : null,
            arrivedDuringQuiesce: sinceSeq === null ? [] : requests.filter((entry) => entry.seq > sinceSeq).map((entry) => ({ seq: entry.seq, url: entry.url })),
          };
        }
        await sleep(Math.min(pollMs, Math.max(1, deadline - monoNow())));
      }
    },
    async close() {
      const closed = await new Promise((done) => {
        server.close(() => done(true));
        for (const socket of sockets) { try { socket.destroy(); } catch { /* best effort */ } }
        setTimeout(() => done(false), 2000).unref?.();
      });
      return { closed, requestsServed: requests.length };
    },
  };
}

/* ------------------------------------------------------------------------------------------------
 * Evidence writer
 * ---------------------------------------------------------------------------------------------- */

class Evidence {
  constructor({ runId, phase, dir }) {
    this.runId = runId;
    this.phase = phase;
    /** 'bug' for --phase=reproduce, 'fixed' for --phase=verify-fixed. Never inferred. */
    this.expectationMode = expectationModeFor(phase);
    this.dir = dir;
    this.startedAt = new Date().toISOString();
    this.startedMonoMs = monoNow();
    this.checks = [];
    this.identities = {};
    this.scenarios = {};
    this.waits = [];
    this.notRun = [];
    this.notes = [];
    this.cleanup = { steps: [], ok: null };
    this.callsSeq = 0;
    this.observations = {};
    mkdirSync(dir, { recursive: true });
  }

  path(name) { return join(this.dir, name); }

  /** One recorded tool call → one JSONL line (+ dispatch evidence from the fixture log). */
  recordCall(entry) {
    this.callsSeq += 1;
    const line = { seq: this.callsSeq, ...entry };
    appendFileSync(this.path('calls.jsonl'), `${JSON.stringify(line)}\n`);
    return line;
  }

  /** One ordered observation for before-after.json. */
  observe(scenario, step, actor, data) {
    const list = this.observations[scenario] || (this.observations[scenario] = []);
    list.push({ index: list.length + 1, step, actor, atMonoMs: monoNow(), atWallMs: wallNow(), data });
  }

  /**
   * One check. `expected` describes the BUG-BASELINE expectation (§11.6 "修复前缺陷表现");
   * `pass` is decided at the call site from the measured value and never recomputed later.
   */
  check({ id, scenario, step, kind = 'defect', name, expected, observed, pass, notes }) {
    const entry = { id, scenario, step, kind, name, expected, observed, pass: pass === true, atMonoMs: monoNow() };
    if (notes) entry.notes = notes;
    this.checks.push(entry);
    const tag = entry.pass ? 'PASS' : 'FAIL';
    console.log(`${tag} ${id} ${name}`);
    if (!entry.pass) {
      console.log(`  expected: ${JSON.stringify(expected)}`);
      console.log(`  observed: ${JSON.stringify(observed)}`);
    }
    return entry;
  }

  /** Final before/after comparison block for one scenario (§11.8 before-after.json). */
  observeComparison(scenario, comparison) {
    const list = this.observations[scenario] || (this.observations[scenario] = []);
    list.push({ index: list.length + 1, step: 'comparison', actor: '-', atMonoMs: monoNow(), atWallMs: wallNow(), data: comparison });
  }

  /**
   * One phase-aware check. `bug` and `fixed` each carry {expected, pass}; the active phase decides
   * which one is judged, but BOTH are written to the report so it doubles as the implementation
   * checklist for M2/M3. `mode:'fixed-only'` marks behaviour the baseline cannot have (§11.4:
   * "新功能的正向用例不要求在旧版存在…"); such entries are recorded as not-applicable in reproduce
   * and never counted there.
   */
  checkPhase({ id, scenario, step, kind = 'defect', mode = 'both', name, bug, fixed, observed, notes }) {
    const applicable = mode === 'both' || this.phase === 'verify-fixed';
    const active = this.expectationMode === 'fixed' ? fixed : bug;
    const entry = {
      id, scenario, step, kind, name, mode, applicable,
      expectationMode: applicable ? this.expectationMode : null,
      expected: applicable ? active.expected : null,
      observed,
      pass: applicable ? active.pass === true : null,
      expectations: { bug: bug.expected, fixed: fixed.expected },
      atMonoMs: monoNow(),
    };
    if (notes) entry.notes = notes;
    this.checks.push(entry);
    const tag = applicable ? (entry.pass ? 'PASS' : 'FAIL') : 'N/A ';
    console.log(`${tag} ${id} ${name}`);
    if (applicable && !entry.pass) {
      console.log(`  expected(${this.expectationMode}): ${JSON.stringify(entry.expected)}`);
      console.log(`  observed: ${JSON.stringify(observed)}`);
    }
    return entry;
  }

  addWait({ id, scenario, requestedMs, measuredMs, fromStep, startedAtMonoMs }) {
    const valid = Number.isFinite(measuredMs) && measuredMs >= MIN_VALID_IDLE_MS;
    this.waits.push({ id, scenario, fromStep: fromStep || null, startedAtMonoMs: startedAtMonoMs === undefined ? null : round(startedAtMonoMs), requestedMs, measuredMs, minValidMs: MIN_VALID_IDLE_MS, valid });
    return valid;
  }

  /**
   * Compare the code identity now with the one frozen at the start of the run. A run whose
   * dependency tree changed underneath it (another agent editing the worktree, a checkout, ...)
   * is evidence for nothing and must never be signed off.
   */
  integrityCheck() {
    const before = this.baselineSnapshot || { head: null, sourceTree: null };
    const after = { head: git(['rev-parse', 'HEAD']), sourceTree: hashSourceTree() };
    const beforeTree = before.sourceTree || {};
    const afterTree = after.sourceTree || {};
    const changedFiles = [];
    for (const file of new Set([...Object.keys(beforeTree), ...Object.keys(afterTree)])) {
      if ((beforeTree[file] ?? null) !== (afterTree[file] ?? null)) changedFiles.push(file);
    }
    const planDrift = PLAN_FINGERPRINT_FILES.filter((file) => (beforeTree[file] ?? null) !== (afterTree[file] ?? null));
    const worktreeStable = before.head === after.head && changedFiles.length === 0;
    return {
      worktreeStable,
      headBefore: before.head ?? null, headAfter: after.head ?? null,
      changedSourceFiles: changedFiles.slice(0, 40),
      planFingerprintDrift: planDrift,
      filesHashed: Object.keys(afterTree).length,
      note: 'a run is only signable while the executed module tree (root *.js + core/ + integration/ + targets/ + this driver) is the one it started with (§11.4 G0)',
    };
  }

  writeIdentities() { writeFileSync(this.path('identities.json'), `${JSON.stringify(this.identities, null, 2)}\n`); }
  writeBeforeAfter() { writeFileSync(this.path('before-after.json'), `${JSON.stringify(this.observations, null, 2)}\n`); }

  writeManifest(extra) {
    // Freeze the code identity this run is measured against (§11.4 G0). Re-read at the end so a
    // worktree that moves underneath the run can never be signed off.
    this.baselineSnapshot = { head: git(['rev-parse', 'HEAD']), sourceTree: hashSourceTree() };
    const manifest = {
      schemaVersion: 1,
      kind: 'g1-defect-reproduction',
      runId: this.runId,
      phase: this.phase,
      startedAt: this.startedAt,
      fixture: { version: FIXTURE_VERSION, transports: ['node:http'], routes: 'any path → generated document' },
      node: { version: process.version, platform: process.platform, arch: process.arch },
      browser: browserVersion(),
      repository: {
        root: REPO_ROOT,
        head: git(['rev-parse', 'HEAD']),
        branch: git(['rev-parse', '--abbrev-ref', 'HEAD']),
        dirty: gitStatusLines(),
        packageVersion: (() => {
          try { return JSON.parse(readFileSync(join(REPO_ROOT, 'package.json'), 'utf8')).version; } catch { return null; }
        })(),
        fingerprintsSha256First16: Object.fromEntries(PLAN_FINGERPRINT_FILES.map((file) => [file, (sha256File(join(REPO_ROOT, file)) || '').slice(0, 16) || null])),
        fingerprintsNote: 'plan §2.1 records these 8 files; the runner records what it actually loaded',
      },
      driver: {
        file: 'tests/acceptance/session-tab-ownership.mjs',
        sha256: sha256File(fileURLToPath(import.meta.url)),
        harnessSha256: sha256File(join(HERE, 'harness.mjs')),
        harnessProfilePrefix: PROFILE_PREFIX,
      },
      config: {
        agentHoldMs: AGENT_HOLD_MS,
        realIdleMs: REAL_IDLE_MS,
        minValidIdleMs: MIN_VALID_IDLE_MS,
        accelerated: false,
        leaseRenewalInjected: false,
        dispatchAttribution: { passivePrefixes: [...PASSIVE_REQUEST_PREFIXES], quiesceMinQuietMs: QUIESCE_MIN_QUIET_MS, quiesceMaxMs: QUIESCE_MAX_MS },
      },
      ...extra,
    };
    writeFileSync(this.path('manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);
  }

  writeReport(extra) {
    const durationMs = Math.round(monoNow() - this.startedMonoMs);
    const applicableChecks = this.checks.filter((entry) => entry.applicable !== false);
    const failed = applicableChecks.filter((entry) => entry.pass !== true);
    const report = {
      schemaVersion: 1,
      runId: this.runId,
      phase: this.phase,
      startedAt: this.startedAt,
      finishedAt: new Date().toISOString(),
      durationMs,
      checks: this.checks,
      totals: {
        checks: applicableChecks.length,
        passed: applicableChecks.length - failed.length,
        failed: failed.length,
        defectChecks: applicableChecks.filter((entry) => entry.kind === 'defect').length,
        invariantChecks: applicableChecks.filter((entry) => entry.kind === 'invariant').length,
        notApplicableInThisPhase: this.checks.length - applicableChecks.length,
      },
      /** The fix-side requirement list: what M2/M3 must make true (independent of the phase run). */
      fixedRequirements: this.checks.map((entry) => ({
        id: entry.id, scenario: entry.scenario, name: entry.name, mode: entry.mode,
        fixedExpected: entry.expectations ? entry.expectations.fixed : entry.expected,
        activeThisPhase: entry.applicable !== false,
        resultThisPhase: entry.applicable === false ? 'not-applicable' : (entry.pass ? 'pass' : 'fail'),
      })),
      waits: this.waits,
      scenarios: this.scenarios,
      failures: failed.map((entry) => ({ id: entry.id, name: entry.name, expected: entry.expected, observed: entry.observed })),
      notRun: this.notRun,
      notes: this.notes,
      cleanup: this.cleanup,
      ...extra,
    };
    writeFileSync(this.path('report.json'), `${JSON.stringify(report, null, 2)}\n`);
    return report;
  }
}

/* ------------------------------------------------------------------------------------------------
 * Scenario harness helper: one clean harness + one clean fixture per scenario, always torn down.
 * ---------------------------------------------------------------------------------------------- */

function createScenarioContext(evidence, scenario, runNonce) {
  const resources = [];
  let teardownResult = null;
  return {
    scenario,
    runNonce,
    async open() {
      const fixture = await startFixture(scenario);
      resources.push(async () => ({ resource: 'fixture-http-server', ...(await fixture.close()) }));
      const harness = await createHarness({
        name: `g1-${scenario}`,
        connection: createFakeConnectionService({
          rejection: undefined,
          admit: () => ({ peer: { id: `g1-connection-peer-${scenario}` } }),
          browserPeer: { id: `g1-connection-peer-${scenario}` },
        }),
      });
      resources.push(async () => { await harness.dispose(); return { resource: 'harness', disposed: true }; });
      const cwd = harness.workspaceDir;
      const actors = {
        A: { id: `g1-${scenario}-A-${runNonce}`, exec: { agent: { id: `g1-${scenario}-A-${runNonce}`, session: { header: { cwd } } } } },
        B: { id: `g1-${scenario}-B-${runNonce}`, exec: { agent: { id: `g1-${scenario}-B-${runNonce}`, session: { header: { cwd } } } } },
      };
      const invoke = async ({ actor, tool, args, step, label, quiesceBefore = false }) => {
        // Optional pre-window quiet period for dispatch-attribution probes (never a substitute for
        // the assertion itself: the window still opens after it, so a real write is still caught).
        const quiesce = quiesceBefore
          ? await fixture.quiesce({ minQuietMs: QUIESCE_MIN_QUIET_MS, maxMs: QUIESCE_MAX_MS, sinceSeq: fixture.count })
          : null;
        const before = fixture.count;
        const acceptedAtMonoMs = monoNow();
        let result;
        try {
          result = await harness.invoke(tool, args, actors[actor].exec);
        } catch (error) {
          result = { ok: false, threw: true, error: { name: error?.name, code: error?.code, message: String(error && error.message || error) } };
        }
        const completedAtMonoMs = monoNow();
        const hits = fixture.since(before);
        const { active: activeHits, passive: passiveHits } = classifyHits(hits);
        const value = payload(result);
        const line = evidence.recordCall({
          scenario,
          step,
          label: label || null,
          actor,
          actorId: actors[actor].id,
          tool,
          args: summariseArgs(args),
          actionId: value?.actionId ?? result?.error?.details?.actionId ?? null,
          acceptedAtMonoMs: round(acceptedAtMonoMs),
          enqueuedAtMonoMs: null,
          dispatchedAtMonoMs: null,
          completedAtMonoMs: round(completedAtMonoMs),
          timestampsNote: 'the baseline exposes no queue/dispatch timestamps; real dispatch is evidenced by fixture requests and page counters',
          ok: result.ok === true,
          errorCode: errorCode(result),
          errorMessage: errorMessage(result),
          errorDetails: result?.error?.details ? summariseErrorDetails(result.error.details) : null,
          target: value?.target ?? null,
          tab: value?.tab ?? null,
          dispatchEvidence: {
            // The raw list is never trimmed: both attributable and passive requests stay here.
            fixtureRequests: hits.map((hit) => ({ seq: hit.seq, atMonoMs: round(hit.atMonoMs), url: hit.url })),
            fixtureRequestCount: hits.length,
            // Attribution view used by the assertions.
            activeRequestCount: activeHits.length,
            activeRequests: activeHits.map((hit) => ({ seq: hit.seq, atMonoMs: round(hit.atMonoMs), url: hit.url })),
            ignoredPassive: passiveHits.map((hit) => ({ seq: hit.seq, atMonoMs: round(hit.atMonoMs), url: hit.url })),
            ignoredPassivePolicy: PASSIVE_REQUEST_POLICY,
            quiesceBeforeWindow: quiesce,
            pageCounters: value?.value && typeof value.value === 'object' ? value.value.counters ?? null : null,
          },
          barrier: null,
        });
        return { result, value, line, hits, activeHits, passiveHits, quiesce, completedAtMonoMs };
      };
      return {
        harness,
        fixture,
        cwd,
        actors,
        invoke,
        call: (actor, tool, args, step, label) => invoke({ actor, tool, args, step, label }),
        async teardown() {
          // Idempotent: a second call reports the first call's result and never disposes twice.
          if (teardownResult === null) {
            const results = [];
            for (const dispose of [...resources].reverse()) {
              try { results.push(await dispose()); } catch (error) { results.push({ resource: 'teardown-failed', error: String(error && error.message || error) }); }
            }
            teardownResult = results;
          }
          return teardownResult;
        },
      };
    },
  };
}

function round(value) { return Number.isFinite(value) ? Math.round(value * 1000) / 1000 : null; }

function summariseArgs(args) {
  const out = {};
  for (const [key, value] of Object.entries(args || {})) {
    if (key === 'expression') out.expression = { type: 'string', length: String(value).length };
    else if (typeof value === 'string') out[key] = value.length > 200 ? `${value.slice(0, 200)}…` : value;
    else if (typeof value === 'number' || typeof value === 'boolean') out[key] = value;
    else if (value && typeof value === 'object') out[key] = { type: 'object', keys: Object.keys(value).slice(0, 20) };
    else out[key] = { type: typeof value };
  }
  return out;
}

function summariseErrorDetails(details) {
  const out = {};
  for (const [key, value] of Object.entries(details || {})) {
    if (['args', 'actionId', 'sessionId'].includes(key)) continue;
    if (value === null || ['string', 'number', 'boolean'].includes(typeof value)) out[key] = typeof value === 'string' ? value.slice(0, 200) : value;
  }
  return out;
}

/**
 * The long-lived ownership/control projection M2a added to every `browser_tabs list` row
 * (ruling §5 "每页返回"). These fields, not the 15 s lease, are what a fix must hold.
 */
const OWNERSHIP_REQUIRED_FIELDS = Object.freeze([
  'rootSessionId', 'ownerSessionId', 'controllerSessionId', 'ownershipRevision', 'controlRevision',
]);

/**
 * Snapshot the ownership projection of one tab row. A field that is `undefined`/`null` is
 * reported as missing and named — never silently treated as "fine" (task-7 requirement).
 */
function ownershipSnapshot(row) {
  if (!row) return { present: false, missing: [...OWNERSHIP_REQUIRED_FIELDS], fields: {}, reason: 'row-absent' };
  const fields = {};
  const missing = [];
  for (const key of OWNERSHIP_REQUIRED_FIELDS) {
    const value = row[key];
    fields[key] = value === undefined ? null : value;
    if (value === undefined || value === null) missing.push(key);
  }
  if (row.accessVersion !== undefined) fields.accessVersion = row.accessVersion;
  if (row.accessState !== undefined) fields.accessState = row.accessState;
  return { present: missing.length === 0, missing, fields };
}

function missingFieldFor(snapshot) {
  return snapshot && snapshot.missing && snapshot.missing.length > 0 ? [...snapshot.missing] : null;
}

/** A fingerprint is only usable for byte comparison when every field was actually read. */
function bBeforeComplete(state) {
  if (!state || typeof state !== 'object') return false;
  return ['url', 'title', 'nonce', 'form', 'scrollX', 'scrollY', 'visibility', 'documentLength'].every((key) => state[key] !== undefined);
}

function sameOwnership(a, b) {
  if (!a || !b) return false;
  return OWNERSHIP_REQUIRED_FIELDS.every((key) => a.fields[key] === b.fields[key]);
}

/**
 * Byte-level page fingerprint read *by the page's own owner*: everything that a cross-root write
 * could disturb. Compared as an exact string, so "unchanged" means unchanged, not "similar".
 */
const BYTE_STATE_EXPRESSION = `(() => ({
  url: location.href,
  title: document.title,
  nonce: (typeof window.__g1Nonce === 'string' ? window.__g1Nonce : null),
  form: (document.getElementById('login') || {}).value ?? null,
  counters: window.__g1 ?? null,
  scrollX: window.scrollX,
  scrollY: window.scrollY,
  visibility: document.visibilityState,
  documentLength: document.documentElement ? document.documentElement.outerHTML.length : null,
  textLength: document.body ? document.body.textContent.length : null
}))()`;

/** Read the current document through the page's own owner (legitimate read), memory only. */
const READ_EXPRESSION = `(() => ({
  url: location.href,
  title: document.title,
  nonce: (typeof window.__g1Nonce === 'string' ? window.__g1Nonce : null),
  nonceType: typeof window.__g1Nonce,
  form: (document.getElementById('login') || {}).value ?? null,
  counters: window.__g1 ?? null,
  localStorageKeys: (() => { try { return Object.keys(localStorage); } catch (e) { return ['unavailable']; } })(),
  sessionStorageKeys: (() => { try { return Object.keys(sessionStorage); } catch (e) { return ['unavailable']; } })()
}))()`;

function writeNonceExpression(nonce) {
  return `(() => { window.__g1Nonce = ${JSON.stringify(nonce)}; return { nonce: window.__g1Nonce, url: location.href }; })()`;
}

function tabRow(listValue, tabId) {
  const tabs = Array.isArray(listValue?.tabs) ? listValue.tabs : [];
  return tabs.find((row) => row.tabId === tabId) || null;
}

/* ------------------------------------------------------------------------------------------------
 * P1 — two independent roots contend for the same primary (§11.6 P1)
 * ---------------------------------------------------------------------------------------------- */

async function runP1(evidence, runNonce) {
  const ctx = createScenarioContext(evidence, 'P1', runNonce);
  const nonce = `g1-p1-${randomBytes(12).toString('hex')}`;
  const scenarios = { steps: {}, status: null };
  try {
    const env = await ctx.open();
    const { actors, fixture, invoke } = env;
    const phaseMode = evidence.expectationMode;

    // --- P1-1: A navigates its fixture primary and marks it with a private document nonce.
    const aNavigate = await invoke({ actor: 'A', tool: 'browser_navigate', args: { url: `${fixture.base}/logged-in-primary` }, step: 'P1-1', label: 'A navigate primary' });
    const scope = aNavigate.value?.scope ?? null;
    const aRuntimeId = aNavigate.value?.tab?.runtimeId ?? null;
    const aTabId = aNavigate.value?.tab?.id ?? null;
    evidence.check({
      id: 'P1-1a', scenario: 'P1', step: 'P1-1', kind: 'invariant',
      name: 'A can open its own fixture primary inside a registered (non-degraded) workspace',
      expected: { ok: true, scopeKind: 'workspace', degraded: false },
      observed: { ok: aNavigate.result.ok, scopeKind: scope?.kind ?? null, degraded: scope?.degraded ?? null, tabId: aTabId, runtimeId: aRuntimeId, trustedRoot: null, trustedRootReason: 'no root is exposed to the tool surface on this baseline' },
      pass: aNavigate.result.ok === true && scope?.kind === 'workspace' && scope?.degraded === false && Boolean(aRuntimeId),
    });

    const aNonce = await invoke({ actor: 'A', tool: 'browser_eval', args: { expression: writeNonceExpression(nonce) }, step: 'P1-1', label: 'A writes document nonce' });
    const aRead1 = await invoke({ actor: 'A', tool: 'browser_eval', args: { expression: READ_EXPRESSION }, step: 'P1-1', label: 'A reads own document' });
    const aState1 = aRead1.value?.value ?? null;
    evidence.observe('P1', 'P1-1', 'A', { before: { url: aState1?.url, nonce: aState1?.nonce, form: aState1?.form, counters: aState1?.counters } });
    evidence.check({
      id: 'P1-1b', scenario: 'P1', step: 'P1-1', kind: 'invariant',
      name: 'A document nonce is random, lives in page memory only and is readable by A',
      expected: { ok: true, nonceEcho: nonce, localStorageKeys: [] },
      observed: { ok: aNonce.result.ok && aRead1.result.ok, nonceEcho: aNonce.value?.value?.nonce ?? null, read: aState1 && { url: aState1.url, nonce: aState1.nonce, form: aState1.form, localStorageKeys: aState1.localStorageKeys } },
      pass: aNonce.result.ok === true && aRead1.result.ok === true
        && aNonce.value?.value?.nonce === nonce && aState1?.nonce === nonce
        && Array.isArray(aState1?.localStorageKeys) && aState1.localStorageKeys.length === 0,
    });

    const aListOwnBefore = await invoke({ actor: 'A', tool: 'browser_tabs', args: { action: 'list' }, step: 'P1-1', label: 'A lists its own page before the idle window' });
    const ownershipBefore = ownershipSnapshot(tabRow(aListOwnBefore.value, 'primary'));
    evidence.observe('P1', 'P1-1', 'A', { ownershipBefore });
    const capsBeforeP1 = await invoke({ actor: 'A', tool: 'browser_capabilities', args: {}, step: 'P1-1', label: 'capacity before attack' });

    // --- P1-2: B targets its own default primary with a different URL (no workspace is supplied).
    const bAttempt = await invoke({ actor: 'B', tool: 'browser_navigate', args: { url: `${fixture.base}/scene` }, step: 'P1-2', label: 'B navigate while A is on its page' });
    const bAttemptRuntime = bAttempt.value?.tab?.runtimeId ?? null;
    const bAttemptCode = errorCode(bAttempt.result);
    const bAttemptOwner = bAttempt.result?.error?.details?.owner ?? null;
    const bOwnPrimary = bAttempt.result.ok === true && Boolean(bAttemptRuntime) && bAttemptRuntime !== aRuntimeId;
    const bUnboundRefusal = bAttempt.result.ok === false && isStructuredNonBusyRefusal(bAttemptCode);
    evidence.observe('P1', 'P1-2', 'B', {
      attempt: `${fixture.base}/scene`, ok: bAttempt.result.ok, code: bAttemptCode, owner: bAttemptOwner,
      runtimeId: bAttemptRuntime, distinctFromA: bAttemptRuntime !== null && bAttemptRuntime !== aRuntimeId,
      fixtureRequests: bAttempt.hits.map((hit) => hit.url),
    });
    evidence.checkPhase({
      id: 'P1-2a', scenario: 'P1', step: 'P1-2', kind: 'defect',
      name: 'B is not permanently locked out of its own page by A\'s page',
      bug: {
        expected: { ok: false, errorCode: 'BUSY', owner: actors.A.id },
        pass: bAttempt.result.ok === false && bAttemptCode === 'BUSY' && bAttemptOwner === actors.A.id,
      },
      fixed: {
        expected: {
          anyOf: [
            { ok: true, runtimeId: '!= A.runtimeId (B gets its own independent primary)' },
            { ok: false, errorCode: 'structured non-BUSY unbound error (e.g. TARGET_NOT_BOUND / TAB_NOT_FOUND / SESSION_NOT_BOUND)' },
          ],
        },
        pass: bOwnPrimary || bUnboundRefusal,
      },
      observed: { ok: bAttempt.result.ok, errorCode: bAttemptCode, owner: bAttemptOwner, runtimeId: bAttemptRuntime, distinctFromA: bAttemptRuntime !== null && bAttemptRuntime !== aRuntimeId, aRuntimeId, dispatchRequests: bAttempt.hits.map((hit) => hit.url) },
      notes: 'A permanent BUSY-only answer fails this check on purpose (§11.6 P1-2, G2 requirement).',
    });

    // --- P1-3: real 16 s idle measured from A's last page operation; A stays alive, renews nothing.
    const lastPageOpMonoMs = aRead1.completedAtMonoMs;
    const idleMs = await realIdle(REAL_IDLE_MS);
    const idleValid = evidence.addWait({ id: 'P1-3', scenario: 'P1', fromStep: 'A last page tool completion (P1-1 read)', requestedMs: REAL_IDLE_MS, measuredMs: round(idleMs) });
    const aStateWait = await invoke({ actor: 'A', tool: 'browser_state', args: {}, step: 'P1-3', label: 'A diagnostic read after the idle window' });
    const aListWait = await invoke({ actor: 'A', tool: 'browser_tabs', args: { action: 'list' }, step: 'P1-3', label: 'A lists tabs after the idle window' });
    const stateAfterIdle = aStateWait.value ?? null;
    const primaryRowAfterIdle = tabRow(aListWait.value, 'primary');
    const ownershipUnchangedAfterIdle = stateAfterIdle?.tab?.id === 'primary'
      && stateAfterIdle?.tab?.runtimeId === aRuntimeId
      && (stateAfterIdle?.owner?.sessionId ?? null) !== actors.B.id;
    evidence.observe('P1', 'P1-3', 'A', {
      idleMeasuredMs: round(idleMs),
      lastPageOpMonoMs: round(lastPageOpMonoMs),
      stateAfterIdle: stateAfterIdle && { url: stateAfterIdle.url, owner: stateAfterIdle.owner, tab: stateAfterIdle.tab, error: stateAfterIdle.error },
      primaryRowAfterIdle,
    });
    evidence.check({
      id: 'P1-3', scenario: 'P1', step: 'P1-3', kind: 'invariant',
      name: 'Real uncut 16000 ms idle elapsed while A stayed alive (no renewal, no acceleration)',
      expected: { measuredMs: `>= ${MIN_VALID_IDLE_MS}`, agentAlive: true, leaseStillOwnedByA: 'recorded, not asserted (§11.6 P1-3)' },
      observed: { measuredMs: round(idleMs), valid: idleValid, agentAlive: aStateWait.result.ok === true, leaseOwner: stateAfterIdle?.owner?.sessionId ?? null },
      pass: idleValid && aStateWait.result.ok === true,
      notes: 'Plan P1-3 explicitly forbids asserting that A must still be BUSY here; only the window and A\'s liveness are checked.',
    });
    const ownershipAfter = ownershipSnapshot(primaryRowAfterIdle);
    evidence.observe('P1', 'P1-3', 'A', { ownershipAfter, ownershipBefore });
    const ownershipHeldByA = ownershipAfter.present
      && ownershipAfter.fields.ownerSessionId === actors.A.id
      && ownershipAfter.fields.controllerSessionId === actors.A.id
      && ownershipAfter.fields.rootSessionId === actors.A.id;
    const ownershipRevisionsStable = sameOwnership(ownershipBefore, ownershipAfter)
      && ownershipBefore.fields.ownershipRevision === ownershipAfter.fields.ownershipRevision
      && ownershipBefore.fields.controlRevision === ownershipAfter.fields.controlRevision;
    if (phaseMode === 'fixed' && !ownershipAfter.present) {
      evidence.notRun.push({
        id: 'P1-3b', item: 'persistent ownership projection on the tab row',
        reason: `tab row is missing ${JSON.stringify(ownershipAfter.missing)}; the strong assertion cannot be made, so this check fails instead of passing softly`,
      });
    }
    evidence.checkPhase({
      id: 'P1-3b', scenario: 'P1', step: 'P1-3', kind: 'defect',
      name: 'The idle window does not move A\'s ownership: owner/controller/root still A, both revisions unchanged',
      bug: {
        expected: {
          ownershipProjection: 'absent (no ownerSessionId/controllerSessionId/rootSessionId/ownershipRevision/controlRevision on any row)',
          leaseAfterIdle: 'null (the only ownership the baseline has is the 15 s lease, and it lapsed)',
        },
        pass: ownershipBefore.present === false && ownershipAfter.present === false
          && (primaryRowAfterIdle?.owner ?? null) === null,
      },
      fixed: {
        expected: {
          ownerSessionId: actors.A.id, controllerSessionId: actors.A.id, rootSessionId: actors.A.id,
          ownershipRevision: 'unchanged across the idle window', controlRevision: 'unchanged across the idle window',
          missingField: missingFieldFor(ownershipAfter),
        },
        pass: ownershipHeldByA && ownershipRevisionsStable,
      },
      observed: {
        ownershipBefore, ownershipAfter,
        missingField: missingFieldFor(ownershipAfter),
        leaseOwnerAfterIdle: stateAfterIdle?.owner?.sessionId ?? null,
        tabId: stateAfterIdle?.tab?.id ?? null, runtimeId: stateAfterIdle?.tab?.runtimeId ?? null,
        leaseOnlyStillConsistent: ownershipUnchangedAfterIdle,
      },
      notes: 'Strong form (task-7): the persistent projection must exist and still name A, with both revisions frozen, because nothing happened to the page. A missing field fails the check and is also recorded as an explicit NOT_RUN.',
    });

    // --- P1-7: B repeatedly observes A's page while A is idle; reads must not become write rights.
    //     Protocol is identical in both phases: three rounds of list+state from B, then A re-reads
    //     its own projection. Only the expectation is swapped.
    const observationRounds = [];
    for (let round = 1; round <= 3; round += 1) {
      const bObserveList = await invoke({ actor: 'B', tool: 'browser_tabs', args: { action: 'list' }, step: 'P1-7', label: `B observes A (round ${round}) via list` });
      const bObserveState = await invoke({ actor: 'B', tool: 'browser_state', args: {}, step: 'P1-7', label: `B observes A (round ${round}) via state` });
      observationRounds.push({
        round,
        listSeesARuntime: (bObserveList.value?.tabs ?? []).some((row) => row.runtimeId === aRuntimeId),
        listRows: (bObserveList.value?.tabs ?? []).map((row) => ({ tabId: row.tabId, runtimeId: row.runtimeId, ownerSessionId: row.ownerSessionId ?? null, controllerSessionId: row.controllerSessionId ?? null })),
        stateOk: bObserveState.result.ok,
        stateTab: bObserveState.value?.tab ?? null,
        stateUrl: bObserveState.value?.url ?? null,
        stateLeaseOwner: bObserveState.value?.owner?.sessionId ?? null,
        dispatch: bObserveList.activeHits.length + bObserveState.activeHits.length,
        ignoredPassive: [...bObserveList.passiveHits, ...bObserveState.passiveHits].map((hit) => hit.url),
      });
      await sleep(120);
    }
    const aAfterObservation = await invoke({ actor: 'A', tool: 'browser_tabs', args: { action: 'list' }, step: 'P1-7', label: 'A lists its own page after B observed it' });
    const ownershipAfterObservation = ownershipSnapshot(tabRow(aAfterObservation.value, 'primary'));
    const bEverSawA = observationRounds.some((round) => round.listSeesARuntime);
    evidence.observe('P1', 'P1-7', 'B', { rounds: observationRounds });
    evidence.observe('P1', 'P1-7', 'A', { ownershipAfterObservation, ownershipBefore });
    evidence.checkPhase({
      id: 'P1-7', scenario: 'P1', step: 'P1-7', kind: 'defect',
      name: 'Repeated cross-root observation never turns a reader into a writer (ownership and controller frozen)',
      bug: {
        expected: {
          bSeesAPage: true,
          ownershipProjection: 'absent — a reader only needs the 15 s lease to be gone to be able to take the page',
        },
        // Either signal is a defect on the baseline; a correct implementation has neither, so the
        // fixed side stays fully discriminating.
        pass: bEverSawA === true || ownershipAfterObservation.present === false,
      },
      fixed: {
        expected: {
          bSeesAPage: false, observedRounds: 3,
          ownerSessionId: actors.A.id, controllerSessionId: actors.A.id, rootSessionId: actors.A.id,
          ownershipRevision: 'unchanged', controlRevision: 'unchanged',
          missingField: missingFieldFor(ownershipAfterObservation),
        },
        pass: bEverSawA === false
          && ownershipAfterObservation.present === true
          && ownershipAfterObservation.fields.ownerSessionId === actors.A.id
          && ownershipAfterObservation.fields.controllerSessionId === actors.A.id
          && ownershipAfterObservation.fields.rootSessionId === actors.A.id
          && sameOwnership(ownershipBefore, ownershipAfterObservation),
      },
      observed: {
        bEverSawARuntime: bEverSawA,
        rounds: observationRounds,
        ownershipBefore, ownershipAfterObservation,
        missingField: missingFieldFor(ownershipAfterObservation),
      },
      notes: 'Reads must never mutate ownership/controller (§3.4 "观察不夺取写权"). Observation is list/state only: no lease, no queue, no claim.',
    });

    // --- P1-4: B navigates again; the baseline reuses and destroys A's runtime.
    const bTakeover = await invoke({ actor: 'B', tool: 'browser_navigate', args: { url: `${fixture.base}/scene` }, step: 'P1-4', label: 'B navigate after the idle window' });
    const bRuntimeId = bTakeover.value?.tab?.runtimeId ?? null;
    const bTakeoverCode = errorCode(bTakeover.result);
    evidence.observe('P1', 'P1-4', 'B', { ok: bTakeover.result.ok, code: bTakeoverCode, url: bTakeover.value?.url ?? null, tab: bTakeover.value?.tab ?? null, dispatchRequests: bTakeover.hits.map((hit) => hit.url) });
    evidence.checkPhase({
      id: 'P1-4a', scenario: 'P1', step: 'P1-4', kind: 'defect',
      name: 'B\'s second navigation never shares A\'s runtime',
      bug: {
        expected: { ok: true, runtimeId: aRuntimeId, sameAsA: true },
        pass: bTakeover.result.ok === true && bRuntimeId !== null && bRuntimeId === aRuntimeId,
      },
      fixed: {
        expected: { anyOf: [{ ok: true, runtimeId: '!= A.runtimeId' }, { ok: false, errorCode: 'structured non-BUSY refusal' }] },
        pass: (bTakeover.result.ok === true && bRuntimeId !== null && bRuntimeId !== aRuntimeId)
          || (bTakeover.result.ok === false && isStructuredNonBusyRefusal(bTakeoverCode)),
      },
      observed: { ok: bTakeover.result.ok, errorCode: bTakeoverCode, runtimeId: bRuntimeId, sameAsA: bRuntimeId === aRuntimeId, aRuntimeId, dispatchRequests: bTakeover.hits.map((hit) => hit.url) },
    });

    const aReadAfter = await invoke({ actor: 'A', tool: 'browser_eval', args: { expression: READ_EXPRESSION }, step: 'P1-4', label: 'A reads its own page after B\'s navigation' });
    const bRead = await invoke({ actor: 'B', tool: 'browser_eval', args: { expression: READ_EXPRESSION }, step: 'P1-4', label: 'B reads the page it is attached to' });
    const aAfterBState = aReadAfter.value?.value ?? null;
    const bState = bRead.value?.value ?? null;
    evidence.observe('P1', 'P1-4', 'A', { ownRead: { ok: aReadAfter.result.ok, code: errorCode(aReadAfter.result), url: aAfterBState?.url, nonce: aAfterBState?.nonce, form: aAfterBState?.form } });
    evidence.observe('P1', 'P1-4', 'B', { ownRead: { ok: bRead.result.ok, url: bState?.url, nonce: bState?.nonce, nonceType: bState?.nonceType, form: bState?.form } });
    evidence.checkPhase({
      id: 'P1-4b', scenario: 'P1', step: 'P1-4', kind: 'defect',
      name: 'A\'s document context survives B\'s navigation (URL, private nonce, form value)',
      bug: {
        expected: { aRead: 'BUSY (A blocked on its own page)', bDocument: { url: `${fixture.base}/scene`, nonce: null } },
        pass: aReadAfter.result.ok === false && errorCode(aReadAfter.result) === 'BUSY'
          && bRead.result.ok === true && bState?.url === `${fixture.base}/scene`
          && bState?.nonce === null && bState?.nonceType === 'undefined',
      },
      fixed: {
        expected: { aRead: { ok: true, url: `${fixture.base}/logged-in-primary`, nonce }, bDocument: { url: `${fixture.base}/scene`, nonce: null } },
        pass: aReadAfter.result.ok === true && aAfterBState?.url === `${fixture.base}/logged-in-primary`
          && aAfterBState?.nonce === nonce && aAfterBState?.form === 'fixture-login-loggedinprimary'
          && (bRead.result.ok === false || (bState?.url === `${fixture.base}/scene` && bState?.nonce !== nonce)),
      },
      observed: { aRead: { ok: aReadAfter.result.ok, errorCode: errorCode(aReadAfter.result), url: aAfterBState?.url ?? null, nonce: aAfterBState?.nonce ?? null, form: aAfterBState?.form ?? null }, bRead: { ok: bRead.result.ok, url: bState?.url ?? null, nonce: bState?.nonce ?? null, nonceType: bState?.nonceType ?? null } },
    });

    const aState2 = await invoke({ actor: 'A', tool: 'browser_state', args: {}, step: 'P1-4', label: 'A diagnostic read after B\'s navigation' });
    const aStateValue = aState2.value ?? null;
    evidence.observe('P1', 'P1-4', 'A', { afterTakeover: { url: aStateValue?.url ?? null, tab: aStateValue?.tab ?? null, owner: aStateValue?.owner ?? null } });
    evidence.check({
      id: 'P1-4c', scenario: 'P1', step: 'P1-4', kind: 'invariant',
      name: 'A\'s own selection still points at its own primary/root page after the idle window',
      expected: { tabId: 'primary', runtimeId: aRuntimeId },
      observed: { ok: aState2.result.ok, tabId: aStateValue?.tab?.id ?? null, runtimeId: aStateValue?.tab?.runtimeId ?? null },
      pass: aState2.result.ok === true && aStateValue?.tab?.id === 'primary' && aStateValue?.tab?.runtimeId === aRuntimeId,
    });

    const aList = await invoke({ actor: 'A', tool: 'browser_tabs', args: { action: 'list' }, step: 'P1-4', label: 'A lists tabs after B\'s navigation' });
    const primaryRow = tabRow(aList.value, 'primary');
    const aListForeignRows = (aList.value?.tabs ?? []).filter((row) => row.runtimeId !== aRuntimeId).map((row) => ({ tabId: row.tabId, runtimeId: row.runtimeId, url: row.url, owner: row.owner }));
    evidence.observe('P1', 'P1-4', 'A', { tabRows: aList.value?.tabs ?? null, selection: aList.value?.selection ?? null });
    evidence.checkPhase({
      id: 'P1-4d', scenario: 'P1', step: 'P1-4', kind: 'defect',
      name: 'A\'s tab list shows only A\'s own page (no other session\'s tab is addressable)',
      bug: {
        expected: { primaryOwner: 'other', primaryUrl: `${fixture.base}/scene`, selected: true },
        pass: aList.result.ok === true && primaryRow?.owner === 'other' && primaryRow?.selected === true && primaryRow?.url === `${fixture.base}/scene`,
      },
      fixed: {
        expected: { primaryUrl: `${fixture.base}/logged-in-primary`, primaryOwner: 'self|null', foreignRows: [] },
        pass: aList.result.ok === true && primaryRow?.url === `${fixture.base}/logged-in-primary`
          && (primaryRow?.owner === 'self' || primaryRow?.owner === null) && aListForeignRows.length === 0,
      },
      observed: { ok: aList.result.ok, primaryRow, foreignRows: aListForeignRows },
    });

    // --- P1-5: A keeps read/write access to its own page (positive functionality).
    const aAfterWrite = await invoke({ actor: 'A', tool: 'browser_eval', args: { expression: '(() => { window.__g1Writes = (window.__g1Writes || 0) + 1; return { writes: window.__g1Writes, nonce: (typeof window.__g1Nonce === "string" ? window.__g1Nonce : null), url: location.href }; })()' }, step: 'P1-5', label: 'A writes on its own page' });
    const aAfterWriteRead = await invoke({ actor: 'A', tool: 'browser_eval', args: { expression: READ_EXPRESSION }, step: 'P1-5', label: 'A reads back its own page' });
    const aAfterWriteState = aAfterWrite.value?.value ?? null;
    const aFinalState = aAfterWriteRead.value?.value ?? null;
    evidence.observe('P1', 'P1-5', 'A', { ownWrite: { ok: aAfterWrite.result.ok, code: errorCode(aAfterWrite.result), state: aAfterWriteState ?? null, owner: aAfterWrite.result?.error?.details?.owner ?? null }, ownReadBack: { ok: aAfterWriteRead.result.ok, url: aFinalState?.url, nonce: aFinalState?.nonce } });
    evidence.checkPhase({
      id: 'P1-5', scenario: 'P1', step: 'P1-5', kind: 'defect',
      name: 'A can read and write its own page after B\'s activity',
      bug: {
        expected: { read: 'BUSY', write: 'BUSY' },
        pass: aReadAfter.result.ok === false && errorCode(aReadAfter.result) === 'BUSY'
          && aAfterWrite.result.ok === false && errorCode(aAfterWrite.result) === 'BUSY',
      },
      fixed: {
        expected: { read: 'ok, nonce intact', write: { ok: true, nonce } },
        pass: aReadAfter.result.ok === true && aAfterBState?.nonce === nonce
          && aAfterWrite.result.ok === true && aAfterWriteState?.nonce === nonce
          && aAfterWriteRead.result.ok === true && aFinalState?.nonce === nonce
          && aFinalState?.url === `${fixture.base}/logged-in-primary`,
      },
      observed: { aRead: { ok: aReadAfter.result.ok, code: errorCode(aReadAfter.result) }, aWrite: { ok: aAfterWrite.result.ok, code: errorCode(aAfterWrite.result), nonce: aAfterWriteState?.nonce ?? null }, aReadBack: { ok: aAfterWriteRead.result.ok, nonce: aFinalState?.nonce ?? null, url: aFinalState?.url ?? null } },
    });

    // --- P1-6 (fixed-only): A\'s page is not addressable from B by any known identifier.
    const bListProbe = await invoke({ actor: 'B', tool: 'browser_tabs', args: { action: 'list' }, step: 'P1-6', label: 'B lists tabs looking for A\'s page' });
    const bSeesARuntime = (bListProbe.value?.tabs ?? []).some((row) => row.runtimeId === aRuntimeId);
    const bSelectA = await invoke({ actor: 'B', tool: 'browser_tabs', args: { action: 'select', tabId: aRuntimeId }, step: 'P1-6', label: 'B selects A\'s runtime id as a tab id', quiesceBefore: true });
    const bReadAfterProbe = await invoke({ actor: 'B', tool: 'browser_eval', args: { expression: READ_EXPRESSION }, step: 'P1-6', label: 'B reads its own page after the probe' });
    const bProbeState = bReadAfterProbe.value?.value ?? null;
    evidence.observe('P1', 'P1-6', 'B', {
      listSeesARuntime: bSeesARuntime,
      selectByRuntimeId: { ok: bSelectA.result.ok, code: errorCode(bSelectA.result), dispatch: bSelectA.hits.map((hit) => hit.url) },
      ownReadAfterProbe: { ok: bReadAfterProbe.result.ok, url: bProbeState?.url ?? null, nonce: bProbeState?.nonce ?? null },
    });
    evidence.checkPhase({
      id: 'P1-6', scenario: 'P1', step: 'P1-6', kind: 'defect', mode: 'fixed-only',
      name: 'B cannot discover or address A\'s page by its runtime id (and the attempt dispatches nothing)',
      bug: { expected: { notApplicable: 'the baseline exposes every tab of the shared page group to every session' }, pass: false },
      fixed: {
        expected: { aRuntimeVisibleInBList: false, selectRefused: true, fixtureDispatch: 0, dispatchUrls: [], bOwnPageIntact: true },
        pass: bSeesARuntime === false
          && bSelectA.result.ok === false && isStructuredNonBusyRefusal(errorCode(bSelectA.result))
          && bSelectA.activeHits.length === 0
          && bReadAfterProbe.result.ok === true && bProbeState?.nonce !== nonce,
      },
      observed: {
        aRuntimeVisibleInBList: bSeesARuntime, selectCode: errorCode(bSelectA.result), selectOk: bSelectA.result.ok,
        ...dispatchEvidenceOf(bSelectA),
        bOwnPage: { ok: bReadAfterProbe.result.ok, url: bProbeState?.url ?? null, nonce: bProbeState?.nonce ?? null },
      },
    });

    const capsAfterP1Early = await invoke({ actor: 'A', tool: 'browser_capabilities', args: {}, step: 'P1-4', label: 'capacity after the attack' });

    evidence.identities.P1 = {
      scenario: 'P1',
      harness: { clean: true, workspaceDir: env.cwd, name: 'g1-P1' },
      scope,
      provider: { environment: aNavigate.value?.environment ?? null, adapterId: aNavigate.value?.adapterId ?? null, configRevision: aNavigate.value?.configRevision ?? null },
      actors: {
        A: { id: actors.A.id, root: ownershipAfter.fields.rootSessionId ?? null, rootReason: ownershipAfter.present ? 'rootSessionId as proved by the identity resolver (standalone domain) and projected on the tab row' : 'row carries no rootSessionId (baseline)', sessionHeaderCwd: env.cwd },
        B: { id: actors.B.id, root: null, rootReason: 'B\'s own page group is never exposed to A on this baseline; see the P1-6/P1-7 rows', sessionHeaderCwd: env.cwd },
        distinctAgentIds: actors.A.id !== actors.B.id,
        sameWorkspace: true,
      },
      ownership: {
        before: ownershipBefore,
        afterIdle: ownershipAfter,
        afterObservation: ownershipAfterObservation,
        missingField: missingFieldFor(ownershipAfter),
        expectedRootForStandaloneActor: actors.A.id,
      },
      canonical: {
        primary: { tabId: aTabId, runtimeId: aRuntimeId, targetId: null, targetIdReason: 'CDP targetId is internal to index.js and not exposed by any tool result', bRuntimeIdAfterAttack: bRuntimeId },
        documentNonce: { value: nonce, storage: 'window.__g1Nonce (page memory)', localStorageUsed: false },
      },
      versions: {
        selectionRevision: aRead1.value?.tab?.selectionRevision ?? null,
        leaseOwnerBeforeExpiry: bAttemptOwner,
        leaseOwnerAfterExpiry: stateAfterIdle?.owner?.sessionId ?? null,
        controlRevision: null,
        controlRevisionReason: 'no control-revision field exists on this baseline',
        targetEpoch: null,
        targetEpochReason: 'no target-epoch field exists on this baseline',
        executionVersion: null,
        executionVersionReason: 'not exposed',
      },
      capacity: { before: capsBeforeP1.value?.runtime?.workspaceIsolation ?? null, after: capsAfterP1Early.value?.runtime?.workspaceIsolation ?? null },
    };

    evidence.observeComparison('P1', {
      summary: phaseMode === 'fixed'
        ? 'expected after the fix: two independent primaries, A\'s document and ownership untouched by B'
        : 'observed on the baseline: same primary entry and runtimeId, A document replaced by B, ownership moved to B, A refused on its own page',
      before: {
        actorRead: 'A', url: aState1?.url ?? null, documentNonce: aState1?.nonce ?? null, form: aState1?.form ?? null,
        pageCounters: aState1?.counters ?? null, tabId: aTabId, runtimeId: aRuntimeId,
        selectionOwner: actors.A.id, leaseOwner: actors.A.id, capacity: capsBeforeP1.value?.runtime?.workspaceIsolation ?? null,
      },
      after: {
        url: aStateValue?.url ?? null, documentNonce: bState?.nonce ?? null, form: bState?.form ?? null,
        tabId: aStateValue?.tab?.id ?? null, runtimeId: aStateValue?.tab?.runtimeId ?? null,
        selectionOwner: actors.A.id, leaseOwner: bTakeover.result.ok ? actors.B.id : null,
        aOwnRead: { ok: aAfterWriteRead.result.ok, errorCode: errorCode(aAfterWriteRead.result) },
        capacity: capsAfterP1Early.value?.runtime?.workspaceIsolation ?? null,
      },
      verdictOnBaseline: bRuntimeId === aRuntimeId && bState?.nonce === null ? 'CROSS_SESSION_CONTEXT_LOSS' : 'NOT_OBSERVED',
      notExposed: {
        scroll: 'no tool exposes scroll position of another session page on this baseline',
        visibility: 'no tool exposes document visibility of another session page on this baseline',
        observeSelection: 'the baseline has one selection per (primary entry, session); there is no observe/work split to compare',
        controller: 'no controller/controlRevision concept exists on this baseline (lease owner stands in)',
      },
    });

    scenarios.steps = {
      'P1-1': { status: 'recorded', aRuntimeId, aTabId },
      'P1-2': { status: bAttempt.result.ok ? 'B_GOT_A_PAGE' : bAttemptCode, code: bAttemptCode, runtimeId: bAttemptRuntime, distinctFromA: bAttemptRuntime !== aRuntimeId },
      'P1-3': { measuredIdleMs: round(idleMs), valid: idleValid, leaseOwner: stateAfterIdle?.owner?.sessionId ?? null, ownershipUnchanged: ownershipUnchangedAfterIdle },
      'P1-4': { status: bTakeover.result.ok ? 'NAVIGATED' : 'REFUSED', code: bTakeoverCode, runtimeId: bRuntimeId, sameRuntimeAsA: bRuntimeId === aRuntimeId, aDocumentKeptNonce: aAfterBState?.nonce === nonce },
      'P1-5': { status: aAfterWrite.result.ok ? 'A_CAN_WRITE' : 'A_REFUSED', code: errorCode(aAfterWrite.result) },
      'P1-3b': { ownerSessionId: ownershipAfter.fields.ownerSessionId ?? null, controllerSessionId: ownershipAfter.fields.controllerSessionId ?? null, rootSessionId: ownershipAfter.fields.rootSessionId ?? null, ownershipRevision: ownershipAfter.fields.ownershipRevision ?? null, controlRevision: ownershipAfter.fields.controlRevision ?? null, missingField: missingFieldFor(ownershipAfter) },
      'P1-6': { aRuntimeVisibleInBList: bSeesARuntime, selectCode: errorCode(bSelectA.result), fixtureDispatch: bSelectA.activeHits.length, ignoredPassive: bSelectA.passiveHits.map((hit) => hit.url) },
      'P1-7': { bEverSawARuntime: bEverSawA, rounds: observationRounds.length, ownershipStable: sameOwnership(ownershipBefore, ownershipAfterObservation), ownerSessionId: ownershipAfterObservation.fields.ownerSessionId ?? null, missingField: missingFieldFor(ownershipAfterObservation) },
    };
    scenarios.status = 'completed';
    return { scenarios, teardown: () => env.teardown() };
  } catch (error) {
    scenarios.status = 'error';
    scenarios.error = String(error && error.stack || error);
    evidence.check({
      id: 'P1-X', scenario: 'P1', step: 'P1', kind: 'invariant',
      name: 'P1 scenario ran to completion',
      expected: { ran: true },
      observed: { ran: false, error: String(error && error.message || error) },
      pass: false,
    });
    return { scenarios, teardown: async () => [{ resource: 'scenario-error', error: String(error && error.message || error) }] };
  }
}

/* ------------------------------------------------------------------------------------------------
 * P2 — B opens a child, then A is handed B's real child id and takes it over (§11.6 P2, user's
 * direction: A takes over B's child, not the symmetric direction of the historical script).
 * ---------------------------------------------------------------------------------------------- */

async function runP2(evidence, runNonce) {
  const ctx = createScenarioContext(evidence, 'P2', runNonce);
  const nonceA = `g1-p2-A-${randomBytes(12).toString('hex')}`;
  const nonceB = `g1-p2-B-${randomBytes(12).toString('hex')}`;
  const scenarios = { steps: {}, status: null };
  try {
    const env = await ctx.open();
    const { actors, fixture, invoke } = env;
    const phaseMode = evidence.expectationMode;

    // --- P2-1: A works on its own page; B is either given its own page or refused structurally.
    const aOpen = await invoke({ actor: 'A', tool: 'browser_navigate', args: { url: `${fixture.base}/A-work` }, step: 'P2-1', label: 'A navigate own primary' });
    const aPrimaryRuntimeId = aOpen.value?.tab?.runtimeId ?? null;
    const aNonceWrite = await invoke({ actor: 'A', tool: 'browser_eval', args: { expression: writeNonceExpression(nonceA) }, step: 'P2-1', label: 'A writes own nonce' });
    evidence.check({
      id: 'P2-1a', scenario: 'P2', step: 'P2-1', kind: 'invariant',
      name: 'A works in its own fixture page inside a registered workspace',
      expected: { ok: true, scopeKind: 'workspace', degraded: false },
      observed: { ok: aOpen.result.ok && aNonceWrite.result.ok, scopeKind: aOpen.value?.scope?.kind ?? null, degraded: aOpen.value?.scope?.degraded ?? null, runtimeId: aPrimaryRuntimeId },
      pass: aOpen.result.ok === true && aNonceWrite.result.ok === true
        && aOpen.value?.scope?.kind === 'workspace' && aOpen.value?.scope?.degraded === false && Boolean(aPrimaryRuntimeId),
    });

    const bOnShared = await invoke({ actor: 'B', tool: 'browser_navigate', args: { url: `${fixture.base}/scene` }, step: 'P2-1', label: 'B navigate while A holds the page' });
    const bOnSharedRuntime = bOnShared.value?.tab?.runtimeId ?? null;
    const bOnSharedCode = errorCode(bOnShared.result);
    evidence.observe('P2', 'P2-1', 'B', { ok: bOnShared.result.ok, code: bOnSharedCode, owner: bOnShared.result?.error?.details?.owner ?? null, runtimeId: bOnSharedRuntime, distinctFromA: bOnSharedRuntime !== null && bOnSharedRuntime !== aPrimaryRuntimeId });
    evidence.checkPhase({
      id: 'P2-1b', scenario: 'P2', step: 'P2-1', kind: 'defect',
      name: 'B is not refused forever by A\'s page (own primary or a structured non-BUSY answer)',
      bug: {
        expected: { ok: false, errorCode: 'BUSY', owner: actors.A.id },
        pass: bOnShared.result.ok === false && bOnSharedCode === 'BUSY' && bOnShared.result?.error?.details?.owner === actors.A.id,
      },
      fixed: {
        expected: { anyOf: [{ ok: true, runtimeId: '!= A.runtimeId' }, { ok: false, errorCode: 'structured non-BUSY unbound error' }] },
        pass: (bOnShared.result.ok === true && bOnSharedRuntime !== null && bOnSharedRuntime !== aPrimaryRuntimeId)
          || (bOnShared.result.ok === false && isStructuredNonBusyRefusal(bOnSharedCode)),
      },
      observed: { ok: bOnShared.result.ok, errorCode: bOnSharedCode, owner: bOnShared.result?.error?.details?.owner ?? null, runtimeId: bOnSharedRuntime, aPrimaryRuntimeId, dispatchRequests: bOnShared.hits.map((hit) => hit.url) },
    });

    const capsBeforeP2 = await invoke({ actor: 'A', tool: 'browser_capabilities', args: {}, step: 'P2-2', label: 'capacity before attack' });

    // --- P2-2: B explicitly creates and works in its own child tab.
    const bOpen = await invoke({ actor: 'B', tool: 'browser_tabs', args: { action: 'open' }, step: 'P2-2', label: 'B opens a child tab' });
    const childTabId = bOpen.value?.tabId ?? null;
    const bListAfterOpen = await invoke({ actor: 'B', tool: 'browser_tabs', args: { action: 'list' }, step: 'P2-2', label: 'B lists tabs after open' });
    const childRow = tabRow(bListAfterOpen.value, childTabId);
    const childRuntimeId = childRow?.runtimeId ?? null;
    evidence.check({
      id: 'P2-2a', scenario: 'P2', step: 'P2-2', kind: 'invariant',
      name: 'B can create and select a child tab of its own (distinct runtime from A\'s primary)',
      expected: { ok: true, childTabId: '<uuid>', childRuntimeIdDifferent: true },
      observed: { ok: bOpen.result.ok, childTabId, childRuntimeId, aPrimaryRuntimeId, distinct: Boolean(childRuntimeId) && childRuntimeId !== aPrimaryRuntimeId },
      pass: bOpen.result.ok === true && Boolean(childTabId) && Boolean(childRuntimeId) && childRuntimeId !== aPrimaryRuntimeId && childRow?.selected === true,
    });

    const bNavigateChild = await invoke({ actor: 'B', tool: 'browser_navigate', args: { url: `${fixture.base}/B-work` }, step: 'P2-2', label: 'B navigates its child' });
    const bNonceWrite = await invoke({ actor: 'B', tool: 'browser_eval', args: { expression: writeNonceExpression(nonceB) }, step: 'P2-2', label: 'B writes child nonce' });
    const bChildRead = await invoke({ actor: 'B', tool: 'browser_eval', args: { expression: READ_EXPRESSION }, step: 'P2-2', label: 'B reads own child document' });
    const bChildState = bChildRead.value?.value ?? null;
    evidence.observe('P2', 'P2-2', 'B', { child: { tabId: childTabId, runtimeId: childRuntimeId, url: bChildState?.url, nonce: bChildState?.nonce, form: bChildState?.form, counters: bChildState?.counters } });
    evidence.check({
      id: 'P2-2b', scenario: 'P2', step: 'P2-2', kind: 'invariant',
      name: 'B\'s child holds B\'s own URL, random nonce and form value (page memory only)',
      expected: { url: `${fixture.base}/B-work`, nonce: nonceB, form: 'fixture-login-Bwork', localStorageKeys: [] },
      observed: { ok: bNavigateChild.result.ok && bNonceWrite.result.ok && bChildRead.result.ok, url: bChildState?.url ?? null, nonce: bChildState?.nonce ?? null, form: bChildState?.form ?? null, tabRuntimeId: bNavigateChild.value?.tab?.runtimeId ?? null, localStorageKeys: bChildState?.localStorageKeys ?? null },
      pass: bNavigateChild.result.ok === true && bNonceWrite.result.ok === true && bChildRead.result.ok === true
        && bChildState?.url === `${fixture.base}/B-work` && bChildState?.nonce === nonceB
        && bNavigateChild.value?.tab?.runtimeId === childRuntimeId
        && Array.isArray(bChildState?.localStorageKeys) && bChildState.localStorageKeys.length === 0,
    });

    const aStillWorks = await invoke({ actor: 'A', tool: 'browser_eval', args: { expression: READ_EXPRESSION }, step: 'P2-2', label: 'A continues on its own page' });
    const aOwnState = aStillWorks.value?.value ?? null;
    const aStateAfterBOpen = await invoke({ actor: 'A', tool: 'browser_state', args: {}, step: 'P2-2', label: 'A diagnostic after B open' });
    const aStateValue = aStateAfterBOpen.value ?? null;
    evidence.observe('P2', 'P2-2', 'A', { ownPage: { url: aOwnState?.url, nonce: aOwnState?.nonce }, selection: aStateValue?.tab ?? null, owner: aStateValue?.owner ?? null });
    evidence.check({
      id: 'P2-2c', scenario: 'P2', step: 'P2-2', kind: 'invariant',
      name: 'B opening a child did not move A\'s selection or damage A\'s own page',
      expected: { ok: true, url: `${fixture.base}/A-work`, nonce: nonceA, selectionTabId: 'primary', selectionRuntimeId: aPrimaryRuntimeId },
      observed: { ok: aStillWorks.result.ok, url: aOwnState?.url ?? null, nonce: aOwnState?.nonce ?? null, selectionTabId: aStateValue?.tab?.id ?? null, selectionRuntimeId: aStateValue?.tab?.runtimeId ?? null },
      pass: aStillWorks.result.ok === true && aOwnState?.url === `${fixture.base}/A-work` && aOwnState?.nonce === nonceA
        && aStateValue?.tab?.id === 'primary' && aStateValue?.tab?.runtimeId === aPrimaryRuntimeId,
    });

    // --- P2-5a (positive, before any attack): A writes its own page.
    const aOwnWrite = await invoke({ actor: 'A', tool: 'browser_eval', args: { expression: '(() => { window.__g1Writes = (window.__g1Writes || 0) + 1; return { writes: window.__g1Writes, nonce: (typeof window.__g1Nonce === "string" ? window.__g1Nonce : null), url: location.href }; })()' }, step: 'P2-5', label: 'A writes its own page' });
    const aOwnWriteState = aOwnWrite.value?.value ?? null;
    evidence.check({
      id: 'P2-5a', scenario: 'P2', step: 'P2-5', kind: 'invariant',
      name: 'A can write its own page while B works in its child (no global serialisation yet)',
      expected: { ok: true, nonce: nonceA, url: `${fixture.base}/A-work` },
      observed: { ok: aOwnWrite.result.ok, code: errorCode(aOwnWrite.result), nonce: aOwnWriteState?.nonce ?? null, url: aOwnWriteState?.url ?? null },
      pass: aOwnWrite.result.ok === true && aOwnWriteState?.nonce === nonceA && aOwnWriteState?.url === `${fixture.base}/A-work`,
    });

    // --- P2-3: first attack attempt inside B's still-valid lease.
    const aSelectBefore = await invoke({ actor: 'A', tool: 'browser_tabs', args: { action: 'select', tabId: childTabId }, step: 'P2-3', label: 'A selects B\'s child before the lease expiry', quiesceBefore: true });
    const aSelectBeforeCode = errorCode(aSelectBefore.result);
    evidence.observe('P2', 'P2-3', 'A', { select: { tabId: childTabId, ok: aSelectBefore.result.ok, code: aSelectBeforeCode, owner: aSelectBefore.result?.error?.details?.owner ?? null, dispatch: aSelectBefore.hits.map((hit) => hit.url) } });
    evidence.checkPhase({
      id: 'P2-3a', scenario: 'P2', step: 'P2-3', kind: 'defect',
      name: 'A\'s select of B\'s child is refused by ownership (not merely by the transient lease)',
      bug: {
        expected: { ok: false, errorCode: 'BUSY', owner: actors.B.id, dispatch: 0 },
        pass: aSelectBefore.result.ok === false && aSelectBeforeCode === 'BUSY'
          && aSelectBefore.result?.error?.details?.owner === actors.B.id && aSelectBefore.activeHits.length === 0,
      },
      fixed: {
        expected: { ok: false, errorCode: 'TAB_FORBIDDEN|TAB_NOT_FOUND|TAB_CONTROL_CHANGED', fixtureDispatch: 0, dispatchUrls: [] },
        pass: aSelectBefore.result.ok === false && OWNERSHIP_REFUSAL_CODES.includes(aSelectBeforeCode) && aSelectBefore.activeHits.length === 0,
      },
      observed: { ok: aSelectBefore.result.ok, errorCode: aSelectBeforeCode, owner: aSelectBefore.result?.error?.details?.owner ?? null, ...dispatchEvidenceOf(aSelectBefore) },
    });

    const aSelectionAfterRefusal = await invoke({ actor: 'A', tool: 'browser_state', args: {}, step: 'P2-3', label: 'A selection after the refused select' });
    const aSelValue = aSelectionAfterRefusal.value ?? null;
    evidence.observe('P2', 'P2-3', 'A', { selectionAfterRefusal: aSelValue?.tab ?? null });
    evidence.check({
      id: 'P2-3b', scenario: 'P2', step: 'P2-3', kind: 'invariant',
      name: 'A\'s own selection is unchanged by the refused select (in both phases it must not move)',
      expected: { tabId: 'primary', runtimeId: aPrimaryRuntimeId },
      observed: { tabId: aSelValue?.tab?.id ?? null, runtimeId: aSelValue?.tab?.runtimeId ?? null },
      pass: aSelValue?.tab?.id === 'primary' && aSelValue?.tab?.runtimeId === aPrimaryRuntimeId,
    });

    // --- P2-3c: real 16 s idle measured from B's last page operation.
    const bLastPageOpMonoMs = bChildRead.completedAtMonoMs;
    const idleMs = await realIdle(REAL_IDLE_MS);
    const idleValid = evidence.addWait({ id: 'P2-3c', scenario: 'P2', startedAtMonoMs: bLastPageOpMonoMs, requestedMs: REAL_IDLE_MS, measuredMs: round(idleMs) });
    evidence.check({
      id: 'P2-3c', scenario: 'P2', step: 'P2-3', kind: 'invariant',
      name: 'Second real uncut 16000 ms idle elapsed (B stayed alive, nothing renewed the lease)',
      expected: { measuredMs: `>= ${MIN_VALID_IDLE_MS}` },
      observed: { measuredMs: round(idleMs), valid: idleValid, lastPageOpMonoMs: round(bLastPageOpMonoMs) },
      pass: idleValid,
    });

    const aListAfterIdle = await invoke({ actor: 'A', tool: 'browser_tabs', args: { action: 'list' }, step: 'P2-3', label: 'A lists tabs after the idle window' });
    const childRowForA = tabRow(aListAfterIdle.value, childTabId);
    evidence.observe('P2', 'P2-3', 'A', { childRowSeenByA: childRowForA, selectionSeenByA: aListAfterIdle.value?.selection ?? null, tabRows: aListAfterIdle.value?.tabs ?? null });
    evidence.checkPhase({
      id: 'P2-3d', scenario: 'P2', step: 'P2-3', kind: 'defect',
      name: 'B\'s child is never presented to A as an ownerless manageable tab',
      bug: {
        expected: { owner: null, manageable: true, busy: false },
        pass: aListAfterIdle.result.ok === true && childRowForA?.owner === null && childRowForA?.manageable === true,
      },
      fixed: {
        expected: { row: 'absent from A\'s list, or present but manageable:false' },
        pass: aListAfterIdle.result.ok === true && (!childRowForA || childRowForA.manageable === false),
      },
      observed: { ok: aListAfterIdle.result.ok, childRow: childRowForA && { tabId: childRowForA.tabId, runtimeId: childRowForA.runtimeId, owner: childRowForA.owner, manageable: childRowForA.manageable, busy: childRowForA.busy, url: childRowForA.url } },
    });

    // --- P2-4: second attack attempt after the idle window.
    const aSelectAfter = await invoke({ actor: 'A', tool: 'browser_tabs', args: { action: 'select', tabId: childTabId }, step: 'P2-4', label: 'A selects B\'s child after the lease expiry', quiesceBefore: true });
    const aSelectAfterCode = errorCode(aSelectAfter.result);
    evidence.observe('P2', 'P2-4', 'A', { select: { tabId: childTabId, ok: aSelectAfter.result.ok, code: aSelectAfterCode, tabIdReturned: aSelectAfter.value?.tabId ?? null, selection: aSelectAfter.value?.selection ?? null, dispatch: aSelectAfter.hits.map((hit) => hit.url) } });
    evidence.checkPhase({
      id: 'P2-4a', scenario: 'P2', step: 'P2-4', kind: 'defect',
      name: 'A never obtains B\'s child, before or after the lease lapse',
      bug: {
        expected: { ok: true, tabId: childTabId },
        pass: aSelectAfter.result.ok === true && aSelectAfter.value?.tabId === childTabId,
      },
      fixed: {
        expected: { ok: false, errorCode: 'TAB_FORBIDDEN|TAB_NOT_FOUND|TAB_CONTROL_CHANGED', fixtureDispatch: 0, dispatchUrls: [] },
        pass: aSelectAfter.result.ok === false && OWNERSHIP_REFUSAL_CODES.includes(aSelectAfterCode) && aSelectAfter.activeHits.length === 0,
      },
      observed: { ok: aSelectAfter.result.ok, errorCode: aSelectAfterCode, tabIdReturned: aSelectAfter.value?.tabId ?? null, ...dispatchEvidenceOf(aSelectAfter) },
    });

    const aReadTarget = await invoke({ actor: 'A', tool: 'browser_eval', args: { expression: READ_EXPRESSION }, step: 'P2-4', label: 'A reads its current target after the select attempt', quiesceBefore: true });
    const aTargetState = aReadTarget.value?.value ?? null;
    evidence.observe('P2', 'P2-4', 'A', { currentTarget: { ok: aReadTarget.result.ok, url: aTargetState?.url, nonce: aTargetState?.nonce, tab: aReadTarget.value?.tab ?? null }, dispatch: aReadTarget.hits.map((hit) => hit.url) });
    evidence.checkPhase({
      id: 'P2-4b', scenario: 'P2', step: 'P2-4', kind: 'defect',
      name: 'Whatever the select returned, A\'s reads/writes stay on its own page and never see B\'s document',
      bug: {
        expected: { url: `${fixture.base}/B-work`, nonce: nonceB, runtimeId: childRuntimeId },
        pass: aReadTarget.result.ok === true && aTargetState?.nonce === nonceB
          && aTargetState?.url === `${fixture.base}/B-work` && aReadTarget.value?.tab?.runtimeId === childRuntimeId,
      },
      fixed: {
        expected: { url: `${fixture.base}/A-work`, nonce: nonceA, runtimeId: aPrimaryRuntimeId, fixtureDispatch: 0, dispatchUrls: [] },
        pass: aReadTarget.result.ok === true && aTargetState?.nonce === nonceA
          && aTargetState?.url === `${fixture.base}/A-work` && aReadTarget.value?.tab?.runtimeId === aPrimaryRuntimeId
          && aReadTarget.activeHits.length === 0,
      },
      observed: { ok: aReadTarget.result.ok, url: aTargetState?.url ?? null, nonce: aTargetState?.nonce ?? null, runtimeId: aReadTarget.value?.tab?.runtimeId ?? null, nonceB, childRuntimeId, aPrimaryRuntimeId, ...dispatchEvidenceOf(aReadTarget) },
      notes: 'A "default write lands on A\'s own page" is NOT counted as a bypass; the assertion is that it never lands on B\'s page.',
    });

    // --- P2-5b: B must still be able to write its own child after A\'s attempts.
    const bOwnWrite = await invoke({ actor: 'B', tool: 'browser_eval', args: { expression: '(() => { window.__g1Writes = (window.__g1Writes || 0) + 1; return { writes: window.__g1Writes, nonce: (typeof window.__g1Nonce === "string" ? window.__g1Nonce : null), url: location.href }; })()' }, step: 'P2-5', label: 'B writes its own child' });
    const bOwnWriteState = bOwnWrite.value?.value ?? null;
    evidence.observe('P2', 'P2-5', 'B', { ownWrite: { ok: bOwnWrite.result.ok, code: errorCode(bOwnWrite.result), state: bOwnWriteState ?? null, owner: bOwnWrite.result?.error?.details?.owner ?? null } });
    evidence.checkPhase({
      id: 'P2-5b', scenario: 'P2', step: 'P2-5', kind: 'defect',
      name: 'B can keep writing its own child while A is active on its own page',
      bug: {
        expected: { ok: false, errorCode: 'BUSY' },
        pass: bOwnWrite.result.ok === false && errorCode(bOwnWrite.result) === 'BUSY',
      },
      fixed: {
        expected: { ok: true, nonce: nonceB, url: `${fixture.base}/B-work` },
        pass: bOwnWrite.result.ok === true && bOwnWriteState?.nonce === nonceB && bOwnWriteState?.url === `${fixture.base}/B-work`,
      },
      observed: { ok: bOwnWrite.result.ok, errorCode: errorCode(bOwnWrite.result), nonce: bOwnWriteState?.nonce ?? null, url: bOwnWriteState?.url ?? null, owner: bOwnWrite.result?.error?.details?.owner ?? null },
    });

    // --- P2-4c: A navigates the known target id; the write must not reach B's page.
    const aNavigateScene = await invoke({ actor: 'A', tool: 'browser_navigate', args: { url: `${fixture.base}/scene-child` }, step: 'P2-4', label: 'A navigates toward B\'s child id' });
    const aReadScene = await invoke({ actor: 'A', tool: 'browser_eval', args: { expression: READ_EXPRESSION }, step: 'P2-4', label: 'A reads where its navigation landed' });
    const bReadScene = await invoke({ actor: 'B', tool: 'browser_eval', args: { expression: READ_EXPRESSION }, step: 'P2-4', label: 'B reads its own child after A\'s navigation' });
    const aLandedState = aReadScene.value?.value ?? null;
    const bAfterNavState = bReadScene.value?.value ?? null;
    evidence.observe('P2', 'P2-4', 'A', { navigate: { ok: aNavigateScene.result.ok, code: errorCode(aNavigateScene.result), runtimeId: aNavigateScene.value?.tab?.runtimeId ?? null, dispatch: aNavigateScene.hits.map((hit) => hit.url) }, landed: { ok: aReadScene.result.ok, url: aLandedState?.url, nonce: aLandedState?.nonce, runtimeId: aReadScene.value?.tab?.runtimeId ?? null } });
    evidence.observe('P2', 'P2-4', 'B', { afterANavigate: { ok: bReadScene.result.ok, code: errorCode(bReadScene.result), url: bAfterNavState?.url, nonce: bAfterNavState?.nonce ?? null, nonceType: bAfterNavState?.nonceType ?? null } });
    evidence.checkPhase({
      id: 'P2-4c', scenario: 'P2', step: 'P2-4', kind: 'defect',
      name: 'A\'s navigation destroys B\'s document on the baseline and never does so after the fix',
      bug: {
        expected: { navigate: 'ok on B\'s child runtime', bDocument: { url: `${fixture.base}/scene-child`, nonce: null }, bOwnRead: 'BUSY' },
        pass: aNavigateScene.result.ok === true && aNavigateScene.value?.tab?.runtimeId === childRuntimeId
          && aLandedState?.url === `${fixture.base}/scene-child` && aLandedState?.nonce === null
          && bReadScene.result.ok === false && errorCode(bReadScene.result) === 'BUSY',
      },
      fixed: {
        expected: { bDocument: { url: `${fixture.base}/B-work`, nonce: nonceB }, aNavigation: 'own page or refused', bOwnRead: 'ok' },
        pass: bReadScene.result.ok === true && bAfterNavState?.url === `${fixture.base}/B-work` && bAfterNavState?.nonce === nonceB
          && ((aNavigateScene.result.ok === true && aNavigateScene.value?.tab?.runtimeId === aPrimaryRuntimeId)
            || (aNavigateScene.result.ok === false && OWNERSHIP_REFUSAL_CODES.includes(errorCode(aNavigateScene.result)))),
      },
      observed: {
        navigateOk: aNavigateScene.result.ok, navigateCode: errorCode(aNavigateScene.result), navigateRuntimeId: aNavigateScene.value?.tab?.runtimeId ?? null,
        landed: { url: aLandedState?.url ?? null, nonce: aLandedState?.nonce ?? null }, childRuntimeId, aPrimaryRuntimeId,
        bOwnRead: { ok: bReadScene.result.ok, code: errorCode(bReadScene.result), url: bAfterNavState?.url ?? null, nonce: bAfterNavState?.nonce ?? null },
        dispatchRequests: aNavigateScene.hits.map((hit) => hit.url),
      },
    });

    // --- P2-4d: A cannot close B's work tab.
    const aClose = await invoke({ actor: 'A', tool: 'browser_tabs', args: { action: 'close', tabId: childTabId }, step: 'P2-4', label: 'A closes B\'s child id', quiesceBefore: true });
    const bListFinal = await invoke({ actor: 'B', tool: 'browser_tabs', args: { action: 'list' }, step: 'P2-4', label: 'B lists tabs after A\'s close attempt' });
    const childRowFinal = tabRow(bListFinal.value, childTabId);
    evidence.observe('P2', 'P2-4', 'A', { close: { ok: aClose.result.ok, code: errorCode(aClose.result), dispatch: aClose.hits.map((hit) => hit.url) } });
    evidence.observe('P2', 'P2-4', 'B', { tabsAfterCloseAttempt: bListFinal.value?.tabs ?? null });
    evidence.checkPhase({
      id: 'P2-4d', scenario: 'P2', step: 'P2-4', kind: 'defect',
      name: 'A cannot destroy B\'s work tab by its known id',
      bug: {
        expected: { close: 'ok (B\'s tab destroyed)', bTabStillPresent: false },
        pass: aClose.result.ok === true && childRowFinal === null,
      },
      fixed: {
        expected: { close: 'refused (TAB_FORBIDDEN|TAB_NOT_FOUND|TAB_CONTROL_CHANGED)', bTabStillPresent: true, fixtureDispatch: 0, dispatchUrls: [] },
        pass: aClose.result.ok === false && OWNERSHIP_REFUSAL_CODES.includes(errorCode(aClose.result))
          && childRowFinal !== null && childRowFinal.runtimeId === childRuntimeId && aClose.activeHits.length === 0,
      },
      observed: { closeOk: aClose.result.ok, closeCode: errorCode(aClose.result), bTabStillPresent: childRowFinal !== null, bRow: childRowFinal && { tabId: childRowFinal.tabId, runtimeId: childRowFinal.runtimeId, status: childRowFinal.status }, ...dispatchEvidenceOf(aClose) },
    });

    // --- P2-6: the three write families against B's second child (task-7).
    //     Same protocol in both phases: B builds a fresh work tab, a REAL 16 s idle, then A attempts
    //     close/navigate/eval on that known tab id, and B's page is fingerprinted byte-for-byte.
    const bOpen2 = await invoke({ actor: 'B', tool: 'browser_tabs', args: { action: 'open' }, step: 'P2-6', label: 'B opens a second child tab' });
    const child2TabId = bOpen2.value?.tabId ?? null;
    const bList2 = await invoke({ actor: 'B', tool: 'browser_tabs', args: { action: 'list' }, step: 'P2-6', label: 'B lists tabs after the second open' });
    const child2Row = tabRow(bList2.value, child2TabId);
    const child2RuntimeId = child2Row?.runtimeId ?? null;
    const nonce2 = `g1-p2-B2-${randomBytes(12).toString('hex')}`;
    const bNav2 = await invoke({ actor: 'B', tool: 'browser_navigate', args: { url: `${fixture.base}/B-work2` }, step: 'P2-6', label: 'B navigates its second child' });
    const bWrite2 = await invoke({ actor: 'B', tool: 'browser_eval', args: { expression: writeNonceExpression(nonce2) }, step: 'P2-6', label: 'B writes the second child nonce' });
    const bByteBefore = await invoke({ actor: 'B', tool: 'browser_eval', args: { expression: BYTE_STATE_EXPRESSION }, step: 'P2-6', label: 'B fingerprints its own page (before)' });
    const byteBefore = bByteBefore.value?.value ?? null;

    const idle2Ms = await realIdle(REAL_IDLE_MS);
    const idle2Valid = evidence.addWait({ id: 'P2-6-idle', scenario: 'P2', startedAtMonoMs: bByteBefore.completedAtMonoMs, requestedMs: REAL_IDLE_MS, measuredMs: round(idle2Ms) });

    const aSelect2 = await invoke({ actor: 'A', tool: 'browser_tabs', args: { action: 'select', tabId: child2TabId }, step: 'P2-6', label: 'A selects B\'s second child', quiesceBefore: true });
    const aEval2 = await invoke({ actor: 'A', tool: 'browser_eval', args: { expression: READ_EXPRESSION }, step: 'P2-6', label: 'A evaluates on the known target', quiesceBefore: true });
    const aNav2 = await invoke({ actor: 'A', tool: 'browser_navigate', args: { url: `${fixture.base}/scene-child2` }, step: 'P2-6', label: 'A navigates the known target' });
    // The navigate above is the one action that legitimately emits a request; quiesce again so a
    // late favicon from it can never be counted against the close below (measured: 19 ms late).
    const aClose2 = await invoke({ actor: 'A', tool: 'browser_tabs', args: { action: 'close', tabId: child2TabId }, step: 'P2-6', label: 'A closes the known target', quiesceBefore: true });
    const evalState = aEval2.value?.value ?? null;

    const bByteAfter = await invoke({ actor: 'B', tool: 'browser_eval', args: { expression: BYTE_STATE_EXPRESSION }, step: 'P2-6', label: 'B fingerprints its own page (after)' });
    const bListAfter2 = await invoke({ actor: 'B', tool: 'browser_tabs', args: { action: 'list' }, step: 'P2-6', label: 'B lists tabs after A\'s three writes' });
    const byteAfter = bByteAfter.value?.value ?? null;
    const child2RowAfter = tabRow(bListAfter2.value, child2TabId);
    const byteIdentical = Boolean(byteBefore) && Boolean(byteAfter) && JSON.stringify(byteBefore) === JSON.stringify(byteAfter);

    evidence.observe('P2', 'P2-6', 'B', {
      child2: { tabId: child2TabId, runtimeId: child2RuntimeId, url: byteBefore?.url ?? null, nonce: byteBefore?.nonce ?? null },
      byteBefore, byteAfter, byteIdentical,
      tabStillPresent: child2RowAfter !== null,
      idleMeasuredMs: round(idle2Ms), idleValid: idle2Valid,
    });
    evidence.observe('P2', 'P2-6', 'A', {
      select: { ok: aSelect2.result.ok, code: errorCode(aSelect2.result), ...dispatchEvidenceOf(aSelect2) },
      eval: { ok: aEval2.result.ok, code: errorCode(aEval2.result), nonce: evalState?.nonce ?? null, url: evalState?.url ?? null, runtimeId: aEval2.value?.tab?.runtimeId ?? null, ...dispatchEvidenceOf(aEval2) },
      navigate: { ok: aNav2.result.ok, code: errorCode(aNav2.result), runtimeId: aNav2.value?.tab?.runtimeId ?? null, ...dispatchEvidenceOf(aNav2) },
      close: { ok: aClose2.result.ok, code: errorCode(aClose2.result), ...dispatchEvidenceOf(aClose2) },
    });

    // Without this gate the three write checks below would pass vacuously on a broken fixture.
    evidence.check({
      id: 'P2-6-setup', scenario: 'P2', step: 'P2-6', kind: 'invariant',
      name: 'B really owns a fresh second work tab with its own nonce before A attacks it',
      expected: { child2TabId: '<uuid>', child2RuntimeIdDifferent: true, url: `${fixture.base}/B-work2`, nonce: nonce2, fingerprintComplete: true },
      observed: { child2TabId, child2RuntimeId, distinct: Boolean(child2RuntimeId) && child2RuntimeId !== aPrimaryRuntimeId, navigateOk: bNav2.result.ok, writeOk: bWrite2.result.ok, url: byteBefore?.url ?? null, nonce: byteBefore?.nonce ?? null, fingerprintComplete: bBeforeComplete(byteBefore) },
      pass: Boolean(child2TabId) && Boolean(child2RuntimeId) && child2RuntimeId !== aPrimaryRuntimeId
        && bNav2.result.ok === true && bWrite2.result.ok === true
        && byteBefore?.url === `${fixture.base}/B-work2` && byteBefore?.nonce === nonce2
        && bBeforeComplete(byteBefore),
    });

    evidence.checkPhase({
      id: 'P2-6a', scenario: 'P2', step: 'P2-6', kind: 'defect',
      name: 'close: A cannot close B\'s work tab by its known id, and the call dispatches nothing',
      bug: {
        expected: { close: 'ok (B\'s tab destroyed)', bTabStillPresent: false },
        pass: aClose2.result.ok === true && child2RowAfter === null,
      },
      fixed: {
        expected: { close: false, errorCode: OWNERSHIP_REFUSAL_CODES.join('|'), fixtureDispatch: 0, dispatchUrls: [], bTabStillPresent: true },
        pass: aClose2.result.ok === false && OWNERSHIP_REFUSAL_CODES.includes(errorCode(aClose2.result))
          && aClose2.activeHits.length === 0 && child2RowAfter !== null && child2RowAfter.runtimeId === child2RuntimeId,
      },
      observed: { closeOk: aClose2.result.ok, closeCode: errorCode(aClose2.result), bTabStillPresent: child2RowAfter !== null, child2RuntimeId, rowRuntimeId: child2RowAfter?.runtimeId ?? null, ...dispatchEvidenceOf(aClose2) },
    });

    evidence.checkPhase({
      id: 'P2-6b', scenario: 'P2', step: 'P2-6', kind: 'defect',
      name: 'navigate: A\'s navigation never lands on B\'s second tab',
      bug: {
        expected: { navigate: 'ok', landedRuntimeId: child2RuntimeId, fixtureDispatch: '>= 1 (a real navigation happened)' },
        pass: aNav2.result.ok === true && aNav2.value?.tab?.runtimeId === child2RuntimeId && aNav2.activeHits.length >= 1,
      },
      fixed: {
        expected: {
          anyOf: [
            { ok: false, errorCode: OWNERSHIP_REFUSAL_CODES.join('|'), fixtureDispatch: 0, dispatchUrls: [] },
            { ok: true, landedRuntimeId: 'A\'s own primary runtime (navigating its own page is legal)' },
          ],
        },
        pass: (aNav2.result.ok === false && OWNERSHIP_REFUSAL_CODES.includes(errorCode(aNav2.result)) && aNav2.activeHits.length === 0)
          || (aNav2.result.ok === true && aNav2.value?.tab?.runtimeId === aPrimaryRuntimeId && aNav2.value?.tab?.runtimeId !== child2RuntimeId),
      },
      observed: {
        navigateOk: aNav2.result.ok, navigateCode: errorCode(aNav2.result), landedRuntimeId: aNav2.value?.tab?.runtimeId ?? null,
        child2RuntimeId, aPrimaryRuntimeId, ...dispatchEvidenceOf(aNav2),
      },
      notes: 'The tool surface has no explicit target argument for navigate/eval, so "refused" can only mean either the call is refused, or it legally navigates A\'s own page. What must never happen is landing on B\'s tab.',
    });

    evidence.checkPhase({
      id: 'P2-6c', scenario: 'P2', step: 'P2-6', kind: 'defect',
      name: 'eval: A never reads B\'s second tab document, and the call dispatches nothing',
      bug: {
        expected: { nonce: nonce2, runtimeId: child2RuntimeId },
        pass: aEval2.result.ok === true && evalState?.nonce === nonce2 && aEval2.value?.tab?.runtimeId === child2RuntimeId,
      },
      fixed: {
        expected: { nonce: `!= ${nonce2}`, runtimeId: `!= ${child2RuntimeId}`, fixtureDispatch: 0, dispatchUrls: [] },
        pass: aEval2.result.ok === true && evalState?.nonce !== nonce2 && aEval2.value?.tab?.runtimeId !== child2RuntimeId
          && aEval2.activeHits.length === 0,
      },
      observed: { evalOk: aEval2.result.ok, evalCode: errorCode(aEval2.result), nonce: evalState?.nonce ?? null, url: evalState?.url ?? null, runtimeId: aEval2.value?.tab?.runtimeId ?? null, nonce2, child2RuntimeId, ...dispatchEvidenceOf(aEval2) },
    });

    evidence.checkPhase({
      id: 'P2-6d', scenario: 'P2', step: 'P2-6', kind: 'defect',
      name: 'B\'s work tab is byte-for-byte unchanged after all three write families',
      bug: {
        expected: { bOwnRead: 'refused or replaced document (the tab was taken over)', pageUnchanged: false },
        pass: bByteAfter.result.ok === false || byteIdentical === false,
      },
      fixed: {
        expected: { bOwnRead: 'ok', pageUnchanged: true, fields: 'url/title/nonce/form/counters/scroll/visibility/documentLength' },
        pass: bByteAfter.result.ok === true && byteIdentical === true && bBeforeComplete(byteBefore),
      },
      observed: { bOwnReadOk: bByteAfter.result.ok, bOwnReadCode: errorCode(bByteAfter.result), byteIdentical, byteBefore, byteAfter },
      notes: 'Compared as an exact JSON string of the page\'s own fingerprint (url/title/nonce/form/counters/scrollX/Y/visibility/documentLength), so "identical" is byte equality, not similarity.',
    });

    if (phaseMode === 'fixed' && !bBeforeComplete(byteBefore)) {
      evidence.notRun.push({ id: 'P2-6', item: 'byte-level page fingerprint', reason: 'B could not produce a complete fingerprint of its own page before the attack; the byte-equality assertion is therefore not evaluable' });
    }

    const caps = await invoke({ actor: 'A', tool: 'browser_capabilities', args: {}, step: 'P2-4', label: 'capacity after the attacks' });

    evidence.identities.P2 = {
      scenario: 'P2',
      harness: { clean: true, workspaceDir: env.cwd, name: 'g1-P2' },
      scope: aOpen.value?.scope ?? null,
      provider: { environment: aOpen.value?.environment ?? null, adapterId: aOpen.value?.adapterId ?? null, configRevision: aOpen.value?.configRevision ?? null },
      actors: {
        A: { id: actors.A.id, root: null, rootReason: 'the current baseline exposes no root/Team membership to the Web adapter session', sessionHeaderCwd: env.cwd },
        B: { id: actors.B.id, root: null, rootReason: 'same as A', sessionHeaderCwd: env.cwd },
        distinctAgentIds: actors.A.id !== actors.B.id,
        sameWorkspace: true,
      },
      canonical: {
        primaryA: { tabId: 'primary', runtimeId: aPrimaryRuntimeId, targetId: null, targetIdReason: 'CDP targetId is internal to index.js and not exposed by any tool result' },
        childB: { tabId: childTabId, runtimeId: childRuntimeId, targetId: null, targetIdReason: 'same as primary', source: childRow?.source ?? null, createdAt: childRow?.createdAt ?? null },
      },
      documentNonces: {
        A: { value: nonceA, storage: 'window.__g1Nonce (page memory)', localStorageUsed: false },
        B: { value: nonceB, storage: 'window.__g1Nonce (page memory)', localStorageUsed: false },
      },
      versions: {
        selectionRevisionA: aStateValue?.tab?.selectionRevision ?? null,
        leaseOwnerBeforeExpiry: aSelectBefore.result?.error?.details?.owner ?? null,
        childRowOwnerSeenByB: childRow?.owner ?? null,
        controlRevision: null,
        controlRevisionReason: 'no control-revision field exists on this baseline',
        targetEpoch: null,
        targetEpochReason: 'no target-epoch field exists on this baseline',
        executionVersion: null,
        executionVersionReason: 'not exposed',
      },
      selectionModel: {
        work: 'selectionFor(primaryKey, sessionId) → tabId; select implies a runtime.claim',
        observe: null,
        observeReason: 'no observe/work split exists on this baseline',
        controller: null,
        controllerReason: 'no controller or controlRevision field exists on this baseline; the lease owner is the only control signal',
      },
      capacityBefore: capsBeforeP2.value?.runtime?.workspaceIsolation ?? null,
      capacity: caps.value?.runtime?.workspaceIsolation ?? null,
    };

    evidence.observeComparison('P2', {
      summary: phaseMode === 'fixed'
        ? 'expected after the fix: A never selects, reads, navigates or closes B\'s child; both roots write in parallel'
        : 'observed on the baseline: A selects, reads, navigates and closes B\'s child after the lease lapses, and B is locked out of its own tab',
      before: {
        bChild: { tabId: childTabId, runtimeId: childRuntimeId, url: bChildState?.url ?? null, documentNonce: bChildState?.nonce ?? null, form: bChildState?.form ?? null, pageCounters: bChildState?.counters ?? null, leaseOwner: actors.B.id },
        aPrimary: { runtimeId: aPrimaryRuntimeId, url: aOwnState?.url ?? null, documentNonce: aOwnState?.nonce ?? null },
        capacity: capsBeforeP2.value?.runtime?.workspaceIsolation ?? null,
      },
      after: {
        bChild: { url: bAfterNavState?.url ?? aLandedState?.url ?? null, documentNonce: bAfterNavState?.nonce ?? null, runtimeId: bAfterNavState ? (bReadScene.value?.tab?.runtimeId ?? null) : null, leaseOwner: aSelectAfter.result.ok ? actors.A.id : null, bOwnRead: { ok: bReadScene.result.ok, errorCode: errorCode(bReadScene.result) }, bTabStillPresent: childRowFinal !== null },
        aPrimary: { runtimeId: aReadTarget.value?.tab?.runtimeId ?? null, url: aTargetState?.url ?? null, documentNonce: aTargetState?.nonce ?? null },
        aSelection: aSelectAfter.value?.selection ?? null,
        capacity: caps.value?.runtime?.workspaceIsolation ?? null,
      },
      verdictOnBaseline: aSelectAfter.result.ok === true && aLandedState?.nonce === null ? 'CROSS_SESSION_CHILD_TAKEOVER' : 'NOT_OBSERVED',
      notExposed: {
        scroll: 'no tool exposes scroll position of another session page on this baseline',
        visibility: 'no tool exposes document visibility of another session page on this baseline',
        observeSelection: 'the baseline has one selection per (primary entry, session); there is no observe/work split to compare',
        controller: 'no controller/controlRevision concept exists on this baseline (lease owner stands in)',
      },
    });

    scenarios.steps = {
      'P2-1': { aPrimaryRuntimeId, bStatus: bOnShared.result.ok ? 'B_GOT_PAGE' : bOnSharedCode, bRuntimeId: bOnSharedRuntime, distinctFromA: bOnSharedRuntime !== aPrimaryRuntimeId },
      'P2-2': { childTabId, childRuntimeId, bChildUrl: bChildState?.url ?? null, aOwnUrlUnaffected: aOwnState?.url ?? null },
      'P2-3': {
        selectBeforeExpiry: aSelectBefore.result.ok ? 'SELECTED' : aSelectBeforeCode,
        measuredIdleMs: round(idleMs), valid: idleValid,
        childRowSeenByA: childRowForA && { owner: childRowForA.owner, manageable: childRowForA.manageable, busy: childRowForA.busy },
      },
      'P2-4': {
        selectAfterExpiry: aSelectAfter.result.ok ? 'SELECTED' : aSelectAfterCode,
        aCurrentTarget: aTargetState?.url ?? null,
        navigateLandedOnBChild: aNavigateScene.value?.tab?.runtimeId === childRuntimeId,
        bDocumentAfter: { url: bAfterNavState?.url ?? null, nonce: bAfterNavState?.nonce ?? null, ownReadOk: bReadScene.result.ok },
        closeBChild: aClose.result.ok ? 'CLOSED' : errorCode(aClose.result),
        bTabStillPresent: childRowFinal !== null,
      },
      'P2-5': { aOwnWrite: aOwnWrite.result.ok, bOwnWrite: bOwnWrite.result.ok, bOwnWriteCode: errorCode(bOwnWrite.result) },
      'P2-6': {
        child2TabId, child2RuntimeId, idleMeasuredMs: round(idle2Ms), idleValid: idle2Valid,
        select: aSelect2.result.ok ? 'SELECTED' : errorCode(aSelect2.result),
        close: aClose2.result.ok ? 'CLOSED' : errorCode(aClose2.result),
        navigateLandedOnChild2: aNav2.value?.tab?.runtimeId === child2RuntimeId,
        evalReadChild2: evalState?.nonce === nonce2,
        byteIdentical, bTabStillPresent: child2RowAfter !== null,
      },
    };
    scenarios.status = 'completed';
    return { scenarios, teardown: () => env.teardown() };
  } catch (error) {
    scenarios.status = 'error';
    scenarios.error = String(error && error.stack || error);
    evidence.check({
      id: 'P2-X', scenario: 'P2', step: 'P2', kind: 'invariant',
      name: 'P2 scenario ran to completion',
      expected: { ran: true },
      observed: { ran: false, error: String(error && error.message || error) },
      pass: false,
    });
    return { scenarios, teardown: async () => [{ resource: 'scenario-error', error: String(error && error.message || error) }] };
  }
}

/* ------------------------------------------------------------------------------------------------
 * Cleanup bookkeeping: only what this run created.
 * ---------------------------------------------------------------------------------------------- */

function scanPluginChromeRecords() {
  try {
    return scanPluginChromeProcesses();
  } catch {
    return [];
  }
}

function readProcEntry(pid) {
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, 'utf8');
    const afterName = stat.slice(stat.lastIndexOf(')') + 2).split(' ');
    const ppid = Number(afterName[1]);
    let cmdline = '';
    try {
      cmdline = readFileSync(`/proc/${pid}/cmdline`, 'utf8').split('\u0000').filter(Boolean).join(' ');
    } catch { /* a process can vanish between the two reads */ }
    return { pid: Number(pid), ppid: Number.isFinite(ppid) ? ppid : null, cmdline };
  } catch {
    return null;
  }
}

/** Parent chain of one pid, nearest first. Stops at init or when /proc stops answering. */
function ancestryOf(pid, maxDepth = 12) {
  const chain = [];
  let current = pid;
  for (let depth = 0; depth < maxDepth; depth += 1) {
    const self = readProcEntry(current);
    if (!self || !self.ppid || self.ppid <= 1) break;
    const parent = readProcEntry(self.ppid);
    if (!parent) break;
    chain.push(parent);
    current = parent.pid;
  }
  return chain;
}

/** The DSH host that serves the user (it may itself own a plugin Chromium). */
function isHostProcess(cmdline) {
  const value = String(cmdline || '');
  return /\bdsh\b/u.test(value) && (/\bweb\b/u.test(value) || /--port[\s=]\d+/u.test(value));
}

function isNodeProcess(cmdline) {
  const value = String(cmdline || '');
  return /(^|\/|\s)node(\s|$)/u.test(value);
}

/**
 * Decide who owns one plugin Chromium process. The criterion is process ownership, never the
 * profile directory: a real leak from this run uses the same `/tmp/dsh-ui-testing-*` prefix as the
 * host's own browser, so ignoring that prefix would hide exactly what must be caught.
 *
 *   baseline (existed before this run)          → foreignChrome  pre-existing-before-this-run
 *   ancestry contains this runner's node pid    → LEAKED         descendant-of-this-run   (killable)
 *   ancestry contains the DSH host (`dsh … web`)→ foreignChrome  owned-by-host-process
 *   ancestry contains another node process      → foreignChrome  owned-by-another-node-process
 *   no attributable ancestor                    → LEAKED         unattributed-new-process (not killable)
 *
 * `cleanup.ok` is driven by the LEAKED bucket only; foreignChrome never fails a run.
 */
function classifyPluginChrome(record, { baselinePids, selfPid = process.pid, ancestry = null } = {}) {
  const base = {
    pid: record.pid,
    parentPid: record.parentPid ?? null,
    userDataDir: record.profileDir ?? null,
    bin: record.bin ?? null,
  };
  const chain = ancestry || ancestryOf(record.pid);
  const summarized = chain.map((entry) => ({ pid: entry.pid, cmdline: String(entry.cmdline || '').slice(0, 180) }));
  const host = chain.find((entry) => isHostProcess(entry.cmdline));
  const hostOwner = host ? { pid: host.pid, cmdline: String(host.cmdline || '').slice(0, 180) } : null;
  const preExisting = baselinePids instanceof Set && baselinePids.has(record.pid);

  // Ours first: a process this run started is a leak no matter what else is in the chain.
  if (chain.some((entry) => entry.pid === selfPid)) {
    return { ...base, bucket: 'leaked', reason: 'descendant-of-this-run', killable: true, preExisting, hostOwned: Boolean(host), ancestry: summarized, note: '本 run 的子进程树里残留，允许清理' };
  }
  // The user's own host browser: the exact false positive this criterion exists to remove.
  if (host) {
    return {
      ...base, bucket: 'foreign', reason: 'owned-by-host-process', killable: false, preExisting, hostOwned: true,
      owner: hostOwner, ancestry: summarized,
      note: '非本 run 创建，未处理（属于用户正在使用的 DSH 宿主）',
    };
  }
  if (preExisting) {
    return { ...base, bucket: 'foreign', reason: 'pre-existing-before-this-run', killable: false, preExisting, hostOwned: false, ancestry: summarized, note: '非本 run 创建，未处理' };
  }
  const otherNode = chain.find((entry) => isNodeProcess(entry.cmdline));
  if (otherNode) {
    return {
      ...base, bucket: 'foreign', reason: 'owned-by-another-node-process', killable: false, preExisting, hostOwned: false, ancestry: summarized,
      owner: { pid: otherNode.pid, cmdline: String(otherNode.cmdline || '').slice(0, 180) },
      note: '非本 run 创建，未处理（属于另一个 node 进程，可能是并行的其他验收）',
    };
  }
  return {
    ...base, bucket: 'leaked', reason: 'unattributed-new-process', killable: false, preExisting, hostOwned: false, ancestry: summarized,
    note: '本 run 期间新出现且无法归属到任何父进程；只报告不清理（不是我们创建的进程，无权 kill）',
  };
}

function pluginChromePids() {
  return scanPluginChromeRecords().map((entry) => entry.pid);
}

async function settle(promise, ms = 3000) {
  return Promise.race([promise, sleep(ms).then(() => ({ timedOutAfterMs: ms }))]);
}

/* ------------------------------------------------------------------------------------------------
 * CLI
 * ---------------------------------------------------------------------------------------------- */

const BOOLEAN_FLAGS = new Set(['dry-run', 'cleanup-self-check', 'help']);

function parseArgs(argv) {
  const options = { phase: null, runId: null, runsDir: null, repeatOf: null, dryRun: false, help: false };
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (!token.startsWith('--')) continue;
    const [rawKey, inlineValue] = token.slice(2).split('=');
    const key = rawKey.trim();
    if (BOOLEAN_FLAGS.has(key)) {
      // A boolean flag never consumes the next token, so `--dry-run --phase=…` stays valid.
      const name = key === 'dry-run' ? 'dryRun' : (key === 'cleanup-self-check' ? 'cleanupSelfCheck' : 'help');
      options[name] = inlineValue === undefined ? true : inlineValue !== 'false';
      continue;
    }
    const value = inlineValue !== undefined ? inlineValue : argv[index + 1];
    if (inlineValue === undefined) index += 1;
    if (key === 'phase') options.phase = String(value || '').trim();
    else if (key === 'run-id') options.runId = String(value || '').trim();
    else if (key === 'runs-dir') options.runsDir = String(value || '').trim();
    else if (key === 'repeat-of') options.repeatOf = String(value || '').trim();
  }
  return options;
}

function usage() {
  return [
    'Usage: node tests/acceptance/session-tab-ownership.mjs --phase=reproduce|verify-fixed',
    '                                                [--run-id=<id>] [--runs-dir=<dir>] [--repeat-of=<runId>]',
    '',
    '  --phase=reproduce      run §11.6 P1 + P2 against the current working-tree baseline;',
    '                         exit 0 only when the defect is reproduced (BUG_REPRODUCED).',
    '  --phase=verify-fixed   run the same attack protocol and judge it by the §11.6 post-fix',
    '                         requirements; exit 0 only when every one of them holds.',
    '',
    'Verdicts are derived, never hand-written (§11.8):',
    '  some check failed                 → NOT_FIXED / NOT_REPRODUCED, exit 1, fixedVerified:false',
    '  checks passed but not signable    → BLOCKED_CLEANUP, exit 2, fixedVerified:true',
    '  all green                         → FIX_VERIFIED / BUG_REPRODUCED, exit 0',
    '',
    '  --dry-run              static self-check only: no Chromium, no evidence, no worktree writes.',
    '  --cleanup-self-check   prove the cleanup ownership decision table (incl. a NEGATIVE case) without',
    '                         starting a browser; prints the live classification of this machine.',
    '  --repeat-of=<runId>    record this run as a repeat of an earlier run (§11.6 wants each',
    '                         scenario re-run in an independent clean run).',
    '',
    'A real run takes ~50 s (three uncut 16000 ms idle windows).',
  ].join('\n');
}

/**
 * `--dry-run`: static self-check. Loads nothing, starts no Chromium, writes no evidence and does
 * not touch the worktree. It proves the file parses, the protocol expressions are valid JavaScript
 * and the pure ownership/dispatch helpers behave as the two phases assume.
 */
/** Shared by --dry-run and --cleanup-self-check: the three-state verdict must be exhaustive. */
function verdictDerivationChecks(check) {
  const matrix = [];
  for (const phase of ['reproduce', 'verify-fixed']) {
    for (const checks of [true, false]) {
      for (const blocked of [[], ['cleanupLeakFree'], ['worktreeStableThroughRun']]) {
        matrix.push({ phase, checks, blocked, out: deriveVerdict({ phase, checksAllPassed: checks, blockedBy: blocked }) });
      }
    }
  }
  const expectedVerdicts = matrix.map((entry) => entry.out.verdict);
  check('verdict derivation: NOT_FIXED only when a check failed (verify-fixed)',
    matrix.filter((entry) => entry.phase === 'verify-fixed' && entry.checks === false).every((entry) => entry.out.verdict === 'NOT_FIXED' && entry.out.exitCode === 1 && entry.out.fixedVerified === false),
    expectedVerdicts);
  check('verdict derivation: NOT_REPRODUCED only when a check failed (reproduce)',
    matrix.filter((entry) => entry.phase === 'reproduce' && entry.checks === false).every((entry) => entry.out.verdict === 'NOT_REPRODUCED' && entry.out.exitCode === 1),
    expectedVerdicts);
  check('verdict derivation: checks passed + a blocked gate → BLOCKED_CLEANUP, exit 2, verified:true',
    matrix.filter((entry) => entry.checks === true && entry.blocked.length > 0).every((entry) => entry.out.verdict === 'BLOCKED_CLEANUP'
      && entry.out.exitCode === 2
      && (entry.phase === 'verify-fixed' ? entry.out.fixedVerified === true : entry.out.reproductionVerified === true)),
    expectedVerdicts);
  check('verdict derivation: cleanup is reported as blockedKind=cleanup, other gates as evidence',
    matrix.filter((entry) => entry.checks === true && entry.blocked.length > 0).every((entry) => entry.out.blockedKind === (entry.blocked.includes('cleanupLeakFree') ? 'cleanup' : 'evidence')),
    matrix.map((entry) => [entry.blocked, entry.out.blockedKind]));
  check('verdict derivation: everything passed → FIX_VERIFIED / BUG_REPRODUCED, exit 0',
    matrix.filter((entry) => entry.checks === true && entry.blocked.length === 0).every((entry) => entry.out.exitCode === 0
      && entry.out.verdict === (entry.phase === 'verify-fixed' ? 'FIX_VERIFIED' : 'BUG_REPRODUCED')
      && (entry.phase === 'verify-fixed' ? entry.out.fixedVerified === true : entry.out.reproductionVerified === true)),
    expectedVerdicts);
  const tripleBuckets = new Set(matrix.filter((entry) => entry.phase === 'verify-fixed').map((entry) => entry.out.verdict));
  check('verdict derivation: the three states are exactly {FIX_VERIFIED, NOT_FIXED, BLOCKED_CLEANUP}',
    tripleBuckets.size === 3 && ['FIX_VERIFIED', 'NOT_FIXED', 'BLOCKED_CLEANUP'].every((name) => tripleBuckets.has(name)),
    [...tripleBuckets]);
  check('verdict derivation: a blocked run is never labelled NOT_FIXED / NOT_REPRODUCED and always exits 2',
    matrix.filter((entry) => entry.out.verdict === 'BLOCKED_CLEANUP').every((entry) => entry.out.exitCode === 2
      && entry.out.verdict !== 'NOT_FIXED' && entry.out.verdict !== 'NOT_REPRODUCED'),
    matrix.filter((entry) => entry.out.verdict === 'BLOCKED_CLEANUP').map((entry) => [entry.phase, entry.out.exitCode]));

}

function selfCheck() {
  const failures = [];
  const check = (name, ok, detail) => {
    console.log(`${ok ? 'PASS' : 'FAIL'} ${name}`);
    if (!ok) failures.push({ name, detail });
    return ok;
  };

  // The protocol expressions must be syntactically valid JavaScript before any page sees them.
  for (const [name, expression] of [['READ_EXPRESSION', READ_EXPRESSION], ['BYTE_STATE_EXPRESSION', BYTE_STATE_EXPRESSION], ['writeNonceExpression', writeNonceExpression('nonce-probe')]]) {
    let ok = true;
    let detail = null;
    try {
      // Function() compiles without executing, which is exactly the guarantee wanted here.
      new Function(`return (${expression});`);
    } catch (error) {
      ok = false;
      detail = String(error && error.message || error);
    }
    check(`${name} compiles`, ok, detail);
  }

  // Ownership projection: complete row, partial row, absent row.
  const complete = ownershipSnapshot({ rootSessionId: 'A', ownerSessionId: 'A', controllerSessionId: 'A', ownershipRevision: 2, controlRevision: 5, accessVersion: 1 });
  check('ownershipSnapshot: complete row is present', complete.present === true && complete.missing.length === 0, complete);
  const partial = ownershipSnapshot({ rootSessionId: 'A', ownerSessionId: null, controllerSessionId: 'A', ownershipRevision: 2, controlRevision: 5 });
  check('ownershipSnapshot: null field is reported missing (never a soft pass)', partial.present === false && partial.missing.join(',') === 'ownerSessionId', partial);
  const absent = ownershipSnapshot({ tabId: 'primary', runtimeId: 'r1' });
  check('ownershipSnapshot: baseline row (no projection) is reported absent with all fields named', absent.present === false && absent.missing.length === OWNERSHIP_REQUIRED_FIELDS.length, absent);
  check('ownershipSnapshot: absent row is handled', ownershipSnapshot(null).present === false, ownershipSnapshot(null));
  check('sameOwnership: recognises equality and a changed revision', sameOwnership(complete, { ...complete }) === true
    && sameOwnership(complete, ownershipSnapshot({ rootSessionId: 'A', ownerSessionId: 'A', controllerSessionId: 'A', ownershipRevision: 3, controlRevision: 5 })) === false);
  check('missingFieldFor: null when complete, list when not', missingFieldFor(complete) === null && Array.isArray(missingFieldFor(partial)) === true);

  // Refusal-code policy: BUSY must never be accepted as an ownership refusal.
  check('OWNERSHIP_REFUSAL_CODES excludes BUSY', OWNERSHIP_REFUSAL_CODES.includes('BUSY') === false
    && OWNERSHIP_REFUSAL_CODES.includes('TAB_FORBIDDEN') && OWNERSHIP_REFUSAL_CODES.includes('TAB_NOT_FOUND') && OWNERSHIP_REFUSAL_CODES.includes('TAB_CONTROL_CHANGED'), [...OWNERSHIP_REFUSAL_CODES]);
  check('isStructuredNonBusyRefusal rejects BUSY and empty codes', isStructuredNonBusyRefusal('BUSY') === false
    && isStructuredNonBusyRefusal('') === false && isStructuredNonBusyRefusal(null) === false
    && isStructuredNonBusyRefusal('TARGET_NOT_BOUND') === true);
  check('bBeforeComplete requires a full fingerprint', bBeforeComplete({ url: 'u', title: 't', nonce: 'n', form: 'f', scrollX: 0, scrollY: 0, visibility: 'visible', documentLength: 10 }) === true
    && bBeforeComplete({ url: 'u' }) === false && bBeforeComplete(null) === false);

  // Byte comparison is exact-string equality, not a tolerance.
  const fingerprint = { url: 'u', title: 't', nonce: 'n', form: 'f', counters: { input: 0, click: 0 }, scrollX: 0, scrollY: 0, visibility: 'visible', documentLength: 10, textLength: 3 };
  check('byte comparison is exact equality', JSON.stringify(fingerprint) === JSON.stringify({ ...fingerprint })
    && JSON.stringify(fingerprint) !== JSON.stringify({ ...fingerprint, nonce: 'other' }));

  verdictDerivationChecks(check);

  // Dispatch attribution: passive browser requests never count as dispatch, but never vanish.
  check('isPassiveRequest: favicon/robots/well-known are passive, a page URL is not',
    isPassiveRequest('/favicon.ico') === true && isPassiveRequest('/robots.txt') === true
    && isPassiveRequest('/.well-known/security.txt') === true
    && isPassiveRequest('/scene-child2') === false && isPassiveRequest('/B-work') === false
    && isPassiveRequest(null) === false);
  const split = classifyHits([{ url: '/favicon.ico' }, { url: '/scene-child2' }, { url: '/robots.txt' }]);
  check('classifyHits: splits active vs passive and keeps every entry',
    split.active.length === 1 && split.active[0].url === '/scene-child2'
    && split.passive.length === 2 && split.active.length + split.passive.length === 3);
  const attribution = dispatchEvidenceOf({
    activeHits: [], passiveHits: [{ url: '/favicon.ico' }], hits: [{ url: '/favicon.ico' }],
    quiesce: { quiet: true, waitedMs: 412, sinceLastRequestMs: 301, arrivedDuringQuiesce: [{ url: '/favicon.ico' }] },
  });
  check('dispatchEvidenceOf: a passive-only window reports fixtureDispatch 0 but still lists ignoredPassive',
    attribution.fixtureDispatch === 0 && attribution.dispatchUrls.length === 0
    && attribution.ignoredPassive.join(',') === '/favicon.ico' && attribution.rawRequestCount === 1
    && attribution.quiesce.status === 'quiet' && attribution.quiesce.arrivedDuringQuiesce.join(',') === '/favicon.ico');
  const timedOut = dispatchEvidenceOf({ activeHits: [], passiveHits: [], hits: [], quiesce: { quiet: false, waitedMs: 2000, sinceLastRequestMs: 12, arrivedDuringQuiesce: [] } });
  check('dispatchEvidenceOf: an unquiescable window is reported as timeout (never hidden)',
    timedOut.quiesce.status === 'timeout' && timedOut.quiesce.waitedMs === 2000);
  check('a non-passive request in the window still counts as dispatch', dispatchEvidenceOf({ activeHits: [{ url: '/scene-child2' }], passiveHits: [], hits: [{ url: '/scene-child2' }], quiesce: null }).fixtureDispatch === 1);
  check('quiesce policy constants are 300ms quiet / 2000ms ceiling', QUIESCE_MIN_QUIET_MS === 300 && QUIESCE_MAX_MS === 2000);

  // Phase semantics are fixed by the flag, never by an observation.
  check('expectationMode is derived from --phase only', expectationModeFor('reproduce') === 'bug'
    && expectationModeFor('verify-fixed') === 'fixed' && expectationModeFor('anything-else') === 'bug');

  // Idle windows are configured, not shortened.
  check('real idle window is 16000ms and the validity floor is 15000ms', REAL_IDLE_MS === 16000 && MIN_VALID_IDLE_MS === 15000);
  return failures;
}

/**
 * `--cleanup-self-check`: unit-level proof of the ownership decision table plus a live scan of this
 * machine. It starts no browser and writes no evidence.
 */
function cleanupSelfCheck() {
  const failures = [];
  const check = (name, ok, detail) => {
    console.log(`${ok ? 'PASS' : 'FAIL'} ${name}`);
    if (!ok) failures.push({ name, detail });
    return ok;
  };
  const baselinePids = new Set([1001]);
  const record = (pid) => ({ pid, parentPid: 2000, profileDir: `/tmp/dsh-ui-testing-${pid}`, bin: '/opt/google/chrome/chrome' });
  const hostAncestry = [
    { pid: 2000, cmdline: 'node /home/dev/.local/share/dsh24/bin/dsh web --port 3080' },
    { pid: 1999, cmdline: 'bash /home/dev/.local/bin/dsh-web.sh' },
    { pid: 1, cmdline: '/sbin/init' },
  ];

  // 1. Host-owned is foreign even when it also existed before the run (the measured false positive).
  const hostPreExisting = classifyPluginChrome(record(1001), { baselinePids, selfPid: 9999, ancestry: hostAncestry });
  check('pre-existing + host-owned → foreignChrome, reason owned-by-host-process, not killable',
    hostPreExisting.bucket === 'foreign' && hostPreExisting.reason === 'owned-by-host-process'
    && hostPreExisting.preExisting === true && hostPreExisting.hostOwned === true
    && hostPreExisting.killable === false, hostPreExisting);
  const preExistingOnly = classifyPluginChrome(record(1001), { baselinePids, selfPid: 9999, ancestry: [{ pid: 3001, cmdline: 'bash -c other' }, { pid: 1, cmdline: '/sbin/init' }] });
  check('pre-existing without host/self ancestry → foreignChrome (pre-existing-before-this-run)',
    preExistingOnly.bucket === 'foreign' && preExistingOnly.reason === 'pre-existing-before-this-run', preExistingOnly);

  // 2. Descendant of this runner → leaked and killable.
  const own = classifyPluginChrome(record(1002), { baselinePids, selfPid: 9999, ancestry: [{ pid: 9999, cmdline: 'node tests/acceptance/session-tab-ownership.mjs' }, ...hostAncestry] });
  check('descendant of this node → leaked + killable', own.bucket === 'leaked' && own.reason === 'descendant-of-this-run' && own.killable === true, own);

  // 3. The measured host case: parent is `dsh web --port 3080`.
  const host = classifyPluginChrome(record(1003), { baselinePids, selfPid: 9999, ancestry: hostAncestry });
  check('host-owned (dsh web) → foreignChrome, not leaked, not killable',
    host.bucket === 'foreign' && host.reason === 'owned-by-host-process' && host.killable === false
    && host.owner && host.owner.pid === 2000, host);

  // 4. Another node process (a parallel acceptance run) → foreign, so neighbours never fail us.
  const neighbour = classifyPluginChrome(record(1004), { baselinePids, selfPid: 9999, ancestry: [{ pid: 4321, cmdline: 'node tests/acceptance/p0e-multitab.mjs' }, { pid: 1, cmdline: '/sbin/init' }] });
  check('descendant of another node process → foreignChrome (owned-by-another-node-process)',
    neighbour.bucket === 'foreign' && neighbour.reason === 'owned-by-another-node-process' && neighbour.owner.pid === 4321, neighbour);

  // 5. NEGATIVE: appeared during the run, not ours, no owning ancestor → leaked, and never killed.
  const foreign = classifyPluginChrome(record(1005), { baselinePids, selfPid: 9999, ancestry: [{ pid: 3000, cmdline: 'bash -c some-script' }, { pid: 1, cmdline: '/sbin/init' }] });
  check('NEGATIVE: unattributable new plugin chrome → leaked (ok would be false) and left untouched',
    foreign.bucket === 'leaked' && foreign.reason === 'unattributed-new-process' && foreign.killable === false, foreign);

  // The three-state verdict derivation must be mutually exclusive and exhaustive (task-14).
  verdictDerivationChecks(check);

  // Live scan of this machine (no verdict, just the current classification).
  const live = scanPluginChromeRecords().map((entry) => classifyPluginChrome(entry, { baselinePids: new Set(), selfPid: process.pid }));
  console.log(`# live plugin chromium on this machine: ${live.length}`);
  for (const entry of live) {
    console.log(`#   pid=${entry.pid} bucket=${entry.bucket} reason=${entry.reason} userDataDir=${entry.userDataDir} parent=${JSON.stringify((entry.ancestry[0] || {}).cmdline || null)}`);
  }
  return { failures, live };
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help || (!options.phase && !options.dryRun && !options.cleanupSelfCheck)) {
    console.error(usage());
    return 2;
  }
  if (options.phase === null || options.phase === undefined) options.phase = 'verify-fixed';
  if (!['reproduce', 'verify-fixed'].includes(options.phase)) {
    console.error(`unknown --phase=${options.phase}\n\n${usage()}`);
    return 2;
  }

  if (options.cleanupSelfCheck) {
    console.log('# cleanup-self-check: ownership decision table + live scan (no Chromium, no evidence)');
    const result = cleanupSelfCheck();
    if (result.failures.length > 0) {
      console.log(`# SELF_CHECK_FAILED ${JSON.stringify(result.failures)}`);
      console.log('SELF_CHECK_FAILED');
      return 2;
    }
    console.log('# SELF_CHECK_OK');
    console.log('CLEANUP_SELF_CHECK_OK');
    return 0;
  }

  if (options.dryRun) {
    console.log(`# dry-run: phase=${options.phase} expectationMode=${options.phase === 'verify-fixed' ? 'fixed' : 'bug'} (no Chromium, no evidence, no worktree writes)`);
    console.log('# plan: P1 [P1-1a,P1-1b,P1-2a,P1-3,P1-3b,P1-7,P1-4a,P1-4b,P1-4c,P1-4d,P1-5,P1-6]');
    console.log('# plan: P2 [P2-1a,P2-1b,P2-2a,P2-2b,P2-2c,P2-5a,P2-3a,P2-3b,P2-3c,P2-3d,P2-4a,P2-4b,P2-5b,P2-4c,P2-4d,P2-6-setup,P2-6a,P2-6b,P2-6c,P2-6d]');
    console.log(`# real idle windows per run: 3 x ${REAL_IDLE_MS}ms (P1-3, P2-3c, P2-6-idle)`);
    const failures = selfCheck();
    if (failures.length > 0) {
      console.log(`# SELF_CHECK_FAILED ${JSON.stringify(failures)}`);
      console.log('SELF_CHECK_FAILED');
      return 2;
    }
    console.log('# SELF_CHECK_OK');
    console.log('DRY_RUN_OK');
    return 0;
  }

  const runId = options.runId || `${new Date().toISOString().replace(/[:.]/g, '-')}-${randomBytes(3).toString('hex')}`;
  const runsRoot = options.runsDir
    ? (isAbsolute(options.runsDir) ? options.runsDir : resolve(REPO_ROOT, options.runsDir))
    : join(HERE, 'runs');
  const evidence = new Evidence({ runId, phase: options.phase, dir: join(runsRoot, runId) });

  console.log(`# G1 session-tab-ownership phase=${options.phase} runId=${runId}`);
  console.log(`# evidence: ${evidence.dir}`);

  const chromeBaselineRecords = scanPluginChromeRecords();
  const chromeBaselinePids = new Set(chromeBaselineRecords.map((entry) => entry.pid));
  let exitCode = 1;
  let runNonce = null;
  const teardowns = [];

  try {
    runNonce = randomBytes(8).toString('hex');
    evidence.writeManifest({
      nonce: { strategy: 'crypto.randomBytes(8) per run', storage: 'page memory (window.__g1Nonce)', localStorageUsed: false },
      expectationMode: evidence.expectationMode,
      phaseMeaning: options.phase === 'reproduce'
        ? 'reproduce: pass means the OLD single-owner-lease behaviour was observed (§11.4 G1)'
        : 'verify-fixed: pass means the fix candidate satisfied every §11.6 post-fix requirement (§11.4 G2); the same attack protocol and the same real 16 s idles are used',
    });

    // P1 then P2, each in its own clean harness — §11.6 requires independent clean runs.
    const p1 = await runP1(evidence, runNonce);
    teardowns.push(p1.teardown);
    const p1Cleanup = await settle(p1.teardown());
    evidence.cleanup.steps.push({ scenario: 'P1', ...(Array.isArray(p1Cleanup) ? { results: p1Cleanup } : p1Cleanup) });

    const p2 = await runP2(evidence, runNonce);
    teardowns.push(p2.teardown);
    const p2Cleanup = await settle(p2.teardown());
    evidence.cleanup.steps.push({ scenario: 'P2', ...(Array.isArray(p2Cleanup) ? { results: p2Cleanup } : p2Cleanup) });

    evidence.scenarios = { P1: p1.scenarios, P2: p2.scenarios };
  } catch (error) {
    evidence.notRun.push({ id: 'RUN', item: 'unexpected top-level failure', reason: String(error && error.stack || error) });
    console.error(`# top-level failure: ${String(error && error.stack || error)}`);
    // Fall through: teardown + report still happen, the verdict stays NOT_REPRODUCED.
    for (const teardown of teardowns.reverse()) {
      try { evidence.cleanup.steps.push({ late: true, ...(await settle(teardown())) }); } catch { /* best effort */ }
    }
  } finally {
    // ---- cleanup verification: judged by PROCESS OWNERSHIP, never by profile directory ----
    const classifyAfter = () => scanPluginChromeRecords()
      .map((record) => classifyPluginChrome(record, { baselinePids: chromeBaselinePids }));
    const afterAll = classifyAfter();
    const leakedNow = afterAll.filter((entry) => entry.bucket === 'leaked');
    const killable = leakedNow.filter((entry) => entry.killable);
    const killedPids = [];
    for (const entry of killable) {
      // Only processes we can prove we started (descendant of this node) are cleaned up.
      try { process.kill(entry.pid, 'SIGKILL'); killedPids.push(entry.pid); } catch { /* already gone */ }
    }
    if (killedPids.length > 0) await sleep(200);
    const finalAll = killedPids.length > 0 ? classifyAfter() : afterAll;
    const finalLeaked = finalAll.filter((entry) => entry.bucket === 'leaked');
    const foreignChrome = finalAll.filter((entry) => entry.bucket === 'foreign');

    evidence.cleanup = {
      ...evidence.cleanup,
      chromeProcesses: {
        baseline: chromeBaselineRecords.map((entry) => ({ pid: entry.pid, parentPid: entry.parentPid, profileDir: entry.profileDir })),
        afterRun: afterAll,
        killed: killedPids,
        final: finalAll,
        leaked: finalLeaked.map((entry) => entry.pid),
        foreignChrome: foreignChrome.map((entry) => entry.pid),
      },
      // New first-class field: plugin Chromium that this run did NOT create and must not touch.
      foreignChrome,
      leaked: finalLeaked,
      pluginChromeRemaining: finalLeaked.map((entry) => entry.pid),
      attribution: {
        criterion: 'parent-chain ownership (this runner node pid / DSH host / another node process / unattributable) — never the /tmp/dsh-ui-testing-* directory name',
        selfPid: process.pid,
        hostPattern: 'cmdline matches /\\bdsh\\b/ and (/\\bweb\\b/ or --port <n>)',
        decisionTable: [
          { condition: 'ancestor is this runner node pid', bucket: 'leaked', reason: 'descendant-of-this-run', cleaned: true },
          { condition: 'ancestor is the DSH host', bucket: 'foreignChrome', reason: 'owned-by-host-process' },
          { condition: 'existed before this run', bucket: 'foreignChrome', reason: 'pre-existing-before-this-run' },
          { condition: 'ancestor is another node process', bucket: 'foreignChrome', reason: 'owned-by-another-node-process' },
          { condition: 'no attributable ancestor', bucket: 'leaked', reason: 'unattributed-new-process', cleaned: false },
        ],
      },
      ok: finalLeaked.length === 0
        && !evidence.cleanup.steps.some((step) => step.error || step.timedOutAfterMs)
        && evidence.cleanup.steps.length > 0,
    };

    {
      const applicable = evidence.checks.filter((entry) => entry.applicable !== false);
      const failures = applicable.filter((entry) => entry.pass !== true);
      // Three real idle windows (P1-3, P2-3c, P2-6-idle): every one must be genuinely >= 15000ms.
      const waitsValid = evidence.waits.length === 3 && evidence.waits.every((wait) => wait.valid === true);
      const identitiesValid = [evidence.identities.P1, evidence.identities.P2].every((identity) => identity
        && identity.scope && identity.scope.kind === 'workspace' && identity.scope.degraded === false
        && identity.actors.distinctAgentIds === true);
      const scenarioStatuses = ['P1', 'P2'].map((key) => evidence.scenarios[key]);

      const integrity = evidence.integrityCheck();
      // "The checks passed" and "this run is signable" are two different questions (§11.8): the
      // first is about the code under test, the second also about evidence quality and cleanup.
      const checksAllPassed = failures.length === 0 && applicable.length > 0;

      if (!evidence.notRun.some((entry) => entry.id === 'X04-X06')) {
        evidence.notRun.push(
          { id: 'X04-X06', item: 'team preset / cross-root binding / config-provider bypasses', reason: 'NOT_RUN: this runner only covers the §11.6 primary and child protocol; the other X cases need their own harness' },
          { id: 'T01-T06', item: 'native Team roles and membership', reason: 'NOT_RUN: requires a real host Team (plan §11.7 P3, runner team-tab-access.mjs, not created yet)' },
          { id: 'R01-R16', item: 'deterministic concurrency, lifecycle and bypass matrix', reason: 'NOT_RUN: requires barrier-controlled queue harness (plan §11.7 P4/P5, runner tab-control-races.mjs, not created yet)' },
          { id: 'GUI', item: 'panel/frame screenshots for the takeover', reason: 'NOT_RUN: this runner is tool-surface only; no GUI panel is driven' },
          { id: 'G2-G4', item: 'fix / Team / regression gates', reason: 'NOT_RUN: G1 only; a fix candidate does not exist yet (§11.4)' },
        );
      }
      evidence.writeIdentities();
      evidence.writeBeforeAfter();
      const scenariosCompleted = scenarioStatuses.every((scenario) => scenario && scenario.status === 'completed');
      const gateMap = {
        // check-level gates (a false here means the code under test did not meet the phase)
        [options.phase === 'reproduce' ? 'allChecksMatchedBugBaseline' : 'allFixedRequirementsMet']: checksAllPassed,
        // non-check gates (a false here does NOT mean the fix failed; it means this run cannot be signed)
        allRealIdleWindowsValid: waitsValid,
        identitiesAreTwoDistinctAgentsInOneRegisteredWorkspace: identitiesValid,
        bothScenariosCompleted: scenariosCompleted,
        worktreeStableThroughRun: integrity.worktreeStable,
        cleanupLeakFree: evidence.cleanup.ok,
      };
      const blockedBy = Object.entries(gateMap)
        .filter(([name, ok]) => ok !== true && name !== (options.phase === 'reproduce' ? 'allChecksMatchedBugBaseline' : 'allFixedRequirementsMet'))
        .map(([name]) => name);
      // Derived, never written by hand (§11.8 three-state verdict).
      const derivation = deriveVerdict({ phase: options.phase, checksAllPassed, blockedBy });
      const verdict = derivation.verdict;
      const reproductionVerified = derivation.reproductionVerified;
      const fixedVerified = derivation.fixedVerified;
      const report = evidence.writeReport({
        verdict,
        // The three independent booleans the verdict is derived from, written out explicitly.
        checksAllPassed,
        cleanupLeakFree: evidence.cleanup.ok,
        reproductionVerified,
        fixedVerified,
        exitCode: derivation.exitCode,
        blockedKind: derivation.blockedKind,
        phaseMeaning: options.phase === 'reproduce'
          ? 'reproduce: reproductionVerified=true means the OLD behaviour was observed; fixedVerified stays false by construction'
          : 'verify-fixed: fixedVerified=true means every §11.6 post-fix requirement passed; reproductionVerified stays false (G1 and G2 are never the same run)',
        integrity,
        gates: gateMap,
        // A negative verdict must always say which gate produced it, even with 0 failed checks.
        blockedBy,
        cleanupOk: evidence.cleanup.ok,
        dispatchAttribution: {
          policy: PASSIVE_REQUEST_POLICY,
          passivePrefixes: [...PASSIVE_REQUEST_PREFIXES],
          quiesceMinQuietMs: QUIESCE_MIN_QUIET_MS,
          quiesceMaxMs: QUIESCE_MAX_MS,
          note: 'zero-dispatch checks count only attributable requests; passive ones stay in calls.jsonl under ignoredPassive; a non-passive request inside the window still fails the check and its URL is printed',
        },
        relatedRuns: options.repeatOf ? [{ runId: options.repeatOf, relation: 'repeat-of' }] : [],
        nonce: runNonce,
      });
      console.log(`# checks: ${report.totals.passed}/${report.totals.checks} passed (${report.totals.notApplicableInThisPhase} not applicable in this phase)`);
      console.log(`# waits: ${evidence.waits.map((wait) => `${wait.id}=${wait.measuredMs}ms valid=${wait.valid}`).join(' ')}`);
      console.log(`# cleanup: ok=${evidence.cleanup.ok} leaked=${JSON.stringify(evidence.cleanup.leaked.map((entry) => entry.pid))} foreignChrome=${JSON.stringify(evidence.cleanup.foreignChrome.map((entry) => entry.pid))}`);
      if (blockedBy.length > 0) {
        console.log(`# NOT SIGNED OFF: ${JSON.stringify(blockedBy)} (kind=${derivation.blockedKind}, failed checks: ${failures.length}) — the checks themselves ${checksAllPassed ? 'passed' : 'failed'}`);
      }
      if (!integrity.worktreeStable) {
        console.log(`# WORKTREE CHANGED DURING RUN — verdict cannot be signed off: changed=${JSON.stringify(integrity.changedSourceFiles)} planDrift=${JSON.stringify(integrity.planFingerprintDrift)} headBefore=${integrity.headBefore} headAfter=${integrity.headAfter}`);
      }
      if (failures.length > 0) {
        console.log(`# ${verdict} because ${failures.length} check(s) did not meet the ${evidence.expectationMode}-phase expectation:`);
        for (const failure of failures) console.log(`#   ${failure.id} expected(${failure.expectationMode})=${JSON.stringify(failure.expected)} observed=${JSON.stringify(failure.observed)}`);
      }
      console.log(`# duration: ${report.durationMs}ms`);
      console.log(verdict);
      exitCode = derivation.exitCode;
    }
  }

  return exitCode;
}

const code = await main();
process.exitCode = Number.isInteger(code) ? code : 1;
