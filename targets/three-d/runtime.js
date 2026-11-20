import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { constants } from 'node:fs';
import { access, mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { delimiter, isAbsolute, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createInterface } from 'node:readline';

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

async function executable(override, name) {
  const paths = (process.env.PATH || '').split(delimiter).filter(isAbsolute).map((path) => join(path, name));
  paths.push(join(homedir(), '.local', 'bin', name));
  if (name === 'blender' && !override) {
    const root = join(homedir(), 'opt');
    const dirs = await readdir(root).catch(() => []);
    paths.push(...dirs.filter((dir) => /^blender-\d/.test(dir))
      .sort(new Intl.Collator('en', { numeric: true }).compare).reverse().map((dir) => join(root, dir, name)));
  }
  for (const path of override ? [override] : paths) {
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

export function createBlenderViewport() {
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
    if (process.platform !== 'linux') {
      throw new ViewportError('BLENDER_PLATFORM_UNSUPPORTED', 'Blender 视口目前需要 Linux 与 Xvfb。', 503);
    }
    const [xvfb, blender] = await Promise.all([
      executable(process.env.DSH_UI_TESTING_XVFB, 'Xvfb'),
      executable(process.env.DSH_UI_TESTING_BLENDER, 'blender'),
    ]);
    const root = await mkdtemp(join(tmpdir(), 'dsh-blender-viewport-'));
    const frame = join(root, 'frame.png');
    const authority = join(root, 'authority');
    runtime = { root, frame };
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
    const args = ['--factory-startup', '--disable-autoexec', '-noaudio', '-t', '4', '-p', '0', '0', ...SIZE.map(String)];
    const project = process.env.DSH_UI_TESTING_BLEND_FILE;
    if (project) {
      const info = isAbsolute(project) && /\.blend$/i.test(project) && await stat(project).catch(() => null);
      if (!info?.isFile()) throw new ViewportError('BLENDER_PROJECT_INVALID', 'Blender 工程须为可读的绝对 .blend 路径。', 503);
      args.push(project);
    }
    signal.throwIfAborted();
    const env = { ...process.env, DISPLAY: ':' + display, XAUTHORITY: authority, WAYLAND_DISPLAY: '',
      LIBGL_ALWAYS_SOFTWARE: process.env.LIBGL_ALWAYS_SOFTWARE || '1',
      LP_NUM_THREADS: process.env.LP_NUM_THREADS || '4' };
    runtime.blender = startProcess(blender, [...args, '--python', SCRIPT, '--', frame], {
      cwd: root, env, stdio: ['pipe', 'pipe', 'pipe'],
    });
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
