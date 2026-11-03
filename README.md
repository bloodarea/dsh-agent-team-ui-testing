# dsh-agent-team-ui-testing

**AI-native UI testing for DeepSeekHarness.**

Let AI agents operate, inspect, test and verify real user interfaces — with evidence humans can review.

**English** | [简体中文](README_zh.md)

> **Status: pre-release.** The Web/Chromium channel is implemented: 30 agent tools plus a debug panel for programmatic inspection, structured GUI actions, static visual analysis, network capture, shared viewport control, a hybrid canvas and client-side annotations. Other environments are planned and stay disabled in the runtime picker. The plugin is linked locally during development; there is no published package yet. Verification details live in [docs/status.md](docs/status.md).

## What is this?

**dsh-agent-team-ui-testing** is a UI testing infrastructure plugin for [DeepSeekHarness (DSH)](https://github.com/deepseek-ai/deepseek-harness). It lets an AI agent — or a coordinated Agent Team — drive a real application, inspect what the application exposes, verify expected behavior, collect reviewable evidence and report actionable failures.

The runtime is built around a shared Chromium instance with one isolated page per DSH workspace, a typed tool surface, and a human-facing debug panel. The same session can be inspected programmatically, operated through structured DOM/accessibility data, captured as screenshots, or analyzed visually.

The project grows out of the earlier `dsh-agent-team-browser` idea. The shared browser workspace remains the first adapter of a broader, capability-aware UI testing runtime.

## Why build it?

Coding agents can produce UI code without being able to answer: **“Does the finished application actually work and look right?”** A 200 response, a running process or a single screenshot is not proof of a working user journey.

This project focuses on:

- **Real UI feedback** — exercise user journeys on rendered interfaces, not only source code.
- **Structured-first automation** — prefer APIs, DOM and accessibility data; use vision when structure is insufficient.
- **Evidence-based results** — record what ran, what was observed, what passed, what failed and what remains unverified.
- **Human control** — authorized access, scoped sessions and a panel humans can watch or take over.
- **Low disruption** — prefer background browser operations over hijacking the desktop foreground.

## What works today

- **Shared browser runtime** — one headless Chromium per host; each DSH workspace gets its own page, URL, viewport, history, network buffer and lease. Cookies and storage are shared by the Chromium profile.
- **30 agent tools** across programmatic, structured GUI, static vision and network debugging.
- **Debug panel** — live preview, responsive size controls, shared viewport state, a hybrid canvas, and a client-side annotation layer that agents can read back.
- **Evidence and safety** — typed errors, structured action evidence, validated PNG capture, managed visual baselines, network evidence and optimistic concurrency for shared state.

### Agent tools

| Group | Tools | What it covers |
| --- | --- | --- |
| **Programmatic** (10) | `browser_navigate` `browser_eval` `browser_screenshot` `browser_input` `browser_network` `browser_computed_style` `browser_http_request` `browser_viewport` `browser_state` `browser_capabilities` | Navigation, JavaScript, console/network inspection, independent HTTP requests, computed styles, screenshots, raw mouse/wheel/keyboard input, shared viewport state and capability reporting |
| **Structured GUI** (7) | `browser_snapshot` `browser_click` `browser_type` `browser_scroll` `browser_fill_form` `browser_node_state` `browser_wait_for` | Snapshot → ref targeting, trusted input, forms, node state and waits, with structured evidence and typed errors |
| **Static vision** (6) | `browser_vision_image` `browser_vision_find` `browser_vision_compare` `browser_vision_act` `browser_vision_baseline` `browser_vision_check` | Crop/zoom/preprocess/annotate PNGs, deterministic colour/component/edge/template finders, YIQ diff, coordinate input, managed baselines and visual assertions |
| **Network** (7) | `browser_network_session` `browser_network_events` `browser_network_detail` `browser_network_trace` `browser_network_control` `browser_network_evidence` `browser_network_subscribe` | Capture, timeline, analysis, business-step traces, interception/throttling/replay/mock, JSONL/HAR evidence and per-agent subscriptions |

### Debug panel

The panel is the human window into the same runtime the agent uses.

- **Live preview** of the workspace page, driven by a screencast with a polling fallback.
- **Size bar** — 宽屏 / 横屏 / 平板 / 手机 presets as a segmented control, X/Y canvas position, width × height, display scale, and a `拖拽 | 适应窗口 | 默认` mode selector. Preset clicks reset X/Y and keep the chosen display mode; the selected preset shows a green dot and is mutually exclusive with drag mode.
- **Hybrid canvas** — the viewport can be positioned like a canvas: a signed origin, negative coordinates and blank areas, a dark checkerboard in the panel (pure white in screenshots), drag-to-pan and screen-anchored wheel zoom.
- **Annotation mode** — circle, rectangle, line, arrow, brush, text and eraser, plus fill/outline, colour, width and clear-canvas. Drawings are anchored in canvas coordinates, the page receives no input while annotating, and the document is published so agents can read it through `browser_state.annotations`.
- **Shared state** — agent and panel read the same viewport; updates use `expectedRevision`, and conflicts are reported instead of silently overwriting.

### Evidence and safety

- Every structured action can return evidence: target identity, before/after state, dispatch facts, network deltas and typed errors.
- Screenshots are validated PNGs with explicit scale and canvas-space regions; capture can be staged or persisted under a controlled root.
- Visual baselines are immutable revisions with compare-and-swap HEAD updates and tombstones.
- Network evidence supports JSONL (lossless) and HAR 1.2 export with default redaction and explicit truncation counters.
- Runtime access is scoped to a DSH workspace; mutating page work is serialized through a lease and a serial queue.
- Navigation is restricted to approved targets (loopback by default; private ranges blocked unless explicitly enabled), with DNS, redirect and popup checks.

## How it works

```text
DSH Agent / Agent Team
        │
        ▼
UI testing plugin runtime
  ├─ shared headless Chromium
  ├─ one page per DSH workspace (URL, viewport, history, network, lease)
  ├─ agent tool surface (30 tools)
  └─ debug panel (preview, size bar, canvas, annotations)
        │
        ▼
Observations, evidence and verdicts
```

Only the Web/Chromium adapter is implemented. Desktop, Android, TUI, HarmonyOS, game and 3D adapters are planned; each must report its real capabilities instead of pretending to support the same operations.

## Capability tiers

The tool surface is organized as **selection and fallback levels**, not a mandatory pipeline. Pick the lowest-cost reliable path; escalate when it cannot produce the required evidence.

| Level | Focus | Typical use |
| --- | --- | --- |
| **T1** Programmatic | CDP, HTTP, JavaScript, network, console | API checks, network faults, page state, performance data |
| **T2** Structured GUI | DOM, accessibility tree, snapshot/ref, trusted input | Buttons, forms, navigation, interaction tests |
| **T3** Static vision | Screenshots, deterministic pixel analysis, coordinate actions | Layout, colour, occlusion, canvas, chart and style defects |
| **T4** Dynamic vision | Frame sequences, timing, motion reasoning | Animation, transitions, dragging and time-dependent behavior — planned, not implemented |

A successful T1 call is never treated as a visual pass. UI-specific acceptance criteria still require UI-level observations.

## Getting started

**Requirements:** a DSH installation and a local Chrome/Chromium binary.

The plugin is currently used as a local link into a DSH profile; there is no published npm package or compatibility matrix yet.

1. Link or copy the repository into the DSH profile used for development.
2. Restart DSH after the first install so the plugin bundle is registered.
3. Open the debug view from **更多 → 调试视图**, or from the plugin card in the right sidebar.
4. Changes to `client.js` only need a panel refresh; changes to `index.js`, the tool surface or bundled skills need a DSH restart.

Integration notes and known pitfalls are in [docs/dsh-integration.md](docs/dsh-integration.md).

A typical agent flow is: navigate to the target, inspect state with `browser_state`/`browser_eval`, perform structured actions with the T2 tools, capture screenshots or run T3 checks, inspect network traffic with the network tools, and use the shared viewport/canvas/annotation state when the task involves layout, framing or visual feedback.

## Current limits

- **Web only.** Windows, Linux, macOS desktop, Android, TUI, HarmonyOS, games and 3D are planned and disabled in the runtime picker.
- **Static vision only.** T3 judges single PNGs with deterministic algorithms; it has no VLM/OCR or semantic naming and cannot prove animation or intermediate frames. T4 is not implemented.
- **Shared browser profile.** Cookies and storage are shared by the Chromium profile; only page, URL, viewport, history, network buffer and leases are isolated per workspace.
- **Screenshots are not redacted.** Review their content before sharing.
- **Attachments are not provider visibility.** A returned image attachment does not prove the model received it at full resolution.
- **Network capture is partial at the edges.** Same-page iframe and dedicated workers are covered; OOPIF is partial; shared and service workers are not collected; HAR is a 1.2 subset; body/header redaction is not a general secret detector.
- **Viewport display is a 1× screencast.** A display scale above 100% magnifies the bitmap rather than adding pixel density; request an explicit screenshot scale when resolution matters. Resize input barriers are best-effort, while canvas offsets use a fail-closed barrier.
- **Shared state is optimistic.** `browser_viewport get` is a cache diagnostic; `stale` means “not recently observed”, and a lost `expectedRevision` race returns `VIEWPORT_CONFLICT` instead of replaying the patch.

## Roadmap

- Harden the Web channel and finish T4 dynamic visual verification.
- Add the cross-environment test core: typed sessions, observations, assertions and reports.
- Validate desktop (Windows/Linux/macOS), Android, TUI, HarmonyOS, game and 3D adapters by demand and platform feasibility.
- Add multi-agent scheduling, human takeover and release hardening.

## Documentation

| File | Contents |
| --- | --- |
| [docs/index.md](docs/index.md) | Project documentation index |
| [docs/status.md](docs/status.md) | Current implementation state, verification evidence and open gaps |
| [docs/capability-tiers.md](docs/capability-tiers.md) | T1–T4 tier model, completion bars and fallback rules |
| [docs/viewport-control.md](docs/viewport-control.md) | Shared viewport contract: view model, CAS, panel mapping and screenshot scale |
| [docs/canvas-viewport.md](docs/canvas-viewport.md) | Hybrid canvas contract: signed origin, blank, drag/zoom, input mapping and canvas-space capture |
| [docs/annotation-p0d.md](docs/annotation-p0d.md) | Annotation contract: tools, canvas anchoring, agent-visible document and retention |
| [docs/network-p0.md](docs/network-p0.md) | Network capture contract: tools, events, quotas, evidence and errors |
| [docs/capture-p0.md](docs/capture-p0.md) | Screenshot and evidence-file contract |
| [docs/t2-structured-gui.md](docs/t2-structured-gui.md) | Structured GUI contract and ref protocol |
| [docs/t3-vision.md](docs/t3-vision.md) | Static vision contract, algorithms and verdict rules |
| [docs/dsh-integration.md](docs/dsh-integration.md) | DSH integration notes and pitfalls |
| [docs/verification.md](docs/verification.md) | How the project is verified (isolated DSH + headless Chromium) |

## Relationship to other projects

| Project | Role |
| --- | --- |
| [`dsh-agent-team-presets`](https://github.com/bloodarea/dsh-agent-team-presets) | Reusable team and role configurations, model routes and tool policies |
| **`dsh-agent-team-ui-testing`** | UI testing targets, sessions, automation, evidence and governed human/agent control |

They are complementary but do not require each other; the runtime supports a single DSH agent without the presets plugin.

## Contributing

Reproducible DSH integration findings, platform feasibility tests, accessibility/DOM fallback cases, security threat models and concrete UI acceptance scenarios are the most useful contributions.

When filing an issue, include the DSH version/commit, platform and runtime versions, reproduction steps, expected and observed results, and sanitized evidence. Never upload credentials, personal device data or unredacted authenticated traffic.

## License

The repository does not currently declare a license. Add an explicit license before redistribution or reuse; third-party code incorporated later must retain its applicable notices.

---

**Repository:** [bloodarea/dsh-agent-team-ui-testing](https://github.com/bloodarea/dsh-agent-team-ui-testing) · **Maintainer:** [bloodarea](https://github.com/bloodarea) · **Status:** pre-release
