/**
 * 班別解析：移植自 OvertimeSalary/loaders.py 的 parse_code / load_schedule。
 * 純函式，不碰 Apps Script 服務，可以在 Node 測試。
 */

function hmToMin(s) {
  var p = String(s).split(':');
  return parseInt(p[0], 10) * 60 + parseInt(p[1], 10);
}

function minToHm(m) {
  if (m === null || m === undefined || m === '') return '';
  var h = Math.floor(m / 60), mi = m % 60;
  return (h < 10 ? '0' : '') + h + ':' + (mi < 10 ? '0' : '') + mi;
}

/** 回傳 {shifts, openerMin}，套用 dateStr（yyyy-MM-dd）當天已生效的班別修訂。 */
function shiftTable(dateStr) {
  var shifts = {}, openerMin = OPENER_SHIFT_MIN;
  Object.keys(SHIFTS).forEach(function (k) { shifts[k] = SHIFTS[k]; });
  SHIFT_REVISIONS.forEach(function (rev) {
    if (dateStr && dateStr >= rev.since) {
      Object.keys(rev.changes).forEach(function (k) { shifts[k] = rev.changes[k]; });
      openerMin = rev.openerMin;
    }
  });
  return { shifts: shifts, openerMin: openerMin };
}

/**
 * 解析一格班別代號。
 * 回傳 {raw, code, off, opener, start, end, baseStart, baseEnd, note, unknown}；時間為分鐘。
 * start/end 是實際排定時段（▲ 開門班已提早）；baseStart/baseEnd 是沒有提早的時段，
 * 匯入時存成「比對上班／下班」欄，供參考。
 */
function parseCode(raw, dateStr) {
  // Python: str(raw or '').strip()
  var s = (raw === null || raw === undefined || raw === 0 || raw === false) ? '' : String(raw).trim();
  var p = { raw: s, code: '', off: false, opener: false, start: null, end: null,
            baseStart: null, baseEnd: null, note: '', unknown: false };
  if (!s || OFF_CODES.indexOf(s) >= 0) {
    p.code = 'off';
    p.off = true;
    return p;
  }
  var tokens = s.split('\n').map(function (t) { return t.trim(); }).filter(Boolean);
  var i = tokens.indexOf(OPENER_MARK);
  if (i >= 0) {
    p.opener = true;
    tokens.splice(i, 1);
  }
  tokens = tokens.map(function (t) { return SHIFT_ALIASES.hasOwnProperty(t) ? SHIFT_ALIASES[t] : t; });
  var tbl = shiftTable(dateStr);
  var joined = tokens.join(' ');
  if (tbl.shifts.hasOwnProperty(joined)) {
    p.code = joined;
  } else {
    var hit = tokens.filter(function (t) { return tbl.shifts.hasOwnProperty(t); });
    if (hit.length) {
      p.code = hit[0];
      p.note = tokens.filter(function (t) { return t !== hit[0]; }).join(' ');
    } else {
      p.code = joined;
      p.unknown = true;
      return p;
    }
  }
  var se = tbl.shifts[p.code];
  var shift = p.opener ? tbl.openerMin : 0;
  p.baseStart = hmToMin(se[0]);
  p.baseEnd = hmToMin(se[1]);
  p.start = p.baseStart + shift;
  p.end = p.baseEnd + shift;
  return p;
}

function normName(s) {
  return String(s === null || s === undefined ? '' : s).replace(/\s+/g, '');
}

function isDateValue(v) {
  return Object.prototype.toString.call(v) === '[object Date]' && !isNaN(v.getTime());
}

function pad2(n) { return (n < 10 ? '0' : '') + n; }

/** 工作表名稱「11511」→ {year: 2026, month: 11}；格式不符回傳 null。 */
function parseSheetName(name) {
  var m = /^(\d{3})(\d{2})$/.exec(String(name).trim());
  if (!m) return null;
  var month = parseInt(m[2], 10);
  if (month < 1 || month > 12) return null;
  return { year: parseInt(m[1], 10) + 1911, month: month };
}

/**
 * 解析一個月的排班表。values 是工作表的 getValues()（二維陣列，[0][0] = A1）。
 * 只取表頭日期的「日」，年月以參數為準（排班表表頭的年份不可靠）。
 * 人員列：從第 6 列往下，遇到空白或以 ▲ / ※ 開頭的註腳就停止。
 * 回傳 [{name, date, ...parseCode 結果}]。
 */
function parseScheduleGrid(values, year, month) {
  var header = values[SCHEDULE_HEADER_ROW - 1] || [];
  var days = [];  // [{col, date}]
  for (var c = SCHEDULE_FIRST_DAY_COL - 1; c < SCHEDULE_FIRST_DAY_COL - 1 + 32 && c < header.length; c++) {
    if (!isDateValue(header[c])) break;
    var day = header[c].getDate();
    days.push({ col: c, date: year + '-' + pad2(month) + '-' + pad2(day) });
  }
  var out = [];
  for (var r = SCHEDULE_FIRST_ROW - 1; r < values.length; r++) {
    var name = normName(values[r][0]);
    if (!name || name.charAt(0) === OPENER_MARK || name.charAt(0) === '※') break;
    days.forEach(function (d) {
      var p = parseCode(values[r][d.col], d.date);
      p.name = name;
      p.date = d.date;
      out.push(p);
    });
  }
  return out;
}

/** 沒有 ▲ 提早的上下班時間（匯入時存成比對欄，供參考）。 */
function shiftKeyOf(baseStart, baseEnd) {
  if (baseStart === null || baseStart === undefined || baseStart === '' ||
      baseEnd === null || baseEnd === undefined || baseEnd === '') return '';
  return minToHm(baseStart) + '-' + minToHm(baseEnd);
}
