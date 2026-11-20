import { createConnection } from 'node:net';
import { setTimeout as delay } from 'node:timers/promises';
import x11 from 'x11';

const ATOM = 4;
const CARDINAL = 6;
const WINDOW = 33;
const WM_EVENT_MASK = (1 << 19) | (1 << 20); // SubstructureNotify | SubstructureRedirect
const VIEWABLE = 2;
const WINDOW_LIST_LIMIT = 2048;

function request(object, method, ...args) {
  return new Promise((resolve, reject) => {
    object[method](...args, (error, value) => error ? reject(error) : resolve(value));
  });
}

function property(client, window, atom, type, limit) {
  return request(client, 'GetProperty', 0, window, atom, type, 0, limit);
}

function words(reply) {
  const values = [];
  if (reply.format !== 32) return values;
  for (let offset = 0; offset + 4 <= reply.data.length; offset += 4) {
    values.push(reply.data.readUInt32LE(offset));
  }
  return values;
}

function skipTaskbar(client, root, window, { stateAtom, skipTaskbarAtom, skipPagerAtom }) {
  // EWMH asks clients to send a ClientMessage to the WM for mapped windows.
  const event = Buffer.alloc(32);
  event[0] = 33; // ClientMessage
  event[1] = 32; // format
  event.writeUInt32LE(window, 4);
  event.writeUInt32LE(stateAtom, 8);
  event.writeUInt32LE(1, 12); // _NET_WM_STATE_ADD
  event.writeUInt32LE(skipTaskbarAtom, 16);
  event.writeUInt32LE(skipPagerAtom, 20);
  event.writeUInt32LE(1, 24); // normal application
  client.SendEvent(root, false, WM_EVENT_MASK, event);
}

async function rejectNativeFocus(client, window, { hintsAtom, protocolsAtom, takeFocusAtom }) {
  const [hintsReply, protocolsReply] = await Promise.all([
    property(client, window, hintsAtom, hintsAtom, 9), property(client, window, protocolsAtom, ATOM, 128),
  ]);
  if (hintsReply.bytesAfter || protocolsReply.bytesAfter) return false;
  const hints = words(hintsReply);
  const protocols = words(protocolsReply);
  const inputHint = 1;
  // ICCCM's no-input model requires both InputHint=False and no WM_TAKE_FOCUS protocol.
  // Keep Chrome's remaining hints and protocols (including WM_DELETE_WINDOW).
  if (!(hints[0] & inputHint) || hints[1] !== 0) {
    const value = Buffer.alloc(36);
    hints.forEach((word, index) => value.writeUInt32LE(word, index * 4));
    value.writeUInt32LE(((hints[0] || 0) | inputHint) >>> 0);
    value.writeUInt32LE(0, 4);
    client.ChangeProperty(0, window, hintsAtom, hintsAtom, 32, value);
  }
  if (protocols.includes(takeFocusAtom)) {
    const remaining = protocols.filter((protocol) => protocol !== takeFocusAtom);
    const value = Buffer.alloc(remaining.length * 4);
    remaining.forEach((protocol, index) => value.writeUInt32LE(protocol, index * 4));
    client.ChangeProperty(0, window, protocolsAtom, ATOM, 32, value);
  }
  const [readHints, readProtocols] = await Promise.all([
    property(client, window, hintsAtom, hintsAtom, 9), property(client, window, protocolsAtom, ATOM, 128),
  ]);
  const input = words(readHints);
  return Boolean(input[0] & inputHint) && input[1] === 0
    && !readProtocols.bytesAfter && !words(readProtocols).includes(takeFocusAtom);
}

async function hideOwnedWindows({ client, screen }, pid, signal) {
  const atom = (name) => request(client, 'InternAtom', false, name);
  const [pidAtom, clientsAtom, stateAtom, skipTaskbarAtom, skipPagerAtom, motifAtom,
    hintsAtom, protocolsAtom, takeFocusAtom, opacityAtom, shape] = await Promise.all([
    atom('_NET_WM_PID'), atom('_NET_CLIENT_LIST'), atom('_NET_WM_STATE'), atom('_NET_WM_STATE_SKIP_TASKBAR'),
    atom('_NET_WM_STATE_SKIP_PAGER'), atom('_MOTIF_WM_HINTS'), atom('WM_HINTS'), atom('WM_PROTOCOLS'),
    atom('WM_TAKE_FOCUS'), atom('_NET_WM_WINDOW_OPACITY'), request(client, 'require', 'shape'),
  ]);
  const roots = screen.map((item) => item.root);
  const flags = { stateAtom, skipTaskbarAtom, skipPagerAtom };
  let found = false;
  let hidden = true;
  for (const root of roots) {
    signal.throwIfAborted();
    const [managed, tree] = await Promise.all([
      property(client, root, clientsAtom, WINDOW, WINDOW_LIST_LIMIT), request(client, 'QueryTree', root),
    ]);
    const managedWindows = new Set(words(managed));
    const candidates = new Set([...managedWindows, ...tree.children]);
    if (managed.bytesAfter || candidates.size > WINDOW_LIST_LIMIT) return false;
    const windows = await Promise.all([...candidates].map(async (window) => {
      const owner = await property(client, window, pidAtom, CARDINAL, 1).catch(() => null);
      return owner && words(owner)[0] === pid ? window : null;
    }));
    for (const window of windows.filter(Boolean)) {
      signal.throwIfAborted();
      const attrs = await request(client, 'GetWindowAttributes', window).catch(() => null);
      // A WM-managed window may still be awaiting its first map. Apply the protections before
      // it becomes visible, but ignore unmapped utility windows outside the WM's client list.
      if (!attrs || attrs.overrideRedirect || (attrs.mapState !== VIEWABLE && !managedWindows.has(window))) continue;
      found = true;
      // Give the compositor a separate way to hide the window. A shape change can leave a black
      // surface in the desktop scene, and Chrome can reset its bounding shape during a configure.
      client.ChangeProperty(0, window, opacityAtom, CARDINAL, 32, Buffer.alloc(4));
      shape.Rectangles(shape.Op.Set, shape.Kind.Input, window, 0, 0, []);
      shape.Rectangles(shape.Op.Set, shape.Kind.Bounding, window, 0, 0, []);
      const rejectsFocus = await rejectNativeFocus(client, window, { hintsAtom, protocolsAtom, takeFocusAtom });
      const motif = words(await property(client, window, motifAtom, motifAtom, 5));
      const decorationFlag = 2; // MWM_HINTS_DECORATIONS
      if (!(motif[0] & decorationFlag) || motif[2] !== 0) {
        const hints = Buffer.alloc(20);
        for (const [index, value] of motif.entries()) hints.writeUInt32LE(value, index * 4);
        hints.writeUInt32LE(((motif[0] || 0) | decorationFlag) >>> 0);
        hints.writeUInt32LE(0, 8);
        client.ChangeProperty(0, window, motifAtom, motifAtom, 32, hints);
      }
      // The WM can reparent/decorate asynchronously, and Chromium can reset the bounding shape
      // while configuring a new native window. Verify a stable readback without touching WM frames.
      let confirmed = false;
      let lastReadHidden = false;
      let sentSkip = false;
      for (let attempt = 0; attempt < 8 && !confirmed; attempt += 1) {
        signal.throwIfAborted();
        const [state, bounds, input, opacity, treeAfter, current] = await Promise.all([
          property(client, window, stateAtom, ATOM, 128), request(shape, 'GetRectangles', window, shape.Kind.Bounding),
          request(shape, 'GetRectangles', window, shape.Kind.Input), property(client, window, opacityAtom, CARDINAL, 1),
          request(client, 'QueryTree', window), request(client, 'GetWindowAttributes', window),
        ]);
        const states = words(state);
        const skipped = states.includes(skipTaskbarAtom) && states.includes(skipPagerAtom);
        const clipped = bounds.rectangles.length === 0;
        const inputClipped = input.rectangles.length === 0;
        const transparent = opacity.bytesAfter === 0 && words(opacity)[0] === 0;
        if (!clipped) shape.Rectangles(shape.Op.Set, shape.Kind.Bounding, window, 0, 0, []);
        if (!inputClipped) shape.Rectangles(shape.Op.Set, shape.Kind.Input, window, 0, 0, []);
        if (!transparent) client.ChangeProperty(0, window, opacityAtom, CARDINAL, 32, Buffer.alloc(4));
        if (!skipped && !sentSkip) {
          skipTaskbar(client, root, window, flags);
          sentSkip = true;
        }
        let hiddenNow = current.mapState === VIEWABLE && transparent && clipped && inputClipped && skipped;
        if (hiddenNow && treeAfter.parent !== root) {
          const frame = await request(shape, 'GetRectangles', treeAfter.parent, shape.Kind.Bounding);
          hiddenNow = frame.rectangles.length === 0;
        }
        confirmed = lastReadHidden && hiddenNow;
        lastReadHidden = hiddenNow;
        if (!confirmed) await delay(25, undefined, { signal });
      }
      hidden &&= confirmed && rejectsFocus;
    }
  }
  return found && hidden;
}

/** Keep browser windows mapped while the X server clips their visible and clickable area. */
export async function hideHeadedWindowsX11(pid, display) {
  // Only the Host's local desktop is supported. Don't send its X authority to a remote display.
  const local = /^(?:(?:unix|local)\/|unix)?:(\d+)(?:\.\d+)?$/.exec(display || '');
  if (!Number.isInteger(pid) || pid <= 0 || !local) return false;
  const signal = AbortSignal.timeout(1200);
  const stream = createConnection({ path: `/tmp/.X11-unix/X${local[1]}`, signal });
  try {
    return await new Promise((resolve, reject) => {
      signal.addEventListener('abort', () => reject(signal.reason), { once: true });
      // An injected stream defaults to no authority in x11. Null keeps its normal Xauthority lookup.
      const client = x11.createClient({ display: local[0].replace(/^unix:/, 'unix/:'), stream, auth: null, disableBigRequests: true }, (error, connection) => {
        if (error) reject(error);
        else hideOwnedWindows(connection, pid, signal).then(resolve, reject);
      });
      client.on('error', reject);
      stream.on('close', () => reject(new Error('X11 connection closed')));
    });
  } catch {
    return false;
  } finally {
    stream.destroy();
  }
}
