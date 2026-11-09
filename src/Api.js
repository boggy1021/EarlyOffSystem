/**
 * LIFF 小網頁呼叫的 API。每個動作都先驗證 ID token，並在 script lock 內執行，
 * 避免兩個人同時按同意造成重複核准，或核准與凍結互相搶先。
 */

var API_ACTIONS = {
  me: apiMe_,
  apply: apiApply_,
  shareCard: apiShareCard_,
  cancel: apiCancel_,
  view: apiView_,
  agree: apiAgree_,
  report: apiReport_,
  decideView: apiDecideView_,
  decide: apiDecide_,
  bindOptions: apiBindOptions_,
  bind: apiBind_
};

function handleApi_(body) {
  try {
    var fn = API_ACTIONS[body.action];
    if (!fn) throw apiError_('BAD_REQUEST', '未知的動作：' + body.action);
    var who = verifyIdToken_(body.idToken);
    var data = withLock_(function () {
      expireDue_();
      return fn(who, body);
    });
    return { ok: true, data: data };
  } catch (e) {
    if (e.apiCode) return { ok: false, code: e.apiCode, error: e.message };
    console.error(e && e.stack || e);
    return { ok: false, code: 'SERVER', error: '系統錯誤，請稍後再試。（' + e.message + '）' };
  }
}

function withLock_(fn) {
  var lock = LockService.getScriptLock();
  if (!lock.tryLock(20000)) throw apiError_('BUSY', '系統忙碌中，請稍後再試。');
  try {
    return fn();
  } finally {
    lock.releaseLock();
  }
}

/** 把已過失效時間的進行中申請改成已失效。API 與時間觸發器都會呼叫。 */
function expireDue_() {
  var nowMs = Date.now();
  requests_().forEach(function (r) {
    if (shouldExpire(r, nowMs)) {
      saveRequestPatch_(r, { status: STATUS.EXPIRED, closedMs: nowMs, closeBy: CLOSE_BY.TIMEOUT });
    }
  });
}

// ── 共用 ─────────────────────────────────────────────────

function countedVotes_(reqId) {
  return votesFor_(reqId).filter(function (v) { return v.counted; });
}

function hmOf_(ms) {
  return ms ? fmt_(new Date(ms), 'HH:mm') : '';
}

function summary_(req, cfg) {
  return {
    id: req.id, name: req.name, status: req.status, date: req.date,
    start: minToHm(req.start), end: minToHm(req.end),
    createdAt: hmOf_(req.createdMs), expiresAt: hmOf_(req.expiresMs),
    approvedAt: hmOf_(req.approvedMs), closeBy: req.closeBy,
    countedVotes: countedVotes_(req.id).length, threshold: cfg.threshold
  };
}

function myShiftOn_(empId, date) {
  var all = shiftsOn_(date);
  for (var i = 0; i < all.length; i++) if (all[i].empId === empId) return all[i];
  return null;
}

function approvedEmpIdsOn_(date, reqs) {
  return (reqs || requests_())
    .filter(function (r) { return r.date === date && r.status === STATUS.APPROVED; })
    .map(function (r) { return r.empId; });
}

function boundEmpIds_(emps) {
  return emps.filter(function (e) { return e.bindStatus === BIND.OK && e.userId; })
             .map(function (e) { return e.empId; });
}

/** 申請人與同仁都可以使用的資格檢查（同意、通知主管共用）。 */
function colleagueEligibility_(req, emp) {
  return checkColleague({
    request: req,
    voter: myShiftOn_(emp.empId, req.date),
    voterEmpId: emp.empId,
    voterApprovedToday: approvedEmpIdsOn_(req.date).indexOf(emp.empId) >= 0
  });
}

function applyContext_(emp, now, cfg) {
  var emps = employees_();
  var reqs = requests_();
  var today = shiftsOn_(now.date);
  var me = null;
  today.forEach(function (s) { if (s.empId === emp.empId && !me) me = s; });
  var mine = reqs.filter(function (r) { return r.empId === emp.empId && r.date === now.date; });
  var eligible = me ? eligibleColleagues({
    me: me, todayShifts: today, approvedEmpIds: approvedEmpIdsOn_(now.date, reqs), boundEmpIds: boundEmpIds_(emps)
  }) : [];
  var check = checkCanApply({
    now: now, me: me, myRequestsToday: mine, eligibleCount: eligible.length, threshold: cfg.threshold
  });
  return { me: me, mine: mine, eligibleCount: eligible.length, check: check };
}

// ── 申請人 ───────────────────────────────────────────────

function apiMe_(who) {
  var emps = employees_();
  var emp = employeeByUserId_(who.userId, emps);
  if (!emp || emp.bindStatus !== BIND.OK) {
    return { bindStatus: emp ? emp.bindStatus : BIND.NONE, bindName: emp ? emp.name : '' };
  }
  var now = now_(), cfg = settings_();
  var ctx = applyContext_(emp, now, cfg);
  return {
    bindStatus: BIND.OK,
    employee: { empId: emp.empId, name: emp.name, role: emp.role },
    shift: ctx.me ? { start: minToHm(ctx.me.start), end: minToHm(ctx.me.end) } : null,
    canApply: ctx.check,
    eligibleCount: ctx.eligibleCount,
    threshold: cfg.threshold, timeoutMin: cfg.timeoutMin, groupName: cfg.groupName,
    requests: ctx.mine.slice().reverse().map(function (r) { return summary_(r, cfg); })
  };
}

function apiApply_(who) {
  var emp = requireEmployee_(who.userId);
  var now = now_(), cfg = settings_();
  var ctx = applyContext_(emp, now, cfg);
  if (!ctx.check.ok) throw apiError_('DENIED', ctx.check.reason);
  var me = ctx.me;
  var req = {
    id: 'R' + fmt_(new Date(now.ms), 'yyyyMMdd-HHmmss') + '-' + emp.empId,
    empId: emp.empId, name: emp.name, date: now.date,
    start: me.start, end: me.end, baseStart: me.baseStart, baseEnd: me.baseEnd,
    createdMs: now.ms,
    expiresMs: computeExpiry(now.ms, cfg.timeoutMin, dateMinToMs_(now.date, me.end)),
    status: STATUS.PENDING
  };
  append_(TABLES.REQ, {
    id: req.id, empId: req.empId, name: req.name, date: req.date,
    start: minToHm(req.start), end: minToHm(req.end),
    baseStart: minToHm(req.baseStart), baseEnd: minToHm(req.baseEnd),
    createdAt: req.createdMs, expiresAt: req.expiresMs, status: req.status
  });
  return { request: summary_(req, cfg), flex: shareCard_(req, cfg), groupName: cfg.groupName };
}

function ownActiveRequest_(who, id) {
  var emp = requireEmployee_(who.userId);
  var req = findRequest_(id);
  if (req.empId !== emp.empId) throw apiError_('DENIED', '這不是您的申請。');
  return req;
}

function apiShareCard_(who, body) {
  var req = ownActiveRequest_(who, body.id);
  if (!isActiveStatus(req.status)) throw apiError_('DENIED', '這筆申請已經' + req.status + '。');
  var cfg = settings_();
  return { flex: shareCard_(req, cfg), groupName: cfg.groupName };
}

function apiCancel_(who, body) {
  var req = ownActiveRequest_(who, body.id);
  var chk = checkCanCancel(req);
  if (!chk.ok) throw apiError_('DENIED', chk.reason);
  saveRequestPatch_(req, { status: STATUS.CANCELLED, closedMs: Date.now(), closeBy: CLOSE_BY.CANCEL });
  return { request: summary_(req, settings_()) };
}

// ── 同仁 ─────────────────────────────────────────────────

function apiView_(who, body) {
  var emp = requireEmployee_(who.userId);
  var req = findRequest_(body.id);
  var cfg = settings_();
  var elig = colleagueEligibility_(req, emp);
  var mineCounted = countedVotes_(req.id).some(function (v) { return v.voterEmpId === emp.empId; });
  var report = checkCanReport(req, elig, now_());
  return {
    request: summary_(req, cfg),
    iAmApplicant: req.empId === emp.empId,
    eligibility: elig,
    alreadyAgreed: mineCounted,
    canReport: report
  };
}

function apiAgree_(who, body) {
  var emp = requireEmployee_(who.userId);
  var req = findRequest_(body.id);
  var cfg = settings_();
  var elig = colleagueEligibility_(req, emp);
  var res = evaluateVote({
    request: req, eligibility: elig, existingVotes: votesFor_(req.id),
    voterEmpId: emp.empId, threshold: cfg.threshold
  });
  var nowMs = Date.now();
  append_(TABLES.VOTE, {
    reqId: req.id, voterEmpId: emp.empId, voterName: emp.name, at: nowMs,
    counted: res.counted, reason: res.counted ? '' : res.reason
  });
  if (res.approve) {
    saveRequestPatch_(req, { status: STATUS.APPROVED, approvedMs: nowMs, closedMs: nowMs, closeBy: CLOSE_BY.VOTES });
    var applicant = findEmployee_(req.empId);
    push_(applicant && applicant.userId, [textMsg_(
      '✅ 您的提前下班申請已核准（' + hmOf_(nowMs) + '），可以下班了。\n正式下班時間仍以打卡為準。')]);
  }
  return { counted: res.counted, reason: res.reason, request: summary_(req, cfg) };
}

function apiReport_(who, body) {
  var emp = requireEmployee_(who.userId);
  var req = findRequest_(body.id);
  var elig = colleagueEligibility_(req, emp);
  var chk = checkCanReport(req, elig, now_());
  if (!chk.ok) throw apiError_('DENIED', chk.reason);
  var reason = String(body.reason || '').trim().slice(0, 200);
  append_(TABLES.REPORT, {
    reqId: req.id, reporterEmpId: emp.empId, reporterName: emp.name, at: Date.now(), reason: reason
  });
  if (chk.freeze) {
    saveRequestPatch_(req, { status: STATUS.SUPERVISOR, closedMs: null, closeBy: '' });
    notifySupervisors_(req);
  }
  return { request: summary_(req, settings_()) };
}

function notifySupervisors_(req) {
  var sups = employees_().filter(function (e) {
    return e.role === ROLE.SUPERVISOR && e.bindStatus === BIND.OK && e.userId;
  });
  if (!sups.length) console.warn('沒有已綁定的主管可以通知：' + req.id);
  var card = supervisorCard_(req, countedVotes_(req.id).length, reportsFor_(req.id));
  sups.forEach(function (s) { push_(s.userId, [card]); });
}

function findEmployee_(empId) {
  var emps = employees_();
  for (var i = 0; i < emps.length; i++) if (emps[i].empId === empId) return emps[i];
  return null;
}

// ── 主管 ─────────────────────────────────────────────────

function requireSupervisor_(who) {
  var emp = requireEmployee_(who.userId);
  if (emp.role !== ROLE.SUPERVISOR) throw apiError_('DENIED', '只有主管可以查看。');
  return emp;
}

function apiDecideView_(who, body) {
  requireSupervisor_(who);
  var req = findRequest_(body.id);
  var reports = reportsFor_(req.id);
  var decided = reports.filter(function (r) { return r.decision; })[0];
  var decider = decided ? findEmployee_(decided.supervisorEmpId) : null;
  return {
    request: summary_(req, settings_()),
    reports: reports.map(function (r) {
      return { name: r.reporterName, reason: r.reason, at: hmOf_(r.at) };
    }),
    voters: countedVotes_(req.id).map(function (v) { return v.voterName; }),
    canDecide: checkCanDecide(req),
    decided: decided ? { decision: decided.decision, by: decider ? decider.name : '', at: hmOf_(decided.decidedAt) } : null
  };
}

function apiDecide_(who, body) {
  var sup = requireSupervisor_(who);
  var req = findRequest_(body.id);
  var chk = checkCanDecide(req);
  if (!chk.ok) throw apiError_('DENIED', chk.reason);
  var ok = body.approve === true, nowMs = Date.now();
  saveRequestPatch_(req, ok
    ? { status: STATUS.APPROVED, approvedMs: nowMs, closedMs: nowMs, closeBy: CLOSE_BY.SUPERVISOR_OK }
    : { status: STATUS.REJECTED, closedMs: nowMs, closeBy: CLOSE_BY.SUPERVISOR_NO });
  reportsFor_(req.id).forEach(function (r) {
    if (!r.decision) {
      update_(TABLES.REPORT, r._row, {
        supervisorEmpId: sup.empId, decision: ok ? DECISION.OK : DECISION.NO, decidedAt: nowMs
      });
    }
  });
  var applicant = findEmployee_(req.empId);
  push_(applicant && applicant.userId, [textMsg_(ok
    ? '✅ 主管已核准您的提前下班申請（' + hmOf_(nowMs) + '），可以下班了。\n正式下班時間仍以打卡為準。'
    : '主管這次沒有核准您的提前下班申請，請依表定時間下班。')]);
  return { request: summary_(req, settings_()) };
}

// ── 綁定 ─────────────────────────────────────────────────

function apiBindOptions_(who) {
  var emps = employees_();
  var emp = employeeByUserId_(who.userId, emps);
  return {
    bindStatus: emp ? emp.bindStatus : BIND.NONE,
    bindName: emp ? emp.name : '',
    options: emps.filter(function (e) { return !e.userId; })
                 .map(function (e) { return { empId: e.empId, name: e.name }; })
  };
}

function apiBind_(who, body) {
  var emps = employees_();
  var current = employeeByUserId_(who.userId, emps);
  if (current && current.bindStatus === BIND.OK) {
    throw apiError_('DENIED', '您已經綁定為「' + current.name + '」。如需更改請洽管理者。');
  }
  var key = normName(body.empIdOrName);
  var target = null;
  emps.forEach(function (e) {
    if (target) return;
    var names = [e.name].concat(String(e.aliases || '').split(/[,，、]/)).map(normName).filter(Boolean);
    if (e.empId === key || names.indexOf(key) >= 0) target = e;
  });
  if (!target) throw apiError_('DENIED', '找不到這位員工，請確認員工編號或姓名。');
  if (target.userId && target.userId !== who.userId) {
    throw apiError_('DENIED', '「' + target.name + '」已經被綁定，如有錯誤請洽管理者。');
  }
  // 待確認期間選錯人，可以改選：先清掉原本那一列
  if (current && current._row !== target._row) {
    update_(TABLES.EMP, current._row, { userId: '', lineName: '', bindStatus: BIND.NONE, bindAt: null });
  }
  update_(TABLES.EMP, target._row, {
    userId: who.userId, lineName: who.lineName, bindStatus: BIND.PENDING, bindAt: Date.now()
  });
  return { bindStatus: BIND.PENDING, bindName: target.name };
}
