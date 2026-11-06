/**
 * vision-baseline.js 单元测试（docs/t3-vision.md §9 的 U 类：C32/C33/C34/C36/C37/C38）。
 *
 * - 导出 `runBaselineChecks(check)`，check(criteria, label, pass, detail)；import 无副作用。
 * - 直接 `node tests/vision-baseline.test.mjs` 时自汇总 PASS/FAIL 并设置 process.exitCode。
 * - 每个用例在 mkdtemp 临时根内运行，finally 清理；不写仓库 output/；now/fsOps 全部可注入。
 * - PNG 夹具由测试自带的独立最小编码器生成（CRC32 本地实现），不依赖被测模块的解码路径。
 */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import {
  chmodSync, closeSync, existsSync, fsyncSync as realFsyncSync, linkSync as realLinkSync,
  mkdirSync, mkdtempSync, openSync as realOpenSync, readFileSync, readdirSync,
  rmSync, statSync, symlinkSync, unlinkSync, writeFileSync, writeSync as realWriteSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { deflateSync } from 'node:zlib';

import { BrowserError } from '../browser-safety.js';
import { BASELINE_LIMITS, baselineScopeHash, createBaselineStore } from '../vision-baseline.js';

const SCOPE = 'scope-alpha';
const FIXED_NOW = 1_700_000_000_000;
const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const HEAD_FIELDS = [
  'caseId', 'createdAt', 'image', 'mapping', 'masks', 'name', 'options',
  'parentHeadToken', 'parentRevision', 'provenanceVersion', 'revision',
  'source', 'thresholds', 'tombstone',
];

/* ------------------------------------------------------------------------------------------------
 * 独立 PNG 编码器（测试夹具）
 * ---------------------------------------------------------------------------------------------- */

function crc32(bytes) {
  let crc = 0xffffffff;
  for (let index = 0; index < bytes.length; index += 1) {
    crc ^= bytes[index];
    for (let bit = 0; bit < 8; bit += 1) crc = crc & 1 ? 0xedb88320 ^ (crc >>> 1) : crc >>> 1;
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function pngChunk(type, data) {
  const typeBuffer = Buffer.from(type, 'latin1');
  const out = Buffer.alloc(8 + data.length + 4);
  out.writeUInt32BE(data.length, 0);
  typeBuffer.copy(out, 4);
  data.copy(out, 8);
  out.writeUInt32BE(crc32(Buffer.concat([typeBuffer, data])), 8 + data.length);
  return out;
}

/** 只声明 IHDR 尺寸、IDAT 载荷极小：用于验证像素预算在解码/CRC 之前生效。 */
function makeDeclaredPng(width, height) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;
  ihdr[9] = 6;
  return Buffer.concat([
    PNG_SIGNATURE,
    pngChunk('IHDR', ihdr),
    pngChunk('IDAT', Buffer.from([0x78, 0x9c, 0x03, 0x00, 0x00, 0x00, 0x00, 0x01])),
    pngChunk('IEND', Buffer.alloc(0)),
  ]);
}

/** 生成 width×height 的纯色 RGBA8 PNG。 */
function makePng(width, height, rgba) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // color type RGBA
  const raw = Buffer.alloc((width * 4 + 1) * height);
  let offset = 0;
  for (let y = 0; y < height; y += 1) {
    raw[offset] = 0; // filter None
    offset += 1;
    for (let x = 0; x < width; x += 1) {
      raw[offset] = rgba[0]; raw[offset + 1] = rgba[1];
      raw[offset + 2] = rgba[2]; raw[offset + 3] = rgba[3];
      offset += 4;
    }
  }
  return Buffer.concat([
    PNG_SIGNATURE,
    pngChunk('IHDR', ihdr),
    pngChunk('IDAT', deflateSync(raw, { level: 9 })),
    pngChunk('IEND', Buffer.alloc(0)),
  ]);
}

/* ------------------------------------------------------------------------------------------------
 * 测试辅助
 * ---------------------------------------------------------------------------------------------- */

function sha256(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

/** 独立规范 JSON：递归 key 字典序 + 末尾 LF（不复用被测实现）。 */
function sortKeys(value) {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (value !== null && typeof value === 'object') {
    const out = {};
    for (const key of Object.keys(value).sort()) out[key] = sortKeys(value[key]);
    return out;
  }
  return value;
}

function canonicalText(value) {
  return JSON.stringify(sortKeys(value)) + '\n';
}

function withRoot(fn) {
  const root = mkdtempSync(join(tmpdir(), 't3-baseline-'));
  try {
    return fn(root);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

function withOutside(fn) {
  const outside = mkdtempSync(join(tmpdir(), 't3-baseline-outside-'));
  try {
    return fn(outside);
  } finally {
    rmSync(outside, { recursive: true, force: true });
  }
}

function clock(start = FIXED_NOW) {
  let tick = start;
  return () => {
    tick += 1000;
    return tick;
  };
}

function sourceFor(pngBytes, extra = {}) {
  return {
    productId: 'v1_' + 'a'.repeat(32),
    sha256: sha256(pngBytes),
    capturedAt: FIXED_NOW,
    runtimeId: 'rt-1',
    pageGeneration: 2,
    documentEpoch: 3,
    ...extra,
  };
}

function mappingFixture(origin = { x: 0, y: 0 }) {
  return {
    coordinateSpace: 'document-css-px',
    originCss: { ...origin },
    cssPerPixel: { x: 1, y: 1 },
    imagePixels: { width: 2, height: 2 },
    capturedCssRect: { x: 0, y: 0, width: 2, height: 2 },
    scrollAtCapture: { x: 0, y: 0 },
    viewportAtCapture: { width: 1280, height: 800 },
    visualViewportScale: null,
    geometryTransform: 'axis-aligned',
  };
}

function storeFor(root, options = {}) {
  return createBaselineStore({
    root,
    scopeId: options.scopeId ?? SCOPE,
    now: options.now ?? clock(),
    fsOps: options.fsOps,
  });
}

function pathsFor(root, scopeId = SCOPE) {
  const hash = baselineScopeHash(scopeId);
  const scopeDir = join(root, 'output', 'vision-baselines', hash);
  return {
    hash,
    scopeDir,
    name: (name) => join(scopeDir, name),
    heads: (name) => join(scopeDir, name, 'heads'),
    images: (name) => join(scopeDir, name, 'images'),
  };
}

function expectCode(fn, code, options = {}) {
  let error = null;
  try {
    fn();
  } catch (caught) {
    error = caught;
  }
  assert.ok(error, `expected ${code} but no error was thrown`);
  assert.ok(error instanceof BrowserError, `expected BrowserError, got ${error && error.name}: ${error && error.message}`);
  assert.equal(error.code, code, `expected ${code}, got ${error.code} (${error.message})`);
  if (options.root) {
    const payload = JSON.stringify(error.payload());
    assert.ok(!payload.includes(options.root), `error payload leaks absolute root: ${payload}`);
    assert.ok(!String(error.message).includes(options.root), 'error message leaks absolute root');
  }
  if (options.reason !== undefined) assert.equal(error.details.reason, options.reason);
  if (options.detail !== undefined) assert.equal(error.details.detail, options.detail);
  return error;
}

function readdirSorted(dir) {
  return existsSync(dir) ? readdirSync(dir).sort() : null;
}

function assertNoTempFiles(dir) {
  const entries = readdirSorted(dir) ?? [];
  assert.deepEqual(entries.filter((entry) => entry.startsWith('.tmp-')), [], `temp files left in ${dir}`);
}

/** 基础 create 输入。 */
function createInput(pngBytes, overrides = {}) {
  return {
    name: 'card',
    actionId: 'act-1',
    pngBytes,
    source: sourceFor(pngBytes),
    ...overrides,
  };
}

function updateInput(pngBytes, expectedRevision, overrides = {}) {
  return {
    name: 'card',
    actionId: 'act-2',
    expectedRevision,
    pngBytes,
    source: sourceFor(pngBytes),
    ...overrides,
  };
}

function runCheck(check, criteria, label, fn) {
  try {
    const detail = fn();
    check(criteria, label, true, detail === undefined ? null : detail);
  } catch (error) {
    check(criteria, label, false, error && error.stack ? error.stack : String(error));
  }
}

/* ------------------------------------------------------------------------------------------------
 * 检查主体
 * ---------------------------------------------------------------------------------------------- */

/**
 * @param {(criteria:string, label:string, pass:boolean, detail?:any)=>void} check
 */
export async function runBaselineChecks(check) {
  const it = (criteria, label, fn) => runCheck(check, criteria, label, fn);
  const red = makePng(2, 2, [255, 0, 0, 255]);
  const blue = makePng(2, 2, [0, 0, 255, 255]);
  const green = makePng(2, 2, [0, 255, 0, 255]);

  /* ==============================================================================================
   * §9.C33 — 只有 create/update mkdir；无根/坏根/名字非法/只读失败码
   * ============================================================================================ */

  it('§9.C33', '构造 store、list、get、update、delete 都不创建任何目录', () => withRoot((root) => {
    const store = storeFor(root);
    assert.deepEqual(readdirSync(root), [], 'constructor must not create directories');
    assert.deepEqual(store.list(), { ok: true, baselines: [] });
    assert.deepEqual(readdirSync(root), [], 'list must not create directories');
    expectCode(() => store.get('missing'), 'VISION_BASELINE_NOT_FOUND', { root });
    expectCode(() => store.delete({ name: 'missing', expectedRevision: 1 }), 'VISION_BASELINE_NOT_FOUND', { root });
    expectCode(() => store.update(updateInput(red, 1, { name: 'missing' })), 'VISION_BASELINE_NOT_FOUND', { root });
    assert.deepEqual(readdirSync(root), [], 'get/delete/update must not create directories');
  }));

  it('§9.C33', '非法 name（../、斜杠、反斜杠、点号、空格、超长、空、NUL）→ NAME_INVALID 且零副作用', () => withRoot((root) => {
    const store = storeFor(root);
    const badNames = ['../escape', 'a/b', 'a\\b', '.hidden', 'na me', 'x'.repeat(65), '', 'a\0b', 'ünïcode'];
    for (const name of badNames) {
      expectCode(() => store.get(name), 'VISION_BASELINE_NAME_INVALID', { root });
      expectCode(() => store.delete({ name, expectedRevision: 1 }), 'VISION_BASELINE_NAME_INVALID', { root });
      expectCode(() => store.create(createInput(red, { name })), 'VISION_BASELINE_NAME_INVALID', { root });
      expectCode(() => store.update(updateInput(red, 1, { name })), 'VISION_BASELINE_NAME_INVALID', { root });
    }
    assert.deepEqual(readdirSync(root), [], 'invalid names must not create anything');
  }));

  it('§9.C33', 'root 缺失/相对/不存在/非目录、scopeId 缺失 → ROOT_UNAVAILABLE（不回退暂存）', () => withRoot((root) => {
    expectCode(() => createBaselineStore({ root: undefined, scopeId: SCOPE }), 'VISION_BASELINE_ROOT_UNAVAILABLE', { root });
    expectCode(() => createBaselineStore({ root: null, scopeId: SCOPE }), 'VISION_BASELINE_ROOT_UNAVAILABLE', { root });
    expectCode(() => createBaselineStore({ root: '', scopeId: SCOPE }), 'VISION_BASELINE_ROOT_UNAVAILABLE', { root });
    expectCode(() => createBaselineStore({ root: 'relative/root', scopeId: SCOPE }), 'VISION_BASELINE_ROOT_UNAVAILABLE', { root });
    expectCode(() => createBaselineStore({ root: join(root, 'missing-root'), scopeId: SCOPE }), 'VISION_BASELINE_ROOT_UNAVAILABLE', { root });
    const file = join(root, 'root-file');
    writeFileSync(file, 'x');
    expectCode(() => createBaselineStore({ root: file, scopeId: SCOPE }), 'VISION_BASELINE_ROOT_UNAVAILABLE', { root });
    expectCode(() => createBaselineStore({ root, scopeId: '' }), 'VISION_BASELINE_ROOT_UNAVAILABLE', { root });
    expectCode(() => createBaselineStore({ root, scopeId: '   ' }), 'VISION_BASELINE_ROOT_UNAVAILABLE', { root });
    expectCode(() => baselineScopeHash(''), 'VISION_BASELINE_ROOT_UNAVAILABLE', { root });
    assert.deepEqual(readdirSync(root).sort(), ['root-file']);
  }));

  it('§9.C33', 'mkdir EACCES / EROFS（注入 fsOps）→ WRITE_FAILED reason permission / read-only', () => withRoot((root) => {
    const denied = storeFor(root, {
      fsOps: { mkdirSync: () => { throw Object.assign(new Error('denied'), { code: 'EACCES' }); } },
    });
    expectCode(() => denied.create(createInput(red)), 'VISION_BASELINE_WRITE_FAILED', { root, reason: 'permission' });
    const readOnly = storeFor(root, {
      fsOps: { mkdirSync: () => { throw Object.assign(new Error('read-only'), { code: 'EROFS' }); } },
    });
    expectCode(() => readOnly.create(createInput(red)), 'VISION_BASELINE_WRITE_FAILED', { root, reason: 'read-only' });
    assert.deepEqual(readdirSync(root), [], 'failed mkdir must leave nothing behind');
  }));

  it('§9.C33', '真实只读根（chmod 0500）→ WRITE_FAILED/permission，且不写暂存', () => {
    if (typeof process.getuid === 'function' && process.getuid() === 0) {
      return 'skipped: running as root (permission bits are bypassed)';
    }
    // NTFS has ACLs, not POSIX mode bits: chmod 0500 on a directory does not make it read-only,
    // so this check has no premise on Windows.
    if (process.platform === 'win32') {
      return 'skipped: win32 has no POSIX read-only directory bit';
    }
    return withRoot((root) => {
      chmodSync(root, 0o500);
      try {
        const store = storeFor(root);
        expectCode(() => store.create(createInput(red)), 'VISION_BASELINE_WRITE_FAILED', { root, reason: 'permission' });
        assert.deepEqual(readdirSync(root), [], 'read-only root must stay untouched');
      } finally {
        chmodSync(root, 0o700);
      }
    });
  });

  it('§9.C33', '已有 output 但无 scope 目录：list []/get NOT_FOUND，不创建 scope 目录', () => withRoot((root) => {
    mkdirSync(join(root, 'output'), { recursive: true, mode: 0o700 });
    const store = storeFor(root);
    assert.deepEqual(store.list(), { ok: true, baselines: [] });
    expectCode(() => store.get('card'), 'VISION_BASELINE_NOT_FOUND', { root });
    assert.deepEqual(readdirSync(join(root, 'output')), [], 'read paths must not create the scope directory');
  }));

  it('§9.C33', '只有 images 残留、无 committed head 的名字不算已用：get NOT_FOUND / list 跳过 / create 可建 revision1', () => withRoot((root) => {
    const paths = pathsFor(root);
    const store = storeFor(root);
    store.create(createInput(red));
    mkdirSync(paths.images('orphan'), { recursive: true, mode: 0o700 });
    writeFileSync(join(paths.images('orphan'), '1-act-old.png'), 'ORPHAN');
    expectCode(() => store.get('orphan'), 'VISION_BASELINE_NOT_FOUND', { root });
    assert.deepEqual(store.list().baselines.map((entry) => entry.name), ['card']);
    const meta = store.create(createInput(blue, { name: 'orphan', actionId: 'act-new' }));
    assert.equal(meta.revision, 1);
    assert.deepEqual(readdirSorted(paths.heads('orphan')), ['0000000001.json']);
    assert.deepEqual(readdirSorted(paths.images('orphan')), ['1-act-new.png', '1-act-old.png']);
  }));

  it('§9.C33', 'update 可补建缺失的 images 目录（create/update 才 mkdir）', () => withRoot((root) => {
    const paths = pathsFor(root);
    const store = storeFor(root);
    store.create(createInput(red));
    rmSync(paths.images('card'), { recursive: true, force: true });
    const meta = store.update(updateInput(blue, 1));
    assert.equal(meta.revision, 2);
    assert.deepEqual(readdirSorted(paths.images('card')), ['2-act-2.png']);
    if (process.platform !== 'win32') assert.equal(statSync(paths.images('card')).mode & 0o777, 0o700);
    assert.deepEqual(store.get('card').pngBytes, blue);
  }));

  it('§9.C33', 'list 名字数超过 1000 → LIMIT_EXCEEDED（注入 readdir，不读 head）', () => withRoot((root) => {
    const paths = pathsFor(root);
    mkdirSync(paths.scopeDir, { recursive: true, mode: 0o700 });
    const names = Array.from({ length: 1001 }, (_, index) => `b${String(index).padStart(4, '0')}`);
    const store = storeFor(root, {
      fsOps: { readdirSync: (path) => (path === paths.scopeDir ? names.slice() : readdirSync(path)) },
    });
    const error = expectCode(() => store.list(), 'VISION_LIMIT_EXCEEDED', { root });
    assert.equal(error.details.limit, 'maxListEntries');
    assert.equal(error.details.actual, 1001);
    assert.equal(error.details.max, 1000);
  }));

  /* ==============================================================================================
   * §9.C34 — 0600/0700、原子 no-clobber、realpath/symlink 守卫、历史字节不变
   * ============================================================================================ */

  it('§9.C34', '目录 0700（output/vision-baselines/scope/name/heads/images），PNG 与 head JSON 0600', () => withRoot((root) => {
    const paths = pathsFor(root);
    const store = storeFor(root);
    const meta = store.create(createInput(red));
    const dirs = [
      join(root, 'output'),
      join(root, 'output', 'vision-baselines'),
      paths.scopeDir,
      paths.name('card'),
      paths.heads('card'),
      paths.images('card'),
    ];
    // Windows has ACLs, not POSIX modes: the 0700/0600 requests cannot be observed there.
    if (process.platform !== 'win32') {
      for (const dir of dirs) assert.equal(statSync(dir).mode & 0o777, 0o700, `mode of ${dir}`);
      assert.equal(statSync(join(paths.heads('card'), '0000000001.json')).mode & 0o777, 0o600);
      assert.equal(statSync(join(paths.images('card'), '1-act-1.png')).mode & 0o777, 0o600);
    }
    assert.equal(meta.image.relativePath, 'card/images/1-act-1.png');
  }));

  it('§9.C34', 'scopeHash=sha256(scopeId)[:32]，不同 scope 目录隔离且互不可见', () => withRoot((root) => {
    const expected = createHash('sha256').update(SCOPE, 'utf8').digest('hex').slice(0, 32);
    assert.equal(baselineScopeHash(SCOPE), expected);
    const paths = pathsFor(root);
    assert.equal(paths.scopeDir, join(root, 'output', 'vision-baselines', expected));
    const alpha = storeFor(root);
    alpha.create(createInput(red));
    const beta = storeFor(root, { scopeId: 'scope-beta' });
    assert.deepEqual(beta.list(), { ok: true, baselines: [] });
    assert.equal(existsSync(pathsFor(root, 'scope-beta').scopeDir), false, 'other scope dir must not be created');
  }));

  it('§9.C34', 'head JSON 规范（key 字典序/无空白/末尾 LF），headToken=精确文件字节 sha256', () => withRoot((root) => {
    const paths = pathsFor(root);
    const store = storeFor(root);
    const meta = store.create(createInput(red));
    const bytes = readFileSync(join(paths.heads('card'), '0000000001.json'));
    const text = bytes.toString('utf8');
    assert.ok(text.endsWith('\n'), 'head JSON must end with LF');
    assert.ok(!/[ \t]/.test(text), 'head JSON must not contain whitespace');
    const parsed = JSON.parse(text);
    assert.equal(text, canonicalText(parsed), 'head JSON must be canonical');
    assert.equal(Object.prototype.hasOwnProperty.call(parsed, 'headToken'), false, 'headToken must not be written');
    assert.equal(meta.headToken, sha256(bytes));
    assert.equal(parsed.headToken, undefined);
    assert.equal(parsed.parentHeadToken, null);
    assert.equal(parsed.parentRevision, null);
    assert.equal(parsed.provenanceVersion, 1);
  }));

  it('§9.C34', 'update 后旧 head JSON 与旧 PNG 字节/inode 完全不变（不可变历史）', () => withRoot((root) => {
    const paths = pathsFor(root);
    const store = storeFor(root);
    store.create(createInput(red));
    const head1 = join(paths.heads('card'), '0000000001.json');
    const png1 = join(paths.images('card'), '1-act-1.png');
    const headBytes = readFileSync(head1);
    const pngBytes = readFileSync(png1);
    const headIno = statSync(head1).ino;
    const pngIno = statSync(png1).ino;
    store.update(updateInput(blue, 1));
    assert.deepEqual(readFileSync(head1), headBytes, 'old head bytes must not change');
    assert.deepEqual(readFileSync(png1), pngBytes, 'old PNG bytes must not change');
    assert.equal(statSync(head1).ino, headIno, 'old head inode must not change');
    assert.equal(statSync(png1).ino, pngIno, 'old PNG inode must not change');
    assert.deepEqual(readdirSorted(paths.heads('card')), ['0000000001.json', '0000000002.json']);
    assert.deepEqual(readdirSorted(paths.images('card')), ['1-act-1.png', '2-act-2.png']);
  }));

  it('§9.C34', 'PNG 目标已存在（同 revision+actionId）→ CONFLICT，既有文件字节不变、无临时残留', () => withRoot((root) => {
    const paths = pathsFor(root);
    const store = storeFor(root);
    store.create(createInput(red));
    const decoy = join(paths.images('card'), '2-act-2.png');
    writeFileSync(decoy, 'DECOY-NOT-OVERWRITTEN', { mode: 0o600 });
    expectCode(() => store.update(updateInput(blue, 1)), 'VISION_BASELINE_CONFLICT', { root });
    assert.equal(readFileSync(decoy, 'utf8'), 'DECOY-NOT-OVERWRITTEN');
    assert.deepEqual(readdirSorted(paths.heads('card')), ['0000000001.json']);
    assert.deepEqual(readdirSorted(paths.images('card')), ['1-act-1.png', '2-act-2.png']);
    assertNoTempFiles(paths.heads('card'));
    assertNoTempFiles(paths.images('card'));
    assert.equal(store.get('card').meta.revision, 1, 'HEAD must stay at revision 1');
  }));

  it('§9.C34', 'head link EEXIST（注入并发写者）→ CONFLICT，既有 head 不变且本次 PNG 被清理', () => withRoot((root) => {
    const paths = pathsFor(root);
    const first = storeFor(root);
    first.create(createInput(red));
    const head1 = join(paths.heads('card'), '0000000001.json');
    const headBytes = readFileSync(head1);
    const contender = storeFor(root, {
      fsOps: {
        linkSync: (from, to) => {
          if (to.endsWith(join('heads', '0000000002.json'))) {
            throw Object.assign(new Error('exists'), { code: 'EEXIST' });
          }
          return realLinkSync(from, to);
        },
      },
    });
    expectCode(() => contender.update(updateInput(blue, 1)), 'VISION_BASELINE_CONFLICT', { root });
    assert.deepEqual(readFileSync(head1), headBytes, 'existing head must not change');
    assert.deepEqual(readdirSorted(paths.heads('card')), ['0000000001.json']);
    assert.deepEqual(readdirSorted(paths.images('card')), ['1-act-1.png'], 'loser PNG must be cleaned');
    assertNoTempFiles(paths.heads('card'));
    assertNoTempFiles(paths.images('card'));
  }));

  it('§9.C34', 'scope 目录被替换为 symlink（越界父）→ 读 READ_FAILED / 写 WRITE_FAILED，外部零写入', () => withRoot((root) => withOutside((outside) => {
    const paths = pathsFor(root);
    mkdirSync(join(root, 'output', 'vision-baselines'), { recursive: true, mode: 0o700 });
    symlinkSync(outside, paths.scopeDir);
    const store = storeFor(root);
    expectCode(() => store.list(), 'VISION_BASELINE_READ_FAILED', { root, reason: 'io' });
    expectCode(() => store.get('card'), 'VISION_BASELINE_READ_FAILED', { root, reason: 'io' });
    expectCode(() => store.create(createInput(red)), 'VISION_BASELINE_WRITE_FAILED', { root, reason: 'io' });
    assert.deepEqual(readdirSync(outside), [], 'symlinked scope must never be written through');
  })));

  it('§9.C34', 'output 目录被替换为 symlink → create WRITE_FAILED，外部零写入', () => withRoot((root) => withOutside((outside) => {
    symlinkSync(outside, join(root, 'output'));
    const store = storeFor(root);
    expectCode(() => store.create(createInput(red)), 'VISION_BASELINE_WRITE_FAILED', { root, reason: 'io' });
    assert.deepEqual(readdirSync(outside), []);
  })));

  it('§9.C34', 'name 目录为 symlink → get READ_FAILED / create WRITE_FAILED，外部零写入', () => withRoot((root) => withOutside((outside) => {
    const paths = pathsFor(root);
    const store = storeFor(root);
    store.create(createInput(red));
    symlinkSync(outside, paths.name('linked'));
    expectCode(() => store.get('linked'), 'VISION_BASELINE_READ_FAILED', { root, reason: 'io' });
    expectCode(() => store.create(createInput(red, { name: 'linked' })), 'VISION_BASELINE_WRITE_FAILED', { root, reason: 'io' });
    assert.deepEqual(readdirSync(outside), []);
  })));

  it('§9.C34', 'head 文件为 symlink → get/list READ_FAILED（不跟随叶 symlink）', () => withRoot((root) => withOutside((outside) => {
    const paths = pathsFor(root);
    const store = storeFor(root);
    store.create(createInput(red));
    const head = join(paths.heads('card'), '0000000001.json');
    const real = join(outside, 'real-head.json');
    writeFileSync(real, readFileSync(head));
    unlinkSync(head);
    symlinkSync(real, head);
    expectCode(() => store.get('card'), 'VISION_BASELINE_READ_FAILED', { root, reason: 'io' });
    expectCode(() => store.list(), 'VISION_BASELINE_READ_FAILED', { root, reason: 'io' });
  })));

  it('§9.C34', 'PNG 为 symlink → get READ_FAILED，外部目标不被当图像', () => withRoot((root) => withOutside((outside) => {
    const paths = pathsFor(root);
    const store = storeFor(root);
    store.create(createInput(red));
    const png = join(paths.images('card'), '1-act-1.png');
    const real = join(outside, 'real.png');
    writeFileSync(real, readFileSync(png));
    unlinkSync(png);
    symlinkSync(real, png);
    expectCode(() => store.get('card'), 'VISION_BASELINE_READ_FAILED', { root, reason: 'io' });
    assert.deepEqual(readFileSync(real), red, 'symlink target must not be treated as the baseline image');
  })));

  it('§9.C34', 'scope 位置是普通文件 → list READ_FAILED / create WRITE_FAILED', () => withRoot((root) => {
    const paths = pathsFor(root);
    mkdirSync(join(root, 'output', 'vision-baselines'), { recursive: true, mode: 0o700 });
    writeFileSync(paths.scopeDir, 'not-a-directory');
    const store = storeFor(root);
    expectCode(() => store.list(), 'VISION_BASELINE_READ_FAILED', { root, reason: 'io' });
    expectCode(() => store.create(createInput(red)), 'VISION_BASELINE_WRITE_FAILED', { root, reason: 'io' });
    assert.equal(readFileSync(paths.scopeDir, 'utf8'), 'not-a-directory');
  }));

  /* ==============================================================================================
   * §9.C36 — create/update 继承与覆盖、不可变 revision、CAS 两写者仅一个成功
   * ============================================================================================ */

  it('§9.C36', 'create：revision1 / parent null / caseId 默认 name / options+thresholds 解析默认 / image 摘要', () => withRoot((root) => {
    const paths = pathsFor(root);
    const store = storeFor(root);
    const meta = store.create(createInput(red, { mapping: mappingFixture() }));
    assert.equal(meta.revision, 1);
    assert.equal(meta.parentRevision, null);
    assert.equal(meta.parentHeadToken, null);
    assert.equal(meta.tombstone, false);
    assert.equal(meta.caseId, 'card');
    assert.equal(meta.provenanceVersion, 1);
    assert.deepEqual(meta.options, { threshold: 0.1, includeAA: false, minRegionPixels: 1 });
    assert.deepEqual(meta.thresholds, { warnRatio: 0.001, failRatio: 0.01 });
    assert.deepEqual(meta.masks, []);
    assert.deepEqual(meta.mapping, mappingFixture());
    assert.deepEqual(meta.image, {
      relativePath: 'card/images/1-act-1.png',
      sha256: sha256(red),
      width: 2,
      height: 2,
      bytes: red.length,
    });
    assert.equal(meta.headToken, sha256(readFileSync(join(paths.heads('card'), '0000000001.json'))));
    assert.deepEqual(Object.keys(meta).sort(), [...HEAD_FIELDS, 'headToken'].sort());
  }));

  it('§9.C36', 'update 缺省继承 caseId/options/thresholds/masks/mapping，revision+1 且父链正确', () => withRoot((root) => {
    const store = storeFor(root);
    const first = store.create(createInput(red, {
      caseId: 'case-a',
      options: { threshold: 0.2, includeAA: true, minRegionPixels: 2 },
      thresholds: { warnRatio: 0.01, failRatio: 0.05 },
      masks: [{ id: 'clock', region: { x: 1, y: 1, width: 2, height: 2 } }],
      mapping: mappingFixture(),
    }));
    const second = store.update(updateInput(blue, 1));
    assert.equal(second.revision, 2);
    assert.equal(second.parentRevision, 1);
    assert.equal(second.parentHeadToken, first.headToken);
    assert.equal(second.caseId, 'case-a');
    assert.deepEqual(second.options, first.options);
    assert.deepEqual(second.thresholds, first.thresholds);
    assert.deepEqual(second.masks, first.masks);
    assert.deepEqual(second.mapping, first.mapping);
    assert.deepEqual(second.image, {
      relativePath: 'card/images/2-act-2.png',
      sha256: sha256(blue),
      width: 2,
      height: 2,
      bytes: blue.length,
    });
    assert.equal(second.headToken, sha256(readFileSync(join(pathsFor(root).heads('card'), '0000000002.json'))));
    assert.deepEqual(store.get('card').meta, second);
    assert.deepEqual(store.get('card').pngBytes, blue);
    assert.deepEqual(store.get('card', 1).pngBytes, red);
  }));

  it('§9.C36', 'update 显式覆盖：caseId、options 逐字段合并、thresholds 合并、masks=[] 清空', () => withRoot((root) => {
    const store = storeFor(root);
    store.create(createInput(red, {
      caseId: 'case-a',
      options: { threshold: 0.2, includeAA: true, minRegionPixels: 2 },
      thresholds: { warnRatio: 0.01, failRatio: 0.05 },
      masks: [{ id: 'clock', region: { x: 1, y: 1, width: 2, height: 2 } }],
    }));
    store.update(updateInput(blue, 1));
    const third = store.update(updateInput(green, 2, {
      caseId: 'case-b',
      options: { threshold: 0.5 },
      thresholds: { warnRatio: 0.02 },
      masks: [],
      mapping: mappingFixture({ x: 10, y: 20 }),
    }));
    assert.equal(third.caseId, 'case-b');
    assert.deepEqual(third.options, { threshold: 0.5, includeAA: true, minRegionPixels: 2 });
    assert.deepEqual(third.thresholds, { warnRatio: 0.02, failRatio: 0.05 });
    assert.deepEqual(third.masks, []);
    assert.deepEqual(third.mapping, mappingFixture({ x: 10, y: 20 }));
    assert.deepEqual(third.image, {
      relativePath: 'card/images/3-act-2.png',
      sha256: sha256(green),
      width: 2,
      height: 2,
      bytes: green.length,
    });
  }));

  it('§9.C36', '两个 store 以 expectedRevision=1 抢 revision2：一个成功一个 CONFLICT，旧 PNG 不变', () => withRoot((root) => {
    const paths = pathsFor(root);
    const writerA = storeFor(root);
    const writerB = storeFor(root);
    writerA.create(createInput(red));
    const png1 = join(paths.images('card'), '1-act-1.png');
    const png1Bytes = readFileSync(png1);
    const winner = writerA.update(updateInput(blue, 1));
    assert.equal(winner.revision, 2);
    expectCode(() => writerB.update(updateInput(green, 1, { actionId: 'act-3' })), 'VISION_BASELINE_CONFLICT', { root });
    assert.equal(writerA.get('card').meta.revision, 2);
    assert.deepEqual(readFileSync(png1), png1Bytes, 'old PNG must not change');
    assert.deepEqual(readdirSorted(paths.images('card')), ['1-act-1.png', '2-act-2.png'], 'loser must not publish a PNG');
    assert.deepEqual(readdirSorted(paths.heads('card')), ['0000000001.json', '0000000002.json']);
  }));

  it('§9.C36', '两写者交错：parent 复验后、head link 前被抢先 → CONFLICT 且清理本次 PNG', () => withRoot((root) => {
    const paths = pathsFor(root);
    const writerA = storeFor(root);
    writerA.create(createInput(red));
    let raced = false;
    const writerB = storeFor(root, {
      fsOps: {
        linkSync: (from, to) => {
          if (!raced && to.endsWith(join('heads', '0000000002.json'))) {
            raced = true;
            writerA.update(updateInput(blue, 1, { actionId: 'act-a' }));
          }
          return realLinkSync(from, to);
        },
      },
    });
    expectCode(() => writerB.update(updateInput(green, 1, { actionId: 'act-b' })), 'VISION_BASELINE_CONFLICT', { root });
    assert.equal(raced, true, 'race hook must have run');
    assert.equal(writerA.get('card').meta.revision, 2);
    assert.deepEqual(readdirSorted(paths.images('card')), ['1-act-1.png', '2-act-a.png'], 'loser PNG must be cleaned');
    assert.deepEqual(readdirSorted(paths.heads('card')), ['0000000001.json', '0000000002.json']);
  }));

  it('§9.C36', 'expectedRevision 非法/缺失 → INVALID_ARGUMENT；与 HEAD 不等 → CONFLICT', () => withRoot((root) => {
    const store = storeFor(root);
    store.create(createInput(red));
    store.update(updateInput(blue, 1));
    for (const bad of [undefined, 0, 1.5, '1', BASELINE_LIMITS.maxRevision + 1]) {
      expectCode(() => store.update(updateInput(green, bad, { actionId: 'act-x' })), 'INVALID_ARGUMENT', { root });
      expectCode(() => store.delete({ name: 'card', expectedRevision: bad }), 'INVALID_ARGUMENT', { root });
    }
    expectCode(() => store.update(updateInput(green, 1, { actionId: 'act-x' })), 'VISION_BASELINE_CONFLICT', { root });
    expectCode(() => store.update(updateInput(green, 3, { actionId: 'act-x' })), 'VISION_BASELINE_CONFLICT', { root });
    assert.equal(store.get('card').meta.revision, 2, 'failed CAS must not advance HEAD');
  }));

  it('§9.C36', 'update/delete 名字不存在 → NOT_FOUND；create 已用名字 → EXISTS', () => withRoot((root) => {
    const store = storeFor(root);
    expectCode(() => store.update(updateInput(red, 1, { name: 'nope' })), 'VISION_BASELINE_NOT_FOUND', { root });
    expectCode(() => store.delete({ name: 'nope', expectedRevision: 1 }), 'VISION_BASELINE_NOT_FOUND', { root });
    store.create(createInput(red));
    expectCode(() => store.create(createInput(blue)), 'VISION_BASELINE_EXISTS', { root });
    assert.equal(store.list().baselines.length, 1);
  }));

  /* ==============================================================================================
   * §9.C37 — tombstone / CAS / 旧 revision 审计 / 名字不可复用
   * ============================================================================================ */

  it('§9.C37', 'delete 追加 tombstone HEAD：image=null，保留 case/options/thresholds/masks/mapping/source 与父链', () => withRoot((root) => {
    const paths = pathsFor(root);
    const store = storeFor(root);
    const first = store.create(createInput(red, {
      caseId: 'case-a',
      options: { threshold: 0.2, includeAA: true, minRegionPixels: 2 },
      thresholds: { warnRatio: 0.01, failRatio: 0.05 },
      masks: [{ id: 'clock', region: { x: 1, y: 1, width: 2, height: 2 } }],
      mapping: mappingFixture(),
    }));
    const second = store.update(updateInput(blue, 1));
    const tombstone = store.delete({ name: 'card', actionId: 'act-del', expectedRevision: 2 });
    assert.equal(tombstone.revision, 3);
    assert.equal(tombstone.tombstone, true);
    assert.equal(tombstone.image, null);
    assert.equal(tombstone.parentRevision, 2);
    assert.equal(tombstone.parentHeadToken, second.headToken);
    assert.equal(tombstone.caseId, second.caseId);
    assert.deepEqual(tombstone.options, second.options);
    assert.deepEqual(tombstone.thresholds, second.thresholds);
    assert.deepEqual(tombstone.masks, second.masks);
    assert.deepEqual(tombstone.mapping, second.mapping);
    assert.deepEqual(tombstone.source, second.source);
    assert.ok(tombstone.createdAt > second.createdAt);
    assert.equal(tombstone.headToken, sha256(readFileSync(join(paths.heads('card'), '0000000003.json'))));
    assert.equal(first.revision, 1);
    assert.deepEqual(readdirSorted(paths.images('card')), ['1-act-1.png', '2-act-2.png'], 'tombstone must keep PNG history');
    assert.deepEqual(readdirSorted(paths.name('card')), ['heads', 'images'], 'delete must not create new directories');
  }));

  it('§9.C37', 'get：HEAD tombstone → NOT_FOUND；显式墓碑 revision 成功返回 meta+null；旧 revision 可审计', () => withRoot((root) => {
    const store = storeFor(root);
    store.create(createInput(red));
    store.update(updateInput(blue, 1));
    const tombstone = store.delete({ name: 'card', expectedRevision: 2 });
    expectCode(() => store.get('card'), 'VISION_BASELINE_NOT_FOUND', { root });
    const atTombstone = store.get('card', 3);
    assert.equal(atTombstone.meta.tombstone, true);
    assert.equal(atTombstone.pngBytes, null);
    assert.deepEqual(atTombstone.meta, tombstone);
    const first = store.get('card', 1);
    assert.equal(first.meta.revision, 1);
    assert.equal(first.meta.tombstone, false);
    assert.deepEqual(first.pngBytes, red);
    assert.deepEqual(store.get('card', 2).pngBytes, blue);
    expectCode(() => store.get('card', 4), 'VISION_BASELINE_NOT_FOUND', { root });
  }));

  it('§9.C37', 'list 含 tombstone 且按名字字典序；headToken 与 head 文件字节一致', () => withRoot((root) => {
    const paths = pathsFor(root);
    const store = storeFor(root);
    store.create(createInput(red, { name: 'zebra' }));
    store.create(createInput(blue, { name: 'alpha', actionId: 'act-a' }));
    store.delete({ name: 'zebra', expectedRevision: 1 });
    const listed = store.list();
    assert.deepEqual(listed.baselines.map((entry) => entry.name), ['alpha', 'zebra']);
    const zebra = listed.baselines[1];
    assert.equal(zebra.tombstone, true);
    assert.equal(zebra.image, null);
    assert.equal(zebra.revision, 2);
    assert.equal(zebra.headToken, sha256(readFileSync(join(paths.heads('zebra'), '0000000002.json'))));
    assert.equal(listed.baselines[0].headToken, sha256(readFileSync(join(paths.heads('alpha'), '0000000001.json'))));
  }));

  it('§9.C37', '名字不可复用（含 tombstone）：create 同名 EXISTS；update/delete 墓碑 HEAD → NOT_FOUND', () => withRoot((root) => {
    const store = storeFor(root);
    store.create(createInput(red));
    store.update(updateInput(blue, 1));
    store.delete({ name: 'card', expectedRevision: 2 });
    expectCode(() => store.create(createInput(green, { actionId: 'act-new' })), 'VISION_BASELINE_EXISTS', { root });
    expectCode(() => store.update(updateInput(green, 3, { actionId: 'act-new' })), 'VISION_BASELINE_NOT_FOUND', { root });
    expectCode(() => store.delete({ name: 'card', expectedRevision: 3 }), 'VISION_BASELINE_NOT_FOUND', { root });
    expectCode(() => store.delete({ name: 'card', expectedRevision: 2 }), 'VISION_BASELINE_NOT_FOUND', { root });
    assert.equal(store.list().baselines[0].tombstone, true);
  }));

  it('§9.C37', 'delete CAS：expectedRevision 与 HEAD 不等 → CONFLICT，HEAD 不前进', () => withRoot((root) => {
    const store = storeFor(root);
    store.create(createInput(red));
    store.update(updateInput(blue, 1));
    expectCode(() => store.delete({ name: 'card', expectedRevision: 1 }), 'VISION_BASELINE_CONFLICT', { root });
    assert.equal(store.get('card').meta.revision, 2);
    const tombstone = store.delete({ name: 'card', expectedRevision: 2 });
    assert.equal(tombstone.revision, 3);
    expectCode(() => store.delete({ name: 'card', expectedRevision: 3 }), 'VISION_BASELINE_NOT_FOUND', { root });
  }));

  it('§9.C37', 'head 文件名十位零填充且 revision 连续（1..n）', () => withRoot((root) => {
    const paths = pathsFor(root);
    const store = storeFor(root);
    store.create(createInput(red));
    store.update(updateInput(blue, 1));
    store.update(updateInput(green, 2));
    const heads = readdirSorted(paths.heads('card'));
    assert.deepEqual(heads, ['0000000001.json', '0000000002.json', '0000000003.json']);
    for (const entry of heads) assert.match(entry, /^\d{10}\.json$/);
    assert.equal(store.list().baselines[0].revision, 3);
  }));

  /* ==============================================================================================
   * §9.C38 — 提交前清理、提交后不回滚、hash/元数据损坏、不猜旧 HEAD
   * ============================================================================================ */

  it('§9.C38', 'PNG 写失败（writeSync EIO）→ WRITE_FAILED，无 PNG/head/临时文件', () => withRoot((root) => {
    const paths = pathsFor(root);
    const store = storeFor(root, {
      fsOps: { writeSync: () => { throw Object.assign(new Error('io'), { code: 'EIO' }); } },
    });
    const error = expectCode(() => store.create(createInput(red)), 'VISION_BASELINE_WRITE_FAILED', { root, reason: 'io' });
    assert.notEqual(error.details.committed, true);
    assert.deepEqual(readdirSorted(paths.images('card')), [], 'failed PNG write must leave no image');
    assert.deepEqual(readdirSorted(paths.heads('card')), [], 'failed PNG write must leave no head');
    assertNoTempFiles(paths.images('card'));
    assertNoTempFiles(paths.heads('card'));
  }));

  it('§9.C38', '提交前 PNG fsync 失败（EIO）→ WRITE_FAILED，临时/PNG 清理，HEAD 未提交', () => withRoot((root) => {
    const paths = pathsFor(root);
    const fdPaths = new Map();
    const store = storeFor(root, {
      fsOps: {
        openSync: (path, flags, mode) => {
          const fd = realOpenSync(path, flags, mode);
          fdPaths.set(fd, String(path));
          return fd;
        },
        fsyncSync: (fd) => {
          const path = fdPaths.get(fd);
          if (path && path.includes(join('images', '.tmp-'))) {
            throw Object.assign(new Error('io'), { code: 'EIO' });
          }
          return realFsyncSync(fd);
        },
      },
    });
    expectCode(() => store.create(createInput(red)), 'VISION_BASELINE_WRITE_FAILED', { root, reason: 'io' });
    assert.deepEqual(readdirSorted(paths.images('card')), []);
    assert.deepEqual(readdirSorted(paths.heads('card')), []);
    assert.equal(store.list().baselines.length, 0);
  }));

  it('§9.C38', 'head link 失败（EIO）→ WRITE_FAILED，本次 PNG 与临时文件清理', () => withRoot((root) => {
    const paths = pathsFor(root);
    const store = storeFor(root, {
      fsOps: {
        linkSync: (from, to) => {
          if (to.endsWith(join('heads', '0000000001.json'))) {
            throw Object.assign(new Error('io'), { code: 'EIO' });
          }
          return realLinkSync(from, to);
        },
      },
    });
    expectCode(() => store.create(createInput(red)), 'VISION_BASELINE_WRITE_FAILED', { root, reason: 'io' });
    assert.deepEqual(readdirSorted(paths.images('card')), [], 'unreferenced PNG must be cleaned');
    assert.deepEqual(readdirSorted(paths.heads('card')), []);
    assertNoTempFiles(paths.heads('card'));
  }));

  it('§9.C38', '提交后 heads 目录 fsync 失败（EIO）→ WRITE_FAILED committed:true，HEAD/PNG 不回滚', () => withRoot((root) => {
    const paths = pathsFor(root);
    const headsDir = paths.heads('card');
    const fdPaths = new Map();
    const store = storeFor(root, {
      fsOps: {
        openSync: (path, flags, mode) => {
          const fd = realOpenSync(path, flags, mode);
          fdPaths.set(fd, String(path));
          return fd;
        },
        fsyncSync: (fd) => {
          if (fdPaths.get(fd) === headsDir) throw Object.assign(new Error('io'), { code: 'EIO' });
          return realFsyncSync(fd);
        },
      },
    });
    const error = expectCode(() => store.create(createInput(red)), 'VISION_BASELINE_WRITE_FAILED', { root, reason: 'io' });
    assert.equal(error.details.committed, true, 'post-commit failure must report committed:true');
    assert.equal(error.details.revision, 1);
    assert.deepEqual(readdirSorted(headsDir), ['0000000001.json'], 'committed head must not be rolled back');
    assert.deepEqual(readdirSorted(paths.images('card')), ['1-act-1.png'], 'committed PNG must not be rolled back');
    const readBack = store.get('card');
    assert.equal(readBack.meta.revision, 1);
    assert.deepEqual(readBack.pngBytes, red);
    assert.equal(store.list().baselines.length, 1);
  }));

  it('§9.C38', 'delete 提交后 fsync 失败 → committed:true，tombstone 已提交且可读', () => withRoot((root) => {
    const paths = pathsFor(root);
    const headsDir = paths.heads('card');
    const base = storeFor(root);
    base.create(createInput(red));
    const fdPaths = new Map();
    const failing = storeFor(root, {
      fsOps: {
        openSync: (path, flags, mode) => {
          const fd = realOpenSync(path, flags, mode);
          fdPaths.set(fd, String(path));
          return fd;
        },
        fsyncSync: (fd) => {
          if (fdPaths.get(fd) === headsDir) throw Object.assign(new Error('io'), { code: 'EIO' });
          return realFsyncSync(fd);
        },
      },
    });
    const error = expectCode(() => failing.delete({ name: 'card', expectedRevision: 1 }), 'VISION_BASELINE_WRITE_FAILED', { root });
    assert.equal(error.details.committed, true);
    assert.equal(error.details.revision, 2);
    assert.deepEqual(readdirSorted(headsDir), ['0000000001.json', '0000000002.json']);
    const listed = base.list().baselines;
    assert.equal(listed[0].revision, 2);
    assert.equal(listed[0].tombstone, true);
    assert.deepEqual(base.get('card', 1).pngBytes, red);
  }));

  it('§9.C38', 'parent 复验读取失败（EIO）→ READ_FAILED，本次未引用 PNG 清理，HEAD 不前进', () => withRoot((root) => {
    const paths = pathsFor(root);
    const base = storeFor(root);
    base.create(createInput(red));
    let headsReads = 0;
    const flaky = storeFor(root, {
      fsOps: {
        readdirSync: (path) => {
          if (path === paths.heads('card')) {
            headsReads += 1;
            if (headsReads === 2) throw Object.assign(new Error('io'), { code: 'EIO' });
          }
          return readdirSync(path);
        },
      },
    });
    expectCode(() => flaky.update(updateInput(blue, 1)), 'VISION_BASELINE_READ_FAILED', { root, reason: 'io' });
    assert.equal(headsReads, 2, 'update must re-read the parent before publishing');
    assert.deepEqual(readdirSorted(paths.heads('card')), ['0000000001.json']);
    assert.deepEqual(readdirSorted(paths.images('card')), ['1-act-1.png'], 'unreferenced PNG must be cleaned');
    assert.equal(base.get('card').meta.revision, 1);
  }));

  it('§9.C38', 'head 链缺号（删除中间 head）→ READ_FAILED/corrupt，不猜旧 HEAD', () => withRoot((root) => {
    const paths = pathsFor(root);
    const store = storeFor(root);
    store.create(createInput(red));
    store.update(updateInput(blue, 1));
    store.update(updateInput(green, 2));
    unlinkSync(join(paths.heads('card'), '0000000002.json'));
    expectCode(() => store.list(), 'VISION_BASELINE_READ_FAILED', { root, reason: 'corrupt' });
    expectCode(() => store.get('card'), 'VISION_BASELINE_READ_FAILED', { root, reason: 'corrupt' });
    expectCode(() => store.get('card', 1), 'VISION_BASELINE_READ_FAILED', { root, reason: 'corrupt' });
    expectCode(() => store.create(createInput(blue, { actionId: 'act-new' })), 'VISION_BASELINE_EXISTS', { root });
  }));

  it('§9.C38', 'head JSON 损坏（非规范/坏 JSON）→ READ_FAILED/corrupt，list 不跳过', () => withRoot((root) => {
    const paths = pathsFor(root);
    const store = storeFor(root);
    store.create(createInput(red));
    const head = join(paths.heads('card'), '0000000001.json');
    const text = readFileSync(head, 'utf8');
    writeFileSync(head, text.replace('{"caseId"', '{ "caseId"'));
    expectCode(() => store.get('card'), 'VISION_BASELINE_READ_FAILED', { root, reason: 'corrupt' });
    expectCode(() => store.list(), 'VISION_BASELINE_READ_FAILED', { root, reason: 'corrupt' });
    writeFileSync(head, 'not json at all');
    expectCode(() => store.get('card'), 'VISION_BASELINE_READ_FAILED', { root, reason: 'corrupt' });
  }));

  it('§9.C38', '父链 hash 不符（篡改中间 head 的规范 JSON）→ READ_FAILED/corrupt', () => withRoot((root) => {
    const paths = pathsFor(root);
    const store = storeFor(root);
    store.create(createInput(red));
    store.update(updateInput(blue, 1));
    store.update(updateInput(green, 2));
    const head2 = join(paths.heads('card'), '0000000002.json');
    const parsed = JSON.parse(readFileSync(head2, 'utf8'));
    parsed.caseId = 'tampered-case';
    writeFileSync(head2, canonicalText(parsed));
    const error = expectCode(() => store.get('card'), 'VISION_BASELINE_READ_FAILED', { root, reason: 'corrupt' });
    assert.equal(error.details.detail, 'head_parent_token');
    expectCode(() => store.list(), 'VISION_BASELINE_READ_FAILED', { root, reason: 'corrupt' });
  }));

  it('§9.C38', 'PNG 被篡改/截断 → get READ_FAILED/hash-mismatch；list 仍只读元数据', () => withRoot((root) => {
    const paths = pathsFor(root);
    const store = storeFor(root);
    store.create(createInput(red));
    const png = join(paths.images('card'), '1-act-1.png');
    const original = readFileSync(png);
    const tampered = Buffer.from(original);
    tampered[tampered.length - 5] ^= 0xff;
    writeFileSync(png, tampered);
    const error = expectCode(() => store.get('card'), 'VISION_BASELINE_READ_FAILED', { root, reason: 'hash-mismatch' });
    assert.equal(error.details.detail, 'png_hash_mismatch');
    assert.equal(store.list().baselines.length, 1, 'list only reads metadata');
    writeFileSync(png, original.subarray(0, original.length - 4));
    expectCode(() => store.get('card'), 'VISION_BASELINE_READ_FAILED', { root, reason: 'hash-mismatch' });
  }));

  it('§9.C38', 'PNG 缺失 → get READ_FAILED/io；list 仍可列元数据', () => withRoot((root) => {
    const paths = pathsFor(root);
    const store = storeFor(root);
    store.create(createInput(red));
    unlinkSync(join(paths.images('card'), '1-act-1.png'));
    const error = expectCode(() => store.get('card'), 'VISION_BASELINE_READ_FAILED', { root, reason: 'io' });
    assert.equal(error.details.detail, 'png_missing');
    assert.equal(store.list().baselines.length, 1);
    expectCode(() => store.get('card', 1), 'VISION_BASELINE_READ_FAILED', { root, reason: 'io' });
  }));

  it('§9.C38', '非法 PNG / source hash 不符 / 超预算 → 早期拒绝且零目录副作用', () => withRoot((root) => {
    const store = storeFor(root);
    expectCode(() => store.create(createInput(Buffer.from('not a png'))), 'INVALID_PNG', { root });
    expectCode(() => store.create(createInput(Buffer.alloc(0))), 'INVALID_ARGUMENT', { root });
    const wrongSource = { ...sourceFor(red), sha256: sha256(blue) };
    expectCode(() => store.create(createInput(red, { source: wrongSource })), 'INVALID_ARGUMENT', { root });
    const oversize = Buffer.alloc(BASELINE_LIMITS.maxPngBytes + 1);
    const oversizeError = expectCode(() => store.create(createInput(oversize)), 'VISION_LIMIT_EXCEEDED', { root });
    assert.equal(oversizeError.details.limit, 'maxPngBytes');
    assert.equal(oversizeError.details.max, BASELINE_LIMITS.maxPngBytes);
    assert.deepEqual(readdirSync(root), [], 'pure parameter failures must not create directories');
  }));

  it('§9.C38', 'IHDR 声明像素超 16M → LIMIT_EXCEEDED（含超过 inspectPng 200M 上限的声明尺寸）', () => withRoot((root) => {
    const store = storeFor(root);
    for (const [width, height] of [[4001, 4001], [20000, 20000]]) {
      const error = expectCode(() => store.create(createInput(makeDeclaredPng(width, height))), 'VISION_LIMIT_EXCEEDED', { root });
      assert.equal(error.details.limit, 'maxPngPixels');
      assert.equal(error.details.max, BASELINE_LIMITS.maxPngPixels);
      assert.equal(error.details.actual, width * height);
    }
    assert.deepEqual(readdirSync(root), [], 'pixel budget failures must not create directories');
  }));

  it('§9.C38', 'revision 上限常量与边界校验（9,999,999,999）', () => withRoot((root) => {
    assert.equal(BASELINE_LIMITS.maxRevision, 9_999_999_999);
    assert.equal(BASELINE_LIMITS.headNameWidth, 10);
    const store = storeFor(root);
    store.create(createInput(red));
    expectCode(() => store.update(updateInput(blue, BASELINE_LIMITS.maxRevision + 1, { actionId: 'act-x' })), 'INVALID_ARGUMENT', { root });
    // 耗尽路径需要 HEAD=9,999,999,999（需 ~1e10 个 head 文件），不可在单测中执行；
    // 这里只固定常量与输入边界，耗尽分支见 update/delete 的 nextRevision > maxRevision 判断。
    return 'revision-exhaustion 分支不可执行，仅断言常量与输入边界';
  }));

  it('§9.C38', 'head 含额外字段（如把 headToken 写进文件）→ READ_FAILED/corrupt', () => withRoot((root) => {
    const paths = pathsFor(root);
    const store = storeFor(root);
    store.create(createInput(red));
    const head = join(paths.heads('card'), '0000000001.json');
    const parsed = JSON.parse(readFileSync(head, 'utf8'));
    parsed.headToken = 'f'.repeat(64);
    writeFileSync(head, canonicalText(parsed));
    const error = expectCode(() => store.get('card'), 'VISION_BASELINE_READ_FAILED', { root, reason: 'corrupt' });
    assert.equal(error.details.detail, 'head_unexpected_fields');
  }));

  it('§9.C38', '注入非法 now → INVALID_ARGUMENT，create/update/delete 均零副作用', () => withRoot((root) => {
    const badClock = storeFor(root, { now: () => -1 });
    expectCode(() => badClock.create(createInput(red)), 'INVALID_ARGUMENT', { root });
    assert.deepEqual(readdirSync(root), [], 'bad clock must fail before mkdir');
    const store = storeFor(root);
    store.create(createInput(red));
    const before = readdirSorted(pathsFor(root).heads('card'));
    expectCode(() => storeFor(root, { now: () => -1 }).update(updateInput(blue, 1)), 'INVALID_ARGUMENT', { root });
    expectCode(() => storeFor(root, { now: () => -1 }).delete({ name: 'card', expectedRevision: 1 }), 'INVALID_ARGUMENT', { root });
    assert.deepEqual(readdirSorted(pathsFor(root).heads('card')), before, 'failed clock must not append a head');
  }));

  /* ==============================================================================================
   * §9.C32 — 错误 taxonomy / 纯 JSON
   * ============================================================================================ */

  it('§9.C32', '错误均为 BrowserError + §3.3 code/category/retryable，payload 可 JSON 往返且无绝对路径', () => withRoot((root) => {
    const store = storeFor(root);
    const cases = [
      [() => store.get('missing'), 'VISION_BASELINE_NOT_FOUND', 'vision', false],
      [() => store.get('../x'), 'VISION_BASELINE_NAME_INVALID', 'input', false],
      [() => store.create(createInput(red, { name: 'x'.repeat(65) })), 'VISION_BASELINE_NAME_INVALID', 'input', false],
      [() => store.create(createInput(Buffer.from('nope'))), 'INVALID_PNG', 'capture', false],
      [() => store.create(createInput(red, { options: { threshold: 2 } })), 'INVALID_ARGUMENT', 'input', false],
    ];
    const failingStore = storeFor(root, {
      fsOps: { mkdirSync: () => { throw Object.assign(new Error('denied'), { code: 'EACCES' }); } },
    });
    const records = [];
    for (const [fn, code, category, retryable] of cases) {
      const error = expectCode(fn, code, { root });
      assert.equal(error.category, category, `${code} category`);
      assert.equal(error.retryable, retryable, `${code} retryable`);
      const payload = error.payload();
      assert.deepEqual(JSON.parse(JSON.stringify(payload)), payload);
      records.push(payload);
    }
    const writeError = expectCode(() => failingStore.create(createInput(red)), 'VISION_BASELINE_WRITE_FAILED', { root });
    assert.equal(writeError.category, 'output');
    assert.equal(writeError.retryable, true);
    assert.deepEqual(JSON.parse(JSON.stringify(writeError.payload())), writeError.payload());
    assert.deepEqual(readdirSync(root), [], 'pure failures must not create anything');
  }));

  it('§9.C32', 'BaselineMeta 是纯 JSON（无 Buffer/undefined），key 集合固定', () => withRoot((root) => {
    const store = storeFor(root);
    const meta = store.create(createInput(red, { mapping: mappingFixture() }));
    const roundTrip = JSON.parse(JSON.stringify(meta));
    assert.deepEqual(roundTrip, meta);
    assert.equal(Object.values(meta).some((value) => Buffer.isBuffer(value)), false);
    assert.deepEqual(Object.keys(meta).sort(), [...HEAD_FIELDS, 'headToken'].sort());
    for (const field of HEAD_FIELDS) assert.ok(Object.prototype.hasOwnProperty.call(meta, field), `meta.${field}`);
    assert.equal(typeof meta.headToken, 'string');
    assert.match(meta.headToken, /^[0-9a-f]{64}$/);
  }));
}

/* ------------------------------------------------------------------------------------------------
 * 直接运行：自汇总 + exitCode
 * ---------------------------------------------------------------------------------------------- */

const isMainModule = (() => {
  if (!process.argv[1]) return false;
  try {
    return pathToFileURL(process.argv[1]).href === import.meta.url;
  } catch {
    return false;
  }
})();

if (isMainModule) {
  const records = [];
  const startedAt = Date.now();
  await runBaselineChecks((criteria, label, pass, detail) => {
    records.push({ criteria, label, pass });
    if (pass) {
      console.log(`PASS ${criteria} ${label}`);
      return;
    }
    const lines = String(detail ?? '').split('\n').slice(0, 8).join('\n     ');
    console.log(`FAIL ${criteria} ${label}\n     ${lines}`);
  });
  const failed = records.filter((record) => !record.pass).length;
  const criteria = [...new Set(records.map((record) => record.criteria))];
  console.log('');
  console.log(`${records.length} checks, ${records.length - failed} passed, ${failed} failed (${Date.now() - startedAt}ms)`);
  console.log(`criteria covered: ${criteria.join(', ')}`);
  process.exitCode = failed === 0 ? 0 : 1;
}
