/**
 * WEB-T4 dynamic-visual fixture routes.
 *
 * Contract: tests/ui_test_fixture/t4-visual.md (routes / DOM / window.__t4.visual truth API).
 * Owned by the dynamic-visual fixture executor; `server.mjs` only calls the exported functions.
 *
 *   GET /web-t4-visual.html   deterministic 2x2 dynamic-visual page (text/html; UTF-8)
 *   GET /t4/visual/*          page assets (currently the generated WebM media asset)
 *   returns true              request fully handled (response already written)
 *   returns false             not a T4 visual route -> server continues to its own 404
 *
 * Everything is loopback-only, zero-dependency and deterministic. Every response carries
 * `cache-control: no-store` + `x-fixture: dsh-ui-testing` through t4-http-utils.mjs.
 */
import { sendFile, methodNotAllowed, notFound } from './t4-http-utils.mjs';

const HERE = new URL('.', import.meta.url).pathname;
const PAGE_PATH = '/web-t4-visual.html';
const ASSET_PREFIX = '/t4/visual/';

// Only files that actually belong to this fixture can be served. Keep this explicit so the route
// can never turn into a directory listing of the fixture directory.
const ASSETS = new Set([
  't4-visual-media.webm',
]);

export async function handleT4VisualRoute(req, res, url, state) {
  const pathname = url.pathname;
  const isPage = pathname === PAGE_PATH;
  const isAsset = pathname.startsWith(ASSET_PREFIX);
  if (!isPage && !isAsset) return false;

  const method = req.method || 'GET';
  if (method !== 'GET') {
    methodNotAllowed(res, ['GET']);
    return true;
  }

  // Per-server-instance bookkeeping only; no timers, sockets or file handles are created here.
  if (state && typeof state === 'object') {
    state.requests = (state.requests || 0) + 1;
    state.lastPath = pathname;
  }

  if (isPage) {
    await sendFile(res, 'web-t4-visual.html', {
      root: HERE,
      contentType: 'text/html; charset=utf-8',
    });
    return true;
  }

  const relative = pathname.slice(ASSET_PREFIX.length);
  if (!relative || relative.includes('/') || relative.includes('\\') || relative.includes('..')) {
    notFound(res);
    return true;
  }
  if (!ASSETS.has(relative)) {
    notFound(res);
    return true;
  }
  await sendFile(res, relative, { root: HERE });
  return true;
}

/**
 * Release fixture state. The page owns its rAF loop / media element in the browser, so the server
 * side only drops bookkeeping; there is deliberately no setInterval to clear.
 */
export function disposeT4Visual(state) {
  if (!state || typeof state !== 'object') return;
  delete state.requests;
  delete state.lastPath;
}
