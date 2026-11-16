/**
 * 匯入班表：把 Drive 上的排班表 xlsx 暫時轉成 Google 試算表，用 Shift.js 解析，
 * 寫進「班表」工作表。同一個月份重新匯入會整月覆蓋。每天清晨會自動匯入（cronImportSchedule），
 * 所以換班要改 Drive 上的排班表；直接改「班表」工作表會在下次排班表變更後被覆蓋。
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

/** 匯入一個月。回傳 {message, rows, created, unknown}。也可以在編輯器直接執行。 */
function importSchedule(fileId, sheetName) {
  clearReadCache_();
  if (!parseSheetName(sheetName)) throw new Error('工作表名稱要像「11511」（民國年 + 月）。');
  return importScheduleValues_(readXlsxSheet_(fileId, sheetName), sheetName);
}

/** 把一個月份工作表的內容（getValues）寫進「班表」，整月覆蓋。 */
function importScheduleValues_(values, sheetName) {
  var ym = parseSheetName(sheetName);
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
    return {
      message: msg, rows: rows.length,
      created: created.map(function (e) { return e.name; }), unknown: unknown
    };
  });
}

/** 把 xlsx 暫時轉成 Google 試算表，讀出指定工作表後丟進垃圾桶。 */
function readXlsxSheet_(fileId, sheetName) {
  var v = readXlsxSheets_(fileId, [sheetName])[sheetName];
  if (!v) throw new Error('排班表裡找不到工作表「' + sheetName + '」。');
  return v;
}

/** 一次轉檔讀多個工作表。回傳 {工作表名稱: values}，找不到的是 null。 */
function readXlsxSheets_(fileId, names) {
  var tmp = Drive.Files.copy(
    { name: '_tmp_班表匯入_' + Date.now(), mimeType: MimeType.GOOGLE_SHEETS },
    fileId, { supportsAllDrives: true });
  try {
    var ss = SpreadsheetApp.openById(tmp.id);
    ss.setSpreadsheetTimeZone(TZ);   // 讓表頭日期以台灣時間解讀
    var out = {};
    names.forEach(function (n) {
      var sh = ss.getSheetByName(n);
      out[n] = sh ? sh.getDataRange().getValues() : null;
    });
    return out;
  } finally {
    DriveApp.getFileById(tmp.id).setTrashed(true);
  }
}

// ── 每日自動匯入 ─────────────────────────────────────────

/**
 * 每天清晨自動匯入上個月、這個月、下個月（加班可補登到上個月；下個月的工作表一建立就會載入）。
 * 排班表每年一個檔（115年排班表.xlsx、116年排班表.xlsx…），跨年時到「班表檔案ID」那個檔所在的
 * 資料夾找同名規則的檔案。檔案沒有變更就略過（記錄在 Script Properties），所以不會每天重寫。
 * 有錯誤、新增員工、無法辨識的代號時推播給已綁定的主管。
 * ⚠ 自動匯入會整月覆蓋「班表」工作表：換班請改 Drive 上的排班表，不要只改「班表」工作表。
 */
var AUTO_IMPORT_HOUR = 5;
var AUTO_IMPORT_STATE_KEY = 'AUTO_IMPORT_STATE';

/** 'yyyy-MM-dd' → 要匯入的月份 [{roc: 民國年, sheet: '11511'}]：上個月、這個月、下個月。 */
function autoImportMonths(today) {
  var p = today.split('-').map(Number);
  return [-1, 0, 1].map(function (d) {
    var dt = new Date(Date.UTC(p[0], p[1] - 1 + d, 1));
    var roc = dt.getUTCFullYear() - 1911;
    return { roc: roc, sheet: roc + pad2(dt.getUTCMonth() + 1), current: d === 0 };
  });
}

function cronImportSchedule() {
  clearReadCache_();
  var baseId = extractDriveId_(settings_().scheduleFileId);
  if (!baseId) {
    textToSupervisors_('📅 班表自動匯入：「設定」表沒有「班表檔案ID」，請先手動匯入一次。');
    return;
  }
  var props = PropertiesService.getScriptProperties();
  var state = {};
  try { state = JSON.parse(props.getProperty(AUTO_IMPORT_STATE_KEY) || '{}'); } catch (e) { state = {}; }

  var byYear = {};
  autoImportMonths(now_().date).forEach(function (m) {
    (byYear[m.roc] = byYear[m.roc] || []).push(m);
  });
  var done = [], alerts = [];
  Object.keys(byYear).forEach(function (roc) {
    var months = byYear[roc];
    var sheets = months.map(function (m) { return m.sheet; });
    try {
      var file = scheduleFileForYear_(baseId, +roc);
      if (!file) {
        if (months.some(function (m) { return m.current; })) {
          alerts.push('找不到「' + roc + '年排班表.xlsx」（要和現在的排班表放在同一個資料夾）。');
        }
        return;
      }
      var key = file.modified + '|' + sheets.join(',');
      if (state[file.id] === key) { done.push(roc + '年沒有變更'); return; }
      var grids = readXlsxSheets_(file.id, sheets);
      sheets.forEach(function (name) {
        if (!grids[name]) return;                       // 還沒建立的月份
        var r;
        try {
          r = importScheduleValues_(grids[name], name);
        } catch (e) {
          if (/沒有讀到任何班別/.test(e.message)) return; // 剛建立、還沒排的月份
          throw e;
        }
        done.push(name + ' ' + r.rows + ' 筆');
        if (r.created.length) alerts.push(name + ' 新增員工：' + r.created.join('、') + '（請到「員工」表確認角色）');
        if (r.unknown.length) {
          alerts.push(name + ' 無法辨識的代號：\n' + r.unknown.slice(0, 10).join('\n') +
                      (r.unknown.length > 10 ? '\n…共 ' + r.unknown.length + ' 格' : ''));
        }
      });
      state[file.id] = key;
    } catch (e) {
      console.warn('自動匯入 ' + roc + ' 年失敗', e);    // 主管會收到推播，這裡只留紀錄
      alerts.push(roc + ' 年排班表自動匯入失敗：' + e.message);
      done.push(roc + '年失敗');
    }
  });
  props.setProperty(AUTO_IMPORT_STATE_KEY, JSON.stringify(state));
  setSetting_('上次自動匯入', fmt_(new Date(), 'yyyy-MM-dd HH:mm') + '　' + done.join('；'));
  if (alerts.length) textToSupervisors_('📅 班表自動匯入\n' + alerts.join('\n'));
}

/** 某個民國年的排班表檔：就是設定的那個檔，或同資料夾裡的「NNN年排班表.xlsx」。 */
function scheduleFileForYear_(baseId, roc) {
  var base = driveMeta_(baseId);
  var want = roc + '年排班表';
  if (String(base.name).indexOf(want) === 0) return base;
  var parent = (base.parents || [])[0];
  return parent ? driveFind_(parent, want + '.xlsx') : null;
}

function driveMeta_(id) {
  var f = Drive.Files.get(id, { fields: 'id,name,parents,modifiedTime', supportsAllDrives: true });
  return { id: f.id, name: f.name, parents: f.parents, modified: f.modifiedTime };
}

function driveFind_(parentId, name) {
  var res = Drive.Files.list({
    q: "'" + parentId + "' in parents and name = '" + name.replace(/'/g, "\\'") + "' and trashed = false",
    fields: 'files(id,name,parents,modifiedTime)', orderBy: 'modifiedTime desc',
    supportsAllDrives: true, includeItemsFromAllDrives: true
  });
  var f = (res.files || [])[0];
  return f ? { id: f.id, name: f.name, parents: f.parents, modified: f.modifiedTime } : null;
}

function textToSupervisors_(text) {
  employees_().forEach(function (e) {
    if (e.role === ROLE.SUPERVISOR && e.bindStatus === BIND.OK && e.userId) push_(e.userId, [textMsg_(text)]);
  });
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
