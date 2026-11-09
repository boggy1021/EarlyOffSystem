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

test('可同意的同仁：申請有效期間內有上班、非本人、未核准、已綁定（不限班別）', () => {
  const win = (from, to) => ({ fromMin: H(from), toMin: H(to) });
  // 15:00–15:30：B、C、D（7-5）在班；E（7-3）14:50 已下班；F 休假
  let ids = g.eligibleColleagues({ me: today[0], ...win('15:00', '15:30'), todayShifts: today, approvedEmpIds: ['C'], boundEmpIds: bound });
  assert.deepEqual([...ids], ['B', 'D']);
  ids = g.eligibleColleagues({ me: today[0], ...win('15:00', '15:30'), todayShifts: today, approvedEmpIds: [], boundEmpIds: ['A', 'B'] });
  assert.deepEqual([...ids], ['B']);
  // 14:30–15:00：7-3 的 E 還在班，也算
  ids = g.eligibleColleagues({ me: today[0], ...win('14:30', '15:00'), todayShifts: today, approvedEmpIds: [], boundEmpIds: bound });
  assert.deepEqual([...ids], ['B', 'C', 'D', 'E']);
});

test('只有一位 7-5：和 E 班重疊的時段，E 班同仁可以同意', () => {
  const day = [shift('A', '7-5'), shift('N1', 'E'), shift('N2', 'E'), shift('M', "10'-7'")];
  const ctx = (from, to) => ({ me: day[0], fromMin: H(from), toMin: H(to), todayShifts: day,
    approvedEmpIds: [], boundEmpIds: ['A', 'N1', 'N2', 'M'] });
  assert.deepEqual([...g.eligibleColleagues(ctx('15:00', '15:30'))], ['N1', 'N2', 'M']);
  // 14:00 申請、14:30 失效：E 班 14:30 才上班，不算（[from, to) 不含 14:30）
  assert.deepEqual([...g.eligibleColleagues(ctx('14:00', '14:30'))], ['M']);
  // 14:10 申請、14:40 失效：E 班會在有效期間內上班，算
  assert.deepEqual([...g.eligibleColleagues(ctx('14:10', '14:40'))], ['N1', 'N2', 'M']);
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

test('誰的同意算數：按下的那一刻正在上班', () => {
  const r = req();
  const chk = (voterEmpId, voter, at, approved = false, date) =>
    g.checkColleague({ request: r, voter, voterEmpId, voterApprovedToday: approved, now: now(at, date) });
  assert.match(chk('A', today[0], '15:00').reason, /本人/);
  assert.match(chk('F', today[5], '15:00').reason, /休假/);
  assert.match(chk('X', null, '15:00').reason, /休假/);
  assert.match(chk('E', today[4], '15:00').reason, /已過下班時間（14:50）/);   // 7-3 已下班
  assert.equal(chk('E', today[4], '14:40').ok, true);                          // 7-3 還在班：不同班別也算
  assert.match(chk('C', today[2], '15:00', true).reason, /已核准/);
  assert.equal(chk('B', today[1], '15:00').ok, true);
  assert.equal(chk('D', today[3], '15:00').ok, true);
  assert.equal(chk('D', today[3], '16:45').ok, false);                         // ▲ 開門班 16:45 下班
  assert.match(chk('B', today[1], '09:00', false, '2026-11-11').reason, /其他日期/);
  const e = { empId: 'N', start: H('14:30'), end: H('22:00') };
  assert.match(chk('N', e, '14:20').reason, /還沒到上班時間（14:30）/);
  assert.equal(chk('N', e, '14:30').ok, true);
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
