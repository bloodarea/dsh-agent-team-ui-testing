import { spawn, execFile } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { constants } from 'node:fs';
import { access, mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { delimiter, dirname, isAbsolute, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createInterface } from 'node:readline';
import { hideBlenderWindowWhenReadyWin32 } from './hidden-window.js';

const SCRIPT = fileURLToPath(new URL('./viewport.py', import.meta.url));
const SIZE = [960, 540];
const TIMEOUT_MS = 20_000;
const IDLE_MS = 45_000;
const MAX_PIXELS = 8 * 1024 * 1024;
const MAX_FRAME_BYTES = MAX_PIXELS * 3 + 32_768;

/**
 * Windows keeps the window off every desktop area. The 3D path cannot be headless (`gpu` is
 * unavailable under `-b`), so the window must exist — but it must not steal focus or cover the
 * user's screen. A large negative offset is accepted and the draw handler still fires (verified).
 */
const WINDOW_OFFSET = -10000;

class ViewportError extends Error {
  constructor(code, message, status) {
    super(message);
    Object.assign(this, { code, status });
  }
}

/** Windows executable names carry a `.exe` suffix; the Linux names here never do. */
function executableNames(name, platform) {
  return platform === 'win32' ? [`${name}.exe`, name] : [name];
}

/**
 * Ask the registry where Blender is installed, instead of walking the disk.
 *
 * Only the per-machine/per-user `Uninstall` keys carry this: this build registers no
 * `SOFTWARE\\BlenderFoundation`, no `App Paths\\blender.exe` and no `blendfile` file association
 * (all four verified empty on a real install). Each entry contributes `DisplayName`,
 * `DisplayVersion` and `InstallLocation`; the newest version wins.
 *
 * @returns {Promise<{path:string, version:string, location:string}[]>} newest first
 */
async function windowsRegistryBlender() {
  const roots = [
    'HKLM\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Uninstall',
    'HKLM\\SOFTWARE\\WOW6432Node\\Microsoft\\Windows\\CurrentVersion\\Uninstall',
    'HKCU\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Uninstall',
  ];
  const run = (args) => new Promise((resolve) => {
    execFile('reg', args, { windowsHide: true, timeout: 10_000 }, (error, stdout) => {
      resolve(error ? '' : String(stdout));
    });
  });

  const found = [];
  for (const root of roots) {
    const listing = await run(['query', root, '/s', '/f', 'Blender', '/d']);
    if (!listing) continue;
    // A search hit prints the key first, then its matching values; read the key block by block.
    for (const block of listing.split(/\r?\n(?=HKEY_)/)) {
      if (!/^HKEY_/.test(block)) continue;
      const key = block.split(/\r?\n/, 1)[0].trim();
      if (!/\\Uninstall\\/i.test(key)) continue;
      const value = await run(['query', key]);
      if (!value) continue;
      const read = (field) => {
        const match = new RegExp(`^\\s*${field}\\s+REG_[A-Z_]+\\s+(.*)$`, 'mi').exec(value);
        return match ? match[1].trim() : '';
      };
      const displayName = read('DisplayName');
      if (!/^Blender$/i.test(displayName)) continue;
      const location = read('InstallLocation');
      if (!location) continue;
      const path = join(location, 'blender.exe');
      const info = await stat(path).catch(() => null);
      if (!info?.isFile()) continue;
      found.push({ path, version: read('DisplayVersion'), location });
    }
  }

  // Newest first, so an installed 5.3 is preferred over a portable 2.79 sitting in PATH.
  const order = new Intl.Collator('en', { numeric: true }).compare;
  return found.sort((left, right) => order(right.version, left.version));
}

/**
 * Resolve an executable path. `override` is authoritative: when it is unusable the caller reports
 * it rather than silently running something else.
 */
async function executable(override, name, platform = process.platform) {
  const names = executableNames(name, platform);
  if (override) {
    const info = await stat(override).catch(() => null);
    if (info?.isFile() && await access(override, constants.X_OK).then(() => true, () => false)) {
      return override;
    }
    throw new ViewportError('BLENDER_DEPENDENCY_MISSING', `找不到可执行文件 ${override}。`, 503);
  }

  const paths = [];
  for (const dir of (process.env.PATH || '').split(platform === 'win32' ? ';' : delimiter)) {
    if (!dir || !isAbsolute(dir)) continue;
    for (const fileName of names) paths.push(join(dir, fileName));
  }
  for (const fileName of names) {
    paths.push(join(homedir(), '.local', 'bin', fileName));
  }
  if (platform === 'win32') {
    // Registry first: an installer build is what the user actually runs, and it is not on PATH.
    for (const entry of await windowsRegistryBlender()) paths.unshift(entry.path);
  } else if (name === 'blender') {
    const root = join(homedir(), 'opt');
    const dirs = await readdir(root).catch(() => []);
    paths.push(...dirs.filter((dir) => /^blender-\d/.test(dir))
      .sort(new Intl.Collator('en', { numeric: true }).compare).reverse()
      .map((dir) => join(root, dir, name)));
  }

  for (const path of paths) {
    if (!isAbsolute(path)) continue;
    const info = await stat(path).catch(() => null);
    if (!info?.isFile()) continue;
    if (await access(path, constants.X_OK).then(() => true, () => false)) return path;
  }
  throw new ViewportError('BLENDER_DEPENDENCY_MISSING', `找不到可执行文件 ${name}。`, 503);
}

function startProcess(path, args, options) {
  const child = spawn(path, args, options);
  const closed = new Promise((resolve) => {
    child.once('close', resolve);
  });
  // A failed spawn must still reach the close/cleanup path.
  child.on('error', () => {});
  child.stderr.resume();
  child.stdin?.on('error', () => {});
  return { child, closed };
}

async function lineFrom(proc, match, signal) {
  const lines = createInterface({ input: proc.child.stdout });
  try {
    return await new Promise((resolve, reject) => {
      const failed = () => reject(new ViewportError('BLENDER_VIEWPORT_FAILED', 'Blender 视口进程意外退出。', 502));
      const aborted = () => reject(signal.reason);
      const onLine = (line) => {
        const value = match(line);
        if (value !== undefined) resolve(value);
      };
      lines.on('line', onLine);
      lines.once('close', failed);
      signal.addEventListener('abort', aborted, { once: true });
      if (signal.aborted) aborted();
      if (proc.child.stdout.readableEnded || proc.child.exitCode !== null || proc.child.signalCode !== null) failed();
    });
  } finally {
    lines.close();
  }
}

function authField(value) {
  const data = Buffer.from(value);
  const length = Buffer.alloc(2);
  length.writeUInt16BE(data.length);
  return Buffer.concat([length, data]);
}

export function parseViewportRequest(body) {
  const camera = body?.camera;
  if (!Array.isArray(camera) || camera.length !== 3 || !camera.every(Number.isFinite)
      || Math.abs(camera[0]) > 180 || Math.abs(camera[1]) > 85 || camera[2] < 0.15 || camera[2] > 6) {
    throw new ViewportError('INVALID_ARGUMENT', '3D 视角参数无效。', 400);
  }
  const size = body.size === undefined ? SIZE : body.size;
  if (!Array.isArray(size) || size.length !== 2
      || !size.every((value) => Number.isInteger(value) && value >= 200 && value <= 4096)
      || size[0] * size[1] > MAX_PIXELS) {
    throw new ViewportError('INVALID_ARGUMENT', '3D 分辨率须为 200–4096 像素，总面积不超过 8,388,608 像素。', 400);
  }
  return { camera, size };
}

export function createBlenderViewport({ platform = process.platform } = {}) {
  const lifetime = new AbortController();
  let runtime;
  let active;
  let idle;
  let stopping;

  function stop() {
    if (!runtime) return stopping;
    const current = runtime;
    runtime = undefined;
    stopping = (async () => {
      current.blender?.child.kill('SIGKILL');
      current.display?.child.kill();
      const fallback = setTimeout(() => current.display?.child.kill('SIGKILL'), 1200);
      try {
        await Promise.all([current.blender?.closed, current.display?.closed]);
        await rm(current.root, { recursive: true, force: true });
      } finally {
        clearTimeout(fallback);
        stopping = undefined;
      }
    })();
    return stopping;
  }

  async function ensure(signal) {
    if (runtime) return runtime;
    await stopping;
    signal.throwIfAborted();
    const windows = platform === 'win32';
    if (!windows && platform !== 'linux') {
      throw new ViewportError('BLENDER_PLATFORM_UNSUPPORTED', 'Blender 视口目前需要 Linux（Xvfb）或 Windows。', 503);
    }
    // Windows draws into a real window, so there is no virtual display to start.
    const [xvfb, blender] = await Promise.all([
      windows ? Promise.resolve(null) : executable(process.env.DSH_UI_TESTING_XVFB, 'Xvfb', platform),
      executable(process.env.DSH_UI_TESTING_BLENDER, 'blender', platform),
    ]);
    const root = await mkdtemp(join(tmpdir(), 'dsh-blender-viewport-'));
    const frame = join(root, 'frame.png');
    const authority = join(root, 'authority');
    runtime = { root, frame };

    const env = { ...process.env, LIBGL_ALWAYS_SOFTWARE: process.env.LIBGL_ALWAYS_SOFTWARE || '1',
      LP_NUM_THREADS: process.env.LP_NUM_THREADS || '4' };

    if (windows) {
      // Keep WAYLAND/display variables out of the way; the real desktop session is used.
      delete env.XAUTHORITY;
    } else {
      const cookie = Buffer.concat([
        Buffer.from([255, 255]), authField(''), authField(''),
        authField('MIT-MAGIC-COOKIE-1'), authField(randomBytes(16)),
      ]);
      await writeFile(authority, cookie, { mode: 0o600 });
      signal.throwIfAborted();
      runtime.display = startProcess(xvfb, [
        '-displayfd', '1', '-screen', '0', `${SIZE[0]}x${SIZE[1]}x24`, '-nolisten', 'tcp', '-auth', authority,
      ], { stdio: ['ignore', 'pipe', 'pipe'] });
      const display = await lineFrom(runtime.display, (line) => /^\d+$/.test(line) ? line : undefined, signal);
      env.DISPLAY = ':' + display;
      env.XAUTHORITY = authority;
      env.WAYLAND_DISPLAY = '';
    }

    const offset = windows ? WINDOW_OFFSET : 0;
    const args = ['--factory-startup', '--disable-autoexec', '-noaudio', '-t', '4',
      '-p', String(offset), String(offset), ...SIZE.map(String)];
    const project = process.env.DSH_UI_TESTING_BLEND_FILE;
    if (project) {
      const info = isAbsolute(project) && /\.blend$/i.test(project) && await stat(project).catch(() => null);
      if (!info?.isFile()) throw new ViewportError('BLENDER_PROJECT_INVALID', 'Blender 工程须为可读的绝对 .blend 路径。', 503);
      args.push(project);
    }
    signal.throwIfAborted();
    runtime.blender = startProcess(blender, [...args, '--python', SCRIPT, '--', frame], {
      cwd: root, env, stdio: ['pipe', 'pipe', 'pipe'],
    });
    if (windows) {
      // Offscreen placement alone leaves a taskbar button and an Alt-Tab entry. Restyle the window
      // as a tool window so the run is invisible; it stays mapped, so drawing keeps working.
      // Fire and forget: a failed restyle only means the button remains.
      void hideBlenderWindowWhenReadyWin32(runtime.blender.child.pid)
        .then((hidden) => { runtime.windowHidden = hidden; })
        .catch(() => {});
    }
    return runtime;
  }

  async function render(request, outerSignal) {
    const signal = AbortSignal.any([outerSignal, lifetime.signal, AbortSignal.timeout(TIMEOUT_MS)]);
    try {
      const current = await ensure(signal);
      const pending = lineFrom(current.blender, (line) => /^DSH_VIEWPORT (frame|error)$/.exec(line)?.[1], signal);
      current.blender.child.stdin.write(JSON.stringify(request) + '\n');
      if (await pending !== 'frame') throw new ViewportError('BLENDER_FRAME_FAILED', 'Blender 未能生成 3D 视口图像。', 502);
      const size = (await stat(current.frame)).size;
      if (size > MAX_FRAME_BYTES) throw new ViewportError('BLENDER_FRAME_FAILED', 'Blender 视口图像超出大小限制。', 502);
      const png = await readFile(current.frame);
      if (png.length < 33 || png.subarray(0, 8).toString('hex') !== '89504e470d0a1a0a') {
        throw new ViewportError('BLENDER_FRAME_FAILED', 'Blender 返回的 3D 视口图像无效。', 502);
      }
      if (png.readUInt32BE(16) !== request.size[0] || png.readUInt32BE(20) !== request.size[1]) {
        throw new ViewportError('BLENDER_FRAME_FAILED', 'Blender 返回的实际分辨率与请求不符。', 502);
      }
      return png;
    } catch (error) {
      await stop();
      if (error instanceof ViewportError) throw error;
      if (signal.reason?.name === 'TimeoutError') throw new ViewportError('BLENDER_TIMEOUT', '等待 Blender 视口超时。', 504);
      if (signal.aborted) throw new ViewportError('ABORTED', 'Blender 视口请求已取消。', 499);
      throw new ViewportError('BLENDER_VIEWPORT_FAILED', '无法读取 Blender 视口。', 502);
    }
  }

  return {
    async frame(camera, signal) {
      if (active) throw new ViewportError('BLENDER_BUSY', 'Blender 视口正在生成画面。', 409);
      clearTimeout(idle);
      active = render(camera, signal);
      try {
        return await active;
      } finally {
        active = undefined;
        if (runtime) {
          idle = setTimeout(() => { void stop().catch(() => {}); }, IDLE_MS);
          idle.unref();
        }
      }
    },
    async dispose() {
      lifetime.abort();
      await active?.catch(() => {});
      clearTimeout(idle);
      await stop();
    },
  };
}
