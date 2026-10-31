/**
 * Host half of the UI testing plugin: owns a real headless Chromium and drives it over CDP.
 * The client half only renders frames and forwards input, so nothing here can steal window focus.
 */
import { spawn } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

export const inject = ['tools', 'webServer'];

const CHROME_BIN = process.env.DSH_UI_TESTING_CHROME || '/opt/google/chrome/chrome';
const ROUTE_PREFIX = '/plugins/ui-testing';
const NETWORK_LIMIT = 300;
const AGENT_HOLD_MS = 15000;

/** Minimal CDP client over the browser's WebSocket endpoint. */
class Cdp {
  constructor(url) {
    this.url = url;
    this.nextId = 1;
    this.pending = new Map();
    this.listeners = new Set();
    this.closed = false;
  }

  connect() {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(this.url);
      this.ws = ws;
      ws.onopen = () => resolve(this);
      ws.onerror = (event) => reject(new Error('cdp open failed: ' + (event && event.message ? event.message : 'unknown')));
      ws.onclose = () => {
        this.closed = true;
        for (const entry of this.pending.values()) entry.reject(new Error('cdp closed'));
        this.pending.clear();
      };
      ws.onmessage = (event) => {
        let message;
        try { message = JSON.parse(event.data); } catch { return; }
        if (message.id !== undefined) {
          const entry = this.pending.get(message.id);
          if (!entry) return;
          this.pending.delete(message.id);
          if (message.error) entry.reject(new Error(message.error.message || 'cdp error'));
          else entry.resolve(message.result);
          return;
        }
        for (const listener of this.listeners) listener(message);
      };
    });
  }

  send(method, params = {}) {
    if (this.closed) return Promise.reject(new Error('cdp closed'));
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.ws.send(JSON.stringify({ id, method, params }));
      setTimeout(() => {
        if (this.pending.has(id)) {
          this.pending.delete(id);
          reject(new Error('cdp timeout: ' + method));
        }
      }, 30000);
    });
  }

  on(listener) {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  close() {
    try { if (this.ws) this.ws.close(); } catch { /* ignore */ }
  }
}

/** One headless browser plus the page being previewed. */
class Runtime {
  constructor(log) {
    this.log = log;
    this.proc = undefined;
    this.cdp = undefined;
    this.profileDir = undefined;
    this.port = 0;
    this.frame = undefined;
    this.frameSeq = 0;
    this.network = [];
    this.requests = new Map();
    this.url = '';
    this.title = '';
    this.viewport = { width: 1280, height: 800 };
    this.activity = '空闲';
    this.agentUntil = 0;
    this.humanUntil = 0;
    this.lastError = '';
    this.starting = undefined;
  }

  mode() {
    const now = Date.now();
    if (now < this.agentUntil) return 'agent';
    if (now < this.humanUntil) return 'human';
    return 'idle';
  }

  async ensure() {
    if (this.cdp && !this.cdp.closed) return this.cdp;
    if (this.starting) return this.starting;
    this.starting = this.#start().finally(() => { this.starting = undefined; });
    return this.starting;
  }

  async #start() {
    this.profileDir = await mkdtemp(join(tmpdir(), 'dsh-ui-testing-'));
    const proc = spawn(CHROME_BIN, [
      '--headless=new',
      '--remote-debugging-port=0',
      `--user-data-dir=${this.profileDir}`,
      '--no-first-run',
      '--no-default-browser-check',
      '--disable-gpu',
      '--hide-scrollbars',
      '--mute-audio',
      '--disable-background-timer-throttling',
      '--disable-renderer-backgrounding',
      '--window-size=1280,800',
      'about:blank',
    ], { stdio: ['ignore', 'ignore', 'pipe'] });
    this.proc = proc;
    proc.stderr.on('data', (chunk) => {
      const text = String(chunk);
      if (/error|fatal/i.test(text)) this.log('chrome: ' + text.trim().slice(0, 300));
    });
    proc.on('exit', () => {
      this.proc = undefined;
      this.cdp = undefined;
    });

    const devtoolsFile = join(this.profileDir, 'DevToolsActivePort');
    let port = 0;
    for (let attempt = 0; attempt < 100; attempt += 1) {
      try {
        const text = await readFile(devtoolsFile, 'utf8');
        port = Number(text.split('\n')[0]);
        if (port) break;
      } catch { /* not ready yet */ }
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    if (!port) throw new Error('Chromium 未在预期时间内启动（DevToolsActivePort 不存在）');
    this.port = port;

    const list = await fetch(`http://127.0.0.1:${port}/json/list`).then((response) => response.json());
    const page = list.find((target) => target.type === 'page');
    if (!page) throw new Error('Chromium 没有可用的 page target');

    const cdp = new Cdp(page.webSocketDebuggerUrl);
    await cdp.connect();
    this.cdp = cdp;
    cdp.on((message) => this.#onEvent(message));

    await cdp.send('Page.enable');
    await cdp.send('Runtime.enable');
    await cdp.send('Network.enable', { maxTotalBufferSize: 5000000 });
    await cdp.send('DOM.enable');
    await cdp.send('CSS.enable');
    await this.applyViewport(this.viewport.width, this.viewport.height);
    await cdp.send('Page.startScreencast', {
      format: 'jpeg',
      quality: 72,
      maxWidth: 1600,
      maxHeight: 1200,
      everyNthFrame: 1,
    });
    this.log(`chromium ready on devtools port ${port}`);
    return cdp;
  }

  #onEvent(message) {
    if (message.method === 'Page.screencastFrame') {
      const params = message.params;
      const scale = params.metadata.pageScaleFactor || 1;
      this.frame = {
        data: params.data,
        width: params.metadata.deviceWidth,
        height: params.metadata.deviceHeight,
        pageWidth: Math.round(params.metadata.deviceWidth / scale),
        pageHeight: Math.round(params.metadata.deviceHeight / scale),
        capturedAt: params.metadata.timestamp,
        receivedAt: Date.now(),
      };
      this.frameSeq += 1;
      if (this.cdp) this.cdp.send('Page.screencastFrameAck', { sessionId: params.sessionId }).catch(() => {});
      return;
    }
    if (message.method === 'Page.frameNavigated' && message.params.frame.parentId === undefined) {
      this.url = message.params.frame.url;
      this.title = message.params.frame.name || '';
      return;
    }
    if (message.method === 'Network.requestWillBeSent') {
      const params = message.params;
      this.requests.set(params.requestId, {
        url: params.request.url,
        method: params.request.method,
        type: params.type,
        at: params.timestamp,
        status: 0,
      });
      return;
    }
    if (message.method === 'Network.responseReceived') {
      const entry = this.requests.get(message.params.requestId);
      if (!entry) return;
      entry.status = message.params.response.status;
      entry.type = message.params.type || entry.type;
      this.network.push(entry);
      if (this.network.length > NETWORK_LIMIT) this.network.shift();
      this.requests.delete(message.params.requestId);
    }
  }

  async applyViewport(width, height) {
    const w = Math.max(200, Math.min(4096, Math.round(width)));
    const h = Math.max(200, Math.min(4096, Math.round(height)));
    this.viewport = { width: w, height: h };
    await this.cdp.send('Emulation.setDeviceMetricsOverride', {
      width: w,
      height: h,
      deviceScaleFactor: 1,
      mobile: false,
    });
    return this.viewport;
  }

  touchHuman(ms = 4000) {
    this.humanUntil = Date.now() + ms;
    this.activity = '人类正在操作浏览器';
  }

  touchAgent(text) {
    this.agentUntil = Date.now() + AGENT_HOLD_MS;
    this.activity = text;
  }

  state() {
    return {
      mode: this.mode(),
      activity: this.activity,
      url: this.url,
      title: this.title,
      viewport: this.viewport,
      seq: this.frameSeq,
      running: Boolean(this.cdp && !this.cdp.closed),
      error: this.lastError,
    };
  }

  async navigate(url) {
    await this.ensure();
    this.url = url;
    await this.cdp.send('Page.navigate', { url });
    return { url };
  }

  async input(events) {
    await this.ensure();
    for (const event of events) {
      if (event.kind === 'mouse') {
        await this.cdp.send('Input.dispatchMouseEvent', {
          type: event.type,
          x: event.x,
          y: event.y,
          button: event.button || 'left',
          buttons: event.buttons || 0,
          clickCount: event.clickCount || 0,
        });
      } else if (event.kind === 'wheel') {
        await this.cdp.send('Input.dispatchMouseEvent', {
          type: 'mouseWheel',
          x: event.x,
          y: event.y,
          deltaX: event.deltaX || 0,
          deltaY: event.deltaY || 0,
        });
      } else if (event.kind === 'key') {
        await this.cdp.send('Input.dispatchKeyEvent', {
          type: event.type,
          key: event.key,
          code: event.code,
          windowsVirtualKeyCode: event.virtualKeyCode,
          text: event.text,
        });
      } else if (event.kind === 'text') {
        await this.cdp.send('Input.insertText', { text: event.text });
      }
    }
    return events.length;
  }

  async evaluate(expression, awaitPromise = true) {
    await this.ensure();
    const result = await this.cdp.send('Runtime.evaluate', {
      expression,
      returnByValue: true,
      awaitPromise,
      userGesture: true,
    });
    if (result.exceptionDetails) {
      return { ok: false, error: result.exceptionDetails.text || 'evaluation failed' };
    }
    return {
      ok: true,
      value: result.result ? result.result.value : undefined,
      type: result.result ? result.result.type : 'undefined',
    };
  }

  async screenshot() {
    await this.ensure();
    const capturedAt = Date.now();
    const shot = await this.cdp.send('Page.captureScreenshot', { format: 'png' });
    return { base64: shot.data, viewport: this.viewport, capturedAt };
  }

  async computedStyle(selector, properties) {
    await this.ensure();
    const doc = await this.cdp.send('DOM.getDocument', { depth: -1, pierce: true });
    const node = await this.cdp.send('DOM.querySelector', { nodeId: doc.root.nodeId, selector });
    if (!node.nodeId) return { ok: false, error: '未找到元素：' + selector };
    const computed = await this.cdp.send('CSS.getComputedStyleForNode', { nodeId: node.nodeId });
    const map = {};
    for (const entry of computed.computedStyle) map[entry.name] = entry.value;
    if (!properties || !properties.length) return { ok: true, style: map };
    const picked = {};
    for (const name of properties) picked[name] = map[name];
    return { ok: true, style: picked };
  }

  async traffic(limit) {
    const size = Math.min(limit, NETWORK_LIMIT);
    return { entries: this.network.slice(-size) };
  }

  async close() {
    try { if (this.cdp) this.cdp.close(); } catch { /* ignore */ }
    this.cdp = undefined;
    if (this.proc) {
      try { this.proc.kill('SIGTERM'); } catch { /* ignore */ }
      this.proc = undefined;
    }
    if (this.profileDir) {
      const dir = this.profileDir;
      this.profileDir = undefined;
      setTimeout(() => { rm(dir, { recursive: true, force: true }).catch(() => {}); }, 1500);
    }
    this.frame = undefined;
    this.frameSeq = 0;
  }
}

function readJson(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > 8388608) {
        reject(new Error('请求体过大'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      const text = Buffer.concat(chunks).toString('utf8');
      if (!text) return resolve({});
      try { resolve(JSON.parse(text)); } catch { reject(new Error('请求体不是合法 JSON')); }
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

/** Register the runtime, its HTTP surface, and the agent tools. */
export function apply(ctx) {
  const log = (text) => {
    try {
      if (ctx.logger && typeof ctx.logger.info === 'function') ctx.logger.info(text);
    } catch { /* logging must never break the runtime */ }
  };
  const runtime = new Runtime(log);

  ctx.effect(() => () => { runtime.close().catch(() => {}); }, 'ui-testing: browser runtime');

  const handle = async (req, res) => {
    let action = '/';
    try {
      const url = new URL(req.url || '/', 'http://localhost');
      action = url.pathname.slice(ROUTE_PREFIX.length) || '/';
      if (req.method === 'GET' && action === '/frame') {
        const since = Number(url.searchParams.get('since') || 0);
        if (!runtime.frame || runtime.frameSeq === since) {
          sendJson(res, 200, { seq: runtime.frameSeq, pending: true, state: runtime.state() });
          return;
        }
        sendJson(res, 200, {
          seq: runtime.frameSeq,
          image: runtime.frame.data,
          width: runtime.frame.width,
          height: runtime.frame.height,
          capturedAt: runtime.frame.capturedAt,
          receivedAt: runtime.frame.receivedAt,
          state: runtime.state(),
        });
        return;
      }
      if (req.method === 'GET' && action === '/state') {
        sendJson(res, 200, runtime.state());
        return;
      }
      if (req.method !== 'POST') {
        sendJson(res, 405, { ok: false, error: '只支持 GET /frame、/state 与 POST 指令' });
        return;
      }
      const body = await readJson(req);
      if (action === '/ensure') {
        await runtime.ensure();
        if (body.url) await runtime.navigate(String(body.url));
        sendJson(res, 200, { ok: true, state: runtime.state() });
        return;
      }
      if (action === '/navigate') {
        await runtime.navigate(String(body.url || ''));
        sendJson(res, 200, { ok: true, state: runtime.state() });
        return;
      }
      if (action === '/viewport') {
        await runtime.ensure();
        const viewport = await runtime.applyViewport(Number(body.width), Number(body.height));
        sendJson(res, 200, { ok: true, viewport });
        return;
      }
      if (action === '/input') {
        runtime.touchHuman();
        const applied = await runtime.input(Array.isArray(body.events) ? body.events : []);
        sendJson(res, 200, { ok: true, applied });
        return;
      }
      if (action === '/eval') {
        sendJson(res, 200, await runtime.evaluate(String(body.expression || 'undefined')));
        return;
      }
      if (action === '/screenshot') {
        const shot = await runtime.screenshot();
        sendJson(res, 200, { ok: true, image: shot.base64, viewport: shot.viewport, capturedAt: shot.capturedAt });
        return;
      }
      if (action === '/close') {
        await runtime.close();
        sendJson(res, 200, { ok: true });
        return;
      }
      sendJson(res, 404, { ok: false, error: '未知指令 ' + action });
    } catch (error) {
      runtime.lastError = String((error && error.message) || error);
      sendJson(res, 500, { ok: false, error: runtime.lastError });
    }
  };

  ctx.effect(() => ctx.webServer.register({ kind: 'prefix', path: ROUTE_PREFIX, handler: handle }), 'ui-testing: http routes');

  const text = (value) => [{ type: 'text', text: typeof value === 'string' ? value : JSON.stringify(value) }];
  const register = (definition) => ctx.effect(() => ctx.tools.register(definition), 'ui-testing: tool ' + definition.name);

  register({
    name: 'browser_navigate',
    description: '在调试视图的内嵌浏览器里打开一个 HTTP(S) 地址。',
    parameters: {
      type: 'object',
      properties: { url: { type: 'string', description: '完整地址，必须带 http:// 或 https://' } },
      required: ['url'],
    },
    output: { schema: { type: 'object' }, render: (args, value) => text(value) },
    async execute(args) {
      const target = String((args && args.url) || '').trim();
      if (!/^https?:\/\//i.test(target)) throw new Error('只支持 http/https 地址');
      runtime.touchAgent('正在打开 ' + target);
      await runtime.navigate(target);
      return { ok: true, url: target };
    },
  });

  register({
    name: 'browser_eval',
    description: '在内嵌浏览器的页面上下文里执行 JavaScript 并返回结果（T1 JS 执行能力）。',
    parameters: {
      type: 'object',
      properties: { expression: { type: 'string', description: '表达式或语句，最后一个值会被返回' } },
      required: ['expression'],
    },
    output: { schema: { type: 'object' }, render: (args, value) => text(value) },
    async execute(args) {
      runtime.touchAgent('执行脚本');
      return runtime.evaluate(String((args && args.expression) || 'undefined'));
    },
  });

  register({
    name: 'browser_screenshot',
    description: '截取内嵌浏览器的当前画面（PNG base64）。',
    parameters: { type: 'object', properties: {} },
    output: { schema: { type: 'object' }, render: (args, value) => text({ viewport: value.viewport, bytes: value.bytes }) },
    async execute() {
      runtime.touchAgent('截图');
      const shot = await runtime.screenshot();
      return { viewport: shot.viewport, bytes: Math.round((shot.base64.length * 3) / 4), image: shot.base64 };
    },
  });

  register({
    name: 'browser_input',
    description: '向内嵌浏览器派发鼠标 / 滚轮 / 键盘事件（T1 原生事件能力）。坐标使用页面 CSS 像素。',
    parameters: {
      type: 'object',
      properties: {
        events: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              kind: { type: 'string', enum: ['mouse', 'wheel', 'key', 'text'] },
              type: { type: 'string', description: 'mouse: mousePressed/mouseReleased/mouseMoved；key: keyDown/keyUp/char' },
              x: { type: 'number' },
              y: { type: 'number' },
              button: { type: 'string' },
              clickCount: { type: 'number' },
              deltaX: { type: 'number' },
              deltaY: { type: 'number' },
              key: { type: 'string' },
              code: { type: 'string' },
              text: { type: 'string' },
            },
            required: ['kind'],
          },
        },
      },
      required: ['events'],
    },
    output: { schema: { type: 'object' }, render: (args, value) => text(value) },
    async execute(args) {
      runtime.touchAgent('派发输入事件');
      const applied = await runtime.input(Array.isArray(args && args.events) ? args.events : []);
      return { ok: true, applied };
    },
  });

  register({
    name: 'browser_network',
    description: '读取内嵌浏览器最近捕获的网络请求（T1 网络抓包，默认不含请求体）。',
    parameters: {
      type: 'object',
      properties: { limit: { type: 'number', description: '最多返回条数，默认 50' } },
    },
    output: { schema: { type: 'object' }, render: (args, value) => text(value) },
    async execute(args) {
      runtime.touchAgent('读取网络记录');
      return runtime.traffic(Number(args && args.limit) || 50);
    },
  });

  register({
    name: 'browser_computed_style',
    description: '读取内嵌浏览器里某个元素的计算样式（T1 CSSOM 能力）。',
    parameters: {
      type: 'object',
      properties: {
        selector: { type: 'string' },
        properties: { type: 'array', items: { type: 'string' } },
      },
      required: ['selector'],
    },
    output: { schema: { type: 'object' }, render: (args, value) => text(value) },
    async execute(args) {
      runtime.touchAgent('读取计算样式');
      return runtime.computedStyle(String(args && args.selector), Array.isArray(args && args.properties) ? args.properties : undefined);
    },
  });

  register({
    name: 'browser_state',
    description: '读取内嵌浏览器的当前状态：地址、标题、视口、控制权归属。',
    parameters: { type: 'object', properties: {} },
    output: { schema: { type: 'object' }, render: (args, value) => text(value) },
    async execute() {
      return runtime.state();
    },
  });
}
