# EarlyOffSystem

LINE 提前下班申請系統。規格見 `提前下班申請系統 規格書.md`，部署步驟見 `部署步驟.md`。

## 架構
- `src/`：Google Apps Script（clasp 推送）。同一個網頁應用程式 `/exec` 同時是 LIFF 的 JSON API 和 Messaging API Webhook（`doPost` 依 body 有沒有 `events` 分流）。
- `liff/`：LIFF 前端，GitHub Actions 部署到 GitHub Pages。Apps Script 的 HtmlService 跑在 googleusercontent iframe 裡，`liff.init` / `shareTargetPicker` 不可靠，所以前端不放在 Apps Script。
- 資料：Apps Script 綁定的 Google 試算表，六個工作表（員工、班表、申請、同意紀錄、通報紀錄、設定）。欄位依表頭名稱對應（`Repo.js` 的 `TABLES`）。

## 檔案分工
- 純邏輯（可在 Node 測試，不能呼叫 Apps Script 服務）：`ShiftConfig.js`、`Shift.js`、`Rules.js`。
- `Shift.js` / `ShiftConfig.js` 移植自 `../OvertimeSalary/loaders.py`、`config.py`。**加班費專案改班別或班別修訂時，這裡要同步改**，然後跑 `npm run parity`。
- `Api.js`：所有 API 動作；每個動作都先驗證 LIFF ID token，再在 script lock 內執行。
- `Repo.js`：試算表讀寫；日期、時間以「yyyy-MM-dd」「HH:mm」文字存放。

## 規則重點（實作決策）
- 同一班 = 比對上下班時間相同。比對時間用**沒有 ▲ 提早**的時段，所以開門班和同班別的人算同一班；「上班時間／下班時間」欄存實際排定時段。
- 失效時間 = min(申請時間 + 逾時分鐘, 表定下班)。
- 同班可同意的人（已綁定、未核准）少於門檻時，不能申請，提示直接問主管（規格待決事項 3）。
- 通知主管：通知所有已綁定的主管，最先決定者為準；已核准的申請在表定下班前仍可被通報；主管核准後不能再通報。追加通報不再推播。
- 綁定由管理者在「員工」表把「綁定狀態」改成「已確認」，不推播。
- Webhook 無法驗證簽章（Apps Script 讀不到 header），所以只做回覆；會改資料的動作都走 API。

## 開發
- Node 在 `C:\Program Files\nodejs`（Git Bash 可能需要 `export PATH="/c/Program Files/nodejs:$PATH"`）。
- `npm test`：單元、整合（`test/gas-mock.js` 是記憶體版 Apps Script 服務）、比對測試。
- `npm run check`：語法檢查與全域名稱重複檢查（Apps Script 所有檔案共用全域範圍）。
- `npm run parity`：用加班費專案的 Python 解析整份排班表，和 JS 逐格比對。輸出的 `test/fixtures/` 含人名，已 gitignore。
- `npm run push`：檢查、測試通過才 `clasp push`。
- 新增 src 檔案時，整合測試會自動載入；純邏輯檔另外加進 `test/load.js`。
