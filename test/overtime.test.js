const test = require('node:test');
const assert = require('node:assert/strict');
const { loadGas } = require('./load');

const g = loadGas();
const H = (s) => g.hmToMin(s);
const now = { date: '2026-11-10', min: H('15:00'), ms: 0 };
const shift = (code) => {
  const p = g.parseCode(code, '2026-11-10');
  return { start: p.start, end: p.end, baseStart: p.baseStart, baseEnd: p.baseEnd };
};

function check(over) {
  return g.checkCanApplyOvertime(Object.assign({
    now, date: '2026-11-10', shift: shift('7-5'), startMin: H('16:50'), endMin: H('17:30'),
    reason: '病人延遲下機', backDays: 7, existing: []
  }, over));
}

test('日期：今天與補登期限內可以，未來與超過期限不行', () => {
  assert.equal(g.addDays('2026-11-01', -1), '2026-10-31');
  assert.deepEqual([...g.overtimeDates('2026-11-10', 2)], ['2026-11-10', '2026-11-09', '2026-11-08']);
  assert.equal(check({}).ok, true);
  assert.equal(check({ date: '2026-11-03', shift: null }).ok, true);
  assert.match(check({ date: '2026-11-02', shift: null }).reason, /7 天內/);
  assert.match(check({ date: '2026-11-11' }).reason, /未來/);
  assert.match(check({ date: '' }).reason, /選擇日期/);
});

test('時段：要有先後、不能和上班或自己其他加班重疊；休假可以', () => {
  assert.match(check({ endMin: H('16:50') }).reason, /晚於開始/);
  assert.match(check({ startMin: NaN }).reason, /開始與結束/);
  assert.match(check({ startMin: H('16:30') }).reason, /06:50–16:50）重疊/);
  assert.equal(check({ startMin: H('06:00'), endMin: H('06:50') }).ok, true);     // 提早來
  assert.equal(check({ shift: null, startMin: H('08:00'), endMin: H('12:00') }).ok, true);
  const mine = [{ start: H('17:00'), end: H('18:00'), status: '待主管決定' }];
  assert.match(check({ existing: mine }).reason, /另一筆/);
  assert.equal(check({ existing: [Object.assign({}, mine[0], { status: '已駁回' })] }).ok, true);
  assert.match(check({ reason: '  ' }).reason, /原因/);
});

test('預設時段、決定與取消', () => {
  assert.deepEqual({ ...g.overtimeDefaults(shift('7-5')) }, { start: '16:50', end: '17:20' });
  assert.deepEqual({ ...g.overtimeDefaults(null) }, { start: '', end: '' });
  const ot = { empId: 'E1', status: '待主管決定' };
  assert.equal(g.checkCanDecideOvertime(ot, 'S1').ok, true);
  assert.match(g.checkCanDecideOvertime(ot, 'E1').reason, /自己/);
  assert.match(g.checkCanDecideOvertime({ empId: 'E1', status: '已核准' }, 'S1').reason, /已核准/);
  assert.equal(g.checkCanCancelOvertime(ot).ok, true);
  assert.equal(g.checkCanCancelOvertime({ status: '已駁回' }).ok, false);
});
