#!/usr/bin/env node
/**
 * Registry-level proof for the bundled ui-testing skill.
 *
 * This does NOT use a fake context: it builds a real Cordis Context, mounts the real
 * SkillRegistry service, provides the two services index.js injects (tools, webServer),
 * and mounts the real plugin with `ctx.plugin(await import('../../index.js'))`, so the
 * plugin's own `ctx.inject(['skills'], ...)` + `ctx.effect(() => ctx.skills.register(...))`
 * path runs exactly as in production.
 *
 * Then it asserts:
 *   - ctx.skills.list() contains ui-testing with modelInvocable=true / userInvocable=true;
 *   - ctx.skills.get('ui-testing') returns the full body, a description and a directory
 *     resourceBase pointing at this repo's skills/ui-testing/;
 *   - every references/*.md mentioned in the body is readable from resourceBase;
 *   - renderSkillContent() renders a parseable <skill_content> block containing the body;
 *   - disposing the plugin fiber unregisters the skill.
 *
 * SKIP (exit 0) when:
 *   - the DSH installation / @deepseek-ai/dsh-skill package is absent (set DSH_ROOT to override);
 *   - skills/ui-testing/SKILL.md has not been written yet (task-1 not merged).
 * Exit codes: 0 pass or skip, 1 failure.
 */
import { existsSync } from 'node:fs';
import { readFile, stat } from 'node:fs/promises';
import { dirname, join, relative } from 'node:path';
import { homedir } from 'node:os';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = dirname(dirname(HERE));
const SKILL_DIR = join(REPO_ROOT, 'skills', 'ui-testing');
const SKILL_FILE = join(SKILL_DIR, 'SKILL.md');
const INDEX_FILE = join(REPO_ROOT, 'index.js');
// DSH_ROOT defaults to the per-user global install; never a machine-specific absolute path.
const DSH_ROOT = process.env.DSH_ROOT || join(homedir(), '.local/share/node/lib/node_modules/@deepseek-ai/dsh');
const DSH_MODULES = join(DSH_ROOT, 'node_modules', '@deepseek-ai');

const results = [];
function record(label, pass, detail, { skip = false } = {}) {
  results.push({ label, pass: skip ? true : pass, skip, detail });
  const mark = skip ? 'SKIP' : pass ? 'PASS' : 'FAIL';
  console.log(`[${mark}] ${label}`);
  if (!pass && !skip && detail !== undefined) console.log(`       ${typeof detail === 'string' ? detail : JSON.stringify(detail)}`);
}

function finish() {
  const failed = results.filter((item) => !item.pass && !item.skip);
  if (failed.length) {
    console.log(`\nFAILED ${failed.length}/${results.length} checks`);
    for (const item of failed) console.log(`  - ${item.label}: ${typeof item.detail === 'string' ? item.detail : JSON.stringify(item.detail)}`);
    return 1;
  }
  const skipped = results.filter((item) => item.skip).length;
  console.log(`\nPASSED ${results.length - skipped}/${results.length} checks${skipped ? ` (${skipped} skipped)` : ''}`);
  return 0;
}

function skip(reason) {
  console.log(`\nSKIP: ${reason}`);
  return 0;
}

async function loadModule(relativePath) {
  return import(pathToFileURL(join(DSH_MODULES, relativePath)).href);
}

async function main() {
  const cordisEntry = join(DSH_MODULES, 'cordis', 'lib', 'index.js');
  const skillEntry = join(DSH_MODULES, 'dsh-skill', 'lib', 'index.js');
  if (!existsSync(cordisEntry) || !existsSync(skillEntry)) {
    console.log(`[INFO] DSH modules not found under ${DSH_MODULES}`);
    return skip(`DSH 安装或 @deepseek-ai/dsh-skill 不存在（DSH_ROOT=${DSH_ROOT}）。本检查跳过；需在装有 DSH 的机器上运行，或用 DSH_ROOT 覆盖。`);
  }
  if (!existsSync(SKILL_FILE)) {
    return skip('skills/ui-testing/SKILL.md 尚未落地（task-1 未完成），真实 SkillRegistry 里不会有可加载的 skill。');
  }

  const { Context } = await loadModule('cordis/lib/index.js');
  const { SkillRegistry, renderSkillContent } = await loadModule('dsh-skill/lib/index.js');
  record('动态 import @deepseek-ai/cordis 成功', typeof Context === 'function', typeof Context);
  record('动态 import @deepseek-ai/dsh-skill 成功', typeof SkillRegistry === 'function' && typeof renderSkillContent === 'function', [typeof SkillRegistry, typeof renderSkillContent]);

  const ctx = new Context();
  new SkillRegistry(ctx);
  record('真实 Context 已挂载真实 SkillRegistry（ctx.skills 可用）', typeof ctx.skills?.list === 'function' && typeof ctx.skills?.get === 'function', Object.keys(ctx.skills || {}));

  // Provide the services index.js declares via `export const inject = ['tools', 'webServer']`.
  // The tools stub records what the real plugin registers, so the registry-level run also proves
  // the 30-tool surface (that count is otherwise only asserted through the fake-ctx harness).
  const registeredTools = new Map();
  ctx.provide('tools', {
    register(definition) { registeredTools.set(definition.name, definition); return () => { registeredTools.delete(definition.name); }; },
  });
  ctx.provide('webServer', { register() { return () => {}; } });
  record('已 provide tools / webServer 两个服务', Boolean(ctx.get('tools')) && Boolean(ctx.get('webServer')), [Boolean(ctx.get('tools')), Boolean(ctx.get('webServer'))]);

  let fiber;
  let disposeError;
  try {
    fiber = ctx.plugin(await import(pathToFileURL(INDEX_FILE).href));
    record('ctx.plugin() 挂载真实 index.js 成功', Boolean(fiber), typeof fiber);

    // Wait for the injected skills callback + effect registration (plugin apply is sync, but
    // inject/effect scheduling is a Cordis-internal boundary; poll briefly instead of guessing).
    const startedAt = Date.now();
    let list = [];
    while (Date.now() - startedAt < 5000) {
      list = await ctx.skills.list({});
      if (list.some((skill) => skill.name === 'ui-testing')) break;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    const netTools = ['browser_network_session', 'browser_network_events', 'browser_network_detail',
      'browser_network_trace', 'browser_network_control', 'browser_network_evidence', 'browser_network_subscribe'];
    // The shared-viewport tool is the 10th T1 tool (docs/viewport-control.md §7).
    const toolNames = [...registeredTools.keys()];
    const t4Tools = ['browser_dynamic_session', 'browser_motion_observe', 'browser_motion_analyze',
      'browser_motion_control', 'browser_dynamic_correlate'];
    record('真实 ctx.plugin 挂载后注册恰好 36 个 browser_* 工具（含 browser_tabs、browser_viewport、7 个 network 与 5 个 T4 工具）', toolNames.length === 36
      && registeredTools.has('browser_tabs')
      && toolNames.every((name) => name.startsWith('browser_')) && netTools.every((name) => registeredTools.has(name))
      && registeredTools.has('browser_viewport') && t4Tools.every((name) => registeredTools.has(name)),
      { count: toolNames.length, tabs: registeredTools.has('browser_tabs'), network: netTools.filter((name) => registeredTools.has(name)), viewport: registeredTools.has('browser_viewport'), t4: t4Tools.filter((name) => registeredTools.has(name)) });
    record('36 个注册工具都带 object 参数 schema 与 execute', toolNames.length === 36
      && [...registeredTools.values()].every((definition) => definition.parameters?.type === 'object'
        && Array.isArray(definition.parameters?.required) && typeof definition.execute === 'function'),
      [...registeredTools.values()].filter((definition) => definition.parameters?.type !== 'object'
        || !Array.isArray(definition.parameters?.required) || typeof definition.execute !== 'function').map((definition) => definition.name));

    const summary = list.find((entry) => entry.name === 'ui-testing');
    record('registry.list() 发现 ui-testing', Boolean(summary), summary || list.map((entry) => entry.name));
    record('registry.list() 标记 modelInvocable=true', summary?.invocation?.modelInvocable === true, summary?.invocation);
    record('registry.list() 标记 userInvocable=true', summary?.invocation?.userInvocable === true, summary?.invocation);
    record('registry.list() 来源为 bundled', summary?.source === 'bundled', summary?.source);
    if (!summary) return finish();

    const loaded = await ctx.skills.get('ui-testing', {});
    record('registry.get("ui-testing") 返回完整正文', Boolean(loaded?.content) && loaded.content.length > 500, { contentLength: loaded?.content?.length });
    record('registry.get() 返回非空 description', typeof loaded?.description === 'string' && loaded.description.length > 20, loaded?.description);
    const expectedBase = SKILL_DIR.split('\\').join('/');
    const actualBase = String(loaded?.resourceBase?.path || '').replace(/[/\\]+$/, '');
    record('resourceBase 指向本仓库 skills/ui-testing/', loaded?.resourceBase?.kind === 'directory' && actualBase === expectedBase, {
      expected: expectedBase,
      actual: loaded?.resourceBase,
    });

    const normalizedBase = loaded?.resourceBase?.kind === 'directory' ? loaded.resourceBase.path : undefined;
    const refs = new Set();
    for (const match of String(loaded?.content || '').matchAll(/`(references\/[^`\s]+?\.md)`/g)) refs.add(match[1]);
    for (const match of String(loaded?.content || '').matchAll(/(?:^|[\s(])(references\/[A-Za-z0-9_./-]+\.md)/g)) refs.add(match[1]);
    const unreadable = [];
    if (normalizedBase) {
      for (const rel of refs) {
        try {
          const info = await stat(join(normalizedBase, rel));
          if (!info.isFile()) unreadable.push(`${rel} (not a file)`);
          else await readFile(join(normalizedBase, rel), 'utf8');
        } catch (error) {
          unreadable.push(`${rel} (${String(error?.code || error?.message || error)})`);
        }
      }
    }
    record('正文引用的 references/*.md 均可从 resourceBase 读取', Boolean(normalizedBase) && refs.size > 0 && unreadable.length === 0, {
      referenced: [...refs],
      unreadable,
    });

    const rendered = renderSkillContent(loaded);
    record('renderSkillContent() 输出可解析的 <skill_content> 块', rendered.startsWith('<skill_content') && rendered.trimEnd().endsWith('</skill_content>'), {
      head: rendered.slice(0, 80),
      tail: rendered.slice(-40),
      bytes: rendered.length,
    });
    record('renderSkillContent() 含技能正文片段', rendered.includes('ui-testing') && rendered.includes(String(loaded.content).slice(0, 60)), {
      bodyExcerpt: String(loaded.content).slice(0, 60),
    });
  } finally {
    try {
      if (fiber && typeof fiber.dispose === 'function') await fiber.dispose();
    } catch (error) {
      disposeError = error;
    }
    try {
      const afterDispose = await ctx.skills.list({});
      record('dispose 插件 fiber 后 ui-testing 从 registry 消失', !afterDispose.some((entry) => entry.name === 'ui-testing'), afterDispose.map((entry) => entry.name));
    } catch (error) {
      record('dispose 后重新 list() 成功', false, String(error?.message || error));
    }
  }
  record('dispose 未抛异常', !disposeError, disposeError ? String(disposeError.message || disposeError) : 'ok');

  return finish();
}

if (!existsSync(join(REPO_ROOT, 'index.js'))) {
  console.log('[FAIL] index.js 不存在');
  process.exitCode = 1;
} else {
  let code = 1;
  try {
    code = await main();
  } catch (error) {
    console.error('[FAIL] check-skill-registry 执行异常:', error);
    code = 1;
  }
  process.exitCode = code;
}