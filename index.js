/**
 * Host half of the UI testing plugin — the plugin entry and the public Host seams.
 *
 * This file keeps the decisions that belong to the Host: which tools exist and how they are
 * disclosed, config/scope resolution, identity (principal) resolution, HTTP authentication and
 * routing, readiness aggregation and diagnostics wiring, plus the environment registrations it
 * assembles by environment id. The Web platform implementation — browser process, page runtimes,
 * page registry, protocol tables — lives in `targets/web/host.js` and is reached only through
 * imports; the Web environment's registration entry lives in `targets/web/environment.js`.
 */
import { execFileSync, spawn } from 'node:child_process';
import { accessSync, constants as fsConstants, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync, unlinkSync } from 'node:fs';
import { mkdtemp, readFile, realpath, rm } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { delimiter, extname, isAbsolute, join, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash, randomUUID, timingSafeEqual } from 'node:crypto';
import http from 'node:http';
import https from 'node:https';
import net from 'node:net';
import { performance } from 'node:perf_hooks';

import { attachFramePush } from './frame-push.js';
import { resolveProviderExecutable, verifyProviderProduct } from './targets/web/adapter.js';
import { createWebToolSurface } from './targets/web/tools.js';
import { createWebInvoker } from './targets/web/invoke.js';
import { createWebRoutes } from './targets/web/routes.js';
import { createBlenderViewport, parseViewportRequest } from './targets/three-d/runtime.js';
import { createWebFramePush } from './targets/web/frame-transport.js';
import { createWebTransition } from './targets/web/transition.js';
import { BrowserError, Cdp, asBrowserError, checkAbort, abortable, redactUrl, redactText, validateTarget } from './browser-safety.js';
import {
  classifySelectWrite, normalizeSelectProjection, normalizeSelectWriteRequest,
  selectProbeDeclaration, selectWriteExpression,
} from './select-control.js';
import { openPageContextMenu, applyPageContextAction } from './context-menu.js';
import { createCrossEnvironment } from './integration/cross-environment.js';
import { createDiagnose } from './integration/diagnose.js';
import { createEnvironmentDirectory } from './core/environments.js';
import { createWebEnvironmentEntry } from './targets/web/environment.js';
import { createFakeEnvironmentEntry } from './targets/fake/environment.js';
import { createToolDisclosure, DISCOVERY_TOOL, DIAGNOSTIC_TOOLS as DISCLOSURE_DIAGNOSTIC_TOOLS } from './integration/tool-disclosure.js';
import { nowMonoMs } from './core/clock.js';
import { webProviderSupport } from './core/config.js';
import {
  ACTOR_SELECTION_KEY_PREFIX, AUTHORIZE_REASON, CONTROL_EVENT, CONTROL_STATE, EFFECT,
  PAGE_GROUP_KEY_PREFIX, PAGE_TARGET_KEY_PREFIX, PRINCIPAL_ROLE, PRINCIPAL_SOURCE, RESOURCE,
  applyControlTransition, authorize, authorizeAll, makeActorSelectionKey, makeControl,
  makeOwnership, makePageAccess, makePageGroupKey, makePageTargetKey, makePrincipal,
  operationEffect, parsePageGroupKey, projectPermissions,
} from './core/index.js';
import { defaultTabPrincipalResolver, resolvePrincipal } from './integration/tab-principal.js';
import {
  AGENT_HOLD_MS, ANNOTATION_AGENT_ACTIONS, ANNOTATION_AGENT_DEFAULT_STROKE, ANNOTATION_AGENT_MAX_SHAPES_PER_CALL, ANNOTATION_ERASE_DEFAULT_RADIUS, ANNOTATION_FOREGROUND_TTL_MS,
  ANNOTATION_LIMITS, ANNOTATION_SPACE, ANNOTATION_TYPES, ANNOTATION_VERSION, BrowserHost, CAPTURE_LIMITS,
  CAPTURE_PERSIST_RULES, CAPTURE_WARNING_VOCABULARY, CLOSED_HISTORY_LIMIT, DYNAMIC_ASSERTION_TYPES, DYNAMIC_BASES, DYNAMIC_DIRECTIONS,
  DYNAMIC_INTERNAL, DYNAMIC_LIMITS, DYNAMIC_MILESTONE, DYNAMIC_REGISTERED_TOOLS, DYNAMIC_SOURCES, DYNAMIC_TOOL_NAMES,
  FrameSource, HTTP_DEFAULTS, HTTP_LIMITS, HttpClient, IDLE_MS_DEFAULT, IMAGE_INLINE_BASE64_LIMIT,
  LEGACY_SCOPE, MAX_PAGES_DEFAULT, MODIFIER_BITS, NETWORK_LIMIT, NETWORK_SUBTARGETS, POPUP_NOTICES_LIMIT,
  PROFILE_RM_RETRIES, PROFILE_RM_RETRY_DELAY_MS, ROUTE_PREFIX, Runtime, RuntimeRegistry, T2_FORM_KINDS,
  T2_LIMITS, T4_LIMITS, TAB_ACQUIRE_TIMEOUT_DEFAULT_MS, TAB_ACQUIRE_TIMEOUT_MAX_MS, TAB_WAIT_POLL_DEFAULT_MS, TAB_WAIT_POLL_MAX_MS,
  TAB_WAIT_POLL_MIN_MS, TAB_WAIT_TIMEOUT_DEFAULT_MS, TAB_WAIT_TIMEOUT_MAX_MS, UNASSIGNED_SCOPE, UNSCOPED_ROOT, UNSCOPED_SCOPE_FACTORY,
  VIEWER_TTL_MS, VIEW_LIMITS, VIEW_PRESETS, WORKSPACE_ISOLATION_DEFAULTS, addCaptureWarning, annotationLimits,
  assertCaptureBudget, captureEnvRoot, captureRootFor, checkPixelSize, chromeCandidatePaths, createBaselineStore,
  createCaptureMapping, decodePng, delay, detectImageAnomaly, dynamicActionTarget, dynamicCapabilityConstraints,
  dynamicJsonProjection, dynamicMonoNow, elementPickRequest, ensureWebHostModules, envPositiveInt, expandViewPatch,
  expectedPixelSize, headerValue, inlineImageDelivery, inspectPng, losslessJson,
  network, normalizeAgentAnnotationCall, normalizeAnnotationPublish, normalizeCaptureRequest, normalizeModifiers, normalizeViewportRequest,
  pathScope, pickComputedStyle, pickElementAt, projectAttachment, projectCaptureMapping, publishCapture,
  readAnnotationBody, readComputedStyleFallback, resolveCapturePath, resolveChromeExecutable, sessionScope, t2BooleanField,
  t2IntegerField, t2ModifierList, t2NumberField, t2Object, t2RejectUnknown, t2StringField,
  vision, workspaceScope,
} from './targets/web/host.js';

// The Web runtime and its platform helpers stay importable from the plugin entry: this file is the
// assembly point, and existing hosts and tests import them from here.
export {
  BrowserHost, CAPTURE_WARNING_VOCABULARY, DYNAMIC_LIMITS, FrameSource, HttpClient, IMAGE_INLINE_BASE64_LIMIT,
  Runtime, RuntimeRegistry, WORKSPACE_ISOLATION_DEFAULTS, chromeCandidatePaths, inlineImageDelivery,
  pickComputedStyle, readComputedStyleFallback, resolveChromeExecutable,
} from './targets/web/host.js';
export { BrowserError, Cdp } from './browser-safety.js';

/**
 * Cordis service lookup (property form as a fallback).
 *
 * The page registry needs the native roster for a control transfer, but reading a Cordis context is
 * the Host's job: the registry receives this function instead of a context it would query itself.
 */
function hostService(ctx, name) {
  try {
    if (ctx && typeof ctx.get === 'function') {
      const value = ctx.get(name);
      if (value !== undefined) return value;
    }
  } catch { /* fall back to the property form */ }
  try { return ctx ? ctx[name] : undefined; } catch { return undefined; }
}

export const loadWebHostModules = ensureWebHostModules;
// Read-only diagnostic: did this host ever load the Web-only module chain?
export { webHostModuleFacts } from './targets/web/host.js';

export const inject = ['tools', 'webServer'];

/**
 * Chromium/Chrome executable discovery (contract §9.3).
 *
 * Nothing is resolved at module load: a deployment may mount the browser later, a test may set
 * `DSH_UI_TESTING_CHROME` after importing this module, and a missing browser must not make the
 * whole plugin fail to load. Resolution happens once, lazily, right before the spawn, and the
 * result is cached (keyed by the configured value, so changing the env var re-resolves).
 * Everything reported back is a path — the configuration never holds secrets.
 */

const SCOPE_HEADER_VERSION = 'x-ui-testing-scope-version';

const SCOPE_HEADER_SESSION = 'x-ui-testing-session-id';

const SCOPE_HEADER_SCOPE = 'x-ui-testing-scope';

const SCOPE_HEADER_BINDING = 'x-ui-testing-scope-binding';
/**
 * Optional hint for a session-scoped GUI request: `primary` means "render this workspace's primary
 * tab, do not apply the Agent session's selectedTab" (P0-E). The panel's own view is authoritative
 * for the panel; the Agent selection only routes tools. Only the literal `primary` is accepted and
 * only together with a sessionId — a binding already names its runtime.
 */

const SCOPE_HEADER_TAB = 'x-ui-testing-scope-tab';

const SCOPE_TAB_PRIMARY = 'primary';
/**
 * "This runtime is my selected tab and I am visible" (P0-D `browser_annotation`).
 *
 * Only the authenticated panel sends it, and only while it is displaying that tab — a selected
 * internal tab, its DSH seat visible, and the GUI page itself not hidden. It is a claim, not a
 * permission: the Host only turns it into a short freshness window, and `read` never needs it.
 */

const SCOPE_HEADER_FOREGROUND = 'x-ui-testing-gui-foreground';

const SCOPE_SPECIAL_VALUES = new Set(['recent', 'unassigned']);

function scopeToken(value, name) {
  if (typeof value !== 'string') return undefined;
  const text = value.trim();
  if (!text) return undefined;
  if (text.length > 256 || /[\u0000-\u001f\u007f]/u.test(text)) throw new BrowserError('SCOPE_INVALID', `${name} 不合法`);
  return text;
}

function scopeSpecial(value) {
  const text = String(value).trim().toLowerCase();
  if (!SCOPE_SPECIAL_VALUES.has(text)) throw new BrowserError('SCOPE_INVALID', `scope 只支持 recent/unassigned，收到 ${value}`);
  return { mode: text };
}

/** `x-ui-testing-scope-tab` / `tab=`: only the literal `primary`, only with a sessionId. */

/** `x-ui-testing-scope-tab` / `tab=`: only the literal `primary`, only with a sessionId. */
function scopeTabHint(value) {
  if (value === undefined || value === null || value === '') return undefined;
  if (String(value).trim().toLowerCase() !== SCOPE_TAB_PRIMARY) {
    throw new BrowserError('SCOPE_INVALID', `scope-tab 只支持 ${SCOPE_TAB_PRIMARY}，收到 ${value}`);
  }
  return SCOPE_TAB_PRIMARY;
}

/**
 * HTTP scope protocol. No scope headers at all = the old protocol (`legacy:default`); any scope
 * header without a protocol version, or two different identities in one request, is a 400.
 */

function parseHttpScope(req) {
  const headers = (req && req.headers) || {};
  const version = headerValue(headers, SCOPE_HEADER_VERSION);
  const sessionId = headerValue(headers, SCOPE_HEADER_SESSION);
  const special = headerValue(headers, SCOPE_HEADER_SCOPE);
  const binding = headerValue(headers, SCOPE_HEADER_BINDING);
  const tab = headerValue(headers, SCOPE_HEADER_TAB);
  const present = [version, sessionId, special, binding, tab].filter((value) => value !== undefined && value !== '');
  if (present.length === 0) return { mode: 'legacy' };
  if (version === undefined || version === '') throw new BrowserError('SCOPE_INVALID', `缺少 ${SCOPE_HEADER_VERSION}`);
  if (version !== '1') throw new BrowserError('SCOPE_INVALID', `不支持的 scope 版本：${version}`);
  const identities = [sessionId, special, binding].filter((value) => value !== undefined && value !== '');
  if (identities.length > 1) throw new BrowserError('SCOPE_INVALID', '同一请求只能给出一种 scope 身份（sessionId / scope / binding）');
  if (identities.length === 0) throw new BrowserError('SCOPE_INVALID', 'scopeVersion=1 必须给出 sessionId、scope 或 binding');
  const tabHint = scopeTabHint(tab);
  if (tabHint && !sessionId) throw new BrowserError('SCOPE_INVALID', 'scope-tab 只能与 sessionId 一起使用');
  if (binding) return { mode: 'binding', runtimeId: scopeToken(binding, 'binding') };
  if (special) return scopeSpecial(special);
  return { mode: 'session', sessionId: scopeToken(sessionId, 'sessionId'), tab: tabHint };
}

/** The WS query form of the same protocol: ?scopeVersion=1&sessionId=… / &scope=… / &binding=… */

/** The WS query form of the same protocol: ?scopeVersion=1&sessionId=… / &scope=… / &binding=… */
function parseScopeQuery(rawUrl) {
  let url;
  try { url = new URL(rawUrl || '/', 'http://localhost'); }
  catch { throw new BrowserError('SCOPE_INVALID', '非法的 WebSocket 地址'); }
  const version = url.searchParams.get('scopeVersion');
  const sessionId = url.searchParams.get('sessionId');
  const special = url.searchParams.get('scope');
  const binding = url.searchParams.get('binding');
  const tab = url.searchParams.get('tab');
  if (version === null) {
    if (sessionId !== null || special !== null || binding !== null || tab !== null) throw new BrowserError('SCOPE_INVALID', '缺少 scopeVersion');
    return { mode: 'legacy' };
  }
  if (version !== '1') throw new BrowserError('SCOPE_INVALID', `不支持的 scope 版本：${version}`);
  const identities = [sessionId, special, binding].filter((value) => value !== null && value !== '');
  if (identities.length > 1) throw new BrowserError('SCOPE_INVALID', '同一连接只能给出一种 scope 身份（sessionId / scope / binding）');
  if (identities.length === 0) throw new BrowserError('SCOPE_INVALID', 'scopeVersion=1 必须给出 sessionId、scope 或 binding');
  const tabHint = scopeTabHint(tab);
  if (tabHint && !sessionId) throw new BrowserError('SCOPE_INVALID', 'scope-tab 只能与 sessionId 一起使用');
  if (binding) return { mode: 'binding', runtimeId: scopeToken(binding, 'binding') };
  if (special) return scopeSpecial(special);
  return { mode: 'session', sessionId: scopeToken(sessionId, 'sessionId'), tab: tabHint };
}

/** Status for the workspace-isolation error taxonomy (everything else stays 500 for compat). */

/** Status for the workspace-isolation error taxonomy (everything else stays 500 for compat). */
function scopeHttpStatus(code) {
  switch (code) {
    // Optimistic-concurrency loss on the shared viewport (docs/viewport-control.md).
    case 'VIEWPORT_CONFLICT': return 409;
    case 'BUSY': return 409;
    case 'SCOPE_INVALID': return 400;
    case 'SCOPE_FORBIDDEN': return 403;
    case 'SCOPE_NOT_FOUND': return 404;
    case 'SCOPE_UNAVAILABLE': return 503;
    case 'RUNTIME_LIMIT': return 503;
    // Team/page access model (M2a, ruling §7.3). The HTTP surface must answer with the same code
    // the tool surface uses, otherwise a refused page write looks like a Host crash over HTTP.
    case 'TAB_FORBIDDEN': return 403;
    case 'TAB_NOT_FOUND': return 404;
    case 'TARGET_GONE': return 410;
    case 'TAB_CONTROL_CHANGED': return 409;
    case 'TAB_OWNERSHIP_STALE': return 409;
    case 'TAB_OBSERVATION_STALE': return 409;
    case 'TAB_LIMIT': return 409;
    case 'TAB_IDENTITY_UNAVAILABLE': return 503;
    case 'OBSERVATION_UNAVAILABLE': return 503;
    case 'TARGET_NOT_BOUND': return 400;
    case 'INVALID_ARGUMENT': return 400;
    default: return 500;
  }
}

/**
 * Codes that are *pre-dispatch refusals* and must never become a page's `lastError` (ruling §7.3).
 *
 * A page's lastError answers "what went wrong with this page". "You may not write it", "your
 * revision is stale" and "the budget is full" are answers about the *caller*, and writing them onto
 * the target would blame the page — and its owner — for somebody else's refusal.
 */

const NON_PAGE_ERROR_CODES = new Set([
  'TAB_FORBIDDEN', 'TAB_NOT_FOUND', 'TAB_CONTROL_CHANGED', 'TAB_OWNERSHIP_STALE',
  'TAB_OBSERVATION_STALE', 'TAB_IDENTITY_UNAVAILABLE', 'TAB_LIMIT', 'OBSERVATION_UNAVAILABLE',
  'RUNTIME_LIMIT', 'TARGET_NOT_BOUND', 'INVALID_ARGUMENT', 'SCOPE_FORBIDDEN', 'SCOPE_NOT_FOUND',
]);

async function resolveSessionScope(ctx, sessionId, { cwd, signal } = {}) {
  let dir = typeof cwd === 'string' && cwd ? cwd : undefined;
  let liveSession = false;
  if (!dir) {
    const sessions = hostService(ctx, 'sessions');
    if (sessions && typeof sessions.get === 'function') {
      let session;
      try { session = sessions.get(sessionId); }
      catch { throw new BrowserError('SCOPE_UNAVAILABLE', '会话服务读取失败', { scope: 'session' }); }
      if (session) {
        liveSession = true;
        const headerCwd = session.header && session.header.cwd;
        if (typeof headerCwd === 'string' && headerCwd) dir = headerCwd;
      }
    }
  }
  if (!dir) {
    const persistence = hostService(ctx, 'sessionPersistence');
    if (persistence && typeof persistence.stat === 'function') {
      let stat;
      try { stat = await persistence.stat(sessionId, signal ? { signal } : undefined); }
      catch (error) {
        if (signal?.aborted) throw new BrowserError('ABORTED', '操作已取消');
        throw new BrowserError('SCOPE_UNAVAILABLE', '会话存储读取失败', { scope: 'session' });
      }
      if (stat === undefined) {
        // `undefined` is the only "definitely absent" answer; a thrown error is a 503 above.
        if (!liveSession) throw new BrowserError('SCOPE_NOT_FOUND', '会话不存在', { scope: 'session' });
      } else {
        const headerCwd = stat && stat.header && stat.header.cwd;
        if (typeof headerCwd === 'string' && headerCwd) dir = headerCwd;
        else liveSession = true;
      }
    }
  }
  const registryService = hostService(ctx, 'workspaceRegistry');
  const rescueBySession = () => {
    if (!registryService || typeof registryService.list !== 'function') return undefined;
    let list;
    try { list = registryService.list(); }
    catch { throw new BrowserError('SCOPE_UNAVAILABLE', '工作区注册表读取失败', { scope: 'workspace' }); }
    if (!Array.isArray(list)) return undefined;
    const matches = list.filter((workspace) => workspace && typeof workspace.id === 'string'
      && Array.isArray(workspace.sessionIds) && workspace.sessionIds.includes(sessionId));
    return matches.length === 1 ? workspaceScope(matches[0].id) : undefined;
  };
  const missingPath = (error) => Boolean(error) && (error.code === 'ENOENT' || error.code === 'ENOTDIR');
  if (dir) {
    let canonical;
    try { canonical = await realpath(dir); }
    catch (error) {
      // ENOENT/ENOTDIR: the directory is gone -> membership rescue or a degraded scope.
      // EACCES/EIO/...: a storage/permission fault, never "unregistered directory".
      if (!missingPath(error)) throw new BrowserError('SCOPE_UNAVAILABLE', '工作目录不可读', { scope: 'path' });
      canonical = undefined;
    }
    if (canonical) {
      if (registryService && typeof registryService.resolveByPath === 'function') {
        let workspace;
        try {
          // DSH WorkspaceRegistry.resolveByPath returns Promise<Workspace | undefined>.
          workspace = await registryService.resolveByPath(canonical);
        } catch (error) {
          // A path removed between realpath() and the registry lookup is a missing directory,
          // not a registry fault: membership rescue first, then the degraded path scope (we still
          // hold the canonical spelling from realpath()).
          if (missingPath(error)) {
            const rescuedOnRace = rescueBySession();
            if (rescuedOnRace) return rescuedOnRace;
            return pathScope(canonical);
          }
          throw new BrowserError('SCOPE_UNAVAILABLE', '工作区注册表读取失败', { scope: 'workspace' });
        }
        if (workspace && typeof workspace.id === 'string' && workspace.id) return workspaceScope(workspace.id);
      }
      // Exact realpath equality only: a parent directory must never claim a nested workspace.
      const rescued = rescueBySession();
      if (rescued) return rescued;
      return pathScope(canonical);
    }
    const rescued = rescueBySession();
    if (rescued) return rescued;
  }
  if (!sessionId) return UNASSIGNED_SCOPE;
  return sessionScope(sessionId);
}

/**
 * The fake registry a host *without* `ctx.agents` gets (M2a).
 *
 * It can only ever confirm the exact object the host already attached to this execution, and it is
 * one stable instance so the resolver's `membershipRevision` does not churn merely because a fresh
 * adapter object was passed on every call. It is not a second identity source: nothing else may
 * write to it.
 */

const DEGRADED_AGENT_OBJECTS = new Map();

const DEGRADED_AGENT_REGISTRY = {
  get(id) { return DEGRADED_AGENT_OBJECTS.get(String(id)); },
};

/**
 * One stable stand-in object per Session id for the no-registry host.
 *
 * With no Agent registry there is nothing to compare against, so the *domain identity* is the
 * Session id itself. Minting a fresh object per call would look — correctly, to the resolver — like
 * a replaced instance, revoke the previous epoch and refuse every later call; callers legitimately
 * pass copies of `exec.agent` (the acceptance suites spread it to attach a signal), so the copy must
 * not be able to invalidate the domain.
 */

function degradedAgentIdentity(actorId) {
  const id = String(actorId);
  let canonical = DEGRADED_AGENT_OBJECTS.get(id);
  if (canonical === undefined) {
    canonical = Object.freeze({ id, degraded: 'host-has-no-agent-registry' });
    DEGRADED_AGENT_OBJECTS.set(id, canonical);
  }
  return canonical;
}

/**
 * Resolve the calling Agent's trusted Principal.
 *
 * Three host states, three different answers — conflating them is what makes a permission model
 * either useless or unusable:
 *   1. `ctx.agents` present: identity must be *proved*. The exact object must come back from
 *      `agents.get(id)`, and the Team service (when installed) must return a native membership
 *      whose root is still the exact registry object. `tryMembership === undefined` is
 *      TAB_IDENTITY_UNAVAILABLE — never "this must be a standalone session".
 *   2. `ctx.agents` present, `ctx.agentTeams` absent (Team plugin not installed): exact-object
 *      proof plus the host's explicit standalone proof from ruling §2.2. The root is the actor, so
 *      it reaches exactly its own pages.
 *   3. `ctx.agents` absent (the acceptance harness, a non-Team host): there is nothing to compare
 *      against, so the caller degrades to a standalone domain keyed by its own Session id. This is
 *      the *only* allowed degradation and it is deliberately not a wildcard: a missing service
 *      grants "my own domain", never "any page". Note it still cannot be forged — `exec.agent` is
 *      put on the execution by the Host, and no tool argument, header or query can set it.
 */

function resolveToolPrincipal(ctx, exec) {
  const agent = exec && exec.agent;
  if (!agent || typeof agent !== 'object' || typeof agent.id !== 'string' || agent.id.trim() === '') {
    // No subject at all: the documented legacy tool protocol (an old client, or a harness that
    // drives tools without an exec identity). This is *not* "a session we could not verify" — there
    // is no session — so it keeps its own isolated domain (`root:unscoped`, where `legacy:default`
    // already lived) instead of being refused. It can therefore never reach an Agent's page, which
    // is strictly stronger than the old behaviour where the legacy entry shared the workspace.
    return resolvePrincipal(degradedAgentIdentity(UNSCOPED_ROOT), {
      agentRegistry: DEGRADED_AGENT_REGISTRY,
      teamService: undefined,
      standaloneProof: () => true,
    });
  }
  const agents = hostService(ctx, 'agents');
  if (!agents || typeof agents.get !== 'function') {
    return resolvePrincipal(degradedAgentIdentity(agent.id), {
      agentRegistry: DEGRADED_AGENT_REGISTRY,
      teamService: undefined,
      standaloneProof: () => true,
    });
  }
  const agentTeams = hostService(ctx, 'agentTeams');
  const hasTeamService = Boolean(agentTeams)
    && (typeof agentTeams.tryMembership === 'function' || typeof agentTeams.membership === 'function');
  return resolvePrincipal(agent, {
    agentRegistry: agents,
    teamService: hasTeamService ? agentTeams : undefined,
    // Without a Team service the host itself is the proof of "no team": the actor is its own root.
    standaloneProof: hasTeamService ? undefined : () => true,
  });
}

/**
 * Principal for one **diagnostic dispatcher** probe (task-12), or `null` for every other call.
 *
 * `integration/diagnose.js` runs a fixed set of read-only probes against a page it already froze.
 * That page belongs to a *root* (page groups are keyed by workspace × provider × root), so the probe
 * has to act inside that root; the frozen entry records its owner, which is exactly the identity the
 * probe is entitled to use.
 *
 * Why this is not an identity backdoor:
 *   - it exists only when `exec.diagnosticScope.entry` is present, which only the diagnose
 *     dispatcher sets — no tool call, header, argument or RPC can attach it;
 *   - the entry was resolved by the same authenticated GUI scope resolution every other panel route
 *     uses (session header, or a binding that must hit an existing runtime), so the panel could
 *     already read that page through `/state|/frame`;
 *   - the probe set and its arguments come from `DISPATCHER_ALLOWED` + `validateProbeArgs`
 *     (expression `1`, snapshot, screenshot, computedStyle, network list): no navigation, no input,
 *     no arbitrary script, and the response is a structural summary, never page content;
 *   - the principal is `source:'panel'`, is never persisted into any long-lived record and cannot be
 *     handed to another call, so it buys exactly one probe round.
 *
 * It deliberately does NOT consult `ctx.agents`: a panel may diagnose a session whose agent is not
 * currently loaded, and the subject here is the panel acting on its own resolved page — not a turn.
 */

function diagnosticPrincipalFor(exec) {
  const entry = exec?.diagnosticScope?.entry;
  const owner = entry?.ownership?.ownerSessionId || entry?.rootSessionId || null;
  if (!owner) return null;
  return makePrincipal({
    actorSessionId: String(owner),
    rootSessionId: String(entry.rootSessionId || owner),
    role: PRINCIPAL_ROLE.STANDALONE,
    membershipRevision: 1,
    executionEpoch: 1,
    source: PRINCIPAL_SOURCE.PANEL,
    hostEpoch: defaultTabPrincipalResolver().hostEpoch,
  });
}

/** Tools carry the Agent's session header; no exec identity at all is the old protocol. */

/** Tools carry the Agent's session header; no exec identity at all is the old protocol. */
function toolScopeRequest(exec, principal = null) {
  const agent = exec && exec.agent;
  if (!agent || !agent.id) return { mode: 'legacy' };
  const headerCwd = agent.session && agent.session.header && agent.session.header.cwd;
  return {
    mode: 'session',
    sessionId: String(agent.id),
    // The verified identity decides the page domain. A tool call never gets to name its own root:
    // it is whatever `integration/tab-principal.js` proved from the exact agent object.
    ...(principal ? { rootSessionId: principal.rootSessionId, creatorSessionId: principal.actorSessionId } : {}),
    ...(typeof headerCwd === 'string' && headerCwd ? { cwd: headerCwd } : {}),
    ...(exec && exec.signal ? { signal: exec.signal } : {}),
  };
}

/**
 * Resolve a parsed scope request to { key, scope }. A `binding` must hit an existing runtime
 * (404 otherwise) and is owner-only at the HTTP/WS layer; `recent` never falls back to legacy.
 */
/**
 * Resolve a parsed scope request to `{ key, scope, provider, rootSessionId, creatorSessionId }`.
 *
 * The **root** dimension is resolved here and nowhere else (M2a, ruling §7.4):
 *   - a tool call supplies the verified Principal's root (`request.rootSessionId`);
 *   - a bound/recent GUI request inherits the root of the entry it already names (the runtime id is
 *     the only thing it knows, and it was minted inside one group);
 *   - a session-addressed GUI request resolves to *that session's* domain, so a panel bound to a
 *     session still shows exactly the page that session drives — the pre-M5 panel has no verified
 *     actor of its own, and inventing one would be worse than reusing the addressed session id;
 *   - the legacy protocol (no scope headers at all) gets `UNSCOPED_ROOT`, its own domain: an old
 *     client must not silently inherit an Agent's page just because it named the workspace.
 */

async function resolveScopeRequest(ctx, registry, request) {
  if (!request || request.mode === 'legacy') return { ...LEGACY_SCOPE, rootSessionId: UNSCOPED_ROOT };
  if (request.mode === 'unassigned') {
    return { ...UNSCOPED_SCOPE_FACTORY(), rootSessionId: String(request.rootSessionId || UNSCOPED_ROOT) };
  }
  if (request.mode === 'recent') {
    // A tool/GUI request that carries a root only follows that root; a rootless (legacy panel)
    // request keeps the historical global pointer. See RuntimeRegistry#recentEntry.
    const entry = registry.recentEntry(request.rootSessionId);
    const rootSessionId = String(request.rootSessionId || entry?.rootSessionId || UNSCOPED_ROOT);
    return entry
      ? { key: entry.key, scope: entry.scope, provider: entry.provider, rootSessionId: entry.rootSessionId }
      : { ...UNSCOPED_SCOPE_FACTORY(), rootSessionId };
  }
  if (request.mode === 'binding') {
    const entry = registry.findByRuntimeId(request.runtimeId);
    if (!entry) throw new BrowserError('SCOPE_NOT_FOUND', 'scope binding 指向的运行时不存在', { scope: 'binding' });
    // `key` is the entry's own page-group key (root + provider + workspace, or a PageTargetKey);
    // the provider and root travel with it so a bound lookup never has to guess them back.
    return { key: entry.key, scope: entry.scope, provider: entry.provider, rootSessionId: entry.rootSessionId };
  }
  // Bounded: tools pass exec.signal; HTTP/WS requests get a 5s metadata-read budget.
  const resolved = await resolveSessionScope(ctx, request.sessionId, { cwd: request.cwd, signal: request.signal || AbortSignal.timeout(5000) });
  const rootSessionId = String(request.rootSessionId || request.sessionId || UNSCOPED_ROOT);
  return {
    ...resolved,
    rootSessionId,
    creatorSessionId: String(request.creatorSessionId || request.sessionId || rootSessionId),
  };
}

/** A fresh (mutable) copy of the unassigned scope so a root dimension can be attached. */

function emptyMetrics() {
  return {
    ok: true,
    now: Date.now(),
    host: {
      seq: 0, epoch: 0, url: '', captured: 0, cachedOnly: 0, subscribers: 0,
      captureFps: 0, captureIntervalMs: 0, measured: { captureFps: false, captureIntervalMs: false },
      lastFrame: null, ackFailures: 0, push: null, cleanupError: null,
    },
    client: null,
  };
}

/**
 * Per-scope Runtime registry.
 *
 * - `getOrCreate` returns a cold Runtime (no page, no Chromium) so /state and /frames have a
 *   stable runtimeId; only an actual page operation starts the shared BrowserHost.
 * - `reservePageSlot` counts a reservation BEFORE any await that could create a page, so N
 *   concurrent first ensures cannot exceed `maxPages`; eligible idle LRU pages are evicted first.
 * - `recent` is updated only by real interaction / successful operations, never by polling, and
 *   never points at `legacy:default`.
 */

function readJson(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > 8388608) {
        reject(new BrowserError('INVALID_ARGUMENT', '请求体过大'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      const text = Buffer.concat(chunks).toString('utf8');
      if (!text) return resolve({});
      try { resolve(JSON.parse(text)); } catch { reject(new BrowserError('INVALID_ARGUMENT', '请求体不是合法 JSON')); }
    });
    req.on('error', reject);
  });
}

function sendJson(res, status, value) {
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
  });
  res.end(JSON.stringify(value));
}


/* ---------------------------------------------------------------------------------------------
 * Independent HTTP(S) client — `browser_http_request` / `web.t1.http-request`.
 *
 * Deliberately shares nothing with the page runtime: no Chromium, no CDP, no page queue, no
 * owner lease, no cookie jar, no page lastError. Contract: docs/tools.md.
 *
 * `node:http` / `node:https` are default-imported and called as `http.request(...)` so a probe
 * can wrap the module property to count dispatches (zero-dispatch assertions).
 * ------------------------------------------------------------------------------------------- */

export function apply(ctx) {
  const log = (text) => {
    try {
      if (ctx.logger && typeof ctx.logger.info === 'function') ctx.logger.info(text);
    } catch { /* logging must never break the runtime */ }
  };
  const origins = new Set();
  const registry = new RuntimeRegistry({
    log,
    ctx,
    // The page registry asks the Host for native services (roster proofs) instead of reading the
    // Cordis context itself.
    services: (name) => hostService(ctx, name),
    origins,
    maxPages: envPositiveInt('DSH_UI_TESTING_MAX_PAGES', MAX_PAGES_DEFAULT),
    idleMs: envPositiveInt('DSH_UI_TESTING_IDLE_MS', IDLE_MS_DEFAULT),
    viewerTtlMs: envPositiveInt('DSH_UI_TESTING_VIEWER_TTL_MS', VIEWER_TTL_MS),
  });
  // Environment registrations, assembled by environment id (plan §Host 负责编排，环境实现负责执行).
  // Each entry declares what the environment is (capabilities, tool descriptions) and builds its
  // implementation lazily; everything below resolves entries instead of importing a platform.
  const webTabsLimits = {
    TAB_WAIT_TIMEOUT_DEFAULT_MS, TAB_WAIT_TIMEOUT_MAX_MS,
    TAB_WAIT_POLL_DEFAULT_MS, TAB_WAIT_POLL_MIN_MS, TAB_WAIT_POLL_MAX_MS,
    TAB_ACQUIRE_TIMEOUT_DEFAULT_MS, TAB_ACQUIRE_TIMEOUT_MAX_MS,
  };
  const environments = createEnvironmentDirectory({ log });
  environments.register(createWebEnvironmentEntry({ log, BrowserError, registry, webTabsLimits }));
  environments.register(createFakeEnvironmentEntry({ log }));
  // Cross-environment composition root (M2/M3): authoritative config, adapter registry, tool
  // admission, per-execution adapter dispatch, readiness and Skill discovery. It resolves the
  // environment implementations from `environments`; the Web runtime stays in this bundle.
  const crossEnvironment = createCrossEnvironment({
    ctx, registry, log, BrowserError, asBrowserError, webTabsLimits, environments,
  });
  ctx.effect(() => () => crossEnvironment.dispose(), 'ui-testing: cross-environment');
  /**
   * Per-Agent capability selection (in-memory `WeakMap`, disposed with the plugin).
   *
   * `environmentAdmitted` reuses the same snapshot that gates execution, so a group can never be
   * disclosed where the environment refuses it. `scopeVisible` asks the host registry whether the
   * registration is visible to that Agent, which keeps a `tools.restrict()` whitelist authoritative:
   * activation cannot resurrect a denied definition.
   */
  const disclosure = createToolDisclosure({
    snapshotForAgent: (agent) => crossEnvironment.snapshotForAgent(agent),
    environmentAdmitted: (agent, name) => name === DISCOVERY_TOOL || crossEnvironment.toolAdmitted(agent, name),
    scopeVisible: (agent, name) => {
      const tools = ctx.tools;
      if (!tools || typeof tools.get !== 'function') return true;
      try {
        return tools.get(name, agent) !== undefined;
      } catch {
        // A host without scoped lookup cannot prove a restriction; fail open for *visibility* only.
        // Execution stays gated by the host's own restrict/guard enforcement.
        return true;
      }
    },
    ErrorClass: BrowserError,
  });
  ctx.effect(() => () => disclosure.dispose(), 'ui-testing: tool disclosure');
  // Independent HTTP client: shares only the collected host origins, never a page runtime.
  const httpClient = new HttpClient({ origins: () => [...origins] });
  // Web dispatch pipeline: page resolution, queue, lease, dispatch-time re-check and handler
  // execution. The Host keeps admission, the authorization verdict and the evidence envelope.
  const webInvoker = createWebInvoker({
    log, registry, httpClient, tabLimits: { acquireTimeoutMs: TAB_ACQUIRE_TIMEOUT_DEFAULT_MS },
  });
  // Panel page routes: the Web environment answers them; the Host keeps authentication, the
  // control plane and the error→status mapping.
  const webRoutes = createWebRoutes({ log, registry, BrowserError, asBrowserError });
  const blenderViewport = createBlenderViewport();
  ctx.effect(() => () => blenderViewport.dispose(), 'ui-testing: Blender viewport');
  ctx.effect(() => () => { httpClient.dispose(); }, 'ui-testing: http client');
  /**
   * P0 capture staging root: one per plugin instance, created on first non-persistent capture and
   * removed when the plugin is disposed. Screenshots default to this directory so a plain
   * `browser_screenshot` never writes into the user's workspace. A crash can leave the directory
   * behind (documented limitation); normal dispose removes it best-effort.
   */
  const captureStaging = { root: undefined };
  const ensureCaptureStagingRoot = () => {
    if (!captureStaging.root) captureStaging.root = mkdtempSync(join(tmpdir(), 'dsh-ui-testing-capture-'));
    return captureStaging.root;
  };
  ctx.effect(() => () => {
    const root = captureStaging.root;
    captureStaging.root = undefined;
    if (!root) return;
    try {
      rmSync(root, { recursive: true, force: true, maxRetries: PROFILE_RM_RETRIES, retryDelay: PROFILE_RM_RETRY_DELAY_MS });
    } catch { /* best effort */ }
  }, 'ui-testing: capture staging root');
  let attachments;
  ctx.inject(['attachments'], (sub) => {
    attachments = sub.attachments;
    try { webToolSurface?.setAttachments(sub.attachments); } catch { /* surface not built yet */ }
    sub.effect(() => () => { attachments = undefined; }, 'ui-testing: attachments');
  });
  if (typeof ctx.on === 'function') ctx.on('agent/disposed', ({ agent }) => registry.releaseSession(String(agent.id)));

  // Plugin unload waits for every page/WS/HTTP resource: the effect cleanup returns a promise.
  ctx.effect(() => () => registry.dispose(), 'ui-testing: browser runtimes');

  const connectionService = () => {
    try { return typeof ctx.get === 'function' ? ctx.get('connection') : undefined; } catch { return undefined; }
  };
  /** Historical raw-UI gate (unscoped / legacy protocol only): fail closed on any doubt. */
  const requestRejection = (req) => {
    const connection = connectionService();
    if (!connection || typeof connection.requestRejection !== 'function') return 401;
    let rejection;
    try { rejection = connection.requestRejection(req); } catch { return 401; }
    if (rejection === undefined || rejection === null || rejection === false) return 0;
    return rejection === 403 ? 403 : 401;
  };
  const uiRejection = requestRejection;

  /**
   * Strict owner-only gate for every scoped request (HTTP and WS).
   *
   * Workspace page isolation is NOT a security boundary (cookies/profile are shared), but the raw
   * UI projection (unredacted address, reload/history, frame stream) is owner-only: the request
   * must be admitted *and* its peer must be the browser's own peer. Missing connection service,
   * missing `admit`, a thrown admission or an unresolvable peer fails closed (401/503); a
   * different peer is 403. Legacy unscoped requests keep the old requestRejection-only gate.
   */
  const scopeAuthorization = (req) => {
    const connection = connectionService();
    if (!connection || typeof connection.requestRejection !== 'function') return 401;
    let rejection;
    try { rejection = connection.requestRejection(req); } catch { return 401; }
    if (rejection !== undefined && rejection !== null && rejection !== false) return rejection === 403 ? 403 : 401;
    if (typeof connection.admit !== 'function') return 503;
    let admitted;
    try { admitted = connection.admit(req); } catch { return 401; }
    if (!admitted || typeof admitted !== 'object') return 401;
    // DSH `admit()` returns `{ peer }` or `{ rejection: 401|403 }`.
    if ('rejection' in admitted) return admitted.rejection === 403 ? 403 : 401;
    const peerId = admitted.peer && admitted.peer.id;
    let browserPeer;
    try { browserPeer = connection.browserPeer; } catch { browserPeer = undefined; }
    const ownerId = browserPeer && browserPeer.id;
    if (!peerId || !ownerId) return 503;
    return peerId === ownerId ? 0 : 403;
  };
  const scopeAuthError = (res, status) => {
    const code = status === 403 ? 'SCOPE_FORBIDDEN' : status === 503 ? 'SCOPE_UNAVAILABLE' : 'UNSUPPORTED';
    const error = new BrowserError(code, status === 403 ? '该调试视图不属于当前浏览器会话' : '需要已认证且已绑定的 GUI 会话');
    sendJson(res, status, { ok: false, ...error.payload(), error: error.message });
  };
  const rejectUi = (res, status) => {
    // Authentication failures are answered inline: they are not page errors and must not be
    // written into any runtime's lastError / activity.
    const error = new BrowserError('UNSUPPORTED', '需要已认证的 GUI 会话才能访问该运行时接口');
    sendJson(res, status === 403 ? 403 : 401, { ok: false, ...error.payload(), error: error.message });
  };

  // Frame push (same-origin WebSocket upgrade) is the Web environment's transport wiring; a
  // failure to mount it leaves the `/frame` polling fallback working.
  const webFramePush = createWebFramePush({
    log,
    registry,
    BrowserError,
    authenticate: (req) => scopeAuthorization(req),
    parseScope: parseScopeQuery,
    statusFor: scopeHttpStatus,
    resolveScopeRequest: (scopeRequest) => resolveScopeRequest(ctx, registry, scopeRequest),
    scopeTabPrimary: SCOPE_TAB_PRIMARY,
  });
  ctx.effect(() => webFramePush.mount(ctx), 'ui-testing: frame push');

  // Environment-aware Skill discovery (M3). The provider exposes the common rules plus only the
  // current environment's extension; `get()` re-checks visibility because an explicit skill load
  // does not pass through `list()`. The legacy single-skill registration is the fallback.
  ctx.inject(['skills'], (sub) => {
    try {
      crossEnvironment.registerSkills(sub);
    } catch (error) {
      log('ui-testing skill 未注册：' + String((error && error.message) || error));
    }
  });

  /**
   * HTTP surface. Every existing path/field is unchanged; the scope headers select which
   * workspace runtime the request operates on:
   *   no scope headers            -> legacy:default (old client / old regression only)
   *   scopeVersion=1 + sessionId  -> that session's workspace (server-side cwd lookup only)
   *   scopeVersion=1 + scope      -> recent | unassigned
   *   scopeVersion=1 + binding    -> the existing runtime named by its runtimeId (owner-only)
   * Scoped requests are authenticated (strict owner-only) BEFORE any scope resolution, registry
   * creation or host-origin recording, so a rejected request has zero side effects.
   */
  // Test-only tool invocation (P0-E GUI acceptance). Disabled unless BOTH env vars are set;
  // it never appears in toolDefinitions/capabilities and never changes the public tool surface.
  const TEST_HOOKS_ENABLED = process.env.DSH_UI_TESTING_TEST_HOOKS === '1'
    && Boolean(process.env.DSH_UI_TESTING_TEST_TOKEN);
  const TEST_HOOK_TOKEN = TEST_HOOKS_ENABLED ? String(process.env.DSH_UI_TESTING_TEST_TOKEN) : '';
  const testToolDefs = new Map();
  const testTokenEqual = (provided) => {
    if (typeof provided !== 'string' || !provided || !TEST_HOOK_TOKEN) return false;
    const a = Buffer.from(provided, 'utf8');
    const b = Buffer.from(TEST_HOOK_TOKEN, 'utf8');
    return a.length === b.length && timingSafeEqual(a, b);
  };
  const testLoopback = (req) => {
    const address = String(req.socket?.remoteAddress || '');
    return address === '127.0.0.1' || address === '::1' || address === '::ffff:127.0.0.1';
  };

  /**
   * Provider diagnostics (Host slice): `POST /plugins/ui-testing/diagnose` streams NDJSON and runs
   * five real checks. It reuses the registered tool handlers (never `/test/invoke`) through a
   * restricted dispatcher; `toolDefinitions` is read lazily because it is declared later.
   */
  const diagnose = createDiagnose({
    log,
    crossEnvironment,
    registry,
    // The probe list is the environment's own declaration; this module stays generic.
    environments,
    readJson,
    sendJson,
    nowMonoMs,
    resolveProviderExecutable,
    randomUUID,
    webProviderSupport: (providerId) => {
      try { return webProviderSupport(providerId); } catch { return undefined; }
    },
    toolDefinitions: {
      get(name) { return toolDefinitions.get(name); },
      keys() { return [...toolDefinitions.keys()]; },
      has(name) { return toolDefinitions.has(name); },
    },
  });

  const handle = async (req, res) => {
    // No eager Web-module resolution here (A14 / plan §2): config, readiness and the diagnostics
    // control plane must answer on a host that never loads the Web dependency chain. The page
    // routes resolve it themselves on first use, and so does every tool dispatch.
    let action = '/';
    let selected;
    try {
      const url = new URL(req.url || '/', 'http://localhost');
      action = url.pathname.slice(ROUTE_PREFIX.length) || '/';
      if (req.method === 'POST' && action === '/test/invoke' && TEST_HOOKS_ENABLED) {
        if (!testLoopback(req) || !testTokenEqual(headerValue(req.headers, 'x-ui-testing-test-token'))) {
          sendJson(res, 404, { ok: false, code: 'NOT_FOUND' });
          return;
        }
        const body = await readJson(req);
        const keys = body && typeof body === 'object' ? Object.keys(body) : [];
        const allowed = ['tool', 'args', 'agent'];
        const agent = body && body.agent;
        const valid = keys.every((key) => allowed.includes(key))
          && typeof body?.tool === 'string' && body.tool.length > 0
          && agent && typeof agent.id === 'string' && agent.id.length > 0
          && agent.session && agent.session.header && typeof agent.session.header.cwd === 'string'
          && (body.args === undefined || (body.args && typeof body.args === 'object' && !Array.isArray(body.args)));
        if (!valid) throw new BrowserError('INVALID_ARGUMENT', 'test/invoke body 必须只含 {tool,args,agent:{id,session:{header:{cwd}}}}');
        const definition = testToolDefs.get(body.tool);
        if (!definition) {
          sendJson(res, 404, { ok: false, code: 'TOOL_NOT_FOUND' });
          return;
        }
        let execAgent = agent;
        const cwdHint = String(agent.session.header.cwd || '');
        if (cwdHint.startsWith('workspace:')) {
          const workspaceId = cwdHint.slice('workspace:'.length);
          const registryService = hostService(ctx, 'workspaceRegistry');
          const list = registryService && typeof registryService.list === 'function' ? registryService.list() : [];
          const workspace = Array.isArray(list) ? list.find((item) => item && item.id === workspaceId) : undefined;
          const root = workspace && (workspace.path || workspace.root || workspace.cwd || workspace.directory);
          if (!root) throw new BrowserError('SCOPE_NOT_FOUND', 'test workspace 不存在或没有路径', { workspaceId });
          execAgent = { ...agent, session: { ...agent.session, header: { ...agent.session.header, cwd: String(root) } } };
        }
        const value = await definition.execute(body.args || {}, { agent: execAgent, signal: AbortSignal.timeout(30000) });
        sendJson(res, 200, { ok: true, value });
        return;
      }
      // Scope-header presence decides "scoped" BEFORE parsing: authentication must happen before
      // any scope resolution, registry creation, origin recording or parse-error path.
      const scopeHeaders = req.headers || {};
      const scoped = [SCOPE_HEADER_VERSION, SCOPE_HEADER_SESSION, SCOPE_HEADER_SCOPE, SCOPE_HEADER_BINDING]
        .some((name) => {
          const value = headerValue(scopeHeaders, name);
          return value !== undefined && value !== '';
        });
      if (scoped) {
        const status = scopeAuthorization(req);
        if (status) { scopeAuthError(res, status); return; }
      }
      if (action === '/blender/frame' && req.method === 'POST') {
        if (!scoped) { scopeAuthError(res, 401); return; }
        parseHttpScope(req);
        if (!crossEnvironment.isViewEnabled('three-d')) {
          sendJson(res, 409, { ok: false, code: 'ADAPTER_DISABLED', error: '请先在设置中启用 3D 视图。' });
          return;
        }
        // Blender 是 3D 的 provider：环境总开关开着、但这一运行环境被单独关掉时，画面也不能取。
        if (!crossEnvironment.isProviderEnabled('three-d', 'blender')) {
          sendJson(res, 409, { ok: false, code: 'ADAPTER_DISABLED', error: '请先在设置中启用 Blender 运行环境。' });
          return;
        }
        const controller = new AbortController();
        const onClose = () => controller.abort();
        res.once('close', onClose);
        try {
          const frameRequest = parseViewportRequest(await readJson(req));
          const png = await blenderViewport.frame(frameRequest, controller.signal);
          if (res.destroyed) return;
          res.writeHead(200, { 'Content-Type': 'image/png', 'Content-Length': png.length, 'Cache-Control': 'no-store' });
          res.end(png);
        } catch (error) {
          if (res.destroyed) return;
          if (!error.status) throw error;
          sendJson(res, error.status, { ok: false, code: error.code, error: error.message });
        } finally {
          res.off('close', onClose);
        }
        return;
      }
      // Host-side provider diagnostics. Handled before the page-route dispatch so it never creates
      // a Runtime or starts Chromium just by being routed (observe must stay cheap).
      if (await diagnose.handleHttp(req, res, {
        action,
        url,
        scopeRequest: parseHttpScope(req),
        scoped,
        requestRejection,
        rejectUi,
        readJson,
        sendJson,
        // Bound resolver: this seam calls `resolveScopeRequest(request)`. Passing the 3-argument
        // module function unbound left `request` undefined, so every diagnose run silently froze
        // the LEGACY scope instead of the panel's own session/binding.
        resolveScopeRequest: (request) => resolveScopeRequest(ctx, registry, request),
      })) return;
      const scopeRequest = parseHttpScope(req);
      if (req.headers?.host) {
        try { origins.add(new URL('http://' + req.headers.host).origin); } catch { /* invalid host */ }
      }
      // Cross-environment control plane: /config, /config/select, /readiness. Consumed before the
      // page-route dispatch so these endpoints never create a Runtime or start Chromium.
      if (await crossEnvironment.handleHttp(req, res, {
        action,
        url,
        scopeRequest,
        scoped,
        requestRejection,
        rejectUi,
        readJson,
        sendJson,
        resolveScopeRequest: (request) => resolveScopeRequest(ctx, registry, request),
      })) return;
      // Page semantics live in the Web environment (`targets/web/routes.js`): frames, state,
      // metrics, element picking, select/annotation writes, input, screenshots, tabs and close.
      // The Host keeps authentication, the control plane above, the projection policy and the
      // error→status mapping.
      const pageState = { selected: null };
      try {
        if (await webRoutes.handleHttp({
          req,
          res,
          url,
          action,
          scopeRequest,
          scoped,
          state: pageState,
          resolveScopeRequest: (request) => resolveScopeRequest(ctx, registry, request),
          assertGuiAllowed: (request) => crossEnvironment.assertGuiAllowed(request),
          requestRejection,
          rejectUi,
          readJson,
          sendJson,
          scopeHttpStatus,
          SCOPE_TAB_PRIMARY,
          SCOPE_HEADER_FOREGROUND,
        })) return;
      } finally {
        // Keep the Host's error projection pointed at the page this request actually touched,
        // including the throwing case.
        selected = pageState.selected;
      }

      const error = new BrowserError('UNSUPPORTED', '未知指令 ' + action);
      sendJson(res, 404, { ok: false, ...error.payload(), error: error.message });
    } catch (error) {
      const classified = asBrowserError(error);
      if (selected && !NON_PAGE_ERROR_CODES.has(classified.code)) {
        // The page-projection write belongs to the Web environment; the Host only decides that
        // this failure counts as a page error.
        webRoutes.noteHttpError(selected, classified.message);
      }
      sendJson(res, scopeHttpStatus(classified.code), { ok: false, ...classified.payload(), error: classified.message });
    }
  };

  ctx.effect(() => ctx.webServer.register({ kind: 'prefix', path: ROUTE_PREFIX, handler: handle }), 'ui-testing: http routes');

  /**
   * Describe the *live* target this tool call is running against, when it has one.
   *
   * Readiness must answer "is the target this session is actually driving bound?", not a static
   * projection: a running page with a runtimeId is a bound target with a connected transport
   * (plan §6.2 six axes, A13). Diagnostics never start a target, so an idle runtime reports null
   * and the axes stay `not-probed`/`unbound` truthfully.
   */

  const text = (value) => [{ type: 'text', text: typeof value === 'string' ? value : JSON.stringify(value) }];
  /**
   * P0 data access for tools (A01): one entry through the environment's P0 provider.
   *
   * The provider owns target binding, generation and the evidence envelope; the tool keeps its
   * public result shape. `raw: true` (default) keeps platform-shaped payloads untouched.
   */
  const p0 = async (exec, family, method, args = {}, extra = {}) => {
    const result = await crossEnvironment.p0Call({
      family,
      method,
      args,
      exec,
      runtime: exec?.runtime ?? null,
      entry: extra.entry ?? null,
      meta: exec?.meta ?? null,
      selection: extra.selection ?? null,
      resolvedScope: extra.resolvedScope ?? null,
      raw: extra.raw !== false,
    });
    return extra.withEvidence === true ? result : result.value;
  };
  /** Tool name → environment that owns its definition (Web surface or an entry's own tools). */
  const toolOwnerEnvironment = new Map();
  const register = (definition, ownerEnvironment = 'web') => {
    const execute = definition.execute;
    toolOwnerEnvironment.set(definition.name, ownerEnvironment);
    if (!definition.timeoutMs) definition.timeoutMs = 30000;
    definition.execute = async (args, exec = {}) => {
      // Execution guard: conditional registration alone is not enough (old calls, /test/invoke,
      // programmatic dispatch). The same snapshot gates the actual dispatch.
      crossEnvironment.assertToolAllowed(exec.agent, definition.name);
      // A14: the Web-only module chain is resolved here, once, before any page/state work — and
      // only when this call actually needs it. Neutral diagnostics must still answer on a host
      // whose Web environment is disabled, so for them the load is optional and failure-tolerant.
      if (definition.name === DISCOVERY_TOOL) {
        // Discovery/selection is host-local state: no page, no CDP, no Web module chain, no
        // principal binding. It must answer even on a host whose Web environment is disabled.
        return disclosure.execute(args, exec.agent);
      }
      if (definition.name !== 'browser_fake_probe') {
        if (DISCLOSURE_DIAGNOSTIC_TOOLS.includes(definition.name)) {
          try { await ensureWebHostModules(); } catch { /* diagnostics keep answering */ }
        } else {
          await ensureWebHostModules();
        }
      }
      const admissionSnapshot = crossEnvironment.snapshotForAgent(exec.agent);
      const sessionId = String(exec.agent?.id || 'anonymous');
      // M2a: prove *who* is calling before any scope resolution, entry creation or CDP.
      const principal = diagnosticPrincipalFor(exec) || resolveToolPrincipal(ctx, exec);
      // The call's real effects are known before any scope/entry work: they decide which selection
      // this call uses (observation vs work) and later authorise its page part.
      const callEffects = operationEffect(definition.name, args);
      const observeOnlyCall = callEffects.length > 0
        && callEffects.every((row) => row.effect === EFFECT.OBSERVE || row.effect === EFFECT.CALLER_LOCAL);
      const meta = { actionId: randomUUID(), sessionId, startedAt: Date.now(), tool: definition.name,
        configRevision: admissionSnapshot.revision,
        environment: admissionSnapshot.environment,
        adapterId: admissionSnapshot.adapterId,
        // Expressions and input text may contain secrets: record a bounded structural summary.
        args: Object.fromEntries(Object.entries(args || {}).map(([key, value]) => [key,
          key === 'url' ? redactUrl(String(value))
            : key === 'method' && typeof value === 'string' ? { type: 'string', value }
            : Array.isArray(value) ? { count: value.length }
            : typeof value === 'string' ? { type: 'string', length: value.length }
            : typeof value === 'number' && Number.isFinite(value) ? { type: 'number', value }
            : typeof value === 'boolean' ? { type: 'boolean', value }
            : value && typeof value === 'object' ? { type: 'object', count: Object.keys(value).length }
            : { type: typeof value }])),
      };
      const isNetworkRead = definition.networkRead === true;
      // The platform half — page resolution, authorization verdict, preflight, queue, lease,
      // dispatch-time re-check, handler, activity marks — belongs to the Web environment.
      const authorizePage = ({ entry, effects, operation, expectedControlRevision }) => {
        const verdict = authorizeAll({
          principal,
          ...registry.accessOf(entry),
          effects,
          operation,
          ...(expectedControlRevision === undefined ? {} : { expectedControlRevision }),
        });
        return verdict.allowed
          ? { allowed: true, verdict }
          : { allowed: false, verdict, error: registry.accessError(verdict.verdict, operation) };
      };
      const dispatchThroughAdapter = (thunk, executionClass, targetInfo) => crossEnvironment.invokeTool({
        name: definition.name,
        args,
        exec,
        thunk,
        // The wrapper branch decides queue/ensure; the adapter class is the operation's declared
        // class refined by its action (e.g. network_session status=readOnly, start=hostOnly).
        executionClass: crossEnvironment.executionClassFor(definition.name, args) || executionClass,
        resolvedScope: targetInfo.resolvedScope,
        runtime: targetInfo.runtime,
        entry: targetInfo.entry,
        selection: targetInfo.selection,
        meta,
      });
      // Every tool value leaves through this single lossless-JSON boundary. The platform facts the
      // envelope needs (which tab, whether control was auto-acquired) come back from the Web
      // environment; the envelope itself is the Host's public contract.
      const finish = (value, target, outcome = {}) => {
        // Envelope ordering matters per tool family (docs/network-p0.md):
        //  - the 7 network tools own `sessionId` (采集会话 id 或 null); the agent session moves to
        //    `agentSessionId` so the envelope can never overwrite the contract field.
        //  - the legacy 22 tools keep their historical `{...value, ...meta}` order untouched.
        const tabMeta = outcome.tab ?? null;
        const controlMeta = outcome.control
          ? { autoAcquired: true, control: outcome.control.projection }
          : {};
        const result = isNetworkRead
          ? { ...meta, ...value, agentSessionId: meta.sessionId, ...(tabMeta ? { tab: tabMeta } : {}), ...controlMeta, finishedAt: Date.now(), target }
          : { ...value, ...meta, ...(tabMeta ? { tab: tabMeta } : {}), ...controlMeta, finishedAt: Date.now(), target };
        const notes = [];
        const clean = losslessJson(result, definition.name, notes);
        if (!clean || typeof clean !== 'object' || Array.isArray(clean)) throw new BrowserError('INTERNAL', '工具返回值不是对象');
        if (notes.length > 0) clean.sanitized = notes;
        return clean;
      };
      // A tool owned by a non-Web environment has no page runtime, no queue and no lease: its
      // handler is dispatched through its own adapter only. This is what makes the public dispatch
      // usable with a plain contract fixture (plan §1 完成条件). Web-operated tools still take the
      // Web pipeline even when the resolved environment is not Web (their diagnostics must answer).
      const ownerEnvironment = toolOwnerEnvironment.get(definition.name) ?? 'web';
      if (ownerEnvironment !== 'web') {
        const value = await crossEnvironment.invokeTool({
          name: definition.name,
          args,
          exec,
          thunk: () => execute(args, { ...exec, meta, sessionId, principal, httpClient }),
          executionClass: crossEnvironment.executionClassFor(definition.name, args) || 'page',
          resolvedScope: null,
          runtime: null,
          entry: null,
          selection: null,
          meta,
        });
        return finish(value, meta.target || '', {});
      }
      try {
        const outcome = await webInvoker.invoke({
          operation: definition.name,
          definition,
          // The tool's own implementation, captured before the Host wrapped `execute`.
          handler: execute,
          args,
          exec,
          meta,
          sessionId,
          principal,
          callEffects,
          observeOnlyCall,
          environment: admissionSnapshot.environment,
          hooks: {
            resolveScope: (execArg, principalArg) => resolveScopeRequest(
              ctx, registry, toolScopeRequest(execArg, principalArg ?? principal),
            ),
            authorize: authorizePage,
            dispatch: dispatchThroughAdapter,
          },
        });
        return finish(outcome.value, outcome.target, outcome);
      } catch (error) {
        const classified = asBrowserError(error);
        // Safety net: a network tool must always surface a code-bearing error with a non-empty
        // message; a bare internal error would reach the caller as `{message: ""}`.
        if (!classified.message || String(classified.message).trim() === '') {
          classified.message = `[${classified.code}] ${definition.name} 失败`;
        }
        if (!classified.code) classified.code = 'INTERNAL';
        const evidence = { ...meta, finishedAt: Date.now(), target: meta.target || '' };
        classified.details = losslessJson({ ...classified.details, ...evidence }, definition.name + '.details', []);
        classified.message += ' ' + JSON.stringify(evidence);
        // No direct lastError write here: run() records only page/network operational failures,
        // so BUSY / argument pre-checks / pre-queue cancellation never overwrite an owner's error.
        throw classified;
      }
    };
    testToolDefs.set(definition.name, definition);
    // Per-step admission: the same snapshot decides model-visible schema and dispatch. `when`
    // must never throw (a rejected condition fails the whole step preparation).
    const when = (context = {}) => {
      try {
        // Environment admission first (cheap, no disclosure state), then this Agent's selection.
        // Both must pass: disclosure can only narrow what the environment already allows.
        return crossEnvironment.toolAdmitted(context.agent, definition.name)
          && disclosure.disclosed(context.agent, definition.name);
      } catch {
        return false;
      }
    };
    // Registration is deferred to `syncToolVisibility()`, which registers the *union* of tool
    // definitions once and lets the host resolve `when(agent)` per step. The host's declaration
    // path (`ToolsService.resolve` -> the `systemPrompt.tools` provider reading
    // `definitions(scope, toolSet)` in dsh-tools/lib/index.js) filters the model-facing list with
    // that same admitted set, so a per-agent snapshot decides declaration and dispatch together
    // (A08). The earlier global register/unregister sync leaked one agent's selection to every
    // other agent in the process.
    toolDefinitions.set(definition.name, { definition, when });
    return null;
  };

  /**
   * Register the union of tool definitions, each with its per-agent `when` predicate.
   *
   * Registration no longer depends on the *global* selection: the host admits per step, so every
   * environment's tools can stay registered without leaking into another agent's request (A08).
   * Environment-neutral diagnostics stay registered in every environment (including a disabled
   * one) so "why is it unavailable" remains answerable.
   */
  function syncToolVisibility() {
    let wanted;
    try {
      wanted = crossEnvironment.declarableToolNames();
    } catch (error) {
      log('ui-testing: tool visibility sync skipped: ' + String((error && error.message) || error));
      return;
    }
    for (const [name, dispose] of toolDisposers) {
      if (wanted.has(name)) continue;
      try { dispose(); } catch { /* best effort */ }
      toolDisposers.delete(name);
    }
    for (const name of wanted) {
      if (toolDisposers.has(name)) continue;
      const entry = toolDefinitions.get(name);
      if (!entry) continue;
      try {
        toolDisposers.set(name, ctx.tools.register(entry.definition, { when: entry.when }));
      } catch (error) {
        log('ui-testing: tool registration failed for ' + name + ': ' + String((error && error.message) || error));
      }
    }
  }

  const toolDefinitions = new Map();
  const toolDisposers = new Map();
  ctx.effect(() => () => {
    for (const dispose of toolDisposers.values()) {
      try { dispose(); } catch { /* best effort */ }
    }
    toolDisposers.clear();
  }, 'ui-testing: tool visibility');

  // Discovery/selection entry (always disclosed). Deliberately short: it lists capability groups
  // and how to select them, and never repeats a tool's parameter schema or a capability contract.
  // The full schemas arrive in the next model step only when this Agent activates their group.






  // ---- Web P0 network surface (docs/network-p0.md): 7 tools, 22 → 29. ---------------------
  // Every one of them is `networkRead`: the read-only actions must resolve the workspace scope but
  // never start Chromium or take the page lease. `session.start` and the page-requiring `control`
  // actions call `runtime.run()` themselves, so BUSY/ABORTED/CDP_* keep their platform semantics.














  // Web T2 tool surface (16 tools total). Every one of these is a page operation: lazy start, the
  // serial page queue and the single-owner lease all apply. Targets are the two mutually exclusive
  // plain strings `ref` / `selector`; `ref` comes from browser_snapshot and never carries a
  // snapshotId — the Runtime keeps that provenance internally.


















  /* -------------------------------------------------------------------------------------------
   * Web T3 static vision (docs/t3-vision.md)
   *
   * Host responsibilities (docs/t3-vision.md): pure argument pre-checks (before
   * ensure/mkdir/CDP), source resolution + pin/release, the per-scope product store, the single
   * delivered PNG (P0 output rules + attachment), the unified `evidence.vision` v1 projection, and
   * the decision rules of `act` (§6) and `check` (§7). Pixel algorithms stay in vision-t3.js and
   * baseline storage in vision-baseline.js; neither module is modified here.
   * ----------------------------------------------------------------------------------------- */





















  // Environment-transition cleanup lives in the Web environment: the Host owns the config
  // notification, the Web runtime owns what a page release means (cancel → rotate → close).
  const webTransition = createWebTransition({
    log,
    registry,
    snapshotForScope: (scope) => crossEnvironment.snapshotForScope(scope),
  });
  const applyConfigTransition = (notification = {}) => webTransition.apply(notification);

  // Initial admission + re-admission on every successful config write: schema declaration follows
  // the same authoritative snapshot that execution uses (plan §5.1/§5.3, A08/A10), and the same
  // notification drives resource release for scopes that no longer own the Web environment (A12).
// The Web environment's tool descriptions and handlers live in the Web module. The Host keeps
  // only the decisions that are its own: admission, per-Agent disclosure and registration.
  const webToolSurface = createWebToolSurface({
    log, crossEnvironment, disclosure, registry, origins, httpClient, text, p0, ensureCaptureStagingRoot, DISCOVERY_TOOL,
  });
  webToolSurface.setAttachments(attachments);
  for (const definition of webToolSurface.definitions) register(definition);
  // Every other environment registers what it owns. A fixture therefore adds an entry plus its
  // implementation — nothing here changes (plan §4 验证扩展边界).
  for (const envEntry of environments.entries()) {
    if (!envEntry.tools || envEntry.tools.length === 0) continue;
    if (envEntry.testOnly && !crossEnvironment.allowTestEnvironments) continue;
    for (const definition of envEntry.tools) register(definition, envEntry.id);
  }

  syncToolVisibility();
  crossEnvironment.onConfigChange((notification) => {
    try { disclosure.refresh(); } catch (error) {
      log('ui-testing: disclosure refresh failed: ' + String((error && error.message) || error));
    }
    try { syncToolVisibility(); } catch (error) {
      log('ui-testing: tool visibility sync failed: ' + String((error && error.message) || error));
    }
    applyConfigTransition(notification).catch((error) => {
      log('ui-testing: config transition cleanup failed: ' + String((error && error.message) || error));
    });
  });
  // Returned for the fake-ctx acceptance harness only (Cordis ignores apply()'s return value);
  // production callers must keep using the HTTP/tool surface, not this handle.
  return { registry, syncToolVisibility, toolDefinitions, applyConfigTransition };
}
