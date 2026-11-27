import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough, Writable } from 'node:stream';
import { createBlenderViewport } from '../../targets/three-d/runtime.js';

let pid = 4000;
const newline = String.fromCharCode(10);
const spawnProcess = (_path, args) => {
  const child = new EventEmitter();
  child.pid = ++pid;
  child.exitCode = null;
  child.signalCode = null;
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  let closed = false;
  child.close = () => {
    if (closed) return;
    closed = true;
    child.exitCode = 0;
    child.stdout.end();
    child.stderr.end();
    child.emit('close', 0, null);
  };
  child.kill = () => { child.close(); return true; };
  child.stdin = new Writable({
    write(chunk, _encoding, callback) {
      const input = String(chunk).trim();
      if (args.includes('-displayfd')) { callback(); return; }
      let request;
      try { request = JSON.parse(input); } catch { callback(); return; }
      const response = { channel: 'command-reply', id: request.id, targetId: request.targetId,
        generation: request.generation, runtimeGeneration: request.runtimeGeneration, ok: true,
        result: { op: request.op, version: '5.3.0', supportedOps: ['collection.ensure', 'object.ensure', 'object.parent', 'object.transform',
          'mesh.primitive', 'object.remove', 'material.ensure', 'material.assign'] } };
      setTimeout(() => child.stdout.write('DSH_VIEWPORT command ' + JSON.stringify(response) + newline), request.payload?.testDelay || 0);
      callback();
    },
  });
  if (args.includes('-displayfd')) setImmediate(() => child.stdout.write('99' + newline));
  else setImmediate(() => child.stdout.write('DSH_VIEWPORT 5.3.0' + newline));
  return child;
};

const execFile = (_path, _args, _options, callback) => setImmediate(() => callback(null, 'Blender 5.3.0', ''));
const pool = createBlenderViewport({ platform: 'linux', blenderExecutable: process.execPath,
  xvfbExecutable: process.execPath, execFile, spawnProcess, commandTimeoutMs: 40 });
const probe = await pool.probe();
assert.deepEqual({ version: probe.version, compatible: probe.compatible }, { version: '5.3.0', compatible: true });
assert.equal(pool.status('w').state, 'cold', 'probe/status must not launch the GUI process');
await assert.rejects(pool.command({ id: 'pre-hello', targetId: 'target-1', generation: 4,
  op: 'scene.query', payload: {} }, undefined, 'w'), (error) => error.code === 'BLENDER_HANDSHAKE_REQUIRED');

const hello = await pool.command({ id: 'c1', targetId: 'target-1', generation: 4, op: 'hello', payload: {} }, undefined, 'w');
assert.equal(hello.op, 'hello');
const running = pool.status('w');
assert.equal(running.state, 'running');
assert.equal(running.connection.connected, true);
assert.ok(running.pid > 0);
assert.match(running.internalToken, /^[a-f0-9]{48}$/u);
assert.equal(running.connection.runtimeGeneration.length, 32);
assert.equal(running.connection.hello.version, '5.3.0');
assert.equal(running.connection.hello.supportedOps.length, 8);

await assert.rejects(pool.command({ id: 'c2', targetId: 'target-1', generation: 4,
  op: 'scene.apply', payload: { ops: [{ opId: 'script.run', args: { source: 'print(1)' } }] } }, undefined, 'w'),
(error) => error.code === 'INVALID_ARGUMENT');

await assert.rejects(pool.command({ id: 'c3', targetId: 'target-1', generation: 4, op: 'scene.apply',
  payload: { testDelay: 140, ops: [{ opId: 'object.transform', args: {} }] } }, undefined, 'w'),
(error) => error.code === 'BLENDER_COMMAND_UNKNOWN' && error.effectState === 'unknown'
  && error.retryable === false && /禁止自动重放/u.test(error.message));
assert.equal(pool.status('w').pid, running.pid, 'a wait timeout must not replace/kill the shared process');
assert.equal(pool.status('w').busy, true, 'late reply remains serialized behind the active command');
await new Promise((resolve) => setTimeout(resolve, 180));
assert.equal(pool.status('w').busy, false);
assert.equal((await pool.command({ id: 'c4', targetId: 'target-1', generation: 4,
  runtimeGeneration: running.connection.runtimeGeneration, op: 'hello', payload: {} }, undefined, 'w')).op, 'hello');
await pool.release('w');
console.log('PASS: cold probe/status, shared-pool command, envelope echo, closed ops, unknown timeout without process termination');
