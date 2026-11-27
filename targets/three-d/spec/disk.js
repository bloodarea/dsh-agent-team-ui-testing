import * as fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { canonicalize, fail, parseStrictJson, sha256 } from './json.js';

export const scopeKey = id => sha256(String(id));
export function requireScope({ workspaceId, actor }) {
  if (typeof workspaceId !== 'string' || !workspaceId || workspaceId.length > 1024 || typeof actor !== 'string' || !actor || actor.length > 1024)
    fail('PERMISSION_DENIED', 'Host workspace and actual actor are required.');
}
export async function authorizeRequest(authorize, action, request, write = false) {
  requireScope(request);
  if (write && (typeof request.grantId !== 'string' || !request.grantId)) fail('PERMISSION_DENIED', 'Host write grant is required.');
  if (typeof authorize !== 'function' || await authorize({ ...request, action }) !== true) fail('PERMISSION_DENIED', `Access denied: ${action}.`);
}
export async function safeDirectory(root, ...segments) {
  // The environment-provided root and its ancestors may be links; resolve them first.
  await fs.mkdir(path.resolve(root), { recursive: true });
  let current = await fs.realpath(root);
  // Only application-controlled components below the real root must be real directories.
  for (const component of segments) {
    if (!component || component === '..' || component === '.' || component.includes('/') || component.includes('\\')) fail('UNSAFE_PATH', 'Invalid storage path component.');
    current = path.join(current, component);
    await fs.mkdir(current).catch(error => { if (error.code !== 'EEXIST') throw error; });
    const stat = await fs.lstat(current);
    if (stat.isSymbolicLink() || !stat.isDirectory()) fail('UNSAFE_PATH', 'Artifact/spec storage must use real directories.');
  }
  return current;
}
export async function readRegular(file, { maxBytes = 64 * 1024 * 1024 } = {}) {
  const stat = await fs.lstat(file);
  if (!stat.isFile() || stat.isSymbolicLink()) fail('UNSAFE_PATH', 'Expected a regular storage file.');
  if (stat.size > maxBytes) fail('RESOURCE_LIMIT', 'Stored file exceeds size limit.');
  return fs.readFile(file);
}
export async function readJson(file) { return parseStrictJson((await readRegular(file, { maxBytes: 8 * 1024 * 1024 })).toString('utf8')); }
export async function syncDirectory(directory) {
  let handle;
  try { handle = await fs.open(directory, 'r'); await handle.sync(); }
  catch (error) { if (!['EINVAL', 'EPERM', 'EISDIR', 'EACCES', 'ENOTSUP'].includes(error.code) || process.platform !== 'win32') throw error; }
  finally { await handle?.close(); }
}
/** Atomic no-overwrite publication. A complete fsynced file becomes visible with one hard link. */
export async function publishImmutable(directory, filename, bytes, { beforePublish } = {}) {
  const temporary = path.join(directory, `.pending-${randomUUID()}`); const destination = path.join(directory, filename);
  let handle; let linked = false;
  try {
    handle = await fs.open(temporary, 'wx', 0o600); await handle.writeFile(bytes); await handle.sync(); await handle.close(); handle = null;
    if (beforePublish) await beforePublish();
    try { await fs.link(temporary, destination); linked = true; }
    catch (error) { if (error.code !== 'EEXIST') throw error; }
    if (linked) await syncDirectory(directory);
    return { published: linked, path: destination };
  } catch (error) {
    if (linked) { error.effectState = 'unknown'; error.commitMayExist = true; }
    throw error;
  } finally { await handle?.close(); await fs.unlink(temporary).catch(error => { if (error.code !== 'ENOENT') throw error; }); }
}
export const jsonBytes = value => Buffer.from(canonicalize(value));
