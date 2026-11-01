/*
 * Zero-dependency fixture Worker served at GET /n/worker.js.
 *
 * It performs exactly one fetch of /n/worker-data (same origin) as soon as it starts, then posts
 * the result to the page as {source:"worker", status, body}. On failure it posts
 * {source:"worker", status:0, error:<string>}. Truth table: tests/ui_test_fixture/README.md §NET.
 */
(async function () {
  'use strict';
  try {
    const response = await self.fetch('/n/worker-data', { cache: 'no-store' });
    const body = await response.json();
    self.postMessage({ source: 'worker', status: response.status, body: body });
  } catch (error) {
    self.postMessage({ source: 'worker', status: 0, error: String((error && error.message) || error) });
  }
})();
