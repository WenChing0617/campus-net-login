const $ = (id) => document.getElementById(id);

const pad = (n) => String(n).padStart(2, '0');

function fmtTime(ts) {
  if (!ts) return '—';
  const d = new Date(ts);
  const today = new Date();
  const same = d.toDateString() === today.toDateString();
  const t = pad(d.getHours()) + ':' + pad(d.getMinutes());
  if (same) return '今天 ' + t;
  const tomorrow = new Date(today.getTime() + 86400000);
  if (d.toDateString() === tomorrow.toDateString()) return '明天 ' + t;
  return pad(d.getMonth() + 1) + '-' + pad(d.getDate()) + ' ' + t;
}

/* 学号打码：只留首尾各 2 位（太短就全打码），既能辨认又不把完整账号摆出来 */
function maskUser(u) {
  const s = String(u || '');
  if (s.length <= 4) return '*'.repeat(s.length || 1);
  return s.slice(0, 2) + '*'.repeat(s.length - 4) + s.slice(-2);
}

function fmtStamp(ts) {
  if (!ts) return '—';
  const d = new Date(ts);
  const today = new Date();
  const t = pad(d.getHours()) + ':' + pad(d.getMinutes()) + ':' + pad(d.getSeconds());
  return d.toDateString() === today.toDateString() ? t : pad(d.getMonth() + 1) + '-' + pad(d.getDate()) + ' ' + t;
}

function send(msg) {
  return new Promise((resolve) => {
    chrome.runtime.sendMessage(msg, (res) => {
      void chrome.runtime.lastError;
      resolve(res || null);
    });
  });
}

/* 1.16.0：认证到期倒计时。
 * 到期时刻由后台算好放在 state.expiryAt（= 上次成功认证 + 设置的「单次认证有效期」），
 * 这里只管把它变成「还剩多久」往下走秒。 */
function fmtCountdown(ms) {
  if (!Number.isFinite(ms)) return '—';
  const neg = ms < 0;
  let t = Math.abs(Math.floor(ms / 1000));
  const d = Math.floor(t / 86400);
  t -= d * 86400;
  const h = Math.floor(t / 3600);
  t -= h * 3600;
  const mi = Math.floor(t / 60);
  const s = t - mi * 60;
  const clock = pad(h) + ':' + pad(mi) + ':' + pad(s);
  const body = d ? d + ' 天 ' + clock : clock;
  return neg ? '已过期 ' + body : '剩 ' + body;
}

let lastState = null;
let lastSessionMinutes = 0;

function renderExpiry() {
  const el = $('expiry');
  const st = lastState || {};
  if (!(lastSessionMinutes > 0)) {
    el.classList.remove('soon');
    el.textContent = '未启用';
    el.title = '到设置里填「单次认证有效期」就能显示倒计时';
    return;
  }
  if (!st.expiryAt) {
    el.classList.remove('soon');
    el.textContent = '待认证';
    el.title = '还没有成功认证过，先认证一次';
    return;
  }
  const left = st.expiryAt - Date.now();
  el.textContent = fmtCountdown(left);
  el.title = '到期时间：' + new Date(st.expiryAt).toLocaleString();
  /* 只剩 5 分钟以内标红：一眼看出「快到期了，别指望它自己撑住」 */
  el.classList.toggle('soon', left < 5 * 60 * 1000);
}

function render(payload) {
  if (!payload) {
    $('msg').textContent = '后台脚本暂时没有响应，请在扩展管理页重新加载本扩展。';
    return;
  }
  const cfg = payload.config || {};
  const st = payload.state || {};
  lastState = st;
  lastSessionMinutes = Number(cfg.sessionMinutes) || 0;

  const dot = $('dot');
  dot.className = 'dot';
  let pill = '状态未知';
  if (st.paused) pill = '已暂停';
  else if (st.online === true) {
    dot.classList.add('on');
    pill = '网络正常';
  } else if (st.online === false) {
    dot.classList.add('off');
    pill = '需认证';
  }
  $('pill').textContent = pill;

  /* 弹窗里不再显示完整学号：只留首尾各 2 位做辨认，中间打码。
   * 屏幕一开就在别人眼前，没必要把完整账号摆出来。 */
  $('user').textContent = cfg.username ? maskUser(cfg.username) : '未填写';
  const everyN = Number(cfg.intervalDays) || 1;
  $('schedule').textContent = cfg.scheduleEnabled
    ? (everyN > 1 ? '每 ' + everyN + ' 天 ' + cfg.scheduleTimes : '每天 ' + cfg.scheduleTimes)
    : '未启用';
  $('nextRun').textContent = cfg.scheduleEnabled && !st.paused ? fmtTime(st.nextRunAt) : '—';
  $('loginAt').textContent = fmtStamp(st.lastLoginAt);
  $('checkAt').textContent = fmtStamp(st.lastCheckAt);
  $('msg').textContent = st.lastResult || '暂无记录';
  // 探测结论单独一行：出问题时一眼能看出「凭什么说已联网 / 需认证」
  $('checkInfo').textContent = st.lastCheckInfo ? '探测结论：' + st.lastCheckInfo : '—';
  $('btnPause').textContent = st.paused ? '恢复定时' : '暂停定时';

  // 卡住时把页面快照显示出来，方便定位（正常时隐藏）。
  // 点一下可以把这块文字复制走，直接发给开发者就能定位门户结构。
  const diag = st.diag || (st.flow && st.flow.diag) || '';
  const diagHtml = st.diagHtml || (st.flow && st.flow.diagHtml) || '';
  const dEl = $('diag');
  const lines = [];
  if (diag) lines.push('页面诊断：' + diag);
  if (diagHtml) lines.push('页面结构（点这里可复制）：' + diagHtml);
  if (lines.length && st.online !== true) {
    dEl.textContent = lines.join('\n');
    dEl.hidden = false;
  } else {
    dEl.hidden = true;
  }
}

/* 点诊断框 = 复制全部诊断信息，省得手选 */
$('diag').addEventListener('click', async () => {
  const text = $('diag').textContent || '';
  if (!text) return;
  try {
    await navigator.clipboard.writeText(text);
    $('diag').title = '已复制到剪贴板';
  } catch (e) {
    /* 忽略 */
  }
});

async function refresh() {
  render(await send({ type: 'GET_STATUS' }));
}

$('btnCheck').addEventListener('click', async () => {
  $('pill').textContent = '检测中…';
  render(await send({ type: 'CHECK_NOW' }));
});

$('btnLogin').addEventListener('click', async () => {
  $('msg').textContent = '正在认证，几秒后出结果…';
  render(await send({ type: 'LOGIN_NOW' }));
});

/* 不管探测怎么说，都把门户页面开出来（等于主人手动打开网页那条路，只是自动填好表）。
 * 网络明明掉线却被探测误判时，这是最直接的一条路。 */
$('btnOpen').addEventListener('click', async () => {
  $('msg').textContent = '正在打开认证页…';
  render(await send({ type: 'OPEN_PORTAL' }));
});

$('btnPause').addEventListener('click', async () => {
  const cur = await send({ type: 'GET_STATUS' });
  const paused = !(cur && cur.state && cur.state.paused);
  render(await send({ type: 'SET_PAUSED', paused }));
});

$('btnOptions').addEventListener('click', () => {
  chrome.runtime.openOptionsPage();
});

refresh();
// 弹窗开着的时候刷新快一点，关掉就自动停了，不占后台
setInterval(refresh, 2500);
/* 倒计时单独走 1 秒一拍：那只是本地算一下减法，不再去问后台，
 * 所以秒针是滑的，而网络/后台的查询仍然是 2.5 秒一次。 */
setInterval(renderExpiry, 1000);
