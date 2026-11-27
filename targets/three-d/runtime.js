import { spawn, execFile } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { constants } from 'node:fs';
import { access, mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { delimiter, dirname, isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createInterface } from 'node:readline';
import { blenderDesktopLaunch } from './hidden-window.js';
import { isBlenderProjectName } from './projects.js';
import { createBlenderReferences, referenceError } from './references.js';

const SCRIPT = fileURLToPath(new URL('./viewport.py', import.meta.url));
const SIZE = [960, 540];
const TIMEOUT_MS = 20_000;
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

async function probeBlender(options = {}) {
  const path = await executable(options.blenderExecutable || process.env.DSH_UI_TESTING_BLENDER, 'blender', options.platform || process.platform);
  const execute = options.execFile || execFile;
  const result = await new Promise((resolve, reject) => {
    execute(path, ['--version'], { windowsHide: true, timeout: 10_000, encoding: 'utf8' }, (error, stdout, stderr) => {
      if (error) return reject(new ViewportError('BLENDER_PROBE_FAILED', '无法查询 Blender 版本。', 503));
      resolve(`${stdout || ''}\n${stderr || ''}`);
    });
  });
  const version = /Blender\s+(\d+\.\d+\.\d+)/u.exec(result)?.[1];
  if (!version) throw new ViewportError('BLENDER_PROBE_FAILED', 'Blender --version 输出无法识别。', 503);
  return { available: true, path, version, baseline: '5.3.0', compatible: versionAtLeast(version) };
}

function startProcess(path, args, options, spawnProcess = spawn) {
  const child = spawnProcess(path, args, options);
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
const EDITORS = new Set(['outliner', 'properties', 'select-visibility', 'gizmos', 'overlays', 'shading-settings', 'preferences', 'timeline']);
const SHADING_TYPES = new Set(['WIREFRAME', 'SOLID', 'MATERIAL', 'RENDERED']);
const BLENDER_WORKSPACES = new Set(['layout', 'modeling', 'sculpting', 'uv-editing', 'texture-paint',
  'shading', 'animation', 'rendering', 'compositing']);
const COMMAND_OPS = new Set(['hello', 'scene.query', 'scene.apply', 'project.save', 'view.get', 'view.set']);
const SCENE_OPS = new Set(['collection.ensure', 'object.ensure', 'object.parent', 'object.transform',
  'mesh.primitive', 'object.remove', 'material.ensure', 'material.assign']);
const BASELINE_VERSION = [5, 3, 0];

function versionAtLeast(version, baseline = BASELINE_VERSION) {
  const actual = String(version || '').split('.').slice(0, 3).map(Number);
  if (actual.length !== 3 || actual.some((part) => !Number.isInteger(part))) return false;
  for (let index = 0; index < baseline.length; index += 1) {
    if (actual[index] !== baseline[index]) return actual[index] > baseline[index];
  }
  return true;
}

function parseViewportInput(input, editors) {
  const invalid = () => new ViewportError('INVALID_ARGUMENT', 'Blender 鼠标事件无效。', 400);
  if (!Array.isArray(input) || input.length > 32) throw invalid();
  return input.map((event) => {
    const { kind, editor, x, y, button, delta, shift = false, ctrl = false, alt = false } = event || {};
    if (!INPUT_TYPES.has(kind) || (editor !== undefined && !editors?.includes(editor))) throw invalid();
    const result = { kind };
    if (editor !== undefined) result.editor = editor;
    if (kind === 'cancel' || kind === 'escape') return result;
    if (![x, y].every((value) => Number.isFinite(value) && value >= 0 && value <= 1)
        || ![shift, ctrl, alt].every((value) => typeof value === 'boolean')) throw invalid();
    Object.assign(result, { x, y, shift, ctrl, alt });
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
  const workspace = body?.workspace;
  const shading = body?.shading;
  const editors = body?.editors;
  const project = body?.project;
  const reload = body?.reload;
  if ((project !== undefined || reload !== undefined) && (body.input === undefined
      || (project !== undefined && project !== null && !isBlenderProjectName(project))
      || (reload !== undefined && (reload !== true || project === undefined))
      || (reload !== true && body.generation !== undefined)
      || workspace !== undefined || shading !== undefined)) {
    throw new ViewportError('INVALID_ARGUMENT', 'Blender 工程参数无效。', 400);
  }
  if (editors !== undefined && (body.input === undefined || !Array.isArray(editors)
      || editors.length > EDITORS.size || new Set(editors).size !== editors.length || !editors.every((id) => EDITORS.has(id)))) {
    throw new ViewportError('INVALID_ARGUMENT', 'Blender 编辑器面板参数无效。', 400);
  }
  if (workspace !== undefined && (!BLENDER_WORKSPACES.has(workspace) || body.input === undefined)) {
    throw new ViewportError('INVALID_ARGUMENT', 'Blender 工作区无效。', 400);
  }
  if (shading !== undefined && (!SHADING_TYPES.has(shading) || body.input === undefined || workspace !== undefined)) {
    throw new ViewportError('INVALID_ARGUMENT', 'Blender 视口着色模式无效。', 400);
  }
  if (body?.input !== undefined) {
    const input = parseViewportInput(body.input, editors);
    const generation = body.generation;
    if (body.camera !== undefined || ((workspace !== undefined || reload) && input.length)
        || ((input.length || shading !== undefined || workspace !== undefined) && generation === undefined)
        || (generation !== undefined && (typeof generation !== 'string' || !/^[a-f0-9]{32}$/u.test(generation)))) {
      throw new ViewportError('INVALID_ARGUMENT', 'Blender 视口会话参数无效。', 400);
    }
    const request = { input, generation, size };
    if (shading !== undefined) request.shading = shading;
    if (workspace !== undefined) request.workspace = workspace;
    if (editors !== undefined) request.editors = editors;
    if (project !== undefined) request.project = project;
    if (reload) request.reload = true;
    return request;
  }
  const camera = body?.camera;
  if (!Array.isArray(camera) || camera.length !== 3 || !camera.every(Number.isFinite)
      || Math.abs(camera[0]) > 180 || Math.abs(camera[1]) > 85 || camera[2] < 0.15 || camera[2] > 6) {
    throw new ViewportError('INVALID_ARGUMENT', '3D 视角参数无效。', 400);
  }
  return { camera, size };
}

async function readViewportPng(path) {
  const { size } = await stat(path);
  if (size > MAX_FRAME_BYTES) throw new ViewportError('BLENDER_FRAME_FAILED', 'Blender 视口图像超出大小限制。', 502);
  const png = await readFile(path);
  if (png.length < 33 || png.subarray(0, 8).toString('hex') !== '89504e470d0a1a0a') {
    throw new ViewportError('BLENDER_FRAME_FAILED', 'Blender 返回的视口图像无效。', 502);
  }
  return png;
}

export function encodeViewportResponse(result) {
  const png = result.png || result;
  const headers = { 'Content-Type': 'image/png', 'Content-Length': png.length, 'Cache-Control': 'no-store' };
  if (!result.generation) return { headers, body: png };
  headers['X-DSH-Blender-Generation'] = result.generation;
  headers['X-DSH-Blender-Content'] = result.content.join(',');
  if (result.shading) headers['X-DSH-Blender-Shading'] = result.shading;
  if (result.workspace) headers['X-DSH-Blender-Workspace'] = result.workspace;
  if (result.playing) headers['X-DSH-Blender-Playing'] = '1';
  if (result.project) headers['X-DSH-Blender-Project'] = encodeURIComponent(result.project);
  if (!result.editors?.length) return { headers, body: png };
  // The header gives byte lengths in body order. Each segment is a complete PNG.
  const body = Buffer.concat([png, ...result.editors.map((editor) => editor.png)]);
  headers['Content-Type'] = 'application/octet-stream';
  headers['Content-Length'] = body.length;
  headers['X-DSH-Blender-Images'] = JSON.stringify([['viewport', png.length],
    ...result.editors.map((editor) => [editor.id, editor.png.length])]);
  return { headers, body };
}

export function createBlenderViewport(options = {}) {
  const instances = new Map();
  let disposing;

  async function release(workspaceKey) {
    const keys = workspaceKey === undefined ? [...instances.keys()] : [workspaceKey];
    const results = await Promise.allSettled(keys.map(async (key) => {
      const instance = instances.get(key);
      if (!instance) return;
      try {
        await instance.dispose();
      } finally {
        if (instances.get(key) === instance) instances.delete(key);
      }
    }));
    const failures = results.filter((result) => result.status === 'rejected').map((result) => result.reason);
    if (failures.length) throw new AggregateError(failures, 'Failed to dispose Blender workspace instances');
  }

  function referencesFor(workspaceKey, generation) {
    const references = instances.get(workspaceKey)?.references();
    if (generation !== undefined && (!references || references.generation !== generation)) {
      throw referenceError('BLENDER_STALE_FRAME', 'Blender 实例已更换，请重新选择参考图。', 409);
    }
    return references;
  }

  return {
    // Read-only inventory: never creates an instance or exposes its internal token.
    listRunning() {
      return [...instances].map(([workspaceKey, instance]) => {
        const current = instance.status(workspaceKey);
        return { workspaceKey, pid: current.pid, connected: current.connection?.connected === true };
      }).filter(instance => instance.connected);
    },
    listReferences(workspaceKey) {
      return referencesFor(workspaceKey)?.list() ?? { generation: null, items: [] };
    },
    addReference(workspaceKey, generation, reference) {
      return referencesFor(workspaceKey, generation).add(reference);
    },
    getReference(workspaceKey, generation, id) {
      return referencesFor(workspaceKey, generation).get(id);
    },
    removeReference(workspaceKey, generation, id) {
      return referencesFor(workspaceKey, generation).remove(id);
    },
    frame(request, signal, workspaceKey = 'recent', projectPath) {
      if (disposing || signal.aborted) {
        return Promise.reject(new ViewportError('ABORTED', 'Blender 视口请求已取消。', 499));
      }
      let instance = instances.get(workspaceKey);
      if (!instance) {
        instance = createBlenderInstance(options);
        instances.set(workspaceKey, instance);
      }
      return instance.frame(request, projectPath);
    },
    command(request, signal, workspaceKey = 'recent', projectPath) {
      if (disposing || signal?.aborted) {
        return Promise.reject(new ViewportError('ABORTED', 'Blender 命令已取消。', 499));
      }
      let instance = instances.get(workspaceKey);
      if (!instance) {
        instance = createBlenderInstance(options);
        instances.set(workspaceKey, instance);
      }
      return instance.command(request, signal, projectPath);
    },
    probe() {
      return probeBlender(options);
    },
    status(workspaceKey = 'recent') {
      return instances.get(workspaceKey)?.status(workspaceKey) ?? {
        workspaceKey, state: 'cold', internalToken: null, pid: null,
        connection: { connected: false, runtimeGeneration: null, hello: null, lastCommand: null }, busy: false,
      };
    },
    release,
    dispose() {
      disposing ??= release();
      return disposing;
    },
  };
}

function createBlenderInstance(options = {}) {
  const { platform = process.platform, configDirectory } = options;
  const preferencesDirectory = configDirectory ? resolve(configDirectory, 'blender') : null;
  const lifetime = new AbortController();
  let runtime;
  let active;
  let stopping;
  let disposing;
  const internalToken = randomBytes(24).toString('hex');
  let lastCommand = null;

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

  async function ensure(signal, projectPath) {
    if (runtime) return runtime;
    await stopping;
    signal.throwIfAborted();
    const windows = platform === 'win32';
    if (!windows && platform !== 'linux') {
      throw new ViewportError('BLENDER_PLATFORM_UNSUPPORTED', 'Blender 视口目前需要 Linux（Xvfb）或 Windows。', 503);
    }
    // Windows draws into a real window, so there is no virtual display to start.
    const [xvfb, blender] = await Promise.all([
      windows ? Promise.resolve(null) : executable(options.xvfbExecutable || process.env.DSH_UI_TESTING_XVFB, 'Xvfb', platform),
      executable(options.blenderExecutable || process.env.DSH_UI_TESTING_BLENDER, 'blender', platform),
    ]);
    signal.throwIfAborted();
    if (preferencesDirectory) {
      try {
        await mkdir(preferencesDirectory, { recursive: true, mode: 0o700 });
      } catch {
        throw new ViewportError('BLENDER_PREFERENCES_UNAVAILABLE', '无法创建 Blender 偏好设置目录，请检查 DSH 配置目录权限。', 503);
      }
    }
    const root = await mkdtemp(join(tmpdir(), 'dsh-blender-viewport-'));
    const frame = join(root, 'frame.png');
    const authority = join(root, 'authority');
    runtime = { root, frame, runtimeGeneration: randomBytes(16).toString('hex'), projectPath: projectPath || process.env.DSH_UI_TESTING_BLEND_FILE || null };

    const env = { ...process.env, LIBGL_ALWAYS_SOFTWARE: process.env.LIBGL_ALWAYS_SOFTWARE || '1',
      LP_NUM_THREADS: process.env.LP_NUM_THREADS || '4' };
    // Keep Blender's desktop profile separate from the debug runtime.
    for (const key of Object.keys(env)) {
      if (/^BLENDER_USER_/i.test(key)) delete env[key];
    }
    env.BLENDER_USER_RESOURCES = root;
    if (preferencesDirectory) env.BLENDER_USER_CONFIG = preferencesDirectory;

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
      ], { stdio: ['ignore', 'pipe', 'pipe'] }, options.spawnProcess || spawn);
      const display = await lineFrom(runtime.display, (line) => /^\d+$/.test(line) ? line : undefined, signal);
      env.DISPLAY = ':' + display;
      env.XAUTHORITY = authority;
      env.WAYLAND_DISPLAY = '';
    }

    const args = ['--factory-startup', '--disable-autoexec', '--enable-event-simulate', '-noaudio', '-t', '4',
      '-p', '0', '0', ...SIZE.map(String)];
    const project = projectPath || process.env.DSH_UI_TESTING_BLEND_FILE;
    if (project) {
      const info = isAbsolute(project) && /\.blend$/i.test(project) && await stat(project).catch(() => null);
      if (!info?.isFile()) throw new ViewportError('BLENDER_PROJECT_INVALID', 'Blender 工程须为可读的绝对 .blend 路径。', 503);
    }
    signal.throwIfAborted();
    args.push('--python', SCRIPT, '--', frame);
    if (project) args.push(project);
    const launch = windows ? blenderDesktopLaunch(blender, args, env) : { executable: blender, args, env };
    runtime.blender = startProcess(launch.executable, launch.args, {
      cwd: root, env: launch.env, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'],
    }, options.spawnProcess || spawn);
    const current = runtime;
    void current.blender.closed.then(() => { current.references = undefined; });
    return current;
  }

  async function render(request, projectPath) {
    // HTTP frames use [width, height]; agent capture uses the schema's named size.
    const size = Array.isArray(request.size) ? request.size
      : (request.size && Number.isInteger(request.size.width) && Number.isInteger(request.size.height)
        ? [request.size.width, request.size.height] : request.size);
    if (!Array.isArray(size) || size.length !== 2
        || !size.every((value) => Number.isInteger(value) && value >= 200 && value <= 4096)
        || size[0] * size[1] > MAX_PIXELS) {
      throw new ViewportError('INVALID_ARGUMENT', '3D 分辨率须为 200–4096 像素，总面积不超过 8,388,608 像素。', 400);
    }
    request = { ...request, size };
    const interactive = request.input !== undefined;
    if (interactive && request.generation !== undefined && runtime?.generation !== request.generation) {
      throw new ViewportError('BLENDER_STALE_FRAME', 'Blender 视口已重启或切换，请在新画面上操作。', 409);
    }
    // An HTTP disconnect must not interrupt an operation already sent to a shared instance.
    const signal = AbortSignal.any([lifetime.signal, AbortSignal.timeout(TIMEOUT_MS)]);
    try {
      if (request.reload) await stop();
      const current = await ensure(signal, projectPath);
      if (!current.generation) {
        current.project = request.project ?? null;
        current.generation = randomBytes(16).toString('hex');
      }
      const pending = lineFrom(current.blender, (line) => /^DSH_VIEWPORT (frame(?: \d+ \d+ \d+ \d+(?: [A-Z]+(?: [a-z-]+(?: playing)?)?)?)?|error|isolation-error|project-error)$/u.exec(line)?.[1], signal);
      current.blender.child.stdin.write(JSON.stringify(request) + '\n');
      const result = await pending;
      if (result === 'isolation-error') {
        throw new ViewportError('BLENDER_DESKTOP_FAILED', '无法在独立的 Windows 桌面上启动 Blender 视口。', 502);
      }
      if (result === 'project-error') {
        throw new ViewportError('BLENDER_PROJECT_INVALID', 'Blender 无法加载这个 .blend 工程。', 422);
      }
      const [status, xValue, yValue, widthValue, heightValue, reportedShading, workspace, playback] = result.split(' ');
      const shading = reportedShading === 'NONE' ? undefined : reportedShading;
      if (status !== 'frame' || (interactive && (heightValue === undefined
          || (shading !== undefined && !SHADING_TYPES.has(shading)) || (request.shading && request.shading !== shading)
          || (workspace !== undefined && !BLENDER_WORKSPACES.has(workspace)) || (request.workspace && request.workspace !== workspace)))) {
        throw new ViewportError('BLENDER_FRAME_FAILED', 'Blender 未能生成 3D 视口图像。', 502);
      }
      const png = await readViewportPng(current.frame);
      signal.throwIfAborted();
      if (png.readUInt32BE(16) !== request.size[0] || png.readUInt32BE(20) !== request.size[1]) {
        throw new ViewportError('BLENDER_FRAME_FAILED', 'Blender 返回的实际分辨率与请求不符。', 502);
      }
      current.references ??= createBlenderReferences(current.generation);
      if (!interactive) return png;
      const content = [xValue, yValue, widthValue, heightValue].map(Number);
      const [x, y, width, height] = content;
      if (!width || !height || x + width > request.size[0] || y + height > request.size[1]) {
        throw new ViewportError('BLENDER_FRAME_FAILED', 'Blender 返回的视口范围无效。', 502);
      }
      const names = (request.editors || []).filter((id) => id !== 'timeline' || workspace === 'layout');
      const editors = await Promise.all(names.map(async (id) => ({
        id, png: await readViewportPng(join(current.root, `editor-${id}.png`)),
      })));
      signal.throwIfAborted();
      return { png, content, generation: current.generation, shading, workspace, editors,
        project: current.project, playing: playback === 'playing' };
    } catch (error) {
      await stop();
      if (error instanceof ViewportError) throw error;
      if (signal.reason?.name === 'TimeoutError') throw new ViewportError('BLENDER_TIMEOUT', '等待 Blender 视口超时。', 504);
      if (signal.aborted) throw new ViewportError('ABORTED', 'Blender 视口请求已取消。', 499);
      throw new ViewportError('BLENDER_VIEWPORT_FAILED', '无法读取 Blender 视口。', 502);
    }
  }

  async function runCommand(request, projectPath, waitSignal) {
    const bootSignal = lifetime.signal;
    const current = await ensure(bootSignal, projectPath);
    if (!current.hello && request.op !== 'hello') {
      throw new ViewportError('BLENDER_HANDSHAKE_REQUIRED', '请先对当前 Blender 实例执行 hello 握手。', 409);
    }
    if (request.runtimeGeneration !== undefined && request.runtimeGeneration !== current.runtimeGeneration) {
      throw new ViewportError('BLENDER_STALE_RUNTIME', 'Blender 实例已更换，请刷新运行时状态。', 409);
    }
    if (waitSignal.aborted) {
      throw new ViewportError('BLENDER_COMMAND_NOT_SENT', '命令已在发送前取消。', 499);
    }
    const envelope = {
      channel: 'command', id: request.id, targetId: request.targetId,
      generation: request.generation, runtimeGeneration: current.runtimeGeneration,
      op: request.op, payload: request.payload,
    };
    const pending = lineFrom(current.blender, (line) => {
      const match = /^DSH_VIEWPORT command (.+)$/u.exec(line);
      if (!match) return undefined;
      try { return JSON.parse(match[1]); } catch { return { malformed: true }; }
    }, bootSignal);
    lastCommand = { id: request.id, op: request.op, state: 'sent' };
    current.blender.child.stdin.write(JSON.stringify(envelope) + '\n');
    const response = await pending;
    const fields = ['id', 'targetId', 'generation', 'runtimeGeneration'];
    if (response.malformed || response.channel !== 'command-reply'
        || fields.some((key) => response[key] !== envelope[key])) {
      lastCommand = { id: request.id, op: request.op, state: 'unknown', reason: 'identity-mismatch' };
      throw new ViewportError('BLENDER_PROTOCOL_MISMATCH', 'Blender 命令回复身份不匹配，效果未知。', 502);
    }
    if (!response.ok) {
      lastCommand = { id: request.id, op: request.op, state: 'failed' };
      throw new ViewportError(response.error?.code || 'BLENDER_COMMAND_FAILED', response.error?.message || 'Blender 命令失败。', 422);
    }
    if (request.op === 'hello'
        && (!versionAtLeast(response.result?.version)
          || !Array.isArray(response.result?.supportedOps)
          || response.result.supportedOps.length !== SCENE_OPS.size
          || response.result.supportedOps.some((op) => !SCENE_OPS.has(op)))) {
      lastCommand = { id: request.id, op: request.op, state: 'failed', reason: 'runtime-capability-mismatch' };
      throw new ViewportError('BLENDER_VERSION_UNSUPPORTED', 'Blender 版本或受控 op 清单不兼容。', 503);
    }
    if (request.op === 'hello') {
      current.hello = { version: response.result.version, supportedOps: [...response.result.supportedOps] };
    }
    lastCommand = { id: request.id, op: request.op, state: 'succeeded' };
    return response.result;
  }

  function command(request, signal, projectPath) {
    const fail = (code, message, status = 400) => Promise.reject(new ViewportError(code, message, status));
    if (disposing || lifetime.signal.aborted) return fail('ABORTED', 'Blender 命令已取消。', 499);
    if (active) return fail('BLENDER_BUSY', '当前工作区的 Blender 实例正在处理请求。', 409);
    if (!request || typeof request !== 'object' || Array.isArray(request)
        || Object.keys(request).some((key) => !['id', 'targetId', 'generation', 'runtimeGeneration', 'op', 'payload'].includes(key))
        || !['id', 'targetId', 'generation', 'op', 'payload'].every((key) => key in request)
        || typeof request.id !== 'string' || !request.id || request.id.length > 128
        || typeof request.targetId !== 'string' || !request.targetId || request.targetId.length > 128
        || !(typeof request.generation === 'string' && request.generation.length > 0 && request.generation.length <= 128)
          && !(Number.isSafeInteger(request.generation) && request.generation > 0)
        || (request.runtimeGeneration !== undefined && typeof request.runtimeGeneration !== 'string')
        || !COMMAND_OPS.has(request.op) || !request.payload || typeof request.payload !== 'object' || Array.isArray(request.payload)
        || Buffer.byteLength(JSON.stringify(request.payload)) > 1_048_576) {
      return fail('INVALID_ARGUMENT', 'Blender 命令请求无效。');
    }
    if (request.op === 'scene.apply' && (!Array.isArray(request.payload.ops) || request.payload.ops.length > 32
        || request.payload.ops.some((item) => !SCENE_OPS.has(item?.opId)))) {
      return fail('INVALID_ARGUMENT', 'Blender 场景操作未注册或超出批次上限。');
    }
    if (signal?.aborted) return fail('ABORTED', 'Blender 命令在发送前已取消。', 499);
    const timeout = AbortSignal.timeout(options.commandTimeoutMs || TIMEOUT_MS);
    const waitSignal = signal ? AbortSignal.any([signal, timeout]) : timeout;
    const operation = runCommand(request, projectPath, waitSignal);
    active = operation;
    void operation.finally(() => { if (active === operation) active = undefined; }).catch(() => {});
    return new Promise((resolve, reject) => {
      let settled = false;
      const onAbort = () => {
        if (settled) return;
        settled = true;
        const timedOut = timeout.aborted;
        const readOnly = ['hello', 'scene.query', 'view.get'].includes(request.op);
        lastCommand = { id: request.id, op: request.op, state: 'unknown', effectState: readOnly ? 'none' : 'unknown', retryable: false };
        const error = new ViewportError('BLENDER_COMMAND_UNKNOWN',
          'Blender 命令等待已结束；共享进程未终止，写入效果未知，禁止自动重放。', timedOut ? 504 : 499);
        error.effectState = readOnly ? 'none' : 'unknown';
        error.retryable = false;
        error.commandId = request.id;
        reject(error);
      };
      waitSignal.addEventListener('abort', onAbort, { once: true });
      if (waitSignal.aborted) onAbort();
      operation.then((result) => {
        if (settled) return;
        settled = true;
        waitSignal.removeEventListener('abort', onAbort);
        resolve(result);
      }, (error) => {
        if (settled) return;
        settled = true;
        waitSignal.removeEventListener('abort', onAbort);
        reject(error);
      });
    });
  }

  function status(workspaceKey) {
    const current = runtime;
    const connected = Boolean(current?.blender && current.blender.child.exitCode === null && current.blender.child.signalCode === null);
    return { workspaceKey, state: connected ? 'running' : 'stopped', internalToken,
      pid: connected ? current.blender.child.pid : null,
      projectPath: connected ? current.projectPath ?? null : null,
      connection: { connected, runtimeGeneration: connected ? current.runtimeGeneration : null,
        hello: connected ? current.hello ?? null : null, lastCommand },
      busy: Boolean(active) };
  }

  return {
    status,
    command,
    references() {
      if (disposing || !runtime?.blender || runtime.blender.child.exitCode !== null || runtime.blender.child.signalCode !== null) return undefined;
      return runtime.references;
    },
    async frame(request, projectPath) {
      if (disposing || active) throw new ViewportError('BLENDER_BUSY', '当前工作区的 Blender 视口正在处理请求。', 409);
      active = render(request, projectPath);
      try {
        return await active;
      } finally {
        active = undefined;
      }
    },
    dispose() {
      lifetime.abort();
      disposing ??= (async () => {
        await active?.catch(() => {});
        await stop();
      })();
      return disposing;
    },
  };
}
