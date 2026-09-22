/* 后台（service worker）逻辑仿真测试
 * 用 mock chrome API 在 vm 里跑 background.js，重点验证主人反馈过的几件事：
 *   1. 认证页入口：gateway 模式先探一次网络 —— 已在线就不开任何标签（不会留下「无标题」的空白检测页）；
 *      掉线则优先直接打开探测到的门户地址（自带 sessionId/userIp/userMac 等参数）
 *   2. 结论一到就收尾：页面报成功要立刻通知 + 关页面，不能干等定时核查
 *   3. 通知要排在关页面之前（关标签本身也要时间）
 *   4. 认证成功后门户整页跳走（脚本被销毁）时，tabs.onUpdated 要立刻把结果捡回来
 *   4b. **「跳转到最终界面」就算完成**：点过「确定」之后只要离开流程页（登录页 / 服务选择页）
 *       就直接收尾 —— 不再等一次网络探测（主人要求「节省时间，避免关页面和通知延迟」）
 *   5. 页面自己抢跑（无 flow 记录）时，它的结论也要能触发收尾
 *   6. **通知只留「成功」那一个**：失败不弹、本来就在线也不弹
 *   7. 卡住时的页面诊断要存进 state.diag，供弹窗显示
 *   8. 并发写状态不丢更新（setState 已串行化）
 *   9. **检测点被网关回了 200 的拦截页时，绝不许说「无需认证」**（主人报的 bug）
 *  10. **只有「页面明确报成功」或「204 级别的可信探测」才算成功**——
 *      否则会在服务选择还没走完时就把认证页关掉（主人报的「服务没选就关闭了」）
 *  11. 「打开认证页」按钮不管探测结论如何都真的把门户开出来
 * 运行：node test/background-test.mjs   （输出写入 test/background-result.txt）
 */

import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
// 可用环境变量指向另一份 background.js，便于做「改动前后」对照回归
const BG = fs.readFileSync(process.env.BG_JS || path.join(HERE, '..', 'background.js'), 'utf8');

const BASE_CONFIG = {
  enabled: true,
  username: 'test-user',
  password: 'demo-pass',
  operator: '中国电信',
  portalOpenMode: 'gateway',
  portalUrl: 'https://portal.example.edu.cn/portal/portal-main',
  checkUrls: 'http://connectivitycheck.platform.hicloud.com/generate_204\nhttp://connect.rom.miui.com/generate_204',
  schedule: { enabled: false, times: '' },
  loginOnStartup: false,
  catchUpOnStartup: false,
  probeBeforeLogin: false,
  autoLoginOnPortalPage: true,
  backgroundTab: true,
  closeTabOnSuccess: true,
  closeTriggerTabOnSuccess: false,
  notify: true,
  maxAttempts: 2,
  waitAfterSubmitSeconds: 8,
  selectors: { username: '', password: '', submit: '' },
  advanced: { enabled: false, url: '', method: 'POST', format: 'form', body: '', successText: '' }
};

const hostSetTimeout = setTimeout;

function makeEnv(cfgOverride, opts) {
  const o = opts || {};
  const store = { config: { ...BASE_CONFIG, ...(cfgOverride || {}) }, state: { ...(o.state || {}) } };
  const env = {
    store,
    created: [],
    removed: [],
    notifications: [],
    alarms: [],
    tabMessages: [],
    timers: [],
    events: [],
    handler: null,
    onUpdated: null,
    idSeq: 500
  };

  const chrome = {
    storage: {
      local: {
        get: async (keys) => {
          const list = typeof keys === 'string' ? [keys] : Array.isArray(keys) ? keys : Object.keys(keys || {});
          const out = {};
          list.forEach((k) => {
            if (k in store) out[k] = store[k];
          });
          return out;
        },
        set: async (obj) => {
          Object.assign(store, obj);
        }
      },
      onChanged: { addListener: () => {} }
    },
    alarms: {
      create: (name, info) => env.alarms.push({ name, info }),
      clear: async () => true,
      onAlarm: { addListener: () => {} }
    },
    tabs: {
      query: async () => o.queryTabs || [],
      create: async ({ url, active }) => {
        const t = { id: ++env.idSeq, url, active: !!active };
        env.created.push(t);
        return t;
      },
      update: async (id, info) => {
        env.updated = env.updated || [];
        env.updated.push({ id, info });
      },
      get: async (id) => {
        const t = env.created.find((x) => x.id === id) || (o.queryTabs || []).find((x) => x.id === id);
        return { id, status: 'complete', url: (t && t.url) || '' };
      },
      remove: async (id) => {
        env.removed.push(id);
        env.events.push(['close', id]);
      },
      sendMessage: (tabId, msg, cb) => {
        env.tabMessages.push({ tabId, msg: msg && msg.type });
        const resp = msg && msg.type === 'PING' ? o.ping || { ok: true, hasPassword: true } : undefined;
        if (typeof cb === 'function') hostSetTimeout(() => cb(resp), 0);
        return Promise.resolve(resp);
      },
      onUpdated: {
        addListener: (fn) => {
          env.onUpdated = fn;
        },
        removeListener: () => {}
      }
    },
    scripting: { executeScript: async () => [] },
    notifications: {
      create: (id, opt) => {
        env.notifications.push(opt);
        env.events.push(['notify', opt.title]);
      }
    },
    action: {
      setBadgeText: async () => {},
      setBadgeBackgroundColor: async () => {},
      setTitle: async () => {}
    },
    runtime: {
      onMessage: {
        addListener: (fn) => {
          env.handler = fn;
        }
      },
      onInstalled: { addListener: () => {} },
      onStartup: { addListener: () => {} },
      openOptionsPage: () => {},
      lastError: null
    }
  };

  const ctx = vm.createContext({
    chrome,
    fetch:
      o.fetch ||
      // 默认：检测点原样返回 204（真的通了）。url 必须回请求地址本身——
      // 探测逻辑会用「最终地址是否换了域名」来判断有没有被网关劫持，mock 不能乱填。
      (async (url) => ({
        status: 204,
        ok: true,
        url: String(url),
        redirected: false,
        headers: { get: () => null },
        text: async () => ''
      })),
    URL,
    console,
    AbortController,
    // 定时器加速：等待类 sleep 立即兑现，延时值同时被记录下来供断言
    setTimeout: (fn, ms) => {
      env.timers.push(ms || 0);
      return hostSetTimeout(fn, 0);
    },
    clearTimeout: (id) => clearTimeout(id)
  });
  vm.runInContext(BG, ctx);
  env.ctx = ctx;
  return env;
}

async function settle(times) {
  for (let i = 0; i < (times || 12); i++) await new Promise((r) => hostSetTimeout(r, 5));
}

const results = [];
const checks = [];
const check = (name, ok) => checks.push([name, !!ok]);
const runningFlow = (extra) => ({
  startedAt: Date.now(),
  tabId: 999,
  fromTab: false,
  /* 1.13.0：这些用例里的标签页都代表「后台自己打开的认证页」，
   * 新的关页规则是「只关扩展自己打开的页面」，所以这里要带上这个标记。 */
  openedByUs: true,
  status: 'running',
  attempts: 1,
  note: '',
  verifyCount: 0,
  submitted: 0,
  confirmed: 1,
  ...(extra || {})
});

/* ---------- 1. 入口选择 ----------
 * 之前每次认证都无条件打开一个「检测地址」标签，网络已通时那个页面就是空白的
 * （标题「无标题」）—— 主人反馈过这个残留。现在改为先探一次：
 *   已联网 → 连标签都不开；掉线 → 优先直接打开探测到的门户地址（自带 sessionId 等参数） */

/* 1a. 已经联网：不开标签、不打扰
 * ⚠ 关掉续期（`reloginWhenOnline: false`）才是这条老行为成立的前提 ——
 *   默认开着时，即使探测说网络通也**一定要进网页**，否则续期那套流程永远没机会跑到
 *   （见用例 23a）。 */
{
  const env = makeEnv({ portalOpenMode: 'gateway', reloginWhenOnline: false });
  await env.ctx.loginFlow({ force: true });
  await settle();
  results.push({
    case: '1a gateway + 已在线',
    created: env.created.map((t) => t.url),
    notifications: env.notifications.length,
    lastResult: env.store.state.lastResult
  });
  check('1a 已在线：一个标签都不开（不会留下空白检测页）', env.created.length === 0);
  check('1a 已在线：不向页面下发指令', !env.tabMessages.some((m) => m.msg === 'FILL_AND_SUBMIT'));
  check('1a 已在线：不弹通知', env.notifications.length === 0);
  check('1a 已在线：结果记为「本次无需认证」', /无需认证/.test(env.store.state.lastResult || ''));
}

/* 1b. 掉线：直接用探测到的门户地址，而不是检测地址 */
{
  const captive = async (url) => ({
    status: 200,
    ok: true,
    url: 'http://10.0.0.1/portal/portal-main?sessionId=abc&userIp=10.0.0.123',
    headers: { get: (h) => (String(h).toLowerCase() === 'content-type' ? 'text/html' : null) },
    text: async () => '<html>校园网 上网认证 请输入账号 密码 wlanuserip</html>'
  });
  const env = makeEnv({ portalOpenMode: 'gateway' }, { fetch: captive });
  await env.ctx.loginFlow({ force: true });
  await settle();
  const url = (env.created[0] || {}).url || '';
  results.push({ case: '1b gateway + 掉线', created: env.created.map((t) => t.url), alarms: env.alarms.map((a) => a.name) });
  check('1b 掉线：打开了探测到的门户地址', url === 'http://10.0.0.1/portal/portal-main?sessionId=abc&userIp=10.0.0.123');
  check('1b 掉线：没有停在空白检测页', !/generate_204/.test(url));
  check('1b 掉线：向页面下发了 FILL_AND_SUBMIT', env.tabMessages.some((m) => m.msg === 'FILL_AND_SUBMIT'));
}

/* ---------- 2. direct 模式：打开用户填的认证页地址（探测确认掉线后） ---------- */
{
  const captive = async (url) => ({
    status: 200,
    ok: true,
    url: 'http://10.0.0.1/portal/portal-main?sessionId=abc',
    redirected: true,
    headers: { get: (h) => (String(h).toLowerCase() === 'content-type' ? 'text/html' : null) },
    text: async () => '<html>校园网 上网认证 请输入账号 密码</html>'
  });
  const env = makeEnv({ portalOpenMode: 'direct' }, { fetch: captive });
  await env.ctx.loginFlow({ force: true });
  await settle(30);
  const url = (env.created[0] || {}).url || '';
  results.push({ case: 'direct 模式', created: env.created.map((t) => t.url) });
  check('direct：按填写的认证页地址打开', url === 'https://portal.example.edu.cn/portal/portal-main');
}

/* ---------- 3. 已经开着门户页就复用，不新开 ---------- */
{
  const env = makeEnv({}, { queryTabs: [{ id: 77, url: 'https://portal.example.edu.cn/portal/entry/pc/finish', active: false }] });
  await env.ctx.loginFlow({ force: true });
  await settle();
  results.push({ case: '复用已有门户标签', created: env.created.length, updated: (env.updated || []).map((u) => u.id) });
  check('复用：没有新开标签', env.created.length === 0);
  check('复用：切到了已有的门户标签', (env.updated || []).some((u) => u.id === 77));
}

/* ---------- 4. 页面报成功：立刻通知 + 关页面，且通知排在关页之前 ---------- */
{
  const env = makeEnv({}, { state: { flow: runningFlow({ tabId: 999 }) } });
  const t0 = Date.now();
  env.handler({ type: 'FILL_RESULT', result: { final: true, status: 'success', note: '页面出现连接成功标识', submitted: 1, confirmed: 1 } }, {}, () => {});
  await settle(20);
  const notifiedAt = env.events.findIndex((e) => e[0] === 'notify');
  const closedAt = env.events.findIndex((e) => e[0] === 'close');
  results.push({
    case: '成功立刻收尾',
    events: env.events,
    elapsedMs: Date.now() - t0,
    flowCleared: env.store.state.flow === null,
    lastResult: env.store.state.lastResult
  });
  check('成功：认证页被立刻关闭', env.removed.includes(999));
  check('成功：发出了「校园网已连接」通知', env.notifications.some((n) => n.title === '校园网已连接'));
  check('成功：通知排在关页面之前', notifiedAt >= 0 && closedAt >= 0 && notifiedAt < closedAt);
  check('成功：从收到结论到通知 < 500ms', Date.now() - t0 < 500);
  check('成功：flow 已清空（不会重复收尾）', env.store.state.flow === null);
  check('成功：记录了认证成功与当天时间', /认证成功/.test(env.store.state.lastResult || '') && !!env.store.state.lastLoginDay);
}

/* ---------- 5. 页面报失败：立刻排重试并提示，不等定时核查 ---------- */
{
  const env = makeEnv({}, { state: { flow: runningFlow({ tabId: 888 }) } });
  env.handler({ type: 'FILL_RESULT', result: { final: true, status: 'failed', note: '已重试 3 轮仍未成功', submitted: 1 } }, {}, () => {});
  await settle(20);
  results.push({
    case: '失败立刻收尾',
    retry: env.store.state.retry,
    lastResult: env.store.state.lastResult,
    alarms: env.alarms.map((a) => a.name)
  });
  check('失败：排了自动重试', !!(env.store.state.retry && env.store.state.retry.attempts === 2));
  check('失败：结果文案提示 30 秒后重试', /30 秒后自动重试/.test(env.store.state.lastResult || ''));
  check('失败：设了重试闹钟', env.alarms.some((a) => a.name === 'campus-retry'));
  check('失败：不弹系统通知', env.notifications.length === 0);
}

/* ---------- 6. 失败到上限：通知失败并停手 ---------- */
{
  const env = makeEnv({}, { state: { flow: runningFlow({ tabId: 777, attempts: 2 }) } });
  env.handler({ type: 'FILL_RESULT', result: { final: true, status: 'failed', note: '连续失败', submitted: 1 } }, {}, () => {});
  await settle(20);
  results.push({ case: '失败到上限', retry: env.store.state.retry, lastResult: env.store.state.lastResult });
  check('到上限：不再排重试', env.store.state.retry === null);
  check('到上限：不弹系统通知（主人只要「成功」那一个）', env.notifications.length === 0);
}

/* ---------- 7. 运行中的中间回报不应提前收尾 ---------- */
{
  const env = makeEnv({}, { state: { flow: runningFlow({ tabId: 666 }) } });
  env.handler({ type: 'FILL_RESULT', result: { ok: true, status: 'running', note: '已填写账号密码并点击登录', submitted: 1 } }, {}, () => {});
  await settle(10);
  results.push({ case: '中间回报', flowStatus: env.store.state.flow && env.store.state.flow.status, removed: env.removed });
  check('中间回报：不关页面', env.removed.length === 0);
  check('中间回报：流程仍在进行', !!(env.store.state.flow && env.store.state.flow.status === 'running'));
}

/* ---------- 8. 页面预告「几秒后出结果」：即使页面随后被跳转销毁，也要及时捡回结果 ---------- */
{
  const env = makeEnv({}, { state: { flow: runningFlow({ tabId: 555 }) } });
  env.handler(
    { type: 'FILL_RESULT', result: { ok: true, status: 'running', note: '已选择「中国电信」并提交，等待结果…', expectResultIn: 3 } },
    {},
    () => {}
  );
  await settle(20);
  results.push({
    case: '页面跳走前的预告',
    timers: env.timers.slice(0, 8),
    removed: env.removed,
    notifications: env.notifications.map((n) => n.title)
  });
  check('预告：按页面给的节奏安排了核查', env.timers.some((ms) => ms === 3000));
  check('预告：核查发现网络已通 → 立刻收尾关页', env.removed.includes(555));
  check('预告：发出成功通知', env.notifications.some((n) => n.title === '校园网已连接'));
}

/* ---------- 9. 认证成功后跳转到最终界面：**立刻收尾**，不再等网络探测 ----------
 * 主人这轮的要求：「认证时，只要跳转到最终界面都算完成，节省时间，
 * 避免关闭认证页和通知延迟」。
 * 旧版在这里只安排一次 600ms 后的探测 —— 还得等探测回来才算完，通知和关页面都被拖后；
 * 现在点过「确定」之后只要离开流程页就直接收尾。 */
{
  const env = makeEnv({}, { state: { flow: runningFlow({ tabId: 4321 }) } });
  const jump = { id: 4321, url: 'http://123.123.123.123/' };
  const t0 = Date.now();
  env.onUpdated(4321, { url: jump.url }, jump);
  await settle(20);
  results.push({
    case: '跳转到最终界面就收尾',
    timers: env.timers.slice(0, 6),
    removed: env.removed,
    notifications: env.notifications.map((n) => n.title),
    lastResult: env.store.state.lastResult,
    elapsedMs: Date.now() - t0
  });
  check('9 跳转：不再排网络探测（直接把「等探测」这段省掉）', !env.timers.includes(600));
  check('9 跳转：立刻关闭认证页', env.removed.includes(4321));
  check('9 跳转：发出成功通知', env.notifications.some((n) => n.title === '校园网已连接'));
  check('9 跳转：结论写明「已跳转到完成界面」', /已跳转到完成界面/.test(env.store.state.lastResult || ''));
  check('9 跳转：从地址变化到收尾 < 400ms', Date.now() - t0 < 400);
}

/* ---------- 9b. 点过「确定」但还停在服务选择页 ⇒ 不算完成，不许收尾 ---------- */
const SVC_URL = 'https://portal.example.edu.cn/portal/entry/pc/serviceSelection;flowParams=undefined;from=authenticate;sid=false';
/* 网关仍在拦截：任何探测地址都被它换成自己的认证页（HTTP 200），绝不是 204 */
const captiveFetch = async () => ({
  status: 200,
  ok: true,
  url: 'http://10.0.0.1/portal/portal-main?sessionId=abc',
  headers: { get: (h) => (String(h).toLowerCase() === 'content-type' ? 'text/html' : null) },
  text: async () => '<html>校园网 上网认证 请选择服务 密码</html>'
});
{
  const env = makeEnv({}, {
    state: { flow: runningFlow({ tabId: 4326, confirmed: 1 }) },
    queryTabs: [{ id: 4326, url: SVC_URL }],
    fetch: captiveFetch
  });
  env.onUpdated(4326, { url: SVC_URL }, { id: 4326, url: SVC_URL });
  await settle(20);
  results.push({ case: '9b 仍停在服务选择页', removed: env.removed, notifications: env.notifications.length });
  check('9b 仍在流程页上：不算完成、不关页面', env.removed.length === 0);
  check('9b 仍在流程页上：不发成功通知', env.notifications.length === 0);
}

/* ---------- 9c. 兜底：verifyFlow 发现标签页早已在最终界面上 → 直接收尾 ---------- */
{
  const env = makeEnv({}, {
    state: { flow: runningFlow({ tabId: 4324, confirmed: 1 }) },
    queryTabs: [{ id: 4324, url: 'https://portal.example.edu.cn/portal/portal-main?sessionId=abc' }]
  });
  await env.ctx.verifyFlow();
  await settle(10);
  results.push({ case: '9c 兜底核查', removed: env.removed, lastResult: env.store.state.lastResult });
  check('9c 兜底：标签页在最终界面上 → 直接收尾关页面', env.removed.includes(4324));
  check('9c 兜底：发出成功通知', env.notifications.some((n) => n.title === '校园网已连接'));
}

/* ---------- 9d. 兜底：点过确定但标签页还在流程页上 → 不许谎报成功 ---------- */
{
  const env = makeEnv({}, {
    state: { flow: runningFlow({ tabId: 4325, confirmed: 1, status: 'running' }) },
    queryTabs: [{ id: 4325, url: SVC_URL }],
    fetch: captiveFetch
  });
  await env.ctx.verifyFlow();
  await settle(10);
  results.push({ case: '9d 仍在流程页兜底', removed: env.removed, lastResult: env.store.state.lastResult });
  check('9d 仍在流程页：不关页面', !env.removed.includes(4325));
  check('9d 仍在流程页：不谎报成功', !/认证成功/.test(env.store.state.lastResult || ''));
}

/* ---------- 10. 还没点过「确定」时，地址变化不该当成「跳转到最终界面」 ----------
 * 关键：入口页本身（entry/pc/finish、portal-main）也不是流程页地址，
 * 所以这条判据必须要求 confirmed>=1，否则一进页面就会误判成「已完成」。 */
{
  const env = makeEnv({}, { state: { flow: runningFlow({ tabId: 4322, confirmed: 0 }) } });
  env.onUpdated(4322, { url: 'http://123.123.123.123/' }, { id: 4322, url: 'http://123.123.123.123/' });
  await settle(10);
  results.push({ case: '未点确定的跳转', timers: env.timers.slice(0, 6), removed: env.removed });
  check('未点确定：不触发核查', !env.timers.includes(600));
  check('未点确定：不算完成', env.removed.length === 0 && env.notifications.length === 0);
}

/* ---------- 11. 页面自己抢跑（后台还没有 flow 记录）也能正确收尾 ---------- */
{
  const env = makeEnv({}); // state 为空：模拟页面自己检测到认证页并自行填表完成
  env.handler(
    { type: 'FILL_RESULT', result: { final: true, status: 'success', note: '页面出现连接成功标识', submitted: 1, confirmed: 1 } },
    { tab: { id: 2468, url: 'https://portal.example.edu.cn/portal/entry/pc/finish' } },
    () => {}
  );
  await settle(20);
  results.push({
    case: '页面自启动收尾',
    removed: env.removed,
    notifications: env.notifications.map((n) => n.title),
    lastResult: env.store.state.lastResult
  });
  /* 1.13.0：这一页是**主人自己打开**的（页面自启动那条路，后台从没创建过它），
   * 新规则「只关扩展自己打开的页面」下就不该再关它 ——
   * 「打开教务系统，弹个通知、网页自己关了」正是这条路走歪的结果。 */
  check('自启动：主人自己开的页面不被关掉', !env.removed.includes(2468));
  check('自启动：发出成功通知', env.notifications.some((n) => n.title === '校园网已连接'));
  check('自启动：记下当天已认证', !!env.store.state.lastLoginDay);
}

/* ---------- 11b. 1.13.0：教务系统这类校内站点绝不能被当成校园网门户 ---------- *
 * 起因（主人实测）：打开 http://xjwxt.example.edu.cn/login.action 时
 *   会突然弹一条通知，然后网页自己关掉。它同样挂在 .edu.cn 下、同样有账号密码框，
 *   旧版后台只按「是 .edu.cn 就放行」判定，于是照样开一轮认证、关掉主人的标签页。 */
{
  const env = makeEnv({});
  const cfg = await env.ctx.getConfig();
  const st = await env.ctx.getState();
  const jwxt = 'http://xjwxt.example.edu.cn/login.action';
  const portal = 'https://portal.example.edu.cn/portal/entry/pc/finish';
  results.push({
    case: '1.13.0 门户判定（URL 层）',
    jwxt: env.ctx.isAllowedPortalHost(jwxt, cfg, st),
    portal: env.ctx.isAllowedPortalHost(portal, cfg, st),
    excludeHosts: cfg.excludeHosts
  });
  check('教务系统地址：后台门禁拒绝', env.ctx.isAllowedPortalHost(jwxt, cfg, st) === false);
  check('门户地址：后台门禁照旧放行', env.ctx.isAllowedPortalHost(portal, cfg, st) === true);
  /* 默认按本校（Anhui Polytechnic University）列好教务 / 图书馆等校内业务域名；
   * 换学校可在设置里清空 —— 那时仍靠 URL 里的业务路径特征（jwxt / ehall / ids …）挡住，见上面那条。 */
  check('默认排除名单按本校列好了教务系统', /xjwxt\.ahpu\.edu\.cn/.test(String(cfg.excludeHosts || '')));
}

/* ---------- 11c. 1.13.0：教务系统页上报「发现认证页」时，后台不许动 ---------- */
{
  const env = makeEnv({}, { state: { flow: null } });
  env.handler(
    { type: 'PORTAL_FORM_DETECTED', url: 'http://xjwxt.example.edu.cn/login.action', hasPassword: true },
    { tab: { id: 6666, url: 'http://xjwxt.example.edu.cn/login.action' } },
    () => {}
  );
  await settle(15);
  results.push({
    case: '教务系统上报认证页',
    lastResult: env.store.state.lastResult,
    removed: env.removed
  });
  check('教务系统：不发起认证流程', !/已打开认证页|开始执行登录流程/.test(env.store.state.lastResult || ''));
  check('教务系统：不关掉主人的页面', !env.removed.includes(6666));
}

/* ---------- 12. 同一轮认证只收尾一次（不重复通知） ---------- */
{
  const env = makeEnv({}, { state: { flow: runningFlow({ tabId: 1111 }) } });
  const payload = { type: 'FILL_RESULT', result: { final: true, status: 'success', note: '页面出现连接成功标识', submitted: 1, confirmed: 1 } };
  env.handler(payload, {}, () => {});
  await settle(10);
  env.handler(payload, {}, () => {});
  await settle(10);
  results.push({ case: '重复收尾抑制', notifications: env.notifications.length, removed: env.removed });
  check('不重复通知：只发 1 次', env.notifications.length === 1);
  check('不重复关页：只关 1 次', env.removed.length === 1);
}

/* ---------- 13. 本来就在线（无需认证）：静默，不弹通知 ---------- */
{
  const env = makeEnv({}, { state: { flow: runningFlow({ tabId: 3333, status: 'skipped', note: '已在线，无需重复认证' }) } });
  await env.ctx.verifyFlow();
  await settle(20);
  results.push({
    case: '已在线无需认证',
    notifications: env.notifications.map((n) => n.title),
    lastResult: env.store.state.lastResult
  });
  check('无需认证：不弹通知（没干活就别打扰）', env.notifications.length === 0);
  check('无需认证：结果仍然记录下来', /无需|已在线/.test(env.store.state.lastResult || ''));
}

/* ---------- 14. 卡住时的页面诊断要存下来，供弹窗显示 ---------- */
{
  const env = makeEnv({}, { state: { flow: runningFlow({ tabId: 2222 }) } });
  env.handler(
    {
      type: 'FILL_RESULT',
      result: { final: true, status: 'failed', note: '找不到可用的「确定」按钮', diag: 'radio=3(选中0) 按钮=[确定|重新登录]', submitted: 1 }
    },
    {},
    () => {}
  );
  await settle(30);
  results.push({
    case: '诊断透传',
    diag: env.store.state.diag,
    lastResult: env.store.state.lastResult
  });
  check('诊断：存进 state.diag（弹窗能看）', env.store.state.diag === 'radio=3(选中0) 按钮=[确定|重新登录]');
  check('诊断：失败结论保留在 lastResult', /确定/.test(env.store.state.lastResult || ''));
}

/* ---------- 15. 并发写状态不丢更新 ----------
 * 曾经的坑：setState 是「读→改→写」，定时排程与消息处理同时写时，
 * 后写的会拿着旧快照把先写的改动抹掉（诊断信息就是这么丢的）。 */
{
  const env = makeEnv({});
  await Promise.all([env.ctx.setState({ diag: 'radio=3(选中0)' }), env.ctx.setState({ lastResult: '并发写入的结果' })]);
  await settle(10);
  results.push({ case: '并发写状态', diag: env.store.state.diag, lastResult: env.store.state.lastResult });
  check(
    '并发写：两次写入都保留（不丢更新）',
    env.store.state.diag === 'radio=3(选中0)' && env.store.state.lastResult === '并发写入的结果'
  );
}

/* ---------- 16. 检测点被网关回了「200 的拦截页」时，绝不许说「无需认证」 ----------
 * 主人报的原话：「没有网络，却显示无需认证，必须手动打开网页」。
 * 根因：旧版 probeOnce 里那句 `if (res.ok) return { online: true }`。
 * 网关拦截时很多情况下不是 302，而是直接回一个 200 的拦截页，内容里又没有
 * 「认证/登录」字样，于是被读成「已联网」→ 一个标签都不开 → 只能手动去翻门户。 */
{
  const gateway200 = async (url) => ({
    status: 200,
    ok: true,
    url: String(url), // 没有跳转
    redirected: false,
    headers: { get: (h) => (String(h).toLowerCase() === 'content-type' ? 'text/html' : null) },
    text: async () => '<html><body>ok</body></html>' // 故意不含任何门户关键词
  });
  /* 通用版默认不再预置备用入口地址（各校门户地址不同），
   * 这个用例验的是「填了备用入口就会去试」，所以显式给一个。 */
  const env = makeEnv(
    {
      portalOpenMode: 'gateway',
      portalFallbackUrl: 'https://portal.example.edu.cn/portal/entry/pc/finish'
    },
    { fetch: gateway200, ping: { ok: true, hasPassword: false } }
  );
  await env.ctx.loginFlow({ force: true });
  await settle(60);
  const visited = [
    ...env.created.map((t) => t.url),
    ...(env.updated || []).map((u) => u.info && u.info.url).filter(Boolean)
  ];
  results.push({
    case: '16 检测点被拦(200 非跳转)',
    visited,
    lastCheckInfo: env.store.state.lastCheckInfo,
    lastResult: env.store.state.lastResult
  });
  check('16 绝不许说「无需认证」', !/无需认证/.test(env.store.state.lastResult || ''));
  check('16 探测结论是「被网关拦了」', /不是 204/.test(env.store.state.lastCheckInfo || ''));
  check('16 照样把认证页开出来', env.created.length === 1);
  check('16 备用入口（finish 页）也试过', visited.some((u) => /entry\/pc\/finish/.test(u || '')));
  check('16 打不开时如实报告，而不是静默成功', /打不开登录表单/.test(env.store.state.lastResult || ''));
}

/* ---------- 17. probable（页面没报错也没报成功）必须由探测确认，不能直接当成功 ---------- */
{
  // 17a. 探测确认不了（仍被网关拦）→ 判失败 + 排重试，但绝不关页面
  const captive = async (url) => ({
    status: 200,
    ok: true,
    url: 'http://10.0.0.1/portal/portal-main?sessionId=abc&userIp=10.0.0.123',
    redirected: true,
    headers: { get: (h) => (String(h).toLowerCase() === 'content-type' ? 'text/html' : null) },
    text: async () => '<html>校园网 上网认证 请输入账号 密码 wlanuserip</html>'
  });
  const env = makeEnv(
    {},
    { state: { flow: runningFlow({ tabId: 1313, status: 'probable', submitted: 1, confirmed: 1 }) }, fetch: captive }
  );
  env.handler(
    { type: 'FILL_RESULT', result: { final: true, status: 'probable', note: '提交后页面不再报错', submitted: 1, confirmed: 1 } },
    {},
    () => {}
  );
  for (let i = 0; i < 9; i += 1) {
    await env.ctx.verifyFlow();
    await settle(3);
  }
  results.push({
    case: '17a probable + 探测未通过',
    removed: env.removed,
    notifications: env.notifications.map((n) => n.title),
    lastResult: env.store.state.lastResult,
    retry: env.store.state.retry
  });
  check('17a 不关页面（服务还没真正走完就不能关）', !env.removed.includes(1313));
  check('17a 不弹通知', env.notifications.length === 0);
  check('17a 判为失败并排重试', !!(env.store.state.retry && env.store.state.retry.attempts === 2));
}

/* ---------- 17b. probable + 探测 204 确认 → 这时才关页面 + 通知 ---------- */
{
  const env = makeEnv({}, { state: { flow: runningFlow({ tabId: 1314, status: 'probable', submitted: 1, confirmed: 1 }) } });
  env.handler(
    { type: 'FILL_RESULT', result: { final: true, status: 'probable', note: '提交后页面不再报错', submitted: 1, confirmed: 1 } },
    {},
    () => {}
  );
  await settle(30);
  results.push({
    case: '17b probable + 探测通过',
    removed: env.removed,
    notifications: env.notifications.map((n) => n.title),
    lastResult: env.store.state.lastResult
  });
  check('17b 探测确认后才关页面', env.removed.includes(1314));
  check('17b 探测确认后才通知', env.notifications.some((n) => n.title === '校园网已连接'));
}

/* ---------- 18. 卡在「选服务」时（还没点过确定），探测通不过就不许关页面 ----------
 * 这就是主人报的「服务依旧没有选就关闭了」：旧版 verifyFlow 写的是
 * `const ok = p.online || pageOk`，探测一误判就把页面关掉。 */
{
  const captive = async (url) => ({
    status: 200,
    ok: true,
    url: 'http://10.0.0.1/portal/portal-main?sessionId=abc',
    redirected: true,
    headers: { get: (h) => (String(h).toLowerCase() === 'content-type' ? 'text/html' : null) },
    text: async () => '<html>校园网 上网认证 请选择服务 密码</html>'
  });
  const env = makeEnv(
    {},
    { state: { flow: runningFlow({ tabId: 1414, confirmed: 0, submitted: 1, note: '已选择「中国电信」并提交（第 1 次），等待认证结果…' }) }, fetch: captive }
  );
  for (let i = 0; i < 9; i += 1) {
    await env.ctx.verifyFlow();
    await settle(3);
  }
  results.push({
    case: '18 卡在选服务 + 探测未通过',
    removed: env.removed,
    notifications: env.notifications.map((n) => n.title),
    lastResult: env.store.state.lastResult
  });
  check('18 不关页面', !env.removed.includes(1414));
  check('18 不通知', env.notifications.length === 0);
  check('18 如实报告失败（不谎报成功）', /认证未成功|认证失败/.test(env.store.state.lastResult || ''));
}

/* ---------- 19. 「打开认证页」：哪怕探测说已在线，也真的把门户开出来 ---------- */
{
  const env = makeEnv({}, { ping: { ok: true, hasPassword: true } }); // 默认 fetch = 204，即「已在线」
  env.handler({ type: 'OPEN_PORTAL' }, {}, () => {});
  await settle(40);
  const url = (env.created[0] || {}).url || '';
  results.push({ case: '19 强制打开认证页', created: env.created.map((t) => t.url), lastResult: env.store.state.lastResult });
  check('19 已在线也照样开认证页（主人手动打开那条路自动化）', env.created.length === 1 && /^https?:\/\//.test(url));
  check('19 不再用「无需认证」把人挡在门外', !/无需认证/.test(env.store.state.lastResult || ''));
}

/* ---------- 20. 探测地址全部「挂住不回应」时，认证流程不许卡在那 ----------
 * 主人报的「跳转太慢」多半就是这么来的：探测用的 fetch 原先没有超时，
 * 不在校园网 / 学校把这几个探测地址全屏蔽时，浏览器会一路挂着等 TCP 超时，
 * 一个地址十几秒，几个地址叠起来就是「点了半天没反应」。
 * 现在每个地址最多等 1500ms，而且连挂两个就直接收手，照样把认证页开出来。 */
{
  const hanging = (url, init) =>
    new Promise((resolve, reject) => {
      const sig = init && init.signal;
      if (sig) sig.addEventListener('abort', () => reject(new Error('probe timeout')));
    });
  const env = makeEnv({ portalOpenMode: 'gateway' }, { fetch: hanging, ping: { ok: true, hasPassword: true } });
  const t0 = Date.now();
  await env.ctx.loginFlow({ force: true });
  await settle(40);
  const url = (env.created[0] || {}).url || '';
  results.push({
    case: '20 探测地址全部挂住',
    created: env.created.map((t) => t.url),
    lastResult: env.store.state.lastResult,
    elapsedMs: Date.now() - t0
  });
  check('20 探测全挂也不卡住：照样把认证页开出来', env.created.length === 1 && /^https?:\/\//.test(url));
  check('20 探测全挂：不会说「无需认证」', !/无需认证/.test(env.store.state.lastResult || ''));
  check('20 探测全挂：仍然向页面下发了填表指令', env.tabMessages.some((m) => m.msg === 'FILL_AND_SUBMIT'));
}

/* ---------- 20b. 落在「服务选择」独立页上，也要算「到了」，不许报「打不开登录表单」 ----------
 * 主人这轮反馈：「serviceSelection 页还是没有自动选择」。
 * 门户把这一步做成了独立整页（/portal/entry/pc/serviceSelection;flowParams=…），
 * 那一页里**没有密码框**。旧版拿 hasPassword 当唯一的就绪条件，会一直等到超时，
 * 然后报「打不开登录表单，已依次试过…」，把页面换掉重开。 */
{
  const captive = async () => ({
    status: 200,
    ok: true,
    url: 'http://10.0.0.1/portal/portal-main?sessionId=abc',
    redirected: true,
    headers: { get: (h) => (String(h).toLowerCase() === 'content-type' ? 'text/html' : null) },
    text: async () => '<html>校园网 上网认证 请选择服务 密码</html>'
  });
  const env = makeEnv({}, { fetch: captive, ping: { ok: true, hasPassword: false, needService: true } });
  await env.ctx.loginFlow({ force: true });
  await settle(40);
  results.push({
    case: '20b 落在服务选择独立页',
    created: env.created.map((t) => t.url),
    updated: env.updated || [],
    lastResult: env.store.state.lastResult,
    messages: env.tabMessages.map((m) => m.msg)
  });
  check('20b 服务选择页也算「到了」：只开 1 个标签，不反复换入口', env.created.length === 1 && !(env.updated || []).length);
  check('20b 不报「打不开登录表单」', !/打不开登录表单/.test(env.store.state.lastResult || ''));
  check('20b 照样向页面下发指令（由页面去选服务）', env.tabMessages.some((m) => m.msg === 'FILL_AND_SUBMIT'));
}

/* ---------- 21. 停在服务选择页却没动静 → 后台补一次指令（且只补一次） ---------- */
const SERVICE_URL = 'https://portal.example.edu.cn/portal/entry/pc/serviceSelection;flowParams=undefined;from=authenticate;sid=false';
{
  const captive = async () => ({
    status: 200,
    ok: true,
    url: 'http://10.0.0.1/portal/portal-main?sessionId=abc',
    redirected: true,
    headers: { get: (h) => (String(h).toLowerCase() === 'content-type' ? 'text/html' : null) },
    text: async () => '<html>校园网 上网认证 请选择服务 密码</html>'
  });
  const env = makeEnv(
    {},
    {
      state: { flow: runningFlow({ tabId: 1717, confirmed: 0, submitted: 1, note: '已填写账号密码并点击登录，等待服务选择…' }) },
      queryTabs: [{ id: 1717, url: SERVICE_URL }],
      fetch: captive
    }
  );
  for (let i = 0; i < 4; i += 1) {
    await env.ctx.verifyFlow();
    await settle(3);
  }
  const selects = env.tabMessages.filter((m) => m.msg === 'SELECT_SERVICE');
  results.push({
    case: '21 停在服务选择页',
    messages: env.tabMessages.map((m) => m.msg),
    nudged: env.store.state.flow ? !!env.store.state.flow.serviceNudged : null,
    removed: env.removed,
    lastResult: env.store.state.lastResult
  });
  check('21 后台补发了一条「去选服务」指令', selects.length >= 1);
  check('21 只补发一次（不会反复点确定造成重复提交）', selects.length === 1);
  check('21 不关页面', !env.removed.includes(1717));
  check('21 不谎报成功', !/认证成功/.test(env.store.state.lastResult || ''));
}
{
  // 反向：标签页还在登录页（不是服务选择页）时，不该补发这条指令
  const env = makeEnv(
    {},
    {
      state: { flow: runningFlow({ tabId: 1818, confirmed: 0, submitted: 1 }) },
      queryTabs: [{ id: 1818, url: 'https://portal.example.edu.cn/portal/entry/pc/finish;flowParams=undefined;from=' }]
    }
  );
  await env.ctx.verifyFlow();
  await settle(3);
  results.push({ case: '21b 还没到服务选择页', messages: env.tabMessages.map((m) => m.msg) });
  check('21b 登录页上不会乱发「去选服务」指令', !env.tabMessages.some((m) => m.msg === 'SELECT_SERVICE'));
}

/* ---------- 22. 「已在线 → 先下线再认证」宽限期 ----------
 * 主人报的场景：定时到点、但上次认证还没到期 —— 门户不给登录表单，而是渲染「已在线」页，
 * 页面脚本要点「我要下线」，等门户注销完再重新认证一遍。
 * ⚠ 这一阶段**网络本来就是通的**（认证还没到期）。后台要是照老规矩拿 204 探测去判「已完成」，
 *   就会在半路收尾、把页面上的「下线 + 重新认证」直接打断 ——
 *   结果就是「扩展说已连接，认证时长却没续上」。 */
{
  const online204 = async (url) => ({
    status: 204,
    ok: true,
    url: String(url),
    redirected: false,
    headers: { get: () => null },
    text: async () => ''
  });
  const flow = runningFlow({
    tabId: 2201,
    relogin: true,
    reloginAt: Date.now(),
    note: '检测到已在线（认证未到期），正在先下线再重新认证…'
  });
  const env = makeEnv(
    {},
    {
      state: { flow },
      queryTabs: [{ id: 2201, url: 'https://portal.example.edu.cn/portal/entry/pc/finish;flowParams=undefined;from=' }],
      fetch: online204
    }
  );
  await env.ctx.verifyFlow();
  await settle(20);
  results.push({
    case: '22 relogin 宽限期内',
    removed: env.removed,
    notifications: env.notifications.map((n) => n.title),
    flowKept: !!env.store.state.flow,
    lastResult: env.store.state.lastResult
  });
  check('22 下线重认证期间：探测 204 也不关页面', env.removed.length === 0);
  check('22 下线重认证期间：不发成功通知', env.notifications.length === 0);
  check('22 下线重认证期间：流程仍在（没被半路收尾）', !!env.store.state.flow);
}

/* 22b. 反向钉子：宽限期到点后必须恢复兜底 —— 不许永远不收尾 */
{
  const flow = runningFlow({
    tabId: 2202,
    relogin: true,
    reloginAt: Date.now() - 100 * 1000, // 宽限期（90 秒）已经过去
    note: '正在先下线再重新认证…'
  });
  const env = makeEnv(
    {},
    {
      state: { flow },
      queryTabs: [{ id: 2202, url: 'https://portal.example.edu.cn/portal/entry/pc/finish;flowParams=undefined;from=' }]
    }
  );
  await env.ctx.verifyFlow();
  await settle(20);
  results.push({
    case: '22b 宽限期已过',
    removed: env.removed,
    notifications: env.notifications.map((n) => n.title),
    lastResult: env.store.state.lastResult
  });
  check('22b 宽限期过了：恢复兜底、正常收尾', env.removed.includes(2202));
}

/* ---------- 23. 「认证要真的进网页」（主人的原话）----------
 * 认证还没到期时**网络本来就是通的**（探测必回 204）。以前后台拿这一句
 * 「网络正常，本次无需认证」就收手，**一个页面都不开** ——
 * 页面脚本连出场的机会都没有，「已在线 → 离线 → 重新认证」那条支路永远走不到，
 * 在线时长就一直停在上次那个时间点。 */
{
  const online204 = async (url) => ({
    status: 204,
    ok: true,
    url: String(url),
    redirected: false,
    headers: { get: () => null },
    text: async () => ''
  });
  const renewCfg = {
    reloginWhenOnline: true,
    portalFallbackUrl: 'https://portal.example.edu.cn/portal/entry/pc/finish'
  };

  /* 23a 定时到点 + 认证还没到期：必须打开门户页，并且不再去开网关检测地址
   * （已经认证过时那个地址只会回一张空白页，白白等十几秒） */
  {
    const env = makeEnv(renewCfg, { ping: { ok: true, hasPassword: true } });
    await env.ctx.loginFlow({ force: true, reason: 'scheduled' });
    await settle(30);
    const url = (env.created[0] || {}).url || '';
    results.push({
      case: '23a 认证没到期（已在线）也要进网页',
      created: env.created.map((t) => t.url),
      lastResult: env.store.state.lastResult
    });
    check('23a 已在线也打开了门户页（不是「无需认证」收手）', env.created.length === 1);
    check('23a 直接进门户自己的页面，不再去开网关检测地址', !/generate_204/.test(url));
    check('23a 打开了门户的 finish 入口页', /entry\/pc\/finish/.test(url));
    check('23a 向页面下发了 FILL_AND_SUBMIT（让页面去判断要不要下线重认证）', env.tabMessages.some((m) => m.msg === 'FILL_AND_SUBMIT'));
    check('23a 不许记成「本次无需认证」', !/无需认证/.test(env.store.state.lastResult || ''));
  }

  /* 23b 反向钉子：关掉「认证没到期也要续期」的定时触发，退回旧行为——连页面都不开。
   * （这条保留是因为「一个标签都不开、不留空白页」也是主人明确要求过的。） */
  {
    const env = makeEnv({ reloginWhenOnline: false }, { fetch: online204 });
    await env.ctx.loginFlow({ force: true, reason: 'scheduled' });
    await settle();
    results.push({ case: '23b 关掉续期：定时触发仍一个标签都不开', created: env.created.map((t) => t.url) });
    check('23b 关掉续期 + 定时：仍然一个标签都不开', env.created.length === 0);
    check('23b 关掉续期 + 定时：结果记为「本次无需认证」', /无需认证/.test(env.store.state.lastResult || ''));
  }

  /* 24 手动点「保存并立即认证一次」：不管开关与探测结论，一律进网页（主人明确要求）。
   * 这一条即使把「认证没到期也要续期」关掉也成立 —— 手动点就是明确要它打开页面。 */
  {
    const env = makeEnv(
      { reloginWhenOnline: false, portalFallbackUrl: 'https://portal.example.edu.cn/portal/entry/pc/finish' },
      { fetch: online204, ping: { ok: true, hasPassword: false, needService: false, connected: true } }
    );
    await env.ctx.loginFlow({ force: true, reason: 'manual' });
    const opened = env.created.length;
    const instructed = env.tabMessages.some((m) => m.msg === 'FILL_AND_SUBMIT');
    const beforeVerify = env.store.state.lastResult;
    const flowStatus = (env.store.state.flow || {}).status;
    await settle(30);
    results.push({
      case: '24 手动「立即认证」： insist 进网页',
      created: env.created.map((t) => t.url),
      lastResult: beforeVerify
    });
    check('24 手动立即认证：真的打开了网页', opened === 1);
    check('24 手动立即认证：向页面下发了指令', instructed);
    check('24 手动立即认证：流程处于进行中', flowStatus === 'running');
    check('24 手动立即认证：不许再用「无需认证」把人挡在门外', !/无需认证/.test(beforeVerify || ''));
  }

  /* 25 页面 PING 回「已在线」+ 开着续期：不许按「本来就在线」收尾，必须把指令发下去。
   * 后一半还要复刻真机节奏：页面随即回报 `relogin`（正在点「我要下线」），
   * 这段宽限期内后台不许拿 204 探测把流程收尾（那是 case 22 已经钉死的事）。 */
  {
    const env = makeEnv(renewCfg, { ping: { ok: true, hasPassword: false, needService: false, connected: true } });
    await env.ctx.loginFlow({ force: true, reason: 'scheduled' });
    const beforeVerify = env.store.state.lastResult;
    const flowStatus = (env.store.state.flow || {}).status;
    env.handler(
      {
        type: 'FILL_RESULT',
        result: { status: 'running', final: false, relogin: true, note: '检测到已在线，正在先下线再重新认证…' }
      },
      {},
      () => {}
    );
    await settle(30);
    results.push({
      case: '25 页面已在线 + 开着续期：交给页面判断',
      removed: env.removed,
      notifications: env.notifications.map((n) => n.title),
      lastResult: env.store.state.lastResult,
      flowStatus
    });
    check('25 如实说明这一轮是去核对续期', /续期/.test(beforeVerify || ''));
    check('25 流程处于进行中（没有当场收尾）', flowStatus === 'running');
    check('25 不许直接按「已在线」收尾关页', env.removed.length === 0);
    check('25 不许弹「已连接」通知（还没干活）', env.notifications.length === 0);
    check('25 把指令发给了页面（由它决定要不要下线重认证）', env.tabMessages.some((m) => m.msg === 'FILL_AND_SUBMIT'));
  }
}

/* ---------- 18. 认证周期：每 N 天一次（intervalDays） ---------- *
 * 主人要的：其他运营商的验证是按天算的，所以支持「每 3 天认证一次」这种自定义周期。
 * 规则：N=1 保持原样（每天、一天里几个时间点都跑）；
 *      N>1 时，上次认证之后中间 N-1 天跳过，到第 N 天的时间点才再跑。 */
{
  const dayOffset = (ts) => {
    const a = new Date();
    a.setHours(0, 0, 0, 0);
    const b = new Date(ts);
    b.setHours(0, 0, 0, 0);
    return Math.round((b.getTime() - a.getTime()) / 86400000);
  };
  const mk = (intervalDays, lastLoginAt) =>
    makeEnv(
      { schedule: { enabled: true, times: '08:00', intervalDays } },
      { state: lastLoginAt ? { lastLoginAt } : {} }
    );

  // ① 每天（默认）：不受「上次认证时间」影响，下一次就是最近一个 08:00
  const a = mk(1, Date.now());
  const na = await a.ctx.scheduleNext();
  results.push({ case: '周期-每天', nextRunAt: new Date(na).toString() });
  check('每天：下一次仍是最近的时间点（08:00）', new Date(na).getHours() === 8);
  check('每天：不会被推到好几天后', dayOffset(na) <= 1);

  // ② 每 3 天 + 今天刚认证过 → 下一次落在第 3 天
  const b = mk(3, Date.now());
  const nb = await b.ctx.scheduleNext();
  results.push({ case: '周期-每3天(今天认证过)', nextRunAt: new Date(nb).toString(), dayOffset: dayOffset(nb) });
  check('每 3 天：跳过中间两天，落在第 3 天', dayOffset(nb) === 3);
  check('每 3 天：仍然用填的那个时间点（08:00）', new Date(nb).getHours() === 8);

  // ③ 每 3 天但上次认证是 5 天前 → 早就到期，立刻安排最近一次
  const c = mk(3, Date.now() - 5 * 86400000);
  const nc = await c.ctx.scheduleNext();
  results.push({ case: '周期-每3天(5天前认证)', nextRunAt: new Date(nc).toString(), dayOffset: dayOffset(nc) });
  check('每 3 天但已过期：立刻安排最近一次', dayOffset(nc) <= 1);

  // ④ 从没认证过（lastLoginAt 为空）→ 不能因为算不出锚点就不排
  const d = mk(3, 0);
  const nd = await d.ctx.scheduleNext();
  results.push({ case: '周期-每3天(从未认证)', nextRunAt: new Date(nd).toString() });
  check('每 3 天但从未认证：照常排最近一次', nd > 0 && dayOffset(nd) <= 1);
}

const out = [
  JSON.stringify(results, null, 2),
  '',
  '== 断言 ==',
  ...checks.map(([name, ok]) => (ok ? 'PASS  ' : 'FAIL  ') + name),
  '',
  '通过 ' + checks.filter((c) => c[1]).length + ' / ' + checks.length
].join('\n');

fs.writeFileSync(path.join(HERE, 'background-result.txt'), out, 'utf8');
process.exit(checks.every((c) => c[1]) ? 0 : 1);
