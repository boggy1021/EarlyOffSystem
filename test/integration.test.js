// 用記憶體版 Apps Script 服務跑完整流程（API → 試算表 → 推播）。
const test = require('node:test');
const assert = require('node:assert/strict');
const { createEnv } = require('./gas-mock');

const errors = [];

function setup() {
  const env = createEnv({ onError: (...a) => errors.push(a.join(' ')) });
  const { ctx } = env;
  ctx.setupSheets();
  // 員工：甲～己是護理師、庚是主管（不在班表上）、辛還沒綁定
  const people = [['E1', '甲'], ['E2', '乙'], ['E3', '丙'], ['E4', '丁'], ['E5', '戊'], ['E6', '己']];
  ctx.appendMany_(ctx.TABLES.EMP, people.map(([id, name], i) => ({
    empId: id, name, userId: 'u' + id, bindStatus: '已確認', role: '護理師'
  })).concat([
    { empId: 'S1', name: '庚', userId: 'uS1', bindStatus: '已確認', role: '主管' },
    { empId: 'E7', name: '辛', bindStatus: '未綁定', role: '護理師' }
  ]));
  // 班表（11/10）：甲乙丙 7-5、丁 ▲7-5（開門）、戊 7-3、己休、陌生人 V
  const d = (day) => new Date(2015, 10, day);
  const grid = [
    [115, '年', 11, '月'], [], [],
    ['日 期', d(10)], ['星期姓名', 2],
    ['甲', '7-5'], ['乙', '7-5'], ['丙', '7-5'], ['丁', '▲\n7-5'], ['戊', '7-3'], ['己', 'off'],
    ['兼 職', 'V'], ['▲需來開門', null]
  ];
  ctx.readXlsxSheet_ = () => grid;
  const imp = ctx.importSchedule('fileid', '11511');
  const call = (uid, action, extra = {}) =>
    JSON.parse(ctx.doPost({ postData: { contents: JSON.stringify({ action, idToken: 'tok:' + uid, ...extra }) } }).s);
  const at = (hhmm) => {
    const [h, m] = hhmm.split(':').map(Number);
    env.clock.now = Date.UTC(2026, 10, 10, h - 8, m);
  };
  return { ...env, call, at, imp };
}

const pushText = (p) => JSON.stringify(p.body);

test('匯入班表：新增陌生員工、V 列為無法辨識', () => {
  const { ctx, imp } = setup();
  assert.match(imp.message, /寫入 6 筆/);         // 5 個上班 + 1 個 V
  assert.match(imp.message, /新增員工 1 位.*兼職/s);
  assert.match(imp.message, /V × 1/);
  const sched = ctx.readAll_(ctx.TABLES.SCHED);
  const ding = sched.find((r) => r.name === '丁');
  assert.deepEqual([ding.start, ding.end, ding.baseStart, ding.baseEnd, ding.note], ['06:45', '16:45', '06:50', '16:50', '開門']);
  // 重匯同月不會重複
  ctx.importSchedule('fileid', '11511');
  assert.equal(ctx.readAll_(ctx.TABLES.SCHED).length, 6);
});

test('一般流程：申請 → 不算數的同意 → 兩票核准 → 推播申請人', () => {
  const { call, at, pushes } = setup();
  at('15:00');
  let me = call('uE1', 'me');
  assert.equal(me.ok, true);
  assert.equal(me.data.canApply.ok, true);
  assert.equal(me.data.eligibleCount, 3);                // 乙、丙、丁（▲ 開門班算同一班）
  assert.equal(me.data.shift.start, '06:50');

  const ap = call('uE1', 'apply');
  assert.equal(ap.ok, true, ap.error);
  const id = ap.data.request.id;
  assert.match(JSON.stringify(ap.data.flex), /liff\.line\.me\/liff-1\?page=agree&id=/);
  assert.equal(ap.data.request.expiresAt, '15:30');
  assert.equal(call('uE1', 'apply').code, 'DENIED');      // 同時只能一筆

  let v = call('uE5', 'agree', { id });                   // 戊 7-3：14:50 已下班
  assert.equal(v.data.counted, false);
  assert.match(v.data.reason, /已過下班時間/);
  v = call('uE6', 'agree', { id });                       // 己：休假
  assert.match(v.data.reason, /休假/);
  v = call('uE1', 'agree', { id });                       // 本人
  assert.match(v.data.reason, /本人/);
  v = call('uE2', 'agree', { id });
  assert.equal(v.data.counted, true);
  assert.equal(v.data.request.countedVotes, 1);
  v = call('uE2', 'agree', { id });                       // 重複
  assert.equal(v.data.counted, false);
  assert.equal(pushes.length, 0);
  v = call('uE4', 'agree', { id });                       // 丁（開門）→ 第 2 票
  assert.equal(v.data.counted, true);
  assert.equal(v.data.request.status, '已核准');
  assert.equal(pushes.length, 1);
  assert.equal(pushes[0].body.to, 'uE1');
  assert.match(pushText(pushes[0]), /已核准/);

  v = call('uE3', 'agree', { id });                       // 結案後
  assert.equal(v.data.counted, false);
  // 已核准的人不能再同意別人：丙申請，甲同意不算
  const ap2 = call('uE3', 'apply');
  assert.equal(ap2.ok, true, ap2.error);
  v = call('uE1', 'agree', { id: ap2.data.request.id });
  assert.match(v.data.reason, /已核准提前下班/);
});

test('通知主管：已核准也可凍結、主管看得到通報人、申請人看不到', () => {
  const { call, at, pushes } = setup();
  at('15:00');
  const id = call('uE1', 'apply').data.request.id;
  call('uE2', 'agree', { id });
  call('uE4', 'agree', { id });                           // 核准
  pushes.length = 0;
  at('15:10');
  const view = call('uE3', 'view', { id });
  assert.equal(view.data.canReport.ok, true);
  const r = call('uE3', 'report', { id, reason: '病房還很忙' });
  assert.equal(r.ok, true, r.error);
  assert.equal(r.data.request.status, '待主管決定');
  assert.equal(pushes.length, 1);
  assert.equal(pushes[0].body.to, 'uS1');
  assert.match(pushText(pushes[0]), /丙：病房還很忙/);
  assert.match(pushText(pushes[0]), /page=decide/);

  // 追加通報不再推播
  call('uE2', 'report', { id });
  assert.equal(pushes.length, 1);
  // 凍結中的同意照記，但不核准
  const mine = call('uE1', 'me');
  assert.equal(mine.data.requests[0].status, '待主管決定');
  assert.doesNotMatch(JSON.stringify(mine), /丙|乙/);     // 申請人看不到通報人

  assert.equal(call('uE2', 'decideView', { id }).code, 'DENIED');   // 非主管
  const dv = call('uS1', 'decideView', { id });
  assert.equal(dv.data.reports.length, 2);
  assert.deepEqual(dv.data.voters, ['乙', '丁']);
  const dec = call('uS1', 'decide', { id, approve: false });
  assert.equal(dec.data.request.status, '已駁回');
  assert.equal(pushes.length, 2);
  assert.equal(pushes[1].body.to, 'uE1');
  assert.doesNotMatch(pushText(pushes[1]), /丙|乙/);
  assert.equal(call('uS1', 'decide', { id, approve: true }).code, 'DENIED');   // 已決定
  assert.equal(call('uS1', 'decideView', { id }).data.decided.decision, '不准');
  // 被駁回後可以重新申請
  assert.equal(call('uE1', 'me').data.canApply.ok, true);
});

test('進行中被通報 → 之後的同意不會觸發核准；主管核准後不能再通報', () => {
  const { call, at } = setup();
  at('15:00');
  const id = call('uE1', 'apply').data.request.id;
  call('uE3', 'report', { id });
  call('uE2', 'agree', { id });
  const v = call('uE4', 'agree', { id });
  assert.equal(v.data.counted, true);
  assert.equal(v.data.request.status, '待主管決定');
  call('uS1', 'decide', { id, approve: true });
  const r = call('uE2', 'report', { id });
  assert.equal(r.code, 'DENIED');
});

test('在班但比申請人早下班的同仁不算（不會留守）', () => {
  const { call, at, pushes } = setup();
  at('14:40');
  const me = call('uE1', 'me');
  assert.equal(me.data.eligibleCount, 3);                 // 乙丙丁；7-3 的戊 14:50 就下班
  const id = call('uE1', 'apply').data.request.id;
  const v5 = call('uE5', 'agree', { id });
  assert.equal(v5.data.counted, false);
  assert.match(v5.data.reason, /早於申請人/);
  call('uE2', 'agree', { id });
  const v = call('uE4', 'agree', { id });                 // 丁 ▲7-5：比較沒提早的下班時間，算
  assert.equal(v.data.request.status, '已核准');
  assert.equal(pushes.length, 1);
});

test('逾時與表定下班上限', () => {
  const { call, at } = setup();
  at('15:00');
  const a = call('uE2', 'apply').data.request;
  at('15:31');
  assert.equal(call('uE2', 'me').data.requests[0].status, '已失效');
  assert.equal(call('uE3', 'agree', { id: a.id }).data.counted, false);
  assert.equal(call('uE2', 'me').data.canApply.ok, true);          // 可以重新申請
  at('16:40');
  assert.equal(call('uE2', 'apply').data.request.expiresAt, '16:50');
  at('16:50');
  assert.match(call('uE3', 'me').data.canApply.reason, /已過/);
  at('06:40');
  assert.match(call('uE3', 'me').data.canApply.reason, /還沒到/);
});

test('取消與重新分享', () => {
  const { call, at } = setup();
  at('15:00');
  const id = call('uE1', 'apply').data.request.id;
  assert.equal(call('uE2', 'shareCard', { id }).code, 'DENIED');   // 不是自己的
  assert.equal(call('uE1', 'shareCard', { id }).ok, true);
  assert.equal(call('uE1', 'cancel', { id }).data.request.status, '已取消');
  assert.equal(call('uE1', 'shareCard', { id }).code, 'DENIED');
  assert.equal(call('uE1', 'cancel', { id }).code, 'DENIED');
});

test('同職稱：行政人員不能同意護理師，也不計入可同意人數', () => {
  const { ctx, call, at } = setup();
  const emps = ctx.readAll_(ctx.TABLES.EMP);
  ctx.update_(ctx.TABLES.EMP, emps.find((e) => e.name === '丙')._row, { role: '行政人員' });
  at('15:00');
  assert.equal(call('uE1', 'me').data.eligibleCount, 2);              // 乙、丁
  const id = call('uE1', 'apply').data.request.id;
  const v = call('uE3', 'agree', { id });
  assert.equal(v.data.counted, false);
  assert.match(v.data.reason, /只有護理師可以操作/);
  assert.equal(call('uE3', 'report', { id }).code, 'DENIED');          // 通知主管同樣限同職稱
  // 丙（行政人員）自己申請：沒有其他行政人員 → 不能申請
  assert.match(call('uE3', 'me').data.canApply.reason, /同職稱同仁只有 0 位/);
});

test('加班：表單 → 申請推播主管 → 主管核准 → 推播申請人；取消與重疊', () => {
  const { ctx, call, at, pushes } = setup();
  at('16:30');
  const form = call('uE1', 'otForm');
  assert.equal(form.ok, true, form.error);
  assert.equal(form.data.days.length, 8);                 // 今天 + 補登 7 天
  assert.deepEqual(form.data.days[0], {
    date: '2026-11-10', shift: { start: '06:50', end: '16:50' }, defaults: { start: '16:50', end: '17:20' }
  });
  assert.equal(form.data.days[1].shift, null);
  assert.equal(call('uNew', 'otForm').data.bindStatus, '未綁定');

  let ap = call('uE1', 'otApply', { date: '2026-11-10', start: '16:00', end: '17:00', reason: '下機' });
  assert.match(ap.error, /重疊/);
  ap = call('uE1', 'otApply', { date: '2026-11-10', start: '16:50', end: '17:30', reason: '病人延遲下機' });
  assert.equal(ap.ok, true, ap.error);
  assert.equal(ap.data.notified, 1);
  assert.equal(ap.data.overtime.minutes, 40);
  assert.equal(pushes.length, 1);
  assert.equal(pushes[0].body.to, 'uS1');
  assert.match(pushText(pushes[0]), /page=otDecide&id=OT/);
  assert.match(pushText(pushes[0]), /病人延遲下機/);
  const id = ap.data.overtime.id;
  const row = ctx.readAll_(ctx.TABLES.OT)[0];
  assert.deepEqual([row.start, row.end, row.minutes, row.shiftEnd], ['16:50', '17:30', '40', '16:50']);

  assert.match(call('uE1', 'otApply', { date: '2026-11-10', start: '17:00', end: '18:00', reason: 'x' }).error, /另一筆/);
  assert.equal(call('uE1', 'me').data.overtimes[0].status, '待主管決定');
  assert.equal(call('uE2', 'otDecideView', { id }).code, 'DENIED');      // 非主管
  assert.equal(call('uE2', 'otCancel', { id }).code, 'DENIED');          // 不是自己的
  const dv = call('uS1', 'otDecideView', { id });
  assert.equal(dv.data.canDecide.ok, true);
  const dec = call('uS1', 'otDecide', { id, approve: true });
  assert.equal(dec.data.overtime.status, '已核准');
  assert.equal(dec.data.overtime.decidedBy, '庚');
  assert.equal(pushes.length, 2);
  assert.equal(pushes[1].body.to, 'uE1');
  assert.match(pushText(pushes[1]), /已核准您的加班申請（11\/10 16:50–17:30）/);
  assert.equal(call('uS1', 'otDecide', { id, approve: false }).code, 'DENIED');
  assert.equal(call('uE1', 'otCancel', { id }).code, 'DENIED');          // 已核准不能取消

  // 補登休假日（11/09）→ 取消後時段釋出
  const back = call('uE1', 'otApply', { date: '2026-11-09', start: '08:00', end: '12:00', reason: '支援' });
  assert.equal(back.ok, true, back.error);
  assert.equal(back.data.overtime.shift, '');
  assert.equal(call('uE1', 'otCancel', { id: back.data.overtime.id }).data.overtime.status, '已取消');
  assert.equal(call('uE1', 'otApply', { date: '2026-11-09', start: '08:00', end: '12:00', reason: '支援' }).ok, true);
  assert.match(call('uE1', 'otApply', { date: '2026-11-02', start: '08:00', end: '09:00', reason: 'x' }).error, /7 天內/);
  assert.equal(call('uE1', 'me').data.overtimes.length, 3);
});

test('加班審核人：「加班審核」為是的護理師也收得到、能核准，但不能審自己的；提前下班仍是護理師', () => {
  const { ctx, call, at, pushes } = setup();
  const emps = ctx.readAll_(ctx.TABLES.EMP);
  ctx.update_(ctx.TABLES.EMP, emps.find((e) => e.name === '乙')._row, { otApprover: '是' });
  at('16:30');
  const ap = call('uE1', 'otApply', { date: '2026-11-10', start: '16:50', end: '17:30', reason: '下機' });
  assert.equal(ap.data.notified, 2);                                     // 庚（主管）＋乙
  assert.deepEqual(pushes.map((p) => p.body.to).sort(), ['uE2', 'uS1']);
  const id = ap.data.overtime.id;
  assert.equal(call('uE3', 'otDecideView', { id }).code, 'DENIED');      // 一般護理師不行
  const dec = call('uE2', 'otDecide', { id, approve: true });
  assert.equal(dec.data.overtime.decidedBy, '乙');
  assert.match(pushText(pushes[pushes.length - 1]), /乙 已核准您的加班申請/);
  // 乙自己申請：只通知主管，乙不能審自己的
  const own = call('uE2', 'otApply', { date: '2026-11-10', start: '16:50', end: '17:30', reason: '下機' });
  assert.equal(own.data.notified, 1);
  assert.equal(call('uE2', 'otDecide', { id: own.data.overtime.id, approve: true }).code, 'DENIED');
  // 提前下班的同意資格不受影響：乙仍是護理師，可以同意甲
  assert.equal(call('uE1', 'me').data.eligibleCount, 3);
  assert.equal(call('uE2', 'decideView', { id }).code, 'DENIED');        // 提前下班的主管頁仍限主管
});

test('綁定：選名字 → 待確認 → 不能使用；已確認後不能改', () => {
  const { ctx, call, at } = setup();
  at('15:00');
  const opts = call('uNew', 'bindOptions');
  assert.equal(opts.data.bindStatus, '未綁定');
  assert.deepEqual(opts.data.options.map((o) => o.name).sort(), ['兼職', '辛'].sort());
  assert.equal(call('uNew', 'apply').code, 'NOT_BOUND');
  assert.equal(call('uNew', 'bind', { empIdOrName: '甲' }).code, 'DENIED');   // 已被綁定
  let b = call('uNew', 'bind', { empIdOrName: '兼 職' });
  assert.equal(b.data.bindStatus, '待確認');
  b = call('uNew', 'bind', { empIdOrName: 'E7' });                         // 選錯改選
  assert.equal(b.data.bindName, '辛');
  const emps = ctx.readAll_(ctx.TABLES.EMP);
  assert.equal(emps.find((e) => e.name === '兼職').userId, '');
  assert.equal(emps.find((e) => e.name === '辛').lineName, 'LINE-uNew');
  assert.equal(call('uNew', 'apply').code, 'BIND_PENDING');
  assert.equal(call('uNew', 'me').data.bindStatus, '待確認');
  assert.equal(call('uE1', 'bind', { empIdOrName: 'E7' }).code, 'DENIED');  // 已確認的人不能改
});

test('ID token 無效、未知動作、Webhook', () => {
  const { ctx, pushes } = setup();
  const raw = (body) => JSON.parse(ctx.doPost({ postData: { contents: JSON.stringify(body) } }).s);
  assert.equal(raw({ action: 'me', idToken: 'expired' }).code, 'TOKEN');
  const bad = raw({ action: 'me', idToken: 'bad' });
  assert.equal(bad.code, 'AUTH_CONFIG');
  assert.match(bad.error, /Invalid IdToken Audience/);
  assert.equal(raw({ action: 'nope', idToken: 'tok:uE1' }).code, 'BAD_REQUEST');
  const out = ctx.doPost({ postData: { contents: JSON.stringify({ events: [{ type: 'follow', replyToken: 'r1' }] }) } });
  assert.equal(out.s, 'OK');
  assert.match(pushes[0].url, /reply$/);
});

test('沒有未預期的伺服器錯誤', () => {
  assert.deepEqual(errors, []);
});
