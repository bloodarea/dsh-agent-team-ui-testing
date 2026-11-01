/*
 * Zero-dependency fixture SharedWorker served at GET /n/shared-worker.js.
 *
 * One fetch of /n/worker-data per connection, then two messages on the port:
 *   {source:"shared-worker", phase:"connected"}                              (immediately)
 *   {source:"shared-worker", phase:"done", status:200, body:{…}}             (after the fetch)
 *   {source:"shared-worker", phase:"error", status:0, error:<string>}        (on failure)
 *
 * Truth table: tests/ui_test_fixture/README.md §NET.
 */
self.onconnect = function (event) {
  'use strict';
  const port = event.ports && event.ports[0];
  if (!port) return;
  port.postMessage({ source: 'shared-worker', phase: 'connected' });
  self
    .fetch('/n/worker-data', { cache: 'no-store' })
    .then(function (response) {
      return response.json().then(function (body) {
        port.postMessage({ source: 'shared-worker', phase: 'done', status: response.status, body: body });
      });
    })
    .catch(function (error) {
      port.postMessage({
        source: 'shared-worker',
        phase: 'error',
        status: 0,
        error: String((error && error.message) || error),
      });
    });
};
