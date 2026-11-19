/**
 * Web page routes of the debug panel: `/frame`, `/state`, `/metrics`, `/element`, `/select`,
 * `/annotations`, `/input`, `/context-menu`, `/screenshot`, `/tabs`, `/close`, `/navigate`,
 * `/display`, `/reload`, `/history`, `/viewport`.
 *
 * These are page semantics — resolve a page runtime, read its frames/state, drive its input, export
 * its canvas — so they belong to the Web environment. The Host keeps what is genuinely public:
 * authentication, scope-header parsing, the `ui.devtools` projection policy, the config/readiness
 * control plane, the error→status mapping and the page `lastError` projection.
 *
 * The Host hands over exactly these seams:
 *   `resolveScopeRequest(scopeRequest)`  — session/workspace resolution (Cordis services)
 *   `assertGuiAllowed(scopeRequest)`     — the environment-admission gate for GUI writes
 *   `requestRejection(req)` / `rejectUi(res, status)` — the legacy raw-UI gate
 *   `readJson(req)` / `sendJson(res, status, body)` / `scopeHttpStatus(code)`
 *   `SCOPE_TAB_PRIMARY` / `SCOPE_HEADER_FOREGROUND` — public scope-header vocabulary
 *   `state` — a mutable object in which this module records the entry it last touched, so the
 *             Host's error projection still knows which page failed.
 *
 * Dependency direction: `core/`, `browser-safety.js`, `select-control.js`, `context-menu.js` and the
 * Web runtime module. Nothing here imports `integration/` or the Host entry.
 */
import { BrowserError, asBrowserError } from '../../browser-safety.js';
import { applyPageContextAction, openPageContextMenu } from '../../context-menu.js';
import { normalizeSelectWriteRequest } from '../../select-control.js';
import { resolveScopedEntry } from './scope-target.js';
import {
  ANNOTATION_LIMITS, Runtime, elementPickRequest, ensureWebHostModules, expandViewPatch, headerValue,
  normalizeAnnotationPublish, normalizeViewportRequest, pickElementAt, readAnnotationBody,
} from './host.js';

/**
 * @param {object} options
 * @param {object} options.registry  page runtime registry (Web)
 */
export function createWebRoutes({
  log = () => {},
  registry,
  BrowserError: ErrorClass = BrowserError,
  asBrowserError: classify = asBrowserError,
} = {}) {
  /**
   * Dispatch one panel request. Returns `true` when this module answered it.
   */
  async function handleHttp(call) {
    // These routes drive a page, so the Web-only module chain (capture pipeline, frame source,
    // annotation capture) is resolved here — on the first real page request, never for the public
    // config/readiness control plane.
    try {
      await ensureWebHostModules();
    } catch (error) {
      log('ui-testing: web host modules unavailable: ' + String((error && error.message) || error));
    }
    return dispatchPageRoute(call);
  }

  async function dispatchPageRoute({
    req, res, url, action, scopeRequest = null, scoped = false, state = { selected: null },
    resolveScopeRequest, assertGuiAllowed, requestRejection, rejectUi,
    readJson, sendJson, scopeHttpStatus,
    SCOPE_TAB_PRIMARY = 'primary',
    SCOPE_HEADER_FOREGROUND = 'x-ui-testing-gui-foreground',
  }) {
    const select = async ({ create = true } = {}) => {
      const resolved = await resolveScopeRequest(scopeRequest);
      // One rule for every panel route and for the frame-push upgrade (`scope-target.js`): a
      // binding never creates a runtime, and a session-scoped request follows that Agent's
      // selected tab unless the caller asked for `scope-tab: primary`.
      let entry = resolveScopedEntry(registry, resolved, scopeRequest, { create, scopeTabPrimary: SCOPE_TAB_PRIMARY });
      if (entry && scoped && headerValue(req.headers, SCOPE_HEADER_FOREGROUND) === '1') {
        // Human-foreground claim (docs/viewport-control.md): the panel reports it on the requests
        // it makes for the tab it is displaying, so switching tabs/closing the panel/backgrounding
        // the GUI lets the claim expire instead of leaving a stale "somebody is watching" bit.
        entry.runtime.noteGuiForeground(entry.viewId);
      }
      return { resolved, entry };
    };
    const assertGuiPageWrite = (runtime, selfSessionId = null) => {
      // Configuration gate: a disabled/non-Web environment must not be bypassed through the
      // panel HTTP routes (the same snapshot as tool admission).
      assertGuiAllowed(scopeRequest);
      const lease = runtime && runtime.lease;
      if (lease && lease.sessionId !== selfSessionId && (runtime.active > 0 || lease.expiresAt > Date.now())) {
        throw new BrowserError('BUSY', '该标签正由 Agent 操作，GUI 输入暂不可用', { owner: lease.sessionId });
      }
    };
    // Scoped callers are owner-only by construction; legacy callers keep the old fail-closed
    // requestRejection projection. `ui.devtools` is scoped-only: the legacy uiState() shape must
    // not expose the loopback port/target id even to an accepted old client.
    const projected = (runtime) => (scoped || requestRejection(req) === 0
      ? runtime.uiState({ includeDevtools: scoped })
      : runtime.state());

    if (req.method === 'GET' && action === '/frame') {
      const since = Number(url.searchParams.get('since') || 0) || 0;
      const { entry } = await select();
      state.selected = entry;
      const runtime = entry.runtime;
      if (runtime.running) {
        runtime.refreshMetadataSoon();
        // The 80ms poll is the only "viewer alive" signal here: refresh the view cache so a page
        // that scrolled itself is visible in `ui.observed` on a later poll (200ms throttled).
        runtime.refreshViewObservationSoon();
      }
      sendJson(res, 200, runtime.framePayload(since, projected(runtime)));
      return true;
    }
    if (req.method === 'GET' && action === '/state') {
      const { entry, resolved } = await select();
      state.selected = entry;
      const runtime = entry.runtime;
      if (runtime.running) {
        runtime.refreshMetadataSoon();
        // Same for the 500ms GUI state poll: coalesced + ≥200ms throttled, no standing timer.
        runtime.refreshViewObservationSoon();
      }
      sendJson(res, 200, {
        ...projected(runtime),
        ...registry.providerFacts(entry, resolved),
      });
      return true;
    }
    if (req.method === 'GET' && action === '/metrics') {
      const { entry } = await select();
      state.selected = entry;
      sendJson(res, 200, entry.runtime.metrics());
      return true;
    }
    if (req.method === 'GET' && action === '/element') {
      // Explicit method contract (never a generic 400/405 fallthrough): /element is a POST read
      // with a body, and the route must not be reachable as a cacheless GET probe.
      const error = new BrowserError('INVALID_ARGUMENT', '/element 只接受 POST（body: {x,y,detail?}）');
      sendJson(res, 405, { ok: false, ...error.payload(), error: error.message });
      return true;
    }
    if (req.method !== 'POST') {
      const error = new BrowserError('INVALID_ARGUMENT', '只支持 GET /frame、/state、/metrics 与 POST 指令');
      sendJson(res, 405, { ok: false, ...error.payload(), error: error.message });
      return true;
    }
    if (action === '/annotations') {
      // P0-D annotations (docs/viewport-control.md): the ONLY write surface of the
      // human panel's annotation document — not a tool (the surface stays 36 tools).
      //   * scoped only: a legacy/unscoped request would have to guess a workspace, so it is
      //     refused instead of being mapped to `legacy:default`;
      //   * its own 262144-byte bounded body read (the other routes keep the 8MiB default);
      //   * no page queue, no lease, no ensure, no `lastError` — a refused publish is free.
      if (!scoped) {
        const error = new BrowserError('SCOPE_FORBIDDEN', '标注发布只接受 scopeVersion=1 且通过 browserPeer 鉴权的请求');
        sendJson(res, 403, { ok: false, ...error.payload(), error: error.message });
        return true;
      }
      assertGuiAllowed(scopeRequest);
      let ack;
      try {
        const request = normalizeAnnotationPublish(await readAnnotationBody(req, ANNOTATION_LIMITS.maxBodyBytes));
        const { entry } = await select();
        registry.touch(entry);
        ack = entry.runtime.acceptAnnotations(request);
      } catch (error) {
        const classified = asBrowserError(error);
        const reason = classified.details && typeof classified.details.reason === 'string' ? classified.details.reason : null;
        const mapped = scopeHttpStatus(classified.code);
        // 409 = the panel published against a documentKey/代次 that has already been rotated away
        // (zero writes); 400 = everything the Host refused to interpret. Never 5xx, never a
        // page error: the annotation surface must not pollute the page's `lastError`.
        const status = reason === 'annotation-context-stale' ? 409 : (mapped === 500 ? 400 : mapped);
        sendJson(res, status, { ok: false, ...classified.payload(), error: classified.message });
        return true;
      }
      sendJson(res, 200, { ok: true, ...ack });
      return true;
    }
    if (action === '/element') {
      // Read-only element pick for the debug view (POST /element, v1 contract): a pure DOM read.
      //   * NEVER calls ensure()/starts Chromium, never enters runtime.run (no serial queue, no
      //     single-owner lease, no BUSY) and records no client metrics nor agent/human mark;
      //   * never writes runtime.lastError: pickElementAt answers {element:null,reason} instead
      //     of throwing, and this route does not assign `state.selected`, so the shared error
      //     projection below (which only touches a state.selected runtime) cannot see it;
      //   * scoped requests already passed the strict owner-only gate; a legacy caller keeps the
      //     historical requestRejection gate — this route exposes page content, so an
      //     unauthenticated old client is refused instead of being mapped to legacy:default;
      //   * it owns its body read so an unreadable/invalid body is a 400 INVALID_ARGUMENT (the
      //     shared catch would answer 500 for that code, which is not this route's contract).
      if (!scoped) {
        const rejection = requestRejection(req);
        if (rejection) { rejectUi(res, rejection); return; }
      }
      let request;
      try {
        request = elementPickRequest(await readJson(req));
      } catch (error) {
        const classified = asBrowserError(error);
        sendJson(res, 400, { ok: false, ...classified.payload(), error: classified.message });
        return true;
      }
      const { entry } = await select({ create: false });
      const result = entry ? await pickElementAt(entry.runtime, request) : { element: null, reason: 'no-page' };
      sendJson(res, 200, result.element
        ? { ok: true, element: result.element }
        : { ok: true, element: null, reason: result.reason });
      return true;
    }
    const body = await readJson(req);
    if (action === '/metrics') {
      const { entry } = await select();
      state.selected = entry;
      entry.runtime.recordClientMetrics(body);
      // Optional annotation heartbeat (docs/viewport-control.md): only a heartbeat naming the
      // current source + accepted clientRevision (and, when given, the current documentKey)
      // refreshes lastSeenAt. It never rewrites shapes, the Host revision or lastError.
      entry.runtime.noteAnnotationHeartbeat(body);
      // Metrics is the panel's viewer heartbeat: a hidden/closed panel stops renewing and its
      // page becomes idle-collectable even if a leaked WS socket never sent a Close frame.
      entry.runtime.touchViewer();
      // Heartbeat only: front the previewed page, but never let a failed bringToFront escape as an
      // unhandled rejection (the panel is not waiting for it).
      entry.runtime.activate().catch(() => false);
      sendJson(res, 200, { ok: true, metrics: entry.runtime.metrics() });
      return true;
    }
    if (action === '/ensure') {
      // Environment gate (A10): a legacy/unscoped caller must not warm up (or navigate) a page
      // for an environment the configuration disabled. This runs for scoped *and* legacy
      // callers, before `select()` can create a page, so the bypass cannot resurrect Chromium.
      assertGuiAllowed(scopeRequest);
      const { entry } = await select();
      state.selected = entry;
      registry.touch(entry);
      // A URL here is a page write, not a warm-up: gate it exactly like /navigate so a GUI
      // caller cannot navigate a tab an Agent owns. The lease gate stays scoped-only; the
      // environment gate above applies to every caller.
      if (body.url && scoped) assertGuiPageWrite(entry.runtime, scopeRequest.mode === 'session' ? scopeRequest.sessionId : null);
      await entry.runtime.run(async () => {
        await entry.runtime.ensure();
        if (body.url) await entry.runtime.navigate(String(body.url));
      });
      registry.markRecent(entry);
      sendJson(res, 200, { ok: true, state: projected(entry.runtime) });
      return true;
    }
    if (action === '/navigate') {
      // Environment gate (A10): the legacy compatibility route used to skip every config check
      // unless the caller was scoped, so `enabledEnvironments=[]` still let it navigate.
      assertGuiAllowed(scopeRequest);
      const { entry } = await select();
      state.selected = entry;
      registry.touch(entry);
      // Legacy HTTP callers keep the historical no-lease path; authenticated GUI page writes
      // are the ones P0-E gates per tab.
      if (scoped) assertGuiPageWrite(entry.runtime, scopeRequest.mode === 'session' ? scopeRequest.sessionId : null);
      await entry.runtime.run(() => entry.runtime.navigate(String(body.url || '')));
      registry.markRecent(entry);
      sendJson(res, 200, { ok: true, state: projected(entry.runtime) });
      return true;
    }
    if (action === '/display') {
      // Web-view run mode: headless (default) vs headed (visible window + persistent profile).
      // A swap restarts the shared Chromium; the caller must reopen pages afterwards. This is a
      // lifecycle action, so it is GUI-only and carries no per-tab Agent lease gate.
      if (!scoped) {
        const rejection = requestRejection(req);
        if (rejection) { rejectUi(res, rejection); return; }
      }
      const host = registry.browserHost();
      await host.setDisplayMode(String(body.mode || ''));
      sendJson(res, 200, { ok: true, mode: host.display });
      return true;
    }
    if (action === '/reload') {
      // A10: reload/history are page writes too; the environment switch gates every caller.
      assertGuiAllowed(scopeRequest);
      // These two routes exist only for the authenticated GUI. Scoped callers already passed
      // the strict owner-only gate above; legacy callers keep the historical check.
      if (!scoped) {
        const rejection = requestRejection(req);
        if (rejection) { rejectUi(res, rejection); return; }
      }
      const { entry } = await select();
      state.selected = entry;
      registry.touch(entry);
      if (scoped) assertGuiPageWrite(entry.runtime, scopeRequest.mode === 'session' ? scopeRequest.sessionId : null);
      await entry.runtime.run(() => entry.runtime.reload());
      registry.markRecent(entry);
      sendJson(res, 200, { ok: true, state: entry.runtime.uiState({ includeDevtools: scoped }) });
      return true;
    }
    if (action === '/history') {
      assertGuiAllowed(scopeRequest); // A10: page write, same gate as /reload.
      if (!scoped) {
        const rejection = requestRejection(req);
        if (rejection) { rejectUi(res, rejection); return; }
      }
      const { entry } = await select();
      state.selected = entry;
      registry.touch(entry);
      if (scoped) assertGuiPageWrite(entry.runtime, scopeRequest.mode === 'session' ? scopeRequest.sessionId : null);
      const moved = await entry.runtime.run(() => entry.runtime.historyMove(String(body.direction || '')));
      registry.markRecent(entry);
      sendJson(res, 200, { ok: true, moved: moved.moved, state: entry.runtime.uiState({ includeDevtools: scoped }) });
      return true;
    }
    if (action === '/viewport') {
      // A10: changing the shared viewport is a page write; a disabled Web environment must not
      // drive it through the legacy GUI route.
      assertGuiAllowed(scopeRequest);
      // Two shapes (docs/viewport-control.md):
      //   legacy {width,height}                 -> historical Number/round/clamp, same reply
      //   v1 {version:1, ...patch, expectedRevision?, originId?} -> strict, same validation as
      //                                            the tool; replies also carry ui.view/observed.
      const { entry } = await select();
      state.selected = entry;
      registry.touch(entry);
      // Viewport configuration is not content input; preview/сize remains usable while an
      // Agent owns the tab (P0-E only gates page writes/input).
      if (body.version === undefined || body.version === null) {
        const viewport = await entry.runtime.run(async () => {
          await entry.runtime.ensure();
          return entry.runtime.applyViewport(Number(body.width), Number(body.height));
        });
        registry.markRecent(entry);
        sendJson(res, 200, {
          ok: true,
          viewport,
          // Additive projections: an old client ignores them, the new one adopts them.
          view: entry.runtime.viewProjection(),
          observed: entry.runtime.observedProjection(),
          viewMeta: entry.runtime.viewMeta(),
          requested: { width: Number(body.width), height: Number(body.height) },
          clamped: { x: false, y: false, canvasX: false, canvasY: false },
          applied: true,
          settled: true,
          state: projected(entry.runtime),
        });
        return true;
      }
      if (body.version !== 1) {
        throw new BrowserError('INVALID_ARGUMENT', 'version 只支持 1（省略则为旧形状 {width,height}）', {
          field: 'version', valueType: typeof body.version,
        });
      }
      const originId = body.originId === undefined || body.originId === null ? null : body.originId;
      if (originId !== null && (typeof originId !== 'string' || !/^[\x20-\x7e]{1,64}$/.test(originId))) {
        throw new BrowserError('INVALID_ARGUMENT', 'originId 必须是 ≤64 个可打印 ASCII 字符（可省略）', {
          field: 'originId', valueType: typeof originId,
        });
      }
      const { version: _version, originId: _originId, ...patchFields } = body;
      const request = normalizeViewportRequest({ action: 'set', ...patchFields });
      const result = await entry.runtime.run(() => entry.runtime.applyView(expandViewPatch(request.patch), {
        source: 'gui', originId, expectedRevision: request.expectedRevision,
      }));
      registry.markRecent(entry);
      sendJson(res, 200, {
        ok: true,
        viewport: { width: result.view.width, height: result.view.height },
        view: result.view,
        // Additive canvas-space facts (docs/viewport-control.md step 7 / §4).
        canvasX: result.canvasX,
        canvasY: result.canvasY,
        offset: result.offset,
        content: result.content,
        observed: result.observed,
        viewMeta: result.viewMeta,
        requested: request.requested,
        clamped: result.clamped,
        applied: true,
        settled: result.settled,
        state: projected(entry.runtime),
      });
      return true;
    }
    if (action === '/input') {
      assertGuiAllowed(scopeRequest); // A10: same environment gate as /navigate.
      const { entry } = await select();
      state.selected = entry;
      registry.touch(entry);
      if (scoped) assertGuiPageWrite(entry.runtime, scopeRequest.mode === 'session' ? scopeRequest.sessionId : null);
      const events = Array.isArray(body.events) ? body.events : [];
      // Only an authenticated scoped GUI click/key gets a one-shot popup ticket.
      if (scoped) entry.runtime.host.noteGuiInput(entry.runtime, events);
      const applied = await entry.runtime.run(() => {
        entry.runtime.touchHuman();
        return entry.runtime.input(events);
      });
      registry.markRecent(entry);
      sendJson(res, 200, { ok: true, applied });
      return true;
    }
    if (action === '/context-menu' || action === '/context-action') {
      assertGuiAllowed(scopeRequest);
      const { entry } = await select();
      state.selected = entry;
      registry.touch(entry);
      if (scoped) assertGuiPageWrite(entry.runtime, scopeRequest.mode === 'session' ? scopeRequest.sessionId : null);
      const result = await entry.runtime.run(async () => {
        entry.runtime.touchHuman();
        return action === '/context-menu'
          ? openPageContextMenu(entry.runtime, body)
          : applyPageContextAction(entry.runtime, body);
      });
      registry.markRecent(entry);
      sendJson(res, 200, { ok: true, ...result, state: projected(entry.runtime) });
      return true;
    }
    if (action === '/select') {
      // Panel-side native <select> write (POST /select, body {value, selector?}).
      //
      // Why this exists: the popup of a native <select> is drawn by the browser UI layer, so the
      // panel's frame shows nothing and a mouse user cannot pick an option. The panel renders its
      // own list (POST /element gives it the options) and writes the chosen value back here.
      //
      // Gate order is byte-for-byte the same as `/input` — environment/config gate, scoped
      // ownership + lease (BUSY), body validation, and only then the serial queue + dispatch:
      //   * `assertGuiAllowed(scopeRequest)` first (A10: a disabled Web
      //     environment must not be bypassed through a panel route);
      //   * `assertGuiPageWrite` before anything reaches the page, so a refused write dispatches
      //     nothing at all (the tests assert the interception point, not a message);
      //   * the body is validated outside `runtime.run`, so a bad request costs zero CDP;
      //   * `runtime.run` gives the same single-owner serial queue and lease semantics as input.
      // A refusal is a panel-facing input answer: INVALID_ARGUMENT is in NON_PAGE_ERROR_CODES, so
      // a rejected value never overwrites the page's `lastError` projection.
      assertGuiAllowed(scopeRequest); // A10: same environment gate as /input.
      const { entry } = await select();
      state.selected = entry;
      registry.touch(entry);
      if (scoped) assertGuiPageWrite(entry.runtime, scopeRequest.mode === 'session' ? scopeRequest.sessionId : null);
      const request = normalizeSelectWriteRequest(body);
      if (!request.ok) {
        const refused = new BrowserError(request.code, request.message, request.details);
        sendJson(res, scopeHttpStatus(request.code), { ok: false, ...refused.payload(), error: refused.message });
        return true;
      }
      const applied = await entry.runtime.run(() => entry.runtime.selectValue(request));
      registry.markRecent(entry);
      sendJson(res, 200, { ok: true, value: applied.value, selectedIndex: applied.selectedIndex, selector: request.selector });
      return true;
    }
    if (action === '/eval') {
      assertGuiAllowed(scopeRequest); // A10: same environment gate as /navigate.
      const { entry } = await select();
      state.selected = entry;
      registry.touch(entry);
      if (scoped) assertGuiPageWrite(entry.runtime, scopeRequest.mode === 'session' ? scopeRequest.sessionId : null);
      const result = await entry.runtime.run(() => entry.runtime.evaluate(String(body.expression || 'undefined')));
      registry.markRecent(entry);
      sendJson(res, 200, result.ok === false ? { ...result, ...result.error, error: result.error.message } : result);
      return true;
    }
    if (action === '/screenshot') {
      assertGuiAllowed(scopeRequest);
      const { entry } = await select();
      state.selected = entry;
      registry.touch(entry);
      // `canvas:true` enables the canvas-space seed provenance (O = 0 keeps the raw single-CDP
      // PNG path). Empty/legacy bodies keep the historical raw reply shape byte-for-byte.
      const canvas = body && typeof body === 'object' && body.canvas === true;
      // `includeAnnotations:true` (annot bar → 截图): the panel asks for the SAME composited
      // capture the agent's `browser_screenshot{includeAnnotations:true}` produces, so the human
      // can hand its own page+notes to the chat as one image. It goes through `capture()`, i.e.
      // the documented canvas-space path, and therefore also carries `capture`.
      const includeAnnotations = body && typeof body === 'object' && body.includeAnnotations === true;
      // The panel's seed capture is a display request, not a lifecycle action: a closed primary
      // must stay closed (the empty tab state), otherwise every panel mount would resurrect a
      // blank tab. Agent screenshot calls go through the tool runtime, not this GUI route.
      if (!entry.runtime.running) {
        sendJson(res, 200, { ok: true, closed: true, image: null, capturedAt: Date.now() });
        return true;
      }
      const shot = includeAnnotations
        ? await entry.runtime.run(() => entry.runtime.capture({ scale: 1, includeAnnotations: true }))
        : await entry.runtime.run(() => entry.runtime.screenshot(canvas ? { canvas: true } : {}));
      registry.markRecent(entry);
      const capture = shot.capture || null;
      const viewport = capture && capture.viewport ? capture.viewport : null;
      sendJson(res, 200, {
        ok: true,
        image: shot.base64,
        viewport: viewport || shot.viewport || null,
        capturedAt: (capture && capture.capturedAt) || shot.capturedAt || Date.now(),
        ...(includeAnnotations ? {
          capture,
          // Same metadata the tool reports: revision/context/source/truncation of the frozen
          // document, so the panel can say which document the picture shows.
          annotations: (capture && capture.annotations) || null,
        } : canvas ? { view: shot.view, capture } : {}),
      });
      return true;
    }
    if (action === '/tabs') {
      assertGuiAllowed(scopeRequest);
      const { entry } = await select();
      state.selected = entry;
      const primary = registry.primaryEntry(entry) || entry;
      const guiSession = 'gui:panel';
      const tabAction = String(body.action || 'list');
      if (tabAction === 'list') {
        sendJson(res, 200, { ok: true, action: tabAction, tabs: registry.listTabs(primary, guiSession) });
        return true;
      }
      if (tabAction === 'open') {
        const opened = await registry.openTab(primary, guiSession, 'gui', { select: false });
        sendJson(res, 200, { ok: true, action: tabAction, tabId: opened.entry.tabId || opened.entry.viewId, state: projected(opened.entry.runtime) });
        return true;
      }
      if (tabAction === 'close') {
        const tabId = typeof body.tabId === 'string' && body.tabId ? body.tabId : undefined;
        const closed = await registry.closeTab(primary, guiSession, tabId, { gui: true });
        sendJson(res, 200, { ok: true, action: tabAction, tabId: closed.closed });
        return true;
      }
      if (tabAction === 'lock' || tabAction === 'unlock') {
        // Human-only keep-alive: this route is the single write surface for the lock. No Agent tool
        // carries it, so a model can neither pin a page awake nor unpin one the user pinned. A
        // missing tabId is refused instead of defaulting to primary: a blind lock must never land
        // on a page the panel is not showing.
        const tabId = typeof body.tabId === 'string' && body.tabId ? body.tabId : undefined;
        if (!tabId) throw new BrowserError('INVALID_ARGUMENT', tabAction + '.tabId 不能为空', { field: 'tabId' });
        const locked = registry.setTabLock(primary, tabId, tabAction === 'lock');
        sendJson(res, 200, { ok: true, action: tabAction, ...locked });
        return true;
      }
      throw new BrowserError('INVALID_ARGUMENT', 'tabs.action 只支持 list/open/close/lock/unlock', { field: 'action' });
    }
    if (action === '/close') {
      // Close only the state.selected scope. The registry entry stays (cold) so its runtimeId and
      // scope binding remain stable; the shared host exits only when no page is left.
      const { entry } = await select({ create: false });
      state.selected = entry;
      if (!entry) {
        // A scoped close that names no live runtime must not answer ok:true: the panel would
        // drop its tab locally while the Host kept the page (an unresolved scope binding used to
        // look like a successful close). Legacy callers keep the historical idempotent reply.
        if (!scoped) {
          sendJson(res, 200, { ok: true });
          return true;
        }
        const error = new BrowserError('SCOPE_NOT_FOUND', '关闭请求指向的运行时不存在', { scope: 'binding' });
        sendJson(res, 404, { ok: false, ...error.payload(), error: error.message });
        return true;
      }
      registry.touch(entry);
      // P0-E: primary close only makes it cold; child tabs stay live. Closing a page is a
      // lifecycle action, not page input, so it is not gated by the per-tab Agent lease;
      // browser_tabs.close keeps its own session/lease rule.
      await entry.runtime.run(() => entry.runtime.close());
      sendJson(res, 200, { ok: true });
      return true;
    }
    return false;
  }

  /**
   * Record a panel-route failure on the page the request touched.
   *
   * The Host decides *what counts as a page failure* (`NON_PAGE_ERROR_CODES` is its public
   * vocabulary); writing it onto the live page is the runtime's job, so the Host calls this
   * instead of dereferencing `entry.runtime`.
   */
  function noteHttpError(entry, message) {
    const runtime = entry?.runtime;
    if (!runtime || typeof runtime.setError !== 'function') return false;
    try {
      runtime.setError(String(message ?? ''), {
        actionId: null,
        target: runtime.url ? redactUrl(runtime.url) : null,
      });
      return true;
    } catch {
      return false;
    }
  }

  return { handleHttp, noteHttpError };
}
