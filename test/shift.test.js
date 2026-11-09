const test = require('node:test');
const assert = require('node:assert/strict');
const { loadGas } = require('./load');

const g = loadGas();
const hm = (m) => g.minToHm(m);

test('一般班別，修訂前後時段不同', () => {
  let p = g.parseCode('7-5', '2026-10-31');
  assert.equal(hm(p.start), '07:00');
  assert.equal(hm(p.end), '17:00');
  p = g.parseCode('7-5', '2026-11-01');
  assert.equal(hm(p.start), '06:50');
  assert.equal(hm(p.end), '16:50');
  assert.equal(p.opener, false);
});

test('▲ 開門班：實際時段提早，比對時段不變', () => {
  const p = g.parseCode('▲\n7-3', '2026-11-05');
  assert.equal(p.opener, true);
  assert.equal(hm(p.start), '06:45');
  assert.equal(hm(p.end), '14:45');
  assert.equal(hm(p.baseStart), '06:50');
  assert.equal(hm(p.baseEnd), '14:50');
  const q = g.parseCode('7-3', '2026-11-05');
  assert.equal(g.shiftKeyOf(p.baseStart, p.baseEnd), g.shiftKeyOf(q.baseStart, q.baseEnd));

  const old = g.parseCode('▲\n7-3', '2026-10-05');
  assert.equal(hm(old.start), '06:45');   // 修訂前提早 15 分
});

test('off、空白、0 都是休假', () => {
  for (const v of ['off', 'OFF', '', null, undefined, 0, '  ']) {
    const p = g.parseCode(v, '2026-11-01');
    assert.equal(p.off, true, String(v));
    assert.equal(p.start, null);
  }
});

test('多行代號與別名', () => {
  let p = g.parseCode("消RO\n11-7'", '2026-11-01');
  assert.equal(p.code, "消RO 11-7'");
  assert.equal(hm(p.end), '19:30');
  p = g.parseCode("'10'-6'", '2026-11-01');
  assert.equal(p.code, "10'-6'");
  p = g.parseCode('7-3\n王小明', '2026-11-01');
  assert.equal(p.code, '7-3');
  assert.equal(p.note, '王小明');
});

test('無法辨識的代號', () => {
  const p = g.parseCode('V', '2026-11-01');
  assert.equal(p.unknown, true);
  assert.equal(p.start, null);
});

test('解析整張月表：只取表頭的日、遇到註腳停止', () => {
  const d = (day) => new Date(2015, 10, day);    // 表頭年份錯誤也不影響
  const values = [
    [115, '年', 11, '月'],
    [], [],
    ['日 期', d(1), d(2), '夜班\n次數'],
    ['星期姓名', '日', 1, null],
    ['甲 乙', 'off', '▲\n7-5', 3],
    ['丙丁', 'E', '7-5', 4],
    ['▲需來開門', null, null, null],
    ['戊', '7-5', '7-5', 1],
  ];
  const rows = g.parseScheduleGrid(values, 2026, 11);
  assert.equal(rows.length, 4);
  assert.deepEqual([...rows.map((r) => `${r.name}|${r.date}|${r.code}`)],
    ['甲乙|2026-11-01|off', '甲乙|2026-11-02|7-5', '丙丁|2026-11-01|E', '丙丁|2026-11-02|7-5']);
  assert.equal(rows[1].opener, true);
});

test('工作表名稱', () => {
  assert.deepEqual({ ...g.parseSheetName('11511') }, { year: 2026, month: 11 });
  assert.equal(g.parseSheetName('說明'), null);
  assert.equal(g.parseSheetName('11513'), null);
});
