/**
 * cookie-store.js — FR-11 Cookie Store 读取与受控凭据导出（docs/internal/security-testing-plan.md §4）。
 *
 * 设计边界（需求说明书 FR-11 / 验收清单 CRED-01..CRED-10）：
 *  1. 首期 CDP 走 `Network.getCookies({urls:[authorizedUrl]})`；不以 `Storage.getCookies` 兜底。
 *  2. `url` 与当前 Tab Origin 精确一致（协议+主机+端口）；same-site 不等于 same-origin。
 *  3. `metadata` 模式只返回名称/Domain/Path/Expires/Secure/HttpOnly/SameSite 等元数据，永不返回 value。
 *  4. `export` 模式必须有 `out`；授权由人类签发的授权记录（Host 配置目录 security-approvals.json）
 *     提供，绑定 workspace/runtime/tab/origin/HttpOnly/一次性标识和过期时间；Agent 传入的
 *     `confirm` 字符串一律无效（GATE-03）。
 *  5. HttpOnly 默认不导出；需授权记录中 `allowHttpOnly: true` 的专项授权。
 *  6. Cookie value 不进入工具响应、Agent 上下文、日志或错误消息；明文只写入受控文件。
 *  7. 文件写入走受控持久根 + 防穿越（复用 capture-p0 resolveCapturePath 语义）+ 原子 no-clobber
 *     + 0600；超限整次失败，不截断单个 value，不输出部分快照。
 *  8. Network P0 的 Cookie/Set-Cookie 脱敏管线保持不变；本模块不经过它。
 *
 * 纯函数核心（originOf / redactCookieValue / metadataOf / buildApprovalQuery / validateApproval…）
 * 无 CDP 无文件依赖，单元测试无需浏览器；CDP 调用与文件落盘由 Host 层组合。
 */
import { basename, dirname, isAbsolute, join, relative as relativePath, resolve, sep } from 'node:path';
import { closeSync, existsSync, fsyncSync, linkSync, mkdirSync, openSync, readFileSync, realpathSync, renameSync, statSync, unlinkSync, writeSync } from 'node:fs';
import { randomUUID } from 'node:crypto';

/** 模块版本：写进导出快照 meta，格式演进时可区分。 */
export const COOKIE_STORE_VERSION = 1;

/** 一次导出允许的最大 Cookie 条数（超限整次失败，绝不截断）。 */
export const COOKIE_MAX_COUNT = 512;

/** 单个 Cookie value 的最大字节数（RFC 6265 上限 4096；超出视为异常整次失败）。 */
export const COOKIE_MAX_VALUE_BYTES = 4096;

/** 导出文件最大字节数（所有条目合计）。 */
export const COOKIE_MAX_TOTAL_BYTES = 2 * 1024 * 1024;

/** metadata 模式允许的字段白名单——value 及任何派生值被结构性排除。 */
export const COOKIE_METADATA_FIELDS = Object.freeze([
  'name', 'domain', 'path', 'expires', 'size', 'httpOnly', 'secure', 'session', 'sameSite',
  'priority', 'sourceScheme', 'sourcePort',
]);

/** 一次性授权记录的必需字段（security-approvals.json 单条记录）。 */
export const APPROVAL_REQUIRED_FIELDS = Object.freeze([
  'approvalId', 'origin', 'tabId', 'workspaceId', 'runtimeId', 'allowHttpOnly', 'issuedAt', 'expiresAt',
]);

/* -----------------------------------------------------------------------------------------------
 * 错误码：COOKIE_* 系列（browser-safety.js TAXONOMY 注册后生效；此处只引用字符串）。
 * ---------------------------------------------------------------------------------------------- */

/** 模块内部使用的错误码集合（Host 层把它们映射成 BrowserError）。 */
export const COOKIE_ERROR_CODES = Object.freeze({
  INVALID_ARGUMENT: 'COOKIE_INVALID_ARGUMENT',
  NO_RUNTIME: 'COOKIE_RUNTIME_UNAVAILABLE',
  ORIGIN_MISMATCH: 'COOKIE_ORIGIN_MISMATCH',
  SCOPE_FORBIDDEN: 'COOKIE_SCOPE_FORBIDDEN',
  APPROVAL_REQUIRED: 'COOKIE_APPROVAL_REQUIRED',
  APPROVAL_INVALID: 'COOKIE_APPROVAL_INVALID',
  APPROVAL_CONSUMED: 'COOKIE_APPROVAL_CONSUMED',
  APPROVAL_EXPIRED: 'COOKIE_APPROVAL_EXPIRED',
  HTTP_ONLY_FORBIDDEN: 'COOKIE_HTTPONLY_FORBIDDEN',
  QUOTA_EXCEEDED: 'COOKIE_QUOTA_EXCEEDED',
  OUTPUT_PATH_INVALID: 'COOKIE_OUTPUT_PATH_INVALID',
  OUTPUT_EXISTS: 'COOKIE_OUTPUT_EXISTS',
  OUTPUT_WRITE_FAILED: 'COOKIE_OUTPUT_WRITE_FAILED',
  ROOT_UNKNOWN: 'COOKIE_OUTPUT_ROOT_UNKNOWN',
  CDP_FAILED: 'COOKIE_CDP_FAILED',
  IMPORT_INVALID: 'COOKIE_IMPORT_INVALID',
});

/* -----------------------------------------------------------------------------------------------
 * Origin 精确匹配
 * ---------------------------------------------------------------------------------------------- */

/**
 * 从 URL 字符串提取精确 Origin（协议+主机+端口；IPv6 括号保持）。
 * 空串/解析失败返回 null —— 调用方必须 fail closed。
 */
export function originOf(url) {
  if (typeof url !== 'string' || url.trim() === '') return null;
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return null;
  // URL.origin 对 IPv6 返回 `[::1]:8088` 形态，对默认端口返回不带端口的形态——保持精确字面量。
  return parsed.origin;
}

/**
 * 精确 same-origin 比较：字符串全等。same-site（不同端口/协议）不通过。
 * 任何一侧无法解析都返回 false（fail closed）。
 */
export function isSameOrigin(urlA, urlB) {
  const a = originOf(urlA);
  const b = originOf(urlB);
  return a !== null && b !== null && a === b;
}

/* -----------------------------------------------------------------------------------------------
 * CDP Cookie 规范化
 * ---------------------------------------------------------------------------------------------- */

/**
 * 把 CDP `Network.getCookies` 的一条 Cookie 规范化为内部形态。
 * value 保留在内存对象中供 export 使用；所有对外视图（metadata/error/log）都必须经过投影。
 */
export function normalizeCookie(raw) {
  if (typeof raw !== 'object' || raw === null || typeof raw.name !== 'string') return null;
  if (typeof raw.value !== 'string') return null;
  const valueBytes = Buffer.byteLength(raw.value, 'utf8');
  if (valueBytes > COOKIE_MAX_VALUE_BYTES) return null; // 异常超长：整批失败路径的信号
  return {
    name: String(raw.name),
    value: String(raw.value),
    domain: typeof raw.domain === 'string' ? raw.domain : '',
    path: typeof raw.path === 'string' ? raw.path : '/',
    expires: Number.isFinite(raw.expires) && raw.expires > 0 ? raw.expires : (raw.session === true ? -1 : -1),
    size: typeof raw.size === 'number' ? raw.size : valueBytes,
    httpOnly: raw.httpOnly === true,
    secure: raw.secure === true,
    session: raw.session !== false && !(Number.isFinite(raw.expires) && raw.expires > 0),
    sameSite: typeof raw.sameSite === 'string' ? raw.sameSite : 'unspecified',
    priority: typeof raw.priority === 'string' ? raw.priority : 'Medium',
    sourceScheme: typeof raw.sourceScheme === 'string' ? raw.sourceScheme : null,
    sourcePort: typeof raw.sourcePort === 'number' ? raw.sourcePort : null,
  };
}

/**
 * metadata 视图投影：白名单字段逐个挑出；value 与任何含 value 的键被结构性排除。
 * 这是 CRED-02 的实现点——默认 HttpOnly value 出现次数必须为 0。
 */
export function metadataOf(cookie) {
  const view = {};
  for (const field of COOKIE_METADATA_FIELDS) {
    if (field in cookie) view[field] = cookie[field];
  }
  return view;
}

/**
 * 受控导出条目：除 metadata 字段外加 value（只允许进入文件字节流）。
 * 返回的条目只应被 JSON.stringify 进受控文件；不得进入工具响应。
 */
export function exportEntryOf(cookie) {
  const entry = metadataOf(cookie);
  entry.value = cookie.value;
  return entry;
}

/** 展示/日志用的 value 遮蔽（防御性：即使误流入日志也不泄漏）。 */
export function redactCookieValue(cookie) {
  const view = metadataOf(cookie);
  view.valueLength = Buffer.byteLength(String(cookie.value ?? ''), 'utf8');
  return view;
}

/* -----------------------------------------------------------------------------------------------
 * 人类授权记录（GATE-03：Agent 自我确认无效）
 * ---------------------------------------------------------------------------------------------- */

/**
 * 导出请求的授权查询键。授权必须绑定：workspace/runtime/tab/origin/HttpOnly/一次性。
 * Agent 传 confirm 字符串不参与任何判定——它在进入本函数前就应被丢弃。
 */
export function buildApprovalQuery({ workspaceId = null, runtimeId = null, tabId = null, origin = null, allowHttpOnly = false } = {}) {
  return {
    workspaceId: workspaceId === null ? null : String(workspaceId),
    runtimeId: runtimeId === null ? null : String(runtimeId),
    tabId: tabId === null ? null : String(tabId),
    origin: origin === null ? null : String(origin),
    allowHttpOnly: allowHttpOnly === true,
  };
}

/**
 * 校验一条人类签发的授权记录是否恰好匹配查询。
 *
 * 规则（全部为硬性）：
 *  - 记录必需字段齐全且类型正确；
 *  - origin/workspace/runtime/tab 四元组与查询精确相等（null 只匹配 null）；
 *  - now 在 [issuedAt, expiresAt] 窗口内（毫秒时间戳）；过期即拒绝；
 *  - 查询需要 HttpOnly 时记录必须 allowHttpOnly: true；反之不要求；
 *  - revoked: true 的记录直接拒绝；
 *  - 记录的 `consumedAt` 存在（一次性已用）→ 拒绝（消耗检查由 Host 层在成功导出后写入）。
 *
 * 返回 { ok:true, approval } 或 { ok:false, code, reason }。
 */
export function validateApproval(approval, query, { now = Date.now() } = {}) {
  if (typeof approval !== 'object' || approval === null) {
    return { ok: false, code: COOKIE_ERROR_CODES.APPROVAL_INVALID, reason: 'approval-missing' };
  }
  for (const field of APPROVAL_REQUIRED_FIELDS) {
    if (!(field in approval)) {
      return { ok: false, code: COOKIE_ERROR_CODES.APPROVAL_INVALID, reason: 'field-missing:' + field };
    }
  }
  if (approval.revoked === true) {
    return { ok: false, code: COOKIE_ERROR_CODES.APPROVAL_INVALID, reason: 'revoked' };
  }
  if (typeof approval.approvalId !== 'string' || approval.approvalId.length === 0) {
    return { ok: false, code: COOKIE_ERROR_CODES.APPROVAL_INVALID, reason: 'approvalId-type' };
  }
  const origin = typeof approval.origin === 'string' ? originOf(approval.origin) : null;
  if (origin === null || origin !== approval.origin) {
    return { ok: false, code: COOKIE_ERROR_CODES.APPROVAL_INVALID, reason: 'origin-format' };
  }
  if (query.origin !== null && approval.origin !== query.origin) {
    return { ok: false, code: COOKIE_ERROR_CODES.APPROVAL_REQUIRED, reason: 'origin-mismatch' };
  }
  if (query.workspaceId !== null && approval.workspaceId !== query.workspaceId) {
    return { ok: false, code: COOKIE_ERROR_CODES.APPROVAL_REQUIRED, reason: 'workspace-mismatch' };
  }
  if (query.runtimeId !== null && approval.runtimeId !== query.runtimeId) {
    return { ok: false, code: COOKIE_ERROR_CODES.APPROVAL_REQUIRED, reason: 'runtime-mismatch' };
  }
  if (query.tabId !== null && approval.tabId !== query.tabId) {
    return { ok: false, code: COOKIE_ERROR_CODES.APPROVAL_REQUIRED, reason: 'tab-mismatch' };
  }
  const issuedAt = typeof approval.issuedAt === 'number' ? approval.issuedAt : Number.NaN;
  const expiresAt = typeof approval.expiresAt === 'number' ? approval.expiresAt : Number.NaN;
  if (!Number.isFinite(issuedAt) || !Number.isFinite(expiresAt) || expiresAt <= issuedAt) {
    return { ok: false, code: COOKIE_ERROR_CODES.APPROVAL_INVALID, reason: 'window-invalid' };
  }
  if (now < issuedAt) {
    return { ok: false, code: COOKIE_ERROR_CODES.APPROVAL_INVALID, reason: 'not-yet-valid' };
  }
  if (now > expiresAt) {
    return { ok: false, code: COOKIE_ERROR_CODES.APPROVAL_EXPIRED, reason: 'expired' };
  }
  if (approval.consumedAt !== undefined && approval.consumedAt !== null) {
    return { ok: false, code: COOKIE_ERROR_CODES.APPROVAL_CONSUMED, reason: 'one-shot-consumed' };
  }
  if (query.allowHttpOnly === true && approval.allowHttpOnly !== true) {
    return { ok: false, code: COOKIE_ERROR_CODES.HTTP_ONLY_FORBIDDEN, reason: 'httpOnly-not-granted' };
  }
  return { ok: true, approval };
}

/* -----------------------------------------------------------------------------------------------
 * 受控文件写入（持久根 + 防穿越 + 原子 no-clobber + 0600）
 * ---------------------------------------------------------------------------------------------- */

const COOKIE_EXPORT_EXTENSIONS = ['.json'];

function pathFail(reason, message, details = {}) {
  return { ok: false, code: reason, message, details };
}

/**
 * 解析导出路径：必须在持久根内、POSIX 相对、无穿越段、扩展名 .json。
 * 语义与 network-p0 resolveEvidencePath 一致（capture-p0 resolveCapturePath 家族）。
 */
export function resolveCookieExportPath({ root, out, defaultName } = {}) {
  if (typeof root !== 'string' || root.trim() === '' || !isAbsolute(root)) {
    return pathFail(COOKIE_ERROR_CODES.ROOT_UNKNOWN, '凭据导出根必须是绝对路径');
  }
  let canonicalRoot;
  try {
    const info = statSync(root);
    if (!info.isDirectory()) return pathFail(COOKIE_ERROR_CODES.ROOT_UNKNOWN, '凭据导出根不是目录');
    canonicalRoot = realpathSync(root);
  } catch {
    return pathFail(COOKIE_ERROR_CODES.ROOT_UNKNOWN, '凭据导出根不可用');
  }
  const requested = out === undefined || out === null || out === '' ? defaultName : out;
  if (typeof requested !== 'string' || requested.trim() === '') {
    return pathFail(COOKIE_ERROR_CODES.OUTPUT_PATH_INVALID, '导出路径不能为空');
  }
  if (requested.includes('\0')) return pathFail(COOKIE_ERROR_CODES.OUTPUT_PATH_INVALID, '导出路径不能含 NUL');
  if (requested.includes('\\')) return pathFail(COOKIE_ERROR_CODES.OUTPUT_PATH_INVALID, '导出路径必须使用 POSIX 分隔符');
  if (/^[A-Za-z]:/.test(requested) || isAbsolute(requested) || requested.startsWith('//')) {
    return pathFail(COOKIE_ERROR_CODES.OUTPUT_PATH_INVALID, '导出路径必须是持久根内的相对路径');
  }
  if (Buffer.byteLength(requested, 'utf8') > 200) {
    return pathFail(COOKIE_ERROR_CODES.OUTPUT_PATH_INVALID, '导出路径超过 200 字节');
  }
  const segments = requested.split('/');
  for (const segment of segments) {
    if (segment === '' || segment === '.' || segment === '..') {
      return pathFail(COOKIE_ERROR_CODES.OUTPUT_PATH_INVALID, '导出路径不能含空段、"." 或 ".."');
    }
    if (Buffer.byteLength(segment, 'utf8') > 100) {
      return pathFail(COOKIE_ERROR_CODES.OUTPUT_PATH_INVALID, '导出路径单段超过 100 字节');
    }
  }
  const name = segments[segments.length - 1];
  if (!COOKIE_EXPORT_EXTENSIONS.some((extension) => name.endsWith(extension))) {
    return pathFail(COOKIE_ERROR_CODES.OUTPUT_PATH_INVALID, '导出文件扩展名必须是 .json', { extensions: COOKIE_EXPORT_EXTENSIONS });
  }
  const inside = (parent, child) => {
    const rel = relativePath(parent, child);
    return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel));
  };
  const targetAbsolute = resolve(canonicalRoot, requested);
  if (!inside(canonicalRoot, targetAbsolute)) {
    return pathFail(COOKIE_ERROR_CODES.OUTPUT_PATH_INVALID, '导出路径逃出持久根');
  }
  let dir;
  try {
    mkdirSync(dirname(targetAbsolute), { recursive: true });
    dir = realpathSync(dirname(targetAbsolute));
  } catch (error) {
    return pathFail(COOKIE_ERROR_CODES.OUTPUT_WRITE_FAILED, '导出目录创建失败', { code: error && error.code ? String(error.code) : null });
  }
  if (!inside(canonicalRoot, dir) && dir !== canonicalRoot) {
    return pathFail(COOKIE_ERROR_CODES.OUTPUT_PATH_INVALID, '导出目录解析到根之外');
  }
  const absolutePath = resolve(dir, name);
  if (dirname(absolutePath) !== dir) {
    return pathFail(COOKIE_ERROR_CODES.OUTPUT_PATH_INVALID, '导出文件名解析异常');
  }
  return { ok: true, root: canonicalRoot, dir, name, absolutePath };
}

/**
 * 原子 no-clobber 写：临时文件 `wx` + fsync + link 提交；EEXIST = 已存在，绝不覆盖。
 * 成功返回 { ok:true, bytes, mode }；失败返回 { ok:false, code, message, details }。
 */
export function publishCookieExport(dir, absolutePath, bytes, { mode = 0o600, now = Date.now } = {}) {
  const name = typeof absolutePath === 'string' ? basename(absolutePath) : null;
  if (typeof dir !== 'string' || !isAbsolute(dir)) {
    return { ok: false, code: COOKIE_ERROR_CODES.OUTPUT_WRITE_FAILED, message: '导出目录必须是绝对路径', details: { reason: 'dir_not_absolute' } };
  }
  if (typeof absolutePath !== 'string' || !isAbsolute(absolutePath) || resolve(dirname(absolutePath)) !== resolve(dir)) {
    return { ok: false, code: COOKIE_ERROR_CODES.OUTPUT_WRITE_FAILED, message: '导出文件必须位于导出目录内', details: { reason: 'cross_directory', name } };
  }
  const data = Buffer.isBuffer(bytes) ? bytes : Buffer.from(String(bytes ?? ''), 'utf8');
  if (data.length === 0) {
    return { ok: false, code: COOKIE_ERROR_CODES.OUTPUT_WRITE_FAILED, message: '导出内容为空', details: { reason: 'empty_bytes', name } };
  }
  const fileMode = Number.isInteger(mode) && mode > 0 && mode <= 0o777 ? mode : 0o600;
  const modeString = '0' + (fileMode & 0o777).toString(8).padStart(3, '0');
  const tempPath = join(dir, '.tmp-cookie-' + randomUUID() + '.json');
  let fd;
  try {
    fd = openSync(tempPath, 'wx', fileMode);
    writeSync(fd, data);
    fsyncSync(fd);
    closeSync(fd);
    fd = undefined;
  } catch (error) {
    if (fd !== undefined) { try { closeSync(fd); } catch { /* ignore */ } }
    try { unlinkSync(tempPath); } catch { /* ignore */ }
    return { ok: false, code: COOKIE_ERROR_CODES.OUTPUT_WRITE_FAILED, message: '导出临时文件写入失败', details: { reason: 'temp_write_failed', code: error && error.code ? String(error.code) : null, name } };
  }
  try {
    linkSync(tempPath, absolutePath);
  } catch (error) {
    try { unlinkSync(tempPath); } catch { /* ignore */ }
    if (error && (error.code === 'EEXIST' || error.code === 'EISDIR')) {
      return { ok: false, code: COOKIE_ERROR_CODES.OUTPUT_EXISTS, message: '导出文件已存在；本工具绝不覆盖', details: { reason: 'output_exists', name } };
    }
    return { ok: false, code: COOKIE_ERROR_CODES.OUTPUT_WRITE_FAILED, message: '导出文件提交失败', details: { reason: 'publish_failed', code: error && error.code ? String(error.code) : null, name } };
  }
  try { unlinkSync(tempPath); } catch { /* 提交点已过：清理失败只记录 */ }
  let dirFsync = false;
  try {
    const dirFd = openSync(dir, 'r');
    try { fsyncSync(dirFd); dirFsync = true; } finally { closeSync(dirFd); }
  } catch { /* 某些文件系统不支持目录 fsync */ }
  return { ok: true, path: absolutePath, bytes: data.length, mode: modeString, createdAt: now(), dirFsync };
}

/* -----------------------------------------------------------------------------------------------
 * 导出快照组装
 * ---------------------------------------------------------------------------------------------- */

/**
 * 组装导出 JSON 快照。全部条目先过额度检查：任何一条异常（超长 value）→ 整次失败返回 null
 * 的 { ok:false }，绝不输出部分快照（CRED-07）。
 *
 * @param {Array<object>} cookies 规范化后的 Cookie 数组
 * @param {{scope:{workspaceId,runtimeId,tabId,origin}, approvalId:string, includeHttpOnly:boolean,
 *          exportedAt?:number}} context
 */
export function buildExportSnapshot(cookies, context) {
  if (!Array.isArray(cookies)) {
    return { ok: false, code: COOKIE_ERROR_CODES.INVALID_ARGUMENT, message: 'cookies 必须是数组' };
  }
  if (cookies.length > COOKIE_MAX_COUNT) {
    return { ok: false, code: COOKIE_ERROR_CODES.QUOTA_EXCEEDED, message: 'Cookie 条数超过导出上限', details: { max: COOKIE_MAX_COUNT, got: cookies.length } };
  }
  const entries = [];
  for (const cookie of cookies) {
    if (cookie === null || typeof cookie !== 'object') {
      return { ok: false, code: COOKIE_ERROR_CODES.INVALID_ARGUMENT, message: 'cookies 含非法条目' };
    }
    const valueBytes = Buffer.byteLength(String(cookie.value ?? ''), 'utf8');
    if (valueBytes > COOKIE_MAX_VALUE_BYTES) {
      return { ok: false, code: COOKIE_ERROR_CODES.QUOTA_EXCEEDED, message: '单个 Cookie value 超过上限；整次失败，不截断', details: { max: COOKIE_MAX_VALUE_BYTES, name: cookie.name } };
    }
    if (context.includeHttpOnly !== true && cookie.httpOnly === true) {
      return { ok: false, code: COOKIE_ERROR_CODES.HTTP_ONLY_FORBIDDEN, message: '快照含未授权 HttpOnly Cookie；整次失败', details: { name: cookie.name } };
    }
    entries.push(exportEntryOf(cookie));
  }
  const snapshot = {
    kind: 'dsh-ui-testing-cookie-export',
    version: COOKIE_STORE_VERSION,
    exportedAt: context.exportedAt ?? Date.now(),
    scope: {
      workspaceId: context.authScope?.workspaceId ?? null,
      runtimeId: context.authScope?.runtimeId ?? null,
      tabId: context.authScope?.tabId ?? null,
      origin: context.authScope?.origin ?? null,
    },
    approval: { approvalId: context.approvalId, allowHttpOnly: context.includeHttpOnly === true, oneShot: true },
    counts: { total: entries.length, httpOnly: entries.filter((entry) => entry.httpOnly === true).length },
    cookies: entries,
  };
  const bytes = Buffer.from(JSON.stringify(snapshot, null, 2) + '\n', 'utf8');
  if (bytes.length > COOKIE_MAX_TOTAL_BYTES) {
    return { ok: false, code: COOKIE_ERROR_CODES.QUOTA_EXCEEDED, message: '导出内容超过总大小上限；整次失败，不截断', details: { max: COOKIE_MAX_TOTAL_BYTES, bytes: bytes.length } };
  }
  return { ok: true, snapshot, bytes };
}

/* -----------------------------------------------------------------------------------------------
 * 导入（cookie jar 回填 T1 会话）
 * ---------------------------------------------------------------------------------------------- */

/**
 * 校验导入 payload。只接受本模块导出的快照形态（kind/version 完整匹配）；
 * 每条 Cookie 过同导出相同的上限；HttpOnly 条目需要 importHttpOnly 显式开启。
 *
 * 返回 { ok:true, cookies, counts } 或 { ok:false, code, message, details }。
 */
export function parseCookieImport(data, { importHttpOnly = false, now = Date.now() } = {}) {
  let parsed;
  try {
    parsed = typeof data === 'string' ? JSON.parse(data) : data;
  } catch {
    return { ok: false, code: COOKIE_ERROR_CODES.IMPORT_INVALID, message: '导入内容不是合法 JSON' };
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    return { ok: false, code: COOKIE_ERROR_CODES.IMPORT_INVALID, message: '导入内容必须是快照对象' };
  }
  if (parsed.kind !== 'dsh-ui-testing-cookie-export') {
    return { ok: false, code: COOKIE_ERROR_CODES.IMPORT_INVALID, message: '导入内容 kind 不匹配：只接受本工具导出的快照' };
  }
  if (parsed.version !== COOKIE_STORE_VERSION) {
    return { ok: false, code: COOKIE_ERROR_CODES.IMPORT_INVALID, message: '导入快照版本不匹配', details: { expected: COOKIE_STORE_VERSION, got: parsed.version ?? null } };
  }
  if (!Array.isArray(parsed.cookies)) {
    return { ok: false, code: COOKIE_ERROR_CODES.IMPORT_INVALID, message: '导入快照缺少 cookies 数组' };
  }
  if (parsed.cookies.length > COOKIE_MAX_COUNT) {
    return { ok: false, code: COOKIE_ERROR_CODES.QUOTA_EXCEEDED, message: '导入条数超过上限', details: { max: COOKIE_MAX_COUNT, got: parsed.cookies.length } };
  }
  const cookies = [];
  const httpOnlyNames = [];
  for (const raw of parsed.cookies) {
    const normalized = normalizeCookie(raw);
    if (normalized === null) {
      return { ok: false, code: COOKIE_ERROR_CODES.IMPORT_INVALID, message: '导入条目非法或 value 超长', details: { name: raw && raw.name ? String(raw.name) : null } };
    }
    if (normalized.httpOnly === true) {
      if (importHttpOnly !== true) {
        return { ok: false, code: COOKIE_ERROR_CODES.HTTP_ONLY_FORBIDDEN, message: '导入内容含 HttpOnly Cookie；需要显式 importHttpOnly', details: { name: normalized.name } };
      }
      httpOnlyNames.push(normalized.name);
    }
    cookies.push(normalized);
  }
  return {
    ok: true,
    cookies,
    counts: { total: cookies.length, httpOnly: httpOnlyNames.length },
    scope: typeof parsed.scope === 'object' && parsed.scope !== null ? parsed.scope : null,
    exportedAt: typeof parsed.exportedAt === 'number' ? parsed.exportedAt : null,
  };
}

/**
 * 把规范化 Cookie 数组转成 CDP `Network.setCookie` 参数序列。
 * expires=-1 的会话 Cookie 转换为不带 expires 的设置（浏览器语义由 CDP 侧决定）。
 * 每次设置都是一次独立 CDP 调用；这里只产出参数，调用在 Host 层。
 */
export function cookieSetParams(cookies, { url }) {
  if (!Array.isArray(cookies)) return [];
  const params = [];
  for (const cookie of cookies) {
    const entry = {
      name: cookie.name,
      value: cookie.value,
      url: String(url),
      domain: cookie.domain || undefined,
      path: cookie.path || '/',
      secure: cookie.secure === true,
      httpOnly: cookie.httpOnly === true,
      // CDP reports SameSite in mixed case ('Lax'/'Strict'/'no_restriction'); Network.setCookie
      // accepts 'Strict'/'Lax'/'None'/'no_restriction' case-sensitively per its contract, so the
      // accepted spellings are normalised explicitly and anything else stays undefined (browser
      // default), never a fabricated value.
      sameSite: (() => {
        const raw = String(cookie.sameSite ?? '').toLowerCase();
        if (raw === 'strict') return 'Strict';
        if (raw === 'lax') return 'Lax';
        if (raw === 'none' || raw === 'no_restriction') return 'no_restriction';
        return undefined;
      })(),
    };
    if (Number.isFinite(cookie.expires) && cookie.expires > 0) {
      entry.expires = cookie.expires;
    }
    params.push(entry);
  }
  return params;
}

/* -----------------------------------------------------------------------------------------------
 * 人类授权记录文件（security-approvals.json，GATE-03）
 * ---------------------------------------------------------------------------------------------- */

/** 授权记录文件名；与插件 config 同目录（DSH_UI_TESTING_CONFIG_DIR / ~/.dsh/ui-testing）。 */
export const APPROVALS_FILE = 'security-approvals.json';

/**
 * 读授权记录文件。文件缺失/为空/损坏时返回空列表（fail closed：没有记录 = 没有授权）。
 * 记录形态：{ approvals: [ {approvalId, origin, tabId, workspaceId, runtimeId,
 * allowHttpOnly, issuedAt, expiresAt, revoked?, consumedAt?} ] }
 */
export function readApprovals(dir) {
  if (typeof dir !== 'string' || dir.trim() === '') return [];
  const path = join(dir, APPROVALS_FILE);
  let text;
  try {
    text = readFileSync(path, 'utf8');
  } catch {
    return []; // 缺文件 = 零授权，不是错误
  }
  try {
    const parsed = JSON.parse(text);
    if (Array.isArray(parsed)) return parsed.filter((entry) => entry && typeof entry === 'object');
    if (Array.isArray(parsed.approvals)) return parsed.approvals.filter((entry) => entry && typeof entry === 'object');
    return [];
  } catch {
    return []; // 损坏文件同样 fail closed
  }
}

/**
 * 把一条授权记录标记为已消耗（一次性语义）。原子替换写；文件不存在时创建。
 * 返回 { ok:true, path } 或 { ok:false, code, message }。
 */
export function markApprovalConsumed(dir, approvalId, { consumedAt = Date.now(), mode = 0o600 } = {}) {
  if (typeof dir !== 'string' || dir.trim() === '') {
    return { ok: false, code: COOKIE_ERROR_CODES.OUTPUT_WRITE_FAILED, message: '授权目录未提供' };
  }
  if (typeof approvalId !== 'string' || approvalId.length === 0) {
    return { ok: false, code: COOKIE_ERROR_CODES.APPROVAL_INVALID, message: 'approvalId 不能为空' };
  }
  const path = join(dir, APPROVALS_FILE);
  let approvals = [];
  try {
    const text = readFileSync(path, 'utf8');
    const parsed = JSON.parse(text);
    approvals = Array.isArray(parsed) ? parsed : (Array.isArray(parsed.approvals) ? parsed.approvals : []);
  } catch { /* 缺失或损坏都按空列表重建 */ }
  let changed = false;
  const next = approvals.map((entry) => {
    if (entry && entry.approvalId === approvalId && entry.consumedAt === undefined) {
      changed = true;
      return { ...entry, consumedAt };
    }
    return entry;
  });
  if (!changed) {
    return { ok: false, code: COOKIE_ERROR_CODES.APPROVAL_INVALID, message: '授权记录不存在或已消耗', details: { approvalId } };
  }
  try {
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    const tempPath = join(dir, '.tmp-approvals-' + randomUUID() + '.json');
    const fd = openSync(tempPath, 'wx', mode);
    try {
      writeSync(fd, Buffer.from(JSON.stringify({ approvals: next }, null, 2) + '\n', 'utf8'));
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    // 授权文件允许覆盖（消耗标记是幂等状态迁移，不是导出快照的 no-clobber 场景）。
    renameSync(tempPath, path);
    return { ok: true, path, consumedAt };
  } catch (error) {
    return { ok: false, code: COOKIE_ERROR_CODES.OUTPUT_WRITE_FAILED, message: '授权记录写入失败', details: { code: error && error.code ? String(error.code) : null } };
  }
}

/**
 * 按查询挑选当前有效的授权：origin/workspace/runtime/tab 精确匹配 + 未消耗 + 未撤销 + 未过期。
 * 返回恰好一条 { ok:true, approval } 或 { ok:false, code, reason }；多条同样拒绝（无歧义原则）。
 *
 * 拒绝时保留最有信息量的具体原因：优先 consumed（一次性已用）> expired > revoked > 其他，
 * 让调用方能区分"从没有授权"和"授权已用完"（GATE-03 验收需要这两种都可观测）。
 */
export function findApproval(approvals, query, { now = Date.now() } = {}) {
  if (!Array.isArray(approvals)) return { ok: false, code: COOKIE_ERROR_CODES.APPROVAL_REQUIRED, reason: 'no-records' };
  const matches = [];
  let best = null;
  const rank = { 'COOKIE_APPROVAL_CONSUMED': 3, 'COOKIE_APPROVAL_EXPIRED': 2, 'COOKIE_APPROVAL_INVALID': 1 };
  for (const candidate of approvals) {
    const verdict = validateApproval(candidate, query, { now });
    if (verdict.ok) { matches.push(candidate); continue; }
    const score = rank[verdict.code] ?? 0;
    if (best === null || score > (best.score ?? 0)) best = { ...verdict, score };
  }
  if (matches.length === 0) {
    if (best !== null) return { ok: false, code: best.code, reason: best.reason };
    return { ok: false, code: COOKIE_ERROR_CODES.APPROVAL_REQUIRED, reason: 'no-valid-approval' };
  }
  if (matches.length > 1) {
    return { ok: false, code: COOKIE_ERROR_CODES.APPROVAL_INVALID, reason: 'ambiguous-approvals' };
  }
  return { ok: true, approval: matches[0] };
}

/* -----------------------------------------------------------------------------------------------
 * canary 审计（CRED-08）
 * ---------------------------------------------------------------------------------------------- */

/**
 * canary 扫描：在一个文本/对象里查找已导出 Cookie value 的任何出现。
 * value 与 name 都纳入扫描；命中返回命中位置描述，未命中返回 null。
 * 用于导出后对工具响应/日志的确定性自检——泄漏必须可测量。
 */
export function canaryScan(payload, cookies, { maxHits = 8 } = {}) {
  if (payload === undefined || payload === null || !Array.isArray(cookies) || cookies.length === 0) return null;
  const haystack = typeof payload === 'string' ? payload : JSON.stringify(payload);
  if (typeof haystack !== 'string' || haystack.length === 0) return null;
  const hits = [];
  for (const cookie of cookies) {
    const needle = String(cookie.value ?? '');
    if (needle.length >= 8 && haystack.includes(needle)) {
      hits.push({ kind: 'value', name: cookie.name });
      if (hits.length >= maxHits) return { hits, truncated: true };
    }
    const nameNeedle = String(cookie.name ?? '');
    if (nameNeedle.length >= 8 && haystack.includes(nameNeedle)) {
      hits.push({ kind: 'name', name: cookie.name });
      if (hits.length >= maxHits) return { hits, truncated: true };
    }
  }
  return hits.length === 0 ? null : { hits, truncated: false };
}
