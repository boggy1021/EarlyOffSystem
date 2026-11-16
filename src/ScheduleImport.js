/**
 * 匯入班表：把 Drive 上的排班表 xlsx 暫時轉成 Google 試算表，用 Shift.js 解析，
 * 寫進「班表」工作表。同一個月份重新匯入會整月覆蓋（臨時調班時重匯即可，
 * 也可以直接手動修改「班表」工作表）。
 */

/**
 * 行政、清潔人員在大排班表底部只寫「V」（上班）／off，時段依「員工」表的角色決定
 * （上下班同加班費專案 config.STAFF_SHIFTS；午休 12:30–13:30 是 2026-11-16 使用者確認的）。
 * 午休可以申請加班（沒申請就是休息）；行政週二、四、六可以 16:30 走，但 16:30–17:30
 * 仍算上班時間，不能申請加班，所以表定下班一律 17:30。
 */
var STAFF_WORK_CODE = 'V';
var STAFF_SHIFTS = {
  '行政人員': { start: '08:30', end: '17:30', breakStart: '12:30', breakEnd: '13:30',
               earlyOut: { 2: '週二 16:30 可下班', 4: '週四 16:30 可下班', 6: '週六 16:30 可下班' } },
  '清潔人員': { start: '07:30', end: '16:30', breakStart: '12:30', breakEnd: '13:30', earlyOut: {} }
};

function staffShiftRow_(p, empId, s) {
  var d = p.date.split('-').map(Number);
  var wd = new Date(Date.UTC(d[0], d[1] - 1, d[2])).getUTCDay();
  return {
    date: p.date, empId: empId, name: p.name,
    start: s.start, end: s.end, baseStart: s.start, baseEnd: s.end,
    breakStart: s.breakStart, breakEnd: s.breakEnd,
    raw: p.raw, note: s.earlyOut[wd] || ''
  };
}

function extractDriveId_(s) {
  var m = /[-\w]{25,}/.exec(String(s || ''));
  return m ? m[0] : '';
}

/** 選單：匯入班表… */
function menuImportSchedule() {
  var ui = SpreadsheetApp.getUi();
  var cfg = settings_();
  var r1 = ui.prompt('匯入班表',
    '排班表 xlsx 在 Google Drive 的網址或檔案 ID' +
    (cfg.scheduleFileId ? '\n（留白 = 沿用上次的檔案）' : ''), ui.ButtonSet.OK_CANCEL);
  if (r1.getSelectedButton() !== ui.Button.OK) return;
  var fileId = extractDriveId_(r1.getResponseText()) || extractDriveId_(cfg.scheduleFileId);
  if (!fileId) return ui.alert('沒有檔案 ID。');

  var next = new Date();
  var r2 = ui.prompt('匯入班表', '要匯入的月份工作表名稱（例如 ' +
    (next.getFullYear() - 1911) + pad2(next.getMonth() + 1) + '）', ui.ButtonSet.OK_CANCEL);
  if (r2.getSelectedButton() !== ui.Button.OK) return;
  var sheetName = r2.getResponseText().trim();

  var result = importSchedule(fileId, sheetName);
  setSetting_('班表檔案ID', fileId);
  ui.alert('匯入完成', result.message, ui.ButtonSet.OK);
}

/** 匯入一個月。回傳 {message}。也可以在編輯器直接執行。 */
function importSchedule(fileId, sheetName) {
  clearReadCache_();
  var ym = parseSheetName(sheetName);
  if (!ym) throw new Error('工作表名稱要像「11511」（民國年 + 月）。');

  var values = readXlsxSheet_(fileId, sheetName);
  var parsed = parseScheduleGrid(values, ym.year, ym.month);
  if (!parsed.length) throw new Error('「' + sheetName + '」沒有讀到任何班別，請確認版面。');

  return withLock_(function () {
    var emps = employees_();
    var created = [];
    var byName = {};
    emps.forEach(function (e) {
      [e.name].concat(String(e.aliases || '').split(/[,，、]/)).map(normName).filter(Boolean)
        .forEach(function (n) { byName[n] = e.empId; });
    });
    var nextNo = emps.reduce(function (mx, e) {
      var m = /^N(\d+)$/.exec(e.empId);
      return m ? Math.max(mx, +m[1]) : mx;
    }, 0);
    parsed.forEach(function (p) {
      if (byName[p.name]) return;
      nextNo++;
      var id = 'N' + ('00' + nextNo).slice(-3);
      byName[p.name] = id;
      created.push({ empId: id, name: p.name, bindStatus: BIND.NONE, role: ROLE.NURSE });
    });
    appendMany_(TABLES.EMP, created);

    var roleOf = {};
    emps.concat(created).forEach(function (e) { roleOf[e.empId] = e.role; });
    var unknown = [];
    var rows = parsed.filter(function (p) { return !p.off; }).map(function (p) {
      var empId = byName[p.name];
      var staff = p.unknown && p.raw === STAFF_WORK_CODE ? STAFF_SHIFTS[roleOf[empId]] : null;
      if (staff) return staffShiftRow_(p, empId, staff);
      if (p.unknown) unknown.push(p.name + ' ' + p.date.slice(5) + '「' + p.raw.replace(/\n/g, ' ') + '」');
      var note = [p.opener ? '開門' : '', p.note, p.unknown ? '無法辨識' : ''].filter(Boolean).join('；');
      return {
        date: p.date, empId: empId, name: p.name,
        start: minToHm(p.start), end: minToHm(p.end),
        baseStart: minToHm(p.baseStart), baseEnd: minToHm(p.baseEnd),
        raw: p.raw.replace(/\n/g, ' '), note: note
      };
    });
    replaceMonth_(ym.year + '-' + pad2(ym.month), rows);

    var msg = sheetName + '：寫入 ' + rows.length + ' 筆上班紀錄。';
    if (created.length) {
      msg += '\n\n新增員工 ' + created.length + ' 位（請到「員工」表確認角色）：' +
             created.map(function (e) { return e.name; }).join('、');
    }
    if (unknown.length) {
      msg += '\n\n無法辨識的代號（不會算進任何一班；行政、清潔人員的 V 要先在「員工」表設好角色）：\n' +
             unknown.slice(0, 30).join('\n') + (unknown.length > 30 ? '\n…' : '');
    }
    return { message: msg };
  });
}

/** 把 xlsx 暫時轉成 Google 試算表，讀出指定工作表後丟進垃圾桶。 */
function readXlsxSheet_(fileId, sheetName) {
  var tmp = Drive.Files.copy(
    { name: '_tmp_班表匯入_' + Date.now(), mimeType: MimeType.GOOGLE_SHEETS },
    fileId, { supportsAllDrives: true });
  try {
    var ss = SpreadsheetApp.openById(tmp.id);
    ss.setSpreadsheetTimeZone(TZ);   // 讓表頭日期以台灣時間解讀
    var sh = ss.getSheetByName(sheetName);
    if (!sh) throw new Error('排班表裡找不到工作表「' + sheetName + '」。');
    return sh.getDataRange().getValues();
  } finally {
    DriveApp.getFileById(tmp.id).setTrashed(true);
  }
}

/** 刪除「班表」中某月份（yyyy-MM）的所有列，再寫入新的。 */
function replaceMonth_(ym, rows) {
  delete READ_CACHE_[TABLES.SCHED.name];
  var sh = sheet_(TABLES.SCHED);
  // 舊表沒有「午休開始／結束」欄時自動補上，免得行政、清潔的午休被丟掉
  var withBreak = rows.filter(function (r) { return r.breakStart; })[0];
  var header = withBreak ? ensureCols_(TABLES.SCHED, sh, header_(sh), withBreak) : header_(sh);
  var keep = readAll_(TABLES.SCHED).filter(function (r) { return r.date.slice(0, 7) !== ym; });
  var all = keep.concat(rows).sort(function (a, b) {
    return a.date < b.date ? -1 : a.date > b.date ? 1 : String(a.empId) < String(b.empId) ? -1 : 1;
  });
  var last = sh.getLastRow();
  if (last > 1) sh.getRange(2, 1, last - 1, header.length).clearContent();
  if (all.length) {
    sh.getRange(2, 1, all.length, header.length)
      .setValues(all.map(function (o) { return toRowArray_(TABLES.SCHED, header, o); }));
  }
  delete READ_CACHE_[TABLES.SCHED.name];   // 上面讀過的是寫入前的舊資料
}
