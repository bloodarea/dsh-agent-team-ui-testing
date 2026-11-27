import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { SHARP_MANIFEST } from '../manifests.js';
import { createLocalVisionAdapter } from './moge3.js';

export function createSharpAdapter(options = {}) {
  const weightsPath = options.weightsPath ?? (process.env.DSH_BLENDER_MODELS_ROOT ? path.join(process.env.DSH_BLENDER_MODELS_ROOT, 'sharp/sharp_2572gikvuh.pt') : undefined);
  const pythonPaths = options.pythonPaths ?? (process.env.DSH_SHARP_SOURCE ? [path.join(process.env.DSH_SHARP_SOURCE, 'src')] : []);
  return createLocalVisionAdapter({ manifest: SHARP_MANIFEST, workerPath: fileURLToPath(new URL('../workers/sharp_worker.py', import.meta.url)), dependencyModules: ['sharp', 'torch', 'numpy', 'PIL', 'plyfile'], ...options, weightsPath, pythonPaths });
}
