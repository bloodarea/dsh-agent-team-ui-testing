// Protocol fixture for process/integrity tests; never used for model quality evidence.
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import path from 'node:path';
const args = process.argv.slice(2);
const req = JSON.parse(readFileSync(args[args.indexOf('--request') + 1], 'utf8'));
const outputPath = args[args.indexOf('--output') + 1];
const mode = req.config.fixture;
if (mode === 'tree') {
  const child = spawn(process.execPath, ['-e', 'setTimeout(()=>{},120000)'], { stdio: 'ignore' });
  writeFileSync(path.join(req.workDir, 'child.pid'), String(child.pid));
  setTimeout(() => {}, 120000);
} else if (mode === 'flood') { process.stdout.write('x'.repeat(200000)); setTimeout(() => {}, 120000); }
else if (mode?.startsWith('fail:')) { process.stderr.write(mode.slice(5) + ': fixture failure\n' + 'z'.repeat(10000)); process.exitCode = 1; }
else {
  const bytes = Buffer.from('protocol-fixture-not-model-output');
  mkdirSync(path.join(req.workDir, 'artifacts'), { recursive: true });
  writeFileSync(path.join(req.workDir, 'artifacts/depth.npy'), bytes);
  const result = { ok: true, providerId: req.providerId, capabilityId: req.capabilityId, modelVersion: 'fixture@1', artifacts: [{ kind: mode === 'wrong-kind' ? 'mesh' : 'relativeDepthRaster', path: mode === 'escape' ? '../outside.npy' : 'artifacts/depth.npy', mediaType: 'application/x-npy', bytes: bytes.length, sha256: mode === 'tamper' ? '0'.repeat(64) : createHash('sha256').update(bytes).digest('hex'), width: 1, height: 1, channels: 1, unit: null }], metrics: { validPixelRatio: 1 }, resources: { wallMs: 1, peakRamBytes: null, peakVramBytes: null, coldStartMs: null }, limitations: ['protocol-fixture-only'] };
  writeFileSync(outputPath, JSON.stringify(result));
  console.log(JSON.stringify({ ok: true }));
}
