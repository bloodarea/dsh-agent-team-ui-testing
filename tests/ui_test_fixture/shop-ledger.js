/*
 * Shared page-side truth ledger for the shop chain fixture, served at GET /shop/shop-ledger.js.
 *
 * One implementation for all five pages (real MPA, full-page navigations). It is plain browser
 * JavaScript with no CDP dependency, no randomness and no clock-derived payloads — the only
 * non-deterministic field is `requests[].at` (epoch ms, page-local bookkeeping for durations).
 *
 * Truth table: tests/ui_test_fixture/README.md §SHOP.
 *
 * window.__shop = {
 *   runId, stage, route:{path, search},
 *   requests: [{stage, method, url, status, at}],
 *   products, product, order, checkout, polls:[status…], orders,
 *   spa: {pushed, pushedPath, status},
 *   errors: [], done: {products, product, order, checkout, orders},
 *   request(), markDone(), pushRoute(), summary()
 * }
 *
 * EVERY API request carries two correlation headers:
 *   x-correlation-id: trace-shop-chain-1   (the default-rule header extractors actually read)
 *   x-shop-trace:     trace-shop-chain-1   (human-readable duplicate)
 */
(function () {
  'use strict';

  var CORRELATION = 'trace-shop-chain-1';
  var params = new URLSearchParams(location.search);

  var shop = {
    runId: params.get('runId') || 'chain-1',
    stage: document.body.getAttribute('data-shop-stage') || 'unknown',
    route: { path: location.pathname, search: location.search },
    requests: [],
    products: null,
    product: null,
    order: null,
    checkout: null,
    polls: [],
    orders: null,
    spa: { pushed: false, pushedPath: null, status: null },
    errors: [],
    done: { products: false, product: false, order: false, checkout: false, orders: false },
    request: request,
    markDone: markDone,
    pushRoute: pushRoute,
    summary: summary
  };
  window.__shop = shop;

  function query(name, fallback) {
    var value = params.get(name);
    return value === null || value === '' ? fallback : value;
  }

  function setStatus(text) {
    var el = document.getElementById('shop-status');
    if (el) el.textContent = text;
  }

  function record(method, url, status) {
    shop.requests.push({
      stage: shop.stage,
      method: method,
      url: url,
      status: status,
      at: Date.now()
    });
  }

  /** One deterministic API call: correlation headers + no-store + ledger entry. */
  function request(method, url, body) {
    var init = {
      method: method,
      cache: 'no-store',
      headers: { 'x-correlation-id': CORRELATION, 'x-shop-trace': CORRELATION }
    };
    if (body !== undefined) {
      init.headers['content-type'] = 'application/json';
      init.body = JSON.stringify(body);
    }
    return fetch(url, init)
      .then(function (response) {
        return response.json().then(function (json) {
          record(method, url, response.status);
          if (!json || json.code !== 0) shop.errors.push('business-code:' + (json ? json.code : 'null'));
          return json;
        });
      })
      .catch(function (error) {
        // Network/parse failure: record it, never leave the page in limbo.
        record(method, url, 0);
        shop.errors.push(String((error && error.message) || error));
        setStatus('error');
        throw error;
      });
  }

  function markDone(stage) {
    shop.done[stage] = true;
    document.body.setAttribute('data-shop-ready', stage);
    setStatus('ready');
  }

  /** Same-document routing: pushState + ledger update (no navigation, no request). */
  function pushRoute(pathWithSearch) {
    var target = new URL(pathWithSearch, location.href);
    history.pushState({}, '', pathWithSearch);
    shop.route = { path: target.pathname, search: target.search };
    shop.spa.pushed = true;
    shop.spa.pushedPath = pathWithSearch;
  }

  function summary() {
    return {
      stage: shop.stage,
      runId: shop.runId,
      route: shop.route,
      requests: shop.requests.length,
      polls: shop.polls.slice(),
      spa: { pushed: shop.spa.pushed, pushedPath: shop.spa.pushedPath },
      done: {
        products: shop.done.products,
        product: shop.done.product,
        order: shop.done.order,
        checkout: shop.done.checkout,
        orders: shop.done.orders
      },
      errors: shop.errors.slice()
    };
  }

  shop.query = query;
  shop.setStatus = setStatus;
  shop.CORRELATION = CORRELATION;
  setStatus('loading');
})();
