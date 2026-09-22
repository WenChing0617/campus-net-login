const DEFAULTS = {
  enabled: true,
  username: '',
  password: '',
  operator: '中国电信',
  portalOpenMode: 'gateway',
  portalUrl: 'https://sam.ahpu.edu.cn/portal/portal-main',
  portalFallbackUrl: 'https://sam.ahpu.edu.cn/portal/entry/pc/finish',
  checkUrls: [
    'http://connectivitycheck.platform.hicloud.com/generate_204',
    'http://connect.rom.miui.com/generate_204',
    'http://wifi.vivo.com.cn/generate_204',
    'https://www.baidu.com/favicon.ico'
  ].join('\n'),
  schedule: { enabled: true, times: '08:00', intervalDays: 1 },
  loginOnStartup: true,
  catchUpOnStartup: true,
  probeBeforeLogin: false,
  autoLoginOnPortalPage: true,
  reloginWhenOnline: true,
  backgroundTab: true,
  closeTabOnSuccess: true,
  closeTriggerTabOnSuccess: false,
  notify: true,
  maxAttempts: 2,
  waitAfterSubmitSeconds: 8,
  selectors: { username: '', password: '', submit: '' },
  excludeHosts: [
    'xjwxt.ahpu.edu.cn',
    'jwxt.ahpu.edu.cn',
    'ehall.ahpu.edu.cn',
    'ids.ahpu.edu.cn',
    'cas.ahpu.edu.cn',
    'lib.ahpu.edu.cn',
    'mail.ahpu.edu.cn'
  ].join(','),
  advanced: { enabled: false, url: '', method: 'POST', format: 'form', body: '', successText: '' }
};

const $ = (id) => document.getElementById(id);
const CHECK_IDS = [
  'scheduleEnabled',
  'loginOnStartup',
  'catchUpOnStartup',
  'probeBeforeLogin',
  'autoLoginOnPortalPage',
  'reloginWhenOnline',
  'backgroundTab',
  'closeTabOnSuccess',
  'closeTriggerTabOnSuccess',
  'notify',
  'advEnabled'
];

function load(cfg) {
  $('username').value = cfg.username || '';
  $('password').value = cfg.password || '';
  $('operator').value = cfg.operator || DEFAULTS.operator;
  $('modeGateway').checked = cfg.portalOpenMode !== 'direct';
  $('modeDirect').checked = cfg.portalOpenMode === 'direct';
  $('portalUrl').value = cfg.portalUrl || '';
  $('portalFallbackUrl').value = cfg.portalFallbackUrl || DEFAULTS.portalFallbackUrl;
  $('checkUrls').value = cfg.checkUrls || DEFAULTS.checkUrls;
  $('excludeHosts').value = cfg.excludeHosts || DEFAULTS.excludeHosts;
  $('scheduleEnabled').checked = !!(cfg.schedule || {}).enabled;
  $('scheduleTimes').value = firstTime((cfg.schedule || {}).times) || DEFAULTS.schedule.times;
  $('intervalDays').value = Number((cfg.schedule || {}).intervalDays) || 1;
  $('waitAfterSubmitSeconds').value = cfg.waitAfterSubmitSeconds;
  $('maxAttempts').value = cfg.maxAttempts;
  CHECK_IDS.forEach((id) => {
    if (id === 'scheduleEnabled') return;
    $(id).checked = !!cfg[id];
  });
  const s = cfg.selectors || {};
  $('selUser').value = s.username || '';
  $('selPass').value = s.password || '';
  $('selSubmit').value = s.submit || '';
  const a = cfg.advanced || {};
  $('advUrl').value = a.url || '';
  $('advMethod').value = a.method || 'POST';
  $('advFormat').value = a.format || 'form';
  $('advBody').value = a.body || '';
  $('advSuccess').value = a.successText || '';
}

function normalizeTimes(text) {
  const out = [];
  String(text || '')
    .split(/[\s,，;；]+/)
    .forEach((raw) => {
      const m = raw.trim().match(/^(\d{1,2})[:：](\d{1,2})$/);
      if (!m) return;
      const h = Number(m[1]);
      const mi = Number(m[2]);
      if (h > 23 || mi > 59) return;
      const v = String(h).padStart(2, '0') + ':' + String(mi).padStart(2, '0');
      if (!out.includes(v)) out.push(v);
    });
  return out.join(',');
}

/* 时间输入框（type="time"）只认一个时间。老配置里可能存着多个时间点，
   这里取第一个，免得打开设置页时输入框变空。 */
function firstTime(text) {
  const m = String(text || '').match(/(\d{1,2})[:：](\d{1,2})/);
  if (!m) return '';
  const h = Number(m[1]);
  const mi = Number(m[2]);
  if (h > 23 || mi > 59) return '';
  return String(h).padStart(2, '0') + ':' + String(mi).padStart(2, '0');
}

function collect() {
  const num = (id, d) => {
    const v = Number($(id).value);
    return Number.isFinite(v) && v > 0 ? v : d;
  };
  const cfg = {
    username: $('username').value.trim(),
    password: $('password').value,
    operator: $('operator').value || DEFAULTS.operator,
    portalOpenMode: $('modeDirect').checked ? 'direct' : 'gateway',
    portalUrl: $('portalUrl').value.trim(),
    portalFallbackUrl: $('portalFallbackUrl').value.trim() || DEFAULTS.portalFallbackUrl,
    checkUrls: $('checkUrls').value.trim() || DEFAULTS.checkUrls,
    excludeHosts: $('excludeHosts').value.trim() || DEFAULTS.excludeHosts,
    schedule: {
      enabled: $('scheduleEnabled').checked,
      times: normalizeTimes($('scheduleTimes').value),
      intervalDays: Math.min(30, Math.max(1, Math.round(Number($('intervalDays').value) || 1)))
    },
    waitAfterSubmitSeconds: Math.round(num('waitAfterSubmitSeconds', 8)),
    maxAttempts: Math.round(num('maxAttempts', 2)),
    selectors: {
      username: $('selUser').value.trim(),
      password: $('selPass').value.trim(),
      submit: $('selSubmit').value.trim()
    },
    advanced: {
      enabled: $('advEnabled').checked,
      url: $('advUrl').value.trim(),
      method: $('advMethod').value,
      format: $('advFormat').value,
      body: $('advBody').value,
      successText: $('advSuccess').value.trim()
    }
  };
  CHECK_IDS.forEach((id) => {
    if (id === 'scheduleEnabled' || id === 'advEnabled') return;
    cfg[id] = $(id).checked;
  });
  return cfg;
}

function flash(text, ms) {
  $('saved').textContent = text;
  setTimeout(() => {
    if ($('saved').textContent === text) $('saved').textContent = '';
  }, ms || 4000);
}

async function save() {
  const cfg = collect();
  if (cfg.schedule.enabled && !cfg.schedule.times) {
    alert('定时认证已启用，但时间点没填对。请填一个 24 小时制时间，例如 08:00。');
    $('scheduleTimes').focus();
    return null;
  }
  await chrome.storage.local.set({ config: cfg, state: { retry: null } });
  $('scheduleTimes').value = firstTime(cfg.schedule.times);
  flash('已保存 ' + new Date().toLocaleTimeString());
  return cfg;
}

function send(msg) {
  return new Promise((resolve) => {
    chrome.runtime.sendMessage(msg, (res) => {
      void chrome.runtime.lastError;
      resolve(res || null);
    });
  });
}

function looksLikePortal(text, finalUrl, reqUrl) {
  let sameHost = true;
  try {
    sameHost = new URL(finalUrl).host === new URL(reqUrl).host;
  } catch (e) {
    sameHost = true;
  }
  if (!sameHost) return true;
  const t = String(text || '').toLowerCase();
  return ['登录', '认证', '校园网', 'wlanuserip', 'ac_id', 'srun', 'eportal', '密码'].some((h) => t.includes(h.toLowerCase()));
}

function is204Check(url) {
  return /generate_204|connecttest\.txt|ncsi\.txt|success\.txt|hotspot-detect\.html/i.test(String(url || ''));
}

$('btnTest').addEventListener('click', async () => {
  const urls = $('checkUrls')
    .value.split(/\r?\n/)
    .map((s) => s.trim())
    .filter(Boolean);
  const out = [];
  for (const url of urls) {
    try {
      const res = await fetch(url, { cache: 'no-store', redirect: 'follow', credentials: 'omit' });
      const type = (res.headers.get('content-type') || '').toLowerCase();
      const text = type.includes('text') || type.includes('html') || type.includes('json') ? (await res.text()).slice(0, 4000) : '';
      const finalUrl = res.url || url;
      let sameOrigin = true;
      try {
        sameOrigin = new URL(finalUrl).origin === new URL(url).origin;
      } catch (e) {
        /* 忽略 */
      }
      if (res.status === 204) out.push(url + ' → 204 ✓ 真的通了');
      else if (!sameOrigin) out.push(url + ' → 被跳到 ' + finalUrl + '（网关在拦 → 需要认证）');
      else if (is204Check(url)) out.push(url + ' → HTTP ' + res.status + '（不是 204 → 被网关拦了，需要认证）');
      else if (looksLikePortal(text, finalUrl, url)) out.push(url + ' → 内容像认证页（需要认证）');
      else if (res.ok) out.push(url + ' → HTTP ' + res.status + (res.redirected ? ' 且发生过跳转' : ' 且没有跳转') + '（不能单凭它下结论）');
      else out.push(url + ' → HTTP ' + res.status);
    } catch (e) {
      out.push(url + ' → 失败：' + ((e && e.message) || e));
    }
  }
  alert(
    '判定规则：只有 204 才算「真的通了」；被跳转、被回 200 都算网关在拦。\n\n' + (out.join('\n') || '没有填写探测地址')
  );
});

$('togglePwd').addEventListener('click', () => {
  const el = $('password');
  const show = el.type === 'password';
  el.type = show ? 'text' : 'password';
  $('togglePwd').textContent = show ? '隐藏' : '显示';
});

$('btnSave').addEventListener('click', () => {
  save();
});

$('btnLogin').addEventListener('click', async () => {
  const cfg = await save();
  if (!cfg) return;
  if (!cfg.username || !cfg.password) {
    alert('请先填写账号和密码');
    return;
  }
  flash('正在认证，几秒后出结果…', 20000);
  const res = await send({ type: 'LOGIN_NOW' });
  const st = (res && res.state) || {};
  flash(st.lastResult || '已触发认证', 10000);
});

$('btnReset').addEventListener('click', async () => {
  if (!confirm('把所有设置恢复为默认值？账号密码也会被清空。')) return;
  await chrome.storage.local.set({ config: DEFAULTS, state: { retry: null, lastResult: '', lastResultAt: 0 } });
  load(DEFAULTS);
  flash('已恢复默认');
});

(async () => {
  const box = await chrome.storage.local.get('config');
  const raw = box.config || {};
  const cfg = {
    ...DEFAULTS,
    ...raw,
    schedule: { ...DEFAULTS.schedule, ...(raw.schedule || {}) },
    selectors: { ...DEFAULTS.selectors, ...(raw.selectors || {}) },
    advanced: { ...DEFAULTS.advanced, ...(raw.advanced || {}) }
  };
  load(cfg);
})();
