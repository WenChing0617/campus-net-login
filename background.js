/* 校园网自动登录 —— 后台 service worker
 *
 * 设计原则：**不做实时轮询**，只在四种时机动作：
 *   1. 每天固定的时间点（定时认证）
 *   2. 浏览器启动时（可开关，带错过补偿）
 *   3. 浏览器打开了认证页（内容脚本上报后自动登录）
 *   4. 用户手动点击
 *
 * 分工：后台负责「开认证页 + 调度 + 事后核查」，页面内的多步流程（填表 → 选服务商 →
 * 确定 → 「我知道了」→ 重新点确定重试）由内容脚本自己推进并通过消息回报，避免后台长时间等待被回收。
 */

const ALARM_SCHEDULE = 'campus-schedule';
const ALARM_RETRY = 'campus-retry';
const ALARM_VERIFY = 'campus-verify';
const ALARM_EXPIRY = 'campus-expiry';
const MIN_GAP_MS = 2 * 60 * 1000; // 两次自动尝试之间的最小间隔
const RETRY_DELAY_MIN = 0.5; // 失败后 30 秒重试一次（alarms 未打包扩展的最小粒度）
const FAST_VERIFY_MS = 5000; // 兜底核查：5 秒（页面一般会更早自己报结论）
/* ---------- 1.16.0：高频探测的两条窗口 ----------
 * 主人实测：电信这条线路认证一次大约管 47 小时 49 分 20 秒（会飘 ±20 秒上下）。
 * 靠闹钟精确掐点不可能 —— alarms 最小粒度 30 秒、被系统睡眠拖后更是常有的事。
 * 所以改成「提前叫醒 + 密集探一段」：
 *   · 会话到期：到期前 EXPIRY_LEAD_MS 就叫醒，然后每 EXPIRY_POLL_MS 探一次，
 *     一直探到「到期后 EXPIRY_TAIL_MS」为止 —— 正好把 ±20 秒的偏差包在窗口里。
 *   · 定时到点：提前 SCHEDULE_LEAD_MS 叫醒，在计划时间**前后 30 秒**内密集探
 *     （SCHEDULE_BURST_PROBES 次 × SCHEDULE_BURST_MS）。
 * 探测本身只是几个 generate_204 请求（每个约 0.1~0.3 秒、无副作用），
 * 比「进网页、开标签、跑表单」便宜两个数量级，所以这里用探测换「绝不瞎折腾」。 */
const EXPIRY_LEAD_MS = 60 * 1000; // 到期前 1 分钟开始盯（主人要求「最后一分钟」）
const EXPIRY_TAIL_MS = 120 * 1000; // 到期后再盯 2 分钟，吸收闹钟延迟与时长偏差
const EXPIRY_POLL_MS = 5000; // 盯梢时的探测间隔
const EXPIRY_RETRY_MS = 5 * 60 * 1000; // 到期后还通着（时长估短了）→ 过 5 分钟再看一眼
const EXPIRY_RETRY_MAX = 6; // 重看次数上限，别没完没了（认证成功后清零）
const SCHEDULE_LEAD_MS = 30 * 1000; // 定时闹钟提前 30 秒叫醒
const SCHEDULE_BURST_MS = 5000; // 到点窗口内的探测间隔
const SCHEDULE_BURST_PROBES = 12; // 12 × 5 秒 = 60 秒 ≈ 计划时间前后各 30 秒
const CLOSE_DELAY_MS = 300; // 判定成功后停留这么久再关页面，让人能瞥见结果
const VERIFY_FLOOR_MS = 600; // 核查最短延迟：收到「可能要出结果了」就尽快探一次
const DUPLICATE_WINDOW_MS = 5000; // 5 秒内只收尾一次，避免重复通知
const FLOW_STALE_MS = 6 * 60 * 1000; // 超过这个时间还没结论的流程直接丢弃
/* 「已在线 → 先下线再认证」的宽限期：这一阶段网络本来就是通的（认证还没到期），
 * 拿 204 探测去判「已完成」会让后台在半路收尾、把页面上的下线 + 重新认证打断。
 * 这段时间把结论权交给页面脚本；宽限期到点自动恢复兜底，绝不会永远不收尾。 */
const RELOGIN_GRACE_MS = 90 * 1000;

const DEFAULT_CONFIG = {
  enabled: true,
  /* 通用版：不预置任何人的账号，装好后在设置页填一次即可 */
  username: '',
  password: '',
  operator: '中国电信',
  // gateway：打开网络检测地址，让校园网网关自己带着完整参数（sessionId/userIp/userMac…）跳到门户登录页
  // direct：直接打开下面填写的认证页地址
  portalOpenMode: 'gateway',
  /* 默认按安徽工程大学（Anhui Polytechnic University）配好：sam.ahpu.edu.cn。
   * 换学校时把这两项改成自己学校的就行；不知道填什么就都留空 ——
   * 默认的「让网关自动跳转」模式会自己探测门户地址，不依赖这两个值。 */
  portalUrl: 'https://sam.ahpu.edu.cn/portal/portal-main',
  // 备用入口：网关不跳转、门户地址又刷不出表单时，按顺序再试这个（本校实测能刷出登录表单的地址）
  portalFallbackUrl: 'https://sam.ahpu.edu.cn/portal/entry/pc/finish',
  checkUrls: [
    'http://connectivitycheck.platform.hicloud.com/generate_204',
    'http://connect.rom.miui.com/generate_204',
    'http://wifi.vivo.com.cn/generate_204',
    'https://www.baidu.com/favicon.ico'
  ].join('\n'),
  /* intervalDays：认证周期（天）。
   *   1 = 每天（默认）—— 一天里填的几个时间点都会跑；
   *   N > 1 = 每隔 N 天认证一次 —— 上次认证之后，中间 N-1 天直接跳过，
   *           到第 N 天的时间点才再跑。给那些「认证一次能撑好几天」的运营商用。 */
  schedule: { enabled: true, times: '08:00', intervalDays: 1 },
  loginOnStartup: true,
  catchUpOnStartup: true,
  probeBeforeLogin: false,
  autoLoginOnPortalPage: true,
  /* 认证还没到期时门户不给登录表单，而是直接渲染「已在线」成功页（上面有「我要下线」）。
   * 勾上（默认）：到点**先点「我要下线」**，等门户注销并回到认证页，再把认证重新做一遍 ——
   * 这样认证时长才会真正续上（强制续期，不看网络通不通）。
   * 不勾：改成「按需认证」—— 到点先在计划时间前后 30 秒内高频探测，**没网才认证**、
   * 有网什么都不做；真正把时长续上的活儿交给下面的「到期看门狗」（见 sessionMinutes）。 */
  reloginWhenOnline: true,
  /* 1.16.0：单次认证能管多久（分钟，可以带小数）。
   * 默认 2869.33 分钟 = 47 小时 49 分 20 秒 —— 主人实测的电信这条线路的有效期。
   * 填 0 = 不启用「到期看门狗」和弹窗里的倒计时。
   * 到了这个点前后会自动密集探测：真掉线就立刻重认证，没掉线就安静收手。 */
  sessionMinutes: 2869.33,
  backgroundTab: true,
  closeTabOnSuccess: true,
  closeTriggerTabOnSuccess: false,
  notify: true,
  maxAttempts: 2,
  waitAfterSubmitSeconds: 8,
  selectors: { username: '', password: '', submit: '' },
  /* 1.13.0：这些域名上一律不自动操作（教务系统 / 办事大厅 / 统一身份认证这类校内业务系统）。
   * 逗号分隔，一行一个也行。写 `jwxt.xxx.edu.cn` 只排除它；写 `xxx.edu.cn` 会连门户一起排掉，慎用。
   * 默认按安徽工程大学（Anhui Polytechnic University）列好；换学校请换成自己学校的业务域名，
   * 或者干脆清空 —— 跨校通用的那层「按页面内容」防护（教务 / 选课 / 图书 …）始终生效。 */
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

const DEFAULT_STATE = {
  online: null,
  lastCheckAt: 0,
  lastCheckInfo: '',
  lastCheckConfidence: '',
  lastCheckVia: '',
  lastLoginAt: 0,
  lastLoginDay: '',
  expiryAt: 0, // 1.16.0：认证到期时刻（lastLoginAt + sessionMinutes），弹窗倒计时用
  expiryTries: 0, // 1.16.0：到期后「还通着」的重看次数（认证成功清零）
  lastAttemptAt: 0,
  lastResult: '',
  lastResultAt: 0,
  diag: '',
  diagHtml: '',
  portalHosts: [],
  portalCandidate: '',
  openedTabIds: [], // 1.13.0：本扩展自己打开的标签页，只有它们允许被自动关闭
  nextRunAt: 0,
  paused: false,
  loginTabId: null,
  flow: null,
  retry: null
};

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function todayKey(ts) {
  const d = new Date(ts || Date.now());
  const p = (n) => String(n).padStart(2, '0');
  return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate());
}

async function getConfig() {
  const box = await chrome.storage.local.get('config');
  const c = box.config || {};
  return {
    ...DEFAULT_CONFIG,
    ...c,
    schedule: { ...DEFAULT_CONFIG.schedule, ...(c.schedule || {}) },
    selectors: { ...DEFAULT_CONFIG.selectors, ...(c.selectors || {}) },
    advanced: { ...DEFAULT_CONFIG.advanced, ...(c.advanced || {}) }
  };
}

async function setConfig(patch) {
  const next = { ...(await getConfig()), ...patch };
  await chrome.storage.local.set({ config: next });
  return next;
}

async function getState() {
  const box = await chrome.storage.local.get('state');
  return { ...DEFAULT_STATE, ...(box.state || {}) };
}

/* setState 是「读 → 改 → 写」。后台有多个异步流程（定时、消息、tabs 事件）会同时改状态，
 * 并发读改写会互相覆盖（后写的拿着旧快照把先写的改动抹掉）。串行化掉，保证不丢更新。 */
let stateQueue = Promise.resolve();
function setState(patch) {
  const run = async () => {
    const next = { ...(await getState()), ...patch };
    await chrome.storage.local.set({ state: next });
    return next;
  };
  stateQueue = stateQueue.then(run, run);
  return stateQueue;
}

/* ---------------- 1.13.0：校内业务系统排除名单 ---------------- *
 * 教务系统这类站点同样挂在 .edu.cn 下、同样有登录表单，不能被当成校园网门户。
 * （完整来龙去脉见 content.js 里 PORTAL_STRONG_RE 那段注释。） */
/* 老配置里没存过这一项时的兜底：按安徽工程大学（Anhui Polytechnic University）的业务域名来。
 * 跨校通用的那层防护是页面侧的「排除词」（教务 / 选课 / 图书 …），它按页面内容判定，
 * 换哪所学校都有效 —— 这份域名清单只是给本校用户的一份默认值，换学校可在设置里改掉。 */
const DEFAULT_EXCLUDE_HOSTS = [
  'xjwxt.ahpu.edu.cn',
  'jwxt.ahpu.edu.cn',
  'ehall.ahpu.edu.cn',
  'ids.ahpu.edu.cn',
  'cas.ahpu.edu.cn',
  'lib.ahpu.edu.cn',
  'mail.ahpu.edu.cn'
].join(',');

function hostExcluded(host, cfg) {
  const raw = String((cfg && cfg.excludeHosts) || DEFAULT_EXCLUDE_HOSTS);
  const h = String(host || '').toLowerCase();
  return raw
    .split(/[\s,，;；]+/)
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean)
    .some((d) => h === d || h.endsWith('.' + d));
}

/* ---------------- 1.13.0：只关「本扩展自己打开的」标签页 ---------------- *
 * 为什么必须记这个：页面脚本在**主人自己开的页面**上跑完流程时（页面自启动那条路），
 * 后台补出来的 flow 是 fromTab=false、tabId=主人的标签页，
 * 旧版 closeTabOnSuccess 一看「不是 fromTab」就关 —— 于是教务系统页面会自己消失。
 * 现在改认「这个标签页是不是我开的」，不认 fromTab。 */
let openedTabsCache = null;
async function getOpenedTabs() {
  if (openedTabsCache) return openedTabsCache;
  const st = await getState();
  openedTabsCache = Array.isArray(st.openedTabIds) ? st.openedTabIds.slice(-50) : [];
  return openedTabsCache;
}
async function markOpenedByUs(tabId) {
  if (!tabId) return;
  const list = await getOpenedTabs();
  if (!list.includes(tabId)) {
    list.push(tabId);
    openedTabsCache = list.slice(-50);
  }
  await setState({ openedTabIds: openedTabsCache });
}
async function forgetOpenedTab(tabId) {
  if (!tabId) return;
  const list = await getOpenedTabs();
  openedTabsCache = list.filter((id) => id !== tabId);
  await setState({ openedTabIds: openedTabsCache });
}
/* flow 自己带的 openedByUs 也算数：后台 service worker 重启后内存列表会丢，
 * 而「这一轮是我开的页面」这个事实在 flow 里还留着。 */
async function isOpenedByUs(tabId, f) {
  if (!tabId) return false;
  if (f && f.openedByUs === true) return true;
  return (await getOpenedTabs()).includes(tabId);
}

async function note(text) {
  return await setState({ lastResult: text, lastResultAt: Date.now() });
}

async function updateBadge(st) {
  const s = st || (await getState());
  let text = '';
  let color = '#888780';
  if (s.paused) text = '||';
  else if (s.online === false) {
    text = '!';
    color = '#E24B4A';
  }
  try {
    await chrome.action.setBadgeText({ text });
    if (text) await chrome.action.setBadgeBackgroundColor({ color });
    const cfg = await getConfig();
    const tip = s.paused
      ? '已暂停'
      : s.online === false
        ? '上次检测：未认证'
        : s.online === true
          ? '上次检测：正常'
          : '尚未检测';
    const times = cfg.schedule.enabled ? cfg.schedule.times : '';
    await chrome.action.setTitle({
      title: '校园网自动登录\n' + tip + (times ? '\n定时认证：' + times : '\n定时认证：未启用')
    });
  } catch (e) {
    /* 忽略 */
  }
}

function notify(title, message) {
  try {
    chrome.notifications.create('campus-' + Date.now(), {
      type: 'basic',
      iconUrl: 'icons/icon128.png',
      title,
      message: String(message || '').slice(0, 200)
    });
  } catch (e) {
    /* 忽略 */
  }
}

/* ---------- 时间点解析与排程 ---------- */

function parseTimes(text) {
  const out = [];
  String(text || '')
    .split(/[\s,，;；]+/)
    .forEach((raw) => {
      const m = raw.trim().match(/^(\d{1,2})[:：](\d{2})$/);
      if (!m) return;
      const h = Number(m[1]);
      const mi = Number(m[2]);
      if (h > 23 || mi > 59) return;
      const key = h * 60 + mi;
      if (!out.some((t) => t.key === key)) out.push({ key, h, m: mi });
    });
  return out.sort((a, b) => a.key - b.key);
}

/* 「每 N 天认证一次」的最早可执行时刻：上次成功认证那天的零点 + N 天。
 * N <= 1（每天）时返回 0，表示不额外限制 —— 一天里的几个时间点照旧都会跑。
 * 例：1 号认证过、N=3 → 最早 4 号零点，2、3 号的时间点全部跳过。 */
function earliestByInterval(cfg, st) {
  const n = Number((cfg && cfg.schedule && cfg.schedule.intervalDays) || 1);
  if (!Number.isFinite(n) || n <= 1) return 0;
  if (!st || !st.lastLoginAt) return 0;
  const d = new Date(st.lastLoginAt);
  d.setHours(0, 0, 0, 0);
  d.setDate(d.getDate() + Math.floor(n));
  return d.getTime();
}

function nextOccurrence(times, from, notBeforeTs) {
  if (!times.length) return 0;
  let baseMs = from + 20000;
  if (notBeforeTs && baseMs < notBeforeTs) baseMs = notBeforeTs;
  const base = new Date(baseMs);
  for (const t of times) {
    const d = new Date(base);
    d.setHours(t.h, t.m, 0, 0);
    if (d.getTime() > from) return d.getTime();
  }
  const first = times[0];
  const d = new Date(base);
  d.setDate(d.getDate() + 1);
  d.setHours(first.h, first.m, 0, 0);
  return d.getTime();
}

async function scheduleNext() {
  const cfg = await getConfig();
  try {
    await chrome.alarms.clear(ALARM_SCHEDULE);
  } catch (e) {
    /* 忽略 */
  }
  /* 到期看门狗是独立的一条线：定时关掉时它也要照常挂着 ——
   * 「按需认证」模式下真正把时长续上的就是它（见 expiryFlow）。 */
  await scheduleExpiry();
  if (!cfg.enabled || !cfg.schedule.enabled) {
    await setState({ nextRunAt: 0 });
    await updateBadge();
    return 0;
  }
  const times = parseTimes(cfg.schedule.times);
  if (!times.length) {
    await setState({ nextRunAt: 0 });
    await note('定时时间格式不对，请按 08:00 这样填写');
    return 0;
  }
  const st = await getState();
  const next = nextOccurrence(times, Date.now(), earliestByInterval(cfg, st));
  /* ⚠ 闹钟**提前 30 秒**响，不是掐着计划时间响：闹钟本身有 30~60 秒的粗粒度、
   * 还会被系统睡眠往后拖，掐点必然不准。提前叫醒后再在「计划时间前后 30 秒」里
   * 密集探一遍（见 onAlarm 里 ALARM_SCHEDULE 那段），比闹钟本身准得多。
   * state.nextRunAt 存的仍是**真正的计划时间**，弹窗倒计时照旧按它显示。 */
  chrome.alarms.create(ALARM_SCHEDULE, {
    delayInMinutes: Math.max(0.5, (next - SCHEDULE_LEAD_MS - Date.now()) / 60000)
  });
  await setState({ nextRunAt: next });
  await updateBadge();
  return next;
}

/* ---------- 网络探测（只用于事后核查，不做轮询） ---------- */

function looksLikePortal(text, finalUrl, reqUrl) {
  let sameHost = true;
  try {
    sameHost = new URL(finalUrl).host === new URL(reqUrl).host;
  } catch (e) {
    sameHost = true;
  }
  if (!sameHost) return true;
  if (!text) return false;
  const t = text.toLowerCase();
  return ['登录', '认证', '校园网', 'wlanuserip', 'wlanacname', 'ac_id', 'srun', 'eportal', 'inter_face', '密码'].some((h) =>
    t.includes(h.toLowerCase())
  );
}

function extractPortalUrl(text, finalUrl, reqUrl) {
  let sameHost = true;
  try {
    sameHost = new URL(finalUrl).host === new URL(reqUrl).host;
  } catch (e) {
    sameHost = true;
  }
  if (!sameHost) return finalUrl;
  const patterns = [
    /<meta[^>]+http-equiv\s*=\s*["']?refresh["']?[^>]*content\s*=\s*["'][^"']*url\s*=\s*([^"'>\s]+)/i,
    /location\.(?:href|replace)\s*(?:=|\(\s*)["']([^"']+)["']/i,
    /window\.location\s*=\s*["']([^"']+)["']/i,
    /(https?:\/\/[^\s"'<>]*(?:wlanuserip|ac_id|srun|eportal|portal|auth)[^\s"'<>]*)/i
  ];
  for (const re of patterns) {
    const m = String(text).match(re);
    if (m && m[1]) {
      try {
        return new URL(m[1], finalUrl || reqUrl).href;
      } catch (e) {
        /* 继续 */
      }
    }
  }

  return finalUrl || '';
}

/* 「返回 204 才算通」的那类检测点（系统联网探测、手机厂商探测） */
const GENERATE_204_RE = /generate_204|connecttest\.txt|ncsi\.txt|success\.txt|hotspot-detect\.html|204\.txt/i;

function isGenerate204(url) {
  return GENERATE_204_RE.test(String(url || ''));
}

function hostOf(url) {
  try {
    return new URL(url).host;
  } catch (e) {
    return '';
  }
}

/* 带超时的 fetch。
 * ⚠ 「跳转太慢」的一大半根因就在这儿：探测用的 fetch 原来没有超时，
 * 一旦某个探测地址不可达（不在校园网、或学校把这几个地址全屏蔽了），
 * 浏览器会一路挂着等 TCP 超时——一个地址就能卡十几秒，几个地址叠起来就是「点了没反应」。
 * 现在每个地址最多给 PROBE_TIMEOUT_MS，超时立刻换下一个。 */
const PROBE_TIMEOUT_MS = 1500;
async function fetchWithTimeout(url, init, ms) {
  const limit = ms || PROBE_TIMEOUT_MS;
  let ctl = null;
  try {
    if (typeof AbortController !== 'undefined') ctl = new AbortController();
  } catch (e) {
    ctl = null;
  }
  let timer = null;
  if (ctl) {
    timer = setTimeout(() => {
      try {
        ctl.abort();
      } catch (e) {
        /* 忽略 */
      }
    }, limit);
  }
  try {
    const opts = Object.assign({}, init || {});
    if (ctl) opts.signal = ctl.signal;
    return await fetch(url, opts);
  } finally {
    if (timer) {
      try {
        clearTimeout(timer);
      } catch (e) {
        /* 忽略 */
      }
    }
  }
}

async function readSnippet(res) {
  try {
    const type = (res.headers.get('content-type') || '').toLowerCase();
    if (!(type.includes('text') || type.includes('html') || type.includes('json') || !type)) return '';
    return (await res.text()).slice(0, 8000);
  } catch (e) {
    return '';
  }
}

/* 302/JS 跳转后的最终地址就是「真正的门户页」，它自带 sessionId/userIp/userMac 等参数，
 * 比任何手填地址都可靠，所以优先取它。
 * 注意：**没跳转、正文里也没给出门户地址时返回空串**——绝不能把「检测地址本身」当成门户地址，
 * 否则又会去开那个空白的「无标题」检测页。 */
function portalFrom(text, finalUrl, reqUrl) {
  let same = true;
  try {
    same = new URL(finalUrl).host === new URL(reqUrl).host;
  } catch (e) {
    /* 忽略 */
  }
  if (!same && finalUrl) return finalUrl;
  const guess = extractPortalUrl(text, finalUrl, reqUrl);
  // 没跳转、正文里也没给出别的门户地址时返回空串 —— 绝不能把「检测地址本身」当成门户地址
  return guess && guess !== (finalUrl || reqUrl) ? guess : '';
}

/* 网络探测。
 *
 * ⚠ 这一版是「宁可判成掉线，也不许误判成联网」：
 *   主人遇到过「明明没网，扩展却说无需认证，一个页面都不开」——根因就是旧版把这句
 *   `if (res.ok) return { online: true }` 当成了联网。
 *   未认证时网关会拦下所有 HTTP 请求，很多网关不是整页跳转，而是**直接回一个 200 的拦截页**，
 *   内容里又未必有「认证/登录」字样，于是旧版就把它读成了「已联网」。
 *
 * 新规则：
 *   · 204                      → 唯一铁证：请求原样到达、没人插手，直接判已联网
 *   · 被跳到别的域名            → 掉线（并且顺手拿到带参数的真正门户地址）
 *   · generate_204 类检测点     → **只有 204 才算通**，其它状态码一律算被拦（200/302/511/403）
 *   · 普通地址                  → 只有「没有被重定向过、并且是 2xx」才算「疑似通」，
 *                                且只是 medium 置信度，要另一个来源再确认（见 probeConfirmed）
 *   · 全都说不清                → unsure，交给上层「照样打开认证页，让页面自己判断」
 */
async function probeOnce(offset) {
  const cfg = await getConfig();
  const urls = String(cfg.checkUrls || '')
    .split(/\r?\n/)
    .map((s) => s.trim())
    .filter(Boolean);
  const start = Math.max(0, Number(offset) || 0) % Math.max(1, urls.length);
  const ordered = urls.slice(start).concat(urls.slice(0, start));

  let lastError = '';
  let hint = null; // 中置信度的「疑似联网」候选
  let captive = null; // 抓到的门户地址
  let hardFails = 0; // 连不上（不是被拦）的次数：连挂两次就别再逐个地址耗时间了

  for (const url of ordered) {
    let res;
    try {
      res = await fetchWithTimeout(url, { cache: 'no-store', redirect: 'follow', credentials: 'omit' });
    } catch (e) {
      lastError = (e && e.message) || String(e);
      hardFails += 1;
      // 探测地址全都不可达时，「是不是掉线」已经问不出来了，早点收手交给页面自己判断
      if (hardFails >= 2) break;
      continue;
    }
    hardFails = 0;
    const finalUrl = res.url || url;
    let sameOrigin = true;
    try {
      sameOrigin = new URL(finalUrl).origin === new URL(url).origin;
    } catch (e) {
      /* 忽略 */
    }

    // ① 204：这是「请求原样到达、没有任何人插手」的最强信号，直接判定已联网
    //    （网关要拦你，就得给你它的页面，那就不可能是 204）
    if (res.status === 204) return { online: true, via: url, confidence: 'high' };

    // ② 被重定向到别的域 = 网关/门户在插手，铁定还没认证
    if (!sameOrigin) {
      const text = await readSnippet(res);
      captive =
        captive ||
        { url: portalFrom(text, finalUrl, url), via: url, why: '被重定向到 ' + (hostOf(finalUrl) || finalUrl) };
      continue;
    }

    // ③ 检测点：只有 204 才算真的通了。网关拦截时常常回 200 + 自己的页面，
    //    旧版就是把这个 200 读成了「已联网」，于是明明掉线却说「无需认证」。
    if (isGenerate204(url)) {
      if (res.status === 200 || res.status === 302 || res.status === 511 || res.status === 403) {
        const text = await readSnippet(res);
        captive =
          captive ||
          {
            url: portalFrom(text, finalUrl, url),
            via: url,
            why: '检测点返回 HTTP ' + res.status + '（不是 204，说明被网关拦了）'
          };
      } else {
        lastError = 'HTTP ' + res.status;
      }
      continue;
    }

    // ④ 普通地址：内容像门户 → 掉线；否则「没被重定向 + 2xx」才算疑似通
    const text = await readSnippet(res);
    if (looksLikePortal(text, finalUrl, url)) {
      captive =
        captive || { url: portalFrom(text, finalUrl, url), via: url, why: '响应内容像认证页' };
      continue;
    }
    if (res.ok && !res.redirected) {
      hint = hint || { via: url };
      continue;
    }
    lastError = 'HTTP ' + res.status;
  }

  if (captive) return { online: false, captive: true, portal: captive.url, via: captive.via, why: captive.why };
  if (hint) return { online: true, via: hint.via, confidence: 'medium' };
  return { online: false, captive: false, error: lastError || '所有探测地址都不可达' };
}

/* 把 medium 置信度的「疑似联网」做实：换一个来源地址再确认一次，
 * 两次都说是通的、而且不是同一个地址回的，才算数。做不实就返回 unsure
 * —— 上层会照常打开认证页，让页面自己去判断该不该登录。 */
async function probeConfirmed() {
  const first = await probeOnce(0);
  if (first.captive) return first;
  if (first.online && first.confidence === 'high') return first;
  if (first.online) {
    const second = await probeOnce(1);
    if (second.captive) return second;
    if (second.online && second.confidence === 'high') return second;
    if (second.online && second.via && second.via !== first.via) {
      return { online: true, via: first.via, confidence: 'high', agreed: [first.via, second.via] };
    }
    return {
      online: false,
      captive: false,
      unsure: true,
      via: first.via,
      error: '只有 ' + (first.via || '一个地址') + ' 回了 2xx，不能确认是否真的联网'
    };
  }
  return first;
}

/* 给「已联网」结论配一句人话，写进弹窗，方便一眼看出凭什么。
 * ⚠ 不要把探测地址写进去 —— 弹窗就那么宽，一长串 URL 会把那行挤到溢出（主人反馈过）。 */
function onlineNote(p) {
  if (!p) return '';
  if (p.confidence === 'high') return '（探测点返回 204）';
  if (p.agreed && p.agreed.length) return '（两个探测点都确认通过）';
  return '（多来源探测确认）';
}

async function probeWithRetry(tries) {
  const max = Math.max(1, tries || 1);
  let last = null;
  for (let i = 0; i < max; i++) {
    last = await probeConfirmed();
    if (last.online || last.captive) return last;
    if (i < max - 1) await sleep(3000);
  }
  return last;
}

async function applyProbeResult(r) {
  const st = await getState();
  const info = r.online
    ? r.confidence === 'high'
      ? '网络正常' + (r.via ? '（' + r.via + ' 返回 204）' : '')
      : '疑似已联网（待确认）'
    : r.captive
      ? '需认证：' + (r.why || '被网关拦到认证页')
      : r.unsure
        ? '探测结果不可信：' + (r.error || '无法确认是否联网')
        : '网络不可用' + (r.error ? '（' + r.error + '）' : '');
  const patch = {
    // unsure（比如检测点被学校屏蔽）时不写死结论，留 null 让弹窗显示「状态未知」
    online: r.unsure ? null : r.online,
    lastCheckAt: Date.now(),
    lastCheckInfo: info,
    lastCheckConfidence: r.online ? r.confidence || 'high' : '',
    lastCheckVia: r.via || ''
  };
  if (r.portal) {
    const hosts = new Set(st.portalHosts || []);
    try {
      hosts.add(new URL(r.portal).origin);
    } catch (e) {
      /* 忽略 */
    }
    patch.portalHosts = Array.from(hosts).slice(-10);
    patch.portalCandidate = r.portal;
  }
  const next = await setState(patch);
  await updateBadge(next);
  return next;
}

/* ---------- 1.16.0：会话到期看门狗 + 到点窗口的高频探测 ---------- */

/* 这次认证大概什么时候到期（毫秒时间戳）。没认证过 / 没填时长 → 0 = 不启用。 */
function expiryAtOf(cfg, st) {
  const mins = Number((cfg && cfg.sessionMinutes) || 0);
  if (!Number.isFinite(mins) || mins <= 0) return 0;
  if (!st || !st.lastLoginAt) return 0;
  return st.lastLoginAt + Math.round(mins * 60000);
}

/* 挂/重挂「到期看门狗」闹钟。顺手把算出来的到期时刻写进 state，弹窗直接拿它做倒计时。
 * 每次认证成功、改设置、重新排定时都会调一次 —— 所以它永远是跟着 lastLoginAt 走的。 */
async function scheduleExpiry() {
  const cfg = await getConfig();
  const st = await getState();
  const at = expiryAtOf(cfg, st);
  if (st.expiryAt !== at) await setState({ expiryAt: at });
  try {
    await chrome.alarms.clear(ALARM_EXPIRY);
  } catch (e) {
    /* 忽略 */
  }
  if (!at || !cfg.enabled || st.paused) return at;
  /* 「定时认证」关掉 = 主人不要任何自动认证，那看门狗也不该自作主张。
   * （到期时刻照样算出来给弹窗做倒计时，只是不挂闹钟。） */
  if (!cfg.schedule.enabled) return at;
  /* 到期时刻已经过去了（比如电脑关机好几天）→ 别挂一个马上就会响的闹钟去乱动，
   * 等下一次「定时 / 开机 / 手动」自然接手即可。 */
  if (at + EXPIRY_TAIL_MS < Date.now()) return at;
  const wake = at - EXPIRY_LEAD_MS;
  chrome.alarms.create(ALARM_EXPIRY, { delayInMinutes: Math.max(0.5, (wake - Date.now()) / 60000) });
  return at;
}

/* 在到期附近 / 到点附近**密集探一段**，用「到底有没有网」替代「进网页看页面」。
 *
 * 返回 { verdict: 'offline' | 'online' | 'unsure', probe }
 *   · offline —— 网关正在拦（captive）。**只有这一种**才算「真的掉线」：
 *                它是网关亲手交出的证据，不会认错。探到就立刻收工去认证。
 *   · online  —— 探到最后一次仍是 204 级别的「真通了」→ 认证还没到期，什么都不用做。
 *   · unsure  —— 其余全部（检测点被学校屏蔽 / 网络整个不通 / 单次抖动）→ 判不出来，
 *                交回上层按老路进网页，让页面自己去认。**绝不靠猜就把整轮认证拉起来。**
 *
 * ⚠ 循环里每次都读一次 state：那不是为了数据，是为了**每隔几秒碰一下扩展 API**，
 *   让 Service Worker 在 MV3 的 30 秒空闲回收面前活下来（这个窗口最长也就两三分钟，
 *   而且一个认证周期只跑一次，代价可以忽略）。
 * ⚠ 次数上限用**计数**而不是墙钟时间 —— 测试环境里 sleep 会被加速成 0ms，
 *   用 Date.now() 判循环会原地空转到超时。 */
async function probeBurst(maxProbes, gapMs) {
  const total = Math.max(1, maxProbes || 1);
  let lastProbe = null;
  for (let i = 0; i < total; i += 1) {
    await getState(); // 触碰扩展 API：防止 SW 在探测间隙被回收
    const r = await probeConfirmed();
    lastProbe = r;
    await applyProbeResult(r);
    if (r.captive) return { verdict: 'offline', probe: r };
    if (i < total - 1) await sleep(gapMs || 0);
  }
  if (lastProbe && lastProbe.online && lastProbe.confidence === 'high') {
    return { verdict: 'online', probe: lastProbe };
  }
  return { verdict: 'unsure', probe: lastProbe };
}

/* 到期看门狗到点：密集探一段，真掉线就立刻认证；还通着就过几分钟再看一眼。
 * 两种模式都开着 —— 勾了「先下线再认证」的人是靠到点强制续期的，万一周期设得比
 * 有效期还长，这条就是防止白白断网的兜底；没勾的人则主要靠它来续期。 */
async function expiryFlow() {
  const cfg = await getConfig();
  const st = await getState();
  if (!cfg.enabled || st.paused) return;
  const at = expiryAtOf(cfg, st);
  if (!at) return;
  /* 来早了（配置刚改 / 闹钟提前醒）→ 重挂一个就收手。
   * ⚠ 判据必须是「比窗口起点还早」，不能写成「还没到到期时刻」——
   *   闹钟本来就是提前 1 分钟叫醒的，那个写法会把每一次唤醒都当成「来早了」，
   *   于是永远只重挂闹钟、从不探测。 */
  if (Date.now() < at - EXPIRY_LEAD_MS) {
    await scheduleExpiry();
    return;
  }
  /* 正在认证中，别插手。 */
  if (st.flow && st.flow.status === 'running') {
    await scheduleExpiry();
    return;
  }
  if (!cfg.username || !cfg.password) return;

  const windowMs = EXPIRY_LEAD_MS + EXPIRY_TAIL_MS;
  const probes = Math.max(2, Math.round(windowMs / EXPIRY_POLL_MS));
  await note('快到认证到期时间了，正在密集检测网络…');
  const r = await probeBurst(probes, EXPIRY_POLL_MS);

  if (r.verdict === 'offline') {
    await setState({ expiryTries: 0 });
    await loginFlow({ reason: 'expiry', force: true });
    return;
  }
  if (r.verdict === 'online') {
    /* 还通着 —— 说明这次的有效期比我们估的长。别瞎认证，过 5 分钟再看一眼；看够次数就算了。 */
    const tries = (st.expiryTries || 0) + 1;
    if (tries > EXPIRY_RETRY_MAX) {
      await setState({ expiryTries: 0 });
      await note('认证有效期比设置的更长，这次先不管了（可以到设置里把「单次认证有效期」调大）');
      return;
    }
    await setState({ expiryTries: tries });
    chrome.alarms.create(ALARM_EXPIRY, { delayInMinutes: Math.max(0.5, EXPIRY_RETRY_MS / 60000) });
    return;
  }
  /* unsure：探测判不出来（检测点可能被学校屏蔽）→ 按老路进网页，让页面自己去判断。 */
  await note('探测结果不可信，改用网页流程核对…');
  await loginFlow({ reason: 'expiry', force: true });
}

/* ---------- 标签页与注入 ---------- */

/* 网关跳转模式下的入口地址：挑一个 http 检测点。
 * 未认证时访问它会收到网关 302，浏览器自动带着 sessionId/userIp/userMac 等完整参数
 * 跳到门户登录页——这比直接打开门户地址可靠得多（门户地址直连往往不渲染表单）。 */
function gatewayEntryUrl(cfg) {
  const list = String(cfg.checkUrls || '')
    .split(/\r?\n/)
    .map((s) => s.trim())
    .filter(Boolean);
  const http = list.find((u) => /^http:\/\//i.test(u));
  return http || list[0] || 'http://connectivitycheck.platform.hicloud.com/generate_204';
}

/* 已知的门户 origin 集合（用于复用已打开的门户标签、以及填密码的安全白名单） */
function portalOrigins(cfg, st) {
  const out = new Set();
  const add = (u) => {
    try {
      if (u) out.add(new URL(u).origin);
    } catch (e) {
      /* 忽略 */
    }
  };
  add(cfg.portalUrl);
  add(st && st.portalCandidate);
  ((st && st.portalHosts) || []).forEach(add);
  return Array.from(out);
}

async function findTabByOrigins(origins) {
  if (!origins || !origins.length) return null;
  try {
    const tabs = await chrome.tabs.query({});
    return (
      tabs.find((t) => t.url && origins.some((o) => t.url.startsWith(o))) ||
      tabs.find((t) => t.pendingUrl && origins.some((o) => t.pendingUrl.startsWith(o))) ||
      null
    );
  } catch (e) {
    return null;
  }
}

function sendToTab(tabId, message, timeoutMs) {
  return new Promise((resolve) => {
    let done = false;
    const finish = (v) => {
      if (done) return;
      done = true;
      resolve(v);
    };
    try {
      chrome.tabs.sendMessage(tabId, message, (resp) => {
        void chrome.runtime.lastError;
        finish(resp || null);
      });
    } catch (e) {
      finish(null);
    }
    setTimeout(() => finish(null), timeoutMs || 4000);
  });
}

/* 等服务页真正可用：重定向链 + JS 渲染都要时间，轮询 PING 到「有密码框」为止。
 * 顺便也认这两种「其实已经到了」的状态——那样不必再换下一个入口地址重开：
 *   · 页面自己说已在线（connected）
 *   · 页面是**服务选择独立页**（needService）：门户点完「立即登录」会整页跳到
 *     /portal/entry/pc/serviceSelection，那一页**没有密码框**，只有服务选项。
 *     旧版拿「有密码框」当唯一就绪条件，于是跳到这一页会被判成「打不开登录表单」。
 *
 * 快慢上的讲究（主人反馈过「跳转太慢」）：
 *   · 前 6 次用短间隔探（门户快就几百毫秒就往下走），之后才放慢到 1 秒一次
 *     —— 既不会在页面早就好了的情况下干等，也不会对慢渲染的 SPA 失去耐心。
 *   · 不再每轮都 executeScript 注入一遍：内容脚本本来就由清单在所有 http(s) 页面上
 *     自动注入，每轮注入一次等于给「等待」本身加了几百毫秒的开销。
 *     只在第一次没应答时补注入一次（用于刚跳转、脚本还没就位的瞬间）。 */
async function waitForPortalReady(tabId, tries, gapMs, slowGapMs) {
  const max = Math.max(1, tries || 8);
  for (let i = 0; i < max; i++) {
    const alive = await chrome.tabs.get(tabId).catch(() => null);
    if (!alive) return { ready: false, gone: true };
    const r = await sendToTab(tabId, { type: 'PING' }, 1200);
    // silent = 空白子框架的「什么都没看见」，不作数（谁先应答谁说了算，不能让空框架盖掉主页面）
    if (r && !r.silent) {
      if (r.hasPassword) return { ready: true, tries: i + 1 };
      if (r.needService) return { ready: true, service: true, tries: i + 1 };
      if (r.connected) return { ready: false, connected: true, tries: i + 1 };
    }
    if (!r && i === 0) await injectContent(tabId);
    const fast = !slowGapMs || i < 6;
    await sleep(fast ? gapMs || 400 : slowGapMs);
  }
  return { ready: false, tries: max };
}

async function closeTabQuietly(tabId) {
  if (!tabId) return;
  try {
    await chrome.tabs.remove(tabId);
  } catch (e) {
    /* 忽略 */
  }
}

/* 「服务选择」是独立整页时，地址长这样：
 *   https://portal.example.edu.cn/portal/entry/pc/serviceSelection;flowParams=undefined;from=authenticate;sid=false */
function isServiceSelectionUrl(u) {
  return /serviceSelection|selectService|service[-_]?select|chooseService|select[-_]?identity/i.test(String(u || ''));
}

/* 「流程页」＝ 认证还没走完的页面（登录页 / 服务选择页）。 */
function isFlowPageUrl(u) {
  return /authenticate|serviceSelection|selectService|service[-_]?select|chooseService|select[-_]?identity/i.test(String(u || ''));
}

/* 「跳转到最终界面」＝ 认证完成（主人这轮的要求）。
 *
 * 判据：**已经点过「确定」，而且标签页离开了流程页**。
 *
 * 依据（从门户前端代码里核过，见 tools/portal-structure.md）：
 * ServiceSelectionModule.submitForm() 只在 serviceLogin 返回 authResult==='success' 时才
 * getActionNextPageForPortal() → nextPath() 跳走；失败时只弹一个 warning 弹窗、**地址一动不动**。
 * 所以「点过确定 + 地址不再是流程页」就是走完了，可以立刻收尾，
 * 不必再等一次网络探测（那段时间正是主人抱怨的「关页面和通知都慢半拍」）。
 *
 * 为什么必须 confirmed>=1：入口页本身（entry/pc/finish、portal-main）也不是流程页地址，
 * 没点过「确定」的时候不能把它们当成「到了最终界面」。 */
function landedOnFinalPage(f, url) {
  if (!f || (f.confirmed || 0) < 1) return false;
  if (!url) return false;
  if (/^(chrome|edge|about|devtools|extension|data|view-source)/i.test(url)) return false;
  return !isFlowPageUrl(url);
}

/* 兜底：页面脚本本该自己动手选服务，万一它没动（脚本没注入 / 用户关掉了「进认证页自动填写」），
 * 后台在这里补一次「去选服务」的指令。**每个流程只补一次**：
 * 既避免和页面自己动手撞车，也避免反复点「确定」变成重复提交。 */
async function nudgeServicePage(f) {
  if (!f || !f.tabId || f.serviceNudged) return false;
  let tab = null;
  try {
    tab = await chrome.tabs.get(f.tabId);
  } catch (e) {
    return false;
  }
  if (!tab || !isServiceSelectionUrl(tab.url)) return false;
  await setState({ flow: { ...f, serviceNudged: true } });
  try {
    await chrome.tabs.sendMessage(f.tabId, { type: 'SELECT_SERVICE' });
  } catch (e) {
    /* 忽略 */
  }
  return true;
}

/* 页面已经给出成功结论时，立刻收尾：通知 + 关页面 + 后台核实，不再等定时核查。
 * 通知排在关页面之前 —— 主人反馈过「通知来得太晚」，关标签页本身也要花时间。 */
let lastFinalSuccessAt = 0;
async function finalizeSuccess(f, note, opts) {
  const o = opts || {};
  const cfg = await getConfig();
  const now = Date.now();
  if (now - lastFinalSuccessAt < DUPLICATE_WINDOW_MS) return; // 同一轮认证只收尾一次
  lastFinalSuccessAt = now;
  const text = note || '门户已提示认证成功';
  const label = /无需|已在线/.test(text) ? text : '认证成功（' + text + '）';
  try {
    await chrome.alarms.clear(ALARM_VERIFY);
  } catch (e) {
    /* 忽略 */
  }
  await setState({
    lastLoginAt: now,
    lastLoginDay: todayKey(now),
    expiryTries: 0, // 1.16.0：新一轮会话开始，到期看门狗的重看计数清零
    lastResult: label,
    lastResultAt: now,
    diag: '',
    diagHtml: '',
    flow: null,
    loginTabId: null,
    retry: null
  });
  /* 1.16.0：刚认证成功 → 到期时刻变了，把看门狗挪到新的到期点前 1 分钟，
   * 顺手把 state.expiryAt 更新掉（弹窗倒计时就是从它算的）。 */
  await scheduleExpiry();

  // 先通知：不让人等「关页面」这段。
  // 只有「真的帮你认证了」才弹 —— 本来就在线（无需认证）时静默，免得白弹一次。
  const idle = o.idle || /无需|已在线/.test(text);
  if (cfg.notify && !idle) notify('校园网已连接', text);

  /* 1.13.0：只关**本扩展自己打开**的页面。
   * 以前是 `!f.fromTab` —— 页面脚本在主人自己开的页面上跑完流程时，后台补的 flow 恰好 fromTab=false，
   * 于是主人的页面被关掉（教务系统「打开后自己消失」就是这么来的）。 */
  const ours = await isOpenedByUs(f && f.tabId, f);
  const closeIt = (cfg.closeTabOnSuccess && f && f.tabId && ours) || (cfg.closeTriggerTabOnSuccess && f && f.tabId);
  if (closeIt && f.tabId) {
    await sleep(CLOSE_DELAY_MS);
    await closeTabQuietly(f.tabId);
    await forgetOpenedTab(f.tabId);
  }

  // 后台快速核实一次真实网络状态（不阻塞上面的关页与通知）。
  // 只在探测确实说「通了」时才更新状态——刚认证成功就用一次探测把它翻成「需认证」是假警报，
  // 有些学校会屏蔽探测地址，这种情况如实记一笔就好，不覆盖结论。
  try {
    const p = await probeConfirmed();
    if (p.online) await applyProbeResult(p);
    else {
      await setState({
        lastCheckAt: Date.now(),
        lastCheckInfo: '刚完成认证；这次探测未通过（' + (p.why || p.error || '探测地址可能被学校屏蔽') + '）'
      });
    }
  } catch (e) {
    /* 忽略 */
  }
  await updateBadge();
}

/* 页面明确失败时立刻收尾：不等定时核查，该重试就排重试，该通知就通知 */
async function finalizeFailure(f, note) {
  const cfg = await getConfig();
  const now = Date.now();
  const text = note || '页面流程失败';
  const attempts = Number((f && f.attempts) || 1) || 1;
  try {
    await chrome.alarms.clear(ALARM_VERIFY);
  } catch (e) {
    /* 忽略 */
  }
  if (attempts < Number(cfg.maxAttempts || 2)) {
    const scheduledFor = now + RETRY_DELAY_MIN * 60000;
    await setState({
      flow: null,
      retry: { attempts: attempts + 1, reason: 'page-failed', scheduledFor },
      lastResult: '认证未成功（' + text + '），30 秒后自动重试（第 ' + (attempts + 1) + ' 次）',
      lastResultAt: now
    });
    chrome.alarms.create(ALARM_RETRY, { delayInMinutes: RETRY_DELAY_MIN });
  } else {
    await setState({
      flow: null,
      retry: null,
      lastResult: '认证失败（' + text + '），已尝试 ' + attempts + ' 次，请手动确认',
      lastResultAt: now
    });
    // 失败不弹系统通知：主人只保留「成功」那一个弹窗
  }
  await updateBadge();
}

/* 现在就安排一次核查（setTimeout 优先，alarm 作为 SW 被回收后的兜底）。
 * 连续调用会重置前一个定时器，避免页面多次回报导致探测堆叠。 */
let verifyTimer = null;
function scheduleVerify(seconds) {
  const ms = Math.max(VERIFY_FLOOR_MS, Math.round((seconds || 4) * 1000));
  if (verifyTimer) {
    try {
      clearTimeout(verifyTimer);
    } catch (e) {
      /* 忽略 */
    }
  }
  verifyTimer = setTimeout(() => {
    verifyTimer = null;
    verifyFlow().catch(() => {});
  }, ms);
  try {
    chrome.alarms.create(ALARM_VERIFY, { delayInMinutes: 1 });
  } catch (e) {
    /* 忽略 */
  }
}

async function injectContent(tabId) {
  try {
    await chrome.scripting.executeScript({ target: { tabId, allFrames: true }, files: ['content.js'] });
  } catch (e) {
    /* 页面可能不允许注入，忽略 */
  }
}

function isAllowedPortalHost(url, cfg, st) {
  try {
    const origin = new URL(url).origin;
    const host = new URL(url).hostname;
    /* 1.13.0：主人填的排除域名优先（教务系统这类就靠它挡住） */
    if (hostExcluded(host, cfg)) return false;
    if (cfg.portalUrl) {
      try {
        if (new URL(cfg.portalUrl).origin === origin) return true;
      } catch (e) {
        /* 忽略 */
      }
    }
    if ((st.portalHosts || []).some((o) => {
      try {
        return new URL(o).origin === origin;
      } catch (e) {
        return false;
      }
    })) {
      return true;
    }
    if (/^(10\.|192\.168\.|127\.|172\.(1[6-9]|2\d|3[01])\.)/.test(host)) return true;
    /* 1.13.0：非同源的教育网地址，不再「是 .edu.cn 就算门户」——
     * 教务系统 / 办事大厅 / 统一身份认证这类地址要先排除，
     * 剩下的还必须在地址里带门户特征（/portal/、srun、eportal、wlanuserip、ac_id…）。 */
    if (host.endsWith('.edu.cn') || host.endsWith('.edu')) {
      // 各校业务系统的通用路径特征（教务 jwxt、办事大厅 ehall、统一认证 ids/cas、图书馆 lib、邮箱 mail…）
      if (/jwxt|xjwxt|ehall|ids\.|cas\.|lib\.|mail\.|vpn|mooc|chaoxing|jiaowu|jwc\./i.test(url)) return false;
      return /portal|srun|eportal|wlanuserip|wlanacname|ac_id|serviceSelection|authenticate|selectService/i.test(url);
    }
    return false;
  } catch (e) {
    return false;
  }
}

/* ---------- 高级：接口模式 ---------- */

async function advancedLogin(cfg) {
  const a = cfg.advanced || {};
  if (!a.url) return { ok: false, note: '未填写登录接口地址' };
  const sub = (s) =>
    String(s || '')
      .replace(/\{\{\s*username\s*\}\}/gi, cfg.username || '')
      .replace(/\{\{\s*password\s*\}\}/gi, cfg.password || '')
      .replace(/\{\{\s*operator\s*\}\}/gi, cfg.operator || '');
  const method = String(a.method || 'POST').toUpperCase();
  const bodyStr = sub(a.body);
  let url = sub(a.url);
  const init = { method, cache: 'no-store', redirect: 'follow', credentials: 'include' };
  if (method === 'GET') {
    if (bodyStr) url += (url.includes('?') ? '&' : '?') + bodyStr.replace(/^\?+/, '');
  } else if (a.format === 'json') {
    init.headers = { 'Content-Type': 'application/json' };
    init.body = bodyStr || '{}';
  } else {
    init.headers = { 'Content-Type': 'application/x-www-form-urlencoded' };
    init.body = bodyStr;
  }
  const res = await fetch(url, init);
  const text = (await res.text()).slice(0, 1000);
  const hit = a.successText && text.includes(a.successText);
  return { ok: !!hit, note: hit ? '接口返回成功标识' : '接口返回 HTTP ' + res.status };
}

/* ---------- 认证流程 ---------- */

async function loginFlow(opts) {
  const o = opts || {};
  const cfg = await getConfig();
  let st = await getState();

  if (!cfg.enabled || st.paused) return st;
  if (!cfg.username || !cfg.password) {
    await note('还没有填写密码，请在设置里补上');
    return await getState();
  }
  if (!o.force && Date.now() - (st.lastAttemptAt || 0) < MIN_GAP_MS) return st;

  /* 这次是不是**主人自己点的**（弹窗「立即认证」/「打开认证页」，或他自己打开门户页）。
   * 这两类跟「定时」要区别对待 —— 见下面那段。 */
  const manualClick =
    o.reason === 'manual' || o.reason === 'open-portal' || o.reason === 'portal-page' || !!o.manual;
  /* 只有后台自己发起的流程（定时 / 开机 / 错过补做 / 重试）才允许「已在线也先下线再认证」，
   * 因为那是为了把认证时长续上。 */
  const insist = !manualClick && !!cfg.reloginWhenOnline;

  /* ---- 先看设备到底有没有网，再决定要不要动手 ----
   *
   * 有网 = 这次认证还有效：
   *   · 「立即认证」  → 什么都不做，连页面都不开（省时间也省电脑资源）；
   *   · 「打开认证页」→ 页面照旧开出来给主人看，但**一个认证动作都不做**
   *     （不开页会让他以为按钮失灵；页面脚本会因为拿不到流程标记而自动收手）。
   * 没网 = 该认证了 → 继续往下走，打开登录页把账号密码填完。
   *
   * 定时 / 开机 / 重试**不受这段影响**：开了「认证没到期也要续期」时仍然必须进网页，
   * 由页面决定要不要先「我要下线」再认证一遍（在线时长才不会停在上次那个点）。
   * 所以那句「网络正常，本次无需认证」只留给定时流程里没开续期的情况。 */
  let manualOnline = false;
  if (o.probe !== false && (manualClick || cfg.probeBeforeLogin)) {
    const r = await probeConfirmed();
    st = await applyProbeResult(r);
    if (r.online && r.confidence === 'high') {
      if (manualClick) {
        manualOnline = true;
        if (o.reason === 'open-portal') {
          await note('设备已联网，认证还没到期 —— 只把页面打开，不做任何操作' + onlineNote(r));
        } else {
          await note('设备已联网，认证还没到期 —— 本次不做任何操作' + onlineNote(r));
          return await getState();
        }
      } else if (!insist) {
        await note('网络正常，本次无需认证' + onlineNote(r));
        return await getState();
      }
    }
  }

  const attempts = o.attempts || 1;

  // 接口模式：不需要页面
  if (cfg.advanced.enabled) {
    let res = { ok: false, note: '' };
    try {
      res = await advancedLogin(cfg);
    } catch (e) {
      res = { ok: false, note: '执行出错：' + ((e && e.message) || e) };
    }
    await setState({
      lastAttemptAt: Date.now(),
      attempts,
      flow: {
        startedAt: Date.now(),
        tabId: 0,
        status: res.ok ? 'success' : 'failed',
        note: res.note,
        attempts,
        verifyCount: 0
      },
      lastResult: '已提交接口登录请求，正在核对…',
      lastResultAt: Date.now()
    });
    scheduleVerify(6);
    return await getState();
  }

  // 网页模式：打开（或复用）认证页，交给内容脚本跑多步流程
  const mode = cfg.portalOpenMode === 'direct' ? 'direct' : 'gateway';
  const wantActive = o.foreground ? true : !cfg.backgroundTab;
  let tabId = o.tabId || 0;
  let openedUrl = '';
  let tried = []; // 依次试过的入口地址（失败时写进日志，方便定位）
  let ready = { ready: false };
  let pageConnected = false; // 打开的那张页面上是否显示「已在线」（决定这一轮是续期还是登录）

  if (!tabId) {
    const existing = await findTabByOrigins(portalOrigins(cfg, st));
    if (existing) {
      // 已经开着门户页就复用，不新开标签
      tabId = existing.id;
      try {
        await chrome.tabs.update(tabId, { active: wantActive });
      } catch (e) {
        /* 忽略 */
      }
    }
  }

  if (!tabId) {
    /* 先在认证时机探一次真实状态（**只探一次**，不是轮询）。
     * ⚠ 只有「204 明确通过」才认「无需认证」——旧版把网关拦截回来的 200 也当成联网，
     * 结果明明掉线却说「无需认证」、一个标签都不开，主人只能自己手动去翻门户页。
     * ⚠ 也**只探一次**、并且每个地址都带超时：这一段的快慢直接决定「点了之后多久有反应」。 */
    let probed = null;
    if (!o.forcePortal) {
      probed = await probeOnce(0);
      st = await applyProbeResult(probed);
      /* 以前这里会直接一句「网络正常，本次无需认证」收手，一个页面都不开 ——
       * 认证没到期时网络本来就通，于是每次到点都这么说，时长永远续不上。
       * insist 时**照样往下开页面**，让页面脚本去判断（它认出「已在线」就会走下线重认证）。 */
      if (!insist && probed.online && probed.confidence === 'high') {
        await note('网络正常，本次无需认证' + onlineNote(probed));
        return await getState();
      }
    }

    /* 入口候选链：一个刷不出登录表单就换下一个。
     * 顺序有讲究——从最可能带全参数的那个开始，最后兜到用户手填的地址。 */
    const candidates = [];
    const pushUrl = (u) => {
      const v = String(u || '').trim();
      if (v && !candidates.includes(v)) candidates.push(v);
    };
    pushUrl(o.url);
    // 探测发现「检测点被拦了但没跳转」时，说明检测地址本身打不开登录页，别再拿它当入口
    const entryRedirects = !(probed && probed.captive && /不是 204/.test(String(probed.why || '')));
    /* ⚠ 已经认证过（探测真通了）时，网关检测地址不会再把你跳到登录页 ——
     * 打开它只会得到一张空白页、白等十几秒。这种情况直接跳过它，
     * 让第一个候选就是门户自己的地址，页面才能立刻开始干活。 */
    const gatewayUseful = entryRedirects && !(probed && probed.online && probed.confidence === 'high');
    if (mode === 'gateway') {
      pushUrl(probed && probed.portal);
      if (gatewayUseful) pushUrl(gatewayEntryUrl(cfg));
      pushUrl(cfg.portalFallbackUrl);
      pushUrl(cfg.portalUrl);
      if (!entryRedirects) pushUrl(gatewayEntryUrl(cfg));
    } else {
      pushUrl(cfg.portalUrl || st.portalCandidate);
      pushUrl(cfg.portalFallbackUrl);
      pushUrl(probed && probed.portal);
      if (gatewayUseful) pushUrl(gatewayEntryUrl(cfg));
    }
    if (!candidates.length) {
      await note('没有可用的认证页地址：请在设置里填「认证页地址」，或把打开方式改成「让网关自动跳转」');
      return await getState();
    }

    for (let i = 0; i < candidates.length; i += 1) {
      const url = candidates[i];
      tried.push(url);
      try {
        if (!tabId) {
          const tab = await chrome.tabs.create({ url, active: wantActive });
          tabId = tab.id;
          await markOpenedByUs(tabId); // 1.13.0：记住「这是我自己开的」，收尾时才允许关它
        } else {
          await chrome.tabs.update(tabId, { url });
        }
      } catch (e) {
        continue;
      }
      openedUrl = url;
      // 第一个入口留足时间（要走完「302 → portal-main → entry/pc/finish」整条跳转链），
      // 后面几个短一些。前 6 次探得快（400ms），之后放慢到 1 秒一次。
      ready = await waitForPortalReady(tabId, i === 0 ? 12 : 6, 400, 1000);
      if (ready.gone || ready.ready || ready.connected) break;
    }

    /* 页面 PING 回来说「这一页看着像已在线」：
     * 以前就在这里按「本来就在线」收尾 + 关页面，页面脚本连一句话都没来得及说。
     * insist 时不能收尾 —— 把指令发下去，让页面自己决定（它会走「下线再认证」这条路）。 */
    if (ready.gone) {
      await note('认证页被关闭，流程结束');
      return await getState();
    }
    if (ready.connected) {
      if (!insist) {
        await finalizeSuccess(
          { tabId, fromTab: false, status: 'skipped' },
          '门户页面显示已在线，无需认证',
          { idle: true }
        );
        return await getState();
      }
      pageConnected = true;
    }
    if (!ready.ready && !pageConnected) {
      const p = await probeOnce(0);
      await applyProbeResult(p);
      if (p.captive === false && p.online && p.confidence === 'high') {
        // 打开的是检测地址、结果网络本来就是好的
        await closeTabQuietly(tabId);
        await note('网络正常，本次无需认证' + onlineNote(p));
        return await getState();
      }
      await note('打不开登录表单，已依次试过：' + tried.join(' → ') + '（最后一次探测：' + (p.error || p.why || '无') + '）');
      return await getState();
    }
  } else {
    ready = await waitForPortalReady(tabId, 8, 400, 1000);
  }

  /* 「打开认证页」而设备本来就联网（上面探测过）：页面留给主人看，扩展到这儿就收手 ——
   * 不注入脚本、不发指令、不下线。页面脚本自己也会因为拿不到「定时流程」标记而不动手。 */
  if (manualOnline) return await getState();

  await injectContent(tabId);

  // 页面会「抢跑」（进页面就自己填）。若它刚刚已经认证成功，别再开第二轮，
  // 否则会对同一个认证结果再提交一次、再通知一次。
  const after = await getState();
  if (Date.now() - (after.lastLoginAt || 0) < 60000) {
    await note('本机刚刚已认证成功，跳过本轮');
    return await getState();
  }

  const flow = {
    startedAt: Date.now(),
    tabId,
    fromTab: !!o.tabId,
    openedByUs: !o.tabId, // 1.13.0：没传 tabId 说明这一页是后台自己新建的，收尾时允许关掉
    status: 'running',
    note: '',
    attempts,
    verifyCount: 0,
    submitted: 0
  };
  await setState({
    loginTabId: tabId,
    lastAttemptAt: Date.now(),
    attempts,
    flow,
    /* 页面已经显示「已在线」时把话说清楚：这一轮是去**核对能不能续期**（没到期就先注销再认证），
     * 而不是打开一张登录表单。以前文案写「开始执行登录流程」，主人看到会觉得它在糊弄。 */
    lastResult: pageConnected ? '已打开认证页，正在核对是否需要续期…' : '已打开认证页，开始执行登录流程…',
    lastResultAt: Date.now()
  });
  await updateBadge();

  try {
    await chrome.tabs.sendMessage(tabId, {
      type: 'FILL_AND_SUBMIT',
      payload: {
        username: cfg.username,
        password: cfg.password,
        operator: cfg.operator,
        selectors: cfg.selectors,
        /* ⭐ 只有「后台自己发起的续期流程」才带这个标记，页面据此决定「已在线」时要不要下线重认证。
         * 手动操作（点按钮 / 自己打开认证页）走到这里时 insist 是 false，页面就只会安静收手。
         * 见 content.js 里 runFlow 的 enterAtOnline 分支。 */
        renew: !!insist
      }
    });
  } catch (e) {
    const msg = '无法在认证页执行脚本：' + ((e && e.message) || e);
    await setState({ flow: { ...flow, status: 'failed', note: msg }, lastResult: msg, lastResultAt: Date.now() });
  }

  // 页面一般会自己回报结论（收到后立即收尾）；这里只做兜底核查
  scheduleVerify(FAST_VERIFY_MS / 1000);
  return await getState();
}

/* 兜底核查：页面没给结论（或只给了「看着像成功」的 probable）时，用一次**可信的**网络探测定论。
 *
 * ⚠ 这里是最关键的一处修复。旧版写的是 `const ok = p.online || pageOk;`——
 * 只要探测说联网就收尾（通知 + 关页面）。探测一误判，就会在「运营商还没选完」的时候
 * 把认证页直接关掉，主人看到的就是「服务还没选就关了」。
 * 现在收紧为：**页面自己给出明确成功结论，或 204 级别的可信探测**，二者只认其一。 */
async function verifyFlow() {
  const cfg = await getConfig();
  const st = await getState();
  const f = st.flow;
  if (!f || !f.startedAt || f.verified) return;
  if (Date.now() - f.startedAt > FLOW_STALE_MS) {
    await setState({ flow: null });
    return;
  }

  /* 页面正在跑「已在线 → 先下线再认证」（它会上报 relogin 标记）。
   * ⚠ 这一阶段**网络本来就是通的**（上次认证还没到期），拿 204 探测去判「已完成」
   *   会让后台在半路收尾、把页面上的「我要下线 → 重新认证」直接打断 ——
   *   结果就是「扩展说已连接，认证时长却没续上」。
   * 宽限期内把结论权交给页面脚本；到点自动恢复兜底，绝不会永远不收尾。 */
  if (f.relogin && Date.now() - (f.reloginAt || f.startedAt) < RELOGIN_GRACE_MS) {
    const stillRunning = f.status === 'running' || f.status === 'probable';
    if (stillRunning) {
      scheduleVerify(4);
      return;
    }
  }

  /* 已经点过「确定」、而且标签页早就离开了流程页 ⇒ 其实就是「跳转到最终界面」了。
   * 直接收尾，省掉那次网络探测（tabs.onUpdated 一般已经先一步收尾了，这里是兜底）。 */
  if ((f.confirmed || 0) >= 1 && f.tabId) {
    const t = await chrome.tabs.get(f.tabId).catch(() => null);
    if (t && landedOnFinalPage(f, t.url)) {
      await finalizeSuccess(f, '已跳转到完成界面');
      return;
    }
  }

  /* 停在「服务选择独立页」上、却一次「确定」都还没点过 → 让页面去选服务。
   * 这是主人报的「serviceSelection 页还是没有自动选择」的兜底：
   * 正常情况下页面脚本自己会动手，这条只在它没动的时候才生效（而且只发一次）。 */
  if (f.status === 'running' && (f.confirmed || 0) < 1) {
    if (await nudgeServicePage(f)) {
      scheduleVerify(3);
      return;
    }
  }

  const p = await probeConfirmed();
  await applyProbeResult(p);

  const onlineOk = !!(p.online && p.confidence === 'high');
  const pageOk = f.status === 'success' || f.status === 'skipped';
  const ok = onlineOk || pageOk;

  if (!ok) {
    const tries = (f.verifyCount || 0) + 1;
    // probable（页面没报错、也没报成功）多给几次机会；running（页面还卡在选服务）也要多探几轮
    const maxTries = f.status === 'probable' ? 7 : 5;
    if (tries <= maxTries) {
      await setState({ flow: { ...f, verifyCount: tries } });
      scheduleVerify(tries <= 3 ? 2 : 3);
      return;
    }
    const detail = [];
    if (f.note) detail.push(f.note);
    detail.push(
      p.captive ? '探测仍被网关拦到认证页' : p.unsure ? '探测结果不可信' : '探测未通过' + (p.error ? '（' + p.error + '）' : '')
    );
    if (f.status === 'running') detail.push('页面流程没给出结论');
    await finalizeFailure(f, detail.join('；'));
    return;
  }

  const note =
    f.status === 'skipped'
      ? '已在线，无需重复认证'
      : f.status === 'probable' || f.status === 'running'
        ? onlineOk
          ? '认证已生效（网络探测确认）'
          : f.note || '认证成功'
        : f.note || (onlineOk ? '网络探测通过' : '认证成功');
  await finalizeSuccess(f, note, { idle: f.status === 'skipped' });
}

/* ---------- 触发时机 ---------- */

/* 认证成功后门户常常整页跳到 redirectUrl：这一跳会把页面里的脚本直接销毁，
 * 它根本来不及回报结论。所以盯着登录标签页的地址——一旦跳离门户域，
 * 立刻探一次网络，把结果捡回来（这是「通知等好久」最隐蔽的根因）。 */
chrome.tabs.onUpdated.addListener((tabId, info, tab) => {
  // 只关心「地址变了」这件事，其他 onUpdated 事件（加载状态等）直接略过，省开销
  if (!info || !info.url) return;
  (async () => {
    try {
      const st = await getState();
      const f = st.flow;
      if (!f || f.tabId !== tabId || f.verified) return;
      const url = (tab && tab.url) || info.url;
      if (!url || /^(chrome|edge|about|devtools|extension)/i.test(url)) return;

      // ① 跳到「服务选择」独立页：门户把这一步做成了整页路由（entry/pc/serviceSelection），
      //    **不会离开门户域**，所以下面那条「跳离门户 → 立刻核查」根本不会触发。
      //    这里排一次快速核查：页面自己动手了就什么都不会发生；没动手就补一次指令。
      if (isServiceSelectionUrl(url)) {
        scheduleVerify(2);
        return;
      }

      /* ② 点过「确定」之后又离开了流程页 ⇒ **跳转到最终界面** ⇒ 立刻算完成。
       *    这条取代了旧的「跳离门户域 → 600ms 后排一次探测」：那时还得等一次探测才能收尾，
       *    通知和关页面都被拖后。现在直接收尾（认证已经做完了，没有不确定的东西要等）。 */
      if (landedOnFinalPage(f, url)) {
        await finalizeSuccess(f, '已跳转到完成界面');
        return;
      }

      // ③ 其余情况（还停在登录页 / 服务选择页）：页面脚本自己会继续跑，后台不插手
    } catch (e) {
      /* 忽略 */
    }
  })();
});

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === ALARM_SCHEDULE) {
    (async () => {
      /* 「每 N 天」模式下闹钟到点还要再看一眼：上次认证可能就发生在刚才（比如刚手动点过），
       * 那这一轮本来就该跳过，重新排下一次即可，不用开页面。 */
      const cfg0 = await getConfig();
      const st0 = await getState();
      const floorTs = earliestByInterval(cfg0, st0);
      await scheduleNext();
      if (floorTs && Date.now() < floorTs) return;
      if (!cfg0.enabled || st0.paused) return;
      /* ---- 1.16.0：「按需认证」模式（设置里没勾「先下线再认证」）----
       * 在计划时间**前后 30 秒**内密集探测：没网才认证；有网就什么都不做，
       * 连标签页都不开 —— 这是最省电脑资源的一条路。
       * 勾了的（强制续期）不探，直接进页面走「我要下线 → 重新认证」，那是另一套。 */
      if (!cfg0.reloginWhenOnline) {
        if (!cfg0.username || !cfg0.password) return;
        const r = await probeBurst(SCHEDULE_BURST_PROBES, SCHEDULE_BURST_MS);
        if (r.verdict === 'offline') {
          await loginFlow({ reason: 'schedule', force: true });
          return;
        }
        if (r.verdict === 'online') {
          await note('到点了，但网络正常（认证还没到期）—— 本次不做任何操作' + onlineNote(r.probe || {}));
          return;
        }
        /* unsure：探测判不出来（检测点可能被学校屏蔽）→ 按老路进网页，让页面自己判断。 */
      }
      await loginFlow({ reason: 'schedule' });
    })();
    return;
  }
  if (alarm.name === ALARM_EXPIRY) {
    expiryFlow().catch(() => {});
    return;
  }
  if (alarm.name === ALARM_VERIFY) {
    verifyFlow();
    return;
  }
  if (alarm.name === ALARM_RETRY) {
    (async () => {
      const st = await getState();
      const r = st.retry;
      if (!r || !r.scheduledFor) return;
      if (Date.now() - r.scheduledFor > 15 * 60 * 1000) {
        await setState({ retry: null });
        return;
      }
      await setState({ retry: null });
      await loginFlow({ reason: r.reason || 'retry', attempts: r.attempts, force: true });
    })();
  }
});

chrome.runtime.onInstalled.addListener(async (details) => {
  await scheduleNext();
  if (details && details.reason === 'install') {
    const cfg = await getConfig();
    if (!cfg.username) {
      try {
        chrome.runtime.openOptionsPage();
      } catch (e) {
        /* 忽略 */
      }
    }
  }
});

chrome.runtime.onStartup.addListener(async () => {
  await scheduleNext();
  const cfg = await getConfig();
  if (!cfg.enabled) return;

  if (cfg.loginOnStartup) {
    await loginFlow({ reason: 'startup', force: true });
    return;
  }
  if (cfg.catchUpOnStartup) {
    const st = await getState();
    const times = parseTimes(cfg.schedule.times);
    const passed = times.some((t) => {
      const d = new Date();
      d.setHours(t.h, t.m, 0, 0);
      return d.getTime() < Date.now();
    });
    /* 「每 N 天」模式下，还没到间隔就不算「错过」—— 那本来就是该跳过的日子。 */
    const floorTs = earliestByInterval(cfg, st);
    const due = !floorTs || Date.now() >= floorTs;
    if (passed && st.lastLoginDay !== todayKey() && due) {
      await loginFlow({ reason: 'catchup', force: true });
    }
  }
});

chrome.storage.onChanged.addListener((changes, area) => {
  if (area === 'local' && changes.config) scheduleNext();
});

/* ---------- 消息接口 ---------- */

async function getStatusPayload() {
  const cfg = await getConfig();
  const st = await getState();
  return {
    config: {
      enabled: cfg.enabled,
      username: cfg.username,
      passwordSet: !!cfg.password,
      operator: cfg.operator,
      portalOpenMode: cfg.portalOpenMode === 'direct' ? 'direct' : 'gateway',
      portalUrl: cfg.portalUrl,
      portalFallbackUrl: cfg.portalFallbackUrl,
      checkUrls: cfg.checkUrls,
      probeBeforeLogin: !!cfg.probeBeforeLogin,
      closeTabOnSuccess: !!cfg.closeTabOnSuccess,
      notify: !!cfg.notify,
      scheduleEnabled: !!cfg.schedule.enabled,
      scheduleTimes: cfg.schedule.times,
      intervalDays: Number(cfg.schedule.intervalDays) || 1,
      loginOnStartup: cfg.loginOnStartup,
      /* 1.16.0：弹窗要拿这两个画倒计时、并说明现在是哪种模式 */
      sessionMinutes: Number(cfg.sessionMinutes) || 0,
      reloginWhenOnline: !!cfg.reloginWhenOnline,
      advancedEnabled: !!cfg.advanced.enabled
    },
    state: st
  };
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (!msg || !msg.type) return;

  if (msg.type === 'GET_STATUS') {
    getStatusPayload().then(sendResponse);
    return true;
  }

  if (msg.type === 'CHECK_NOW') {
    (async () => {
      const r = await probeWithRetry(2);
      await applyProbeResult(r);
      sendResponse(await getStatusPayload());
    })();
    return true;
  }

  /* 页面脚本问「现在到底有没有网」。
   *
   * ⚠ 为什么必须由后台来探：内容脚本跑在页面的 origin 下，跨域 fetch 受 CORS 约束，
   * 读不到状态码、也读不到正文 —— 探测点回的是 204 还是网关塞的拦截页，它根本分不出来。
   * 后台有 host_permissions，fetch 不受 CORS 限制，所以探测一律交给它做。
   *
   * 顺手把结果写进 state：一次询问两用，弹窗那边的「最近检测」也跟着更新。 */
  if (msg.type === 'PROBE_NOW') {
    (async () => {
      try {
        const r = await probeConfirmed();
        await applyProbeResult(r);
        sendResponse({
          online: !!r.online,
          confidence: r.confidence || '',
          captive: !!r.captive,
          unsure: !!r.unsure,
          via: r.via || '',
          why: r.why || r.error || ''
        });
      } catch (e) {
        sendResponse({ online: false, unknown: true, why: (e && e.message) || String(e) });
      }
    })();
    return true;
  }

  if (msg.type === 'LOGIN_NOW') {
    (async () => {
      await loginFlow({
        reason: 'manual',
        force: true,
        foreground: true,
        tabId: msg.tabId || 0,
        url: msg.url || '',
        forcePortal: !!msg.forcePortal
      });
      sendResponse(await getStatusPayload());
    })();
    return true;
  }

  if (msg.type === 'OPEN_PORTAL') {
    /* 「打开认证页」：不管探测定什么结论，都把门户页面开到前台来，
     * 页面里的内容脚本会立刻自己填表（这就是主人手动打开网页的那条路，只是自动化了） */
    (async () => {
      await loginFlow({ reason: 'open-portal', force: true, forcePortal: true, foreground: true });
      sendResponse(await getStatusPayload());
    })();
    return true;
  }

  if (msg.type === 'SET_PAUSED') {
    (async () => {
      await setState({ paused: !!msg.paused });
      await scheduleNext();
      sendResponse(await getStatusPayload());
    })();
    return true;
  }

  if (msg.type === 'PORTAL_FORM_DETECTED') {
    (async () => {
      const cfg = await getConfig();
      const st = await getState();
      if (!cfg.enabled || st.paused || !cfg.autoLoginOnPortalPage) return;
      if (!cfg.username || !cfg.password) {
        await note('检测到认证页，但还没填密码，请在设置里补上');
        return;
      }
      const url = msg.url || (sender.tab && sender.tab.url) || '';
      if (!sender.tab || !isAllowedPortalHost(url, cfg, st)) return;
      if (st.flow && st.flow.status === 'running') return;
      // 页面自己动手是最快的路径；只有它没接（开关关闭、刚试过等）才会走到这里
      if (Date.now() - (st.lastAttemptAt || 0) < 10000) return;
      await loginFlow({ reason: 'portal-page', tabId: sender.tab.id, url, force: true });
    })();
    sendResponse({ received: true });
    return;
  }

  if (msg.type === 'FILL_RESULT') {
    (async () => {
      const r = msg.result || {};
      const st = await getState();
      const patch = { lastResult: r.note || st.lastResult, lastResultAt: Date.now() };
      if (r.diag) patch.diag = r.diag; // 卡住时的页面快照，弹窗里能看到
      if (r.diagHtml) patch.diagHtml = r.diagHtml; // 卡住时那一块的原始 HTML，便于定位结构
      // 页面自己动手跑流程时后台还没有 flow 记录，这里用 sender 的标签页补一条，
      // 这样它的最终结论照样能触发「关页面 + 通知」。
      const tabId = (st.flow && st.flow.tabId) || (sender && sender.tab && sender.tab.id) || 0;
      const base = st.flow || {
        startedAt: Date.now(),
        tabId,
        fromTab: false,
        status: 'running',
        note: '',
        attempts: Number.isFinite(r.submitted) ? Math.max(1, r.submitted) : 1,
        verifyCount: 0,
        submitted: 0,
        confirmed: 0
      };
      if (tabId && !base.tabId) base.tabId = tabId;
      const merged = {
        ...base,
        status: r.final ? r.status || base.status : base.status,
        note: r.note || base.note,
        submitted: Number.isFinite(r.submitted) ? r.submitted : base.submitted,
        confirmed: Number.isFinite(r.confirmed) ? r.confirmed : base.confirmed
      };
      /* 页面正在跑「已在线 → 先下线再认证」：这一段网络本来就是通的，
       * 后台不能拿 204 探测去判「已完成」（那会在半路收尾、把下线流程打断）。
       * 记下来，verifyFlow 在宽限期内不再自作主张，等页面给终局结论。 */
      if (r.relogin) {
        merged.relogin = true;
        merged.reloginAt = merged.reloginAt || Date.now();
      }
      patch.flow = merged;
      await setState(patch);

      // 页面预告「约几秒后有结果」时，按它的节奏提前核查一次。
      // 关键场景：门户认证成功后整页跳到 redirectUrl，旧页面脚本被销毁、来不及回报，
      // 这时只能靠这次提前安排的探测把结果捡回来（否则会干等到超时）。
      if (!r.final && Number.isFinite(r.expectResultIn)) {
        scheduleVerify(r.expectResultIn);
      }

      // 页面给出最终结论就立刻收尾：关页面 + 通知，不再干等定时核查
      if (r.final && !base.verified) {
        if (r.status === 'success' || r.status === 'skipped') {
          // 页面报的是「明确」成功标识（内容脚本已收紧判定：必须出现认证成功/已在线这类字样，
          // 光看到「已连接」「注销」这种词不算），可以立刻收尾
          await finalizeSuccess(merged, r.note || '门户已提示认证成功', { idle: r.status === 'skipped' });
          return;
        }
        if (r.status === 'probable') {
          /* 页面「没报错、也没报成功」（比如提交后弹窗消失了）——旧版这里直接当成功，
           * 结果在「服务还没真正选中」的时候就把页面关了。现在改成：只记「待确认」，
           * 交给可信探测去定论；探测说 204 通过才算成功。 */
          await setState({
            lastResult: (r.note || '页面流程已结束') + '，正在用网络探测确认…',
            lastResultAt: Date.now()
          });
          scheduleVerify(Number.isFinite(r.expectResultIn) ? r.expectResultIn : 2);
          await updateBadge();
          return;
        }
        if (r.status === 'failed') {
          await finalizeFailure(merged, r.note || '页面流程失败');
          return;
        }
      }
      await updateBadge();
    })();
    sendResponse({ received: true });
    return true;
  }
});

scheduleNext();
updateBadge();
