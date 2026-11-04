/**
 * vision-baseline.js — Web T3 受管基线存储（docs/t3-vision.md、§3.3、§8、§9 C33–C39）。
 *
 * 职责边界：本模块只负责“可信持久根 + 不可变 revision + head CAS + tombstone + 只读 list/get”，
 * 不做 PNG 解码/比较/产品 store，也不解析 source（index.js 负责把 source 解析成 product 后
 * 把同份已校验字节交给这里）。所有文件操作都是有限的同步调用；错误一律 BrowserError。
 *
 * 磁盘布局（scopeDir = <root>/output/vision-baselines/<sha256(scopeId).slice(0,32)>）：
 *   <scopeDir>/<name>/images/<revision>-<actionId>.png   （0600，no-clobber，永不原地覆盖）
 *   <scopeDir>/<name>/heads/0000000001.json              （0600，规范 JSON，十位零填充）
 *   <scopeDir>/<name>/heads/0000000002.json
 *   ...
 * 提交点 = 把 head 临时文件 `link` 成 `heads/<n>.json` 成功的那一刻；此前失败只清理本次临时文件
 * 与本次未引用 PNG，此后失败绝不删除已提交 HEAD/PNG（错误 details 带 committed:true）。
 *
 * 规范 head JSON：递归 key 字典序、无空白、末尾 LF；包含 BaselineMeta 全部字段，但不写 headToken
 * （headToken 在返回时按精确文件字节 sha256 计算）。parentHeadToken 是上一 head 文件字节的 sha256。
 *
 * image.relativePath 相对 **scopeDir**（即 `<name>/images/<revision>-<actionId>.png`），
 * 便于审计时从受管根定位文件。
 *
 * 方法全部是同步返回、同步抛错（`await` 兼容）；fsOps 可注入（键名同 node:fs 同步 API），
 * 用于故障注入与确定性单测。默认 node:fs。
 */
import { createHash, randomUUID } from 'node:crypto';
import * as nodeFs from 'node:fs';
import { isAbsolute, join, relative, sep } from 'node:path';

import { BrowserError } from './browser-safety.js';
import { PNG_SIGNATURE, asBuffer, inspectPng } from './capture-p0.js';

/**
 * 基线存储的公共限额（index.js 的 schema/capabilities 可复用；单测直接断言）。
 * maxRevision 与 §2.1 schema 的 revision/expectedRevision 上限一致。
 */
export const BASELINE_LIMITS = Object.freeze({
  maxRevision: 9_999_999_999,
  maxListEntries: 1_000,
  maxPngBytes: 32 * 1024 * 1024,
  maxPngPixels: 16_000_000,
  headNameWidth: 10,
  maxHeadBytes: 1024 * 1024,
});

const NAME_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/;
const SHA256_PATTERN = /^[0-9a-f]{64}$/;
const HEAD_FILE_PATTERN = /^(\d{10})\.json$/;
const IMAGE_FILE_PATTERN = /^(\d{1,10})-([a-zA-Z0-9][a-zA-Z0-9_-]{0,63})\.png$/;
const TEMP_PREFIX = '.tmp-';
const OUTPUT_SEGMENT = 'output';
const BASELINE_SEGMENT = 'vision-baselines';
const HEADS_SEGMENT = 'heads';
const IMAGES_SEGMENT = 'images';
const MAX_SAFE = Number.MAX_SAFE_INTEGER;
const MAX_PRODUCT_ID_LENGTH = 256;

/** BaselineMeta 的 head 文件字段（排序后），headToken 不写入自身。 */
const HEAD_FIELDS = Object.freeze([
  'caseId', 'createdAt', 'image', 'mapping', 'masks', 'name', 'options',
  'parentHeadToken', 'parentRevision', 'provenanceVersion', 'revision',
  'source', 'thresholds', 'tombstone',
]);
const OPTION_KEYS = Object.freeze(['includeAA', 'minRegionPixels', 'threshold']);
const THRESHOLD_KEYS = Object.freeze(['failRatio', 'warnRatio']);
const MASK_KEYS = 'id,region';
const RECT_KEYS = 'height,width,x,y';
const SOURCE_KEYS = 'capturedAt,documentEpoch,pageGeneration,productId,runtimeId,sha256';
const IMAGE_KEYS = 'bytes,height,relativePath,sha256,width';

/**
 * 默认算法默认值：与 docs/t3-vision.md 固定值一致。此处不 import vision-t3.js，
 * 避免基线存储依赖算法切片（默认值本身是契约常量，跨切片重复比隐式耦合安全）。
 */
const DEFAULT_DIFF_OPTIONS = Object.freeze({ threshold: 0.1, includeAA: false, minRegionPixels: 1 });
const DEFAULT_THRESHOLDS = Object.freeze({ warnRatio: 0.001, failRatio: 0.01 });

/** 目录 fsync 在这些 errno 下视为“平台不支持目录 fsync”，与 P0 publishCapture 一样按尽力而为处理。 */
const TOLERATED_DIR_FSYNC = new Set(['EINVAL', 'ENOTSUP', 'EISDIR', 'EBADF', 'ENOSYS', 'ENOTTY']);

const DEFAULT_FS_OPS = Object.freeze({
  realpathSync: nodeFs.realpathSync,
  statSync: nodeFs.statSync,
  lstatSync: nodeFs.lstatSync,
  mkdirSync: nodeFs.mkdirSync,
  chmodSync: nodeFs.chmodSync,
  readdirSync: nodeFs.readdirSync,
  readFileSync: nodeFs.readFileSync,
  openSync: nodeFs.openSync,
  writeSync: nodeFs.writeSync,
  fsyncSync: nodeFs.fsyncSync,
  closeSync: nodeFs.closeSync,
  linkSync: nodeFs.linkSync,
  unlinkSync: nodeFs.unlinkSync,
});

/* ------------------------------------------------------------------------------------------------
 * 纯工具
 * ---------------------------------------------------------------------------------------------- */

function sha256Hex(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value) && !Buffer.isBuffer(value);
}

function isInside(root, target) {
  const rel = relative(root, target);
  if (rel === '') return true;
  if (isAbsolute(rel)) return false;
  return rel !== '..' && !rel.startsWith('..' + sep);
}

/** 递归按 key 字典序排序（数组保持顺序），用于规范 JSON。 */
function canonicalize(value) {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value !== null && typeof value === 'object') {
    const out = {};
    for (const key of Object.keys(value).sort()) {
      if (value[key] === undefined) continue;
      out[key] = canonicalize(value[key]);
    }
    return out;
  }
  return value;
}

/** 规范 JSON：UTF8、key 递归字典序、无空白、末尾 LF。 */
function canonicalJson(value) {
  return JSON.stringify(canonicalize(value)) + '\n';
}

function cloneJson(value) {
  return JSON.parse(JSON.stringify(value));
}

function headFileName(revision) {
  return String(revision).padStart(BASELINE_LIMITS.headNameWidth, '0') + '.json';
}

function writeReasonFor(error) {
  const code = error && error.code ? String(error.code) : '';
  if (code === 'EACCES' || code === 'EPERM') return 'permission';
  if (code === 'EROFS') return 'read-only';
  return 'io';
}

/* ------------------------------------------------------------------------------------------------
 * 只做形状校验的读取器（返回 null 表示非法；写路径抛 INVALID_ARGUMENT，读路径报 READ_FAILED/corrupt）
 * ---------------------------------------------------------------------------------------------- */

function readRatio(value) {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 1 ? value : null;
}

function readInteger(value, min, max) {
  return typeof value === 'number' && Number.isInteger(value) && value >= min && value <= max ? value : null;
}

function readNameValue(value) {
  return typeof value === 'string' && NAME_PATTERN.test(value) ? value : null;
}

function readPixelRect(value) {
  if (!isPlainObject(value)) return null;
  if (Object.keys(value).sort().join(',') !== RECT_KEYS) return null;
  const x = readInteger(value.x, 0, MAX_SAFE);
  const y = readInteger(value.y, 0, MAX_SAFE);
  const width = readInteger(value.width, 1, MAX_SAFE);
  const height = readInteger(value.height, 1, MAX_SAFE);
  if (x === null || y === null || width === null || height === null) return null;
  return { x, y, width, height };
}

function readMaskList(value) {
  if (!Array.isArray(value) || value.length > 64) return null;
  const ids = new Set();
  const out = [];
  for (const entry of value) {
    if (!isPlainObject(entry)) return null;
    if (Object.keys(entry).sort().join(',') !== MASK_KEYS) return null;
    const id = readNameValue(entry.id);
    const region = readPixelRect(entry.region);
    if (!id || !region || ids.has(id)) return null;
    ids.add(id);
    out.push({ id, region });
  }
  return out;
}

/** 局部 options 覆盖（字段可缺省）；返回 partial 或 null。 */
function readOptionsPatch(value) {
  if (!isPlainObject(value)) return null;
  for (const key of Object.keys(value)) if (!OPTION_KEYS.includes(key)) return null;
  const out = {};
  if (value.threshold !== undefined) {
    const threshold = readRatio(value.threshold);
    if (threshold === null) return null;
    out.threshold = threshold;
  }
  if (value.includeAA !== undefined) {
    if (typeof value.includeAA !== 'boolean') return null;
    out.includeAA = value.includeAA;
  }
  if (value.minRegionPixels !== undefined) {
    const minRegionPixels = readInteger(value.minRegionPixels, 1, 16_000_000);
    if (minRegionPixels === null) return null;
    out.minRegionPixels = minRegionPixels;
  }
  return out;
}

function readOptionsFull(value) {
  if (!isPlainObject(value)) return null;
  if (Object.keys(value).sort().join(',') !== OPTION_KEYS.join(',')) return null;
  const patch = readOptionsPatch(value);
  if (!patch) return null;
  if (patch.threshold === undefined || patch.includeAA === undefined || patch.minRegionPixels === undefined) return null;
  return patch;
}

function readThresholdsPatch(value) {
  if (!isPlainObject(value)) return null;
  for (const key of Object.keys(value)) if (!THRESHOLD_KEYS.includes(key)) return null;
  const out = {};
  if (value.warnRatio !== undefined) {
    const warnRatio = readRatio(value.warnRatio);
    if (warnRatio === null) return null;
    out.warnRatio = warnRatio;
  }
  if (value.failRatio !== undefined) {
    const failRatio = readRatio(value.failRatio);
    if (failRatio === null) return null;
    out.failRatio = failRatio;
  }
  return out;
}

function readThresholdsFull(value) {
  if (!isPlainObject(value)) return null;
  if (Object.keys(value).sort().join(',') !== THRESHOLD_KEYS.join(',')) return null;
  const patch = readThresholdsPatch(value);
  if (!patch) return null;
  if (patch.warnRatio === undefined || patch.failRatio === undefined) return null;
  if (patch.warnRatio > patch.failRatio) return null;
  return patch;
}

function readNullableInteger(value) {
  if (value === null) return { ok: true, value: null };
  const parsed = readInteger(value, 0, MAX_SAFE);
  return parsed === null ? { ok: false, value: null } : { ok: true, value: parsed };
}

function readNullableString(value) {
  if (value === null) return { ok: true, value: null };
  return typeof value === 'string' ? { ok: true, value } : { ok: false, value: null };
}

/** 磁盘上的 source 摘要：必须恰好是写路径规范化的 6 个字段。 */
function readSourceSummary(value) {
  if (!isPlainObject(value)) return null;
  if (Object.keys(value).sort().join(',') !== SOURCE_KEYS) return null;
  const productId = typeof value.productId === 'string' && value.productId.length > 0
    && value.productId.length <= MAX_PRODUCT_ID_LENGTH ? value.productId : null;
  if (!productId) return null;
  if (typeof value.sha256 !== 'string' || !SHA256_PATTERN.test(value.sha256)) return null;
  const capturedAt = readNullableInteger(value.capturedAt);
  const pageGeneration = readNullableInteger(value.pageGeneration);
  const documentEpoch = readNullableInteger(value.documentEpoch);
  const runtimeId = readNullableString(value.runtimeId);
  if (!capturedAt.ok || !pageGeneration.ok || !documentEpoch.ok || !runtimeId.ok) return null;
  return {
    productId,
    sha256: value.sha256,
    capturedAt: capturedAt.value,
    runtimeId: runtimeId.value,
    pageGeneration: pageGeneration.value,
    documentEpoch: documentEpoch.value,
  };
}

/** image 元数据（不含 relativePath 的锚点校验）；返回规范化对象或 null。 */
function readImageMeta(value) {
  if (!isPlainObject(value)) return null;
  if (Object.keys(value).sort().join(',') !== IMAGE_KEYS) return null;
  const bytes = readInteger(value.bytes, 1, MAX_SAFE);
  const width = readInteger(value.width, 1, MAX_SAFE);
  const height = readInteger(value.height, 1, MAX_SAFE);
  if (bytes === null || width === null || height === null) return null;
  if (typeof value.sha256 !== 'string' || !SHA256_PATTERN.test(value.sha256)) return null;
  if (typeof value.relativePath !== 'string' || value.relativePath.length === 0) return null;
  return { relativePath: value.relativePath, sha256: value.sha256, width, height, bytes };
}

/**
 * 校验 image.relativePath 必须是 `<name>/images/<revision>-<actionId>.png`（相对 scopeDir），
 * 返回安全的文件名；任何 `..`、绝对路径、分隔符、revision 不符都返回 null。
 */
function imageFileName(relativePath, name, revision) {
  if (typeof relativePath !== 'string' || relativePath.length === 0) return null;
  if (relativePath.includes('\0') || relativePath.includes('\\')) return null;
  if (relativePath.startsWith('/') || /^[A-Za-z]:/.test(relativePath)) return null;
  const prefix = `${name}/${IMAGES_SEGMENT}/`;
  if (!relativePath.startsWith(prefix)) return null;
  const fileName = relativePath.slice(prefix.length);
  if (fileName.includes('/') || fileName.includes('\\')) return null;
  const match = IMAGE_FILE_PATTERN.exec(fileName);
  if (!match) return null;
  if (Number(match[1]) !== revision) return null;
  return fileName;
}

/* ------------------------------------------------------------------------------------------------
 * 作用域哈希 / store 构造
 * ---------------------------------------------------------------------------------------------- */

/**
 * scopeHash = sha256(scopeId UTF8).hex.slice(0,32)。scopeId 只来自可信解析链；
 * 缺失/空字符串按“scope 无工作区身份”处理（§3.3 ROOT_UNAVAILABLE）。
 */
export function baselineScopeHash(scopeId) {
  if (typeof scopeId !== 'string' || scopeId.trim() === '') {
    throw new BrowserError('VISION_BASELINE_ROOT_UNAVAILABLE', '基线持久根不可用', { reason: 'scope_invalid' });
  }
  return createHash('sha256').update(scopeId, 'utf8').digest('hex').slice(0, 32);
}

function canonicalRootOf(fs, root) {
  const unavailable = (reason) => new BrowserError(
    'VISION_BASELINE_ROOT_UNAVAILABLE', '基线持久根不可用', { reason },
  );
  if (typeof root !== 'string' || root.trim() === '') throw unavailable('root_missing');
  if (!isAbsolute(root)) throw unavailable('root_not_absolute');
  let info;
  try {
    info = fs.statSync(root);
  } catch {
    throw unavailable('root_unavailable');
  }
  if (!info.isDirectory()) throw unavailable('root_not_directory');
  try {
    return fs.realpathSync(root);
  } catch {
    throw unavailable('root_unavailable');
  }
}

function normalizeClock(now) {
  if (now === undefined || now === null) return () => Date.now();
  if (typeof now === 'number') {
    if (!Number.isInteger(now) || now < 0) {
      throw new BrowserError('INVALID_ARGUMENT', 'now 必须是有限非负整数或函数', { field: 'now' });
    }
    return () => now;
  }
  if (typeof now !== 'function') {
    throw new BrowserError('INVALID_ARGUMENT', 'now 必须是有限非负整数或函数', { field: 'now' });
  }
  return () => {
    const value = now();
    if (!Number.isInteger(value) || value < 0) {
      throw new BrowserError('INVALID_ARGUMENT', 'now() 必须返回有限非负整数', { field: 'now' });
    }
    return value;
  };
}

/**
 * 创建受管基线 store。同步 API：list/get/create/update/delete 直接返回值或抛 BrowserError。
 *
 * @param {{root?:string, scopeId?:string, now?:number|(()=>number), fsOps?:object}} [options]
 * @returns {{scopeHash:string, list:Function, get:Function, create:Function, update:Function, delete:Function}}
 */
export function createBaselineStore({ root, scopeId, now, fsOps } = {}) {
  const fs = { ...DEFAULT_FS_OPS };
  if (fsOps !== undefined && fsOps !== null) {
    if (typeof fsOps !== 'object') {
      throw new BrowserError('INVALID_ARGUMENT', 'fsOps 必须是对象', { field: 'fsOps' });
    }
    for (const key of Object.keys(fsOps)) {
      if (typeof fsOps[key] === 'function') fs[key] = fsOps[key];
    }
  }
  const clock = normalizeClock(now);
  const canonicalRoot = canonicalRootOf(fs, root);
  const scopeHash = baselineScopeHash(scopeId);
  const storeDir = join(canonicalRoot, OUTPUT_SEGMENT, BASELINE_SEGMENT, scopeHash);

  /* ----------------------------------------------------------------------------------------------
   * 错误构造（message/details 一律不含绝对路径）
   * -------------------------------------------------------------------------------------------- */

  function invalidArgument(message, field) {
    throw new BrowserError('INVALID_ARGUMENT', message, { field });
  }

  function baselineNameInvalid() {
    throw new BrowserError('VISION_BASELINE_NAME_INVALID', '基线名称不合法', { field: 'name' });
  }

  function notFound(name, revision) {
    const details = { name };
    if (revision !== undefined) details.revision = revision;
    throw new BrowserError('VISION_BASELINE_NOT_FOUND', '基线不存在', details);
  }

  function baselineExists(name) {
    throw new BrowserError('VISION_BASELINE_EXISTS', '基线名称已被使用', { name });
  }

  function baselineConflict(detail, extra) {
    throw new BrowserError('VISION_BASELINE_CONFLICT', '基线版本冲突', { detail, ...extra });
  }

  function readFailure(reason, detail, extra) {
    throw new BrowserError('VISION_BASELINE_READ_FAILED', '基线读取失败', { reason, detail, ...extra });
  }

  function writeFailure(reason, detail, extra) {
    throw new BrowserError('VISION_BASELINE_WRITE_FAILED', '基线写入失败', { reason, detail, ...extra });
  }

  function writeFailureFrom(error, detail) {
    writeFailure(writeReasonFor(error), detail, { fsCode: error && error.code ? String(error.code) : null });
  }

  function limitExceeded(limit, actual, max) {
    throw new BrowserError('VISION_LIMIT_EXCEEDED', '基线资源上限超限', { limit, actual, max });
  }

  /* ----------------------------------------------------------------------------------------------
   * 文件系统守卫
   * -------------------------------------------------------------------------------------------- */

  function lstatOrNull(path, mode) {
    try {
      return fs.lstatSync(path);
    } catch (error) {
      if (error && error.code === 'ENOENT') return null;
      const reason = mode === 'write' ? writeReasonFor(error) : 'io';
      const code = mode === 'write' ? 'VISION_BASELINE_WRITE_FAILED' : 'VISION_BASELINE_READ_FAILED';
      throw new BrowserError(code, mode === 'write' ? '基线写入失败' : '基线读取失败', {
        reason, detail: 'lstat_failed', fsCode: error && error.code ? String(error.code) : null,
      });
    }
  }

  function realpathChecked(path, mode) {
    let real;
    try {
      real = fs.realpathSync(path);
    } catch (error) {
      const reason = mode === 'write' ? writeReasonFor(error) : 'io';
      const code = mode === 'write' ? 'VISION_BASELINE_WRITE_FAILED' : 'VISION_BASELINE_READ_FAILED';
      throw new BrowserError(code, mode === 'write' ? '基线写入失败' : '基线读取失败', {
        reason, detail: 'realpath_failed', fsCode: error && error.code ? String(error.code) : null,
      });
    }
    if (!isInside(canonicalRoot, real)) {
      if (mode === 'write') writeFailure('io', 'path_escape');
      readFailure('io', 'path_escape');
    }
    return real;
  }

  function assertDirInfo(info, path, label, mode) {
    if (info.isSymbolicLink()) {
      if (mode === 'write') writeFailure('io', `${label}_symlink`);
      readFailure('io', `${label}_symlink`);
    }
    if (!info.isDirectory()) {
      if (mode === 'write') writeFailure('io', `${label}_not_directory`);
      readFailure('io', `${label}_not_directory`);
    }
    realpathChecked(path, mode);
  }

  function ensureDir(path) {
    const info = lstatOrNull(path, 'write');
    if (info) {
      assertDirInfo(info, path, 'dir', 'write');
      return;
    }
    try {
      fs.mkdirSync(path, { mode: 0o700 });
    } catch (error) {
      if (error && error.code === 'EEXIST') {
        const again = lstatOrNull(path, 'write');
        if (again) {
          assertDirInfo(again, path, 'dir', 'write');
          return;
        }
      }
      writeFailureFrom(error, 'mkdir_failed');
    }
    try {
      fs.chmodSync(path, 0o700);
    } catch (error) {
      writeFailureFrom(error, 'chmod_failed');
    }
    realpathChecked(path, 'write');
  }

  /**
   * 解析受管链 root/output/vision-baselines/<scopeHash>。
   * @param {{write?:boolean, create?:boolean}} [options]
   * @returns {{state:'absent'}|{state:'ready', storeDir:string}}
   */
  function resolveStore({ write = false, create = false } = {}) {
    const mode = write ? 'write' : 'read';
    let current = canonicalRoot;
    for (const segment of [OUTPUT_SEGMENT, BASELINE_SEGMENT, scopeHash]) {
      current = join(current, segment);
      const info = lstatOrNull(current, mode);
      if (!info) {
        if (!create) return { state: 'absent' };
        ensureDir(current);
        continue;
      }
      assertDirInfo(info, current, segment === scopeHash ? 'scope' : segment, mode);
    }
    return { state: 'ready', storeDir: current };
  }

  function ensureNameDirs(storeDirs, name) {
    const nameDir = join(storeDirs.storeDir, name);
    ensureDir(nameDir);
    const headsDir = join(nameDir, HEADS_SEGMENT);
    ensureDir(headsDir);
    const imagesDir = join(nameDir, IMAGES_SEGMENT);
    ensureDir(imagesDir);
    return { nameDir, headsDir, imagesDir };
  }

  /** update 已在读链时拿到 name 目录；只补 images/heads（例如崩溃遗留）并逐级守卫。 */
  function ensureExistingNameDirs(nameDirs) {
    ensureDir(nameDirs.nameDir);
    ensureDir(nameDirs.headsDir);
    ensureDir(nameDirs.imagesDir);
    return nameDirs;
  }

  function resolveNameDirs(storeDirs, name, mode) {
    const nameDir = join(storeDirs.storeDir, name);
    const nameInfo = lstatOrNull(nameDir, mode);
    if (!nameInfo) return { state: 'absent' };
    assertDirInfo(nameInfo, nameDir, 'name', mode);
    const headsDir = join(nameDir, HEADS_SEGMENT);
    const headsInfo = lstatOrNull(headsDir, mode);
    if (!headsInfo) return { state: 'uncommitted' };
    assertDirInfo(headsInfo, headsDir, 'heads', mode);
    return { state: 'ready', nameDir, headsDir, imagesDir: join(nameDir, IMAGES_SEGMENT) };
  }

  /* ----------------------------------------------------------------------------------------------
   * 输入规范化（写路径）
   * -------------------------------------------------------------------------------------------- */

  function assertName(name) {
    const parsed = readNameValue(name);
    if (!parsed) baselineNameInvalid();
    return parsed;
  }

  function assertCaseId(value) {
    const parsed = readNameValue(value);
    if (!parsed) invalidArgument('caseId 不合法', 'caseId');
    return parsed;
  }

  function assertActionId(actionId) {
    const parsed = readNameValue(actionId);
    if (!parsed) invalidArgument('actionId 不合法', 'actionId');
    return parsed;
  }

  function assertRevision(value, field) {
    const parsed = readInteger(value, 1, BASELINE_LIMITS.maxRevision);
    if (parsed === null) invalidArgument(`${field} 必须是 1..9999999999 的整数`, field);
    return parsed;
  }

  function normalizeSource(source) {
    if (!isPlainObject(source)) invalidArgument('source 必须是对象', 'source');
    const productId = typeof source.productId === 'string' && source.productId.length > 0
      && source.productId.length <= MAX_PRODUCT_ID_LENGTH ? source.productId : null;
    if (!productId) invalidArgument('source.productId 缺失或非法', 'source.productId');
    if (typeof source.sha256 !== 'string' || !SHA256_PATTERN.test(source.sha256)) {
      invalidArgument('source.sha256 缺失或非法', 'source.sha256');
    }
    const capturedAt = source.capturedAt === undefined || source.capturedAt === null
      ? { ok: true, value: null } : readNullableInteger(source.capturedAt);
    const pageGeneration = source.pageGeneration === undefined || source.pageGeneration === null
      ? { ok: true, value: null } : readNullableInteger(source.pageGeneration);
    const documentEpoch = source.documentEpoch === undefined || source.documentEpoch === null
      ? { ok: true, value: null } : readNullableInteger(source.documentEpoch);
    const runtimeId = source.runtimeId === undefined || source.runtimeId === null
      ? { ok: true, value: null } : readNullableString(source.runtimeId);
    if (!capturedAt.ok) invalidArgument('source.capturedAt 非法', 'source.capturedAt');
    if (!pageGeneration.ok) invalidArgument('source.pageGeneration 非法', 'source.pageGeneration');
    if (!documentEpoch.ok) invalidArgument('source.documentEpoch 非法', 'source.documentEpoch');
    if (!runtimeId.ok) invalidArgument('source.runtimeId 非法', 'source.runtimeId');
    return {
      productId,
      sha256: source.sha256,
      capturedAt: capturedAt.value,
      runtimeId: runtimeId.value,
      pageGeneration: pageGeneration.value,
      documentEpoch: documentEpoch.value,
    };
  }

  function normalizeMapping(value) {
    if (value === undefined) return { provided: false, value: null };
    if (value === null) return { provided: true, value: null };
    if (!isPlainObject(value)) invalidArgument('mapping 必须是对象或 null', 'mapping');
    try {
      return { provided: true, value: canonicalize(JSON.parse(JSON.stringify(value))) };
    } catch {
      invalidArgument('mapping 必须是 JSON 可序列化对象', 'mapping');
    }
    return { provided: true, value: null };
  }

  function resolveOptions(value, base) {
    const resolved = { ...(base === null || base === undefined ? DEFAULT_DIFF_OPTIONS : base) };
    if (value === undefined) return resolved;
    const patch = readOptionsPatch(value);
    if (!patch) invalidArgument('options 非法', 'options');
    return { ...resolved, ...patch };
  }

  function resolveThresholds(value, base) {
    const resolved = { ...(base === null || base === undefined ? DEFAULT_THRESHOLDS : base) };
    if (value !== undefined) {
      const patch = readThresholdsPatch(value);
      if (!patch) invalidArgument('thresholds 非法', 'thresholds');
      Object.assign(resolved, patch);
    }
    if (resolved.warnRatio > resolved.failRatio) {
      invalidArgument('thresholds.warnRatio 不能大于 failRatio', 'thresholds');
    }
    return resolved;
  }

  function resolveMasks(value, base) {
    if (value === undefined) return cloneJson(base === null || base === undefined ? [] : base);
    const masks = readMaskList(value);
    if (!masks) invalidArgument('masks 非法', 'masks');
    return masks;
  }

  /** 只读 PNG 签名 + IHDR 声明的宽高（不校验 CRC/块结构；结构交给 inspectPng）。 */
  function pngDeclaredSize(buffer) {
    if (buffer.length < 24) return null;
    if (!buffer.subarray(0, 8).equals(Buffer.from(PNG_SIGNATURE))) return null;
    const width = buffer.readUInt32BE(16);
    const height = buffer.readUInt32BE(20);
    if (!(width > 0) || !(height > 0)) return null;
    return { width, height };
  }

  /**
   * 校验并规范化 PNG 字节：结构/CRC/尺寸、字节与像素预算、与 source.sha256 一致。
   * 返回 {buffer, sha256, width, height, bytes}。
   */
  function preparePng(pngBytes, source) {
    const buffer = asBuffer(pngBytes);
    if (!buffer || buffer.length === 0) invalidArgument('pngBytes 必须是非空 Buffer/Uint8Array', 'pngBytes');
    if (buffer.length > BASELINE_LIMITS.maxPngBytes) {
      limitExceeded('maxPngBytes', buffer.length, BASELINE_LIMITS.maxPngBytes);
    }
    // 先按 IHDR 声明尺寸判像素预算：超过 16M px 一律 LIMIT_EXCEEDED，
    // 不让 inspectPng 的“异常尺寸”分支把资源超限误报成 INVALID_PNG。
    const declared = pngDeclaredSize(buffer);
    if (declared && declared.width * declared.height > BASELINE_LIMITS.maxPngPixels) {
      limitExceeded('maxPngPixels', declared.width * declared.height, BASELINE_LIMITS.maxPngPixels);
    }
    const info = inspectPng(buffer, { checkCrc: true });
    if (!info.ok) {
      throw new BrowserError('INVALID_PNG', '基线图像不是合法 PNG', { reason: 'invalid_png' });
    }
    if (info.width * info.height > BASELINE_LIMITS.maxPngPixels) {
      limitExceeded('maxPngPixels', info.width * info.height, BASELINE_LIMITS.maxPngPixels);
    }
    const copy = Buffer.from(buffer);
    const sha256 = sha256Hex(copy);
    if (source.sha256 !== sha256) {
      invalidArgument('source.sha256 与 pngBytes 不一致', 'source.sha256');
    }
    return { buffer: copy, sha256, width: info.width, height: info.height, bytes: copy.length };
  }

  function buildHead(fields) {
    return {
      name: fields.name,
      revision: fields.revision,
      parentRevision: fields.parentRevision,
      parentHeadToken: fields.parentHeadToken,
      tombstone: fields.tombstone,
      caseId: fields.caseId,
      createdAt: fields.createdAt,
      image: fields.image,
      options: fields.options,
      thresholds: fields.thresholds,
      masks: fields.masks,
      mapping: fields.mapping,
      source: fields.source,
      provenanceVersion: 1,
    };
  }

  /* ----------------------------------------------------------------------------------------------
   * 原子发布（wx 临时文件 + fsync + link no-clobber）
   * -------------------------------------------------------------------------------------------- */

  function writeAll(fd, bytes) {
    let offset = 0;
    while (offset < bytes.length) {
      const written = fs.writeSync(fd, bytes, offset, bytes.length - offset);
      if (!Number.isInteger(written) || written <= 0) {
        throw Object.assign(new Error('short write'), { code: 'EIO' });
      }
      offset += written;
    }
  }

  /** 返回 {ok:true} 或 {ok:false, exists:true}；其它失败抛 WRITE_FAILED 并清理临时文件。 */
  function publishFile(dir, targetPath, bytes, suffix) {
    const tempPath = join(dir, `${TEMP_PREFIX}${randomUUID()}${suffix}`);
    let fd;
    try {
      fd = fs.openSync(tempPath, 'wx', 0o600);
      writeAll(fd, bytes);
      fs.fsyncSync(fd);
      fs.closeSync(fd);
      fd = undefined;
    } catch (error) {
      if (fd !== undefined) {
        try { fs.closeSync(fd); } catch { /* ignore */ }
      }
      try { fs.unlinkSync(tempPath); } catch { /* ignore */ }
      writeFailureFrom(error, 'temp_write_failed');
    }
    try {
      fs.linkSync(tempPath, targetPath);
    } catch (error) {
      try { fs.unlinkSync(tempPath); } catch { /* ignore */ }
      if (error && (error.code === 'EEXIST' || error.code === 'EISDIR')) return { ok: false, exists: true };
      writeFailureFrom(error, 'link_failed');
    }
    try { fs.unlinkSync(tempPath); } catch { /* ignore */ }
    return { ok: true };
  }

  function fsyncDirectory(dir) {
    let fd;
    try {
      fd = fs.openSync(dir, 'r');
      fs.fsyncSync(fd);
      return { ok: true, code: null };
    } catch (error) {
      return { ok: false, code: error && error.code ? String(error.code) : null };
    } finally {
      if (fd !== undefined) {
        try { fs.closeSync(fd); } catch { /* ignore */ }
      }
    }
  }

  function unlinkQuietly(path) {
    try { fs.unlinkSync(path); } catch { /* ignore */ }
  }

  /** 发布 PNG（no-clobber）；成功后 fsync images 目录（提交前，可安全回滚）。 */
  function publishImage(nameDirs, name, revision, actionId, png) {
    const fileName = `${revision}-${actionId}.png`;
    const target = join(nameDirs.imagesDir, fileName);
    const published = publishFile(nameDirs.imagesDir, target, png.buffer, '.png');
    if (!published.ok) baselineConflict('image_exists', { name, revision });
    const synced = fsyncDirectory(nameDirs.imagesDir);
    if (!synced.ok && !TOLERATED_DIR_FSYNC.has(synced.code)) {
      unlinkQuietly(target);
      writeFailure('io', 'image_dir_fsync_failed', { name, revision, fsCode: synced.code });
    }
    return {
      fileName,
      target,
      meta: {
        relativePath: `${name}/${IMAGES_SEGMENT}/${fileName}`,
        sha256: png.sha256,
        width: png.width,
        height: png.height,
        bytes: png.bytes,
      },
    };
  }

  /**
   * 发布 head 文件（唯一提交点）。slotConflict='exists' 时 EEXIST 报 EXISTS（create），
   * 否则报 CONFLICT（update/delete）。提交成功后目录 fsync 的真实 I/O 失败报
   * WRITE_FAILED + details.committed=true，绝不删除已提交文件。
   */
  function publishHead({ nameDirs, name, head, bytes, slotConflict }) {
    const target = join(nameDirs.headsDir, headFileName(head.revision));
    const published = publishFile(nameDirs.headsDir, target, bytes, '.json');
    if (!published.ok) {
      if (slotConflict === 'exists') baselineExists(name);
      baselineConflict('head_slot_taken', { name, revision: head.revision });
    }
    const synced = fsyncDirectory(nameDirs.headsDir);
    if (!synced.ok && !TOLERATED_DIR_FSYNC.has(synced.code)) {
      writeFailure('io', 'head_dir_fsync_failed', {
        name, revision: head.revision, committed: true, fsCode: synced.code,
      });
    }
    return { ...head, headToken: sha256Hex(bytes) };
  }

  /* ----------------------------------------------------------------------------------------------
   * 读取 / 父链校验
   * -------------------------------------------------------------------------------------------- */

  function readHeadBytes(path, name, revision) {
    const info = lstatOrNull(path, 'read');
    if (!info) readFailure('corrupt', 'head_missing', { name, revision });
    if (info.isSymbolicLink()) readFailure('io', 'head_symlink', { name, revision });
    if (!info.isFile()) readFailure('io', 'head_not_file', { name, revision });
    if (info.size > BASELINE_LIMITS.maxHeadBytes) readFailure('corrupt', 'head_too_large', { name, revision });
    try {
      return fs.readFileSync(path);
    } catch {
      readFailure('io', 'head_read_failed', { name, revision });
    }
    return null;
  }

  function parseHead(bytes, { name, revision, prevMeta }) {
    const text = bytes.toString('utf8');
    let parsed;
    try {
      parsed = JSON.parse(text);
    } catch {
      readFailure('corrupt', 'head_invalid_json', { name, revision });
    }
    if (!isPlainObject(parsed)) readFailure('corrupt', 'head_not_object', { name, revision });
    const keys = Object.keys(parsed).sort();
    if (keys.length !== HEAD_FIELDS.length || keys.some((key, index) => key !== HEAD_FIELDS[index])) {
      readFailure('corrupt', 'head_unexpected_fields', { name, revision });
    }
    if (canonicalJson(parsed) !== text) readFailure('corrupt', 'head_not_canonical', { name, revision });
    if (parsed.name !== name) readFailure('corrupt', 'head_name_mismatch', { name, revision });
    if (parsed.revision !== revision) readFailure('corrupt', 'head_revision_mismatch', { name, revision });
    if (typeof parsed.tombstone !== 'boolean') readFailure('corrupt', 'head_tombstone_invalid', { name, revision });
    const caseId = readNameValue(parsed.caseId);
    if (!caseId) readFailure('corrupt', 'head_case_id_invalid', { name, revision });
    const createdAt = readInteger(parsed.createdAt, 0, MAX_SAFE);
    if (createdAt === null) readFailure('corrupt', 'head_created_at_invalid', { name, revision });
    if (parsed.provenanceVersion !== 1) readFailure('corrupt', 'head_provenance_invalid', { name, revision });

    if (revision === 1) {
      if (parsed.parentRevision !== null || parsed.parentHeadToken !== null) {
        readFailure('corrupt', 'head_parent_invalid', { name, revision });
      }
    } else {
      if (parsed.parentRevision !== revision - 1) readFailure('corrupt', 'head_parent_revision', { name, revision });
      if (!prevMeta || parsed.parentHeadToken !== prevMeta.headToken) {
        readFailure('corrupt', 'head_parent_token', { name, revision });
      }
    }

    let image = null;
    if (parsed.tombstone) {
      if (parsed.image !== null) readFailure('corrupt', 'head_tombstone_image', { name, revision });
    } else {
      image = readImageMeta(parsed.image);
      if (!image) readFailure('corrupt', 'head_image_invalid', { name, revision });
      if (!imageFileName(image.relativePath, name, revision)) {
        readFailure('corrupt', 'head_image_path', { name, revision });
      }
    }

    const options = readOptionsFull(parsed.options);
    if (!options) readFailure('corrupt', 'head_options_invalid', { name, revision });
    const thresholds = readThresholdsFull(parsed.thresholds);
    if (!thresholds) readFailure('corrupt', 'head_thresholds_invalid', { name, revision });
    const masks = readMaskList(parsed.masks);
    if (!masks) readFailure('corrupt', 'head_masks_invalid', { name, revision });
    const source = readSourceSummary(parsed.source);
    if (!source) readFailure('corrupt', 'head_source_invalid', { name, revision });
    let mapping = null;
    if (parsed.mapping !== null) {
      if (!isPlainObject(parsed.mapping)) readFailure('corrupt', 'head_mapping_invalid', { name, revision });
      mapping = canonicalize(parsed.mapping);
    }

    return {
      name,
      revision,
      parentRevision: parsed.parentRevision,
      parentHeadToken: parsed.parentHeadToken,
      tombstone: parsed.tombstone,
      caseId,
      createdAt,
      image,
      options,
      thresholds,
      masks,
      mapping,
      source,
      provenanceVersion: 1,
    };
  }

  /**
   * 读取某个名字的完整 head 链：1..max 必须连续存在、规范、父链接与 hash 全部有效。
   * 不跳过损坏记录复活旧 HEAD：任何缺号/损坏都报 READ_FAILED。
   */
  function readChain(storeDirs, name) {
    const nameDirs = resolveNameDirs(storeDirs, name, 'read');
    if (nameDirs.state !== 'ready') return { state: nameDirs.state };
    let entries;
    try {
      entries = fs.readdirSync(nameDirs.headsDir);
    } catch (error) {
      readFailure('io', 'heads_readdir_failed', {
        name, fsCode: error && error.code ? String(error.code) : null,
      });
    }
    const revisions = [];
    for (const entry of entries) {
      if (entry.startsWith(TEMP_PREFIX)) continue;
      const match = HEAD_FILE_PATTERN.exec(entry);
      if (match) {
        revisions.push(Number(match[1]));
        continue;
      }
      if (entry.endsWith('.json')) readFailure('corrupt', 'head_name_invalid', { name });
    }
    if (revisions.length === 0) return { state: 'uncommitted' };
    revisions.sort((a, b) => a - b);
    if (revisions[0] !== 1) readFailure('corrupt', 'head_chain_start', { name });
    for (let index = 0; index < revisions.length; index += 1) {
      if (revisions[index] !== index + 1) readFailure('corrupt', 'head_chain_gap', { name });
    }
    const max = revisions[revisions.length - 1];
    const metas = [];
    let prevMeta = null;
    for (let revision = 1; revision <= max; revision += 1) {
      const bytes = readHeadBytes(join(nameDirs.headsDir, headFileName(revision)), name, revision);
      const meta = parseHead(bytes, { name, revision, prevMeta });
      metas.push({ ...meta, headToken: sha256Hex(bytes) });
      prevMeta = metas[metas.length - 1];
    }
    return {
      state: 'ready',
      dirs: nameDirs,
      metas,
      head: metas[metas.length - 1],
    };
  }

  function readChainFor(name) {
    const storeDirs = resolveStore({ write: false });
    if (storeDirs.state === 'absent') return { state: 'absent' };
    return readChain(storeDirs, name);
  }

  /** 读取并验证某个非墓碑 revision 的 PNG 字节（缺失/符号链接/大小或 hash 不符都报 READ_FAILED）。 */
  function readPngBytes(chain, meta) {
    const name = meta.name;
    const revision = meta.revision;
    const fileName = imageFileName(meta.image.relativePath, name, revision);
    if (!fileName) readFailure('corrupt', 'image_path_invalid', { name, revision });
    const imagesDir = chain.dirs.imagesDir;
    const dirInfo = lstatOrNull(imagesDir, 'read');
    if (!dirInfo) readFailure('io', 'png_missing', { name, revision });
    if (dirInfo.isSymbolicLink() || !dirInfo.isDirectory()) readFailure('io', 'images_dir_invalid', { name, revision });
    realpathChecked(imagesDir, 'read');
    const pngPath = join(imagesDir, fileName);
    const info = lstatOrNull(pngPath, 'read');
    if (!info) readFailure('io', 'png_missing', { name, revision });
    if (info.isSymbolicLink()) readFailure('io', 'png_symlink', { name, revision });
    if (!info.isFile()) readFailure('io', 'png_not_file', { name, revision });
    let bytes;
    try {
      bytes = fs.readFileSync(pngPath);
    } catch {
      readFailure('io', 'png_read_failed', { name, revision });
    }
    if (bytes.length !== meta.image.bytes || sha256Hex(bytes) !== meta.image.sha256) {
      readFailure('hash-mismatch', 'png_hash_mismatch', { name, revision });
    }
    return bytes;
  }

  /* ----------------------------------------------------------------------------------------------
   * 公共操作
   * -------------------------------------------------------------------------------------------- */

  /** list：每个名字最新 HEAD（含 tombstone），名字字典序，≤1000；store 目录不存在返回 []。 */
  function list() {
    const storeDirs = resolveStore({ write: false });
    if (storeDirs.state === 'absent') return { ok: true, baselines: [] };
    let entries;
    try {
      entries = fs.readdirSync(storeDirs.storeDir);
    } catch (error) {
      readFailure('io', 'store_readdir_failed', {
        fsCode: error && error.code ? String(error.code) : null,
      });
    }
    const names = entries.filter((entry) => NAME_PATTERN.test(entry)).sort();
    if (names.length > BASELINE_LIMITS.maxListEntries) {
      limitExceeded('maxListEntries', names.length, BASELINE_LIMITS.maxListEntries);
    }
    const baselines = [];
    for (const name of names) {
      const chain = readChain(storeDirs, name);
      if (chain.state !== 'ready') continue;
      baselines.push(chain.head);
    }
    return { ok: true, baselines };
  }

  /**
   * get(name, revision?)：默认逻辑 HEAD（tombstone HEAD → NOT_FOUND）；
   * 显式旧 revision 可审计读取，恰为墓碑时成功返回 {meta, pngBytes:null}。
   */
  function get(name, revision) {
    const parsedName = assertName(name);
    let requested = null;
    if (revision !== undefined && revision !== null) requested = assertRevision(revision, 'revision');
    const chain = readChainFor(parsedName);
    if (chain.state !== 'ready') notFound(parsedName, requested === null ? undefined : requested);
    if (requested === null) {
      if (chain.head.tombstone) notFound(parsedName);
      return { ok: true, meta: chain.head, pngBytes: readPngBytes(chain, chain.head) };
    }
    if (requested > chain.head.revision) notFound(parsedName, requested);
    const meta = chain.metas[requested - 1];
    if (!meta) notFound(parsedName, requested);
    if (meta.tombstone) return { ok: true, meta, pngBytes: null };
    return { ok: true, meta, pngBytes: readPngBytes(chain, meta) };
  }

  function normalizeCreate(input) {
    if (!isPlainObject(input)) invalidArgument('create 参数必须是对象', 'input');
    const name = assertName(input.name);
    const actionId = assertActionId(input.actionId);
    const source = normalizeSource(input.source);
    const png = preparePng(input.pngBytes, source);
    const caseId = input.caseId === undefined ? name : assertCaseId(input.caseId);
    const options = resolveOptions(input.options, null);
    const thresholds = resolveThresholds(input.thresholds, null);
    const masks = resolveMasks(input.masks, null);
    const mapping = normalizeMapping(input.mapping);
    return { name, actionId, source, png, caseId, options, thresholds, masks, mapping };
  }

  function normalizeUpdate(input) {
    if (!isPlainObject(input)) invalidArgument('update 参数必须是对象', 'input');
    const name = assertName(input.name);
    const actionId = assertActionId(input.actionId);
    const expectedRevision = assertRevision(input.expectedRevision, 'expectedRevision');
    const source = normalizeSource(input.source);
    const png = preparePng(input.pngBytes, source);
    const caseId = input.caseId === undefined ? undefined : assertCaseId(input.caseId);
    if (input.options !== undefined && !readOptionsPatch(input.options)) {
      invalidArgument('options 非法', 'options');
    }
    if (input.thresholds !== undefined && !readThresholdsPatch(input.thresholds)) {
      invalidArgument('thresholds 非法', 'thresholds');
    }
    if (input.masks !== undefined && !readMaskList(input.masks)) {
      invalidArgument('masks 非法', 'masks');
    }
    const mapping = normalizeMapping(input.mapping);
    return { name, actionId, expectedRevision, source, png, caseId, mapping,
      optionsPatch: input.options, thresholdsPatch: input.thresholds, masksPatch: input.masks };
  }

  /** 名字是否已被提交使用（含 tombstone）；崩溃遗留的 images/临时文件不占用名字。 */
  function nameInUse(storeDirs, name) {
    const nameDir = join(storeDirs.storeDir, name);
    const nameInfo = lstatOrNull(nameDir, 'write');
    if (!nameInfo) return false;
    assertDirInfo(nameInfo, nameDir, 'name', 'write');
    const headsDir = join(nameDir, HEADS_SEGMENT);
    const headsInfo = lstatOrNull(headsDir, 'write');
    if (!headsInfo) return false;
    assertDirInfo(headsInfo, headsDir, 'heads', 'write');
    let entries;
    try {
      entries = fs.readdirSync(headsDir);
    } catch (error) {
      writeFailureFrom(error, 'heads_readdir_failed');
    }
    return entries.some((entry) => !entry.startsWith(TEMP_PREFIX));
  }

  /** create：名字不可复用（含 tombstone）；只在这里/update 建目录。 */
  function create(input) {
    const params = normalizeCreate(input);
    // 先取时间：注入时钟非法时必须在任何目录/PNG 副作用之前失败。
    const createdAt = clock();

    const existing = resolveStore({ write: true });
    if (existing.state === 'ready' && nameInUse(existing, params.name)) baselineExists(params.name);

    const storeDirs = resolveStore({ write: true, create: true });
    const nameDirs = ensureNameDirs(storeDirs, params.name);
    const image = publishImage(nameDirs, params.name, 1, params.actionId, params.png);

    const head = buildHead({
      name: params.name,
      revision: 1,
      parentRevision: null,
      parentHeadToken: null,
      tombstone: false,
      caseId: params.caseId,
      createdAt,
      image: image.meta,
      options: params.options,
      thresholds: params.thresholds,
      masks: params.masks,
      mapping: params.mapping.provided ? params.mapping.value : null,
      source: params.source,
    });
    const bytes = canonicalJson(head);
    try {
      return publishHead({ nameDirs, name: params.name, head, bytes, slotConflict: 'exists' });
    } catch (error) {
      if (!error || !error.details || error.details.committed !== true) unlinkQuietly(image.target);
      throw error;
    }
  }

  /** update：CAS(expectedRevision===HEAD) → 写不可变 PNG → 再读 parent → link 抢下一 head 槽。 */
  function update(input) {
    const params = normalizeUpdate(input);

    const chain = readChainFor(params.name);
    if (chain.state !== 'ready') notFound(params.name, params.expectedRevision);
    const head = chain.head;
    if (head.tombstone) notFound(params.name);
    if (head.revision !== params.expectedRevision) {
      baselineConflict('expected_revision_mismatch', {
        name: params.name, expectedRevision: params.expectedRevision, headRevision: head.revision,
      });
    }
    const nextRevision = head.revision + 1;
    if (nextRevision > BASELINE_LIMITS.maxRevision) {
      limitExceeded('maxRevision', nextRevision, BASELINE_LIMITS.maxRevision);
    }
    const createdAt = clock();

    const resolved = {
      caseId: params.caseId === undefined ? head.caseId : params.caseId,
      options: resolveOptions(params.optionsPatch, head.options),
      thresholds: resolveThresholds(params.thresholdsPatch, head.thresholds),
      masks: resolveMasks(params.masksPatch, head.masks),
      mapping: params.mapping.provided ? params.mapping.value : cloneJson(head.mapping),
    };

    const nameDirs = ensureExistingNameDirs(chain.dirs);
    const image = publishImage(nameDirs, params.name, nextRevision, params.actionId, params.png);

    // 发布前再次读 parent：确认父链没有被并发写者推进（link 仍可能输，见 publishHead）。
    // 复验本身失败（并发损坏/读失败）也属于提交前失败：清理本次未引用 PNG 后再抛。
    let again;
    try {
      again = readChainFor(params.name);
    } catch (error) {
      unlinkQuietly(image.target);
      throw error;
    }
    if (again.state !== 'ready' || again.head.revision !== head.revision || again.head.headToken !== head.headToken) {
      unlinkQuietly(image.target);
      baselineConflict('parent_changed', { name: params.name, expectedRevision: head.revision });
    }

    const newHead = buildHead({
      name: params.name,
      revision: nextRevision,
      parentRevision: head.revision,
      parentHeadToken: head.headToken,
      tombstone: false,
      caseId: resolved.caseId,
      createdAt,
      image: image.meta,
      options: resolved.options,
      thresholds: resolved.thresholds,
      masks: resolved.masks,
      mapping: resolved.mapping,
      source: params.source,
    });
    const bytes = canonicalJson(newHead);
    try {
      return publishHead({ nameDirs: again.dirs, name: params.name, head: newHead, bytes, slotConflict: 'conflict' });
    } catch (error) {
      if (!error || !error.details || error.details.committed !== true) unlinkQuietly(image.target);
      throw error;
    }
  }

  /** delete：不建目录、不删 PNG；追加 tombstone HEAD（CAS）。 */
  function remove(input) {
    if (!isPlainObject(input)) invalidArgument('delete 参数必须是对象', 'input');
    const name = assertName(input.name);
    const expectedRevision = assertRevision(input.expectedRevision, 'expectedRevision');
    if (input.actionId !== undefined && input.actionId !== null) assertActionId(input.actionId);

    const chain = readChainFor(name);
    if (chain.state !== 'ready') notFound(name, expectedRevision);
    const head = chain.head;
    if (head.tombstone) notFound(name);
    if (head.revision !== expectedRevision) {
      baselineConflict('expected_revision_mismatch', {
        name, expectedRevision, headRevision: head.revision,
      });
    }
    const nextRevision = head.revision + 1;
    if (nextRevision > BASELINE_LIMITS.maxRevision) {
      limitExceeded('maxRevision', nextRevision, BASELINE_LIMITS.maxRevision);
    }
    const createdAt = clock();

    const tombstone = buildHead({
      name,
      revision: nextRevision,
      parentRevision: head.revision,
      parentHeadToken: head.headToken,
      tombstone: true,
      caseId: head.caseId,
      createdAt,
      image: null,
      options: cloneJson(head.options),
      thresholds: cloneJson(head.thresholds),
      masks: cloneJson(head.masks),
      mapping: cloneJson(head.mapping),
      source: cloneJson(head.source),
    });
    const bytes = canonicalJson(tombstone);
    return publishHead({ nameDirs: chain.dirs, name, head: tombstone, bytes, slotConflict: 'conflict' });
  }

  return { scopeHash, list, get, create, update, delete: remove };
}
