/*
 * Page-side truth ledger for the WEB-T4 dynamic-network fixture.
 * Served at GET /t4/network/t4-network-ledger.js and loaded by /web-t4-network.html.
 *
 * Contract: tests/ui_test_fixture/t4-prep-contract.md §2 (frozen) + the truth table in
 * tests/ui_test_fixture/t4-network.md. Plain browser JavaScript: no CDP dependency, no randomness,
 * no clock-derived payloads (atMs is page-relative logical ms, atWallMs is Date.now() and is only
 * for correlation, never for structural equality).
 *
 * Frozen values: runId=t4-run-1, traceId=t4-trace-1, orderId=ORD-T4-1, unit price 4200 (¥42.00).
 * Every business request carries:
 *   x-request-id: t4-req-<n>          (unique per request, echoed by the server ledger)
 *   x-trace-id:   t4-trace-1          (fixed for the whole run)
 *   x-op-id:      op-<n>              (the UI/API operation that caused it)
 *   x-idempotency-key: <key>          (POST: op key; GET: t4-idem-get-<n>)
 *
 * window.__t4.net = {
 *   version, fixture, runId, traceId, scenario,
 *   ops[], requests[], responses[], ui[], ws{state,frames[]}, sse{state,events[]}, polls[],
 *   errors[], serverLedgerUrl,
 *   methods{state, reset, setScenario, addToCart, checkout, retryOrder, cancelOrder, snapshot},
 *   // the same methods are also callable directly (__t4.net.state() etc.)
 * }
 *
 * Scenario semantics (contract §2): normal / no-ws / no-sse / poll-off / dup / fail-cart /
 * fail-order / slow-order. `setScenario` resets the server state AND the local ledger, then
 * reconnects the channels allowed by the new scenario. `reset` clears both but leaves the channels
 * closed (documented in t4-network.md: call setScenario to reconnect).
 */
(function () {
  'use strict';

  var RUN_ID = 't4-run-1';
  var TRACE_ID = 't4-trace-1';
  var ORDER_ID = 'ORD-T4-1';
  var PRICE = 4200;
  var MAIN_SKU = 'sku-t4-main';
  var ORDER_KEY = 't4-idem-order-1';
  var SCENARIOS = ['normal', 'no-ws', 'no-sse', 'poll-off', 'dup', 'fail-cart', 'fail-order', 'slow-order'];
  var STATUS_TEXT = { pending: '待支付', paid: '已支付', fulfilled: '已完成', cancelled: '已取消' };
  var POLL_DELAYS = [200, 400, 600];

  var bootWallMs = Date.now();
  var counters = { req: 0, op: 0, cartOp: 0, wsFrame: 0, sseEvent: 0, poll: 0 };

  var net = {
    version: 1,
    fixture: 'web-t4-network',
    runId: RUN_ID,
    traceId: TRACE_ID,
    scenario: 'normal',
    ops: [],
    requests: [],
    responses: [],
    ui: [],
    ws: { state: 'closed', frames: [] },
    sse: { state: 'closed', events: [] },
    polls: [],
    errors: [],
    serverLedgerUrl: '/api/t4/ledger?runId=' + RUN_ID,
    methods: null
  };
  window.__t4 = window.__t4 || {};
  window.__t4.net = net;

  var cart = { count: 0, revision: 0, items: [] };
  var order = { orderId: null, status: null, total: 0 };
  var qty = 1;
  var wsSocket = null;
  var sseSource = null;
  var pollTimers = [];
  var busy = false;
  var lastError = '';

  function el(id) { return document.getElementById(id); }
  function nowMs() { return Math.max(0, Date.now() - bootWallMs); }
  function money(fen) { return '¥ ' + (Number(fen || 0) / 100).toFixed(2); }

  function setStage(stage) {
    document.body.setAttribute('data-t4n-stage', stage);
    var target = el('t4n-status');
    if (target) target.textContent = stage;
  }

  /* --------------------------------------------------------------------------------------------
   * UI transitions (single source of "what changed, and what caused it")
   * ------------------------------------------------------------------------------------------ */

  function transition(key, from, to, cause) {
    if (from === to) return false;
    net.ui.push({
      key: key,
      from: from,
      to: to,
      atMs: nowMs(),
      atWallMs: Date.now(),
      cause: cause || { kind: 'ui', id: key }
    });
    return true;
  }

  function snapshotCart() {
    return {
      count: cart.count,
      revision: cart.revision,
      items: cart.items.map(function (item) { return { sku: item.sku, qty: item.qty, price: item.price }; })
    };
  }

  function snapshotOrder() {
    return { orderId: order.orderId, status: order.status, total: order.total };
  }

  function renderCart() {
    var countEl = el('t4n-cart-count');
    if (countEl) countEl.textContent = String(cart.count);
    var revisionEl = el('t4n-cart-revision');
    if (revisionEl) revisionEl.textContent = 'revision ' + cart.revision;
    var list = el('t4n-cart-list');
    if (list) {
      if (!cart.items.length) {
        list.innerHTML = '<li data-empty="true">购物车为空</li>';
      } else {
        list.innerHTML = cart.items.map(function (item) {
          return '<li data-sku="' + item.sku + '" data-qty="' + item.qty + '">'
            + item.sku + ' × ' + item.qty + ' · ' + money(item.price * item.qty) + '</li>';
        }).join('');
      }
    }
    renderOrderBanner();
  }

  function renderOrder() {
    var idEl = el('t4n-order-id');
    if (idEl) idEl.textContent = order.orderId || '—';
    var statusEl = el('t4n-order-status');
    if (statusEl) statusEl.textContent = STATUS_TEXT[order.status] || '未创建';
    var cancel = el('t4n-cancel-order');
    if (cancel) cancel.disabled = !order.orderId || order.status === 'cancelled';
    var checkout = el('t4n-checkout');
    if (checkout) checkout.disabled = Boolean(order.orderId) && order.status !== 'cancelled';
    renderOrderBanner();
  }

  function renderOrderBanner() {
    var banner = el('t4n-order-banner');
    if (!banner) return;
    if (!order.orderId) banner.textContent = '尚未创建订单';
    else banner.textContent = '订单 ' + order.orderId + ' · ' + (STATUS_TEXT[order.status] || order.status)
      + ' · 合计 ' + money(order.total);
  }

  function renderPolls() {
    var target = el('t4n-poll-count');
    if (target) target.textContent = String(net.polls.length);
  }

  function setWsState(next, cause) {
    var prev = net.ws.state;
    net.ws.state = next;
    if (prev !== next) transition('ws.state', prev, next, cause || { kind: 'ws', id: 'ws-state' });
    var target = el('t4n-ws-state');
    if (target) target.textContent = next;
  }

  function setSseState(next, cause) {
    var prev = net.sse.state;
    net.sse.state = next;
    if (prev !== next) transition('sse.state', prev, next, cause || { kind: 'sse', id: 'sse-state' });
    var target = el('t4n-sse-state');
    if (target) target.textContent = next;
  }

  /* --------------------------------------------------------------------------------------------
   * Truth application
   * ------------------------------------------------------------------------------------------ */

  function applyCart(next, cause) {
    if (!next) return false;
    var prevCount = cart.count;
    var prevRevision = cart.revision;
    cart = {
      count: Number(next.count) || 0,
      revision: Number(next.revision) || 0,
      items: (next.items || []).map(function (item) {
        return { sku: item.sku, qty: item.qty, price: item.price };
      })
    };
    var changedCount = transition('cart.count', prevCount, cart.count, cause);
    var changedRevision = transition('cart.revision', prevRevision, cart.revision, cause);
    renderCart();
    return changedCount || changedRevision;
  }

  function applyOrder(next, cause) {
    if (!next || !next.orderId) return false;
    var prevStatus = order.status || 'none';
    var total = Number(next.total);
    order = {
      orderId: next.orderId,
      status: next.status,
      total: Number.isFinite(total) && total > 0 ? total : order.total
    };
    var changed = transition('order.status', prevStatus, order.status, cause);
    renderOrder();
    return changed;
  }

  function applyFailure(result, prefix) {
    var record = result.record;
    var code = (record.error && record.error.code) || 'UNKNOWN';
    net.errors.push({ atMs: nowMs(), atWallMs: Date.now(), code: code, requestId: record.requestId });
    var message = prefix + '：' + code;
    lastError = message;
    var errorEl = el('t4n-error');
    if (errorEl) {
      errorEl.textContent = message;
      errorEl.hidden = false;
    }
    transition('error', '', message, { kind: 'request', id: record.requestId });
    // The retry control is only meaningful for a failed order creation (contract §2).
    if (prefix.indexOf('订单') === 0) {
      var retry = el('t4n-retry');
      if (retry) retry.hidden = false;
    }
    setStage('error');
  }

  function clearError(cause) {
    var errorEl = el('t4n-error');
    if (!errorEl || errorEl.hidden) return false;
    var previous = lastError;
    errorEl.textContent = '';
    errorEl.hidden = true;
    lastError = '';
    transition('error', previous, '', cause || { kind: 'ui', id: 'clear-error' });
    var retry = el('t4n-retry');
    if (retry) retry.hidden = true;
    return true;
  }

  /* --------------------------------------------------------------------------------------------
   * Ops + requests (the page-side ledger the acceptance suite reads)
   * ------------------------------------------------------------------------------------------ */

  function findOp(opId) {
    for (var index = 0; index < net.ops.length; index += 1) {
      if (net.ops[index].opId === opId) return net.ops[index];
    }
    return null;
  }

  function beginOp(kind, target) {
    counters.op += 1;
    var op = {
      opId: 'op-' + counters.op,
      kind: kind,
      target: target,
      atMs: nowMs(),
      atWallMs: Date.now(),
      traceId: TRACE_ID,
      idempotencyKey: null,
      requestIds: []
    };
    net.ops.push(op);
    return op;
  }

  function nextRequestId() {
    counters.req += 1;
    return 't4-req-' + counters.req;
  }

  function apiRequest(options) {
    var requestId = nextRequestId();
    var idempotencyKey = options.idempotencyKey || ('t4-idem-get-' + counters.req);
    var startedWall = Date.now();
    var record = {
      requestId: requestId,
      opId: options.opId,
      method: options.method,
      url: options.path,
      atMs: nowMs(),
      atWallMs: startedWall,
      status: 0,
      ok: false,
      duplicate: false,
      retried: false,
      traceId: TRACE_ID,
      idempotencyKey: idempotencyKey,
      durationMs: 0,
      error: null
    };
    net.requests.push(record);
    var op = findOp(options.opId);
    if (op) op.requestIds.push(requestId);

    var headers = {
      'x-request-id': requestId,
      'x-trace-id': TRACE_ID,
      'x-op-id': options.opId,
      'x-idempotency-key': idempotencyKey
    };
    var init = { method: options.method, headers: headers, cache: 'no-store' };
    if (options.body !== undefined) {
      headers['content-type'] = 'application/json';
      init.body = JSON.stringify(options.body);
    }

    return fetch(options.path, init).then(function (response) {
      return response.text().then(function (text) {
        var parsed = null;
        try { parsed = text ? JSON.parse(text) : null; } catch (error) { parsed = null; }
        record.status = response.status;
        record.ok = response.ok && Boolean(parsed) && !(parsed && parsed.error && parsed.error.code);
        record.durationMs = Date.now() - startedWall;
        record.duplicate = Boolean(parsed && parsed.deduped);
        record.retried = Boolean(parsed && parsed.retried);
        if (!record.ok) {
          record.error = { code: (parsed && parsed.error && parsed.error.code) || ('HTTP_' + response.status) };
        }
        net.responses.push({
          requestId: requestId,
          atMs: nowMs(),
          atWallMs: Date.now(),
          status: response.status,
          traceId: TRACE_ID,
          deduped: record.duplicate,
          body: parsed
        });
        return { record: record, body: parsed, status: response.status, ok: record.ok };
      });
    }).catch(function (error) {
      record.status = 0;
      record.ok = false;
      record.durationMs = Date.now() - startedWall;
      record.error = { code: 'NETWORK_ERROR' };
      net.responses.push({
        requestId: requestId,
        atMs: nowMs(),
        atWallMs: Date.now(),
        status: 0,
        traceId: TRACE_ID,
        deduped: false,
        body: null
      });
      return {
        record: record,
        body: null,
        status: 0,
        ok: false,
        networkError: String((error && error.message) || error)
      };
    });
  }

  function cartTotal() {
    return cart.items.reduce(function (sum, item) { return sum + item.price * item.qty; }, 0);
  }

  /* --------------------------------------------------------------------------------------------
   * Business operations
   * ------------------------------------------------------------------------------------------ */

  function addToCart(options) {
    var opts = options || {};
    var source = opts.source === 'click' ? 'click' : 'api';
    var amount = Number.isFinite(opts.qty) && opts.qty > 0 ? Math.min(Math.round(opts.qty), 9) : qty;
    var double = opts.double === true;
    var op = beginOp(source === 'click' ? 'click' : 'api', '#t4n-add-cart');
    counters.cartOp += 1;
    var idempotencyKey = 't4-idem-cart-' + counters.cartOp;
    op.idempotencyKey = idempotencyKey;
    setStage('busy');

    var body = { runId: RUN_ID, sku: MAIN_SKU, qty: amount };
    var sent = [];

    return apiRequest({ opId: op.opId, method: 'POST', path: '/api/t4/cart', body: body, idempotencyKey: idempotencyKey })
      .then(function (first) {
        sent.push(first);
        if (!first.ok) return null;
        if (!double) return { ok: true };
        return apiRequest({ opId: op.opId, method: 'POST', path: '/api/t4/cart', body: body, idempotencyKey: idempotencyKey })
          .then(function (second) {
            sent.push(second);
            return second.ok ? { ok: true } : null;
          });
      })
      .then(function (state) {
        if (!state) {
          var failed = sent[sent.length - 1];
          applyFailure(failed, '购物车更新失败');
          return { ok: false, opId: op.opId, requestIds: op.requestIds.slice(), error: failed.record.error };
        }
        return apiRequest({ opId: op.opId, method: 'GET', path: '/api/t4/cart' }).then(function (refresh) {
          if (!refresh.ok) {
            applyFailure(refresh, '购物车刷新失败');
            return { ok: false, opId: op.opId, requestIds: op.requestIds.slice(), error: refresh.record.error };
          }
          applyCart(refresh.body && refresh.body.cart, { kind: 'response', id: refresh.record.requestId });
          clearError({ kind: 'response', id: refresh.record.requestId });
          setStage('idle');
          return {
            ok: true,
            opId: op.opId,
            requestIds: op.requestIds.slice(),
            cart: snapshotCart(),
            duplicates: sent.filter(function (entry) { return entry.record.duplicate; }).length
          };
        });
      });
  }

  function openSse() {
    closeSse('reopen');
    if (net.scenario === 'no-sse') {
      setSseState('disabled', { kind: 'sse', id: 'sse-disabled' });
      return;
    }
    setSseState('open', { kind: 'sse', id: 'sse-open' });
    var source;
    try {
      source = new EventSource('/api/t4/order-events?orderId=' + encodeURIComponent(order.orderId || ORDER_ID));
    } catch (error) {
      setSseState('closed', { kind: 'sse', id: 'sse-error' });
      return;
    }
    sseSource = source;
    source.addEventListener('order', function (event) {
      var data = null;
      try { data = JSON.parse(event.data); } catch (error) { data = null; }
      counters.sseEvent += 1;
      net.sse.events.push({
        type: 'order',
        data: data,
        id: event.lastEventId || null,
        atMs: nowMs(),
        atWallMs: Date.now()
      });
      if (data) {
        applyOrder(
          { orderId: data.orderId, status: data.status, total: order.total },
          { kind: 'sse', id: 'sse-' + counters.sseEvent }
        );
      }
    });
    source.onerror = function () { closeSse('server'); };
  }

  function closeSse(reason) {
    var source = sseSource;
    sseSource = null;
    if (source) {
      try { source.close(); } catch (error) { /* already closed */ }
    }
    if (net.sse.state === 'open') {
      setSseState('closed', { kind: 'sse', id: 'sse-close-' + reason });
    }
  }

  function clearPollTimers() {
    pollTimers.forEach(function (timer) { clearTimeout(timer); });
    pollTimers = [];
  }

  function pollOnce(opId) {
    return apiRequest({ opId: opId, method: 'GET', path: '/api/t4/orders/' + ORDER_ID }).then(function (result) {
      if (!result.ok) return;
      counters.poll += 1;
      net.polls.push({
        requestId: result.record.requestId,
        orderId: ORDER_ID,
        atMs: nowMs(),
        atWallMs: Date.now()
      });
      renderPolls();
      var next = result.body && result.body.order;
      if (next) applyOrder(next, { kind: 'poll', id: result.record.requestId });
    });
  }

  function startPolls(opId) {
    clearPollTimers();
    renderPolls();
    if (net.scenario === 'poll-off') return;
    POLL_DELAYS.forEach(function (delay) {
      pollTimers.push(setTimeout(function () { void pollOnce(opId); }, delay));
    });
  }

  function checkout(options) {
    var opts = options || {};
    var source = opts.source === 'click' ? 'click' : 'api';
    if (order.orderId && order.status !== 'cancelled') {
      return Promise.resolve({ ok: true, alreadyOrdered: true, order: snapshotOrder() });
    }
    var op = beginOp(source === 'click' ? 'click' : 'api', '#t4n-checkout');
    op.idempotencyKey = ORDER_KEY;
    setStage('busy');
    return apiRequest({
      opId: op.opId,
      method: 'POST',
      path: '/api/t4/orders',
      body: { runId: RUN_ID, cartRevision: cart.revision, total: cartTotal() },
      idempotencyKey: ORDER_KEY
    }).then(function (result) {
      if (!result.ok) {
        applyFailure(result, '订单创建失败');
        return { ok: false, opId: op.opId, requestIds: op.requestIds.slice(), error: result.record.error };
      }
      applyOrder(result.body && result.body.order, { kind: 'response', id: result.record.requestId });
      clearError({ kind: 'response', id: result.record.requestId });
      openSse();
      startPolls(op.opId);
      setStage('ordered');
      return {
        ok: true,
        opId: op.opId,
        requestIds: op.requestIds.slice(),
        order: snapshotOrder(),
        retried: result.record.retried,
        deduped: result.record.duplicate
      };
    });
  }

  function retryOrder(options) {
    var opts = options || {};
    var source = opts.source === 'click' ? 'click' : 'api';
    var op = beginOp(source === 'click' ? 'click' : 'api', '#t4n-retry');
    op.idempotencyKey = ORDER_KEY;
    setStage('busy');
    return apiRequest({
      opId: op.opId,
      method: 'POST',
      path: '/api/t4/orders',
      body: { runId: RUN_ID, cartRevision: cart.revision, total: cartTotal() },
      idempotencyKey: ORDER_KEY
    }).then(function (result) {
      if (!result.ok) {
        applyFailure(result, '订单创建失败');
        return { ok: false, opId: op.opId, requestIds: op.requestIds.slice(), error: result.record.error };
      }
      applyOrder(result.body && result.body.order, { kind: 'response', id: result.record.requestId });
      clearError({ kind: 'response', id: result.record.requestId });
      openSse();
      startPolls(op.opId);
      setStage('ordered');
      return {
        ok: true,
        opId: op.opId,
        requestIds: op.requestIds.slice(),
        order: snapshotOrder(),
        retried: result.record.retried,
        deduped: result.record.duplicate
      };
    });
  }

  function cancelOrder(options) {
    var opts = options || {};
    var source = opts.source === 'click' ? 'click' : 'api';
    if (!order.orderId) {
      return Promise.resolve({ ok: false, error: { code: 'NO_ORDER' } });
    }
    var op = beginOp(source === 'click' ? 'click' : 'api', '#t4n-cancel-order');
    op.idempotencyKey = 't4-idem-cancel-' + counters.op;
    setStage('busy');
    return apiRequest({
      opId: op.opId,
      method: 'POST',
      path: '/api/t4/orders/' + encodeURIComponent(order.orderId) + '/cancel',
      idempotencyKey: op.idempotencyKey
    }).then(function (result) {
      if (!result.ok) {
        applyFailure(result, '取消订单失败');
        return { ok: false, opId: op.opId, requestIds: op.requestIds.slice(), error: result.record.error };
      }
      applyOrder(result.body && result.body.order, { kind: 'response', id: result.record.requestId });
      clearError({ kind: 'response', id: result.record.requestId });
      setStage('cancelled');
      return { ok: true, opId: op.opId, requestIds: op.requestIds.slice(), order: snapshotOrder() };
    });
  }

  /* --------------------------------------------------------------------------------------------
   * Channels (WS / SSE)
   * ------------------------------------------------------------------------------------------ */

  function sendWsFrame(payload) {
    if (!wsSocket || wsSocket.readyState !== 1) return false;
    var text = JSON.stringify(payload);
    wsSocket.send(text);
    counters.wsFrame += 1;
    net.ws.frames.push({
      direction: 'out',
      type: payload.type || 'text',
      data: payload,
      frameId: 'ws-out-' + counters.wsFrame,
      atMs: nowMs(),
      atWallMs: Date.now()
    });
    return true;
  }

  function closeWs() {
    var socket = wsSocket;
    wsSocket = null;
    if (socket) {
      try { socket.close(); } catch (error) { /* already closed */ }
    }
    if (net.ws.state === 'open') {
      setWsState('closed', { kind: 'ws', id: 'ws-close' });
    }
  }

  function connectWs() {
    closeWs();
    if (net.scenario === 'no-ws') {
      setWsState('disabled', { kind: 'ws', id: 'ws-disabled' });
      return;
    }
    var scheme = location.protocol === 'https:' ? 'wss://' : 'ws://';
    var socket;
    try {
      socket = new WebSocket(scheme + location.host + '/t4/ws?runId=' + RUN_ID);
    } catch (error) {
      setWsState('closed', { kind: 'ws', id: 'ws-error' });
      return;
    }
    wsSocket = socket;
    socket.onopen = function () {
      setWsState('open', { kind: 'ws', id: 'ws-open' });
      sendWsFrame({ type: 'ping', nonce: 't4-ping-1' });
    };
    socket.onmessage = function (event) {
      var data = null;
      try { data = JSON.parse(event.data); } catch (error) { data = event.data; }
      counters.wsFrame += 1;
      var frameId = (data && typeof data === 'object' && data.frameId) || ('ws-frame-' + counters.wsFrame);
      net.ws.frames.push({
        direction: 'in',
        type: (data && typeof data === 'object' && data.type) || 'text',
        data: data,
        frameId: frameId,
        atMs: nowMs(),
        atWallMs: Date.now()
      });
      if (data && typeof data === 'object' && data.type === 'cart-updated') {
        applyCart(data.cart, { kind: 'ws', id: frameId });
        setStage('cart-updated');
      }
    };
    socket.onclose = function () { setWsState('closed', { kind: 'ws', id: 'ws-close' }); };
    socket.onerror = function () { setWsState('closed', { kind: 'ws', id: 'ws-error' }); };
  }

  /* --------------------------------------------------------------------------------------------
   * Reset / scenario
   * ------------------------------------------------------------------------------------------ */

  /** Server-side reset only. Internal control request: deliberately NOT recorded in the ledger. */
  function postReset(scenario) {
    var headers = {
      'content-type': 'application/json',
      'x-request-id': 't4-req-reset',
      'x-trace-id': TRACE_ID,
      'x-op-id': 'op-reset',
      'x-idempotency-key': 't4-idem-reset'
    };
    return fetch('/api/t4/reset', {
      method: 'POST',
      headers: headers,
      body: JSON.stringify({ scenario: scenario }),
      cache: 'no-store'
    }).then(function (response) { return response.text(); }).catch(function () { return null; });
  }

  function clearLocal() {
    closeWs();
    closeSse('reset');
    clearPollTimers();
    counters = { req: 0, op: 0, cartOp: 0, wsFrame: 0, sseEvent: 0, poll: 0 };
    net.ops.length = 0;
    net.requests.length = 0;
    net.responses.length = 0;
    net.ui.length = 0;
    net.polls.length = 0;
    net.errors.length = 0;
    net.ws = { state: 'closed', frames: [] };
    net.sse = { state: 'closed', events: [] };
    cart = { count: 0, revision: 0, items: [] };
    order = { orderId: null, status: null, total: 0 };
    qty = 1;
    lastError = '';
    var errorEl = el('t4n-error');
    if (errorEl) { errorEl.textContent = ''; errorEl.hidden = true; }
    var retry = el('t4n-retry');
    if (retry) retry.hidden = true;
    var qtyEl = el('t4n-qty');
    if (qtyEl) qtyEl.value = '1';
    var wsEl = el('t4n-ws-state');
    if (wsEl) wsEl.textContent = 'closed';
    var sseEl = el('t4n-sse-state');
    if (sseEl) sseEl.textContent = 'closed';
    renderCart();
    renderOrder();
    renderPolls();
  }

  function reset() {
    return postReset(net.scenario).then(function () {
      clearLocal();
      setStage('idle');
      return { ok: true, scenario: net.scenario, state: state() };
    });
  }

  function setScenario(name) {
    if (SCENARIOS.indexOf(name) < 0) {
      return Promise.resolve({ ok: false, error: { code: 'INVALID_SCENARIO', allowed: SCENARIOS.slice() } });
    }
    net.scenario = name;
    document.body.setAttribute('data-t4n-scenario', name);
    var scenarioEl = el('t4n-scenario');
    if (scenarioEl) scenarioEl.textContent = 'scenario: ' + name;
    return postReset(name).then(function () {
      clearLocal();
      connectWs();
      setStage('idle');
      return { ok: true, scenario: name, state: state() };
    });
  }

  /* --------------------------------------------------------------------------------------------
   * Serialised snapshots (browser_eval surface)
   * ------------------------------------------------------------------------------------------ */

  function state() {
    return JSON.parse(JSON.stringify({
      version: net.version,
      fixture: net.fixture,
      runId: net.runId,
      traceId: net.traceId,
      scenario: net.scenario,
      ops: net.ops,
      requests: net.requests,
      responses: net.responses,
      ui: net.ui,
      ws: net.ws,
      sse: net.sse,
      polls: net.polls,
      errors: net.errors,
      serverLedgerUrl: net.serverLedgerUrl
    }));
  }

  function snapshot() {
    var base = state();
    base.cart = snapshotCart();
    base.order = snapshotOrder();
    base.qty = qty;
    base.ready = net.ready === true;
    return base;
  }

  /* --------------------------------------------------------------------------------------------
   * Wiring
   * ------------------------------------------------------------------------------------------ */

  function setQty(next) {
    var value = Number(next);
    if (!Number.isFinite(value)) value = 1;
    qty = Math.min(Math.max(Math.round(value), 1), 9);
    var input = el('t4n-qty');
    if (input) input.value = String(qty);
  }

  function runClick(action) {
    if (busy) return;
    busy = true;
    Promise.resolve(action({ source: 'click' })).catch(function () {
      /* the ledger records the failure; a click handler never throws into the page */
    }).then(function () { busy = false; });
  }

  function wire() {
    var add = el('t4n-add-cart');
    if (add) add.addEventListener('click', function () { runClick(addToCart); });
    var checkoutButton = el('t4n-checkout');
    if (checkoutButton) checkoutButton.addEventListener('click', function () { runClick(checkout); });
    var cancelButton = el('t4n-cancel-order');
    if (cancelButton) cancelButton.addEventListener('click', function () { runClick(cancelOrder); });
    var retryButton = el('t4n-retry');
    if (retryButton) retryButton.addEventListener('click', function () { runClick(retryOrder); });
    var resetButton = el('t4n-reset');
    if (resetButton) resetButton.addEventListener('click', function () { runClick(reset); });
    var dec = el('t4n-qty-dec');
    if (dec) dec.addEventListener('click', function () { setQty(qty - 1); });
    var inc = el('t4n-qty-inc');
    if (inc) inc.addEventListener('click', function () { setQty(qty + 1); });
    var input = el('t4n-qty');
    if (input) {
      input.addEventListener('input', function () { setQty(input.value); });
      input.addEventListener('change', function () { setQty(input.value); });
    }
  }

  function boot() {
    var params = new URLSearchParams(location.search);
    var requested = params.get('scenario') || 'normal';
    net.scenario = SCENARIOS.indexOf(requested) >= 0 ? requested : 'normal';
    document.body.setAttribute('data-t4n-scenario', net.scenario);
    var scenarioEl = el('t4n-scenario');
    if (scenarioEl) scenarioEl.textContent = 'scenario: ' + net.scenario;
    renderCart();
    renderOrder();
    renderPolls();
    setStage('boot');
    return postReset(net.scenario).then(function () {
      connectWs();
      var op = beginOp('api', '#t4n-cart-refresh');
      return apiRequest({ opId: op.opId, method: 'GET', path: '/api/t4/cart' }).then(function (refresh) {
        if (refresh.ok) {
          applyCart(refresh.body && refresh.body.cart, { kind: 'response', id: refresh.record.requestId });
        }
        setStage('idle');
        net.ready = true;
      });
    });
  }

  var methods = {
    state: state,
    reset: reset,
    setScenario: setScenario,
    addToCart: addToCart,
    checkout: checkout,
    retryOrder: retryOrder,
    cancelOrder: cancelOrder,
    snapshot: snapshot
  };
  net.methods = methods;
  net.state = state;
  net.snapshot = snapshot;
  net.reset = reset;
  net.setScenario = setScenario;
  net.addToCart = addToCart;
  net.checkout = checkout;
  net.retryOrder = retryOrder;
  net.cancelOrder = cancelOrder;
  net.ready = false;

  wire();
  void boot();
})();
