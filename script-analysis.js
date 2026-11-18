/**
 * script-analysis.js — FR-03/FR-04 JavaScript 源码获取与静态分析（JS-01..JS-08）。
 *
 * 纯函数核心，无 CDP 无文件依赖；CDP 调用（Debugger.enable / Debugger.scriptParsed 事件 /
 * Debugger.getScriptSource）由 Host 层组合。
 *
 * 契约要点：
 *  - Script Inventory：每个脚本带 scriptId/url/来源分类(inline/external/dynamic/worker)、
 *    是否 Source Map、字节数与 sha256（内容指纹，不回显内容）；
 *  - 格式化：把压缩代码展开为可读形式，**明确标注"格式化结果不是原始源码"**（FR-03 硬性要求）；
 *  - 字符串表识别：Base64/Hex/Unicode 编码常量、数组索引表（`_0x5a[i]` 形态）、数组旋转特征；
 *  - 还原：只对**可确定解码**的内容给出结果（base64/hex/unicode-escape），无法确定的标注 unknown，
 *    绝不伪造还原结果；
 *  - Source-to-Sink：常见 DOM XSS 数据流模式（location/document.cookie/input → innerHTML/eval/
 *    document.write/setAttribute），输出 source/sink 位置与证据，不做"已可利用"的断言；
 *  - 置信度：每个还原/发现都带 confidence 与 method，验收时可复核。
 */

export const SCRIPT_ANALYSIS_VERSION = 1;

/** 脚本来源分类。 */
export const SCRIPT_SOURCES = Object.freeze(['inline', 'external', 'dynamic', 'worker', 'eval']);

/** 分析上限（软预算）。 */
export const SCRIPT_LIMITS = Object.freeze({
  maxScripts: 500,
  maxSourceBytes: 4 * 1024 * 1024,
  maxInlineScripts: 100,
  maxStrings: 256,
  maxSinks: 128,
  maxSourceMapCandidates: 8,
});

/* -----------------------------------------------------------------------------------------------
 * Script Inventory（JS-01）
 * ---------------------------------------------------------------------------------------------- */

/**
 * 从一条 CDP `Debugger.scriptParsed` 参数规范化脚本清单项。
 * `params` 是 CDP 原始参数；不读源码内容（只有元数据 + 可选 hash 计算输入）。
 */
export function normalizeScriptDescriptor(params) {
  if (typeof params !== 'object' || params === null) return null;
  const scriptId = typeof params.scriptId === 'string' ? params.scriptId : null;
  if (scriptId === null) return null;
  const url = typeof params.url === 'string' ? params.url : '';
  return {
    scriptId,
    url,
    source: classifyScriptSource(params),
    startLine: Number.isInteger(params.startLine) ? params.startLine : 0,
    endLine: Number.isInteger(params.endLine) ? params.endLine : 0,
    length: Number.isInteger(params.length) ? params.length : 0,
    hash: typeof params.hash === 'string' ? params.hash : null,
    executionContextId: Number.isInteger(params.executionContextId) ? params.executionContextId : null,
    // sourceMapURL is the CDP field; presence is an OBSERVATION, reachability is separate (JS-03).
    sourceMapUrl: typeof params.sourceMapURL === 'string' && params.sourceMapURL !== '' ? params.sourceMapURL : null,
    isModule: params.isModule === true,
  };
}

/** 脚本来源分类：inline（无 url）、external（http(s)）、worker、dynamic（blob/data）、eval。 */
export function classifyScriptSource(params) {
  const url = typeof params.url === 'string' ? params.url : '';
  if (url === '') return 'inline';
  if (url.startsWith('blob:')) return 'dynamic';
  if (url.startsWith('data:')) return 'dynamic';
  if (url.startsWith('wasm:')) return 'dynamic';
  if (url.startsWith('http://') || url.startsWith('https://')) return 'external';
  const type = String(params?.auxData?.type ?? '');
  if (type === 'worker' || type === 'service-worker' || type === 'shared-worker') return 'worker';
  return 'external';
}

/**
 * 建立 Inventory（JS-01 覆盖率）：输入描述符数组，输出去重并按来源/URL 汇总的清单。
 * 同一 URL 的多次 scriptParsed（reload）合并为一条，记录 occurrences。
 */
export function buildScriptInventory(descriptors) {
  const list = (Array.isArray(descriptors) ? descriptors : []).filter(Boolean);
  const byKey = new Map();
  let truncated = false;
  for (const descriptor of list) {
    const key = descriptor.url === '' ? descriptor.scriptId : descriptor.url;
    const existing = byKey.get(key);
    if (existing) {
      existing.occurrences += 1;
      existing.scriptIds.push(descriptor.scriptId);
      if (descriptor.length > existing.length) existing.length = descriptor.length;
      if (descriptor.sourceMapUrl && !existing.sourceMapUrl) existing.sourceMapUrl = descriptor.sourceMapUrl;
      continue;
    }
    if (byKey.size >= SCRIPT_LIMITS.maxScripts) { truncated = true; break; }
    byKey.set(key, {
      key,
      scriptIds: [descriptor.scriptId],
      url: descriptor.url,
      source: descriptor.source,
      length: descriptor.length,
      startLine: descriptor.startLine,
      endLine: descriptor.endLine,
      sourceMapUrl: descriptor.sourceMapUrl,
      isModule: descriptor.isModule,
      occurrences: 1,
      evidence: 'observed',
    });
  }
  const scripts = [...byKey.values()];
  const bySource = {};
  for (const script of scripts) bySource[script.source] = (bySource[script.source] ?? 0) + 1;
  return {
    kind: 'dsh-ui-testing-script-inventory',
    version: SCRIPT_ANALYSIS_VERSION,
    generatedAt: Date.now(),
    counts: {
      scripts: scripts.length,
      withSourceMap: scripts.filter((s) => s.sourceMapUrl !== null).length,
      bySource,
      truncated,
    },
    scripts,
  };
}

/* -----------------------------------------------------------------------------------------------
 * Source Map 检查（JS-03）
 * ---------------------------------------------------------------------------------------------- */

/**
 * Source Map 三态（存在/不存在/不可访问）。`present` 来自 scriptParsed 的 sourceMapURL；
 * `accessible` 由 Host 层实际取回结果决定（null = 未探测，绝不假设可用）。
 */
export function scriptMapStatus(script, { fetched = null } = {}) {
  if (script?.sourceMapUrl === null || script?.sourceMapUrl === undefined) {
    return { status: 'absent', reason: 'no-sourceMappingURL' };
  }
  if (fetched === null) {
    return { status: 'present-unverified', sourceMapUrl: script.sourceMapUrl };
  }
  if (fetched.ok === true) {
    return { status: 'accessible', sourceMapUrl: script.sourceMapUrl, bytes: fetched.bytes ?? null };
  }
  return { status: 'inaccessible', sourceMapUrl: script.sourceMapUrl, reason: fetched.reason ?? 'fetch-failed' };
}

/* -----------------------------------------------------------------------------------------------
 * 格式化（JS-02）：保留原始位置映射
 * ---------------------------------------------------------------------------------------------- */

/**
 * 轻量格式化：在 `;{}` 后插入换行并缩进，返回 { text, lineMap }。
 * `lineMap[formattedLine] = { originalLine, originalColumn }` —— 由于只插入空白，不移动任何
 * 原始字符，位置映射是精确的（这是"保留原始位置映射"的实现基础）。
 *
 * 明确契约：格式化结果不是原始源码。调用方必须原样透出 `isOriginalSource:false`。
 */
export function formatScript(source, { indent = '  ' } = {}) {
  if (typeof source !== 'string' || source === '') {
    return { ok: false, reason: 'empty-source' };
  }
  if (source.length > SCRIPT_LIMITS.maxSourceBytes) {
    return { ok: false, reason: 'source-too-large', bytes: source.length };
  }
  const out = [];
  const lineMap = [];
  let depth = 0;
  let current = '';
  let originalLine = 0;
  let originalColumn = 0;
  let currentLineStart = 0;
  let currentOriginal = { line: 0, column: 0 };
  const flush = () => {
    if (current.trim() === '') { current = ''; return; }
    out.push(indent.repeat(Math.max(0, depth)) + current.trim());
    lineMap.push({ ...currentOriginal });
    current = '';
  };
  for (let i = 0; i < source.length; i += 1) {
    const ch = source[i];
    if (ch === '\n') {
      flush();
      originalLine += 1;
      originalColumn = 0;
      continue;
    }
    if (current === '') {
      currentOriginal = { line: originalLine, column: originalColumn };
    }
    current += ch;
    originalColumn += 1;
    if (ch === '{') {
      // Keep a block opener on the current line, then break.
      flush();
      depth += 1;
    } else if (ch === '}') {
      flush();
      depth = Math.max(0, depth - 1);
    } else if (ch === ';') {
      flush();
    }
  }
  flush();
  return {
    ok: true,
    text: out.join('\n'),
    lineMap,
    isOriginalSource: false,
    note: '格式化结果不是原始源码；lineMap 给出每行对应的原始行列位置。',
  };
}

/**
 * 拆分"嵌套引号列表"：`"a","b","c"` → ['a','b','c']；不匹配该确定形态返回 null（不猜）。
 * 用于识别把整个字符串表塞进单个字符串字面量的混淆变体。
 */
export function splitNestedQuotedList(value) {
  const raw = String(value ?? '');
  if (!/^"([^"\\]|\\.)*"(\s*,\s*"([^"\\]|\\.)*")+$/.test(raw)) return null;
  const parts = [];
  const literal = /"((?:[^"\\]|\\.)*)"/g;
  let match;
  while ((match = literal.exec(raw)) !== null) {
    parts.push(unescapeJsString(match[1]));
    if (parts.length >= SCRIPT_LIMITS.maxStrings) break;
  }
  return parts.length > 1 ? parts : null;
}

/* -----------------------------------------------------------------------------------------------
 * 字符串表识别与还原（JS-04）
 * ---------------------------------------------------------------------------------------------- */

/** 十六进制解码（可确定）。 */
export function decodeHex(text) {
  const match = /^(?:0x)?([0-9a-fA-F]+)$/.exec(String(text ?? ''));
  if (match === null || match[1].length % 2 !== 0) return null;
  try {
    return Buffer.from(match[1], 'hex').toString('utf8');
  } catch { return null; }
}

/** Base64 解码（可确定）；非法 base64 返回 null。 */
export function decodeBase64(text) {
  const raw = String(text ?? '');
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(raw) || raw.length % 4 !== 0) return null;
  try {
    const decoded = Buffer.from(raw, 'base64').toString('utf8');
    // Reject binary garbage: a decoded string must be mostly printable (JS string table payloads are).
    const printable = [...decoded].filter((ch) => ch >= ' ' || ch === '\n' || ch === '\t').length;
    if (decoded.length === 0 || printable / decoded.length < 0.9) return null;
    return decoded;
  } catch { return null; }
}

/** Unicode 转义解码（\u0041 / \x41）。 */
export function decodeUnicodeEscapes(text) {
  const raw = String(text ?? '');
  if (!/\\u[0-9a-fA-F]{4}|\\x[0-9a-fA-F]{2}/.test(raw)) return null;
  try {
    const decoded = raw
      .replace(/\\u([0-9a-fA-F]{4})/g, (_, hex) => String.fromCharCode(parseInt(hex, 16)))
      .replace(/\\x([0-9a-fA-F]{2})/g, (_, hex) => String.fromCharCode(parseInt(hex, 16)));
    return decoded === raw ? null : decoded;
  } catch { return null; }
}

/**
 * 从源码中提取字符串字面量表（JS-04 的"字符串数组/索引映射"）。
 * 识别 `const _0x5a=['a','b']` 与 `const x = ["a","b"]` 形态；返回数组与解码结果。
 */
export function extractStringTables(source) {
  if (typeof source !== 'string' || source === '') return [];
  const tables = [];
  // A const/var/let binding assigned to a single-line array literal of string literals.
  const pattern = /(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*\[((?:\s*(['"])(?:\\.|(?!\3).)*\3\s*,?)+)\s*\]/g;
  let match;
  while ((match = pattern.exec(source)) !== null && tables.length < SCRIPT_LIMITS.maxStrings) {
    const name = match[1];
    const body = match[2];
    const values = [];
    const literal = /(['"])((?:\\.|(?!\1).)*)\1/g;
    let item;
    while ((item = literal.exec(body)) !== null) {
      values.push(unescapeJsString(item[2]));
      if (values.length >= SCRIPT_LIMITS.maxStrings) break;
    }
    if (values.length === 0) continue;
    // Obfuscation variant: the whole table is ONE string literal that itself contains a
    // comma-separated list of quoted strings (`['"a","b","c"']`). Splitting is deterministic
    // (only an exact '"x","y"' shape is re-split); split entries keep their own decode status.
    const expanded = [];
    for (const value of values) {
      const parts = splitNestedQuotedList(value);
      if (parts === null) expanded.push(value);
      else expanded.push(...parts);
    }
    values.length = 0;
    values.push(...expanded.slice(0, SCRIPT_LIMITS.maxStrings));
    const decoded = values.map((value, index) => decodeStringCandidate(value, { index }));
    tables.push({
      name,
      index: match.index,
      count: values.length,
      values,
      decoded,
      evidence: 'observed',
    });
  }
  return tables;
}

function unescapeJsString(value) {
  return String(value)
    .replace(/\\'/g, "'")
    .replace(/\\"/g, '"')
    .replace(/\\\\/g, '\\')
    .replace(/\\n/g, '\n')
    .replace(/\\t/g, '\t');
}

/**
 * 单条字符串的还原尝试：按 hex → base64 → unicode-escape 顺序，返回 { value, method, confidence }
 * 或 { value: null, method: null, confidence: null }（unknown，绝不伪造）。
 */
export function decodeStringCandidate(value, { index = null } = {}) {
  const raw = String(value ?? '');
  if (raw === '') return { index, value: null, method: null, confidence: null, status: 'unknown' };
  const hex = decodeHex(raw);
  if (hex !== null && hex !== raw) return { index, value: hex, method: 'hex', confidence: 'high', status: 'decoded' };
  const b64 = decodeBase64(raw);
  if (b64 !== null) return { index, value: b64, method: 'base64', confidence: 'high', status: 'decoded' };
  const uni = decodeUnicodeEscapes(raw);
  if (uni !== null) return { index, value: uni, method: 'unicode-escape', confidence: 'high', status: 'decoded' };
  // A plain readable string is NOT a decode result: report it as already-plain, not "restored".
  if (/^[\x20-\x7e]+$/.test(raw)) {
    return { index, value: raw, method: null, confidence: null, status: 'plain' };
  }
  return { index, value: null, method: null, confidence: null, status: 'unknown' };
}

/**
 * 检测"数组旋转"特征（JS-04 常见混淆）：源码里对字符串表调用 shift/push 的 IIFE。
 * 只报告模式命中，不执行旋转（执行页面代码不是静态分析的职责）。
 */
export function detectArrayRotation(source) {
  if (typeof source !== 'string') return { detected: false };
  const shiftPush = /while\s*\(\s*true\s*\)\s*\{[^}]{0,400}\.push\s*\(\s*[A-Za-z_$][\w$]*\.shift\s*\(\s*\)/.test(source);
  const rotateFn = /function\s+([A-Za-z_$][\w$]*)\s*\(\s*\)\s*\{[^}]{0,200}shift\s*\(\s*\)[^}]{0,200}push\s*\(/.test(source);
  const indexOffset = /\bparseInt\s*\(\s*[A-Za-z_$][\w$]*\s*\)\s*-\s*0x[0-9a-f]+/i.test(source);
  return {
    detected: shiftPush || rotateFn || indexOffset,
    patterns: {
      shiftPushLoop: shiftPush,
      rotateFunction: rotateFn,
      indexOffsetArithmetic: indexOffset,
    },
    evidence: 'static-pattern',
    note: '只报告静态模式；实际旋转需动态执行验证（不属于静态分析）。',
  };
}

/* -----------------------------------------------------------------------------------------------
 * Source-to-Sink（JS-07）
 * ---------------------------------------------------------------------------------------------- */

/** 常见 DOM XSS source（数据来源）。 */
export const DOM_SOURCES = Object.freeze([
  { id: 'location', pattern: /\blocation\.(?:href|search|hash|pathname)\b/ },
  { id: 'document-cookie', pattern: /\bdocument\.cookie\b/ },
  { id: 'local-storage', pattern: /\blocalStorage\.(?:getItem|setItem)\b/ },
  { id: 'post-message', pattern: /\baddEventListener\s*\(\s*['"]message['"]/ },
  { id: 'url-params', pattern: /\bURLSearchParams\b/ },
  { id: 'user-input', pattern: /\b(?:value|textContent)\s*=/ },
]);

/** 常见 DOM XSS sink（危险接收点）。 */
export const DOM_SINKS = Object.freeze([
  { id: 'innerHTML', pattern: /\.innerHTML\s*=/ },
  { id: 'outerHTML', pattern: /\.outerHTML\s*=/ },
  { id: 'document-write', pattern: /document\.write(?:ln)?\s*\(/ },
  { id: 'eval', pattern: /\beval\s*\(/ },
  { id: 'function-ctor', pattern: /new\s+Function\s*\(/ },
  { id: 'set-timeout-string', pattern: /setTimeout\s*\(\s*['"]/ },
  { id: 'insertAdjacentHTML', pattern: /insertAdjacentHTML\s*\(/ },
  { id: 'setAttribute-onclick', pattern: /setAttribute\s*\(\s*['"](?:on\w+|href|src)['"]/i },
]);

/**
 * Source-to-Sink 静态定位：返回每个 sink 的行号/列号、同行或邻近出现的 source 候选、置信度。
 * 置信度规则（保守）：
 *  - `line-local`：source 与 sink 在同一行 → high；
 *  - `nearby`：source 在 sink 之前 40 行内 → medium；
 *  - `sink-only`：只找到 sink（无 source 线索）→ low（不声称可利用）。
 */
export function findSourceToSink(source) {
  if (typeof source !== 'string' || source === '') return { findings: [], truncated: false };
  const lines = source.split('\n');
  const sourceHits = [];
  for (let index = 0; index < lines.length; index += 1) {
    for (const candidate of DOM_SOURCES) {
      if (candidate.pattern.test(lines[index])) sourceHits.push({ id: candidate.id, line: index, column: lines[index].search(candidate.pattern) });
    }
  }
  const findings = [];
  let truncated = false;
  for (let index = 0; index < lines.length; index += 1) {
    for (const sink of DOM_SINKS) {
      if (!sink.pattern.test(lines[index])) continue;
      if (findings.length >= SCRIPT_LIMITS.maxSinks) { truncated = true; break; }
      const column = lines[index].search(sink.pattern);
      const sameLine = sourceHits.find((hit) => hit.line === index);
      const nearby = sourceHits.filter((hit) => hit.line < index && index - hit.line <= 40).pop();
      const sourceHit = sameLine ?? nearby ?? null;
      const confidence = sameLine ? 'high' : (nearby ? 'medium' : 'low');
      findings.push({
        sink: sink.id,
        line: index,
        column,
        source: sourceHit === null ? null : sourceHit.id,
        sourceLine: sourceHit === null ? null : sourceHit.line,
        confidence,
        evidence: 'static-pattern',
        note: confidence === 'low'
          ? '只定位到 sink；未找到静态数据来源，不能据此声称可注入。'
          : '静态模式命中；实际可利用性需动态验证。',
      });
    }
    if (findings.length >= SCRIPT_LIMITS.maxSinks) { truncated = true; break; }
  }
  return { findings, truncated };
}

/* -----------------------------------------------------------------------------------------------
 * 反混淆综合结论（JS-08：静态与运行时一致率）
 * ---------------------------------------------------------------------------------------------- */

/**
 * 汇总一个脚本的静态分析结论。`runtime` 参数用于 JS-08 的一致性对照：
 * 传入运行时观测到的字符串/参数则逐项比对，输出 consistent/divergent/unknown 计数。
 */
export function analyzeScript({ descriptor = null, source = '', runtime = null } = {}) {
  const tables = extractStringTables(source);
  const rotation = detectArrayRotation(source);
  const sinks = findSourceToSink(source);
  const decodedCount = tables.reduce((sum, table) => sum + table.decoded.filter((d) => d.status === 'decoded').length, 0);
  const unknownCount = tables.reduce((sum, table) => sum + table.decoded.filter((d) => d.status === 'unknown').length, 0);
  const report = {
    kind: 'dsh-ui-testing-script-analysis',
    version: SCRIPT_ANALYSIS_VERSION,
    script: descriptor,
    stringTables: tables,
    rotation,
    sourceToSink: sinks,
    counts: {
      stringTables: tables.length,
      decoded: decodedCount,
      unknown: unknownCount,
      sinks: sinks.findings.length,
      highConfidenceSinks: sinks.findings.filter((finding) => finding.confidence === 'high').length,
    },
    limitations: [
      '静态分析不执行页面代码；数组旋转与动态索引只在动态调试中确认。',
      unknownCount > 0 ? `有 ${unknownCount} 条字符串无法静态还原，已标注 unknown（未伪造）。` : null,
    ].filter(Boolean),
  };
  if (runtime !== null && typeof runtime === 'object') {
    const comparisons = [];
    for (const key of Object.keys(runtime)) {
      const expected = runtime[key];
      const found = findDecodedValue(tables, expected);
      comparisons.push({ key, runtimeValue: expected, staticValue: found, consistent: found === String(expected) });
    }
    report.consistency = {
      comparisons,
      consistent: comparisons.filter((entry) => entry.consistent).length,
      total: comparisons.length,
      rate: comparisons.length === 0 ? null : comparisons.filter((entry) => entry.consistent).length / comparisons.length,
    };
  }
  return report;
}

function findDecodedValue(tables, value) {
  const needle = String(value);
  for (const table of tables) {
    for (const entry of table.decoded) {
      if (entry.value === needle) return entry.value;
    }
    for (const raw of table.values) {
      if (raw === needle) return raw;
    }
  }
  return null;
}
