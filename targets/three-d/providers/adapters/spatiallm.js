import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { SPATIALLM_MANIFEST } from '../manifests.js';
import { ProviderError } from '../contracts.js';
import { assertArtifactAccess } from '../artifacts.js';
import { createLocalVisionAdapter } from './moge3.js';

function validSource(ref, source, scope) {
  try {
    if (!source?.manifest || !scope) return false;
    assertArtifactAccess(source.manifest, scope);
    return source.manifest.artifactId === ref.artifactId && source.manifest.sha256 === ref.sha256
      && source.manifest.kind === 'pointCloud' && source.manifest.units === 'm'
      && source.manifest.coordinateFrame === 'world-z-up'
      && source.axisUp === 'z' && source.axisAligned === true
      && path.extname(source.path ?? '').toLowerCase() === '.ply';
  } catch { return false; }
}

// InputRef is a closed schema (ID+digest only). Type/units/axes come from the
// caller-authorized ArtifactStore metadata, never extra ad-hoc InputRef fields.
// Pass this synchronous callback to CapabilityResolver.resolve({validateInput}).
export function createInputValidator({ lookupInput, scope } = {}) {
  return (ref, context) => context?.taskId === scope?.taskId
    && typeof lookupInput === 'function' && validSource(ref, lookupInput(ref, scope), scope);
}
export const createSpatialLMInputValidator = createInputValidator;

export function createSpatialLMAdapter(options = {}) {
  const models = options.modelsRoot ?? process.env.DSH_BLENDER_MODELS_ROOT;
  const engines = options.enginesRoot ?? process.env.DSH_BLENDER_ENGINES_ROOT;
  const enginePath = options.enginePath ?? (engines ? path.join(engines, 'SpatialLM') : undefined);
  const weightsPath = options.weightsPath ?? (models ? path.join(models, 'spatiallm-1.1-qwen-0.5b') : undefined);
  const resolveInput = async (ref, scope) => {
    const source = await options.resolveInput?.(ref, scope);
    if (!validSource(ref, source, scope)) throw new ProviderError('PRIVACY_POLICY_DENIED', 'spatiallm-pointcloud-metric-z-up-axis-aligned-required');
    return source;
  };
  const adapter = createLocalVisionAdapter({
    manifest: SPATIALLM_MANIFEST, workerPath: fileURLToPath(new URL('../workers/spatiallm_worker.py', import.meta.url)),
    dependencyModules: ['torch', 'numpy', 'spatiallm', 'flash_attn', 'torch_scatter'],
    inputExtensions: ['.ply'], coordinateFrame: 'world-z-up', units: 'm',
    ...options, weightsPath, resolveInput,
    pythonPaths: options.pythonPaths ?? [enginePath].filter(Boolean),
  });
  const withMetadata = args => ({ ...args, config: { ...args.config, axisUp: 'z', axisAligned: true, inputUnit: 'm' } });
  return Object.freeze({ ...adapter,
    preflight: args => adapter.preflight(withMetadata(args)),
    execute: args => adapter.execute(withMetadata(args)),
  });
}
