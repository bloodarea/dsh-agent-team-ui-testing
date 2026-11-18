/**
 * finding.js — FR-09/FR-10 安全 Finding 模型与证据闭环（VULN-08..VULN-11、EVD-01..EVD-07）。
 *
 * 核心约束（需求说明书 §4 FR-09/FR-10，验收清单 VULN/EVD 系列）：
 *  - Finding 状态四态：confirmed（直接证据且可重复）/ likely（证据支持未对照）/
 *    potential（仅风险模式）/ false_positive（经验证不成立）；
 *  - **禁止**把仅由静态字符串或单次异常响应推断的风险标为 confirmed——`deriveStatus` 是唯一
 *    合法状态推导入口，它按证据类型强制降级；
 *  - 严重性 Critical/High/Medium/Low + 权重 5/4/2/1（VULN-08 加权召回率的计算基础）；
 *  - 证据完整率按 Finding Schema 的必填字段计算，High/Critical 单独统计（EVD-02）；
 *  - 敏感字段脱敏检查：Finding 的任何字段都不得包含已导出的 Cookie 值（EVD-06/CRED-08）；
 *  - 每个 confirmed Finding 必须至少有一次对照验证（VULN-10）。
 */

export const FINDING_VERSION = 1;

export const SEVERITIES = Object.freeze(['critical', 'high', 'medium', 'low']);
export const SEVERITY_WEIGHT = Object.freeze({ critical: 5, high: 4, medium: 2, low: 1 });
export const FINDING_STATUSES = Object.freeze(['confirmed', 'likely', 'potential', 'false_positive']);

/** FR-09 的分类（与需求说明书测试类别一一对应）。 */
export const FINDING_CATEGORIES = Object.freeze([
  'authentication', 'authorization-object', 'authorization-function', 'parameter-tampering',
  'injection', 'xss-stored', 'xss-dom', 'cors', 'security-headers', 'information-disclosure',
  'business-logic', 'session', 'other',
]);

/**
 * 证据类型 → 允许的最高状态。这是"禁止把静态字符串/单次异常标 confirmed"的实现点：
 *  - `reproduced`（多次可复现 + 对照）→ confirmed
 *  - `observed-once`（单次观测）/`differential`（有对照但未重复）→ likely
 *  - `static-pattern`（静态串/规则模式）→ potential
 *  - `disproved`（验证不成立）→ false_positive
 */
export const EVIDENCE_BASES = Object.freeze({
  // `differential` means the finding came from a CONTROLLED comparison (same request under two
  // identities/values) — that IS the contrast verification VULN-10 asks for, so with the required
  // reproductions it may reach confirmed. A single observation may not.
  reproduced: 'confirmed',
  differential: 'confirmed',
  'observed-once': 'likely',
  'static-pattern': 'potential',
  disproved: 'false_positive',
});

/** 严重性排序（用于报告与 High/Critical 统计）。 */
export function severityRank(severity) {
  const index = SEVERITIES.indexOf(String(severity ?? '').toLowerCase());
  return index === -1 ? SEVERITIES.length : index;
}

export function severityWeight(severity) {
  return SEVERITY_WEIGHT[String(severity ?? '').toLowerCase()] ?? 0;
}

/* -----------------------------------------------------------------------------------------------
 * 状态推导（FR-09 的硬规则）
 * ---------------------------------------------------------------------------------------------- */

/**
 * 由证据事实推导允许的 Finding 状态。
 *
 * @param {{basis:string, reproductions?:number, hasContrast?:boolean, staticOnly?:boolean}} evidence
 * @returns {{status:string, downgraded:boolean, reason:string}}
 */
export function deriveStatus({ basis = 'static-pattern', reproductions = 0, hasContrast = false, requested = null } = {}) {
  const ceiling = EVIDENCE_BASES[basis] ?? 'potential';
  // `downgraded` answers ONE question: did the caller ask for more than the evidence supports?
  // It is not "the evidence is weaker than confirmed" — a static pattern recorded as potential is
  // an honest record, not a downgrade. Only an explicit higher request makes it a downgrade.
  const downgrade = (status, reason) => {
    const wanted = typeof requested === 'string' ? requested : null;
    const order = ['false_positive', 'potential', 'likely', 'confirmed'];
    const askedHigher = wanted !== null && order.indexOf(wanted) > order.indexOf(status);
    return { status, downgraded: askedHigher, reason: askedHigher ? reason + '（调用方请求 ' + wanted + '）' : reason };
  };
  if (ceiling === 'false_positive') return downgrade('false_positive', '证据证伪');
  if (ceiling === 'confirmed') {
    // confirmed 需要：≥2 次复现 且 有一次对照验证（VULN-10）。缺一即降级。
    if (reproductions >= 2 && hasContrast === true) {
      return { status: 'confirmed', downgraded: false, reason: '≥2 次可复现 + 对照验证' };
    }
    const missing = [];
    if (reproductions < 2) missing.push('复现次数<' + 2);
    if (hasContrast !== true) missing.push('缺对照验证');
    return { ...downgrade('likely', '证据类型支持 confirmed，但' + missing.join('、') + '；降级为 likely'), downgraded: true };
  }
  return downgrade(ceiling, '证据类型 ' + basis + ' 的最高状态是 ' + ceiling);
}

/* -----------------------------------------------------------------------------------------------
 * Finding Schema（EVD-01）
 * ---------------------------------------------------------------------------------------------- */

/** Schema 必填字段（EVD-01 完整率的分母）。 */
export const FINDING_REQUIRED_FIELDS = Object.freeze([
  'findingId', 'title', 'category', 'severity', 'confidence', 'status',
  'targetUrl', 'endpoint', 'identity', 'preconditions', 'reproductionSteps',
  'evidence', 'impact', 'remediation', 'actionId', 'createdAt',
]);

/** 证据引用字段（EVD-03：请求/响应证据；EVD-04：UI/源码位置）。 */
export const FINDING_EVIDENCE_FIELDS = Object.freeze([
  'request', 'response', 'dom', 'screenshot', 'scriptLocation', 'networkSeq',
]);

/** 严重性对应的证据完整性要求（EVD-02 的 High/Critical 100% 规则）。 */
export function evidenceRequiresHighBar(severity) {
  const level = String(severity ?? '').toLowerCase();
  return level === 'critical' || level === 'high';
}

/**
 * 生成一个 Finding 的骨架（字段齐全但未验证）。调用方必须显式填证据与复现步骤；
 * 这里**不发明**任何证据。
 */
export function createFindingSkeleton(input = {}) {
  const category = FINDING_CATEGORIES.includes(input.category) ? input.category : 'other';
  const severity = SEVERITIES.includes(String(input.severity ?? '').toLowerCase())
    ? String(input.severity).toLowerCase() : 'medium';
  return {
    kind: 'dsh-ui-testing-finding',
    version: FINDING_VERSION,
    findingId: typeof input.findingId === 'string' && input.findingId !== '' ? input.findingId : null,
    title: typeof input.title === 'string' ? input.title.slice(0, 200) : null,
    category,
    severity,
    severityWeight: severityWeight(severity),
    confidence: typeof input.confidence === 'number' && input.confidence >= 0 && input.confidence <= 1
      ? input.confidence : null,
    status: null,
    targetUrl: typeof input.targetUrl === 'string' ? input.targetUrl : null,
    endpoint: typeof input.endpoint === 'string' ? input.endpoint : null,
    identity: typeof input.identity === 'string' ? input.identity : null,
    preconditions: Array.isArray(input.preconditions) ? input.preconditions.slice(0, 32).map(String) : [],
    reproductionSteps: Array.isArray(input.reproductionSteps) ? input.reproductionSteps.slice(0, 32).map(String) : [],
    evidence: input.evidence && typeof input.evidence === 'object' ? input.evidence : null,
    request: input.request ?? null,
    response: input.response ?? null,
    dom: input.dom ?? null,
    screenshot: input.screenshot ?? null,
    scriptLocation: input.scriptLocation ?? null,
    networkSeq: Number.isInteger(input.networkSeq) ? input.networkSeq : null,
    impact: typeof input.impact === 'string' ? input.impact.slice(0, 2000) : null,
    remediation: typeof input.remediation === 'string' ? input.remediation.slice(0, 2000) : null,
    retest: input.retest ?? null,
    actionId: typeof input.actionId === 'string' ? input.actionId : null,
    createdAt: Date.now(),
    evidenceBasis: typeof input.evidenceBasis === 'string' ? input.evidenceBasis : null,
    reproductions: Number.isInteger(input.reproductions) ? input.reproductions : 0,
    hasContrast: input.hasContrast === true,
    notes: [],
  };
}

/* -----------------------------------------------------------------------------------------------
 * 证据完整率（EVD-02）与 Schema 校验（EVD-01）
 * ---------------------------------------------------------------------------------------------- */

/** 一个字段是否"有实质内容"（null/undefined/空串/空数组都算缺失）。 */
export function fieldPresent(value) {
  if (value === null || value === undefined) return false;
  if (typeof value === 'string') return value.trim() !== '';
  if (Array.isArray(value)) return value.length > 0;
  if (typeof value === 'object') return Object.keys(value).length > 0;
  return true;
}

/**
 * 计算单个 Finding 的完整度：必填字段 + 适用的证据字段。
 * `complete` 要求全部必填字段在场且至少一条请求或响应证据（EVD-03）。
 */
export function gradeFinding(finding) {
  const missing = FINDING_REQUIRED_FIELDS.filter((field) => !fieldPresent(finding?.[field]));
  const hasRequestOrResponse = fieldPresent(finding?.request) || fieldPresent(finding?.response);
  const hasAnyEvidenceRef = FINDING_EVIDENCE_FIELDS.some((field) => fieldPresent(finding?.[field]));
  // UI/source linkage is required only when the category is DOM/UI-shaped (EVD-04).
  const needsUiOrSource = ['xss-dom', 'xss-stored', 'business-logic', 'other'].includes(finding?.category);
  const hasUiOrSource = fieldPresent(finding?.dom) || fieldPresent(finding?.screenshot) || fieldPresent(finding?.scriptLocation);
  const violations = [];
  if (!hasRequestOrResponse) violations.push('no-request-or-response-evidence');
  if (!hasAnyEvidenceRef) violations.push('no-evidence-reference');
  if (needsUiOrSource && !hasUiOrSource) violations.push('missing-ui-or-source-linkage');
  return {
    complete: missing.length === 0 && violations.length === 0,
    missingFields: missing,
    violations,
    hasRequestOrResponse,
    hasUiOrSource,
  };
}

/**
 * 证据完整率（EVD-02）：全部 Finding 的完整比例 + High/Critical 单独比例。
 * `highBarMet` 是硬门槛：High/Critical 必须 100%。
 */
export function evidenceCompleteness(findings) {
  const list = Array.isArray(findings) ? findings : [];
  const graded = list.map((finding) => ({ finding, grade: gradeFinding(finding) }));
  const complete = graded.filter((entry) => entry.grade.complete).length;
  const highCritical = graded.filter((entry) => evidenceRequiresHighBar(entry.finding?.severity));
  const highComplete = highCritical.filter((entry) => entry.grade.complete).length;
  return {
    total: list.length,
    complete,
    rate: list.length === 0 ? null : complete / list.length,
    highCriticalTotal: highCritical.length,
    highCriticalComplete: highComplete,
    highCriticalRate: highCritical.length === 0 ? null : highComplete / highCritical.length,
    highBarMet: highComplete === highCritical.length,
    incomplete: graded.filter((entry) => !entry.grade.complete).map((entry) => ({
      findingId: entry.finding?.findingId ?? null,
      missingFields: entry.grade.missingFields,
      violations: entry.grade.violations,
    })),
  };
}

/* -----------------------------------------------------------------------------------------------
 * VULN-08/09：加权召回率与 Precision
 * ---------------------------------------------------------------------------------------------- */

/**
 * 加权召回率：Σ(已检出的预置项权重) / Σ(全部预置项权重)。
 * `oracle` 是题方答案（每项 {id, severity, weight?}），`detectedIds` 是本次报告命中的 id 集合。
 */
export function weightedRecall(oracle, detectedIds) {
  const items = Array.isArray(oracle) ? oracle : [];
  const detected = new Set(Array.isArray(detectedIds) ? detectedIds.map(String) : []);
  const weightOf = (item) => (Number.isFinite(item?.weight) ? item.weight : severityWeight(item?.severity));
  const totalWeight = items.reduce((sum, item) => sum + weightOf(item), 0);
  const hitWeight = items.filter((item) => detected.has(String(item.id))).reduce((sum, item) => sum + weightOf(item), 0);
  const missed = items.filter((item) => !detected.has(String(item.id)));
  const missedHighCritical = missed.filter((item) => evidenceRequiresHighBar(item.severity));
  return {
    totalItems: items.length,
    totalWeight,
    hitWeight,
    recall: totalWeight === 0 ? null : hitWeight / totalWeight,
    missedIds: missed.map((item) => item.id),
    missedHighCriticalIds: missedHighCritical.map((item) => item.id),
    highCriticalAllFound: missedHighCritical.length === 0,
  };
}

/**
 * Precision = TP / (TP + FP)。`reported` 是本次报告的 Findings，`oracleIds` 是真实预置项集合。
 * 只有 `status !== 'false_positive'` 的报告项参与计数（被验证为误报的项不拖累 Precision，
 * 但也必须显式标 false_positive——这是"正确排除"而非"漏报"）。
 */
export function precision(reported, oracleIds) {
  const truth = new Set(Array.isArray(oracleIds) ? oracleIds.map(String) : []);
  const list = (Array.isArray(reported) ? reported : []).filter((finding) => finding?.status !== 'false_positive');
  const tp = list.filter((finding) => truth.has(String(finding?.matchedOracleId ?? ''))).length;
  const fp = list.length - tp;
  return { reported: list.length, truePositives: tp, falsePositives: fp, precision: list.length === 0 ? null : tp / list.length };
}

/* -----------------------------------------------------------------------------------------------
 * EVD-06：脱敏检查（canary）
 * ---------------------------------------------------------------------------------------------- */

/**
 * 扫描 Finding 集合里是否出现敏感值（已导出 Cookie 的 value 等）。命中即 EVD-06/CRED-08 失败。
 * 只报告命中位置，不回显命中的值本身。
 */
export function scanFindingsForSecrets(findings, sensitiveValues) {
  const needles = (Array.isArray(sensitiveValues) ? sensitiveValues : [])
    .filter((value) => typeof value === 'string' && value.length >= 8);
  const hits = [];
  const walk = (value, path) => {
    if (value === null || value === undefined) return;
    if (typeof value === 'string') {
      for (const needle of needles) {
        if (value.includes(needle)) hits.push({ path, needleLength: needle.length });
      }
      return;
    }
    if (typeof value === 'object') {
      for (const [key, child] of Object.entries(value)) walk(child, path + '.' + key);
    }
  };
  (Array.isArray(findings) ? findings : []).forEach((finding, index) => walk(finding, 'findings[' + index + ']'));
  return { clean: hits.length === 0, hits, scanned: (Array.isArray(findings) ? findings : []).length };
}

/* -----------------------------------------------------------------------------------------------
 * 报告汇总（FR-10）
 * ---------------------------------------------------------------------------------------------- */

/**
 * 生成报告汇总：按严重性分组、状态分组、证据完整率、加权统计与 High/Critical 门槛判定。
 * 不生成 Markdown/HTML——报告渲染由调用方决定；这里只给结构化事实。
 */
export function summarizeFindings(findings) {
  const list = Array.isArray(findings) ? findings : [];
  const bySeverity = {};
  for (const severity of SEVERITIES) bySeverity[severity] = 0;
  const byStatus = {};
  for (const status of FINDING_STATUSES) byStatus[status] = 0;
  for (const finding of list) {
    const severity = String(finding?.severity ?? '').toLowerCase();
    if (severity in bySeverity) bySeverity[severity] += 1;
    const status = String(finding?.status ?? '');
    if (status in byStatus) byStatus[status] += 1;
  }
  const confirmationRate = (() => {
    const nonFalse = list.filter((finding) => finding?.status !== 'false_positive');
    if (nonFalse.length === 0) return null;
    return nonFalse.filter((finding) => finding?.status === 'confirmed').length / nonFalse.length;
  })();
  return {
    total: list.length,
    bySeverity,
    byStatus,
    severityWeightSum: list.reduce((sum, finding) => sum + severityWeight(finding?.severity), 0),
    evidence: evidenceCompleteness(list),
    confirmationRate,
    highCriticalPresent: list.some((finding) => evidenceRequiresHighBar(finding?.severity)),
    confirmedWithoutContrast: list.filter((finding) => finding?.status === 'confirmed' && finding?.hasContrast !== true)
      .map((finding) => finding?.findingId ?? null),
  };
}
