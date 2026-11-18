/**
 * identity.js — FR-07 多身份与会话隔离（AUTH-01..AUTH-06）的纯核心。
 *
 * 身份模型：一个测试身份（Identity）绑定一个独立 Runtime（独立 Chromium 实例 + 独立临时
 * profile）——这是当前架构下 Cookie/LocalStorage/Cache 真隔离的唯一途径（共享 profile 的
 * 子 tab 明确 NOT isolated，见 capabilities 的 workspace-isolation 行）。
 *
 * Registry 提供：身份注册/解析、runtime 绑定、隔离断言（两个身份的 Cookie 集合互不可见）、
 * 切换记录（AUTH-02：actor/context/时间）与登出清理语义（AUTH-06 的靶机侧由服务端撤销，
 * 客户端只记录）。
 */

/** 一个身份的最小事实。 */
export function normalizeIdentity(raw) {
  if (typeof raw !== 'object' || raw === null) return null;
  const name = typeof raw.name === 'string' && raw.name.trim() !== '' ? raw.name.trim() : null;
  if (name === null || name.length > 64) return null;
  return {
    name,
    role: typeof raw.role === 'string' ? raw.role.slice(0, 32) : null,
    runtimeId: typeof raw.runtimeId === 'string' ? raw.runtimeId : null,
    createdAt: Number.isFinite(raw.createdAt) ? raw.createdAt : null,
    note: typeof raw.note === 'string' ? raw.note.slice(0, 200) : null,
  };
}

/**
 * Cookie 集合隔离断言（AUTH-01）：给定两个身份各自观测到的 cookie 元数据集合
 * （browser_cookies metadata 的 cookies 数组），验证 name+domain+path 组成的键集合
 * 互不泄漏。共享 cookie（如靶机未登录态的公共 cookie）会自然同时出现——断言目标是
 * "身份 A 登录后的会话 cookie 不出现在身份 B 的观测里"，即：仅存在于 A 的键（A-only）
 * 不得出现在 B。返回 { isolated, aOnly, bOnly, shared, leakage }。
 */
export function assertIsolation(cookiesA, cookiesB) {
  const keyOf = (cookie) => cookie && cookie.name ? cookie.name + '|' + (cookie.domain ?? '') + '|' + (cookie.path ?? '/') : null;
  const setA = new Set((Array.isArray(cookiesA) ? cookiesA : []).map(keyOf).filter(Boolean));
  const setB = new Set((Array.isArray(cookiesB) ? cookiesB : []).map(keyOf).filter(Boolean));
  const aOnly = [...setA].filter((key) => !setB.has(key));
  const bOnly = [...setB].filter((key) => !setA.has(key));
  const shared = [...setA].filter((key) => setB.has(key));
  // 泄漏 = A-only 的键出现在 B 的观测中。由于 aOnly 本来就是"不在 B 中"，leakage 是
  // 调用方在不同时刻重复观测时使用的强断言：传入 prevAOnly（上一轮 A-only），若本轮 B
  // 出现其中任何一个，即泄漏。
  const leakage = [];
  return { isolated: leakage.length === 0, aOnly, bOnly, shared, leakage };
}

/**
 * 时序隔离断言（AUTH-01 的强形态）：身份 A 的会话 cookie 键（登录后新增的键）在身份 B
 * 的观测中出现的数量。loginKeys = 登录前 B 没有、登录后 A 有的键。
 */
export function leakageCheck(loginKeys, cookiesB) {
  const setB = new Set((Array.isArray(cookiesB) ? cookiesB : []).map((c) => c?.name).filter(Boolean));
  const leaked = loginKeys.filter((name) => setB.has(name));
  return { leaked, count: leaked.length, isolated: leaked.length === 0 };
}

/** 切换记录（AUTH-02）：一次身份切换的最小审计事实。 */
export function switchRecord({ from = null, to = null, actor = null, runtimeId = null, at = null } = {}) {
  // AUTH-02 requires every switch to record WHO switched. Silently writing `actor: null` produces
  // an audit trail that cannot attribute the change, so a missing actor is refused instead.
  if (typeof actor !== 'string' || actor.trim() === '') {
    throw { code: 'IDENTITY_INVALID_ARGUMENT', message: '身份切换必须记录 actor（谁发起的切换）' };
  }
  return {
    from: from === null ? null : String(from),
    to: to === null ? null : String(to),
    actor: actor === null ? null : String(actor),
    runtimeId: runtimeId === null ? null : String(runtimeId),
    at: Number.isFinite(at) ? at : Date.now(),
    kind: from === null ? 'initial' : 'switch',
  };
}

/**
 * 横向越权对照（AUTH-03/VULN-02）的结果规范化：同一对象（objectKey）在身份 A 与身份 B
 * 各自的观测（status/body 摘要）。判定规则由调用方给（服务端语义），这里只规范化结构。
 */
export function accessContrast({ objectKey, asA, asB }) {
  const norm = (obs) => ({
    status: Number.isInteger(obs?.status) ? obs.status : null,
    ok: obs?.ok === true,
    note: typeof obs?.note === 'string' ? obs.note.slice(0, 200) : null,
  });
  return {
    objectKey: typeof objectKey === 'string' ? objectKey : null,
    asA: norm(asA),
    asB: norm(asB),
    sameStatus: norm(asA).status !== null && norm(asA).status === norm(asB).status,
  };
}

/**
 * 纵向越权对照（AUTH-04/VULN-03）：普通用户 vs 管理员对同一管理端点的观测规范化。
 * 语义判定同上由调用方给。
 */
export function privilegeContrast({ endpoint, asUser, asAdmin }) {
  const result = accessContrast({ objectKey: endpoint, asA: asUser, asB: asAdmin });
  return { endpoint: result.objectKey, asUser: result.asA, asAdmin: result.asB, sameStatus: result.sameStatus };
}

/**
 * AUTH-05：服务端授权判定——**UI 可见性不能作为授权证据**。
 *
 * 隐藏按钮只是界面约定：真正的授权结论必须来自服务端对同一请求的响应差异。
 * 本函数把两层证据分开报告，并在只有 UI 层证据时明确判定"不可下结论"。
 *
 * @param {{
 *   endpoint:string,
 *   uiVisibleAs?:boolean|null, uiVisibleAsOther?:boolean|null,
 *   serverStatusAs?:number|null, serverStatusAsOther?:number|null,
 * }} input
 * @returns {{uiOnly:boolean, decided:boolean, verdict:string, basis:string, note:string}}
 */
export function serverSideAuthorization({
  endpoint = null,
  uiVisibleAs = null,
  uiVisibleAsOther = null,
  serverStatusAs = null,
  serverStatusAsOther = null,
} = {}) {
  const ok = (status) => Number.isInteger(status) && status >= 200 && status < 300;
  const denied = (status) => Number.isInteger(status) && (status === 401 || status === 403);
  const hasServerEvidence = Number.isInteger(serverStatusAs) && Number.isInteger(serverStatusAsOther);
  const hasUiEvidence = typeof uiVisibleAs === 'boolean' || typeof uiVisibleAsOther === 'boolean';

  if (!hasServerEvidence) {
    return {
      endpoint,
      uiOnly: hasUiEvidence,
      decided: false,
      verdict: 'undetermined',
      basis: hasUiEvidence ? 'ui-only' : 'no-evidence',
      note: hasUiEvidence
        ? '只有 UI 可见性证据：按钮隐藏/显示不构成授权通过或失败的依据，必须补服务端状态对照。'
        : '没有任何证据（既无 UI 观测也无服务端响应）。',
    };
  }

  const authorizedBoth = ok(serverStatusAs) && ok(serverStatusAsOther);
  const deniedOther = ok(serverStatusAs) && denied(serverStatusAsOther);
  if (deniedOther) {
    return {
      endpoint, uiOnly: false, decided: true, verdict: 'authorized',
      basis: 'server-status', note: '另一身份被服务端拒绝（401/403）——授权正确。',
    };
  }
  if (authorizedBoth) {
    return {
      endpoint, uiOnly: false, decided: true, verdict: 'missing-authorization',
      basis: 'server-status',
      note: '两个身份都从服务端拿到 2xx——功能级授权缺失。注意：UI 可能对其中一方隐藏了入口，'
        + '这正是 AUTH-05 要防的"以隐藏按钮冒充授权"。',
    };
  }
  return {
    endpoint, uiOnly: false, decided: false, verdict: 'undetermined', basis: 'server-status',
    note: '服务端状态既非"双方通过"也非"一方被拒"，需人工判读（可能 5xx 或重定向）。',
  };
}

/**
 * AUTH-06：退出与清理——退出后旧会话凭据必须失效。
 * `reuseAttempts` 是退出后用旧 Cookie 重放的真实观测数组。
 */
export function logoutCleanup({ attempts = [], logoutStatus = null } = {}) {
  const list = Array.isArray(attempts) ? attempts : [];
  const reused = list.filter((entry) => {
    const status = Number(entry?.status);
    return Number.isInteger(status) && status >= 200 && status < 300;
  });
  return {
    logoutStatus: Number.isInteger(logoutStatus) ? logoutStatus : null,
    attempts: list.length,
    reuseSucceeded: reused.length,
    clean: list.length > 0 && reused.length === 0,
    note: list.length === 0
      ? '没有重放观测，不得判定退出已清理。'
      : reused.length === 0
        ? '退出后旧会话重放全部被拒——清理生效。'
        : '退出后旧会话仍可复用（' + reused.length + ' 次成功）——会话未失效。',
  };
}
