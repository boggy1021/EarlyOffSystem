// 記憶體版的 Apps Script 服務，只實作本專案用到的部分，用來在本機跑完整流程。
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const crypto = require('crypto');

function fmtTaipei(d, pattern) {
  const t = new Date(d.getTime() + 8 * 3600000);
  const p = (n) => String(n).padStart(2, '0');
  return pattern
    .replace('yyyy', t.getUTCFullYear()).replace('MM', p(t.getUTCMonth() + 1)).replace('dd', p(t.getUTCDate()))
    .replace('HH', p(t.getUTCHours())).replace('mm', p(t.getUTCMinutes())).replace('ss', p(t.getUTCSeconds()));
}

class FakeSheet {
  constructor(name) { this.name = name; this.data = []; }
  width() { return Math.max(0, ...this.data.map((r) => r.length)); }
  getLastRow() { return this.data.length; }
  getLastColumn() { return this.width(); }
  getMaxRows() { return 1000; }
  setFrozenRows() {}
  getName() { return this.name; }
  appendRow(row) { this.data.push(row.slice()); }
  getDataRange() { return this.getRange(1, 1, Math.max(1, this.data.length), Math.max(1, this.width())); }
  getRange(r, c, nr = 1, nc = 1) { return new FakeRange(this, r, c, nr, nc); }
}

class FakeRange {
  constructor(sh, r, c, nr, nc) { Object.assign(this, { sh, r, c, nr, nc }); }
  cell(i, j) { const row = this.sh.data[this.r - 1 + i]; return row ? row[this.c - 1 + j] : undefined; }
  getValues() {
    const out = [];
    for (let i = 0; i < this.nr; i++) {
      const row = [];
      for (let j = 0; j < this.nc; j++) { const v = this.cell(i, j); row.push(v === undefined ? '' : v); }
      out.push(row);
    }
    return out;
  }
  getDisplayValues() {
    return this.getValues().map((row) => row.map((v) =>
      Object.prototype.toString.call(v) === '[object Date]' ? fmtTaipei(v, 'yyyy-MM-dd HH:mm:ss') : String(v)));
  }
  setValues(vals) {
    vals.forEach((row, i) => row.forEach((v, j) => this.put(i, j, v)));
    return this;
  }
  setValue(v) { this.put(0, 0, v); return this; }
  put(i, j, v) {
    const ri = this.r - 1 + i;
    while (this.sh.data.length <= ri) this.sh.data.push([]);
    const row = this.sh.data[ri];
    while (row.length < this.c - 1 + j) row.push('');
    row[this.c - 1 + j] = v;
  }
  clearContent() {
    for (let i = 0; i < this.nr; i++) for (let j = 0; j < this.nc; j++) if (this.cell(i, j) !== undefined) this.put(i, j, '');
    // 移除尾端空列
    while (this.sh.data.length && this.sh.data[this.sh.data.length - 1].every((v) => v === '')) this.sh.data.pop();
    return this;
  }
  setNumberFormat() { return this; }
  setDataValidation() { return this; }
  setFontWeight() { return this; }
}

class FakeSpreadsheet {
  constructor() { this.sheets = []; }
  getSheetByName(n) { return this.sheets.find((s) => s.name === n) || null; }
  insertSheet(n) { const s = new FakeSheet(n); this.sheets.push(s); return s; }
  getSheets() { return this.sheets; }
  deleteSheet(s) { this.sheets = this.sheets.filter((x) => x !== s); }
  getId() { return 'fake-ss'; }
}

function createEnv(opts = {}) {
  const ss = new FakeSpreadsheet();
  const props = { CHANNEL_ACCESS_TOKEN: 'tok', LOGIN_CHANNEL_ID: '123', LIFF_ID: 'liff-1' };
  const cache = {};
  const pushes = [];
  const clock = { now: opts.now || Date.UTC(2026, 10, 10, 7, 0) };   // 2026-11-10 15:00 台北

  class FakeDate extends Date {
    constructor(...a) { if (a.length) super(...a); else super(clock.now); }
    static now() { return clock.now; }
  }

  const g = {
    console: { log() {}, warn() {}, error: (...a) => opts.onError && opts.onError(...a) },
    Date: FakeDate,
    SpreadsheetApp: {
      getActiveSpreadsheet: () => ss,
      openById: () => ss,
      getUi: () => { throw new Error('no ui'); },
      newDataValidation: () => ({ requireValueInList() { return this; }, build() { return {}; } })
    },
    PropertiesService: {
      getScriptProperties: () => ({
        getProperty: (k) => (k === 'SPREADSHEET_ID' ? null : props[k] || null),
        setProperty: (k, v) => { props[k] = v; }
      })
    },
    CacheService: { getScriptCache: () => ({ get: (k) => cache[k] || null, put: (k, v) => { cache[k] = v; } }) },
    LockService: { getScriptLock: () => ({ tryLock: () => true, releaseLock() {} }) },
    Utilities: {
      formatDate: (d, tz, p) => fmtTaipei(d, p),
      computeDigest: (alg, s) => [...crypto.createHash('sha256').update(s).digest()],
      base64EncodeWebSafe: (b) => Buffer.from(b).toString('base64url'),
      DigestAlgorithm: { SHA_256: 'sha256' }
    },
    UrlFetchApp: {
      fetch: (url, o) => {
        if (url.includes('/oauth2/v2.1/verify')) {
          // 測試用 token 格式：「tok:<userId>」
          const t = o.payload.id_token;
          const ok = t.startsWith('tok:');
          return {
            getResponseCode: () => (ok ? 200 : 400),
            getContentText: () => JSON.stringify({ sub: t.slice(4), name: 'LINE-' + t.slice(4), exp: clock.now / 1000 + 3600 })
          };
        }
        pushes.push({ url, body: JSON.parse(o.payload) });
        return { getResponseCode: () => 200, getContentText: () => '{}' };
      }
    },
    ContentService: {
      createTextOutput: (s) => ({ s, setMimeType() { return this; } }),
      MimeType: { JSON: 'json' }
    }
  };
  const ctx = vm.createContext(g);
  const dir = path.join(__dirname, '..', 'src');
  for (const f of fs.readdirSync(dir).filter((x) => x.endsWith('.js'))) {
    vm.runInContext(fs.readFileSync(path.join(dir, f), 'utf8'), ctx, { filename: f });
  }
  return { ctx, ss, pushes, clock, props };
}

module.exports = { createEnv, fmtTaipei };
