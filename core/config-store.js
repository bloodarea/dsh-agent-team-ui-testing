/**
 * Durable config store (M0 §4.1).
 *
 * - The directory is supplied by the caller; no machine path is hardcoded.
 * - Load is synchronous and idempotent. A corrupt file is backed up and replaced by defaults
 *   instead of crashing the host.
 * - Writes use revision CAS + atomic tmp/rename, mode 0600 (directory 0700).
 * - Without a writable directory the store still loads in memory mode but every write throws.
 */
import { randomBytes } from 'node:crypto';
import {
  chmodSync,
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { DEFAULT_CONFIG, normalizeConfig, resolveSnapshot, validatePatch } from './config.js';
import { ERROR_CODES } from './contracts.js';
import { AdapterError } from './errors.js';
import { workspaceKeyOf } from './identity.js';

const SLEEP_BUFFER = new Int32Array(new SharedArrayBuffer(4));

function sleepSync(ms) {
  if (ms > 0) Atomics.wait(SLEEP_BUFFER, 0, 0, ms);
}

function clone(value) {
  return structuredClone(value);
}

function requireString(value, field) {
  if (typeof value !== 'string' || value.length === 0) {
    throw new AdapterError(ERROR_CODES.INVALID_ARGUMENT, `${field} must be a non-empty string`, {
      details: { field },
    });
  }
  return value;
}

function applyGlobalPatch(config, patch) {
  if (patch.environment !== undefined) config.global.environment = patch.environment;
  if (patch.enabledEnvironments !== undefined) {
    config.global.enabledEnvironments = [...patch.enabledEnvironments];
  }
  if (patch.environments !== undefined) {
    for (const [environment, entry] of Object.entries(patch.environments)) {
      config.global.environments[environment] = {
        ...(config.global.environments[environment] ?? {}),
        ...clone(entry),
      };
    }
  }
  if (patch.targetId !== undefined) {
    const environment = patch.environment ?? config.global.environment;
    config.global.environments[environment] = {
      ...(config.global.environments[environment] ?? {}),
      targetId: patch.targetId,
    };
  }
}

function applyWorkspacePatch(config, workspaceKey, patch) {
  const key = requireString(workspaceKey, 'workspaceKey');
  const workspace = config.workspaces[key] ?? {};
  config.workspaces[key] = workspace;
  if (patch.environment !== undefined) workspace.environment = patch.environment;
  if (patch.enabledEnvironments !== undefined) {
    workspace.enabledEnvironments = [...patch.enabledEnvironments];
  }
  if (patch.environments !== undefined) {
    workspace.environments = workspace.environments ?? {};
    for (const [environment, entry] of Object.entries(patch.environments)) {
      workspace.environments[environment] = {
        ...(workspace.environments[environment] ?? {}),
        ...clone(entry),
      };
    }
  }
  if (patch.targetId !== undefined) {
    const environment = patch.environment ?? workspace.environment ?? config.global.environment;
    workspace.environments = workspace.environments ?? {};
    workspace.environments[environment] = {
      ...(workspace.environments[environment] ?? {}),
      targetId: patch.targetId,
    };
  }
}

function applySessionPatch(config, agentId, patch) {
  const key = requireString(agentId, 'agentId');
  const session = config.sessions[key] ?? {};
  config.sessions[key] = session;
  if (patch.environment !== undefined) session.environment = patch.environment;
  if (patch.targetId !== undefined) session.targetId = patch.targetId;
}

/**
 * Host-owned, revisioned config store.
 */
export class ConfigStore {
  /**
   * @param {{dir:string, log?:{warn?:Function,info?:Function,error?:Function},
   *   now?:Function|number, allowTestEnvironments?:boolean, file?:string,
   *   lockFile?:string, lockTimeoutMs?:number, lockPollMs?:number}} input
   */
  constructor({
    dir,
    log = null,
    now = Date.now,
    allowTestEnvironments = false,
    file = 'config.json',
    lockFile = 'config.lock',
    lockTimeoutMs = 2000,
    lockPollMs = 20,
  } = {}) {
    this.dir = requireString(dir, 'dir');
    this.file = requireString(file, 'file');
    this.lockFile = requireString(lockFile, 'lockFile');
    this.path = join(this.dir, this.file);
    this.lockPath = join(this.dir, this.lockFile);
    if (typeof lockTimeoutMs !== 'number' || !Number.isFinite(lockTimeoutMs) || lockTimeoutMs < 0) {
      throw new AdapterError(ERROR_CODES.INVALID_ARGUMENT, 'lockTimeoutMs must be a non-negative number', {
        details: { field: 'lockTimeoutMs' },
      });
    }
    this.lockTimeoutMs = lockTimeoutMs;
    this.lockPollMs = Number.isFinite(lockPollMs) && lockPollMs > 0 ? lockPollMs : 20;
    this.allowTestEnvironments = allowTestEnvironments === true;
    this.log = log;
    this._now = typeof now === 'function' ? now : () => now;
    this._config = null;
    this._loaded = false;
    this._writable = false;
    this._loadError = null;
    this._subscribers = new Set();
    this._disposed = false;
    this._writeSeq = 0;
    this._snapshotCache = new Map();
  }

  _warn(message, details) {
    try {
      this.log?.warn?.(message, details);
    } catch {
      // Logging must never break config loading.
    }
  }

  /**
   * Load (once) from disk. Never throws for missing/unreadable/corrupt storage; those cases fall
   * back to defaults and are recorded in `loadError`.
   *
   * @returns {ConfigStore} this
   */
  load() {
    if (this._loaded) return this;
    this._loaded = true;

    try {
      mkdirSync(this.dir, { recursive: true, mode: 0o700 });
      try {
        chmodSync(this.dir, 0o700);
      } catch {
        // Best effort: an existing directory may not allow chmod; write failures still surface.
      }
      this._writable = true;
    } catch (error) {
      this._writable = false;
      this._loadError = { reason: 'config-dir-unavailable', message: String(error?.message ?? error) };
      this._warn('config directory unavailable; running in memory mode', { dir: this.dir });
      this._config = clone(DEFAULT_CONFIG);
      return this;
    }

    let text;
    try {
      text = readFileSync(this.path, 'utf8');
    } catch (error) {
      if (error?.code === 'ENOENT') {
        this._config = clone(DEFAULT_CONFIG);
        return this;
      }
      this._writable = false;
      this._loadError = { reason: 'config-read-failed', message: String(error?.message ?? error) };
      this._warn('config read failed; running in memory mode', { path: this.path });
      this._config = clone(DEFAULT_CONFIG);
      return this;
    }

    try {
      this._config = normalizeConfig(JSON.parse(text));
    } catch (error) {
      this._config = clone(DEFAULT_CONFIG);
      this._recoverCorrupt(error);
    }
    return this;
  }

  _recoverCorrupt(error) {
    const at = Number(this._now());
    let backupPath = `${this.path}.corrupt-${Number.isFinite(at) ? at : 0}`;
    let suffix = 0;
    while (existsSync(backupPath)) {
      suffix += 1;
      backupPath = `${this.path}.corrupt-${Number.isFinite(at) ? at : 0}-${suffix}`;
    }
    try {
      renameSync(this.path, backupPath);
    } catch (renameError) {
      backupPath = null;
      this._warn('could not back up corrupt config file', {
        path: this.path,
        message: String(renameError?.message ?? renameError),
      });
    }
    this._loadError = {
      reason: 'config-corrupt',
      message: String(error?.message ?? error),
      backupPath,
      at: Number.isFinite(at) ? at : null,
    };
    this._warn('config file was corrupt; restored defaults', {
      path: this.path,
      backupPath,
    });
  }

  /**
   * Adopt a newer on-disk revision written by another store instance.
   *
   * CAS against a stale in-memory revision would silently overwrite a concurrent write; refresh
   * first so the conflict is detected. Missing/corrupt files keep the in-memory config.
   */
  _refreshFromDisk() {
    if (!this._writable) return;
    try {
      const disk = normalizeConfig(JSON.parse(readFileSync(this.path, 'utf8')));
      if (disk.revision !== this._config.revision) this._config = disk;
    } catch {
      // Keep the in-memory config; the next successful write persists a fresh revision.
    }
  }

  /** Current config as a deep copy. Loads on first use. */
  getConfig() {
    this.load();
    return clone(this._config);
  }

  /** Diagnostic for the last load problem (null when the file was fine). */
  get loadError() {
    return this._loadError === null ? null : clone(this._loadError);
  }

  /**
   * Apply a CAS-guarded patch and persist it atomically under a cross-process lock.
   *
   * The lock file is `<dir>/config.lock`. Waiting is bounded (default 2000 ms); a timeout throws
   * CONFIG_CONFLICT without touching the config file. Inside the lock the revision is re-read from
   * disk before CAS, so two store instances/processes cannot silently overwrite each other.
   *
   * @param {{expectedRevision?:number, scope:'global'|'workspace'|'session', patch:object,
   *   workspaceKey?:string, agentId?:string}} input
   * @returns {{revision:number, config:object}}
   */
  write({ expectedRevision, scope, patch, workspaceKey, agentId } = {}) {
    this.load();
    if (!this._writable) {
      throw new AdapterError(ERROR_CODES.OUTPUT_WRITE_FAILED, 'config directory is not writable; memory mode cannot persist', {
        details: { path: this.path, loadError: this._loadError },
      });
    }
    const normalizedPatch = validatePatch(
      { scope, patch },
      { allowTestEnvironments: this.allowTestEnvironments },
    );
    return this._withLock(() => this._writeLocked({
      expectedRevision,
      scope,
      patch: normalizedPatch,
      workspaceKey,
      agentId,
    }));
  }

  _writeLocked({ expectedRevision, scope, patch, workspaceKey, agentId }) {
    this._refreshFromDisk();
    if (expectedRevision !== undefined && expectedRevision !== null) {
      if (!Number.isInteger(expectedRevision) || expectedRevision < 0) {
        throw new AdapterError(ERROR_CODES.CONFIG_INVALID, 'expectedRevision must be a non-negative integer', {
          details: { field: 'expectedRevision', value: String(expectedRevision) },
        });
      }
      if (expectedRevision !== this._config.revision) {
        throw new AdapterError(ERROR_CODES.CONFIG_CONFLICT, 'config revision conflict', {
          details: { expected: expectedRevision, actual: this._config.revision },
        });
      }
    }

    const next = clone(this._config);
    if (scope === 'global') {
      applyGlobalPatch(next, patch);
    } else if (scope === 'workspace') {
      applyWorkspacePatch(next, workspaceKey, patch);
    } else {
      applySessionPatch(next, agentId, patch);
    }
    next.revision = this._config.revision + 1;

    // normalizeConfig is the final structural gate; it may throw CONFIG_INVALID before any I/O.
    const normalizedNext = normalizeConfig(next);
    this._persist(normalizedNext);
    this._config = normalizedNext;

    const notification = { revision: normalizedNext.revision, config: clone(normalizedNext) };
    for (const subscriber of this._subscribers) {
      try {
        subscriber(notification);
      } catch (error) {
        this._warn('config subscriber threw', { message: String(error?.message ?? error) });
      }
    }
    return { revision: normalizedNext.revision, config: clone(normalizedNext) };
  }

  _withLock(fn) {
    this._acquireLock();
    try {
      return fn();
    } finally {
      this._releaseLock();
    }
  }

  _acquireLock() {
    const deadline = Date.now() + this.lockTimeoutMs;
    for (;;) {
      try {
        const fd = openSync(this.lockPath, 'wx', 0o600);
        try {
          writeFileSync(fd, String(process.pid));
        } catch {
          // Lock ownership is the file's existence, not its contents.
        }
        closeSync(fd);
        return;
      } catch (error) {
        if (error?.code !== 'EEXIST') {
          throw new AdapterError(ERROR_CODES.OUTPUT_WRITE_FAILED, 'failed to acquire the config lock', {
            details: { lockPath: this.lockPath, message: String(error?.message ?? error) },
            cause: error,
          });
        }
        const remaining = deadline - Date.now();
        if (remaining <= 0) {
          throw new AdapterError(ERROR_CODES.CONFIG_CONFLICT, 'timed out waiting for the config lock', {
            details: { lockPath: this.lockPath, timeoutMs: this.lockTimeoutMs },
          });
        }
        sleepSync(Math.min(this.lockPollMs, remaining));
      }
    }
  }

  _releaseLock() {
    try {
      unlinkSync(this.lockPath);
    } catch {
      // Already released (or never created).
    }
  }

  _persist(config) {
    const tmp = join(
      this.dir,
      `.${this.file}.${process.pid}.${++this._writeSeq}.${randomBytes(4).toString('hex')}.tmp`,
    );
    const text = `${JSON.stringify(config, null, 2)}\n`;
    try {
      writeFileSync(tmp, text, { encoding: 'utf8', mode: 0o600 });
      try {
        chmodSync(tmp, 0o600);
      } catch {
        // mode from writeFileSync is already 0600 for a newly created file.
      }
      renameSync(tmp, this.path);
    } catch (error) {
      try {
        unlinkSync(tmp);
      } catch {
        // Nothing to clean up.
      }
      throw new AdapterError(ERROR_CODES.OUTPUT_WRITE_FAILED, 'failed to persist config atomically', {
        details: { path: this.path, message: String(error?.message ?? error) },
        cause: error,
      });
    }
  }

  /**
   * Convenience wrapper over `write` for selecting an environment/target.
   *
   * Workspace scope accepts either an explicit `workspaceKey` or `{agent, cwd, workspaceId}` and
   * derives the key through `workspaceKeyOf`, so config buckets and runtime entries cannot drift.
   *
   * @param {{scope?:'global'|'workspace'|'session', environment?:string, targetId?:string|null,
   *   agentId?:string, workspaceKey?:string, expectedRevision?:number, agent?:object,
   *   cwd?:string, workspaceId?:string}} input
   */
  select({
    scope = 'session',
    environment,
    targetId,
    agentId,
    workspaceKey,
    expectedRevision,
    agent = null,
    cwd = null,
    workspaceId = null,
  } = {}) {
    this.load();
    const resolvedWorkspaceKey = workspaceKey ?? workspaceKeyOf({ agent, cwd, workspaceId });
    const patch = {};
    if (environment !== undefined) patch.environment = environment;
    if (targetId !== undefined) {
      if (scope === 'session') {
        patch.targetId = targetId;
      } else {
        const selected = environment ?? (scope === 'workspace'
          ? (this._config.workspaces?.[workspaceKey]?.environment ?? this._config.global.environment)
          : this._config.global.environment);
        patch.environments = { [selected]: { targetId } };
      }
    }
    if (Object.keys(patch).length === 0) {
      throw new AdapterError(ERROR_CODES.CONFIG_INVALID, 'select requires environment or targetId', {
        details: { scope },
      });
    }
    return this.write({ expectedRevision, scope, patch, workspaceKey: resolvedWorkspaceKey, agentId });
  }

  /**
   * Resolve a snapshot and memoize it for the current config revision (A11).
   *
   * One step must see one immutable snapshot: two reads inside the same revision return the *same*
   * frozen object, so admission, schema declaration, Skill discovery and execution cannot observe
   * different capability lists. A config write bumps `revision`, which yields a new key and a new
   * object — the change is then visible to every reader at once instead of per-reader.
   */
  _memoized(key, resolve) {
    const cacheKey = `${this._config.revision}|${key}`;
    const cached = this._snapshotCache.get(cacheKey);
    if (cached !== undefined) return cached;
    const snapshot = resolve();
    // Keep the cache bounded: a long-lived Host may resolve many agents across many revisions.
    if (this._snapshotCache.size > 256) this._snapshotCache.clear();
    this._snapshotCache.set(cacheKey, snapshot);
    return snapshot;
  }

  /** Resolve the snapshot for a DSH agent (workspace key from workspaceId or realpath(cwd)). */
  resolveForAgent(agent) {
    this.load();
    const workspaceKey = workspaceKeyOf({ agent });
    const agentId = agent?.id ?? agent?.sessionId ?? null;
    const parent = agent?.session?.header?.parentSession ?? null;
    return this._memoized(`agent:${String(agentId)}:${String(parent)}:${String(workspaceKey)}`, () => resolveSnapshot(
      this._config,
      { agent, workspaceKey },
      { allowTestEnvironments: this.allowTestEnvironments },
    ));
  }

  /** Resolve the snapshot for a generic scope ({id|sessionId, workspaceId, cwd}). */
  resolveForScope(scope) {
    this.load();
    const sessionId = scope?.id ?? scope?.sessionId ?? null;
    const cwd = scope?.cwd;
    const agent = {
      id: typeof sessionId === 'string' ? sessionId : null,
      session: { header: { cwd: typeof cwd === 'string' ? cwd : null } },
    };
    const workspaceKey = workspaceKeyOf({ cwd, workspaceId: scope?.workspaceId });
    return this._memoized(`scope:${String(sessionId)}:${String(cwd)}:${String(workspaceKey)}`, () => resolveSnapshot(
      this._config,
      { agent, workspaceKey },
      { allowTestEnvironments: this.allowTestEnvironments },
    ));
  }

  /** Subscribe to successful writes. Returns a disposer. */
  subscribe(fn) {
    if (typeof fn !== 'function') {
      throw new AdapterError(ERROR_CODES.INVALID_ARGUMENT, 'subscriber must be a function', {
        details: { field: 'fn' },
      });
    }
    this._subscribers.add(fn);
    return () => {
      this._subscribers.delete(fn);
    };
  }

  /** Drop subscribers. Idempotent. */
  dispose() {
    this._subscribers.clear();
    this._snapshotCache.clear();
    this._disposed = true;
  }
}
