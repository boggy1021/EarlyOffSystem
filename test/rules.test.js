const test = require('node:test');
const assert = require('node:assert/strict');
const { loadGas } = require('./load');

const g = loadGas();
const S = g.STATUS;
const H = (s) => g.hmToMin(s);

function shift(empId, code, date = '2026-11-10') {
  const p = g.parseCode(code, date);
  return { empId, date, start: p.start, end: p.end, baseStart: p.baseStart, baseEnd: p.baseEnd };
}
const now = (hhmm, date = '2026-11-10') => ({ date, min: H(hhmm), ms: 0 });

// 今天：A、B、C、D 是 7-5（D 是 ▲ 開門），E 是 7-3，F 休假
const today = [
  shift('A', '7-5'), shift('B', '7-5'), shift('C', '7-5'), shift('D', '▲\n7-5'),
  shift('E', '7-3'), shift('F', 'off'),
];
const bound = ['A', 'B', 'C', 'D', 'E', 'F'];

test('可同意的同仁：同班、非本人、未核准、已綁定；▲ 開門班算同一班', () => {
  const ids = g.eligibleColleagues({ me: today[0], todayShifts: today, approvedEmpIds: ['C'], boundEmpIds: bound });
  assert.deepEqual([...ids], ['B', 'D']);
  const ids2 = g.eligibleColleagues({ me: today[0], todayShifts: today, approvedEmpIds: [], boundEmpIds: ['A', 'B'] });
  assert.deepEqual([...ids2], ['B']);
});

test('申請時段與重複申請', () => {
  const base = { me: today[0], myRequestsToday: [], eligibleCount: 3, threshold: 2 };
  assert.equal(g.checkCanApply({ ...base, now: now('06:40') }).ok, false);
  assert.equal(g.checkCanApply({ ...base, now: now('06:50') }).ok, true);
  assert.equal(g.checkCanApply({ ...base, now: now('16:50') }).ok, false);
  assert.equal(g.checkCanApply({ ...base, now: now('15:00'), me: today[5] }).ok, false);
  assert.equal(g.checkCanApply({ ...base, now: now('15:00'), me: null }).ok, false);
  assert.equal(g.checkCanApply({ ...base, now: now('15:00'), myRequestsToday: [{ status: S.PENDING }] }).ok, false);
  assert.equal(g.checkCanApply({ ...base, now: now('15:00'), myRequestsToday: [{ status: S.SUPERVISOR }] }).ok, false);
  assert.equal(g.checkCanApply({ ...base, now: now('15:00'), myRequestsToday: [{ status: S.APPROVED }] }).ok, false);
  assert.equal(g.checkCanApply({ ...base, now: now('15:00'), myRequestsToday: [{ status: S.EXPIRED }] }).ok, true);
  const few = g.checkCanApply({ ...base, now: now('15:00'), eligibleCount: 1 });
  assert.equal(few.ok, false);
  assert.match(few.reason, /只有 1 位/);
});

test('失效時間不晚於表定下班', () => {
  assert.equal(g.computeExpiry(0, 30, 10 * 60000), 10 * 60000);
  assert.equal(g.computeExpiry(0, 30, 60 * 60000), 30 * 60000);
});

const req = (status = S.PENDING, extra = {}) => ({ empId: 'A', date: '2026-11-10', status, ...today[0], ...extra, empId: 'A' });

test('誰的同意算數', () => {
  const r = req();
  const chk = (voterEmpId, voter, approved = false) =>
    g.checkColleague({ request: r, voter, voterEmpId, voterApprovedToday: approved });
  assert.match(chk('A', today[0]).reason, /本人/);
  assert.match(chk('F', today[5]).reason, /休假/);
  assert.match(chk('X', null).reason, /休假/);
  assert.match(chk('E', today[4]).reason, /不在這一班/);
  assert.match(chk('C', today[2], true).reason, /已核准/);
  assert.equal(chk('B', today[1]).ok, true);
  assert.equal(chk('D', today[3]).ok, true);
});

test('滿 2 票核准；重複點不計', () => {
  const ok = { ok: true };
  let v = g.evaluateVote({ request: req(), eligibility: ok, existingVotes: [], voterEmpId: 'B', threshold: 2 });
  assert.deepEqual([v.counted, v.countedTotal, v.approve], [true, 1, false]);
  const votes = [{ voterEmpId: 'B', counted: true }];
  v = g.evaluateVote({ request: req(), eligibility: ok, existingVotes: votes, voterEmpId: 'B', threshold: 2 });
  assert.deepEqual([v.counted, v.countedTotal, v.approve], [false, 1, false]);
  assert.match(v.reason, /已經同意過/);
  v = g.evaluateVote({ request: req(), eligibility: ok, existingVotes: votes, voterEmpId: 'C', threshold: 2 });
  assert.deepEqual([v.counted, v.countedTotal, v.approve], [true, 2, true]);
});

test('不算數的人：記錄但不計入', () => {
  const v = g.evaluateVote({ request: req(), eligibility: { ok: false, reason: '您今天不在這一班，無法操作。' },
    existingVotes: [], voterEmpId: 'E', threshold: 2 });
  assert.equal(v.counted, false);
  assert.match(v.reason, /不在這一班/);
});

test('待主管決定：同意照記，但不觸發核准', () => {
  const v = g.evaluateVote({ request: req(S.SUPERVISOR), eligibility: { ok: true },
    existingVotes: [{ voterEmpId: 'B', counted: true }], voterEmpId: 'C', threshold: 2 });
  assert.deepEqual([v.counted, v.countedTotal, v.approve], [true, 2, false]);
});

test('已結案的申請不再記票', () => {
  for (const s of [S.APPROVED, S.REJECTED, S.EXPIRED, S.CANCELLED]) {
    const v = g.evaluateVote({ request: req(s), eligibility: { ok: true }, existingVotes: [], voterEmpId: 'B', threshold: 2 });
    assert.equal(v.counted, false, s);
  }
});

test('通知主管', () => {
  const ok = { ok: true };
  assert.deepEqual({ ...g.checkCanReport(req(), ok, now('15:00')) }, { ok: true, freeze: true });
  assert.deepEqual({ ...g.checkCanReport(req(S.SUPERVISOR), ok, now('15:00')) }, { ok: true, freeze: false });
  // 已核准、還沒到表定下班 → 改由主管決定
  assert.equal(g.checkCanReport(req(S.APPROVED, { closeBy: g.CLOSE_BY.VOTES }), ok, now('15:00')).freeze, true);
  assert.equal(g.checkCanReport(req(S.APPROVED, { closeBy: g.CLOSE_BY.VOTES }), ok, now('16:50')).ok, false);
  assert.equal(g.checkCanReport(req(S.APPROVED, { closeBy: g.CLOSE_BY.VOTES }), ok, now('09:00', '2026-11-11')).ok, false);
  assert.equal(g.checkCanReport(req(S.APPROVED, { closeBy: g.CLOSE_BY.SUPERVISOR_OK }), ok, now('15:00')).ok, false);
  assert.equal(g.checkCanReport(req(S.EXPIRED), ok, now('15:00')).ok, false);
  assert.equal(g.checkCanReport(req(), { ok: false, reason: 'x' }, now('15:00')).ok, false);
});

test('逾時、取消、主管決定', () => {
  assert.equal(g.shouldExpire({ status: S.PENDING, expiresMs: 100 }, 100), true);
  assert.equal(g.shouldExpire({ status: S.PENDING, expiresMs: 100 }, 99), false);
  assert.equal(g.shouldExpire({ status: S.SUPERVISOR, expiresMs: 100 }, 200), false);
  assert.equal(g.checkCanCancel({ status: S.PENDING }).ok, true);
  assert.equal(g.checkCanCancel({ status: S.SUPERVISOR }).ok, true);
  assert.equal(g.checkCanCancel({ status: S.APPROVED }).ok, false);
  assert.equal(g.checkCanDecide({ status: S.SUPERVISOR }).ok, true);
  assert.equal(g.checkCanDecide({ status: S.PENDING }).ok, false);
});
