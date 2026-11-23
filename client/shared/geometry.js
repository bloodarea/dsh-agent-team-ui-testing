    const PAN_WRITE_THROTTLE_MS = 80;

    function clampNumber(value, min, max) {
      const number = Number(value);
      if (!Number.isFinite(number)) return min;
      return Math.max(min, Math.min(max, number));
    }

    /** Finite number, or null for missing/invalid metadata (never coerces null to 0). */
    function finiteOrNull(value) {
      if (value === null || value === undefined || value === '') return null;
      const number = Number(value);
      return Number.isFinite(number) ? number : null;
    }

    /** `ui.view` (v1) from any Host snapshot shape; null for an old Host without shared view. */
    function viewOf(payload) {
      if (!payload || typeof payload !== 'object') return null;
      const state = payload.state && typeof payload.state === 'object' ? payload.state : payload;
      const ui = state && state.ui && typeof state.ui === 'object' ? state.ui : null;
      const view = ui && ui.view && typeof ui.view === 'object' && Number(ui.view.version) === 1 ? ui.view : null;
      return view;
    }

    /** `ui.viewMeta` / `ui.observed` companions of the same snapshot. */
    function viewCompanionsOf(payload) {
      const state = payload && payload.state && typeof payload.state === 'object' ? payload.state : payload;
      const ui = state && state.ui && typeof state.ui === 'object' ? state.ui : null;
      return {
        viewMeta: ui && ui.viewMeta && typeof ui.viewMeta === 'object' ? ui.viewMeta : null,
        observed: ui && ui.observed && typeof ui.observed === 'object' ? ui.observed : null,
      };
    }

    /**
     * Shared canvas projection (`ui.canvas`, docs/viewport-control.md). Its presence is the
     * capability handshake: a Host without it is an old Host, so the panel keeps the legacy
     * scroll-only X/Y behaviour and disables canvas editing/drag (fail closed, no guessing).
     */
    function canvasOf(payload) {
      if (!payload || typeof payload !== 'object') return null;
      const state = payload.state && typeof payload.state === 'object' ? payload.state : payload;
      const ui = state && state.ui && typeof state.ui === 'object' ? state.ui : null;
      const canvas = ui && ui.canvas && typeof ui.canvas === 'object' && Number(ui.canvas.version) === 1 ? ui.canvas : null;
      return canvas;
    }

    /** Draw-displacement inputs of one displayed frame (canvas compositing, §5.2). */
    function frameScrollOf(meta, fallback) {
      const pick = (key) => {
        if (!meta || meta[key] === undefined || meta[key] === null) return null;
        const value = Number(meta[key]);
        if (Number.isFinite(value)) return value;
        return fallback && Number.isFinite(Number(fallback[key])) ? Number(fallback[key]) : null;
      };
      return { x: pick('scrollX'), y: pick('scrollY') };
    }

    /** Round a canvas coordinate to two decimals (Host accepts CSS floats). */
    function roundCanvas(value) {
      return Math.round(Number(value) * 100) / 100;
    }

    /**
     * Painted image rect for `object-fit: contain; object-position: 50% 50%` (contract §5.1).
     * `rect` is the img content box in *host* CSS px (border/padding already excluded by the
     * layout), natural* are the decoded frame pixels. The host window DPR never enters this
     * formula: event.clientX/Y, getBoundingClientRect and the target viewport are all CSS px.
     */
    /** 单选 <select> 面板浮层的几何参数（纯数据；契约测试按源码抽取校验）。 */
    const SELECT_POP_GEOMETRY = {
      itemHeight: 26, minWidth: 160, maxWidth: 280, edge: 8, gap: 4, pad: 4, maxVisibleItems: 12,
    };
    /** 点击与按下点之间的最大偏移：超过就算拖拽，不弹浮层。 */
    const SELECT_CLICK_SLOP_PX = 4;

    /**
     * 原生 <select> 浮层的定位（纯函数，无 DOM）。
     *
     * 输入：点击点在画面框内的 CSS px、要显示的行数、画面框的可用宽高；输出浮层的
     * left/top/width/maxHeight 以及是否上翻/左移。规则：
     *   ① 优先在点击点下方展开；② 下方放不下、上方放得下 → 上翻；
     *   ③ 两侧都放不下 → 取空间较大的一侧，并把高度截断（列表内部滚动）；
     *   ④ 任何情况下都夹在框内（edge 内边距），水平越界则左移。
     * 行数再乘 itemHeight 得到自然高度；maxVisibleItems 是"不滚动时最多显示几行"的上限。
     */
    function selectPopLayout(point, itemCount, bounds) {
      const g = SELECT_POP_GEOMETRY;
      const boxW = Math.max(0, Number(bounds && bounds.width) || 0);
      const boxH = Math.max(0, Number(bounds && bounds.height) || 0);
      const rawX = Number(point && point.x);
      const rawY = Number(point && point.y);
      const x = Number.isFinite(rawX) ? rawX : 0;
      const y = Number.isFinite(rawY) ? rawY : 0;
      const count = Math.max(0, Math.floor(Number(itemCount) || 0));
      // 高度按"最多 maxVisibleItems 行"算，但**所有条目都要渲染**（容器自己滚动）：
      // 截断只发生在高度上，绝不能把第 13 项之后的选项从列表里丢掉。
      const rowsForHeight = Math.max(1, Math.min(count, g.maxVisibleItems));
      const natural = rowsForHeight * g.itemHeight + g.pad * 2;
      const minHeight = g.itemHeight + g.pad * 2;
      const roomBelow = Math.max(0, boxH - y - g.gap - g.edge);
      const roomAbove = Math.max(0, y - g.gap - g.edge);
      let side = 'below';
      let top;
      let maxHeight;
      if (natural <= roomBelow) {
        top = y + g.gap;
        maxHeight = natural;
      } else if (natural <= roomAbove) {
        side = 'above';
        top = y - g.gap - natural;
        maxHeight = natural;
      } else if (roomBelow >= roomAbove) {
        top = y + g.gap;
        maxHeight = Math.max(minHeight, Math.min(natural, roomBelow));
      } else {
        side = 'above';
        maxHeight = Math.max(minHeight, Math.min(natural, roomAbove));
        top = y - g.gap - maxHeight;
      }
      // ④ 硬夹进画面框：极端窄/矮面板也不许画到框外。
      if (top + maxHeight > boxH - g.edge) top = boxH - g.edge - maxHeight;
      if (top < g.edge) top = g.edge;
      const room = Math.max(1, boxW - g.edge * 2);
      const preferred = Math.max(g.minWidth, Math.min(g.maxWidth, room));
      const width = Math.max(1, Math.min(preferred, room));
      const wantedLeft = x - g.pad;
      const lastLeft = Math.max(g.edge, boxW - g.edge - width);
      const left = Math.min(Math.max(g.edge, wantedLeft), lastLeft);
      const visibleItems = Math.max(1, Math.floor((maxHeight - g.pad * 2) / g.itemHeight));
      return {
        left: Math.round(left * 1000) / 1000,
        top: Math.round(top * 1000) / 1000,
        width: Math.round(width * 1000) / 1000,
        maxHeight: Math.round(maxHeight * 1000) / 1000,
        side,
        flippedUp: side === 'above',
        shiftedLeft: left < wantedLeft - 0.5,
        itemHeight: g.itemHeight,
        pad: g.pad,
        visibleItems,
        scrolls: count > visibleItems,
      };
    }

    function paintedRect(rect, naturalW, naturalH) {
      const nw = Number(naturalW) || 0;
      const nh = Number(naturalH) || 0;
      if (!nw || !nh || !rect || !(Number(rect.width) > 0) || !(Number(rect.height) > 0)) return null;
      const k = Math.min(Number(rect.width) / nw, Number(rect.height) / nh);
      const width = nw * k;
      const height = nh * k;
      return {
        left: Number(rect.left) + (Number(rect.width) - width) / 2,
        top: Number(rect.top) + (Number(rect.height) - height) / 2,
        width,
        height,
        naturalW: nw,
        naturalH: nh,
      };
    }

    /**
     * One wheel delta in *target page* CSS px. deltaMode is fixed, not guessed:
     * 0 = host CSS px, 1 = 16 CSS px per line, 2 = one page (painted rect) per unit.
     */
    function frameWheelDelta(delta, mode, paintedSize, viewportSize) {
      const raw = Number(delta) || 0;
      if (!raw) return 0;
      if (!(paintedSize > 0) || !(viewportSize > 0)) return 0;
      if (Number(mode) === 1) return raw * FRAME_WHEEL_LINE_CSS_PX * (viewportSize / paintedSize);
      if (Number(mode) === 2) return raw * viewportSize;
      return raw * (viewportSize / paintedSize);
    }
