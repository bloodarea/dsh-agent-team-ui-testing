import { createHash } from 'node:crypto';

export class SpecError extends Error {
  constructor(code, message, details = {}) {
    super(message); this.name = 'SpecError'; this.code = code;
    this.details = details; this.effectState = 'none';
  }
}
export const fail = (code, message, details) => { throw new SpecError(code, message, details); };
export const escapePointer = value => String(value).replace(/~/g, '~0').replace(/\//g, '~1');
export function pointerTokens(pointer) {
  if (typeof pointer !== 'string' || !pointer.startsWith('/') || /~(?:[^01]|$)/u.test(pointer))
    fail('INVALID_POINTER', 'Expected a non-root RFC 6901 JSON Pointer.', { instancePath: pointer });
  return pointer.slice(1).split('/').map(x => x.replace(/~1/g, '/').replace(/~0/g, '~'));
}
export function getPointer(value, pointer) {
  return pointerTokens(pointer).reduce((node, key) => node && Object.hasOwn(node, key) ? node[key] : undefined, value);
}
export function setPointer(value, pointer, replacement) {
  const keys = pointerTokens(pointer); const key = keys.pop();
  const parent = keys.reduce((node, k) => node && Object.hasOwn(node, k) ? node[k] : undefined, value);
  if (!parent || Array.isArray(parent) || typeof parent !== 'object' || ['__proto__', 'constructor', 'prototype'].includes(key))
    fail('INVALID_POINTER', 'The slot parent must already exist.', { instancePath: pointer });
  Object.defineProperty(parent, key, { value: replacement, enumerable: true, writable: true, configurable: true });
}
export const JSON_LIMITS = Object.freeze({ maxBytes: 8 * 1024 * 1024, maxDepth: 64, maxNodes: 200000, maxStringLength: 1024 * 1024 });

// Parse before JSON.parse could discard duplicate members. Bounds are checked before recursion.
export function parseStrictJson(text, limits = {}) {
  const cap = { ...JSON_LIMITS, ...limits };
  if (typeof text !== 'string') fail('INVALID_JSON', 'JSON input must be text.');
  if (Buffer.byteLength(text, 'utf8') > cap.maxBytes) fail('RESOURCE_LIMIT', 'JSON byte limit exceeded.');
  let i = 0; let nodes = 0;
  const error = (code, message, path) => fail(code, message, { instancePath: path, offset: i });
  const ws = () => { while (/[\x20\t\r\n]/.test(text[i] || '\0')) i++; };
  function string(path) {
    const start = i++;
    while (i < text.length) {
      const c = text.charCodeAt(i++);
      if (c === 34) {
        let value; try { value = JSON.parse(text.slice(start, i)); } catch { error('INVALID_JSON', 'Invalid JSON string.', path); }
        if (value.length > cap.maxStringLength) error('RESOURCE_LIMIT', 'String limit exceeded.', path);
        if (/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/u.test(value))
          error('INVALID_UNICODE', 'Lone UTF-16 surrogate is not valid JCS input.', path);
        return value;
      }
      if (c < 32) error('INVALID_JSON', 'Unescaped control character.', path);
      if (c === 92) { if (text[i] === 'u') i += 5; else i++; }
      if (i - start > cap.maxStringLength * 6 + 2) error('RESOURCE_LIMIT', 'String limit exceeded.', path);
    }
    error('INVALID_JSON', 'Unterminated string.', path);
  }
  function value(path, depth) {
    if (depth > cap.maxDepth || ++nodes > cap.maxNodes) error('RESOURCE_LIMIT', 'JSON nesting/node limit exceeded.', path);
    ws(); const c = text[i];
    if (c === '"') return string(path);
    if (c === '{') {
      i++; ws(); const result = {}; const keys = new Set();
      if (text[i] === '}') { i++; return result; }
      while (i < text.length) {
        ws(); if (text[i] !== '"') error('INVALID_JSON', 'Expected object member name.', path);
        const key = string(path); const next = `${path}/${escapePointer(key)}`;
        if (keys.has(key)) error('DUPLICATE_KEY', 'Duplicate JSON object member.', next);
        keys.add(key); ws(); if (text[i++] !== ':') error('INVALID_JSON', 'Expected colon.', next);
        Object.defineProperty(result, key, { value: value(next, depth + 1), enumerable: true, writable: true, configurable: true });
        ws(); const delim = text[i++]; if (delim === '}') return result;
        if (delim !== ',') error('INVALID_JSON', 'Expected comma or closing brace.', path);
      }
      error('INVALID_JSON', 'Unterminated object.', path);
    }
    if (c === '[') {
      i++; ws(); const result = []; if (text[i] === ']') { i++; return result; }
      while (i < text.length) {
        result.push(value(`${path}/${result.length}`, depth + 1)); ws(); const delim = text[i++];
        if (delim === ']') return result;
        if (delim !== ',') error('INVALID_JSON', 'Expected comma or closing bracket.', path);
      }
      error('INVALID_JSON', 'Unterminated array.', path);
    }
    for (const [literal, result] of [['true', true], ['false', false], ['null', null]]) {
      if (text.startsWith(literal, i)) { i += literal.length; return result; }
    }
    const match = /^-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?/.exec(text.slice(i));
    if (!match) error('INVALID_JSON', 'Expected JSON value.', path);
    i += match[0].length; const result = Number(match[0]);
    if (!Number.isFinite(result)) error('NON_FINITE_NUMBER', 'Non-finite number is forbidden.', path);
    return result;
  }
  const result = value('', 0); ws(); if (i !== text.length) error('INVALID_JSON', 'Trailing JSON input.', '');
  return result;
}

// Accept JSON data only: no accessors, prototypes, sparse arrays, cycles or implicit coercion.
export function assertJsonData(value, limits = {}) {
  const cap = { ...JSON_LIMITS, ...limits }; const ancestors = new Set(); let nodes = 0; let bytes = 0;
  const account = (length, path) => { bytes += length; if (bytes > cap.maxBytes) fail('RESOURCE_LIMIT', 'JSON byte limit exceeded.', { instancePath: path }); };
  function visit(node, path, depth) {
    if (depth > cap.maxDepth || ++nodes > cap.maxNodes) fail('RESOURCE_LIMIT', 'JSON nesting/node limit exceeded.', { instancePath: path });
    if (typeof node === 'number') { if (!Number.isFinite(node)) fail('NON_FINITE_NUMBER', 'Non-finite number.', { instancePath: path }); account(JSON.stringify(node).length, path); return; }
    if (typeof node === 'string') {
      if (node.length > cap.maxStringLength) fail('RESOURCE_LIMIT', 'String limit exceeded.', { instancePath: path });
      if (/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/u.test(node)) fail('INVALID_UNICODE', 'Lone UTF-16 surrogate.', { instancePath: path });
      account(Buffer.byteLength(JSON.stringify(node), 'utf8'), path); return;
    }
    if (node === null || typeof node === 'boolean') { account(node === null ? 4 : node ? 4 : 5, path); return; }
    if (!node || typeof node !== 'object' || ancestors.has(node)) fail('INVALID_JSON', 'Expected acyclic JSON data.', { instancePath: path });
    const array = Array.isArray(node);
    if (!array && ![Object.prototype, null].includes(Object.getPrototypeOf(node))) fail('INVALID_JSON', 'Only plain JSON records are accepted.', { instancePath: path });
    ancestors.add(node);
    const descriptors = Object.getOwnPropertyDescriptors(node);
    account(2 + Math.max(0, Object.keys(node).length - 1) + (array ? 0 : Object.keys(node).length), path);
    if (Object.getOwnPropertySymbols(node).length) fail('INVALID_JSON', 'Symbol members are forbidden.', { instancePath: path });
    if (array && Object.keys(node).length !== node.length) fail('INVALID_JSON', 'Sparse or extended arrays are forbidden.', { instancePath: path });
    for (const [key, d] of Object.entries(descriptors)) {
      if (array && key === 'length') continue;
      if (!d.enumerable || !Object.hasOwn(d, 'value')) fail('INVALID_JSON', 'Accessors/non-enumerable data are forbidden.', { instancePath: path });
      if (!array) visit(key, path, depth + 1); visit(d.value, `${path}/${escapePointer(key)}`, depth + 1);
    }
    ancestors.delete(node);
  }
  visit(value, '', 0); return value;
}
export function canonicalize(value) {
  assertJsonData(value);
  function encode(node) {
    if (node === null || typeof node !== 'object') return JSON.stringify(node);
    if (Array.isArray(node)) return `[${node.map(encode).join(',')}]`;
    return `{${Object.keys(node).sort().map(key => `${JSON.stringify(key)}:${encode(node[key])}`).join(',')}}`;
  }
  const text = encode(value);
  if (Buffer.byteLength(text, 'utf8') > JSON_LIMITS.maxBytes) fail('RESOURCE_LIMIT', 'Canonical JSON byte limit exceeded.');
  return text;
}
export const sha256 = value => createHash('sha256').update(value).digest('hex');
export const hashJson = value => sha256(canonicalize(value));
export const cloneJson = value => parseStrictJson(canonicalize(value));
