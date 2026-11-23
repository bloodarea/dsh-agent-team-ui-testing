    /* =====================================================================================
     * DSH 设置页：第五节点为卡片目标；第三节点接口与第四节点执行端以同级标签展示。
     * 配置与就绪状态来自 Host（GET/PUT /config）：页面只提交意图，Host revision 是唯一真值。
     * Host 未提供接口时页面保持可用，但明确显示读取失败，绝不把任何目标标成已就绪或显示版本。
     * ===================================================================================== */
    const TARGET_CHAINS = {
      chromium: { communication: 'CDP', backend: 'Chromium DevTools' },
      electron: { communication: 'CDP / RPC', backend: 'Electron DevTools / 桌面自动化服务' },
      linux: { communication: 'D-Bus / X11 / Wayland', backend: 'AT-SPI / 桌面输入服务' },
      webkitgtk: { communication: 'WebKit Inspector / D-Bus', backend: 'WebKitGTK 调试后端 / AT-SPI' },
      windows: { communication: 'RPC / 系统 API', backend: 'UI Automation / 桌面输入服务' },
      webview2: { communication: 'CDP / RPC', backend: 'WebView2 DevTools / UI Automation' },
      macos: { communication: 'RPC / 系统 API', backend: 'Accessibility / 桌面输入服务' },
      wkwebview: { communication: 'WebKit Inspector / RPC', backend: 'WebKit 调试后端 / Accessibility' },
      android: { communication: 'ADB / RPC', backend: 'UI Automator / 系统输入服务' },
      androidWeb: { communication: 'ADB / CDP', backend: 'UI Automator / WebView DevTools' },
      terminal: { communication: 'PTY / IPC', backend: '终端会话服务' },
      harmonyos: { communication: 'HDC / RPC', backend: 'UiTest / 系统输入服务' },
      native3d: { communication: 'RPC / IPC', backend: '桌面自动化服务 / 应用辅助程序' },
    };

    /** 每张卡片表示运行中的应用类型；框架只作为技术栈说明。状态来自 Host 就绪结果。 */
    function plannedTarget(id, name, note, chain) {
      return { id, name, note, chain, state: 'planned' };
    }

    function miniProgramTarget(id, platform) {
      return plannedTarget(id, platform + '小程序', '运行于' + platform + '小程序容器的应用', {
        communication: '平台自动化接口（待选）', backend: platform + '开发者工具 / 辅助程序（待选）',
      });
    }

    const TARGET_ENV_GROUPS = [
      {
        id: 'web', title: 'Web 视图',
        targets: [
          { id: 'chrome', name: 'Chrome', note: 'Chrome / Chromium 中运行的网页', chain: TARGET_CHAINS.chromium,
            state: 'supported' },
          // Edge 与 Chrome 共用 CDP 执行端，已是「已实现」；是否真的可跑仍由 Host 就绪的依赖轴
          // （providers.edge.axes.dependency）回答，卡片不得据此显示成「可用」。
          Object.assign(plannedTarget('edge', 'Edge', 'Edge 中运行的网页', {
            communication: 'CDP', backend: 'Edge DevTools',
          }), { state: 'supported' }),
          Object.assign(plannedTarget('firefox', 'Firefox', 'Firefox 中运行的网页', {
            communication: 'WebDriver BiDi', backend: 'Firefox Remote Agent',
          }), { state: 'unsupported' }),
        ],
      },
      {
        id: 'linux-desktop', title: 'Linux 视图',
        targets: [
          plannedTarget('linux-native', 'Linux 原生桌面应用', 'GTK / Qt / Flutter 等原生窗口', TARGET_CHAINS.linux),
          plannedTarget('electron', 'Electron 应用', 'Chromium 页面与原生应用窗口', TARGET_CHAINS.electron),
          plannedTarget('tauri', 'Tauri 应用', 'WebKitGTK 页面与原生应用窗口', TARGET_CHAINS.webkitgtk),
        ],
      },
      {
        id: 'windows', title: 'Windows 视图',
        targets: [
          plannedTarget('windows-native', 'Windows 原生桌面应用', 'Win32 / Qt / Flutter 等原生窗口', TARGET_CHAINS.windows),
          plannedTarget('dotnet', '.NET 桌面应用', 'WPF / Windows Forms', TARGET_CHAINS.windows),
          plannedTarget('winui3', 'WinUI 3 应用', 'Windows App SDK 应用', TARGET_CHAINS.windows),
          plannedTarget('win-electron', 'Electron 应用', 'Chromium 页面与原生应用窗口', TARGET_CHAINS.electron),
          plannedTarget('win-tauri', 'Tauri 应用', 'WebView2 页面与原生应用窗口', TARGET_CHAINS.webview2),
        ],
      },
      {
        id: 'macos', title: 'macOS 视图',
        targets: [
          plannedTarget('macos-native', 'macOS 原生桌面应用', 'AppKit / SwiftUI / Qt / Flutter', TARGET_CHAINS.macos),
          plannedTarget('mac-electron', 'Electron 应用', 'Chromium 页面与原生应用窗口', TARGET_CHAINS.electron),
          plannedTarget('mac-tauri', 'Tauri 应用', 'WKWebView 页面与原生应用窗口', TARGET_CHAINS.wkwebview),
        ],
      },
      {
        id: 'android', title: 'Android 视图',
        targets: [
          plannedTarget('android-native', 'Android 原生应用', 'Android Views / Jetpack Compose', TARGET_CHAINS.android),
          plannedTarget('android-webview', 'Android WebView 应用', '内嵌网页；Capacitor / Cordova', TARGET_CHAINS.androidWeb),
          plannedTarget('android-flutter', 'Flutter Android 应用', 'Flutter 引擎渲染的应用', TARGET_CHAINS.android),
          plannedTarget('react-native', 'React Native 应用', 'Android 原生视图与 JS 运行时', TARGET_CHAINS.android),
        ],
      },
      {
        id: 'tui', title: 'TUI 视图',
        targets: [
          plannedTarget('python-tui', 'Python 终端应用', 'Textual 等终端界面', TARGET_CHAINS.terminal),
          plannedTarget('node-tui', 'Node.js 终端应用', 'Ink / blessed 等终端界面', TARGET_CHAINS.terminal),
          plannedTarget('go-tui', 'Go 终端应用', 'Bubble Tea 等终端界面', TARGET_CHAINS.terminal),
          plannedTarget('rust-tui', 'Rust 终端应用', 'Ratatui 等终端界面', TARGET_CHAINS.terminal),
        ],
      },
      {
        id: 'harmonyos', title: 'HarmonyOS 视图',
        targets: [
          plannedTarget('harmony-native', '鸿蒙原生应用', 'ArkUI / ArkTS', TARGET_CHAINS.harmonyos),
          plannedTarget('arkui-x', 'ArkUI-X 应用', 'ArkUI 跨平台应用', TARGET_CHAINS.harmonyos),
          plannedTarget('harmony-flutter', 'Flutter 鸿蒙应用', 'Flutter 鸿蒙适配应用', TARGET_CHAINS.harmonyos),
          plannedTarget('harmony-rn', 'React Native 鸿蒙应用', 'React Native 鸿蒙适配应用', TARGET_CHAINS.harmonyos),
        ],
      },
      {
        id: 'game', title: '游戏视图',
        targets: [
          plannedTarget('unity', 'Unity 游戏', 'Unity Player 中运行的游戏', {
            communication: 'RPC / IPC', backend: 'Unity 调试辅助程序（待选）',
          }),
          plannedTarget('unreal', 'Unreal 游戏', 'Unreal Engine 游戏实例', {
            communication: 'RPC / IPC', backend: 'Unreal 调试辅助程序（待选）',
          }),
          plannedTarget('godot', 'Godot 游戏', 'Godot 游戏实例', {
            communication: '引擎调试协议 / RPC', backend: 'Godot 调试后端 / 辅助程序（待选）',
          }),
          plannedTarget('cocos', 'Cocos 游戏', 'Cocos 原生或 Web 游戏实例', {
            communication: 'CDP / RPC', backend: 'DevTools / 引擎辅助程序（待选）',
          }),
        ],
      },
      {
        id: 'three-d', title: '3D 视图',
        targets: [
          plannedTarget('web-3d', 'Web 三维应用', 'Three.js / Babylon.js / PlayCanvas；WebGL / WebGPU', TARGET_CHAINS.chromium),
          plannedTarget('native-3d', '原生三维应用', '原生窗口中的三维场景', TARGET_CHAINS.native3d),
          plannedTarget('three-unity', 'Unity 三维应用', 'Unity Player 中的交互式三维场景', {
            communication: 'RPC / IPC', backend: 'Unity 调试辅助程序（待选）',
          }),
          { id: 'blender', name: 'Blender', note: '启用 3D 视图后，在调试视图中打开 Blender 纯视口。',
            chain: { communication: 'Blender Python / PNG', backend: 'Blender 3D 视口' }, state: 'preview' },
          plannedTarget('3dsmax', '3ds Max', '3ds Max 场景、模型与材质编辑器', {
            communication: 'RPC / IPC（MAXScript 待评估）', backend: '3ds Max 脚本与辅助程序（待实现）',
          }),
          plannedTarget('mmd', 'MikuMikuDance（MMD）', 'MMD 动画、模型预览与动作编辑（PMD/PMX/VMD）', {
            communication: 'RPC / IPC（待评估）', backend: 'MMD 辅助程序（待实现）',
          }),
          plannedTarget('pmx-editor', 'PMX Editor', 'PMX 模型结构、材质与变形编辑', {
            communication: 'RPC / IPC（待评估）', backend: 'PMX Editor 辅助程序（待实现）',
          }),
        ],
      },
      {
        id: 'mini-program', title: '小程序视图',
        targets: [
          miniProgramTarget('wechat', '微信'),
          miniProgramTarget('alipay', '支付宝'),
          miniProgramTarget('douyin', '抖音'),
          miniProgramTarget('qq', 'QQ'),
          miniProgramTarget('baidu', '百度智能'),
          miniProgramTarget('kuaishou', '快手'),
          miniProgramTarget('jd', '京东'),
          miniProgramTarget('meituan', '美团'),
          miniProgramTarget('xiaohongshu', '小红书'),
          miniProgramTarget('taobao', '淘宝'),
          miniProgramTarget('dingtalk', '钉钉'),
        ],
      },
    ];

    /** 设置页样式：只作用于 `.uts-*`，不覆盖宿主设置页的其它样式。 */
    const TARGET_ENV_CSS = `
.uts-settings { display: flex; flex-direction: column; gap: 20px; font-size: 13px; line-height: 20px; color: var(--dsw-alias-label-primary); }
.uts-head { display: flex; flex-direction: column; gap: 4px; }
.uts-head-row { display: flex; align-items: center; justify-content: space-between; flex-wrap: wrap; gap: 8px 12px; }
.uts-filter { display: inline-flex; align-items: center; gap: 8px; margin-left: auto; color: var(--dsw-alias-label-secondary); font-size: 12px; }
.uts-page-title { margin: 0; font-size: 16px; font-weight: 500; line-height: 24px; }
.uts-page-desc { margin: 0; font-size: 13px; line-height: 20px; color: var(--dsw-alias-label-secondary); }
.uts-body { display: flex; flex-direction: column; gap: 12px; }
.uts-title { margin: 0; font-size: 14px; font-weight: 600; line-height: 20px; }
.uts-chain-guide { margin: 0; color: var(--dsw-alias-label-secondary); font-size: 12px; line-height: 20px; overflow-wrap: anywhere; }
.uts-groups { display: flex; flex-direction: column; gap: 18px; }
.uts-group { display: flex; flex-direction: column; gap: 8px; }
.uts-group-heading { display: flex; align-items: center; gap: 8px; margin: 0; font-size: 13px; font-weight: 600; line-height: 20px; }
.uts-card-head { display: flex; align-items: flex-start; justify-content: space-between; gap: 8px; }
.uts-card-title { display: inline-flex; align-items: center; flex-wrap: wrap; gap: 6px; min-width: 0; }
.uts-card-switch { flex: none; display: inline-flex; align-items: center; }
.uts-card-foot { display: flex; align-items: flex-end; justify-content: space-between; gap: 8px; margin-top: auto; }
.uts-card-actions { display: flex; gap: 6px; }
.uts-card-foot .uts-card-actions { margin: 0 0 0 auto; }
.uts-diagnose-btn { box-sizing: border-box; padding: 2px 8px; font: inherit; font-size: 11px; line-height: 16px; color: var(--dsw-alias-label-secondary); background: transparent; border: .5px solid var(--dsw-alias-border-l2); border-radius: 6px; cursor: pointer; }
.uts-diagnose-btn:hover { color: var(--dsw-alias-label-primary); border-color: var(--dsw-alias-border-l1); }
.uts-diagnostics .uts-axes { margin-top: 8px; }
.uts-diagnostics .uts-head-row { gap: 8px; }
.uts-group-env { display: inline-flex; align-items: center; gap: 6px; margin-left: auto; padding: 2px 8px; font-size: 12px; font-weight: 400; color: var(--dsw-alias-label-secondary); }
.uts-group-toggle { display: flex; align-items: center; gap: 8px; width: 100%; margin: 0; padding: 4px 8px; font: inherit; font-weight: 600; line-height: 20px; color: var(--dsw-alias-label-primary); text-align: left; background: transparent; border: 0; border-radius: 8px; cursor: pointer; }
.uts-group-toggle:hover { background: var(--dsw-alias-bg-layer-2); }
.uts-group-toggle:focus-visible { outline: 2px solid var(--dsw-alias-brand-primary); outline-offset: 1px; }
.uts-group-title { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.uts-group-count { flex: 0 0 auto; color: var(--dsw-alias-label-tertiary); font-size: 12px; font-weight: 400; }
.uts-group-chevron { flex: 0 0 auto; margin-left: auto; display: grid; place-items: center; color: var(--dsw-alias-label-secondary); transform: rotate(-90deg); transition: transform .15s ease; }
.uts-group[data-uts-expanded="true"] .uts-group-chevron { transform: rotate(0deg); }
.uts-cards { display: grid; grid-template-columns: repeat(auto-fill, minmax(160px, 1fr)); gap: 12px 20px; }
.uts-item { display: flex; flex-direction: column; min-width: 0; }
.uts-card { box-sizing: border-box; width: 100%; flex: 1 1 auto; display: flex; flex-direction: column; gap: 8px; padding: 12px 14px; border: .5px solid var(--dsw-alias-border-l2); border-radius: 12px; background: var(--dsw-alias-bg-layer-1); }
.uts-card-name { font-size: 13px; font-weight: 600; line-height: 20px; overflow-wrap: anywhere; }
.uts-card-note { display: -webkit-box; -webkit-box-orient: vertical; -webkit-line-clamp: 2; line-clamp: 2; overflow: hidden;
  font-size: 12px; line-height: 18px; max-height: 36px; color: var(--dsw-alias-label-tertiary); overflow-wrap: anywhere; }
.uts-field { display: flex; flex-direction: column; gap: 2px; min-width: 0; }
.uts-field-inline { flex-direction: row; align-items: center; gap: 8px; }
.uts-field-label { font-size: 12px; line-height: 18px; color: var(--dsw-alias-label-secondary); }
.uts-field-value { font-size: 12px; line-height: 18px; color: var(--dsw-alias-label-primary); font-variant-numeric: tabular-nums; overflow-wrap: anywhere; }
.uts-field-value[data-uts-valid="false"], .uts-field-value[data-uts-valid="unknown"] { color: var(--dsw-alias-label-tertiary); }
.uts-empty { margin: 0; font-size: 12px; line-height: 18px; color: var(--dsw-alias-label-tertiary); }
.uts-tags { display: flex; flex-wrap: wrap; align-items: flex-start; gap: 6px; margin-top: auto; min-width: 0; }
.uts-card-state { font-size: 12px; line-height: 18px; color: var(--dsw-alias-label-tertiary); }
.uts-tag { box-sizing: border-box; display: inline-flex; align-items: center; min-height: 18px; max-width: 100%; padding: 2px 7px; border-radius: 6px; font-size: 11px; line-height: 16px; white-space: normal; overflow-wrap: anywhere; color: var(--dsw-alias-label-tertiary); background: var(--dsw-alias-bg-layer-2); border: .5px solid var(--dsw-alias-border-l2); }
.uts-tag[data-uts-tag="supported"] { color: #16a34a; background: color-mix(in srgb, #16a34a 12%, transparent); border-color: color-mix(in srgb, #16a34a 35%, transparent); }
.uts-chain { margin-top: 0; margin-bottom: 10px; }
.uts-axes { display: grid; grid-template-columns: repeat(auto-fill, minmax(150px, 1fr)); gap: 6px 14px; padding: 8px 10px; border: .5px dashed var(--dsw-alias-border-l2); border-radius: 8px; background: var(--dsw-alias-bg-layer-1); }
.uts-axis { display: flex; flex-direction: column; min-width: 0; }
.uts-axis-head { display: flex; align-items: baseline; gap: 6px; min-width: 0; }
.uts-axis-label { font-size: 11px; line-height: 16px; color: var(--dsw-alias-label-secondary); }
.uts-axis-status { font-size: 11px; line-height: 16px; font-weight: 600; color: var(--dsw-alias-label-tertiary); }
.uts-axis-reason { font-size: 11px; line-height: 16px; color: var(--dsw-alias-label-tertiary); overflow-wrap: anywhere; }
.uts-axis[data-uts-status="supported"] .uts-axis-status,
.uts-axis[data-uts-status="ok"] .uts-axis-status,
.uts-axis[data-uts-status="bound"] .uts-axis-status,
.uts-axis[data-uts-status="available"] .uts-axis-status,
.uts-axis[data-uts-status="true"] .uts-axis-status { color: #16a34a; }
.uts-axis[data-uts-status="failed"] .uts-axis-status,
.uts-axis[data-uts-status="degraded"] .uts-axis-status,
.uts-axis[data-uts-status="stale"] .uts-axis-status,
.uts-axis[data-uts-status="partial"] .uts-axis-status,
.uts-axis[data-uts-status="unavailable"] .uts-axis-status { color: #d97706; }
.uts-config-error { margin: 0; padding: 8px 10px; border-radius: 8px; font-size: 12px; line-height: 18px; color: #b91c1c; background: color-mix(in srgb, #b91c1c 10%, transparent); border: .5px solid color-mix(in srgb, #b91c1c 30%, transparent); overflow-wrap: anywhere; }
.uts-config-meta { display: flex; flex-wrap: wrap; gap: 4px 12px; margin: 0; font-size: 11px; line-height: 16px; color: var(--dsw-alias-label-tertiary); }
.uts-config-actions { display: flex; align-items: center; flex-wrap: wrap; gap: 8px 12px; margin-left: auto; }
.uts-link-btn { padding: 2px 8px; font: inherit; font-size: 12px; line-height: 18px; color: var(--dsw-alias-brand-primary); background: transparent; border: .5px solid var(--dsw-alias-border-l2); border-radius: 6px; cursor: pointer; }
.uts-link-btn:disabled { color: var(--dsw-alias-label-tertiary); cursor: not-allowed; }
.uts-switch { position: relative; display: inline-flex; align-items: center; width: 32px; height: 18px; flex: 0 0 auto; cursor: pointer; }
.uts-switch-input { position: absolute; inset: 0; width: 100%; height: 100%; margin: 0; opacity: 0; cursor: inherit; }
.uts-switch-input:disabled { cursor: not-allowed; }
.uts-switch-track { position: relative; display: block; width: 32px; height: 18px; border-radius: 999px; background: var(--dsw-alias-bg-layer-3, color-mix(in srgb, var(--dsw-alias-label-primary) 18%, transparent)); transition: background-color .15s ease; }
.uts-switch-thumb { position: absolute; top: 2px; left: 2px; width: 14px; height: 14px; border-radius: 50%; background: #fff; box-shadow: 0 1px 2px rgba(0, 0, 0, .28); transition: transform .15s ease; }
.uts-switch-input:checked + .uts-switch-track { background: var(--dsw-alias-brand-primary); }
.uts-switch-input:checked + .uts-switch-track .uts-switch-thumb { transform: translateX(14px); }
.uts-switch-input:disabled + .uts-switch-track { opacity: .45; }
.uts-switch-input:focus-visible + .uts-switch-track { outline: 2px solid var(--dsw-alias-brand-primary); outline-offset: 2px; }
@media (prefers-reduced-motion: reduce) { .uts-switch-track, .uts-switch-thumb, .uts-group-chevron { transition: none; } }
/* --- 诊断页四个板块：实时调试拓扑 / 各模块诊断状态（六轴卡片）/ 诊断日志 / 调试节点职责 --- */
.uts-diag-summary { display: flex; align-items: center; flex-wrap: wrap; gap: 6px 12px; }
.uts-diag-overall { box-sizing: border-box; display: inline-flex; align-items: center; gap: 7px; padding: 3px 11px; border-radius: 999px; font-size: 12px; line-height: 18px; color: #d97706; background: color-mix(in srgb, #d97706 12%, transparent); border: .5px solid color-mix(in srgb, #d97706 38%, transparent); }
/* 胶囊跟随五态（旧的三态 ready/pending/broken 已全部退役，写成 ready 会永远不匹配、只剩默认橙色）。 */
.uts-diag-overall[data-uts-overall="PASS"] { color: #16a34a; background: color-mix(in srgb, #16a34a 12%, transparent); border-color: color-mix(in srgb, #16a34a 38%, transparent); }
.uts-diag-overall[data-uts-overall="WARN"] { color: #d97706; background: color-mix(in srgb, #d97706 12%, transparent); border-color: color-mix(in srgb, #d97706 38%, transparent); }
.uts-diag-overall[data-uts-overall="FAIL"] { color: #b91c1c; background: color-mix(in srgb, #b91c1c 12%, transparent); border-color: color-mix(in srgb, #b91c1c 38%, transparent); }
.uts-diag-overall[data-uts-overall="SKIPPED"] { color: var(--dsw-alias-label-tertiary); background: color-mix(in srgb, var(--dsw-alias-label-primary) 6%, transparent); border-style: dashed; border-color: color-mix(in srgb, var(--dsw-alias-label-tertiary) 55%, transparent); }
.uts-diag-overall[data-uts-overall="UNKNOWN"] { color: var(--dsw-alias-label-tertiary); background: color-mix(in srgb, var(--dsw-alias-label-primary) 4%, transparent); border-style: dotted; border-color: color-mix(in srgb, var(--dsw-alias-label-tertiary) 45%, transparent); }
.uts-diag-overall-dot { flex: none; width: 6px; height: 6px; border-radius: 50%; background: currentColor; }
.uts-diag-stale { flex: 1 1 100%; margin: 0; font-size: 11px; line-height: 16px; color: #d97706; overflow-wrap: anywhere; }
.uts-diag-panel { display: flex; flex-direction: column; gap: 10px; padding: 13px 15px; border: .5px solid var(--dsw-alias-border-l2); border-radius: 12px; background: var(--dsw-alias-bg-layer-1); }
.uts-diag-panel-head { display: flex; align-items: baseline; justify-content: space-between; flex-wrap: wrap; gap: 4px 12px; }
.uts-diag-panel-title { margin: 0; font-size: 13px; font-weight: 600; line-height: 20px; }
.uts-diag-flow { margin: 0; font-size: 10px; line-height: 15px; color: var(--dsw-alias-label-tertiary); overflow-wrap: anywhere; }
.uts-diag-chain-scroll { overflow-x: auto; overflow-y: hidden; padding-bottom: 2px; }
.uts-diag-chain { position: relative; display: grid; grid-template-columns: minmax(0, 1fr) 56px minmax(0, 1fr) 56px minmax(0, 1fr) 56px minmax(0, 1fr) 56px minmax(0, 1fr); align-items: center; min-width: 760px; padding-top: 16px; }
/* 纯装饰导轨（不承载状态）：虚线 + 右端静态小点，颜色只取中性值。 */
.uts-diag-rail { position: absolute; left: 7.5%; right: 7.5%; top: 4px; height: 0; border-top: 1px dashed color-mix(in srgb, var(--dsw-alias-label-tertiary) 55%, transparent); pointer-events: none; }
.uts-diag-rail-dot { position: absolute; right: -2px; top: -3px; width: 5px; height: 5px; border-radius: 50%; background: color-mix(in srgb, var(--dsw-alias-label-tertiary) 70%, transparent); opacity: .65; }
.uts-diag-node { box-sizing: border-box; display: flex; flex-direction: column; gap: 3px; min-width: 0; padding: 10px 11px; border: .5px solid var(--dsw-alias-border-l2); border-radius: 10px; background: var(--dsw-alias-bg-layer-2); }
.uts-diag-node[data-uts-node-state="PASS"] { border-color: color-mix(in srgb, #16a34a 42%, transparent); }
.uts-diag-node[data-uts-node-state="WARN"] { border-color: color-mix(in srgb, #d97706 42%, transparent); }
.uts-diag-node[data-uts-node-state="FAIL"] { border-color: color-mix(in srgb, #b91c1c 45%, transparent); }
.uts-diag-node[data-uts-node-state="SKIPPED"] { border-style: dashed; border-color: color-mix(in srgb, var(--dsw-alias-label-tertiary) 55%, transparent); }
.uts-diag-node[data-uts-node-state="UNKNOWN"] { border-style: dashed; border-color: color-mix(in srgb, var(--dsw-alias-label-tertiary) 40%, transparent); }
.uts-diag-node[data-uts-stage-phase="running"] { border-color: var(--dsw-alias-brand-primary); animation: uts-diag-pulse 1s ease-in-out infinite alternate; }
@keyframes uts-diag-pulse { from { box-shadow: 0 0 0 0 color-mix(in srgb, var(--dsw-alias-brand-primary) 0%, transparent); } to { box-shadow: 0 0 0 3px color-mix(in srgb, var(--dsw-alias-brand-primary) 22%, transparent); } }
.uts-diag-node-top { display: flex; align-items: center; justify-content: space-between; gap: 6px; }
.uts-diag-node-index { font-size: 9px; line-height: 14px; letter-spacing: .1em; color: var(--dsw-alias-label-tertiary); }
.uts-diag-node-glyph { display: grid; place-items: center; flex: none; width: 24px; height: 24px; border-radius: 7px; color: var(--dsw-alias-label-tertiary); background: color-mix(in srgb, var(--dsw-alias-label-primary) 6%, transparent); }
.uts-diag-node[data-uts-node-state="PASS"] .uts-diag-node-glyph { color: #16a34a; background: color-mix(in srgb, #16a34a 12%, transparent); }
.uts-diag-node[data-uts-node-state="WARN"] .uts-diag-node-glyph { color: #d97706; background: color-mix(in srgb, #d97706 12%, transparent); }
.uts-diag-node[data-uts-node-state="FAIL"] .uts-diag-node-glyph { color: #b91c1c; background: color-mix(in srgb, #b91c1c 12%, transparent); }
.uts-diag-node-role { font-size: 10px; line-height: 15px; color: var(--dsw-alias-label-tertiary); }
.uts-diag-node-name { font-size: 12px; font-weight: 600; line-height: 18px; color: var(--dsw-alias-label-primary); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
/* 职责描述固定占两行（15px × 2 = 30px）：卡片高度不随文案长短跳动 */
.uts-diag-node-sub { display: -webkit-box; -webkit-box-orient: vertical; -webkit-line-clamp: 2; overflow: hidden; min-height: 30px; font-size: 10px; line-height: 15px; color: var(--dsw-alias-label-secondary); }
.uts-diag-node-status { display: flex; align-items: flex-start; gap: 5px; min-width: 0; font-size: 10px; line-height: 15px; color: var(--dsw-alias-label-tertiary); }
/* 状态信息预留两行（30px = 2 × 15px），超出两行才截断；完整内容在节点悬停提示里。 */
.uts-diag-node-status > span { min-width: 0; min-height: 30px; display: -webkit-box; -webkit-box-orient: vertical; -webkit-line-clamp: 2; overflow: hidden; overflow-wrap: anywhere; }
.uts-diag-node[data-uts-node-state="WARN"] .uts-diag-node-status { color: #d97706; }
.uts-diag-node[data-uts-node-state="FAIL"] .uts-diag-node-status { color: #b91c1c; }
.uts-diag-dot { flex: none; width: 5px; height: 5px; margin-top: 5px; border-radius: 50%; background: var(--dsw-alias-label-tertiary); }
.uts-diag-node[data-uts-node-state="PASS"] .uts-diag-dot { background: #16a34a; }
.uts-diag-node[data-uts-node-state="WARN"] .uts-diag-dot { background: #d97706; }
.uts-diag-node[data-uts-node-state="FAIL"] .uts-diag-dot { background: #b91c1c; }
.uts-diag-edge { position: relative; display: flex; align-items: center; justify-content: center; align-self: center; width: 100%; }
.uts-diag-edge-line { position: relative; display: block; width: 100%; height: 1.5px; background: #16a34a; }
.uts-diag-edge[data-uts-edge-state="PASS"] .uts-diag-edge-line { background: #16a34a; }
.uts-diag-edge[data-uts-edge-state="PASS"] .uts-diag-edge-line::before { content: ""; position: absolute; top: 50%; right: 0; transform: translateY(-50%); border-left: 4px solid #16a34a; border-top: 3px solid transparent; border-bottom: 3px solid transparent; }
.uts-diag-edge[data-uts-edge-state="WARN"] .uts-diag-edge-line { background: #d97706; }
.uts-diag-edge[data-uts-edge-state="WARN"] .uts-diag-edge-label { color: #d97706; }
.uts-diag-edge[data-uts-edge-state="SKIPPED"] .uts-diag-edge-line { background: repeating-linear-gradient(90deg, color-mix(in srgb, var(--dsw-alias-label-tertiary) 60%, transparent) 0 4px, transparent 4px 8px); }
.uts-diag-edge[data-uts-edge-state="UNKNOWN"] .uts-diag-edge-line { background: repeating-linear-gradient(90deg, color-mix(in srgb, var(--dsw-alias-label-tertiary) 45%, transparent) 0 2px, transparent 2px 6px); }
.uts-diag-edge[data-uts-edge-state="FAIL"] .uts-diag-edge-line { background: repeating-linear-gradient(90deg, #b91c1c 0 4px, transparent 4px 8px); }
.uts-diag-edge[data-uts-edge-state="FAIL"] .uts-diag-edge-label { color: #b91c1c; }
/* 沿通路移动的小球：绝对定位，不参与布局；只有本 run 里 PASS 且下游已 stage-end 的段才跑。 */
.uts-diag-edge-dot { position: absolute; top: 50%; left: 0; width: 6px; height: 6px; margin-top: -3px; border-radius: 50%; background: #16a34a; box-shadow: 0 0 6px color-mix(in srgb, #16a34a 55%, transparent); opacity: .9; display: none; pointer-events: none; }
.uts-diag-edge[data-uts-edge-live="true"] .uts-diag-edge-dot { display: block; animation: uts-diag-flow 2.1s linear infinite; }
@keyframes uts-diag-flow { 0% { left: 0; opacity: 0; } 12% { opacity: .9; } 88% { opacity: .9; } 100% { left: calc(100% - 6px); opacity: 0; } }
.uts-diag-edge-break { position: absolute; display: grid; place-items: center; width: 15px; height: 15px; border-radius: 50%; font-size: 10px; line-height: 1; color: #b91c1c; background: var(--dsw-alias-bg-layer-1); border: .5px solid color-mix(in srgb, #b91c1c 50%, transparent); }
.uts-diag-edge-label { position: absolute; top: calc(50% + 7px); left: 50%; transform: translateX(-50%); font-size: 9px; line-height: 13px; color: var(--dsw-alias-label-tertiary); white-space: nowrap; }
.uts-diag-panel-head { display: flex; align-items: baseline; justify-content: space-between; flex-wrap: wrap; gap: 4px 12px; }
.uts-diag-panel-title { margin: 0; font-size: 13px; font-weight: 600; line-height: 20px; }
.uts-diag-flow { margin: 0; font-size: 10px; line-height: 15px; color: var(--dsw-alias-label-tertiary); overflow-wrap: anywhere; }
.uts-diag-flow { margin: 0; font-size: 10px; line-height: 15px; color: var(--dsw-alias-label-tertiary); overflow-wrap: anywhere; }
.uts-diag-axes { display: grid; grid-template-columns: repeat(auto-fit, minmax(180px, 1fr)); gap: 10px; }
.uts-diag-axis { box-sizing: border-box; display: flex; align-items: flex-start; gap: 10px; min-width: 0; padding: 11px 12px; border: .5px solid var(--dsw-alias-border-l2); border-radius: 12px; background: var(--dsw-alias-bg-layer-2); }
.uts-diag-axis-icon { flex: none; display: grid; place-items: center; width: 26px; height: 26px; border-radius: 8px; color: var(--dsw-alias-label-secondary); background: color-mix(in srgb, var(--dsw-alias-label-primary) 8%, transparent); }
.uts-diag-axis[data-uts-status="supported"] .uts-diag-axis-icon, .uts-diag-axis[data-uts-status="ok"] .uts-diag-axis-icon, .uts-diag-axis[data-uts-status="bound"] .uts-diag-axis-icon, .uts-diag-axis[data-uts-status="available"] .uts-diag-axis-icon, .uts-diag-axis[data-uts-status="true"] .uts-diag-axis-icon { color: #16a34a; background: color-mix(in srgb, #16a34a 12%, transparent); }
.uts-diag-axis[data-uts-status="failed"] .uts-diag-axis-icon, .uts-diag-axis[data-uts-status="degraded"] .uts-diag-axis-icon, .uts-diag-axis[data-uts-status="stale"] .uts-diag-axis-icon, .uts-diag-axis[data-uts-status="partial"] .uts-diag-axis-icon, .uts-diag-axis[data-uts-status="unavailable"] .uts-diag-axis-icon { color: #d97706; background: color-mix(in srgb, #d97706 12%, transparent); }
.uts-diag-axis-body { display: flex; flex-direction: column; gap: 3px; min-width: 0; flex: 1 1 auto; }
.uts-diag-axis-head { display: flex; align-items: baseline; justify-content: space-between; gap: 8px; min-width: 0; }
.uts-diag-axis-name { font-size: 11px; line-height: 16px; font-weight: 600; color: var(--dsw-alias-label-secondary); }
.uts-diag-axis-value { flex: none; font-size: 11px; line-height: 16px; font-weight: 600; white-space: nowrap; color: var(--dsw-alias-label-tertiary); }
.uts-diag-axis[data-uts-status="supported"] .uts-diag-axis-value, .uts-diag-axis[data-uts-status="ok"] .uts-diag-axis-value, .uts-diag-axis[data-uts-status="bound"] .uts-diag-axis-value, .uts-diag-axis[data-uts-status="available"] .uts-diag-axis-value, .uts-diag-axis[data-uts-status="true"] .uts-diag-axis-value { color: #16a34a; }
.uts-diag-axis[data-uts-status="failed"] .uts-diag-axis-value, .uts-diag-axis[data-uts-status="degraded"] .uts-diag-axis-value, .uts-diag-axis[data-uts-status="stale"] .uts-diag-axis-value, .uts-diag-axis[data-uts-status="partial"] .uts-diag-axis-value, .uts-diag-axis[data-uts-status="unavailable"] .uts-diag-axis-value, .uts-diag-axis[data-uts-status="unsupported"] .uts-diag-axis-value, .uts-diag-axis[data-uts-status="unbound"] .uts-diag-axis-value, .uts-diag-axis[data-uts-status="not-probed"] .uts-diag-axis-value, .uts-diag-axis[data-uts-status="false"] .uts-diag-axis-value { color: #d97706; }
.uts-diag-axis-reason { font-family: inherit; font-size: 10px; line-height: 16px; color: var(--dsw-alias-label-tertiary); overflow-wrap: anywhere; }
/* 占位固定三行（16px × 3）：六张卡片高度一致，且 run 结果变化时卡片不会跳动 */
.uts-diag-axis-checks { display: block; min-height: 48px; font-family: inherit; font-size: 10px; line-height: 16px; color: var(--dsw-alias-label-tertiary); }
/* 一行一项：不用分隔符串成一句，逐行列出更易读；单项过长用省略号，完整列表看悬停提示 */
.uts-diag-axis-checks-item { display: block; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
/* 「+n」是计数标签：字号更小、颜色更淡，与描述文字明显区分 */
.uts-diag-axis-checks-more { margin-left: 5px; font-size: 9px; line-height: 16px; letter-spacing: .02em; color: color-mix(in srgb, var(--dsw-alias-label-tertiary) 55%, transparent); }
.uts-diag-bottom { display: grid; grid-template-columns: minmax(0, 1.15fr) minmax(0, .85fr); gap: 12px; }
.uts-diag-events { display: flex; flex-direction: column; gap: 7px; }
.uts-diag-event { display: grid; grid-template-columns: 62px 8px minmax(0, 1fr); align-items: start; gap: 8px; min-width: 0; font-size: 11px; line-height: 16px; }
.uts-diag-event-time { font-family: ui-monospace, SFMono-Regular, Consolas, monospace; font-size: 10px; line-height: 16px; color: var(--dsw-alias-label-tertiary); font-variant-numeric: tabular-nums; }
/* 圆点颜色只跟随事件状态（旧写法按 kind="change" 上橙色，把所有 stage 行都染成告警色）。 */
.uts-diag-event-pin { width: 5px; height: 5px; margin-top: 6px; border-radius: 50%; background: var(--dsw-alias-label-tertiary); }
.uts-diag-event-pin[data-uts-event-status="PASS"] { background: #16a34a; }
.uts-diag-event-pin[data-uts-event-status="WARN"] { background: #d97706; }
.uts-diag-event-pin[data-uts-event-status="FAIL"] { background: #b91c1c; }
.uts-diag-event-pin[data-uts-event-status="SKIPPED"] { background: color-mix(in srgb, var(--dsw-alias-label-tertiary) 85%, transparent); }
.uts-diag-event-pin[data-uts-event-status="UNKNOWN"] { background: color-mix(in srgb, var(--dsw-alias-label-tertiary) 60%, transparent); }
.uts-diag-event-pin[data-uts-event-status="INFO"] { background: var(--dsw-alias-label-tertiary); }
.uts-diag-event[data-uts-event-time-source="observed"] .uts-diag-event-time { font-style: italic; opacity: .75; }
.uts-diag-event-text { min-width: 0; color: var(--dsw-alias-label-secondary); overflow-wrap: anywhere; }
.uts-diag-duties { display: flex; flex-direction: column; gap: 8px; }
.uts-diag-duty { display: flex; align-items: flex-start; gap: 8px; font-size: 11px; line-height: 16px; color: var(--dsw-alias-label-secondary); overflow-wrap: anywhere; }
.uts-diag-duty-arrow { flex: none; color: #16a34a; }
.uts-diag-duty-text strong { font-weight: 600; color: var(--dsw-alias-label-primary); }
.uts-diag-empty { margin: 0; font-size: 11px; line-height: 16px; color: var(--dsw-alias-label-tertiary); }
@media (max-width: 900px) { .uts-diag-bottom { grid-template-columns: minmax(0, 1fr); } }
@media (prefers-reduced-motion: reduce) {
  .uts-diag-edge[data-uts-edge-live="true"] .uts-diag-edge-dot { animation: none; }
  .uts-diag-node[data-uts-stage-phase="running"] { animation: none; }
}
.uts-diag-modal-overlay { position: fixed; inset: 0; z-index: 3000; display: flex; align-items: center; justify-content: center; padding: 16px; background: rgba(0, 0, 0, .45); pointer-events: auto; }
.uts-diag-modal-panel { box-sizing: border-box; position: relative; display: flex; flex-direction: column; width: min(1180px, 94vw); max-height: 86vh; overflow: auto; border-radius: 14px; border: .5px solid var(--dsw-alias-border-l1); background: var(--dsw-alias-bg-layer-1); box-shadow: 0 24px 64px rgba(0, 0, 0, .32); }
.uts-diag-modal-head { position: sticky; top: 0; z-index: 1; display: flex; align-items: center; justify-content: space-between; gap: 12px; padding: 13px 16px; border-bottom: .5px solid var(--dsw-alias-border-l2); background: var(--dsw-alias-bg-layer-1); }
.uts-diag-modal-title { display: flex; align-items: center; gap: 8px; min-width: 0; }
.uts-diag-modal-close { flex: none; }
.uts-diag-modal-body { padding: 14px 16px 18px; }
.uts-diagnostics-body { display: flex; flex-direction: column; gap: 12px; }
.uts-diag-action { display: flex; align-items: center; flex-wrap: wrap; gap: 6px 10px; }

`;

    /* ---- Host config (M4): one authoritative revision for the settings page and the panel ---- */
