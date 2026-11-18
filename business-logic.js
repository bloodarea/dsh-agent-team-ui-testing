/**
 * business-logic.js — FR-08 业务逻辑测试（BIZ-01..BIZ-05）的纯核心。
 *
 * 业务逻辑测试与"漏洞规则"不同：它比较的是**服务端最终状态**与业务不变量（价格、数量、
 * 折扣、状态迁移、幂等性），而不是请求本身。因此本模块的判定全部基于「观测到的服务端状态」：
 *
 *  - BIZ-01 数量/价格边界：负数、零、超上限、小数被接受后服务端状态是否越界（如 subtotal<0）；
 *  - BIZ-02 优惠券重复：同一码多次应用后折扣是否累加（业务上应为一次）；
 *  - BIZ-03 客户端金额信任：提交金额与服务端最终 total 不一致且服务端采用了客户端值；
 *  - BIZ-04 重复提交/状态迁移：同一操作重复提交是否幂等；非法顺序是否被拒；
 *  - BIZ-05 可重复性：每个确认的问题必须有 ≥2 次可重复观测。
 *
 * 所有判定都输出 candidate（候选），状态仍由 finding.deriveStatus 按证据类型推导。
 */

export const BIZ_VERSION = 1;

/** 业务不变量：价格与数量的合法域。 */
export const BIZ_INVARIANTS = Object.freeze({
  minQty: 0,
  maxQty: 999,
  minPrice: 0,
  maxDiscountRatio: 1,
});

/* -----------------------------------------------------------------------------------------------
 * BIZ-01：数量/价格边界
 * ---------------------------------------------------------------------------------------------- */

/**
 * 数量边界：观测到的服务端状态里出现了业务上不可能的数量或金额。
 * `observations` 是 [{input, accepted, cartState:{items:[{qty}], subtotal, total}}]。
 * 判定依据是**服务端状态**（subtotal/total<0 或 qty 越界），不是输入本身被接受。
 */
export function checkQuantityBoundaries(observations) {
  const list = Array.isArray(observations) ? observations : [];
  const violations = [];
  for (const entry of list) {
    const state = entry?.cartState ?? null;
    if (state === null) continue;
    const items = Array.isArray(state.items) ? state.items : [];
    const negativeQty = items.filter((item) => Number(item?.qty) < BIZ_INVARIANTS.minQty);
    const tooLargeQty = items.filter((item) => Number(item?.qty) > BIZ_INVARIANTS.maxQty);
    const negativeMoney = [
      ['subtotal', state.subtotal], ['total', state.total],
    ].filter(([, value]) => Number.isFinite(Number(value)) && Number(value) < BIZ_INVARIANTS.minPrice);
    if (negativeQty.length > 0 || tooLargeQty.length > 0 || negativeMoney.length > 0) {
      violations.push({
        input: entry.input ?? null,
        accepted: entry.accepted === true,
        negativeQty: negativeQty.map((item) => ({ qty: item.qty, name: item.name ?? null })),
        tooLargeQty: tooLargeQty.map((item) => item.qty),
        negativeMoney: negativeMoney.map(([field, value]) => ({ field, value })),
      });
    }
  }
  if (violations.length === 0) return null;
  const hasNegativeMoney = violations.some((entry) => entry.negativeMoney.length > 0);
  return {
    ruleId: 'BIZ-QTY-BOUNDARY',
    category: 'business-logic',
    severity: hasNegativeMoney ? 'high' : 'medium',
    title: hasNegativeMoney ? '负数量导致订单金额为负' : '数量边界未被服务端校验',
    basis: 'observed-once',
    confidence: 0.85,
    evidence: { violations, invariants: { ...BIZ_INVARIANTS } },
    impact: hasNegativeMoney
      ? '攻击者可用负数数量把订单金额压到负值，可能造成退款/积分套利或账务错误。'
      : '异常数量被写入服务端购物车，可能导致库存/统计错误。',
    remediation: '服务端对数量做 ≥1 且 ≤库存的整数校验；金额按服务端价格重算并校验非负。',
  };
}

/* -----------------------------------------------------------------------------------------------
 * BIZ-02：优惠券重复与叠加
 * ---------------------------------------------------------------------------------------------- */

/**
 * 优惠券重复使用：同一码连续应用 N 次，折扣累加（业务上应为幂等或拒绝）。
 * `applications` 是 [{code, ok, discount, total}]，顺序即真实顺序。
 */
export function checkCouponReuse(applications) {
  const list = Array.isArray(applications) ? applications : [];
  if (list.length < 2) return null;
  const byCode = new Map();
  for (const entry of list) {
    const code = String(entry?.code ?? '');
    if (code === '') continue;
    const bucket = byCode.get(code) ?? [];
    bucket.push(entry);
    byCode.set(code, bucket);
  }
  const offenders = [];
  for (const [code, bucket] of byCode) {
    if (bucket.length < 2) continue;
    const discounts = bucket.map((entry) => Number(entry?.discount ?? 0)).filter(Number.isFinite);
    if (discounts.length < 2) continue;
    const last = discounts[discounts.length - 1];
    const first = discounts[0];
    const accumulated = last > first;
    if (accumulated || bucket.every((entry) => entry?.ok === true)) {
      offenders.push({ code, applications: bucket.length, discounts, accumulated });
    }
  }
  if (offenders.length === 0) return null;
  return {
    ruleId: 'BIZ-COUPON-REUSE',
    category: 'business-logic',
    severity: 'high',
    title: '同一优惠券可重复应用并累加折扣',
    basis: 'observed-once',
    confidence: 0.9,
    evidence: { offenders },
    impact: '攻击者可反复应用优惠券把价格压到极低甚至负数。',
    remediation: '服务端按（用户,券码）唯一约束记录已用券；重复应用返回错误而非累加。',
  };
}

/* -----------------------------------------------------------------------------------------------
 * BIZ-03：客户端金额信任
 * ---------------------------------------------------------------------------------------------- */

/**
 * 客户端提交金额 vs 服务端最终状态。服务端应重算；若最终 total 跟随客户端值即为缺陷。
 * `checkout` 是 {submittedTotal, serverTotal, expectedServerTotal?}。
 */
export function checkClientTrust(checkout) {
  if (typeof checkout !== 'object' || checkout === null) return null;
  const submitted = Number(checkout.submittedTotal);
  const server = Number(checkout.serverTotal);
  if (!Number.isFinite(submitted) || !Number.isFinite(server)) return null;
  const expected = Number(checkout.expectedServerTotal);
  const followsClient = Math.abs(server - submitted) < 0.005;
  const divergesFromExpected = Number.isFinite(expected) && Math.abs(server - expected) > 0.005;
  if (!followsClient || !divergesFromExpected) return null;
  return {
    ruleId: 'BIZ-CLIENT-TRUST',
    category: 'business-logic',
    severity: 'critical',
    title: '服务端采用客户端提交的结算金额',
    basis: 'differential',
    confidence: 0.95,
    evidence: { submittedTotal: submitted, serverTotal: server, expectedServerTotal: expected },
    impact: '攻击者可篡改结算金额，直接造成资金损失。',
    remediation: '服务端按购物车商品与券规则重算 total，忽略客户端金额字段。',
  };
}

/* -----------------------------------------------------------------------------------------------
 * BIZ-04：重复提交与状态迁移
 * ---------------------------------------------------------------------------------------------- */

/**
 * 重复提交（幂等性）：同一提交动作重复执行，服务端创建了多个资源（订单/工单）。
 * `submissions` 是 [{id?, ok, createdId?, status}]，`resourceIds` 返回去重后的新资源数。
 */
export function checkDuplicateSubmission(submissions) {
  const list = Array.isArray(submissions) ? submissions : [];
  if (list.length < 2) return null;
  const created = list.map((entry) => entry?.createdId ?? entry?.id ?? null).filter((value) => value !== null);
  const unique = new Set(created.map(String));
  if (created.length < 2 || unique.size <= 1) return null;
  return {
    ruleId: 'BIZ-DUPLICATE-SUBMIT',
    category: 'business-logic',
    severity: 'medium',
    title: '重复提交创建了多个资源（缺少幂等）',
    basis: 'observed-once',
    confidence: 0.85,
    evidence: { submissions: list.length, createdIds: [...unique] },
    impact: '重复提交可造成重复订单/重复扣款/重复工单。',
    remediation: '引入幂等键（Idempotency-Key）或服务端去重窗口。',
  };
}

/**
 * 非法状态迁移：订单/工单在错误状态下被推进（如已取消订单可再次支付、跳过支付直接完成）。
 * `transitions` 是 [{from, to, accepted, allowedByBusiness?}]。
 */
export function checkStateTransition(transitions, { allowedTransitions = null } = {}) {
  const list = Array.isArray(transitions) ? transitions : [];
  if (list.length === 0) return null;
  const allowed = allowedTransitions instanceof Set
    ? allowedTransitions
    : new Set((Array.isArray(allowedTransitions) ? allowedTransitions : []).map((pair) => pair?.from + '->' + pair?.to));
  const illegal = list.filter((entry) => {
    if (entry?.accepted !== true) return false;
    const key = String(entry?.from ?? '') + '->' + String(entry?.to ?? '');
    // Without a declared business map we can only flag obviously illegal transitions.
    if (allowed.size > 0) return !allowed.has(key);
    return ['cancelled->paid', 'cancelled->completed', 'refunded->paid', 'new->completed'].includes(key);
  });
  if (illegal.length === 0) return null;
  return {
    ruleId: 'BIZ-STATE-TRANSITION',
    category: 'business-logic',
    severity: 'medium',
    title: '服务端接受非法状态迁移',
    basis: 'observed-once',
    confidence: 0.8,
    evidence: { illegal: illegal.map((entry) => ({ from: entry.from, to: entry.to })) },
    impact: '非法状态迁移可绕过支付/审核流程。',
    remediation: '服务端用显式状态机校验每次迁移的合法性。',
  };
}

/* -----------------------------------------------------------------------------------------------
 * BIZ-05：可重复性
 * ---------------------------------------------------------------------------------------------- */

/**
 * 可重复性门槛：每个确认的业务问题至少 2 次可重复观测（BIZ-05 硬性要求）。
 * `attempts` 是每次尝试的 {reproduced:boolean}；返回是否达标与命中率。
 */
export function reproducibility({ attempts = [] } = {}) {
  const list = Array.isArray(attempts) ? attempts : [];
  const reproduced = list.filter((entry) => entry?.reproduced === true).length;
  return {
    attempts: list.length,
    reproduced,
    repeatable: reproduced >= 2,
    rate: list.length === 0 ? null : reproduced / list.length,
    note: 'BIZ-05：每个确认问题至少 2 次可重复验证；1 次只能计为候选。',
  };
}

/* -----------------------------------------------------------------------------------------------
 * 场景汇总
 * ---------------------------------------------------------------------------------------------- */

/**
 * 对一个业务场景的全部观测执行检查，返回候选与可重复性结论。
 * `facts` 的键与上面的 check 函数一一对应；缺失即不评估（不生成假阳性）。
 */
export function evaluateBusinessLogic(facts = {}) {
  const checks = [];
  const has = (key) => facts[key] !== undefined && facts[key] !== null;
  if (has('quantityBoundaries')) checks.push(checkQuantityBoundaries(facts.quantityBoundaries));
  if (has('couponReuse')) checks.push(checkCouponReuse(facts.couponReuse));
  if (has('clientTrust')) checks.push(checkClientTrust(facts.clientTrust));
  if (has('duplicateSubmission')) checks.push(checkDuplicateSubmission(facts.duplicateSubmission));
  if (has('stateTransition')) checks.push(checkStateTransition(facts.stateTransition, facts.allowedTransitions ?? {}));
  const candidates = checks.filter((entry) => entry !== null && entry !== undefined);
  const repeat = has('reproducibility') ? reproducibility(facts.reproducibility) : null;
  return {
    version: BIZ_VERSION,
    evaluated: candidates.length,
    candidates,
    reproducibility: repeat,
    // BIZ-05 gate: a confirmed business finding needs repeatability evidence.
    confirmable: candidates.filter((candidate) => repeat === null || repeat.repeatable === true)
      .map((candidate) => candidate.ruleId),
    note: '候选只描述服务端状态观测；confirmed 仍需 finding.deriveStatus 的 ≥2 复现+对照门槛。',
  };
}
