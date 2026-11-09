/**
 * Google Sheets 資料存取。欄位依第 1 列的表頭名稱對應，管理者調整欄位順序不影響程式。
 */

var TZ = 'Asia/Taipei';

// 欄位型別：text（預設）、date（yyyy-MM-dd 文字）、time（HH:mm 文字）、ts（時間戳，Date）、bool
var TABLES = {
  EMP: {
    name: '員工',
    cols: [
      ['empId', '員工編號'], ['name', '姓名'], ['aliases', '別名'], ['userId', 'LINE userId'],
      ['lineName', 'LINE 名稱'], ['bindStatus', '綁定狀態'], ['bindAt', '綁定申請時間', 'ts'],
      ['role', '角色']
    ]
  },
  SCHED: {
    name: '班表',
    cols: [
      ['date', '日期', 'date'], ['empId', '員工編號'], ['name', '姓名'],
      ['start', '上班時間', 'time'], ['end', '下班時間', 'time'],
      ['baseStart', '比對上班', 'time'], ['baseEnd', '比對下班', 'time'],
      ['raw', '原始代號'], ['note', '備註']
    ]
  },
  REQ: {
    name: '申請',
    cols: [
      ['id', '申請ID'], ['empId', '員工編號'], ['name', '姓名'], ['date', '日期', 'date'],
      ['start', '表定上班', 'time'], ['end', '表定下班', 'time'],
      ['baseStart', '比對上班', 'time'], ['baseEnd', '比對下班', 'time'],
      ['createdAt', '申請時間', 'ts'], ['expiresAt', '失效時間', 'ts'], ['status', '狀態'],
      ['closedAt', '結案時間', 'ts'], ['closeBy', '結案方式'], ['approvedAt', '核准時間', 'ts']
    ]
  },
  VOTE: {
    name: '同意紀錄',
    cols: [
      ['reqId', '申請ID'], ['voterEmpId', '點選者編號'], ['voterName', '點選者姓名'],
      ['at', '時間', 'ts'], ['counted', '是否計入', 'bool'], ['reason', '不計原因']
    ]
  },
  REPORT: {
    name: '通報紀錄',
    cols: [
      ['reqId', '申請ID'], ['reporterEmpId', '通報人編號'], ['reporterName', '通報人姓名'],
      ['at', '時間', 'ts'], ['reason', '原因'], ['supervisorEmpId', '主管編號'],
      ['decision', '決定'], ['decidedAt', '決定時間', 'ts']
    ]
  },
  SETTINGS: {
    name: '設定',
    cols: [['key', '項目'], ['value', '值'], ['desc', '說明']]
  }
};

var BIND = { NONE: '未綁定', PENDING: '待確認', OK: '已確認' };
var ROLE = { NURSE: '護理師', SUPERVISOR: '主管' };
var DECISION = { OK: '准', NO: '不准' };

var SETTING_DEFAULTS = [
  ['同意門檻', 2, '需要幾位在班同仁同意'],
  ['逾時分鐘', 30, '未達門檻的申請幾分鐘後失效（不會晚於表定下班）'],
  ['群組名稱', '護理師大群組', '申請頁提示要分享到哪個群組'],
  ['班表檔案ID', '', 'Google Drive 上排班表 xlsx 的檔案 ID 或網址（匯入班表時會自動更新）']
];

function ss_() {
  var id = PropertiesService.getScriptProperties().getProperty('SPREADSHEET_ID');
  return id ? SpreadsheetApp.openById(id) : SpreadsheetApp.getActiveSpreadsheet();
}

function sheet_(t) {
  var sh = ss_().getSheetByName(t.name);
  if (!sh) throw new Error('找不到工作表「' + t.name + '」，請先執行「初始化工作表」。');
  return sh;
}

// ── 值轉換 ─────────────────────────────────────────────

function fmt_(d, pattern) {
  return Utilities.formatDate(d, TZ, pattern);
}

function normDateText_(v, disp) {
  var m = /(\d{4})\D(\d{1,2})\D(\d{1,2})/.exec(String(disp || v || ''));
  return m ? m[1] + '-' + pad2(+m[2]) + '-' + pad2(+m[3]) : '';
}

function normTimeText_(v, disp) {
  var m = /(\d{1,2}):(\d{2})/.exec(String(disp || v || ''));
  return m ? pad2(+m[1]) + ':' + m[2] : '';
}

function readCell_(type, v, disp) {
  switch (type) {
    case 'date': return normDateText_(v, disp);
    case 'time': return normTimeText_(v, disp);
    case 'ts': return isDateValue(v) ? v.getTime() : (v ? new Date(v).getTime() || null : null);
    case 'bool': return v === true || v === 'TRUE' || v === '是';
    default: return v === null || v === undefined ? '' : String(v).trim();
  }
}

function writeCell_(type, v) {
  if (v === null || v === undefined) return '';
  switch (type) {
    case 'ts': return typeof v === 'number' ? new Date(v) : v;
    case 'bool': return v ? '是' : '否';
    default: return v;
  }
}

// ── 通用表格操作 ─────────────────────────────────────────

/** 讀整張表，回傳 [{_row, 欄位...}]。 */
function readAll_(t) {
  var sh = sheet_(t);
  var rng = sh.getDataRange();
  var vals = rng.getValues(), disp = rng.getDisplayValues();
  var idx = colIndex_(t, vals[0]);
  var out = [];
  for (var r = 1; r < vals.length; r++) {
    var o = { _row: r + 1 }, empty = true;
    t.cols.forEach(function (c) {
      var i = idx[c[0]];
      if (i === undefined) return;
      o[c[0]] = readCell_(c[2], vals[r][i], disp[r][i]);
      if (vals[r][i] !== '' && vals[r][i] !== null) empty = false;
    });
    if (!empty) out.push(o);
  }
  return out;
}

function colIndex_(t, headerRow) {
  var idx = {};
  t.cols.forEach(function (c) {
    var i = headerRow.indexOf(c[1]);
    if (i >= 0) idx[c[0]] = i;
  });
  return idx;
}

function header_(sh) {
  return sh.getRange(1, 1, 1, sh.getLastColumn()).getValues()[0];
}

function toRowArray_(t, header, obj) {
  var row = header.map(function () { return ''; });
  var idx = colIndex_(t, header);
  t.cols.forEach(function (c) {
    if (idx[c[0]] !== undefined && obj.hasOwnProperty(c[0])) row[idx[c[0]]] = writeCell_(c[2], obj[c[0]]);
  });
  return row;
}

function append_(t, obj) {
  var sh = sheet_(t);
  sh.appendRow(toRowArray_(t, header_(sh), obj));
}

function appendMany_(t, objs) {
  if (!objs.length) return;
  var sh = sheet_(t), header = header_(sh);
  var rows = objs.map(function (o) { return toRowArray_(t, header, o); });
  sh.getRange(sh.getLastRow() + 1, 1, rows.length, header.length).setValues(rows);
}

/** 只更新 patch 裡有的欄位。 */
function update_(t, rowNum, patch) {
  var sh = sheet_(t), header = header_(sh), idx = colIndex_(t, header);
  t.cols.forEach(function (c) {
    if (patch.hasOwnProperty(c[0]) && idx[c[0]] !== undefined) {
      sh.getRange(rowNum, idx[c[0]] + 1).setValue(writeCell_(c[2], patch[c[0]]));
    }
  });
}

// ── 設定 ─────────────────────────────────────────────────

function settings_() {
  var out = {};
  SETTING_DEFAULTS.forEach(function (d) { out[d[0]] = d[1]; });
  readAll_(TABLES.SETTINGS).forEach(function (r) { if (r.key && r.value !== '') out[r.key] = r.value; });
  return {
    threshold: parseInt(out['同意門檻'], 10) || 2,
    timeoutMin: parseInt(out['逾時分鐘'], 10) || 30,
    groupName: String(out['群組名稱'] || ''),
    scheduleFileId: String(out['班表檔案ID'] || '')
  };
}

function setSetting_(key, value) {
  var rows = readAll_(TABLES.SETTINGS);
  for (var i = 0; i < rows.length; i++) {
    if (rows[i].key === key) return update_(TABLES.SETTINGS, rows[i]._row, { value: value });
  }
  append_(TABLES.SETTINGS, { key: key, value: value, desc: '' });
}

function prop_(key) {
  var v = PropertiesService.getScriptProperties().getProperty(key);
  if (!v) throw new Error('尚未設定 ' + key + '，請在試算表選單執行「設定 LINE 金鑰」。');
  return v;
}

// ── 領域物件 ─────────────────────────────────────────────

function employees_() {
  return readAll_(TABLES.EMP);
}

function shiftFromRow_(r) {
  var t = function (s) { return s ? hmToMin(s) : null; };
  return { empId: r.empId, name: r.name, date: r.date, start: t(r.start), end: t(r.end),
           baseStart: t(r.baseStart), baseEnd: t(r.baseEnd), raw: r.raw };
}

/** 某天的班表（只回傳有上班時段的人）。 */
function shiftsOn_(date) {
  return readAll_(TABLES.SCHED)
    .filter(function (r) { return r.date === date && r.start && r.end; })
    .map(shiftFromRow_);
}

function requestFromRow_(r) {
  var t = function (s) { return s ? hmToMin(s) : null; };
  return {
    _row: r._row, id: r.id, empId: r.empId, name: r.name, date: r.date,
    start: t(r.start), end: t(r.end), baseStart: t(r.baseStart), baseEnd: t(r.baseEnd),
    createdMs: r.createdAt, expiresMs: r.expiresAt, status: r.status,
    closedMs: r.closedAt, closeBy: r.closeBy, approvedMs: r.approvedAt
  };
}

function requests_() {
  return readAll_(TABLES.REQ).map(requestFromRow_);
}

function findRequest_(id) {
  var all = requests_();
  for (var i = 0; i < all.length; i++) if (all[i].id === id) return all[i];
  throw apiError_('NOT_FOUND', '找不到這筆申請。');
}

function votesFor_(reqId) {
  return readAll_(TABLES.VOTE).filter(function (v) { return v.reqId === reqId; });
}

function reportsFor_(reqId) {
  return readAll_(TABLES.REPORT).filter(function (v) { return v.reqId === reqId; });
}

function saveRequestPatch_(req, patch) {
  var p = {};
  Object.keys(patch).forEach(function (k) {
    req[k] = patch[k];
    var map = { closedMs: 'closedAt', approvedMs: 'approvedAt', expiresMs: 'expiresAt' };
    p[map[k] || k] = patch[k];
  });
  update_(TABLES.REQ, req._row, p);
}

/** 'yyyy-MM-dd' + 分鐘 → epoch 毫秒（台灣沒有日光節約時間）。 */
function dateMinToMs_(date, min) {
  return new Date(date + 'T' + minToHm(min) + ':00+08:00').getTime();
}

function now_() {
  var d = new Date();
  return { ms: d.getTime(), date: fmt_(d, 'yyyy-MM-dd'), min: hmToMin(fmt_(d, 'HH:mm')) };
}
