/**
 * 網頁應用程式進入點：同時是 LIFF 小網頁的 API 與 Messaging API 的 Webhook。
 *
 * 前端用 Content-Type: text/plain 送 POST，避免 CORS 預檢（Apps Script 不處理 OPTIONS）。
 * Apps Script 讀不到 HTTP header，無法驗證 X-Line-Signature，所以 Webhook 只做回覆
 * （偽造事件也只會拿到無效的 replyToken），所有會改變資料的動作都走 API 並驗證 ID token。
 */

function doGet() {
  return json_({ ok: true, service: 'EarlyOffSystem' });
}

function doPost(e) {
  var body;
  try {
    body = JSON.parse(e.postData.contents);
  } catch (err) {
    return json_({ ok: false, code: 'BAD_REQUEST', error: '格式錯誤' });
  }
  if (body && Array.isArray(body.events)) {
    try {
      handleWebhook_(body.events);
    } catch (err) {
      console.error(err && err.stack || err);
    }
    return ContentService.createTextOutput('OK');
  }
  return json_(handleApi_(body || {}));
}

function json_(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj)).setMimeType(ContentService.MimeType.JSON);
}

function handleWebhook_(events) {
  events.forEach(function (ev) {
    if (!ev.replyToken) return;
    if (ev.type === 'follow') {
      reply_(ev.replyToken, [textMsg_(
        '歡迎使用提前下班／加班申請。\n第一次使用請點下方選單任一項，依畫面選擇您的名字完成綁定；' +
        '管理者確認後就可以開始申請。')]);
    } else if (ev.type === 'message') {
      reply_(ev.replyToken, [textMsg_(
        '請使用下方選單操作：\n・我想提前下班：送出申請\n・申請加班：事前申請或事後補登，由主管核准\n・我的申請：查看進度、取消、重新分享')]);
    }
  });
}
