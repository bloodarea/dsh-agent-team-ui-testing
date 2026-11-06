/**
 * Platform parity: the Web/Chromium adapter must behave identically on Linux, macOS and
 * Windows hosts. Every platform-dependent branch is exercised here by injecting `platform`
 * instead of relying on the runner's own OS, so the same assertions run everywhere (and in a
 * CI matrix they catch a change that only holds on one platform).
 *
 * Contract: docs/getting-started.md (browser discovery), docs/capture-p0.md (output paths).
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { resolveChromeExecutable } from '../index.js';
import { resolveCapturePath } from '../capture-p0.js';

function withScratch(fn) {
  const root = mkdtempSync(join(tmpdir(), 'dsh-platform-'));
  try {
    return fn(root);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
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

test('win32: chrome.exe under %ProgramFiles% is discovered without any env override', () => {
  withScratch((root) => {
    const install = join(root, 'Google', 'Chrome', 'Application');
    mkdirSync(install, { recursive: true });
    const expected = join(install, 'chrome.exe');
    writeFileSync(expected, 'stub');
    const found = resolveChromeExecutable({
      platform: 'win32',
      env: { PROGRAMFILES: root, PATH: '' },
      pathDirs: [],
    });
    assert.equal(found, expected);
  });
});

test('win32: the POSIX default candidate is not offered there', () => {
  const error = captureError(() => resolveChromeExecutable({
    platform: 'win32', env: { PATH: '' }, pathDirs: [],
  }));
  assert.equal(error.code, 'UNSUPPORTED');
  assert.ok(!candidatesFrom(error).some((candidate) => String(candidate).startsWith('/opt')), 'win32 must not list /opt');
});

test('linux: /opt default and POSIX PATH names are offered, never .exe names', () => {
  const error = captureError(() => resolveChromeExecutable({
    platform: 'linux', env: {}, pathDirs: ['/usr/bin'],
  }));
  // path.join follows the *host* separator, so compare with separators normalised.
  const candidates = candidatesFrom(error).map((candidate) => String(candidate).split('\\').join('/'));
  assert.ok(candidates.includes('/opt/google/chrome/chrome'), 'POSIX default candidate must be kept');
  assert.ok(candidates.includes('/usr/bin/google-chrome-stable'), 'POSIX PATH name must be kept');
  assert.ok(!candidates.some((candidate) => candidate.endsWith('.exe')), 'linux must not list .exe names');
});

test('darwin: application bundles stay in the candidate list', () => {
  const error = captureError(() => resolveChromeExecutable({ platform: 'darwin', env: {}, pathDirs: [] }));
  assert.ok(candidatesFrom(error).includes('/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'));
});

test('a resolved browser is cached per platform: a win32 hit never leaks into a linux lookup', () => {
  withScratch((root) => {
    const install = join(root, 'Google', 'Chrome', 'Application');
    mkdirSync(install, { recursive: true });
    const windowsBinary = join(install, 'chrome.exe');
    writeFileSync(windowsBinary, 'stub');
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
    const file = join(root, 'win.ini');
    writeFileSync(file, 'x');
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
