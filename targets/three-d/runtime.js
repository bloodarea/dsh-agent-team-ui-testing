import { spawn, execFile } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { constants } from 'node:fs';
import { access, mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { delimiter, dirname, isAbsolute, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createInterface } from 'node:readline';
import { blenderDesktopLaunch } from './hidden-window.js';

const SCRIPT = fileURLToPath(new URL('./viewport.py', import.meta.url));
const SIZE = [960, 540];
const TIMEOUT_MS = 20_000;
const IDLE_MS = 45_000;
const MAX_PIXELS = 8 * 1024 * 1024;
const MAX_FRAME_BYTES = MAX_PIXELS * 3 + 32_768;

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

const INPUT_TYPES = new Set(['move', 'down', 'up', 'wheel', 'cancel', 'escape']);

function parseViewportInput(input) {
  const invalid = () => new ViewportError('INVALID_ARGUMENT', 'Blender 鼠标事件无效。', 400);
  if (!Array.isArray(input) || input.length > 32) throw invalid();
  return input.map((event) => {
    const { kind, x, y, button, delta, shift = false, ctrl = false, alt = false } = event || {};
    if (!INPUT_TYPES.has(kind)) throw invalid();
    if (kind === 'cancel' || kind === 'escape') return { kind };
    if (![x, y].every((value) => Number.isFinite(value) && value >= 0 && value <= 1)
        || ![shift, ctrl, alt].every((value) => typeof value === 'boolean')) throw invalid();
    const result = { kind, x, y, shift, ctrl, alt };
    if (kind === 'down' || kind === 'up') {
      if (button !== 0 && button !== 1 && button !== 2) throw invalid();
      result.button = button;
    }
    if (kind === 'wheel') {
      if (!Number.isInteger(delta) || delta === 0 || Math.abs(delta) > 8) throw invalid();
      result.delta = delta;
    }
    return result;
  });
}

export function parseViewportRequest(body) {
  const size = body?.size === undefined ? SIZE : body.size;
  if (!Array.isArray(size) || size.length !== 2
      || !size.every((value) => Number.isInteger(value) && value >= 200 && value <= 4096)
      || size[0] * size[1] > MAX_PIXELS) {
    throw new ViewportError('INVALID_ARGUMENT', '3D 分辨率须为 200–4096 像素，总面积不超过 8,388,608 像素。', 400);
  }
  if (body?.input !== undefined) {
    const input = parseViewportInput(body.input);
    const generation = body.generation;
    if (body.camera !== undefined || (input.length && generation === undefined)
        || (generation !== undefined && (typeof generation !== 'string' || !/^[a-f0-9]{32}$/u.test(generation)))) {
      throw new ViewportError('INVALID_ARGUMENT', 'Blender 视口会话参数无效。', 400);
    }
    return { input, generation, size };
  }
  const camera = body?.camera;
  if (!Array.isArray(camera) || camera.length !== 3 || !camera.every(Number.isFinite)
      || Math.abs(camera[0]) > 180 || Math.abs(camera[1]) > 85 || camera[2] < 0.15 || camera[2] > 6) {
    throw new ViewportError('INVALID_ARGUMENT', '3D 视角参数无效。', 400);
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
      if (platform === 'win32') current.blender?.child.stdin.end();
      else current.blender?.child.kill('SIGKILL');
      current.display?.child.kill();
      const fallback = setTimeout(() => {
        current.blender?.child.kill('SIGKILL');
        current.display?.child.kill('SIGKILL');
      }, 1200);
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
      // The Windows launcher supplies a private Win32 desktop.
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

    const args = ['--factory-startup', '--disable-autoexec', '--enable-event-simulate', '-noaudio', '-t', '4',
      '-p', '0', '0', ...SIZE.map(String)];
    const project = process.env.DSH_UI_TESTING_BLEND_FILE;
    if (project) {
      const info = isAbsolute(project) && /\.blend$/i.test(project) && await stat(project).catch(() => null);
      if (!info?.isFile()) throw new ViewportError('BLENDER_PROJECT_INVALID', 'Blender 工程须为可读的绝对 .blend 路径。', 503);
      args.push(project);
    }
    signal.throwIfAborted();
    args.push('--python', SCRIPT, '--', frame);
    const launch = windows ? blenderDesktopLaunch(blender, args, env) : { executable: blender, args, env };
    runtime.blender = startProcess(launch.executable, launch.args, {
      cwd: root, env: launch.env, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'],
    });
    return runtime;
  }

  async function render(request, outerSignal, scopeKey) {
    const interactive = request.input !== undefined;
    if (interactive && request.generation !== undefined
        && (runtime?.generation !== request.generation || runtime?.scopeKey !== scopeKey)) {
      throw new ViewportError('BLENDER_STALE_FRAME', 'Blender 视口已重启或切换，请在新画面上操作。', 409);
    }
    const signal = AbortSignal.any([outerSignal, lifetime.signal, AbortSignal.timeout(TIMEOUT_MS)]);
    try {
      if (interactive && runtime && runtime.scopeKey !== scopeKey) await stop();
      const current = await ensure(signal);
      if (interactive && !current.generation) {
        current.scopeKey = scopeKey;
        current.generation = randomBytes(16).toString('hex');
      }
      const pending = lineFrom(current.blender, (line) => /^DSH_VIEWPORT (frame(?: \d+ \d+ \d+ \d+)?|error|isolation-error)$/u.exec(line)?.[1], signal);
      current.blender.child.stdin.write(JSON.stringify(request) + '\n');
      const result = await pending;
      if (result === 'isolation-error') {
        throw new ViewportError('BLENDER_DESKTOP_FAILED', '无法在独立的 Windows 桌面上启动 Blender 视口。', 502);
      }
      const [status, ...bounds] = result.split(' ');
      if (status !== 'frame' || (interactive && bounds.length !== 4)) {
        throw new ViewportError('BLENDER_FRAME_FAILED', 'Blender 未能生成 3D 视口图像。', 502);
      }
      const size = (await stat(current.frame)).size;
      if (size > MAX_FRAME_BYTES) throw new ViewportError('BLENDER_FRAME_FAILED', 'Blender 视口图像超出大小限制。', 502);
      const png = await readFile(current.frame);
      if (png.length < 33 || png.subarray(0, 8).toString('hex') !== '89504e470d0a1a0a') {
        throw new ViewportError('BLENDER_FRAME_FAILED', 'Blender 返回的 3D 视口图像无效。', 502);
      }
      if (png.readUInt32BE(16) !== request.size[0] || png.readUInt32BE(20) !== request.size[1]) {
        throw new ViewportError('BLENDER_FRAME_FAILED', 'Blender 返回的实际分辨率与请求不符。', 502);
      }
      if (!interactive) return png;
      const content = bounds.map(Number);
      const [x, y, width, height] = content;
      if (!width || !height || x + width > request.size[0] || y + height > request.size[1]) {
        throw new ViewportError('BLENDER_FRAME_FAILED', 'Blender 返回的视口范围无效。', 502);
      }
      return { png, content, generation: current.generation };
    } catch (error) {
      await stop();
      if (error instanceof ViewportError) throw error;
      if (signal.reason?.name === 'TimeoutError') throw new ViewportError('BLENDER_TIMEOUT', '等待 Blender 视口超时。', 504);
      if (signal.aborted) throw new ViewportError('ABORTED', 'Blender 视口请求已取消。', 499);
      throw new ViewportError('BLENDER_VIEWPORT_FAILED', '无法读取 Blender 视口。', 502);
    }
  }

  return {
    async frame(request, signal, scopeKey = 'recent') {
      if (active) throw new ViewportError('BLENDER_BUSY', 'Blender 视口正在生成画面。', 409);
      clearTimeout(idle);
      active = render(request, signal, scopeKey);
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
