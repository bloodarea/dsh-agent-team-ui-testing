export { SpecError, JSON_LIMITS, parseStrictJson, canonicalize, hashJson, sha256, cloneJson, pointerTokens, getPointer, setPointer } from './json.js';
export { SCENE_SCHEMA_ID, COLLECTIONS, collectClaimSlots, claimValues, knownValue, validateScene, assertScene, validatePatch, assertPatch } from './validation.js';
export { ArtifactStore, artifactIdForSha256, validateArtifactReferences } from './artifact-store.js';
export { SpecStore } from './spec-store.js';
export { applyPatch } from './patch.js';
export { SpecBuilder, SceneBuilder, emptyScene, claimIdForTarget, buildPatch } from './builder.js';
export { FIRST_BATCH_OPS, compileScene, compileSceneSpec } from './compiler.js';
export { REFERENCE_LIMITS, normalizeReferenceImage, normalizeReferencePng, encodeRgbaPng, createRoiMapping, mapPointToSource, mapPointFromSource, mapRectToSource } from './reference.js';
