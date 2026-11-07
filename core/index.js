/**
 * Public surface of the cross-environment core.
 *
 * Integration code imports from here; `core/` never imports index.js, targets/, browser-safety.js
 * or any platform implementation. Every symbol below is a pure function, frozen data, or a class
 * whose side effects are explicit (ConfigStore file I/O, AdapterRegistry.dispose).
 */
export * from './contracts.js';
export * from './errors.js';
export * from './identity.js';
export * from './geometry.js';
export * from './clock.js';
export * from './evidence.js';
export * from './config.js';
export * from './config-store.js';
export * from './registry.js';
export * from './readiness.js';
// P0 neutral models live in core/p0.js (separate write scope); the barrel exposes them so
// adapters/providers have one import surface. No symbol names collide with the modules above.
export * from './p0.js';
