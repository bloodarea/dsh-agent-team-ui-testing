/**
 * Platform parity: the Web/Chromium adapter must behave identically on Linux, macOS and
 * Windows hosts. Every platform-dependent branch is exercised here by injecting `platform`
 * instead of relying on the runner's own OS, so the same assertions run everywhere (and in a
 * CI matrix they catch a change that only holds on one platform).
 *
 * Two rules keep the file host-independent, which is the whole point:
 *  - discovery order is asserted through `chromeCandidatePaths` (pure strings, no filesystem);
 *  - discovery itself is asserted with fixtures built by the *same* host `join` the resolver uses,
 *    so the files exist on whatever host runs the suite (on POSIX a Windows tail simply becomes a
 *    directory name containing backslashes).
 * Only the resolution cache needs its own host: it reads/writes on `process.platform` by design.
 *
 * Contract: docs/getting-started.md (browser discovery), docs/capture-p0.md (output paths).
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { chromeCandidatePaths, resolveChromeExecutable } from '../index.js';
import { resolveCapturePath } from '../capture-p0.js';

function withScratch(fn) {
  const root = mkdtempSync(join(tmpdir(), 'dsh-platform-'));
  try {
    return fn(root);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

/** A candidate fixture: an absolute file with the execute bit POSIX needs (win32 ignores it). */
function stubFile(file) {
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, 'stub');
  chmodSync(file, 0o755);
  return file;
}

/** Capture the BrowserError a call is expected to throw (assert.throws does not return it). */
function captureError(fn) {
  try {
    fn();
  } catch (error) {
    return error;
  }
  assert.fail('expected the call to throw a BrowserError');
}

/** The discovery error carries the candidate list, so a missing browser is assertable. */
function candidatesFrom(error) {
  return error && error.details && Array.isArray(error.details.candidates) ? error.details.candidates : [];
}

/** path.join follows the *host* separator, so compare candidate strings with separators normalised. */
function normalise(candidate) {
  return String(candidate).split('\\').join('/');
}

/** The resolution cache only reads/writes on the host platform, so its isolation needs a win32 host. */
const win32HostOnly = process.platform === 'win32'
  ? test
  : (name, fn) => test(name, { skip: 'requires a win32 host: the resolution cache is host-platform keyed' }, fn);

test('win32: the candidate list is %ProgramFiles% tails + .exe PATH shims, never the POSIX default', () => {
  const candidates = chromeCandidatePaths({
    platform: 'win32',
    env: { PROGRAMFILES: 'C:\\Program Files', PATH: '' },
    pathDirs: ['C:\\bin'],
  }).map(normalise);

  assert.ok(!candidates.some((candidate) => candidate.startsWith('/opt')), 'win32 must not list /opt');
  assert.ok(
    candidates.includes('C:/Program Files/Google/Chrome/Application/chrome.exe'),
    'the stable channel tail must be offered under %ProgramFiles%',
  );
  assert.ok(
    candidates.includes('C:/Program Files/Chromium/Application/chrome.exe'),
    'the Chromium tail must be offered under %ProgramFiles%',
  );
  // The POSIX names can never match a Windows shim, so only *.exe names are tried on PATH.
  assert.deepEqual(
    candidates.filter((candidate) => candidate.startsWith('C:/bin/')),
    [
      'C:/bin/chrome.exe', 'C:/bin/google-chrome-stable.exe', 'C:/bin/google-chrome.exe',
      'C:/bin/chromium.exe', 'C:/bin/chromium-browser.exe',
    ],
    'PATH must be probed with the Windows names only',
  );
});

test('win32: chrome.exe under %ProgramFiles% is discovered without any env override', () => {
  withScratch((root) => {
    // Same host join as the resolver: the fixture is discoverable on every host, Windows tail or not.
    const expected = stubFile(join(root, 'Google\\Chrome\\Application\\chrome.exe'));
    const found = resolveChromeExecutable({
      platform: 'win32',
      env: { PROGRAMFILES: root, PATH: '' },
      pathDirs: [],
    });
    assert.equal(found, expected);
  });
});

test('win32: a bare command name on PATH resolves through PATHEXT, not the literal name', () => {
  withScratch((root) => {
    const expected = stubFile(join(root, 'chrome.exe'));
    const found = resolveChromeExecutable({
      platform: 'win32', env: {}, pathDirs: [root], override: { present: true, value: 'chrome' },
    });
    assert.equal(found, expected);
  });
});

test('win32: the POSIX default candidate is not offered there', () => {
  // Runs on every host: on Linux the built-in /opt path really exists, so a regression that
  // stopped suppressing it there would resolve instead of throwing.
  const error = captureError(() => resolveChromeExecutable({ platform: 'win32', env: { PATH: '' }, pathDirs: [] }));
  assert.equal(error.code, 'UNSUPPORTED');
  assert.ok(!candidatesFrom(error).some((candidate) => normalise(candidate).startsWith('/opt')), 'win32 must not list /opt');
});

test('linux: /opt default and POSIX PATH names are offered, never .exe names', () => {
  const candidates = chromeCandidatePaths({ platform: 'linux', env: {}, pathDirs: ['/usr/bin'] }).map(normalise);
  assert.ok(candidates.includes('/opt/google/chrome/chrome'), 'POSIX default candidate must be kept');
  assert.ok(candidates.includes('/usr/bin/google-chrome-stable'), 'POSIX PATH name must be kept');
  assert.ok(!candidates.some((candidate) => candidate.endsWith('.exe')), 'linux must not list .exe names');
});

test('darwin: application bundles stay in the candidate list', () => {
  const candidates = chromeCandidatePaths({ platform: 'darwin', env: {}, pathDirs: [] });
  assert.ok(candidates.includes('/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'));
});

win32HostOnly('a resolved browser is cached per platform: a win32 hit never leaks into a linux lookup', () => {
  withScratch((root) => {
    const windowsBinary = stubFile(join(root, 'Google\\Chrome\\Application\\chrome.exe'));
    assert.equal(resolveChromeExecutable({
      platform: 'win32', env: { PROGRAMFILES: root, PATH: '' }, pathDirs: [],
    }), windowsBinary);
    // Same process, different platform: the cache key includes the platform, so this must miss.
    const error = captureError(() => resolveChromeExecutable({ platform: 'linux', env: {}, pathDirs: [] }));
    assert.equal(error.code, 'UNSUPPORTED');
    assert.ok(!candidatesFrom(error).includes(windowsBinary));
  });
});

test('isExecutableFile: an extensionless readable file is refused on win32 only', () => {
  withScratch((root) => {
    const file = stubFile(join(root, 'win.ini'));
    const override = { present: true, value: file };
    // Windows cannot execute it (X_OK is a no-op there), so the override is an operator error.
    const win32 = captureError(() => resolveChromeExecutable({ platform: 'win32', env: {}, pathDirs: [], override }));
    assert.equal(win32.code, 'UNSUPPORTED');
    // On POSIX the same path is executable and stays authoritative (unchanged behaviour).
    assert.equal(resolveChromeExecutable({ platform: 'linux', env: {}, pathDirs: [], override }), file);
  });
});

test('capture output paths: the POSIX-separator contract holds on every platform', () => {
  withScratch((root) => {
    const workspace = join(root, '工作区');
    mkdirSync(workspace, { recursive: true });
    const forward = resolveCapturePath({ root: workspace, out: 'shots/子目录/a.png', defaultName: 'output/capture/x.png' });
    assert.equal(forward.ok, true);
    assert.equal(forward.relativePath, 'shots/子目录/a.png');
    // Backslashes stay rejected everywhere: they are legal filename characters on POSIX.
    const backslash = resolveCapturePath({ root: workspace, out: 'shots\\a.png', defaultName: 'output/capture/x.png' });
    assert.equal(backslash.ok, false);
    assert.equal(backslash.details.reason, 'out_backslash');
    // Traversal and absolute paths are rejected regardless of the separator style.
    for (const out of ['../evil.png', 'C:/Windows/a.png', '//server/share/a.png']) {
      const result = resolveCapturePath({ root: workspace, out, defaultName: 'output/capture/x.png' });
      assert.equal(result.ok, false, `expected rejection for ${JSON.stringify(out)}`);
    }
  });
});
