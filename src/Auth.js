/**
 * 身分驗證：前端送 LIFF ID token，後端向 LINE 驗證後取得 userId。
 * 不相信前端直接傳來的 userId。
 */

function apiError_(code, message) {
  var e = new Error(message);
  e.apiCode = code;
  return e;
}

/** 驗證 ID token，回傳 {userId, lineName}。結果快取到 token 過期為止（最多 30 分鐘）。 */
function verifyIdToken_(idToken) {
  if (!idToken) throw apiError_('TOKEN', '缺少登入資訊，請重新開啟。');
  var cache = CacheService.getScriptCache();
  var key = 'tok:' + Utilities.base64EncodeWebSafe(
    Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, idToken));
  var hit = cache.get(key);
  if (hit) return JSON.parse(hit);

  var res = UrlFetchApp.fetch('https://api.line.me/oauth2/v2.1/verify', {
    method: 'post',
    payload: { id_token: idToken, client_id: prop_('LOGIN_CHANNEL_ID') },
    muteHttpExceptions: true
  });
  if (res.getResponseCode() !== 200) {
    var desc = '';
    try { desc = JSON.parse(res.getContentText()).error_description || ''; } catch (e) { /* 非 JSON */ }
    console.warn('ID token 驗證失敗 ' + res.getResponseCode() + '：' + res.getContentText());
    if (/expired/i.test(desc)) throw apiError_('TOKEN', '登入已過期，請重新開啟。');
    // 其他原因多半是設定錯誤（例如 LOGIN_CHANNEL_ID 不是 LINE Login channel 的 ID），重新登入也沒用
    throw apiError_('AUTH_CONFIG', '登入驗證失敗：' + (desc || res.getResponseCode()) +
      '。請管理者確認「設定 LINE 金鑰」的 LINE Login Channel ID。');
  }
  var body = JSON.parse(res.getContentText());
  var who = { userId: body.sub, lineName: body.name || '' };
  var ttl = Math.min(1800, Math.floor(body.exp - Date.now() / 1000) - 10);
  if (ttl > 0) cache.put(key, JSON.stringify(who), ttl);
  return who;
}

/** 依 userId 找員工（不限綁定狀態），找不到回傳 null。 */
function employeeByUserId_(userId, emps) {
  emps = emps || employees_();
  for (var i = 0; i < emps.length; i++) if (emps[i].userId === userId) return emps[i];
  return null;
}

/** 依 userId 找已確認綁定的員工；未綁定或待確認時丟出錯誤。 */
function requireEmployee_(userId, emps) {
  var e = employeeByUserId_(userId, emps);
  if (!e) throw apiError_('NOT_BOUND', '您還沒綁定員工身分，請先完成綁定。');
  if (e.bindStatus !== BIND.OK) throw apiError_('BIND_PENDING', '您的綁定還在等待管理者確認。');
  return e;
}
