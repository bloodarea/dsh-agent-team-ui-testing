# dsh-agent-team-ui-testing

**AI-native, cross-platform UI testing for DeepSeekHarness.**  
Help AI agents operate, inspect, test, and verify Web, desktop, and Android interfaces—with evidence humans can review.

**English** | [简体中文](README_zh.md)

> [!IMPORTANT]
> **Project status: architecture / pre-release.** This repository currently documents a proposed design, not a released or verified plugin. All capabilities below are **planned** unless explicitly marked otherwise. There is no verified installation command, compatibility matrix, or published release yet. This README describes intended behavior, not completed tests.

## What is this?

**dsh-agent-team-ui-testing** is a proposed UI testing infrastructure plugin for [DeepSeekHarness (DSH)](https://github.com/deepseek-ai/deepseek-harness). Its purpose is to let an AI agent—or a coordinated Agent Team—interact with a real application, inspect its state, verify expected behavior, capture evidence, and report actionable failures.

The project evolves from the earlier **`dsh-agent-team-browser`** concept, whose original focus was shared Chromium workspaces. **The browser workspace remains part of the plan**, but becomes one adapter within a broader UI testing runtime.

**Primary targets:** Web (Chromium), Windows/Linux desktop applications, and Android applications. Other platforms may be evaluated later.

The `dsh-agent-team-*` name denotes the project family. **Agent Team and [`dsh-agent-team-presets`](https://github.com/bloodarea/dsh-agent-team-presets) are optional:** a single agent should be able to use the testing runtime independently.

## Why build it?

Coding agents can create UI code without being able to reliably answer the question: **“Does the finished application actually work and look right?”** A working API response, a successfully launched process, or one screenshot is not sufficient evidence of a working user journey.

This project aims to provide:

- **Real UI feedback:** exercise user journeys on actual rendered interfaces, not only inspect source code.
- **Structured-first automation:** use application and accessibility/DOM interfaces when appropriate; use visual reasoning when necessary.
- **Cross-platform test sessions:** present a consistent testing contract while retaining platform-specific capabilities and limitations.
- **Evidence-based results:** record what was executed, what was observed, what passed, what failed, and what remains unverified.
- **Agent collaboration with human control:** coordinate authorized access across agents and let a human observe or take over where supported.
- **Low disruption:** avoid stealing foreground input when the target and OS allow it; disclose and explicitly coordinate any operation that requires focus.

## Planned scope

| Target | Candidate integration approach | Intended coverage |
| --- | --- | --- |
| **Web** | Chromium, Chrome DevTools Protocol (CDP), DOM/accessibility APIs | Navigation, forms, responsive layouts, console/network inspection, screenshots and interactions |
| **Windows desktop** | Windows UI Automation (UIA) and platform-approved input/capture mechanisms | Native controls, window state, user journeys, screenshots |
| **Linux desktop** | Accessibility interfaces and compositor/desktop-specific automation | Native controls and GUI workflows; actual coverage depends on X11/Wayland and permissions |
| **Android** | ADB, UI hierarchy/UiAutomator-style capabilities, device screenshots/input | Activities, navigation, controls, permission-aware device workflows |

These technologies are **candidates, not selected dependencies or verified integrations**. An adapter must report its available operations instead of pretending every platform supports the same functions.

**Not included in the initial commitment:** macOS/iOS automation, unrestricted OS control, bypassing CAPTCHA or application security restrictions, or guarantees of background input on every native platform.

## Key design principles

1. **Test outcomes are first-class.** Operating the UI is a means to verify an expected behavior. The result must include evidence and explicit limits.
2. **Prefer structured information.** Use supported application, event, DOM, or accessibility interfaces before relying on fragile screen coordinates.
3. **Do not claim an unperformed test passed.** API-only checks cannot by themselves prove visual appearance or end-to-end UI behavior.
4. **Separate execution from presentation.** Closing a DSH sidebar viewer must not implicitly destroy its test target or abort a permitted background test session.
5. **Isolation by default.** A browser context, native desktop session, or Android device belongs to an authorized testing scope; identities and access are checked by the runtime.
6. **Keep human-facing complexity low.** Agents may use detailed adapters and evidence internally; humans should receive concise findings, failure locations, and reviewable artifacts.

## Planned capabilities

The following list is a **target specification**, not an implemented feature list.

| Area | Planned behavior |
| --- | --- |
| **Test session management** | Create, select, resume where feasible, and terminate scoped target sessions; distinguish them from DSH conversation sessions |
| **Action and observation tools** | Provide small, typed operations for launching, finding, clicking, typing, inspecting, waiting, and capturing evidence |
| **Assertions and reports** | Link expected state, actual observation, pass/fail/blocked/unverified status, and supporting artifacts |
| **Multi-agent coordination** | Allow parallel work on independent targets; serialize conflicting mutations with scoped ownership/leases |
| **Human observation/takeover** | Display target state through an authorized DSH viewer; hand control between an agent and a human where supported |
| **Browser workspace** | Retain shared Chromium context/tab design, optional cookie-sharing within one authorized context, and per-tab ownership |
| **Responsive testing** | Set a browser tab's CSS viewport and DPR independently from the sidebar width |
| **Debugging** | Inspect permitted console, runtime, network, and application errors; protect secret-bearing data |
| **Visual verification** | Compare UI states or screenshots under controlled conditions, with uncertainty reported instead of concealed |
| **Animation verification** | Sample state and frames over time, check transitions/timing/layout stability against explicit acceptance criteria |
| **Reproducibility** | Record environment metadata, steps, test artifacts, failure evidence, and replay limitations |

## T0–T3: capability-aware interaction and observation

The intended hierarchy favors efficient, reliable, structured interfaces. It is a **selection and fallback strategy**, not a requirement to execute all four levels on every step.

| Level | Technique | Examples | Caveat |
| --- | --- | --- | --- |
| **T0** | Application or test API | Health, test fixtures, app-specific state/query interfaces | Useful for setup and validation, but does not prove the UI was rendered or usable |
| **T1** | Supported event / automation interface | OS or runtime interaction commands, app events, platform controls | Must confirm that an action actually reached its intended target |
| **T2** | Structured UI tree | Web DOM, accessibility tree, Android UI hierarchy | Prefer stable identities/semantics; structures can be incomplete or stale |
| **T3** | Visual perception and coordinate input | Screenshots, multimodal model, visual target localization | More variable; require uncertainty reporting and post-action confirmation |

An adapter advertises its capabilities. The agent selects the **lowest-cost dependable method suitable for the assertion** and can escalate when a method is unavailable or inconclusive. UI-specific acceptance criteria still require UI-level observations; a successful T0 call is never silently treated as a visual test pass.

## From a test request to verifiable evidence

A typical intended flow:

1. **Specify:** describe the target, user journey, expected behavior, environment, and acceptance criteria.
2. **Prepare:** start or attach to an authorized browser, desktop, or Android test session.
3. **Execute:** use the best supported structured action path, falling back as needed.
4. **Observe:** capture UI state, accessibility/DOM data, logs, screenshots, or timed frames relevant to the assertion.
5. **Assert:** prefer deterministic checks; for subjective visual judgments, include tolerance, uncertainty, and review requirements.
6. **Report:** produce passed/failed/blocked/unverified outcomes and a reproducible failure summary.
7. **Retest:** after the development agent changes the application, rerun affected test cases and report regressions.

**Example goal (illustrative, not a published tool/API syntax):**

> Launch the application. Open Settings, switch to dark mode, verify the persisted preference and the rendered interface, then navigate away and back. Report the actual checks run, screenshots, relevant logs, any mismatch, and any check that could not be performed.

### Evidence and verdicts

Planned test records should carry a target/environment identity, test case and step, action source, timestamp, expected result, observed result, status, and references to relevant artifacts. Sensitive captures are disabled or redacted by default.

A visual model may offer a finding or confidence estimate, but **a confidence score alone is not proof**. Deterministic assertions, reviewed evidence, and platform limitations must remain distinguishable.

### Animation and visual behavior

A single static screenshot cannot establish that an animation is correct. Where the platform permits, the runtime should capture a bounded sequence of frames or state observations, along with timestamps and defined criteria (e.g., duration range, start/end state, unexpected layout shift, or missing transition). Rendering variability, reduced-motion settings, frame capture gaps, and device performance must be documented. Ambiguous results should be marked **unverified/review needed** instead of passed.

## Architecture (planned)

```mermaid
flowchart TD
    A[DSH Agent / Agent Team] --> G[Authorized UI Testing Gateway]
    H[Human reviewer / takeover] --> G
    G --> M[Test session manager and leases]
    G --> V[DSH sidebar viewer]
    M --> P[Capability selection: T0 / T1 / T2 / T3]
    P --> B[Web adapter: Chromium / CDP]
    P --> D[Desktop adapter: Windows / Linux]
    P --> R[Android adapter: device / emulator]
    B --> E[Observations and evidence]
    D --> E
    R --> E
    E --> X[Assertions and test report]
    X --> A
    X --> H
```

### Preserve the shared-browser foundation

The initial browser design remains important:

- An authorized **Browser Workspace** can contain multiple tabs, with explicit per-tab access and write leases.
- Tabs within one chosen `BrowserContext` can share applicable cookies and same-origin storage; separate contexts remain isolated by default. Sharing cookies never guarantees universal sign-in.
- An agent's DSH Session, the browser runtime, and the sidebar viewer have **different lifecycles**. Switching the viewed tab must not switch or recreate background browser tasks.
- Each tab owns its logical viewport; shrinking the DSH sidebar must not unexpectedly change a `1920 × 1080` page into a mobile viewport. The viewer scales/crops the output and maps human input back to the actual target coordinates.
- Browser automation should use background CDP operations rather than hijack the desktop's foreground pointer or keyboard.

Desktop and Android adapters follow the same **authorized session and evidence principles**, but do not pretend to share Chromium-specific cookies, DOM capabilities, or focus guarantees.

### Multi-agent ownership and permissions

- Read-only observations may run concurrently when authorized.
- Independent targets can be tested concurrently subject to machine/device capacity.
- Mutating operations on the **same target** require a coordinated write owner/lease; expired actors must not keep writing.
- A human takeover pauses or revokes conflicting agent control before granting a bounded human operation scope.
- Agent or team identity comes from trusted DSH runtime context, not user-supplied `agentId` strings.
- Tool availability does not override resource authorization. An Agent Team preset can permit a tool, while this runtime must still verify access to a specific target.

## Security and privacy

The testing runtime may encounter authenticated pages, private screens, developer tools, or device data. It should follow least privilege, explicit target authorization, bounded collection, and safe defaults:

- Do not export cookies, access tokens, authorization headers, passwords, or private request bodies by default.
- Require clear authorization for sensitive application/device actions or intrusive debugging.
- Redact test logs and screenshots where feasible; describe redaction gaps.
- Do not silently bypass OS protections, application security checks, CAPTCHA, or consent prompts.
- Avoid recording unrelated host windows or cross-team data.
- Keep replay and recovery capabilities bounded; never promise to recreate arbitrary in-memory state.

## Roadmap

These are **planned work items**, not claims of completion. Ordering may change after DSH and platform feasibility audits.

- [ ] **R0 — Feasibility:** audit DSH plugin/sidebar interfaces, upstream licenses, test target capabilities, and security boundaries.
- [ ] **R1 — Web foundation:** retain workspace/context/tab management, background Chromium execution, and viewer independence.
- [ ] **R2 — Test core:** add typed test sessions, T0–T3 capability selection, actions, observations, assertions, and evidence reports.
- [ ] **R3 — Collaboration:** implement agent/team authorization, target ownership, human takeover, and concurrent test scheduling.
- [ ] **R4 — Desktop:** validate Windows/Linux adapters, accessibility/input/capture options, permissions, and focus constraints.
- [ ] **R5 — Android:** validate device/emulator lifecycle, UI hierarchy, interaction, screenshots, and failure reporting.
- [ ] **R6 — Visual tests:** verify responsive UI, state comparison, timed animation observations, and uncertainty handling.
- [ ] **R7 — Hardening:** run security, privacy, resource, crash/recovery, and cross-platform regression tests.
- [ ] **R8 — Release:** publish a reproducible build, pinned DSH compatibility, verified installation instructions, and acceptance evidence.

A milestone is complete only after its implementation and tests are publicly verifiable. No test should be marked passed without actual execution evidence.

## Installation and development

**No verified public installation command or released version is available yet.** Build commands, DSH compatibility, runtime dependencies, supported operating-system versions, and the release artifact format will be documented after implementation and test verification.

The existing repository may still contain legacy `banner.png` and `banner_zh.png` assets from the browser-workspace concept. They are **not product screenshots** and should not be presented as evidence of the new cross-platform UI testing system. New visual assets can be added after the updated design is reviewed.

### Known constraints

- DSH APIs and extension points may change; adapters must be validated against pinned versions.
- Windows and Linux GUI automation differ significantly; Wayland restrictions and focus rules may limit unattended operation.
- Android testing depends on device/emulator availability, debugging permissions, platform API level, and app security settings.
- Automated visual judgments require defined acceptance criteria and may need human review.
- A browser tab, an OS application, and an Android activity do not expose interchangeable capabilities.

## Relationship to other projects

| Project | Role |
| --- | --- |
| [`dsh-agent-team-presets`](https://github.com/bloodarea/dsh-agent-team-presets) | Reusable team and role configurations, model routes, and tool policies |
| **`dsh-agent-team-ui-testing`** | UI testing targets, sessions, automation, evidence, verification, and governed human/agent control |

The projects are complementary but **do not require each other**. The UI testing runtime is intended to support a single DSH agent without an Agent Team plugin.

## Contributing

Early contributions are most useful when they provide reproducible DSH integration findings, platform-specific feasibility tests, accessibility/DOM fallback cases, security threat models, or concrete UI acceptance scenarios.

When filing an issue, include the exact DSH version/commit, platform and runtime versions, reproduction steps, expected result, observed result, and sanitized evidence. Do not upload credentials, personal device data, or unredacted authenticated traffic.

## License and acknowledgements

**The repository's license has not yet been confirmed in the available published materials.** Please check the repository's actual `LICENSE` file before reuse or redistribution; any third-party code incorporated later must retain applicable notices and license terms.

Thanks to the DeepSeekHarness ecosystem and browser/UI automation communities for the prior art that informs this design. Candidate references include [Chrome DevTools Protocol](https://chromedevtools.github.io/devtools-protocol/) and existing DSH browser integrations; these references are not automatically runtime dependencies.

---

**Repository:** [bloodarea/dsh-agent-team-ui-testing](https://github.com/bloodarea/dsh-agent-team-ui-testing) · **Maintainer:** [bloodarea](https://github.com/bloodarea) · **Status:** Architecture / pre-release
