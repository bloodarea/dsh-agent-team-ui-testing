    /* ---- 选元素发送到聊天框：纯函数与常量（无 DOM 依赖，可按 marker 提取做单测） ---------- */
    const PICK_HOVER_MS = 80;
    const PICK_WHEEL_DEBOUNCE_MS = 180;
    const PICK_STATUS_MS = 4200;
    function pickCollapseText(value) {
      return String(value === undefined || value === null ? '' : value).replace(/\s+/g, ' ').trim();
    }
    function pickTagName(element) {
      const raw = pickCollapseText(element && element.tag).toLowerCase().replace(/[^a-z0-9_-]/g, '');
      return raw || 'element';
    }
    function pickClassList(element) {
      const raw = element && element.classes;
      const list = Array.isArray(raw) ? raw : String(raw === undefined || raw === null ? '' : raw).split(/\s+/);
      return list.map((value) => pickCollapseText(value))
        .filter((value) => /^[A-Za-z_][\w-]*$/.test(value)).slice(0, 3);
    }
    function pickId(element) {
      return pickCollapseText(element && element.id).replace(/[^\w-]/g, '');
    }
    /** `<tag#id.class>` 兜底：Host 没给 outerHTML/selector 时仍能给出稳定标识。 */
    function pickCompoundSelector(element) {
      const id = pickId(element);
      const classes = pickClassList(element);
      return pickTagName(element) + (id ? '#' + id : '') + classes.map((name) => '.' + name).join('');
    }
    /** 左上角小标签：tag#id 或 tag.class。 */
    function pickTagLabel(element) {
      const id = pickId(element);
      if (id) return pickTagName(element) + '#' + id;
      const classes = pickClassList(element);
      return pickTagName(element) + (classes.length ? '.' + classes[0] : '');
    }
    function pickNumberText(value) {
      const number = Number(value);
      if (!Number.isFinite(number)) return '0';
      return String(Math.round(number * 100) / 100);
    }
    /* ---- 元素引用（@ chip）：聊天框显示紧凑引用，模型收到完整块 ---------------------------- */
    const ELEMENT_REF_SOURCE = 'ui-element';
    const ELEMENT_REF_VERSION = 1;
    const ELEMENT_REF_LABEL_MAX = 40;
    const ELEMENT_REF_RECENT_MAX = 12;
    /** 最近选取的元素引用，按 Agent session 分组（@ 菜单候选来源；不跨会话混用）。 */
    const elementRefs = { seq: 0, bySession: new Map(), lastSessionId: null, sourceRegistered: false };

    function elementRefBase64Url(bytes) {
      let binary = '';
      for (const byte of bytes) binary += String.fromCharCode(byte);
      return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/u, '');
    }
    function elementRefEncode(payload) {
      const bytes = new TextEncoder().encode(JSON.stringify(payload));
      return 'v' + ELEMENT_REF_VERSION + '.' + elementRefBase64Url(bytes);
    }
    function elementRefDecode(ref) {
      const match = /^v(\d+)\.([A-Za-z0-9_-]+)$/u.exec(pickCollapseText(ref));
      if (!match || Number(match[1]) !== ELEMENT_REF_VERSION) return null;
      try {
        const padded = match[2].replace(/-/g, '+').replace(/_/g, '/');
        const binary = atob(padded + '='.repeat((4 - (padded.length % 4)) % 4));
        const bytes = new Uint8Array(binary.length);
        for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
        const parsed = JSON.parse(new TextDecoder().decode(bytes));
        return parsed && typeof parsed === 'object' ? parsed : null;
      } catch {
        return null;
      }
    }
    /** Host detail → 自包含引用载荷（chip 标签、剪贴板文本、模型文本共用同一份事实）。 */
    function pickElementPayload(element, fallbackUrl) {
      const source = element && typeof element === 'object' ? element : {};
      const rect = source.rect && typeof source.rect === 'object' ? source.rect : {};
      const page = source.page && typeof source.page === 'object' ? source.page : {};
      const finite = (value) => (Number.isFinite(Number(value)) ? Number(value) : null);
      return {
        v: ELEMENT_REF_VERSION,
        tag: pickTagName(source),
        id: pickId(source) || null,
        classes: pickClassList(source),
        selector: pickCollapseText(source.selector) || null,
        selectorQuality: source.selectorQuality === 'unique' || source.selectorQuality === 'degraded'
          || source.selectorQuality === 'none' ? source.selectorQuality : null,
        role: pickCollapseText(source.role) || null,
        name: pickCollapseText(source.name) || null,
        rect: { x: finite(rect.x) || 0, y: finite(rect.y) || 0, width: finite(rect.width) || 0, height: finite(rect.height) || 0 },
        page: {
          url: pickCollapseText(page.url) || pickCollapseText(fallbackUrl) || null,
          title: pickCollapseText(page.title) || null,
        },
        frameId: source.frameId === undefined || source.frameId === null ? null : String(source.frameId),
        // 嵌套 frame 命中：Host 只在子 frame 上给 frame，selector 属于该 frame 的文档。
        frame: source.frame && source.frame.main === false
          ? {
            id: pickCollapseText(source.frame.id) || null,
            url: pickCollapseText(source.frame.url) || null,
          }
          : null,
        outerHTML: pickCollapseText(source.outerHTML) || null,
        outerHTMLTruncated: source.outerHTMLTruncated === true,
        outerHTMLLength: finite(source.outerHTMLLength),
        text: pickCollapseText(source.text) || null,
        textTruncated: source.textTruncated === true,
        textLength: finite(source.textLength),
      };
    }
    /** 定位标识：degraded selector 不作为引用名（它不是唯一定位器）。 */
    function pickElementLocator(payload) {
      if (payload.selector && payload.selectorQuality !== 'degraded') return payload.selector;
      const compound = payload.tag + (payload.id ? '#' + payload.id : '')
        + (payload.classes || []).map((name) => '.' + name).join('');
      return compound || payload.tag || 'element';
    }
    /** 引用插入描述（@ 菜单 onPick 与面板插入共用；clipboard 与模型文本分离）。 */
    function elementRefInsertFor(ref) {
      const payload = elementRefDecode(ref);
      if (!payload) return null;
      return {
        source: ELEMENT_REF_SOURCE,
        ref,
        label: pickElementChipLabel(payload),
        clipboardText: pickElementClipboardText(payload),
      };
    }
    /** chip 标签：紧凑、可读，长 selector 截断到 40 码点。 */
    function pickElementChipLabel(payload) {
      const text = '元素 ' + pickElementLocator(payload);
      const chars = Array.from(text);
      return chars.length > ELEMENT_REF_LABEL_MAX ? chars.slice(0, ELEMENT_REF_LABEL_MAX - 1).join('') + '…' : text;
    }
    function pickElementClipboardText(payload) {
      return '@' + pickElementChipLabel(payload);
    }
    /** 模型文本：完整块；截断与 degraded selector 必须显式标注，不能静默省略。 */
    function pickElementModelText(payload) {
      const summary = payload.outerHTML ? payload.outerHTML : '<' + pickElementLocator(payload) + '>';
      const selector = payload.selector || pickElementLocator(payload);
      const lines = ['[调试视图元素] ' + summary];
      lines.push('selector: ' + selector
        + (payload.selectorQuality === 'degraded' ? '（degraded：非唯一定位，仅作线索）' : ''));
      if (payload.role || payload.name) lines.push('role: ' + (payload.role || '') + ' · name: ' + (payload.name || ''));
      const rect = payload.rect || {};
      lines.push('rect(文档坐标): x=' + pickNumberText(rect.x) + ', y=' + pickNumberText(rect.y)
        + ', ' + pickNumberText(rect.width) + '×' + pickNumberText(rect.height));
      if (payload.page && payload.page.url) lines.push('page: ' + payload.page.url);
      // 嵌套 frame 的 selector 只在那个 frame 的文档里有效：不写出来，模型会当成主文档选择器。
      if (payload.frame && payload.frame.url) lines.push('frame: ' + payload.frame.url + '（selector 在该 frame 文档内有效）');
      if (payload.outerHTMLTruncated) {
        const shown = Math.max(0, Array.from(payload.outerHTML || '').length - 1);
        const total = payload.outerHTMLLength === null ? '?' : String(payload.outerHTMLLength);
        lines.push('outerHTML: 截断 ' + shown + '/' + total + ' 码点（末尾 …，完整文本未取得）');
      }
      return lines.join('\n');
    }
    function elementRefRemember(sessionId, payload) {
      const key = String(sessionId || '');
      if (!key) return null;
      const ref = elementRefEncode(payload);
      const locator = pickElementLocator(payload);
      const item = {
        ref,
        locator,
        label: pickElementChipLabel(payload),
        description: [
          payload.tag,
          payload.role || payload.name || '',
          pickNumberText(payload.rect.width) + '×' + pickNumberText(payload.rect.height),
          payload.page && payload.page.url ? payload.page.url : '',
        ].filter(Boolean).join(' · '),
        search: [locator, payload.tag, payload.id, payload.name, payload.page && payload.page.url]
          .filter(Boolean).join(' ').toLowerCase(),
      };
      const list = elementRefs.bySession.get(key) || [];
      elementRefs.bySession.set(key, [item, ...list.filter((entry) => entry.ref !== ref)].slice(0, ELEMENT_REF_RECENT_MAX));
      elementRefs.seq += 1;
      return item;
    }
    function elementRefCandidates(sessionId, query) {
      const needle = String(query || '').trim().toLowerCase();
      const list = elementRefs.bySession.get(String(sessionId || '')) || [];
      return list
        .filter((item) => !needle || item.search.includes(needle))
        .map((item) => ({ name: item.locator, label: item.label, description: item.description, value: item.ref, hint: '插入元素引用' }));
    }
    /**
     * 用 `@` 引用 chip 把元素加入聊天框：chip 只显示紧凑标签，模型文本由 codec.serialize 提供。
     * 插入是公开的 `SessionInput.insertReference`（span CAS 到当前 draftRev）；任何一步不可用都
     * 返回 { ok:false, reason }，由调用方降级为纯文本块，绝不静默丢失元素或伪造成功。
     */
    function pickInsertElementChip(sessionId, payload) {
      const sid = String(sessionId || '');
      if (!sid) return { ok: false, reason: 'no-session' };
      // Test-only seam (both globals must be enabled by the acceptance page): exercise the
      // plain-text fallback without having to fake a busy composer in a real session.
      if (typeof window !== 'undefined' && window.__UTB_TEST_HOOKS__ === true
        && window.__UTB_TEST_FORCE_TEXT_APPEND__ === true) {
        return { ok: false, reason: 'forced' };
      }
      const ctx = pluginContext;
      if (!ctx || typeof ctx.get !== 'function') return { ok: false, reason: 'unavailable' };
      let sessions = null;
      let conversation = null;
      try {
        sessions = ctx.get('sessions');
        conversation = ctx.get('conversation');
      } catch {
        return { ok: false, reason: 'unavailable' };
      }
      const input = conversation && conversation.input;
      if (!input || typeof input.for !== 'function' || !sessions || typeof sessions.binding !== 'function') {
        return { ok: false, reason: 'unavailable' };
      }
      let binding = null;
      try { binding = sessions.binding(sid); } catch { binding = null; }
      if (!binding) return { ok: false, reason: 'not-retained' };
      let face = null;
      try { face = input.for(binding.ctx); } catch { face = null; }
      if (!face || typeof face.insertReference !== 'function') return { ok: false, reason: 'unavailable' };
      let state = null;
      try { state = face.state && typeof face.state.getSnapshot === 'function' ? face.state.getSnapshot() : null; } catch { state = null; }
      if (!state || typeof state.draft !== 'string' || !Number.isInteger(state.draftRev)) {
        return { ok: false, reason: 'unavailable' };
      }
      if (state.phase !== 'plain' && state.phase !== 'claimed') return { ok: false, reason: 'busy' };
      elementRefs.lastSessionId = sid;
      const ref = elementRefEncode(payload);
      // `InputState.draft` is the clipboard projection: every chip expands to its clipboardText
      // there, while the editor's detect projection holds ONE placeholder per chip. Insert at the
      // END of the detect projection so a draft that already contains @ references still maps.
      const occurrences = Array.isArray(state.occurrences) ? state.occurrences : [];
      const placeholderDelta = occurrences.reduce((sum, occurrence) => {
        const length = Number(occurrence && occurrence.length);
        return sum + (Number.isFinite(length) && length > 1 ? length - 1 : 0);
      }, 0);
      const detectEnd = Math.max(0, state.draft.length - placeholderDelta);
      const span = { start: detectEnd, end: detectEnd, draftRev: state.draftRev };
      let applied = false;
      try {
        applied = face.insertReference(elementRefInsertFor(ref), span);
      } catch {
        applied = false;
      }
      if (!applied) return { ok: false, reason: 'blocked' };
      try { if (typeof face.focus === 'function') face.focus(); } catch { /* focus is best-effort */ }
      if (typeof window !== 'undefined' && window.__UTB_TEST_HOOKS__ === true) {
        const insert = elementRefInsertFor(ref);
        window.__UTB_ELEMENT_REF_LAST__ = {
          ref,
          label: pickElementChipLabel(payload),
          clipboardText: pickElementClipboardText(payload),
          modelText: pickElementModelText(payload),
          payload,
        };
        // Same code paths the @ menu source uses (candidates / onPick / codec.serialize).
        window.__UTB_ELEMENT_SOURCE_HOOK__ = {
          registered: elementRefs.sourceRegistered,
          name: ELEMENT_REF_SOURCE,
          candidates: (query) => elementRefCandidates(elementRefs.lastSessionId, query),
          insertFor: (ref) => elementRefInsertFor(ref),
          serialize: (ref) => {
            const decoded = elementRefDecode(ref);
            return decoded ? pickElementModelText(decoded) : null;
          },
          lastSessionId: elementRefs.lastSessionId,
          insertShape: insert ? { source: insert.source, label: insert.label, clipboardText: insert.clipboardText } : null,
          textRule: { registered: elementTextRuleState.registered, slotRegistered: elementTextRuleState.slotRegistered },
          matchText: (text, from) => {
            const match = elementTextBlockMatch(text, from);
            return match ? { id: match.id, start: match.start, end: match.end, data: match.data } : null;
          },
        };
      }
      return { ok: true };
    }
    /**
     * 注册 `@` 触发来源（“最近选取的元素”候选）。宿主没有 inputTriggers 服务时静默跳过——
     * chip 插入仍走 pickInsertElementChip，只是没有 `@` 菜单候选。
     */
    function registerElementReferenceSource(ctx) {
      if (!ctx) return false;
      let registered = false;
      const install = (host) => {
        if (registered || !host) return registered;
        let triggers = null;
        try { triggers = typeof host.get === 'function' ? host.get('inputTriggers') : null; } catch { triggers = null; }
        if (!triggers || typeof triggers.registerSource !== 'function') return false;
        const source = {
          trigger: '@',
          name: ELEMENT_REF_SOURCE,
          showGroupTitle: false,
          order: -1,
          async candidates(session, req) {
            return elementRefCandidates(session && session.sessionId, req && req.query);
          },
          onPick(pick) {
            const insert = elementRefInsertFor(pickCollapseText(pick && pick.candidate && pick.candidate.value));
            return insert ? { insert } : undefined;
          },
          codec: {
            clipboardText(ref) {
              const payload = elementRefDecode(ref);
              return payload ? pickElementClipboardText(payload) : ref;
            },
            async serialize(ref) {
              const payload = elementRefDecode(ref);
              if (!payload) throw new Error('ui-testing: element reference payload is not decodable');
              return pickElementModelText(payload);
            },
          },
          openReference() {
            try {
              const layout = typeof host.get === 'function' ? host.get('layout') : null;
              if (layout && typeof layout.selectPanel === 'function') {
                layout.selectPanel(ID);
                return true;
              }
            } catch { /* fall through to "not handled" */ }
            return false;
          },
        };
        try {
          const dispose = triggers.registerSource(source);
          registered = true;
          elementRefs.sourceRegistered = true;
          if (typeof ctx.effect === 'function') ctx.effect(() => dispose, 'ui-testing: @ element reference');
          else if (typeof host.effect === 'function') host.effect(() => dispose, 'ui-testing: @ element reference');
          return true;
        } catch {
          return false;
        }
      };
      // The trigger service may settle after this plugin's apply(): declare the dependency so the
      // registration runs when it exists, and still try immediately for hosts that already have it.
      if (typeof ctx.inject === 'function') {
        try { ctx.inject(['inputTriggers'], (sub) => { install(sub); }); } catch { /* immediate install below */ }
      }
      return install(ctx);
    }

    /* ---- 聊天记录里的元素块：折叠为同样的 @ 元素引用 chip（显示 ≠ 原始文本） ------------- */
    const ELEMENT_TEXT_RULE_ID = 'ui-element';
    const ELEMENT_TEXT_BLOCK_PREFIX = '[调试视图元素] ';
    const ELEMENT_TEXT_BLOCK_LINE = /^(?:selector|role|rect\(文档坐标\)|page|outerHTML):/u;
    const elementTextRuleState = { registered: false, slotRegistered: false };

    /**
     * 在用户消息原文里找一段 `[调试视图元素] …` 块（不跨非块行），返回 JSON 安全节点。
     * 模型侧文本不变；这里只决定 transcript 的显示。
     */
    function elementTextBlockMatch(text, from) {
      const source = String(text == null ? '' : text);
      const start = source.indexOf(ELEMENT_TEXT_BLOCK_PREFIX, Math.max(0, Number(from) || 0));
      if (start < 0) return undefined;
      let cursor = start;
      let end = start;
      let lastLineStart = start;
      const lines = [];
      for (;;) {
        const newline = source.indexOf('\n', cursor);
        const lineEnd = newline === -1 ? source.length : newline;
        const line = source.slice(cursor, lineEnd);
        if (lines.length > 0 && !ELEMENT_TEXT_BLOCK_LINE.test(line)) break;
        lines.push(line);
        lastLineStart = cursor;
        end = lineEnd;
        if (newline === -1) break;
        cursor = newline + 1;
      }
      if (end <= start) return undefined;
      const lastLine = lines[lines.length - 1] || '';
      // A chip is serialized as block text and any user text typed after the chip lands on the
      // LAST line (the insert rule adds one trailing space). Stop at the canonical end marker so
      // only the reference is folded and the caller's own sentence stays outside the chip.
      if (lastLine.startsWith('outerHTML: ')) {
        const marker = /^outerHTML: 截断 \d+\/\d+ 码点（末尾 …，完整文本未取得）/u.exec(lastLine);
        if (marker) end = lastLineStart + marker[0].length;
      } else if (lastLine.startsWith('page: ')) {
        const url = /^page: \S+/u.exec(lastLine);
        if (url) end = lastLineStart + url[0].length;
      }
      const selectorLine = lines.find((line) => line.startsWith('selector: ')) || '';
      const rawSelector = selectorLine.slice('selector: '.length);
      const degraded = rawSelector.includes('（degraded');
      const selector = rawSelector.replace(/（degraded.*$/u, '').trim();
      const pageLine = lines.find((line) => line.startsWith('page: ')) || '';
      const pageMatch = /^page: (\S+)/u.exec(pageLine);
      const rectLine = lines.find((line) => line.startsWith('rect(文档坐标): ')) || '';
      const rectMatch = /^rect\(文档坐标\): (x=-?[\d.]+, y=-?[\d.]+, [\d.]+×[\d.]+)/u.exec(rectLine);
      const truncatedLine = lines.find((line) => line.startsWith('outerHTML: ')) || '';
      const truncationMatch = /^outerHTML: (截断 \d+\/\d+ 码点（末尾 …，完整文本未取得）)/u.exec(truncatedLine);
      const label = '元素 ' + (selector || 'element');
      return {
        id: ELEMENT_TEXT_RULE_ID,
        start,
        end,
        data: {
          label,
          selector: selector || null,
          degraded,
          rect: rectMatch ? rectMatch[1].trim() : null,
          page: pageMatch ? pageMatch[1] : null,
          truncation: truncationMatch ? truncationMatch[1].trim() : null,
        },
      };
    }

    /** transcript 内联渲染：紧凑引用 chip；完整文本放在 title（悬停可见）。 */
    function ElementReferenceTextNode(props) {
      const raw = props && typeof props.raw === 'string' ? props.raw : '';
      const node = props && props.node && typeof props.node === 'object' ? props.node : null;
      const data = node && node.data && typeof node.data === 'object' ? node.data : {};
      const label = typeof data.label === 'string' && data.label ? data.label : '元素';
      const title = [label, data.rect ? 'rect: ' + data.rect : '', data.page ? 'page: ' + data.page : '',
        data.truncation || '', raw].filter(Boolean).join('\n');
      return h('span', {
        className: 'utb-user-element-ref',
        title,
        'data-utb-user-element-ref': typeof data.selector === 'string' ? data.selector : '',
        'data-utb-user-element-degraded': data.degraded === true ? 'true' : 'false',
        style: {
          display: 'inline-flex', alignItems: 'center', gap: '4px', padding: '0 7px',
          borderRadius: '6px', border: '1px solid rgba(127,127,127,0.35)',
          background: 'rgba(127,127,127,0.16)', fontSize: '0.92em', lineHeight: '1.6',
          maxWidth: '340px', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
          verticalAlign: 'baseline', cursor: 'help',
        },
      }, label);
    }

    /** 注册 transcript 文本规则与对应的内联渲染节点；服务缺失时静默跳过。 */
    function registerUserTextElementReference(ctx) {
      if (!ctx) return false;
      let ruleInstalled = false;
      const installSlot = () => {
        if (elementTextRuleState.slotRegistered) return;
        try {
          ctx.slots.inject('conversation.user.text.node', function* () {
            yield ctx.slots.register({
              name: 'conversation.user.text.node', key: ELEMENT_TEXT_RULE_ID, priority: 100,
            }, ElementReferenceTextNode);
          });
          elementTextRuleState.slotRegistered = true;
        } catch { /* slot absent: transcript keeps plain text */ }
      };
      const installRule = (host) => {
        if (ruleInstalled) return true;
        let service = null;
        try { service = host && typeof host.get === 'function' ? host.get('uiConversation') : null; } catch { service = null; }
        const userText = service && service.userText;
        if (!userText || typeof userText.register !== 'function') return false;
        try {
          const dispose = userText.register({ id: ELEMENT_TEXT_RULE_ID, order: 20, match: elementTextBlockMatch });
          ruleInstalled = true;
          elementTextRuleState.registered = true;
          if (typeof ctx.effect === 'function') ctx.effect(() => dispose, 'ui-testing: transcript element reference rule');
          return true;
        } catch {
          return false;
        }
      };
      installSlot();
      // The conversation service may settle after this plugin's apply(): register when it exists.
      if (typeof ctx.inject === 'function') {
        try { ctx.inject(['uiConversation'], (sub) => { installRule(sub); }); } catch { /* immediate install below */ }
      }
      return installRule(ctx);
    }

    /** 归一化 Host 命中结果；无有效矩形时返回 null（不画框）。 */
    function pickOverlayOf(element) {
      if (!element || typeof element !== 'object') return null;
      const rect = element.rect && typeof element.rect === 'object' ? element.rect : null;
      const x = Number(rect && rect.x);
      const y = Number(rect && rect.y);
      const width = Number(rect && rect.width);
      const height = Number(rect && rect.height);
      if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(width) || !Number.isFinite(height)
        || !(width > 0) || !(height > 0)) return null;
      return {
        rect: { x, y, width, height },
        label: pickTagLabel(element),
        selector: pickCollapseText(element.selector),
        role: pickCollapseText(element.role),
        name: pickCollapseText(element.name),
        frameId: element.frameId === undefined || element.frameId === null ? '' : String(element.frameId),
      };
    }
    /** 文档 CSS px → .utb-box 内相对屏幕矩形：geom.left + (d−C)/viewW*geom.width。 */
    function pickScreenRect(overlay, geom, canvas, size, boxRect) {
      if (!overlay || !overlay.rect || !geom || !canvas || !size || !boxRect) return null;
      const viewW = Number(size.w);
      const viewH = Number(size.h);
      const paintedW = Number(geom.width);
      const paintedH = Number(geom.height);
      if (!(viewW > 0) || !(viewH > 0) || !(paintedW > 0) || !(paintedH > 0)) return null;
      const left = Number(geom.left) + ((overlay.rect.x - Number(canvas.x)) / viewW) * paintedW - Number(boxRect.left);
      const top = Number(geom.top) + ((overlay.rect.y - Number(canvas.y)) / viewH) * paintedH - Number(boxRect.top);
      const width = Math.max(1, (overlay.rect.width / viewW) * paintedW);
      const height = Math.max(1, (overlay.rect.height / viewH) * paintedH);
      if (![left, top, width, height].every((value) => Number.isFinite(value))) return null;
      return { left, top, width, height };
    }
    /** 左上角标签位置：默认贴在框上方，越界时夹紧到画布内。 */
    function pickTagPosition(screen, boxW, boxH) {
      if (!screen) return null;
      const width = Math.max(0, Number(boxW) || 0);
      const height = Math.max(0, Number(boxH) || 0);
      const left = Math.min(Math.max(0, screen.left), Math.max(0, width - 8));
      const top = screen.top - 18 >= 0
        ? screen.top - 18
        : Math.min(Math.max(0, screen.top + 2), Math.max(0, height - 18));
      return { left, top };
    }
    function pickChatFailureText(reason) {
      if (reason === 'busy') return '聊天框正在发送，稍后再试';
      if (reason === 'not-retained') return '该会话未保留，无法加入聊天框（请在会话打开时操作）';
      if (reason === 'stale-binding') return '会话已切换，请重试';
      if (reason === 'no-session') return '当前面板未绑定会话，无法加入聊天框';
      if (reason === 'unavailable') return '聊天框接口不可用，无法加入';
      return '加入聊天框失败，请重试';
    }
    /** 旧 Host（未重启、没有 /element 路由）与普通读失败分开提示。 */
    function pickElementFailureText(error) {
      const code = String((error && error.code) || '');
      const message = String((error && error.message) || '');
      if (code === 'UNSUPPORTED' || code === 'NOT_FOUND' || code === 'TOOL_NOT_FOUND'
        || /未知指令|unknown action|unsupported|not\s*found/i.test(message)) {
        return '当前宿主不支持选元素，请重启 DSH 后刷新面板';
      }
      return '获取元素失败，请稍后重试';
    }
    /** 输入框/可编辑区内的 Esc 不劫持（选元素模式退出监听用）。 */
    function pickEditableTarget(target) {
      if (!target || typeof target !== 'object') return false;
      if (target.isContentEditable === true) return true;
      const tag = String(target.tagName || '').toLowerCase();
      return tag === 'input' || tag === 'textarea' || tag === 'select';
    }
    /* ---- end pick pure helpers ---- */
    /** P0-D annotation layer: SVG namespace for the imperative draft node. */
