/**
 * business-logic.mjs — FR-08 business logic acceptance (BIZ-01..BIZ-05).
 *
 * Ground truth: dsh-security-lab's real cart/coupon endpoints driven through the plugin's own
 * page. Every assertion is about the SERVER's resulting state, never about "the request was
 * accepted":
 *   BIZ-01 boundary quantities (negative / zero / above cap) and the resulting money
 *   BIZ-02 the same coupon applied twice and the accumulated discount
 *   BIZ-04 idempotency + illegal transitions (evaluated from observed facts)
 *   BIZ-05 repeatability gate: a single attempt can never confirm a business finding
 *
 * Run: node tests/acceptance/business-logic.mjs
 */
import { pathToFileURL } from 'node:url';
import { join } from 'node:path';

const REPO_ROOT = join(import.meta.dirname ?? '.', '..', '..');
const LAB = 'http://127.0.0.1:8088';

const checks = [];
let currentSection = '';
function section(title) { currentSection = title; }
function check(condition, label, details) {
  checks.push({ ok: condition === true, label, section: currentSection, details: details ?? null });
  console.log(`${condition === true ? '✔' : '✖'} [${currentSection}] ${label}`);
  if (condition !== true && details !== undefined) console.log('   details:', JSON.stringify(details).slice(0, 800));
}

const { createHarness } = await import('./harness.mjs');

async function main() {
  let labMode = false;
  try {
    const health = await fetch(LAB + '/api/health', { signal: AbortSignal.timeout(1500) });
    labMode = health.ok;
  } catch { labMode = false; }
  if (!labMode) {
    console.log('[env] dsh-security-lab is not running — BIZ acceptance needs the real cart/coupon endpoints.');
    console.log('      start it with: cd targets/dsh-security-lab && docker compose up --build -d');
    process.exitCode = 1;
    return;
  }
  console.log('[env]', LAB);

  const harness = await createHarness({ name: 'business-logic' });
  const agent = { id: 'biz-acc', session: { header: { cwd: harness.workspaceDir } } };
  const exec = { agent };
  try {
    await harness.invoke('browser_tabs', { action: 'open' }, exec);
    await harness.invoke('browser_navigate', { url: LAB }, exec);
    const login = await harness.invoke('browser_eval', {
      expression: `(async () => { const r = await fetch('/api/login', { method: 'POST', credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username: 'alice', password: 'alice-lab-2026' }) }); return r.status; })()`,
    }, exec);
    check(login.value?.value === 200, '以 alice 登录靶机', login.value?.value);

    // ---- BIZ-01: boundary quantities vs the resulting server cart --------------------------
    section('BIZ-01-quantity');
    const boundary = await harness.invoke('browser_biz', {
      action: 'probe', scenario: 'cart-quantity', variants: [-5, 0, 100000], productId: 1,
    }, exec);
    check(boundary.ok === true, 'BIZ-01 边界数量场景执行成功');
    const observations = boundary.value?.observations ?? [];
    check(observations.length === 3, '三次边界数量观测都被采集', observations.length);
    // The cart accumulates, so the scenario neutralises the line first — otherwise each
    // observation would describe a previous run's residue instead of its own input.
    check(boundary.value?.reset?.after === 0, 'BIZ-01 场景先把该商品数量归零（观测基线可复现）', boundary.value?.reset);
    check(observations.every((entry) => entry.cartState !== undefined && entry.cartState !== null),
      '每次观测都读取了服务端购物车状态（而非只看请求是否被接受）');

    const quantityFinding = boundary.value?.evaluated;
    check(quantityFinding !== null && quantityFinding !== undefined, 'BIZ-01 检出数量/金额边界缺陷', quantityFinding);
    if (quantityFinding !== null && quantityFinding !== undefined) {
      check(quantityFinding.ruleId === 'BIZ-QTY-BOUNDARY', '规则 id 正确');
      check(['high', 'medium'].includes(quantityFinding.severity), '严重性合法（负金额为 high）', quantityFinding.severity);
      const negativeMoney = (quantityFinding.evidence?.violations ?? []).some((violation) => violation.negativeMoney?.length > 0);
      check(negativeMoney === true, 'BIZ-01 证据含负金额（subtotal/total<0）——服务端状态事实',
        quantityFinding.evidence?.violations?.map((v) => v.negativeMoney));
    }

    // ---- BIZ-02: coupon reuse --------------------------------------------------------------
    section('BIZ-02-coupon');
    const coupon = await harness.invoke('browser_biz', {
      action: 'probe', scenario: 'coupon-reuse', code: 'WELCOME10', times: 2,
    }, exec);
    check(coupon.ok === true, 'BIZ-02 优惠券场景执行成功');
    const applications = coupon.value?.applications ?? [];
    check(applications.length === 2, '两次应用都被记录');
    const coupons = coupon.value?.evaluated;
    check(coupons !== null && coupons !== undefined, 'BIZ-02 检出优惠券重复累加', coupons);
    if (coupons !== null && coupons !== undefined) {
      check(coupons.ruleId === 'BIZ-COUPON-REUSE', '规则 id 正确');
      const accumulated = (coupons.evidence?.offenders ?? []).some((offender) => offender.accumulated === true);
      check(accumulated === true, 'BIZ-02 证据显示折扣累加（同一码两次生效）', coupons.evidence?.offenders);
    }

    // ---- BIZ-03/04: evaluation-only checks on supplied facts -------------------------------
    section('BIZ-03-04-evaluate');
    const clientTrust = await harness.invoke('browser_biz', {
      action: 'evaluate',
      facts: { clientTrust: { submittedTotal: 0.01, serverTotal: 0.01, expectedServerTotal: 89.7 } },
    }, exec);
    const trustCandidate = (clientTrust.value?.candidates ?? [])[0];
    check(trustCandidate?.ruleId === 'BIZ-CLIENT-TRUST', 'BIZ-03 客户端金额信任被检出（evaluate 路径）');
    check(trustCandidate?.allowedStatus !== 'confirmed', 'BIZ 候选的允许状态永不为 confirmed',
      trustCandidate?.allowedStatus);

    const duplicate = await harness.invoke('browser_biz', {
      action: 'evaluate',
      facts: { duplicateSubmission: [{ ok: true, createdId: 101 }, { ok: true, createdId: 102 }] },
    }, exec);
    check((duplicate.value?.candidates ?? [])[0]?.ruleId === 'BIZ-DUPLICATE-SUBMIT', 'BIZ-04 重复提交被检出');

    const transition = await harness.invoke('browser_biz', {
      action: 'evaluate',
      facts: { stateTransition: [{ from: 'cancelled', to: 'paid', accepted: true }] },
    }, exec);
    check((transition.value?.candidates ?? [])[0]?.ruleId === 'BIZ-STATE-TRANSITION', 'BIZ-04 非法状态迁移被检出');

    const cleanFacts = await harness.invoke('browser_biz', {
      action: 'evaluate',
      facts: { couponReuse: [{ code: 'W', ok: true, discount: 10 }, { code: 'W', ok: false, discount: 10 }] },
    }, exec);
    check((cleanFacts.value?.candidates ?? []).length === 0, '正确拒绝重复券时不产生 Finding（避免误报）');

    // ---- BIZ-05: repeatability gate --------------------------------------------------------
    section('BIZ-05-repeatability');
    const single = await harness.invoke('browser_biz', {
      action: 'evaluate',
      facts: {
        couponReuse: [{ code: 'W', ok: true, discount: 10 }, { code: 'W', ok: true, discount: 20 }],
        reproducibility: { attempts: [{ reproduced: true }] },
      },
    }, exec);
    check(single.value?.reproducibility?.repeatable === false, 'BIZ-05 单次尝试不可重复');
    check((single.value?.confirmable ?? []).length === 0, 'BIZ-05 单次尝试不能确认业务 Finding');

    const twice = await harness.invoke('browser_biz', {
      action: 'evaluate',
      facts: {
        couponReuse: [{ code: 'W', ok: true, discount: 10 }, { code: 'W', ok: true, discount: 20 }],
        reproducibility: { attempts: [{ reproduced: true }, { reproduced: true }] },
      },
    }, exec);
    check(twice.value?.reproducibility?.repeatable === true, 'BIZ-05 两次复现达到门槛');
    check((twice.value?.confirmable ?? []).length === 1, 'BIZ-05 达门槛后候选可确认');

    // Re-probe the real coupon defect to prove repeatability against the live server.
    const couponAgain = await harness.invoke('browser_biz', {
      action: 'probe', scenario: 'coupon-reuse', code: 'WELCOME10', times: 2,
    }, exec);
    const repeatFinding = couponAgain.value?.evaluated;
    check(repeatFinding !== null && repeatFinding !== undefined,
      'BIZ-05 真实靶机上第二次独立复现同样检出（可重复性）', repeatFinding?.ruleId);

    // ---- read-only baseline scenario -------------------------------------------------------
    section('BIZ-snapshot');
    const snapshot = await harness.invoke('browser_biz', { action: 'probe', scenario: 'snapshot' }, exec);
    check(snapshot.ok === true && snapshot.value?.cart !== undefined, '只读快照场景可用（购物车/订单/商品）');
    const orderState = await harness.invoke('browser_biz', { action: 'probe', scenario: 'order-state' }, exec);
    check(orderState.ok === true && Array.isArray(orderState.value?.orders), '订单状态基线可读');

    // ---- scope gate: biz probes must not escape the boundary -------------------------------
    section('BIZ-scope');
    const scoped = await harness.invoke('browser_security_scope', {
      action: 'set', allowedOrigins: ['http://127.0.0.1:8088'], mode: 'active',
    }, exec);
    check(scoped.ok === true, 'scope 边界已建立');
    const escaped = await harness.invoke('browser_biz', {
      action: 'probe', scenario: 'snapshot', basePath: 'http://example.com',
    }, exec);
    check(escaped.ok === false && /SECURITY_SCOPE_/.test(String(escaped.error?.code)),
      'BIZ probe 越界被 scope 闸门拦截（无逃逸口）', escaped.error?.code);
    const danger = await harness.invoke('browser_biz', {
      action: 'probe', scenario: 'cart-quantity', variants: [-1], productId: 1,
    }, exec);
    check(danger.ok === true, '白名单内 probe 不受影响（闸门精确）', danger.error?.code);

    const failed = checks.filter((entry) => !entry.ok);
    console.log(`\n==== business-logic acceptance: ${checks.length - failed.length}/${checks.length} checks passed ====`);
    if (failed.length > 0) {
      for (const entry of failed) console.log('FAILED:', entry.section, '|', entry.label, JSON.stringify(entry.details).slice(0, 400));
      process.exitCode = 1;
    }
  } finally {
    await harness.closeBrowser();
    await harness.dispose();
  }
}

main().catch((error) => {
  console.error('business-logic acceptance crashed:', error);
  process.exitCode = 1;
});
