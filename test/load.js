// 把 Apps Script 的純邏輯檔載入同一個 vm context（模擬 Apps Script 的共用全域範圍）。
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const FILES = ['ShiftConfig.js', 'Shift.js', 'Rules.js'];

function loadGas() {
  const ctx = vm.createContext({});
  for (const f of FILES) {
    const code = fs.readFileSync(path.join(__dirname, '..', 'src', f), 'utf8');
    vm.runInContext(code, ctx, { filename: f });
  }
  return ctx;
}

module.exports = { loadGas };
