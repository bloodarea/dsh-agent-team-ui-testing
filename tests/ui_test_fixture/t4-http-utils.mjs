/**
 * Shared HTTP helpers for the WEB-T4 preparation fixtures (`tests/ui_test_fixture/t4-*-route.mjs`).
 *
 * These fixtures are deliberately zero-dependency, loopback-only, deterministic local targets for
 * the T4 preparation acceptance suites (see tests/ui_test_fixture/t4-visual.md /
 * t4-network.md). They are NOT part of the plugin runtime and are never loaded by index.js.
 *
 * Ownership: this file is integration scaffolding owned by the Lead. Feature owners import it
 * read-only and must not edit it (raise a coordination message instead).
 */
import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import { extname, resolve, sep } from 'node:path';

const MIME = Object.freeze({
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
  '.webm': 'video/webm',
  '.mp4': 'video/mp4',
  '.ico': 'image/x-icon',
});

/** JSON response with the fixture's fixed provenance headers. */
export function json(res, status, value, extraHeaders = {}) {
  const body = JSON.stringify(value);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(body),
    'cache-control': 'no-store',
    'x-fixture': 'dsh-ui-testing',
    ...extraHeaders,
  });
  res.end(body);
}

/** 404 in the fixture's JSON error shape. */
export function notFound(res, message = 'not-found') {
  json(res, 404, { error: message, status: 404 });
}

/** 405 with an explicit Allow list (never silently accepts another method). */
export function methodNotAllowed(res, allowed) {
  json(res, 405, { error: 'method-not-allowed', status: 405, allowed }, { allow: allowed.join(', ') });
}

/** Read a request body as UTF-8 text with a hard byte cap. */
export function readBody(req, limit = 64 * 1024) {
  return new Promise((resolveBody, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > limit) {
        const error = new Error(`fixture request body exceeds ${limit} bytes`);
        error.statusCode = 413;
        reject(error);
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolveBody(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

/** Read + parse a JSON request body. Returns `{ok:true,value}` or `{ok:false,status,error}`. */
export async function readJsonBody(req, limit = 64 * 1024) {
  let raw;
  try {
    raw = await readBody(req, limit);
  } catch (error) {
    return { ok: false, status: 413, error: 'body-too-large' };
  }
  if (!raw.trim()) return { ok: true, value: {} };
  try {
    return { ok: true, value: JSON.parse(raw) };
  } catch {
    return { ok: false, status: 400, error: 'invalid-json' };
  }
}

/** Resolve `relativePath` below `root`; throws on traversal/absolute escape. */
export function safeJoin(root, relativePath) {
  const base = resolve(root);
  const full = resolve(base, relativePath);
  if (full !== base && !full.startsWith(base + sep)) throw new Error(`path escapes fixture root: ${relativePath}`);
  return full;
}

/**
 * Stream a fixture file (HTML/JS/WebM/PNG...). `root` defaults to this module's directory.
 * The response is always `no-store`; a missing/non-regular file yields 404 (never a stack trace).
 */
export async function sendFile(res, relativePath, { root, contentType, headers = {} } = {}) {
  const rootDirectory = root || new URL('.', import.meta.url).pathname;
  let full;
  try {
    full = safeJoin(rootDirectory, relativePath);
  } catch {
    notFound(res);
    return false;
  }
  let info;
  try {
    info = await stat(full);
  } catch {
    notFound(res);
    return false;
  }
  if (!info.isFile()) {
    notFound(res);
    return false;
  }
  res.writeHead(200, {
    'content-type': contentType || MIME[extname(full).toLowerCase()] || 'application/octet-stream',
    'content-length': info.size,
    'cache-control': 'no-store',
    'x-fixture': 'dsh-ui-testing',
    ...headers,
  });
  createReadStream(full).pipe(res);
  return true;
}

/** Parse `?a=1&b=2` into a plain object (repeated key becomes an array, URL order preserved). */
export function queryObject(searchParams) {
  const out = {};
  for (const [key, value] of searchParams) {
    if (!Object.prototype.hasOwnProperty.call(out, key)) out[key] = value;
    else if (Array.isArray(out[key])) out[key].push(value);
    else out[key] = [out[key], value];
  }
  return out;
}

/** Integer clamp with a default for missing/invalid input. */
export function clampInt(raw, fallback, min, max) {
  const value = Number(raw);
  if (raw === null || raw === undefined || raw === '' || !Number.isFinite(value)) return fallback;
  return Math.min(Math.max(Math.round(value), min), max);
}
