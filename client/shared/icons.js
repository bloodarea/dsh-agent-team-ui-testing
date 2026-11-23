    function IconBrowser({ size = 16 }) {
      return h('svg', { width: size, height: size, viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', strokeWidth: 1.7, strokeLinecap: 'round', strokeLinejoin: 'round', 'aria-hidden': true },
        h('rect', { x: 3, y: 4.5, width: 18, height: 15, rx: 2.5 }),
        h('path', { d: 'M3 9h18M6.2 6.9h.01M9 6.9h.01' }));
    }
    function IconArrow({ dir }) {
      const d = dir === 'back' ? 'M14.5 5.5 8 12l6.5 6.5' : 'M9.5 5.5 16 12l-6.5 6.5';
      return h('svg', { width: 16, height: 16, viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', strokeWidth: 1.9, strokeLinecap: 'round', strokeLinejoin: 'round', 'aria-hidden': true }, h('path', { d }));
    }
    function IconReload() {
      return h('svg', { width: 16, height: 16, viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', strokeWidth: 1.8, strokeLinecap: 'round', strokeLinejoin: 'round', 'aria-hidden': true },
        h('path', { d: 'M19.5 12a7.5 7.5 0 1 1-2.6-5.7' }), h('path', { d: 'M19.8 4.6v4.2h-4.2' }));
    }
    /** 尺寸调整：视口/响应式（四角 + 内部视口）。 */
    function IconSize() {
      return h('svg', { width: 16, height: 16, viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', strokeWidth: 1.7, strokeLinecap: 'round', strokeLinejoin: 'round', 'aria-hidden': true },
        h('path', { d: 'M4.2 8.6V5.4a1.2 1.2 0 0 1 1.2-1.2h3.2' }),
        h('path', { d: 'M15.4 4.2h3.2a1.2 1.2 0 0 1 1.2 1.2v3.2' }),
        h('path', { d: 'M19.8 15.4v3.2a1.2 1.2 0 0 1-1.2 1.2h-3.2' }),
        h('path', { d: 'M8.6 19.8H5.4a1.2 1.2 0 0 1-1.2-1.2v-3.2' }),
        h('rect', { x: 8.6, y: 8.6, width: 6.8, height: 6.8, rx: 1.4 }));
    }
    /**
     * 标签保活锁（人力开关）。
     *
     * 形状优先，颜色只作辅助：14px 下颜色差异不够读，所以两种状态的**锁梁几何**必须不同。
     *   - 已锁：锁梁两端都落到锁体顶面，锁体实心（闭合）；
     *   - 未锁：锁梁从锁体左上抬起、绕到右上方就断掉，右端悬在锁体上方留出明显缺口，锁体空心。
     * 缺口在 14px 下仍有约 3px，放大后一眼可分。
     */
    function IconTabLock({ locked }) {
      const common = { width: 14, height: 14, viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', strokeLinecap: 'round', strokeLinejoin: 'round', 'aria-hidden': true };
      if (locked) {
        return h('svg', Object.assign({}, common, { strokeWidth: 2.1 }),
          h('rect', { key: 'body', x: 3.6, y: 12, width: 15.4, height: 8.6, rx: 2.4, fill: 'currentColor', stroke: 'none' }),
          // 闭合锁梁：左端、右端都落在锁体顶面 (y=12)。
          h('path', { key: 'shackle', d: 'M7.4 12V7.4a4.6 4.6 0 0 1 9.2 0V12' }));
      }
      return h('svg', Object.assign({}, common, { strokeWidth: 2.1 }),
        // 开锁：锁体只描边；锁梁从左上起，右端停在 y=7.1 悬空，不再落到锁体。
        h('rect', { key: 'body', x: 3.6, y: 12, width: 15.4, height: 8.6, rx: 2.4 }),
        h('path', { key: 'shackle', d: 'M12 12V7.1a3.9 3.9 0 0 1 7.8 0' }));
    }
    /**
     * 页面声音开关：喇叭 + 两条声波表示"已开"，斜杠表示"静音"。
     * 形状优先（14–16px 下颜色差不明显），两种状态靠"有没有斜杠"区分。
     */
    function IconSound({ muted }) {
      const common = { width: 16, height: 16, viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', strokeWidth: 1.7, strokeLinecap: 'round', strokeLinejoin: 'round', 'aria-hidden': true };
      const body = h('path', { d: 'M4.2 9.4h3.1l4.3-3.3v11.8L7.3 14.6H4.2z' });
      if (muted) {
        return h('svg', common, body, h('path', { d: 'm14.6 9.6 5 4.8' }), h('path', { d: 'm19.6 9.6-5 4.8' }));
      }
      return h('svg', common, body,
        h('path', { d: 'M14.8 9.2a4 4 0 0 1 0 5.6' }),
        h('path', { d: 'M17.6 6.9a7.4 7.4 0 0 1 0 10.2' }));
    }

    /** 标注：画笔（用户 2026-11-02 要求，入口图标）。 */
    function IconAnnot() {
      return h('svg', { width: 16, height: 16, viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', strokeWidth: 1.7, strokeLinecap: 'round', strokeLinejoin: 'round', 'aria-hidden': true },
        h('path', { d: 'M15.6 4.4a1.9 1.9 0 0 1 2.7 2.7L8.9 16.5l-4.2 1.5 1.5-4.2Z' }),
        h('path', { d: 'm13.8 6.2 3.2 3.2' }));
    }
    /** 标注子工具的小图标（16×16、currentColor、stroke 1.7）。 */
    function IconAnnotTool({ tool }) {
      const svg = (children) => h('svg', { width: 16, height: 16, viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', strokeWidth: 1.7, strokeLinecap: 'round', strokeLinejoin: 'round', 'aria-hidden': true }, children);
      // 选择：鼠标指针箭头（白芯描边，和十字形的绘制工具区分开）。
      if (tool === 'select') return svg(h('path', { d: 'M6.2 3.8v14.2l3.8-3.5 2.5 5.2 2.6-1.2-2.5-5.2 5-.5Z' }));
      // 框选：虚线矩形（与实线「矩形」绘制工具同尺寸，靠虚线区分）。
      if (tool === 'marquee') return svg(h('rect', { x: 4.5, y: 5.5, width: 15, height: 13, rx: 1.2, strokeDasharray: '2.6 2.4' }));
      if (tool === 'circle') return svg(h('circle', { cx: 12, cy: 12, r: 7 }));
      if (tool === 'rect') return svg(h('rect', { x: 4.5, y: 5.5, width: 15, height: 13, rx: 1.2 }));
      if (tool === 'line') return svg(h('path', { d: 'M5.5 18.5 18.5 5.5' }));
      if (tool === 'arrow') return svg([h('path', { key: 'shaft', d: 'M5.5 18.5 17.4 6.6' }), h('path', { key: 'head', d: 'M11.6 6.2h6.6v6.6' })]);
      if (tool === 'brush') return svg([h('path', { key: 'body', d: 'M15.6 4.4a1.9 1.9 0 0 1 2.7 2.7L8.9 16.5l-4.2 1.5 1.5-4.2Z' }), h('path', { key: 'tip', d: 'm13.8 6.2 3.2 3.2' })]);
      // 橡皮擦（v2，§11.4）：16×16、currentColor、1.7 描边。
      if (tool === 'eraser') return svg([
        h('path', { key: 'body', d: 'M10.4 19.8 4.6 14a1.7 1.7 0 0 1 0-2.4l7.2-7.2a1.7 1.7 0 0 1 2.4 0l4.3 4.3a1.7 1.7 0 0 1 0 2.4l-9.1 9.1Z' }),
        h('path', { key: 'seam', d: 'm9.4 8.7 6.7 6.7' }),
        h('path', { key: 'tray', d: 'M9.2 19.8H19.4' }),
      ]);
      return svg([h('path', { key: 'top', d: 'M5 6.5h14' }), h('path', { key: 'stem', d: 'M12 6.5v11' }), h('path', { key: 'base', d: 'M9 17.5h6' })]);
    }
    function IconInspect() {
      return h('svg', { width: 16, height: 16, viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', strokeWidth: 1.6, strokeLinecap: 'round', strokeLinejoin: 'round', 'aria-hidden': true },
        h('path', { d: 'M4 9V6.6C4 5.2 5.2 4 6.6 4H9M15 4h2.4C18.8 4 20 5.2 20 6.6V9M4 15v2.4C4 18.8 5.2 20 6.6 20H9', strokeDasharray: '2.6 2.2' }),
        h('path', { d: 'm12.4 10.6 2.9 8.6 1.6-3.4 3.5-1.4-8-3.8Z', fill: 'currentColor', strokeWidth: 0 }));
    }
    function IconChevron() {
      return h('svg', { width: 12, height: 12, viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', strokeWidth: 2, strokeLinecap: 'round', strokeLinejoin: 'round', 'aria-hidden': true }, h('path', { d: 'm6 9 6 6 6-6' }));
    }
    function IconWindow() {
      return h('svg', { width: 18, height: 18, viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', strokeWidth: 1.7, strokeLinecap: 'round', strokeLinejoin: 'round', 'aria-hidden': true },
        h('rect', { x: 3, y: 5, width: 18, height: 14, rx: 2.5 }),
        h('path', { d: 'M3 9.5h18' }),
        h('path', { d: 'M6.3 7.3h.01M8.8 7.3h.01' }));
    }
    /** 地址栏历史：时钟箭头（点击展开最近访问）。 */
    function IconHistory() {
      return h('svg', { width: 14, height: 14, viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', strokeWidth: 1.8, strokeLinecap: 'round', strokeLinejoin: 'round', 'aria-hidden': true },
        h('path', { d: 'M3.5 12a8.5 8.5 0 1 0 2.6-6.1' }), h('path', { d: 'M3.2 4.4v4.2h4.2' }), h('path', { d: 'M12 8.2V12l2.9 1.8' }));
    }
    /** 转到：右箭头 + 落点竖线（等同回车跳转地址）。 */
    function IconGo() {
      return h('svg', { width: 16, height: 16, viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', strokeWidth: 1.9, strokeLinecap: 'round', strokeLinejoin: 'round', 'aria-hidden': true },
        h('path', { d: 'M4.5 12h12' }), h('path', { d: 'm12.2 7.4 4.6 4.6-4.6 4.6' }), h('path', { d: 'M19.6 6.4v11.2' }));
    }
    function IconMore() {
      return h('svg', { width: 16, height: 16, viewBox: '0 0 24 24', fill: 'currentColor', 'aria-hidden': true },
        h('circle', { cx: 5.5, cy: 12, r: 1.5 }), h('circle', { cx: 12, cy: 12, r: 1.5 }), h('circle', { cx: 18.5, cy: 12, r: 1.5 }));
    }
