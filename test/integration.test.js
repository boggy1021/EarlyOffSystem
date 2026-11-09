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

  let v = call('uE5', 'agree', { id });                   // 戊 7-3：不同班
  assert.equal(v.data.counted, false);
  assert.match(v.data.reason, /不在這一班/);
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
  assert.equal(raw({ action: 'me', idToken: 'bad' }).code, 'TOKEN');
  assert.equal(raw({ action: 'nope', idToken: 'tok:uE1' }).code, 'BAD_REQUEST');
  const out = ctx.doPost({ postData: { contents: JSON.stringify({ events: [{ type: 'follow', replyToken: 'r1' }] }) } });
  assert.equal(out.s, 'OK');
  assert.match(pushes[0].url, /reply$/);
});

test('沒有未預期的伺服器錯誤', () => {
  assert.deepEqual(errors, []);
});
