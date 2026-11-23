    const PRESETS = [
      { id: 'wide', label: '宽屏', w: 1920, h: 1080 },
      { id: 'landscape', label: '横屏', w: 1024, h: 768 },
      { id: 'tablet', label: '平板', w: 768, h: 1024 },
      { id: 'phone', label: '手机', w: 393, h: 852 },
    ];
    const BLENDER_PRESETS = [
      { id: 'performance', label: '性能', w: 960, h: 540 },
      { id: 'hd', label: '高清', w: 1280, h: 720 },
      { id: 'ultra', label: '极致', w: 1920, h: 1080 },
    ];
    /**
     * 用户 2026-11-03 第 3 条：默认分辨率按运行环境确定。只引用现有 PRESETS，不引入新尺寸；
     * 非 ready 环境只占位（选项 disabled，handler 仍判 ready）。
     */
    const ENV_DEFAULTS = Object.freeze({
      // 默认视图是空态画布，用横屏比例铺满，好让公共视图组件按真实尺寸展示。
      default: { preset: 'landscape', fit: true },
      web: { preset: 'landscape', fit: true },
      windows: { preset: 'landscape', fit: true },
      'linux-desktop': { preset: 'landscape', fit: true },
      macos: { preset: 'landscape', fit: true },
      tui: { preset: 'landscape', fit: true },
      android: { preset: 'phone', fit: true },
      harmonyos: { preset: 'phone', fit: true },
      game: { preset: 'wide', fit: true },
      'three-d': { preset: 'wide', fit: true },
      'mini-program': { preset: 'phone', fit: true },
    });
    function envDefaultSize(id) {
      const def = ENV_DEFAULTS[id] || ENV_DEFAULTS.web;
      const preset = PRESETS.find((item) => item.id === def.preset) || PRESETS[1];
      return { width: preset.w, height: preset.h, fit: def.fit !== false };
    }
    /** 左下角控制权状态：空闲 / 人类接管 / Agent 操作中。 */
    const MODE_LABEL = { idle: '空闲', human: '人类接管', agent: 'Agent 操作中' };

    /**
     * 视口共享状态（Host `ui.view`）的边界。`scalePercent` 是本面板的手动范围；
     * Host 的 `view.scale` 是 0.1–2.0 的共享比例（Agent 截图默认密度），不启用页面缩放/DPR。
     */
    const VIEW_LIMITS = {
      width: [200, 4096],
      height: [200, 4096],
      scroll: [0, 10000000],
      // P0-C v2 canvas origin C (docs/viewport-control.md): viewport top-left on the document
      // canvas, allowed to be negative or beyond the content box.
      canvas: [-10000000, 10000000],
      scalePercent: [10, 200],
    };
    /**
     * Host screenshot/T3 blank colour: evidence semantics, always #ffffff
     * (docs/viewport-control.md). The panel must NOT use it for display.
     */
    const CANVAS_BLANK_EVIDENCE = '#ffffff';
    /**
     * Panel-only blank: a dark checkerboard (user request 2026-11-02) so composited whitespace is
     * visible against white pages. Fixed host CSS pixels, independent of view.scale. This is a
     * local display style; the evidence/Host blank stays #ffffff.
     */
    const CANVAS_CHECKER = Object.freeze({ dark: '#2b2b2b', light: '#3f3f3f', size: 14 });
    /** 尺寸栏数值滚轮：向上增、向下减；Alt 优先于 Shift。 */
    const WHEEL_STEPS = {
      width: { normal: 10, shift: 100, alt: 1 },
      height: { normal: 10, shift: 100, alt: 1 },
      x: { normal: 10, shift: 100, alt: 1 },
      y: { normal: 10, shift: 100, alt: 1 },
      scale: { normal: 5, shift: 10, alt: 1 },
    };
    /** 本地编辑合并窗口与尺寸变更后的输入暂停上限（best-effort，帧协议不变）。 */
    const VIEW_DEBOUNCE_MS = 120;
    const GEOMETRY_WAIT_MS = 250;
    const POINTER_EPSILON = 0.001;
    const FRAME_WHEEL_LINE_CSS_PX = 16;
