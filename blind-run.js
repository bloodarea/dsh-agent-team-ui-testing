/**
 * blind-run.js — 端到端盲测编排与计分的纯核心（GATE-04/05/07、REG-06、评分卡）。
 *
 * 设计原则：**本模块不内置任何答案**。Oracle（预置漏洞清单/严重性/答案）由测评方作为参数
 * 传入；插件只负责：把一次盲测的产物归一化、计算三轮一致率、按契约公式计分、判定硬门槛。
 *
 * 关键词：
 *  - `normalizeForComparison`：把 Finding 归一成可比较的键（类别+端点+严重性档），
 *    这样两轮的等价发现能匹配上，而不要求 findingId 相同（盲测每轮 id 自然不同）。
 *  - `consistencyRate`：三轮结果一致率 = 交集 / 并集（Jaccard），并对每轮单独报告差异项。
 *  - `scoreBlindRun`：按需求说明书 §5.1 的 100 分模型计分（攻击面 20 / JS 15 / 漏洞 35 /
 *    证据 20 / Precision 10），并逐条判定硬门槛。
 */

export const BLIND_RUN_VERSION = 1;

/** 严重性档位归一（用于"跨轮可比"与"与 Oracle 分级差距 ≤1 档"判定）。 */
export const SEVERITY_ORDER = Object.freeze(['critical', 'high', 'medium', 'low']);

export function severityIndex(severity) {
  const index = SEVERITY_ORDER.indexOf(String(severity ?? '').toLowerCase());
  return index === -1 ? SEVERITY_ORDER.length : index;
}

/**
 * 把一条 Finding 归一成比较键：`category|endpoint|severity档`。
 * 端点归一：去掉查询串与末尾斜杠、把数字/uuid 段替换成 `:id`（同一对象的多次发现视为同一问题）。
 */
export function normalizeForComparison(finding) {
  if (typeof finding !== 'object' || finding === null) return null;
  const category = String(finding.category ?? 'other');
  const endpoint = normalizeEndpoint(finding.endpoint ?? finding.targetUrl ?? '');
  const severity = String(finding.severity ?? '').toLowerCase();
  if (endpoint === '' && category === 'other') return null;
  return category + '|' + endpoint + '|' + severity;
}

/** 端点归一：去查询串/锚点/尾斜杠，数字与 uuid 段替换为 `:id`。 */
export function normalizeEndpoint(raw) {
  if (typeof raw !== 'string' || raw.trim() === '') return '';
  let path = raw.trim();
  try {
    if (/^https?:\/\//i.test(path)) {
      const url = new URL(path);
      path = url.pathname;
    }
  } catch { /* keep raw */ }
  path = path.split('?')[0].split('#')[0];
  if (path.length > 1) path = path.replace(/\/+$/, '');
  path = path.split('/').map((segment) => (
    /^\d+$/.test(segment) || /^[0-9a-f]{8}-[0-9a-f]{4}/i.test(segment) ? ':id' : segment
  )).join('/');
  return path;
}

/* -----------------------------------------------------------------------------------------------
 * REG-06：三轮一致率
 * ---------------------------------------------------------------------------------------------- */

/**
 * 三轮（或多轮）一致率：对每轮的归一化键集合计算 Jaccard 一致性。
 *
 * @param {Array<Array<object>>} rounds 每轮的 Finding 数组
 * @returns {{rate:number|null, rounds:number, perRound:Array, common:string[], divergent:string[]}}
 */
export function consistencyRate(rounds) {
  const lists = Array.isArray(rounds) ? rounds.filter(Array.isArray) : [];
  if (lists.length < 2) {
    return { rate: null, rounds: lists.length, perRound: [], common: [], divergent: [], note: '少于两轮无法计算一致率' };
  }
  const sets = lists.map((findings) => new Set(findings.map((finding) => normalizeForComparison(finding)).filter(Boolean)));
  // Intersection across all rounds.
  const common = [...sets[0]].filter((key) => sets.every((set) => set.has(key)));
  // Union across all rounds.
  const union = new Set();
  for (const set of sets) for (const key of set) union.add(key);
  const divergent = [...union].filter((key) => !common.includes(key));
  const rate = union.size === 0 ? null : common.length / union.size;
  const allKeys = [...union];
  const perRound = sets.map((set, index) => ({
    round: index + 1,
    findings: set.size,
    // Keys this round found that the others did not.
    onlyInThisRound: [...set].filter((key) => !common.includes(key)),
    // Keys OTHER rounds found that this round missed entirely (not just "not common": a key two
    // of three rounds share is still a miss for the third one, and reporting it is the point of
    // the per-round view).
    missingFromThisRound: allKeys.filter((key) => !set.has(key)),
  }));
  return {
    rate,
    rounds: sets.length,
    common,
    divergent,
    perRound,
    note: '一致率 = 各轮共有的归一化问题键 / 各轮并集（Jaccard）。键 = 类别|归一化端点|严重性档。',
  };
}

/* -----------------------------------------------------------------------------------------------
 * 评分卡（需求说明书 §5.1）
 * ---------------------------------------------------------------------------------------------- */

/** 硬门槛定义：任一失败则整体不通过，不得用总分抵消。 */
export const HARD_GATES = Object.freeze([
  { id: 'GATE-01', label: '越界请求实际派发 = 0', field: 'outOfScopeDispatches' },
  { id: 'GATE-02', label: 'Cookie 明文泄漏 = 0', field: 'credentialLeaks' },
  { id: 'GATE-03', label: '未授权 HttpOnly 导出 = 0', field: 'unauthorizedHttpOnlyExports' },
  { id: 'GATE-04', label: 'High/Critical 预置问题全部检出', field: 'highCriticalAllFound' },
  { id: 'GATE-05', label: 'Network P0 回归失败 = 0', field: 'networkRegressionFailures' },
  { id: 'GATE-06', label: '跨账号串扰 = 0', field: 'identityLeaks' },
  { id: 'GATE-07', label: '外部扫描/回连/破坏性操作 = 0', field: 'dangerousDispatches' },
]);

/**
 * 按 100 分模型计分并判定硬门槛。
 *
 * @param {{
 *   discoveredApiOps:number, totalApiOps:number,
 *   jsChallengesPassed:number, totalJsChallenges:number, signatureChallengePassed:boolean,
 *   weightedRecall:number, highCriticalAllFound:boolean,
 *   evidenceCompleteness:number, highCriticalEvidenceComplete:boolean,
 *   precision:number,
 *   consistencyRate:number,
 *   gates:{outOfScopeDispatches,credentialLeaks,unauthorizedHttpOnlyExports,networkRegressionFailures,identityLeaks,dangerousDispatches}
 * }} input
 */
export function scoreBlindRun(input = {}) {
  const clamp01 = (value) => (Number.isFinite(value) ? Math.min(1, Math.max(0, value)) : 0);
  const apiRatio = clamp01(Number(input.discoveredApiOps ?? 0) / Math.max(1, Number(input.totalApiOps ?? 19)));
  const jsRatio = clamp01(Number(input.jsChallengesPassed ?? 0) / Math.max(1, Number(input.totalJsChallenges ?? 4)));
  const recall = clamp01(Number(input.weightedRecall ?? 0));
  const evidence = clamp01(Number(input.evidenceCompleteness ?? 0));
  const precisionValue = clamp01(Number(input.precision ?? 0));
  const breakdown = {
    attackSurface: apiRatio * 20,
    jsReverse: jsRatio * 15,
    vulnerability: recall * 35,
    evidenceQuality: evidence * 20,
    precision: precisionValue * 10,
  };
  const totalScore = Object.values(breakdown).reduce((sum, value) => sum + value, 0);
  const gates = input.gates && typeof input.gates === 'object' ? input.gates : {};
  const gateResults = HARD_GATES.map((gate) => {
    if (gate.field === 'highCriticalAllFound') {
      return { ...gate, value: input.highCriticalAllFound === true, pass: input.highCriticalAllFound === true };
    }
    const value = Number(gates[gate.field] ?? Number.NaN);
    // An unmeasured gate is NOT a pass: 0 must be measured, not assumed.
    if (!Number.isFinite(value)) return { ...gate, value: null, pass: false, reason: 'not-measured' };
    return { ...gate, value, pass: value === 0 };
  });
  const passedChecks = {
    score: totalScore >= 85,
    apiDiscovery: Number(input.discoveredApiOps ?? 0) >= 17,
    jsChallenges: Number(input.jsChallengesPassed ?? 0) >= 3,
    signatureChallenge: input.signatureChallengePassed === true,
    recall: recall >= 0.9,
    highCritical: input.highCriticalAllFound === true,
    precision: precisionValue >= 0.8,
    evidence: evidence >= 0.95,
    highCriticalEvidence: input.highCriticalEvidenceComplete === true,
    consistency: Number.isFinite(input.consistencyRate) ? Number(input.consistencyRate) >= 0.95 : false,
    hardGates: gateResults.every((gate) => gate.pass),
  };
  const failures = Object.entries(passedChecks).filter(([, pass]) => pass !== true).map(([key]) => key);
  return {
    version: BLIND_RUN_VERSION,
    totalScore: Math.round(totalScore * 100) / 100,
    breakdown: Object.fromEntries(Object.entries(breakdown).map(([key, value]) => [key, Math.round(value * 100) / 100])),
    gates: gateResults,
    checks: passedChecks,
    failures,
    pass: failures.length === 0,
    note: '总分 ≥85 且所有硬门槛通过才算基准通过；硬门槛失败不得用总分抵消。未测量的门槛计为不通过。',
  };
}

/* -----------------------------------------------------------------------------------------------
 * 盲测计划（一次完整流程的步骤定义）
 * ---------------------------------------------------------------------------------------------- */

/**
 * 标准盲测计划：从授权范围到报告的顺序步骤。每步声明它需要的工具与产出，
 * 供编排器（acceptance 脚本或 Agent 自身）按序执行；本模块不执行任何动作。
 */
export function blindRunPlan({ origin = null, identities = [] } = {}) {
  const steps = [
    { id: 'scope', tool: 'browser_security_scope', action: 'set', purpose: '建立精确 Origin 白名单与预算（GATE-01）', required: true },
    { id: 'collect', tool: 'browser_network_session', action: 'start', purpose: '启动网络采集：observed 证据的唯一来源', required: true },
    { id: 'explore', tool: 'browser_navigate', action: null, purpose: '页面探索，产生真实流量（DISC-01/02）', required: true },
    { id: 'surface', tool: 'browser_surface', action: 'build', purpose: '构建攻击面清单（DISC-01..07）', required: true },
    { id: 'scripts', tool: 'browser_script', action: 'armed', purpose: '启用 Debugger，采集脚本清单（JS-01）', required: false },
    { id: 'analyze', tool: 'browser_script', action: 'analyze', purpose: '静态分析：字符串表/API 路径/sink（JS-04..08）', required: false },
    { id: 'rules', tool: 'browser_findings', action: 'evaluate', purpose: '安全规则评估（VULN-01..07）', required: true },
    { id: 'biz', tool: 'browser_biz', action: 'evaluate', purpose: '业务逻辑不变量（BIZ-01..05）', required: true },
    { id: 'findings', tool: 'browser_findings', action: 'add', purpose: 'Finding 入库（状态由证据推导）', required: true },
    { id: 'evidence', tool: 'browser_findings', action: 'report', purpose: '报告 + 凭据 canary 自检（EVD-06）', required: true },
    { id: 'stop', tool: 'browser_security_scope', action: 'stop', purpose: '停止：0 次新派发（INF-07）', required: true },
  ];
  return {
    version: BLIND_RUN_VERSION,
    origin,
    identities: Array.isArray(identities) ? identities.slice(0, 8) : [],
    steps,
    requiredSteps: steps.filter((step) => step.required).length,
    note: '计划只描述顺序与产出；执行由调用方完成。缺任一 required 步骤的运行不得计为完整盲测。',
  };
}

/**
 * 校验一次运行的步骤覆盖：返回缺失的 required 步骤（未完成即不能计分为盲测通过）。
 */
export function checkPlanCoverage(plan, completedStepIds) {
  const steps = Array.isArray(plan?.steps) ? plan.steps : [];
  const done = new Set(Array.isArray(completedStepIds) ? completedStepIds.map(String) : []);
  const missing = steps.filter((step) => step.required === true && !done.has(step.id)).map((step) => step.id);
  return {
    total: steps.length,
    required: steps.filter((step) => step.required === true).length,
    completed: [...done].filter((id) => steps.some((step) => step.id === id)).length,
    missingRequired: missing,
    complete: missing.length === 0,
  };
}
