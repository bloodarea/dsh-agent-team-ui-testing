import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { WORLDMIRROR_MANIFEST } from '../manifests.js';
import { createLocalVisionAdapter } from './moge3.js';

// Explicit opt-in factory. Importing it never probes Python, GPU or model files.
export function createWorldMirrorAdapter(options = {}) {
  const models = options.modelsRoot ?? process.env.DSH_BLENDER_MODELS_ROOT;
  const engines = options.enginesRoot ?? process.env.DSH_BLENDER_ENGINES_ROOT;
  const enginePath = options.enginePath ?? (engines ? path.join(engines, 'HY-World-2.0') : undefined);
  const weightsPath = options.weightsPath ?? (models ? path.join(models, 'hy-worldmirror-2.0/HY-WorldMirror-2.0/model.safetensors') : undefined);
  return createLocalVisionAdapter({
    manifest: WORLDMIRROR_MANIFEST,
    workerPath: fileURLToPath(new URL('../workers/worldmirror_worker.py', import.meta.url)),
    dependencyModules: ['torch', 'numpy', 'hyworld2.worldrecon.pipeline'],
    maxInputs: 32, coordinateFrame: 'model-relative-first-camera', units: 'relative', cameraUnits: 'pixel',
    ...options, weightsPath,
    pythonPaths: options.pythonPaths ?? [enginePath].filter(Boolean),
  });
}
