import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile as execFileCallback } from 'node:child_process';
import { createHash } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { PassThrough, Writable } from 'node:stream';
import { promisify } from 'node:util';
import { createBlenderViewport } from '../../targets/three-d/runtime.js';
import { createBlenderCapture } from '../../targets/three-d/tools.js';
import { encodeRgbaPng } from '../../targets/three-d/spec/index.js';

const size = [960, 540];
// Test-only fixture bytes: the production capture must still read Blender's PNG.
const png = encodeRgbaPng(...size, new Uint8Array(size[0] * size[1] * 4).fill(255));
const supportedOps = ['collection.ensure', 'object.ensure', 'object.parent', 'object.transform',
  'mesh.primitive', 'object.remove', 'material.ensure', 'material.assign'];
let pid = 17000;

function fixture(t, response, bytes = png) {
  const received = []; const spawned = [];
  const spawnProcess = (_executable, args) => {
    spawned.push(args);
    const child = new EventEmitter();
    child.pid = ++pid; child.exitCode = null; child.signalCode = null;
    child.stdout = new PassThrough(); child.stderr = new PassThrough();
    let closed = false;
    child.kill = () => {
      if (closed) return true;
      closed = true; child.exitCode = 0;
      child.stdout.end(); child.stderr.end(); child.emit('close', 0, null);
      return true;
    };
    child.stdin = new Writable({
      write(chunk, _encoding, callback) {
        const request = JSON.parse(String(chunk));
        received.push(request);
        if (request.channel === 'command') {
          const reply = { channel: 'command-reply', id: request.id, targetId: request.targetId,
            generation: request.generation, runtimeGeneration: request.runtimeGeneration,
            ok: true, result: { version: '5.3.0', supportedOps } };
          setImmediate(() => child.stdout.write(`DSH_VIEWPORT command ${JSON.stringify(reply)}\n`));
          callback(); return;
        }
        const framePath = args[args.indexOf('--') + 1];
        writeFile(framePath, bytes).then(() => {
          child.stdout.write(`DSH_VIEWPORT ${typeof response === 'function' ? response(request) : response}\n`);
          callback();
        }, callback);
      },
    });
    if (args.includes('-displayfd')) setImmediate(() => child.stdout.write('99\n'));
    else setImmediate(() => child.stdout.write('DSH_VIEWPORT 5.3.0\n'));
    return child;
  };
  const pool = createBlenderViewport({ platform: 'linux', blenderExecutable: process.execPath,
    xvfbExecutable: process.execPath, spawnProcess });
  t.after(() => pool.dispose());
  const signal = AbortSignal.timeout(30000);
  const frame = request => pool.frame(request, signal, 'workspace:capture-live');
  return { pool, received, spawned, signal, frame };
}

for (const [status, succeeds] of [['frame 0 0 960 540', true], ['error', false], ['frame', false]]) {
  test(`fake channel maps ${JSON.stringify(status)} without hiding malformed frames`, async t => {
    const f = fixture(t, status);
    const operation = f.frame({ input: [], size, editors: [] });
    if (succeeds) {
      const result = await operation;
      assert.deepEqual(result.png, png);
      assert.deepEqual(result.content, [0, 0, ...size]);
    } else {
      await assert.rejects(operation, error => error.code === 'BLENDER_FRAME_FAILED' && error.status === 502
        && error.message === 'Blender 未能生成 3D 视口图像。');
    }
  });
}

test('agentView named dimensions reach the Python wire as an ordered numeric size', async t => {
  // Mirror Python *request['size']: a dict iterates its keys, not its values.
  const f = fixture(t, request => Array.isArray(request.size)
    && request.size.every(Number.isInteger) ? 'frame 0 0 960 540 SOLID layout' : 'error');
  const context = { workspaceKey: 'workspace:capture-live', owner: 'capture-owner', assertCaptureScope: async () => {} };
  await f.pool.command({ id: 'hello', targetId: 'capture-target', generation: 1, op: 'hello', payload: {} },
    f.signal, context.workspaceKey);
  const originalPid = f.pool.status(context.workspaceKey).pid;
  let publications = 0;
  const capture = createBlenderCapture({ getViewport: () => f.pool, getArtifactStore: () => ({
    put: async request => {
      publications++;
      assert.equal(await request.authorizeStore({ ...request, action: 'artifact:write' }), true);
      assert.deepEqual(request.bytes, png);
      return { artifactId: 'artifact_capture', sha256: createHash('sha256').update(request.bytes).digest('hex') };
    },
  }) });
  const result = await capture({ source: 'agentView', targetId: 'capture-target', generation: 1 }, context, { signal: f.signal });
  assert.equal(result.width, size[0]); assert.equal(result.height, size[1]);
  assert.equal(publications, 1);
  assert.deepEqual(f.received.at(-1).size, size);
  assert.equal(f.pool.status(context.workspaceKey).pid, originalPid);
});

test('invalid named and array sizes fail closed before process startup or wire writes', async t => {
  const f = fixture(t, 'frame 0 0 960 540');
  for (const invalid of [undefined, null, {}, { width: 960 }, { height: 540 }, { width: '960', height: 540 },
    { width: 960.5, height: 540 }, { width: 199, height: 540 }, { width: 0, height: 540 },
    { width: 960, height: 8193 }, { width: 4096, height: 4096 }, [], [960], [960, 540, 1],
    ['960', 540], [960, null], [960.5, 540], [100, 100], [960, 4097], [4096, 4096]]) {
    await assert.rejects(f.frame({ input: [], size: invalid, editors: [] }),
      error => error.code === 'INVALID_ARGUMENT' && error.status === 400);
  }
  assert.deepEqual(f.spawned, []);
  assert.deepEqual(f.received, []);
});

test('named dimensions still enforce the actual PNG resolution', async t => {
  const f = fixture(t, 'frame 0 0 960 540');
  await assert.rejects(f.frame({ input: [], size: { width: 1000, height: 600 }, editors: [] }),
    error => error.code === 'BLENDER_FRAME_FAILED' && /实际分辨率/.test(error.message));
});

test('Blender background reproduces dict unpack failure in the actual capture_window method', {
  skip: !process.env.DSH_UI_TESTING_BLENDER,
}, async t => {
  const sourcePath = fileURLToPath(new URL('../../targets/three-d/viewport.py', import.meta.url));
  const editorPath = fileURLToPath(new URL('../../targets/three-d/editor_windows.py', import.meta.url));
  const source = String.raw`
import ast
import bpy
import json
import numpy as np
from pathlib import Path
import struct
import tempfile
import zlib

viewport_source = ast.parse(Path(${JSON.stringify(sourcePath)}).read_text(encoding='utf-8'))
viewport_class = next(node for node in viewport_source.body if isinstance(node, ast.ClassDef) and node.name == 'Viewport')
capture_method = next(node for node in viewport_class.body if isinstance(node, ast.FunctionDef) and node.name == 'capture_window')
namespace = dict(bpy=bpy, np=np, struct=struct, zlib=zlib)
helpers = ast.parse(Path(${JSON.stringify(editorPath)}).read_text(encoding='utf-8'))
for name in ('png_chunk', 'write_png'):
    helper = next(node for node in helpers.body if isinstance(node, ast.FunctionDef) and node.name == name)
    exec(compile(ast.Module(body=[helper], type_ignores=[]), '<actual-png-helper>', 'exec'), namespace)
exec(compile(ast.Module(body=[capture_method], type_ignores=[]), '<actual-capture-window>', 'exec'), namespace)

# No window or screenshot operator is used: Blender only writes a tiny source image.
image = bpy.data.images.new('capture-source', width=16, height=9)
image.pixels.foreach_set(np.ones(16 * 9 * 4, dtype=np.float32))
def screenshot(_window, path):
    image.save_render(str(path), scene=bpy.context.scene)
namespace['screenshot'] = screenshot
class Capture:
    window = None
    capture_window = namespace['capture_window']
with tempfile.TemporaryDirectory(prefix='blender-capture-live-') as root:
    namespace['output'] = Path(root) / 'frame.png'
    try:
        Capture().capture_window(*{'width': 960, 'height': 540})
        raise AssertionError('named dimensions unexpectedly worked')
    except TypeError as error:
        assert "'str' and 'int'" in str(error), str(error)
        failure = str(error)
    content = Capture().capture_window(*[960, 540])
    width, height = struct.unpack('>II', namespace['output'].read_bytes()[16:24])
    assert (width, height) == (960, 540), (width, height)
    assert content == (0, 0, 960, 540), content
    print('CAPTURE_PROOF ' + json.dumps(dict(failure=failure, dimensions=[width, height], content=content)))
bpy.data.images.remove(image)
`;
  const { stdout } = await promisify(execFileCallback)(process.env.DSH_UI_TESTING_BLENDER,
    ['--background', '--factory-startup', '--disable-autoexec', '--python-exit-code', '1', '--python-expr', source],
    { windowsHide: true, timeout: 60000, maxBuffer: 1024 * 1024 });
  const proof = JSON.parse(/^CAPTURE_PROOF (.+)$/m.exec(stdout)?.[1] ?? 'null');
  assert.ok(proof, stdout);
  assert.match(proof.failure, /'str' and 'int'/);
  assert.deepEqual(proof.dimensions, size);
  t.diagnostic(JSON.stringify(proof));
});
