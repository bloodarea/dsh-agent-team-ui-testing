import { lstat, opendir, realpath } from 'node:fs/promises';
import { isAbsolute, join, relative, resolve } from 'node:path';

const MAX_PROJECTS = 500;
const MAX_ENTRIES = 12000;

const validPart = (part) => part && !part.startsWith('.') && part !== 'node_modules'
  && !/[\\:\u0000-\u001f\u007f]/u.test(part);

export function isBlenderProjectName(name) {
  return typeof name === 'string' && Buffer.byteLength(name) <= 1024 && /\.blend$/iu.test(name)
    && name.split('/').every(validPart) && !name.toLowerCase().startsWith('docs/internal/old/');
}

export async function listBlenderProjects(directory, signal) {
  if (!directory) return { projects: [], truncated: false };
  const root = await realpath(directory);
  const projects = [];
  const folders = [''];
  let entries = 0;
  let truncated = false;
  while (folders.length && !truncated) {
    const prefix = folders.pop();
    signal.throwIfAborted();
    const folder = await opendir(join(root, prefix)).catch((error) => {
      if (!prefix || !['EACCES', 'EPERM', 'ENOENT', 'ENOTDIR'].includes(error.code)) throw error;
      return null;
    });
    if (!folder) continue;
    for await (const entry of folder) {
      signal.throwIfAborted();
      if (++entries > MAX_ENTRIES || projects.length >= MAX_PROJECTS) {
        truncated = true;
        break;
      }
      if (!validPart(entry.name)) continue;
      const name = prefix ? `${prefix}/${entry.name}` : entry.name;
      if (entry.isDirectory() && name.toLowerCase() !== 'docs/internal/old') folders.push(name);
      else if (entry.isFile() && isBlenderProjectName(name)) projects.push(name);
    }
  }
  projects.sort(new Intl.Collator(undefined, { numeric: true }).compare);
  return { projects, truncated };
}

export async function resolveBlenderProject(directory, name) {
  if (!directory || !isBlenderProjectName(name)) return null;
  try {
    const root = await realpath(directory);
    let current = root;
    for (const part of name.split('/')) {
      current = join(current, part);
      if ((await lstat(current)).isSymbolicLink()) return null;
    }
    const file = await realpath(current);
    const fromRoot = relative(root, file);
    if (isAbsolute(fromRoot) || fromRoot.startsWith('..') || file !== resolve(current)) return null;
    return (await lstat(file)).isFile() ? file : null;
  } catch (error) {
    if (['ENOENT', 'ENOTDIR', 'EACCES', 'EPERM'].includes(error.code)) return null;
    throw error;
  }
}
