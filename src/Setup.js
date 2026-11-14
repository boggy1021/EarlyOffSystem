/**
 * 試算表選單、初始化、金鑰設定、觸發器。
 */

function onOpen() {
  SpreadsheetApp.getUi().createMenu('提前下班系統')
    .addItem('匯入班表…', 'menuImportSchedule')
    .addSeparator()
    .addItem('初始化工作表', 'setupSheets')
    .addItem('設定 LINE 金鑰…', 'menuSetSecrets')
    .addItem('安裝逾時觸發器', 'installTriggers')
    .addToUi();
}

/** 建立缺少的工作表與欄位；已有的資料不會被清除。 */
function setupSheets() {
  var ss = ss_();
  Object.keys(TABLES).forEach(function (k) {
    var t = TABLES[k];
    var sh = ss.getSheetByName(t.name) || ss.insertSheet(t.name);
    var lastCol = Math.max(sh.getLastColumn(), 1);
    var header = sh.getRange(1, 1, 1, lastCol).getValues()[0].filter(String);
    t.cols.forEach(function (c) {
      if (header.indexOf(c[1]) < 0) header.push(c[1]);
    });
    sh.getRange(1, 1, 1, header.length).setValues([header]).setFontWeight('bold');
    sh.setFrozenRows(1);
    // 日期、時間存成純文字，避免試算表自動轉型
    t.cols.forEach(function (c) {
      var col = header.indexOf(c[1]) + 1;
      var rng = sh.getRange(2, col, sh.getMaxRows() - 1, 1);
      if (c[2] === 'date' || c[2] === 'time' || c[0] === 'empId' || c[0] === 'voterEmpId' ||
          c[0] === 'reporterEmpId' || c[0] === 'supervisorEmpId' || c[0] === 'value') {
        rng.setNumberFormat('@');
      } else if (c[2] === 'ts') {
        rng.setNumberFormat('yyyy-mm-dd hh:mm:ss');
      }
    });
  });

  var emp = ss.getSheetByName(TABLES.EMP.name), eh = header_(emp);
  emp.getRange(2, eh.indexOf('綁定狀態') + 1, emp.getMaxRows() - 1, 1).setDataValidation(
    SpreadsheetApp.newDataValidation().requireValueInList([BIND.NONE, BIND.PENDING, BIND.OK]).build());
  emp.getRange(2, eh.indexOf('角色') + 1, emp.getMaxRows() - 1, 1).setDataValidation(
    SpreadsheetApp.newDataValidation().requireValueInList([ROLE.NURSE, ROLE.ADMIN, ROLE.SUPERVISOR]).build());

  var have = readAll_(TABLES.SETTINGS).map(function (r) { return r.key; });
  SETTING_DEFAULTS.forEach(function (d) {
    if (have.indexOf(d[0]) < 0) append_(TABLES.SETTINGS, { key: d[0], value: d[1], desc: d[2] });
  });

  var blank = ss.getSheetByName('工作表1') || ss.getSheetByName('Sheet1');
  if (blank && blank.getLastRow() === 0 && ss.getSheets().length > 1) ss.deleteSheet(blank);
  PropertiesService.getScriptProperties().setProperty('SPREADSHEET_ID', ss.getId());
  try { SpreadsheetApp.getUi().alert('工作表已就緒。'); } catch (e) { /* 從編輯器執行時沒有 UI */ }
}

/** 選單：設定 LINE 金鑰。存在 Script Properties，不寫進程式碼或試算表。 */
function menuSetSecrets() {
  var ui = SpreadsheetApp.getUi();
  var props = PropertiesService.getScriptProperties();
  var items = [
    ['CHANNEL_ACCESS_TOKEN', 'Messaging API 的 Channel access token（長期）'],
    ['LOGIN_CHANNEL_ID', 'LINE Login channel 的 Channel ID（數字）'],
    ['LIFF_ID', 'LIFF app 的 LIFF ID（例如 1234567890-AbCdEfGh）']
  ];
  for (var i = 0; i < items.length; i++) {
    var has = props.getProperty(items[i][0]) ? '（已設定，留白 = 不變）' : '';
    var r = ui.prompt('設定 LINE 金鑰 ' + (i + 1) + '/' + items.length, items[i][1] + has, ui.ButtonSet.OK_CANCEL);
    if (r.getSelectedButton() !== ui.Button.OK) return;
    var v = r.getResponseText().trim();
    if (v) props.setProperty(items[i][0], v);
  }
  ui.alert('已儲存。');
}

/** 每 5 分鐘把逾時的申請改成已失效（API 呼叫時也會檢查，這裡讓試算表狀態即時）。 */
function installTriggers() {
  ScriptApp.getProjectTriggers().forEach(function (t) {
    if (t.getHandlerFunction() === 'cronExpire') ScriptApp.deleteTrigger(t);
  });
  ScriptApp.newTrigger('cronExpire').timeBased().everyMinutes(5).create();
  try { SpreadsheetApp.getUi().alert('已安裝：每 5 分鐘檢查逾時申請。'); } catch (e) { /* 編輯器執行 */ }
}

function cronExpire() {
  var lock = LockService.getScriptLock();
  if (!lock.tryLock(30000)) return;
  try {
    expireDue_();
  } finally {
    lock.releaseLock();
  }
}
