/**
 * 申請規則：資格判斷與狀態流轉。純函式，不碰 Apps Script 服務，可以在 Node 測試。
 *
 * 時間慣例：now = {date: 'yyyy-MM-dd', min: 當天分鐘數, ms: epoch 毫秒}。
 * 班表列 shift = {empId, date, start, end, baseStart, baseEnd}（分鐘），沒排班為 null。
 */

var STATUS = {
  PENDING: '進行中',
  SUPERVISOR: '待主管決定',
  APPROVED: '已核准',
  REJECTED: '已駁回',
  EXPIRED: '已失效',
  CANCELLED: '已取消'
};

var CLOSE_BY = {
  VOTES: '同仁同意',
  SUPERVISOR_OK: '主管核准',
  SUPERVISOR_NO: '主管不准',
  TIMEOUT: '逾時',
  CANCEL: '申請人取消'
};

function isActiveStatus(s) {
  return s === STATUS.PENDING || s === STATUS.SUPERVISOR;
}

function isWorking(shift) {
  return !!shift && shift.start !== null && shift.start !== undefined && shift.start !== '' &&
         shift.end !== null && shift.end !== undefined && shift.end !== '';
}

function sameShift(a, b) {
  return isWorking(a) && isWorking(b) &&
         shiftKeyOf(a.baseStart, a.baseEnd) === shiftKeyOf(b.baseStart, b.baseEnd);
}

/**
 * 同班中「現在可以同意」的同仁編號：同一班、不是本人、今天沒有已核准的提前下班、已完成綁定。
 * ctx: {me: shift, todayShifts: [shift], approvedEmpIds: [id], boundEmpIds: [id]}
 */
function eligibleColleagues(ctx) {
  return ctx.todayShifts.filter(function (s) {
    return s.empId !== ctx.me.empId &&
           sameShift(s, ctx.me) &&
           ctx.approvedEmpIds.indexOf(s.empId) < 0 &&
           ctx.boundEmpIds.indexOf(s.empId) >= 0;
  }).map(function (s) { return s.empId; });
}

/**
 * 能不能送出申請。
 * ctx: {now, me: shift|null, myRequestsToday: [request], eligibleCount, threshold}
 * 回傳 {ok: true} 或 {ok: false, reason}
 */
function checkCanApply(ctx) {
  var me = ctx.me;
  if (!isWorking(me)) return { ok: false, reason: '您今天沒有排班，無法申請。' };
  if (ctx.now.min < me.start) {
    return { ok: false, reason: '還沒到您的上班時間（' + minToHm(me.start) + '），無法申請。' };
  }
  if (ctx.now.min >= me.end) {
    return { ok: false, reason: '已過您的表定下班時間（' + minToHm(me.end) + '），不需要申請。' };
  }
  var mine = ctx.myRequestsToday || [];
  for (var i = 0; i < mine.length; i++) {
    if (isActiveStatus(mine[i].status)) return { ok: false, reason: '您已經有一筆進行中的申請。' };
    if (mine[i].status === STATUS.APPROVED) return { ok: false, reason: '您今天的申請已經核准了。' };
  }
  if (ctx.eligibleCount < ctx.threshold) {
    return {
      ok: false,
      reason: '同一班目前可以同意的同仁只有 ' + ctx.eligibleCount + ' 位，未達 ' + ctx.threshold +
              ' 人門檻，請直接詢問主管。'
    };
  }
  return { ok: true };
}

/** 申請的失效時間：申請時間 + 逾時分鐘，但不晚於表定下班時間。 */
function computeExpiry(createdMs, timeoutMin, shiftEndMs) {
  return Math.min(createdMs + timeoutMin * 60000, shiftEndMs);
}

/**
 * 某人點「同意」或「通知主管」時，是否有資格。
 * ctx: {request, voter: shift|null, voterEmpId, voterApprovedToday: bool}
 * request 需有 empId, baseStart, baseEnd。
 * 回傳 {ok: true} 或 {ok: false, reason}
 */
function checkColleague(ctx) {
  var r = ctx.request;
  if (ctx.voterEmpId === r.empId) return { ok: false, reason: '您是申請人本人，無法操作。' };
  if (!isWorking(ctx.voter)) return { ok: false, reason: '您今天休假或沒有排班，無法操作。' };
  if (!sameShift(ctx.voter, { start: r.start, end: r.end, baseStart: r.baseStart, baseEnd: r.baseEnd })) {
    return { ok: false, reason: '您今天不在這一班，無法操作。' };
  }
  if (ctx.voterApprovedToday) return { ok: false, reason: '您今天已核准提前下班，無法操作。' };
  return { ok: true };
}

/**
 * 記一票同意。
 * ctx: {request, eligibility: checkColleague 結果, existingVotes: [vote], voterEmpId, threshold}
 * vote = {voterEmpId, counted: bool}
 * 回傳 {counted, reason, countedTotal, approve: bool}
 */
function evaluateVote(ctx) {
  var r = ctx.request;
  var countedBefore = ctx.existingVotes.filter(function (v) { return v.counted; });
  var res = { counted: false, reason: '', countedTotal: countedBefore.length, approve: false };
  if (!isActiveStatus(r.status)) {
    res.reason = '這筆申請已經' + r.status + '。';
    return res;
  }
  if (!ctx.eligibility.ok) {
    res.reason = ctx.eligibility.reason;
    return res;
  }
  var dup = countedBefore.some(function (v) { return v.voterEmpId === ctx.voterEmpId; });
  if (dup) {
    res.reason = '您已經同意過了。';
    return res;
  }
  res.counted = true;
  res.countedTotal = countedBefore.length + 1;
  // 待主管決定時，同意照樣記錄，但不會觸發核准
  res.approve = r.status === STATUS.PENDING && res.countedTotal >= ctx.threshold;
  return res;
}

/**
 * 能不能「通知主管」。進行中、待主管決定（追加通報）可以；
 * 已核准且還沒到表定下班、且不是主管決定的結果，也可以。
 * 回傳 {ok, reason, freeze: bool（是否要改成待主管決定並推播主管）}
 */
function checkCanReport(request, eligibility, now) {
  if (!eligibility.ok) return { ok: false, reason: eligibility.reason, freeze: false };
  var s = request.status;
  if (s === STATUS.PENDING) return { ok: true, freeze: true };
  if (s === STATUS.SUPERVISOR) return { ok: true, freeze: false };
  if (s === STATUS.APPROVED) {
    if (request.closeBy === CLOSE_BY.SUPERVISOR_OK) {
      return { ok: false, reason: '這筆申請已經由主管核准。', freeze: false };
    }
    if (now.date !== request.date || now.min >= request.end) {
      return { ok: false, reason: '已過申請人的表定下班時間。', freeze: false };
    }
    return { ok: true, freeze: true };
  }
  return { ok: false, reason: '這筆申請已經' + s + '。', freeze: false };
}

/** 進行中且已過失效時間 → 應改成已失效。 */
function shouldExpire(request, nowMs) {
  return request.status === STATUS.PENDING && nowMs >= request.expiresMs;
}

/** 主管能不能做決定。 */
function checkCanDecide(request) {
  if (request.status !== STATUS.SUPERVISOR) {
    return { ok: false, reason: '這筆申請目前是「' + request.status + '」，不需要決定。' };
  }
  return { ok: true };
}

/** 申請人能不能取消。 */
function checkCanCancel(request) {
  if (!isActiveStatus(request.status)) {
    return { ok: false, reason: '這筆申請已經' + request.status + '，無法取消。' };
  }
  return { ok: true };
}
