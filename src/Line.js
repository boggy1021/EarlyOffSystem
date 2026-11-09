/**
 * LINE Messaging API：推播、回覆，以及 Flex 卡片。
 */

function lineApi_(path, payload) {
  var res = UrlFetchApp.fetch('https://api.line.me/v2/bot/message/' + path, {
    method: 'post',
    contentType: 'application/json',
    headers: { Authorization: 'Bearer ' + prop_('CHANNEL_ACCESS_TOKEN') },
    payload: JSON.stringify(payload),
    muteHttpExceptions: true
  });
  var code = res.getResponseCode();
  if (code !== 200) {
    console.error('LINE ' + path + ' 失敗 ' + code + '：' + res.getContentText());
    return false;
  }
  return true;
}

/** 推播（計入每月額度）。失敗只記錄，不中斷流程；申請人仍可在小網頁看到結果。 */
function push_(userId, messages) {
  if (!userId) return false;
  return lineApi_('push', { to: userId, messages: messages });
}

/** 回覆（不計入額度）。 */
function reply_(replyToken, messages) {
  return lineApi_('reply', { replyToken: replyToken, messages: messages });
}

function liffUrl_(page, reqId) {
  return 'https://liff.line.me/' + prop_('LIFF_ID') + '?page=' + page + (reqId ? '&id=' + encodeURIComponent(reqId) : '');
}

function textMsg_(text) {
  return { type: 'text', text: text };
}

function flexText_(text, opt) {
  var o = { type: 'text', text: String(text), wrap: true };
  Object.keys(opt || {}).forEach(function (k) { o[k] = opt[k]; });
  return o;
}

function flexRow_(label, value) {
  return {
    type: 'box', layout: 'baseline', spacing: 'sm',
    contents: [
      flexText_(label, { size: 'sm', color: '#888888', flex: 2 }),
      flexText_(value, { size: 'sm', color: '#333333', flex: 5 })
    ]
  };
}

function uriButton_(label, uri, style) {
  return { type: 'button', style: style || 'primary', height: 'sm',
           action: { type: 'uri', label: label, uri: uri } };
}

/** 申請人分享到群組的卡片。 */
function shareCard_(req, cfg) {
  return {
    type: 'flex',
    altText: req.name + ' 申請提前下班',
    contents: {
      type: 'bubble',
      body: {
        type: 'box', layout: 'vertical', spacing: 'sm',
        contents: [
          flexText_('提前下班申請', { weight: 'bold', size: 'sm', color: '#06C755' }),
          flexText_(req.name, { weight: 'bold', size: 'xl', margin: 'md' }),
          flexRow_('班別', minToHm(req.start) + '–' + minToHm(req.end)),
          flexRow_('申請時間', fmt_(new Date(req.createdMs), 'HH:mm')),
          flexText_('需要 ' + cfg.threshold + ' 位在班同仁同意；' +
                    fmt_(new Date(req.expiresMs), 'HH:mm') + ' 前有效。',
                    { size: 'xs', color: '#999999', margin: 'md' })
        ]
      },
      footer: {
        type: 'box', layout: 'horizontal', spacing: 'sm',
        contents: [
          uriButton_('同意', liffUrl_('agree', req.id), 'primary'),
          uriButton_('通知主管', liffUrl_('report', req.id), 'secondary')
        ]
      }
    }
  };
}

/** 推播給主管的卡片（主管看得到通報人）。 */
function supervisorCard_(req, countedVotes, reports) {
  var reportLines = reports.map(function (r) {
    return r.reporterName + (r.reason ? '：' + r.reason : '');
  }).join('\n');
  return {
    type: 'flex',
    altText: '提前下班申請需要您決定：' + req.name,
    contents: {
      type: 'bubble',
      body: {
        type: 'box', layout: 'vertical', spacing: 'sm',
        contents: [
          flexText_('提前下班申請・需要主管決定', { weight: 'bold', size: 'sm', color: '#E67E22' }),
          flexText_(req.name, { weight: 'bold', size: 'xl', margin: 'md' }),
          flexRow_('班別', minToHm(req.start) + '–' + minToHm(req.end)),
          flexRow_('申請時間', fmt_(new Date(req.createdMs), 'HH:mm')),
          flexRow_('已同意', countedVotes + ' 人'),
          flexRow_('通報', reportLines || '—')
        ]
      },
      footer: {
        type: 'box', layout: 'vertical',
        contents: [uriButton_('查看並決定', liffUrl_('decide', req.id), 'primary')]
      }
    }
  };
}
