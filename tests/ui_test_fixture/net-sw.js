/*
 * Zero-dependency fixture ServiceWorker served at GET /n/sw.js (scope /n/).
 *
 * Deliberately registers NO `fetch` handler, so it never intercepts the fixture's own /n/*
 * requests (the acceptance probes must keep seeing plain network events). It only answers
 * postMessage:
 *   {type:"net-sw-fetch"} -> fetch('/n/worker-data?from=sw') then
 *   postMessage({source:"service-worker", phase:"done", status:200, body:{…}}) to every client
 *   (or {phase:"error", status:0, error:<string>} on failure).
 *
 * Truth table: tests/ui_test_fixture/README.md §NET.
 */
self.addEventListener('install', function () {
  'use strict';
  self.skipWaiting();
});

self.addEventListener('activate', function (event) {
  'use strict';
  event.waitUntil(self.clients.claim());
});

self.addEventListener('message', function (event) {
  'use strict';
  const data = event.data || {};
  if (data.type !== 'net-sw-fetch') return;
  const reply = function (payload) {
    const clients = self.clients;
    if (event.source && typeof event.source.postMessage === 'function') {
      event.source.postMessage(payload);
      return;
    }
    clients.matchAll({ includeUncontrolled: true, type: 'window' }).then(function (list) {
      for (const client of list) client.postMessage(payload);
    });
  };
  self
    .fetch('/n/worker-data?from=sw', { cache: 'no-store' })
    .then(function (response) {
      return response.json().then(function (body) {
        reply({ source: 'service-worker', phase: 'done', status: response.status, body: body });
      });
    })
    .catch(function (error) {
      reply({ source: 'service-worker', phase: 'error', status: 0, error: String((error && error.message) || error) });
    });
});
