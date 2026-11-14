/**
 * 加班申請規則。純函式，不碰 Apps Script 服務，可以在 Node 測試。
 * 狀態沿用 Rules.js 的 STATUS：待主管決定 → 已核准／已駁回／已取消。
 * 加班一律由主管核准，不經同仁同意。
 */

var OT_REASON_MAX = 200;

/** 'yyyy-MM-dd' 往前（負數）或往後推 n 天。 */
function addDays(date, n) {
  var p = date.split('-').map(Number);
  var d = new Date(Date.UTC(p[0], p[1] - 1, p[2] + n));
  return d.getUTCFullYear() + '-' + pad2(d.getUTCMonth() + 1) + '-' + pad2(d.getUTCDate());
}

/** 可以申請加班的日期：今天往前 backDays 天，新到舊。 */
function overtimeDates(today, backDays) {
  var out = [];
  for (var i = 0; i <= backDays; i++) out.push(addDays(today, -i));
  return out;
}

/** 這筆加班還算數（會佔用時段）：待主管決定或已核准。 */
function isLiveOvertime(ot) {
  return ot.status === STATUS.SUPERVISOR || ot.status === STATUS.APPROVED;
}

/** 表單的預設時段：有排班 → 表定下班起 30 分鐘；休假 → 空白。 */
function overtimeDefaults(shift) {
  if (!isWorking(shift)) return { start: '', end: '' };
  return { start: minToHm(shift.end), end: minToHm(Math.min(shift.end + 30, 23 * 60 + 59)) };
}

/**
 * 能不能送出加班申請。
 * ctx: {now, date, shift: 當天班表|null, startMin, endMin, reason, backDays, existing: [當天自己的加班]}
 * existing 的 start / end 是分鐘。回傳 {ok: true} 或 {ok: false, reason}
 */
function checkCanApplyOvertime(ctx) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(ctx.date || '')) return { ok: false, reason: '請選擇日期。' };
  if (ctx.date > ctx.now.date) return { ok: false, reason: '不能申請未來日期的加班。' };
  if (ctx.date < addDays(ctx.now.date, -ctx.backDays)) {
    return { ok: false, reason: '只能補登 ' + ctx.backDays + ' 天內的加班，更早的請直接找主管。' };
  }
  var s = ctx.startMin, e = ctx.endMin;
  if (typeof s !== 'number' || typeof e !== 'number' || isNaN(s) || isNaN(e)) {
    return { ok: false, reason: '請填寫加班開始與結束時間。' };
  }
  if (e <= s) return { ok: false, reason: '結束時間要晚於開始時間（不支援跨日加班）。' };
  if (!String(ctx.reason || '').trim()) return { ok: false, reason: '請填寫加班原因。' };
  var sh = ctx.shift;
  if (isWorking(sh) && s < sh.end && e > sh.start) {
    return { ok: false, reason: '加班時段不能和表定上班時間（' + minToHm(sh.start) + '–' + minToHm(sh.end) + '）重疊。' };
  }
  var mine = ctx.existing || [];
  for (var i = 0; i < mine.length; i++) {
    var o = mine[i];
    if (isLiveOvertime(o) && s < o.end && e > o.start) {
      return { ok: false, reason: '和您當天另一筆加班申請（' + minToHm(o.start) + '–' + minToHm(o.end) + '）時段重疊。' };
    }
  }
  return { ok: true };
}

/** 主管能不能決定這筆加班。 */
function checkCanDecideOvertime(ot, supervisorEmpId) {
  if (ot.status !== STATUS.SUPERVISOR) {
    return { ok: false, reason: '這筆加班申請目前是「' + ot.status + '」，不需要決定。' };
  }
  if (ot.empId === supervisorEmpId) return { ok: false, reason: '不能決定自己的加班申請，請由其他主管決定。' };
  return { ok: true };
}

/** 申請人能不能取消加班申請（主管決定前才可以）。 */
function checkCanCancelOvertime(ot) {
  if (ot.status !== STATUS.SUPERVISOR) {
    return { ok: false, reason: '這筆加班申請已經' + ot.status + '，無法取消。' };
  }
  return { ok: true };
}
