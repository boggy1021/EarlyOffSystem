// 比對 JS 與 Python（OvertimeSalary/loaders.py）的班表解析結果。
// 先執行 test/parity/dump_python.py 產生 fixture；沒有 fixture 時略過。
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { loadGas } = require('./load');

const FIXTURE = path.join(__dirname, 'fixtures', 'schedule_dump.json');
const g = loadGas();

function revive(v) {
  if (v && typeof v === 'object' && v.$date) return new Date(v.$date[0], v.$date[1] - 1, v.$date[2]);
  return v;
}

test('JS 與 Python 的班表解析逐格一致', { skip: !fs.existsSync(FIXTURE) && '沒有 fixture' }, () => {
  const sheets = JSON.parse(fs.readFileSync(FIXTURE, 'utf8'));
  let cells = 0, unknown = new Map();
  for (const sh of sheets) {
    const grid = sh.grid.map((row) => row.map(revive));
    const rows = g.parseScheduleGrid(grid, sh.year, sh.month);
    const byKey = new Map(rows.map((r) => [`${r.name}|${r.date}`, r]));
    // 1. 逐格比對 parse_code
    for (const [rc, py] of Object.entries(sh.parsed)) {
      const [r, c] = rc.split(':').map(Number);
      const js = g.parseCode(grid[r - 1][c - 1], py.date);
      const where = `${sh.sheet} R${r}C${c} ${JSON.stringify(grid[r - 1][c - 1])}`;
      assert.equal(js.code, py.code, where);
      assert.equal(js.opener, py.opener, where);
      assert.equal(js.start, py.start, where);
      assert.equal(js.end, py.end, where);
      assert.equal(js.baseStart, py.base_start, where);
      assert.equal(js.note, py.note, where);
      assert.equal(js.unknown, py.unknown, where);
      cells++;
      if (js.unknown && byKey.has(`${py.name}|${py.date}`)) {
        unknown.set(js.code, (unknown.get(js.code) || 0) + 1);
      }
    }
    // 2. Python 加班費程式讀的人員列，JS 都要讀到
    const jsNames = new Set(rows.map((r) => r.name));
    for (const r of sh.py_rows) {
      const name = g.normName(grid[r - 1][0]);
      assert.ok(jsNames.has(name), `${sh.sheet} 第 ${r} 列 JS 沒讀到`);
    }
  }
  console.log(`比對 ${sheets.length} 個月、${cells} 格；無法辨識的代號：`, Object.fromEntries(unknown));
});
