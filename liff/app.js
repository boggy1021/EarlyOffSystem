/* 提前下班申請 LIFF 前端。依網址參數 page 切換畫面：
 * apply（我想提前下班）、mine（我的申請）、agree（同意）、report（通知主管）、
 * decide（主管決定）、bind（綁定）、overtime（申請加班）、otDecide（主管決定加班）。
 */
(function () {
  'use strict';

  var C = window.APP_CONFIG || {};
  var app = document.getElementById('app');

  // ── 小工具 ───────────────────────────────────────────

  function h(tag, attrs) {
    var el = document.createElement(tag);
    Object.keys(attrs || {}).forEach(function (k) {
      var v = attrs[k];
      if (v === null || v === undefined || v === false) return;
      if (k === 'class') el.className = v;
      else if (k.slice(0, 2) === 'on') el.addEventListener(k.slice(2), v);
      else el.setAttribute(k, v === true ? '' : v);
    });
    for (var i = 2; i < arguments.length; i++) append(el, arguments[i]);
    return el;
  }

  function append(el, child) {
    if (child === null || child === undefined || child === false) return;
    if (Array.isArray(child)) return child.forEach(function (c) { append(el, c); });
    el.appendChild(child.nodeType ? child : document.createTextNode(String(child)));
  }

  function render() {
    app.innerHTML = '';
    for (var i = 0; i < arguments.length; i++) append(app, arguments[i]);
    window.scrollTo(0, 0);
  }

  function msg(kind, text) { return h('div', { class: 'msg ' + kind }, text); }
  function row(k, v) { return h('div', { class: 'row' }, h('span', { class: 'k' }, k), h('span', null, v)); }
  function badge(status) { return h('span', { class: 'badge ' + status }, status); }

  function loading(text) { render(h('p', { class: 'muted center' }, text || '載入中…')); }

  function liffLink(page, id) {
    return 'https://liff.line.me/' + C.LIFF_ID + '?page=' + page + (id ? '&id=' + encodeURIComponent(id) : '');
  }

  function closeButton() {
    if (!liff.isInClient()) return null;
    return h('button', { class: 'secondary', onclick: function () { liff.closeWindow(); } }, '關閉');
  }

  function progress(req) {
    var pct = Math.min(100, Math.round(req.countedVotes / req.threshold * 100));
    return [
      h('div', { class: 'progress' }, h('div', { style: 'width:' + pct + '%' })),
      h('div', { class: 'muted' }, '已同意 ' + req.countedVotes + '／' + req.threshold)
    ];
  }

  function requestCard(req, extra) {
    return h('div', { class: 'card' },
      h('h2', null, req.name, ' ', badge(req.status)),
      row('班別', req.start + '–' + req.end),
      row('申請時間', req.createdAt),
      req.status === '進行中' ? row('有效到', req.expiresAt) : null,
      req.approvedAt && req.status === '已核准' ? row('核准時間', req.approvedAt) : null,
      req.status === '待主管決定' ? h('p', { class: 'muted' }, '已有同仁通知主管，等待主管決定。') : null,
      progress(req),
      extra || null);
  }

  var WEEKDAYS = '日一二三四五六';

  function dateLabel(date, today) {
    var p = date.split('-').map(Number);
    var wd = WEEKDAYS[new Date(Date.UTC(p[0], p[1] - 1, p[2])).getUTCDay()];
    return p[1] + '/' + p[2] + '（' + wd + '）' + (date === today ? ' 今天' : '');
  }

  function overtimeCard(o, extra) {
    return h('div', { class: 'card' },
      h('h2', null, dateLabel(o.date), ' ', badge(o.status)),
      row('班別', o.shift || '沒有排班'),
      row('加班', o.start + '–' + o.end + '（' + o.minutes + ' 分）'),
      row('原因', o.reason),
      row('申請時間', o.createdAt),
      o.decidedAt ? row(o.decidedBy + ' 決定', o.decidedAt) : null,
      extra || null);
  }

  // ── API ──────────────────────────────────────────────

  function api(action, extra) {
    var body = Object.assign({ action: action, idToken: liff.getIDToken() }, extra || {});
    return fetch(C.API_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'text/plain;charset=utf-8' },   // 避免 CORS 預檢
      body: JSON.stringify(body)
    }).then(function (r) { return r.json(); }).then(function (j) {
      if (j.ok) return j.data;
      if (j.code === 'TOKEN' && !retriedLogin()) {
        liff.logout();
        liff.login({ redirectUri: location.href });
        return new Promise(function () {});   // 等待跳轉
      }
      var e = new Error(j.error || '發生錯誤');
      e.code = j.code;
      throw e;
    });
  }

  function retriedLogin() {
    try {
      if (sessionStorage.getItem('relogin')) return true;
      sessionStorage.setItem('relogin', '1');
    } catch (e) { /* 無痕模式等情況 */ }
    return false;
  }

  function showError(e) {
    if (e.code === 'NOT_BOUND') {
      return render(msg('warn', e.message),
        h('button', { onclick: function () { location.href = liffLink('bind'); } }, '前往綁定'));
    }
    if (e.code === 'BIND_PENDING') {
      return render(msg('warn', e.message), h('p', { class: 'muted' }, '管理者確認後就可以使用。'), closeButton());
    }
    render(msg('err', e.message || String(e)), closeButton());
  }

  // ── 分享卡片 ─────────────────────────────────────────

  function share(flex, groupName, after) {
    if (!liff.isApiAvailable('shareTargetPicker')) {
      return Promise.resolve(after(false, '請在手機的 LINE App 裡開啟，才能分享到群組。'));
    }
    // isMultiple: false 只能選一位好友、不會列出群組，所以必須是 true
    return liff.shareTargetPicker([flex], { isMultiple: true }).then(function (res) {
      after(!!res, res ? '' : '您沒有選擇聊天室，申請卡片還沒送出。');
    }).catch(function (e) {
      after(false, '分享失敗：' + (e.message || e));
    });
  }

  function shareResult(req, flex, groupName) {
    return function (ok, err) {
      render(
        ok ? msg('ok', '已送出到群組，等待同仁同意。') : msg('warn', err),
        requestCard(req),
        ok ? h('p', { class: 'muted' }, '核准時會收到官方帳號的通知；也可以在「我的申請」查看進度。') : null,
        !ok ? h('button', { onclick: function () { share(flex, groupName, shareResult(req, flex, groupName)); } },
          '分享到「' + groupName + '」群組') : null,
        closeButton());
    };
  }

  // ── 頁面 ─────────────────────────────────────────────

  var pages = {};

  pages.apply = function () {
    return api('me').then(function (d) {
      if (d.bindStatus !== '已確認') return showBind(d);
      var active = d.requests.filter(function (r) { return r.status === '進行中' || r.status === '待主管決定'; });
      var parts = [h('h1', null, '我想提前下班')];
      parts.push(h('div', { class: 'card' },
        row('姓名', d.employee.name),
        row('今天班別', d.shift ? d.shift.start + '–' + d.shift.end : '沒有排班')));
      if (!d.canApply.ok) {
        parts.push(msg('warn', d.canApply.reason));
        if (active.length) parts.push(requestCard(active[0]),
          h('button', { class: 'secondary', onclick: function () { location.href = liffLink('mine'); } }, '查看我的申請'));
        parts.push(closeButton());
        return render(parts);
      }
      parts.push(h('div', { class: 'card' },
        h('p', null, '送出後請在「群組」分頁勾選「', h('b', null, d.groupName), '」，再按傳送。'),
        h('p', { class: 'muted' }, '接下來在班、可以同意的同仁 ' + d.eligibleCount + ' 位，需要 ' + d.threshold +
          ' 位同意；' + d.timeoutMin + ' 分鐘內未達門檻會自動失效。')));
      var btn = h('button', {
        onclick: function () {
          btn.disabled = true;
          loading('送出中…');
          api('apply').then(function (r) {
            var after = shareResult(r.request, r.flex, r.groupName);
            return share(r.flex, r.groupName, after);
          }).catch(showError);
        }
      }, '送出申請');
      parts.push(btn);
      render(parts);
    });
  };

  pages.mine = function () {
    return api('me').then(function (d) {
      if (d.bindStatus !== '已確認') return showBind(d);
      var parts = [h('h1', null, '我的申請'), h('h2', null, '提前下班（今天）')];
      if (!d.requests.length) parts.push(h('p', { class: 'muted' }, '今天還沒有申請。'));
      d.requests.forEach(function (r) {
        var active = r.status === '進行中' || r.status === '待主管決定';
        parts.push(requestCard(r, active ? [
          h('button', {
            class: 'secondary',
            onclick: function () {
              loading();
              api('shareCard', { id: r.id }).then(function (s) {
                return share(s.flex, s.groupName, function (ok, err) {
                  pages.mine().then(function () {
                    app.insertBefore(ok ? msg('ok', '已重新分享。') : msg('warn', err), app.firstChild);
                  });
                });
              }).catch(showError);
            }
          }, '重新分享到群組'),
          h('button', {
            class: 'danger',
            onclick: function () {
              if (!confirm('確定要取消這筆申請？')) return;
              loading();
              api('cancel', { id: r.id }).then(function () { return pages.mine(); }).catch(showError);
            }
          }, '取消申請')
        ] : null));
      });
      parts.push(h('h2', null, '加班'));
      if (!d.overtimes.length) parts.push(h('p', { class: 'muted' }, '最近沒有加班申請。'));
      d.overtimes.forEach(function (o) {
        parts.push(overtimeCard(o, o.status === '待主管決定' ? h('button', {
          class: 'danger',
          onclick: function () {
            if (!confirm('確定要取消這筆加班申請？')) return;
            loading();
            api('otCancel', { id: o.id }).then(function () { return pages.mine(); }).catch(showError);
          }
        }, '取消加班申請') : null));
      });
      parts.push(closeButton());
      render(parts);
    });
  };

  pages.overtime = function () {
    return api('otForm').then(function (d) {
      if (d.bindStatus !== '已確認') return showBind(d);
      var byDate = {};
      d.days.forEach(function (x) { byDate[x.date] = x; });
      var dateSel = h('select', null, d.days.map(function (x) {
        return h('option', { value: x.date }, dateLabel(x.date, d.today));
      }));
      var shiftInfo = h('p', { class: 'muted' });
      var start = h('input', { type: 'time' });
      var end = h('input', { type: 'time' });
      var reason = h('textarea', { maxlength: '200', placeholder: '例如：病人延遲下機、交班事項多' });
      var pick = function () {
        var x = byDate[dateSel.value];
        shiftInfo.textContent = x.shift
          ? '當天班別 ' + x.shift.start + '–' + x.shift.end + '；加班時段不能和上班時間重疊。'
          : '當天沒有排班（休假加班）。';
        start.value = x.defaults.start;
        end.value = x.defaults.end;
      };
      dateSel.addEventListener('change', pick);
      pick();
      var btn = h('button', {
        onclick: function () {
          if (!start.value || !end.value) return alert('請填寫加班開始與結束時間。');
          if (!reason.value.trim()) return alert('請填寫加班原因。');
          btn.disabled = true;
          api('otApply', { date: dateSel.value, start: start.value, end: end.value, reason: reason.value })
            .then(function (r) {
              render(msg('ok', r.notified ? '已送出，等待審核；核准結果會由官方帳號通知您。'
                                          : '已送出，但目前沒有可通知的審核人，請直接告知主管。'),
                overtimeCard(r.overtime),
                h('button', { class: 'secondary', onclick: function () { location.href = liffLink('mine'); } }, '查看我的申請'),
                closeButton());
            }).catch(function (e) {
              if (e.code !== 'DENIED') return showError(e);
              btn.disabled = false;
              alert(e.message);
            });
        }
      }, '送出加班申請');
      render(
        h('h1', null, '申請加班'),
        h('div', { class: 'card' },
          row('姓名', d.employee.name),
          h('label', null, '日期'), dateSel, shiftInfo,
          h('label', null, '加班開始'), start,
          h('label', null, '加班結束'), end,
          h('label', null, '原因'), reason,
          h('p', { class: 'muted' }, '可事前申請今天的加班，也可補登 ' + d.backDays + ' 天內的加班；送出後由主管或加班審核人（護理長、組長）核准。')),
        btn, closeButton());
    });
  };

  pages.otDecide = function (id) {
    return api('otDecideView', { id: id }).then(function (d) {
      var o = d.overtime;
      var parts = [h('h1', null, '加班申請・審核'), h('p', null, h('b', null, o.name)), overtimeCard(o)];
      if (!d.canDecide.ok) {
        parts.push(msg('warn', d.canDecide.reason));
      } else {
        var go = function (approve) {
          return function () {
            if (!confirm(approve ? '確定核准這筆加班？' : '確定不核准這筆加班？')) return;
            loading('處理中…');
            api('otDecide', { id: id, approve: approve }).then(function (x) {
              render(msg('ok', '已' + (approve ? '核准' : '不核准') + '，系統已通知申請人。'),
                overtimeCard(x.overtime), closeButton());
            }).catch(showError);
          };
        };
        parts.push(h('button', { onclick: go(true) }, '准'),
                   h('button', { class: 'danger', onclick: go(false) }, '不准'));
      }
      parts.push(closeButton());
      render(parts);
    });
  };

  pages.agree = function (id) {
    loading('記錄中…');
    return api('agree', { id: id }).then(function (d) {
      var r = d.request;
      render(
        d.counted ? msg('ok', '已記錄您的同意。') : msg('warn', d.reason),
        r.status === '已核准' && d.counted && r.closeBy === '同仁同意'
          ? msg('ok', '已達門檻，申請核准。') : null,
        requestCard(r),
        closeButton());
    });
  };

  pages.report = function (id) {
    return api('view', { id: id }).then(function (d) {
      var r = d.request;
      if (!d.canReport.ok) return render(msg('warn', d.canReport.reason), requestCard(r), closeButton());
      var reason = h('textarea', { maxlength: '200', placeholder: '例如：病房還很忙（可不填）' });
      var btn = h('button', {
        class: 'danger',
        onclick: function () {
          btn.disabled = true;
          loading('通知中…');
          api('report', { id: id, reason: reason.value }).then(function (x) {
            render(msg('ok', '已通知主管，這筆申請改由主管決定。'), requestCard(x.request), closeButton());
          }).catch(showError);
        }
      }, '確認通知主管');
      render(
        h('h1', null, '通知主管'),
        requestCard(r),
        h('div', { class: 'card' },
          h('p', null, '通知後，這筆申請會暫停，改由主管決定' +
            (r.status === '已核准' ? '（已核准的申請也會改回待主管決定）' : '') + '。'),
          h('p', { class: 'muted' }, '申請人看不到是誰通知的；主管看得到。'),
          h('label', null, '原因（選填）'), reason),
        btn, closeButton());
    });
  };

  pages.decide = function (id) {
    return api('decideView', { id: id }).then(function (d) {
      var r = d.request;
      var parts = [h('h1', null, '主管決定'), requestCard(r)];
      parts.push(h('div', { class: 'card' },
        h('h2', null, '通報'),
        d.reports.length ? d.reports.map(function (x) {
          return h('p', null, h('b', null, x.name), ' ', h('span', { class: 'muted' }, x.at),
            x.reason ? h('div', null, x.reason) : null);
        }) : h('p', { class: 'muted' }, '無'),
        h('h2', null, '已同意'),
        h('p', null, d.voters.length ? d.voters.join('、') : '無')));
      if (d.decided) {
        parts.push(msg('ok', (d.decided.by || '主管') + ' 已於 ' + d.decided.at + ' 決定：' + d.decided.decision));
      } else if (!d.canDecide.ok) {
        parts.push(msg('warn', d.canDecide.reason));
      } else {
        var go = function (approve) {
          return function () {
            if (!confirm(approve ? '確定核准？' : '確定不核准？')) return;
            loading('處理中…');
            api('decide', { id: id, approve: approve }).then(function (x) {
              render(msg('ok', '已' + (approve ? '核准' : '不核准') + '，系統已通知申請人。'),
                requestCard(x.request), closeButton());
            }).catch(showError);
          };
        };
        parts.push(h('button', { onclick: go(true) }, '准'),
                   h('button', { class: 'danger', onclick: go(false) }, '不准'));
      }
      parts.push(closeButton());
      render(parts);
    });
  };

  function showBind(d) {
    if (d.bindStatus === '待確認') {
      return render(msg('warn', '您已申請綁定為「' + d.bindName + '」，等待管理者確認。'),
        h('button', { class: 'secondary', onclick: function () { location.href = liffLink('bind'); } }, '選錯了，重新選擇'),
        closeButton());
    }
    render(msg('warn', '第一次使用請先綁定員工身分。'),
      h('button', { onclick: function () { location.href = liffLink('bind'); } }, '前往綁定'));
  }

  pages.bind = function () {
    return api('bindOptions').then(function (d) {
      if (d.bindStatus === '已確認') {
        return render(msg('ok', '您已綁定為「' + d.bindName + '」。'), closeButton());
      }
      var sel = h('select', null, h('option', { value: '' }, '請選擇'),
        d.options.map(function (o) { return h('option', { value: o.empId }, o.name); }));
      var btn = h('button', {
        onclick: function () {
          var v = sel.value;
          if (!v) return alert('請選擇您的名字。');
          btn.disabled = true;
          api('bind', { empIdOrName: v }).then(function (x) {
            render(msg('ok', '已送出綁定「' + x.bindName + '」，等待管理者確認後即可使用。'), closeButton());
          }).catch(function (e) { btn.disabled = false; alert(e.message); });
        }
      }, '送出');
      render(
        h('h1', null, '綁定員工身分'),
        d.bindStatus === '待確認' ? msg('warn', '目前申請綁定為「' + d.bindName + '」，等待確認中；可以重新選擇。') : null,
        h('div', { class: 'card' }, h('label', null, '我的名字'), sel,
          h('p', { class: 'muted' }, '清單裡找不到自己的名字，或名字已被選走，請找管理者。')),
        btn);
    });
  };

  // ── 啟動 ─────────────────────────────────────────────

  // LINE 小網頁的視窗標題顯示 document.title，依頁面換掉，避免加班頁也寫著「提前下班」
  var TITLES = {
    apply: '提前下班申請', agree: '提前下班申請', report: '提前下班申請', decide: '提前下班申請',
    overtime: '加班申請', otDecide: '加班申請', mine: '我的申請', bind: '綁定員工身分'
  };

  function start() {
    if (!C.LIFF_ID || !C.API_URL) return render(msg('err', '尚未設定 config.js 的 LIFF_ID / API_URL。'));
    liff.init({ liffId: C.LIFF_ID }).then(function () {
      if (!liff.isLoggedIn()) {
        liff.login({ redirectUri: location.href });
        return;
      }
      var q = new URLSearchParams(location.search);
      var page = q.get('page') || 'apply';
      var fn = pages[page];
      if (!fn) return render(msg('err', '未知的頁面：' + page));
      if (TITLES[page]) document.title = TITLES[page];
      if ((page === 'agree' || page === 'report' || page === 'decide' || page === 'otDecide') && !q.get('id')) {
        return render(msg('err', '網址缺少申請編號。'));
      }
      loading();
      return fn(q.get('id'));
    }).then(function () {
      try { sessionStorage.removeItem('relogin'); } catch (e) { /* 忽略 */ }
    }).catch(showError);
  }

  start();
})();
