/* 1.13.0 门禁专项验证
 *
 * 起因（主人实测）：打开教务系统 http://xjwxt.example.edu.cn/login.action 时，
 *   扩展会突然弹一条通知，然后把这个网页自己关掉。
 *
 * 这里的做法很直接：把 content.js 真的塞进 jsdom 里，分别喂给它
 *   ① 教务系统登录页（应该完全不动手）
 *   ② 校园网门户登录页（应该照旧动手）
 * 然后检查它有没有往密码框里写字、有没有给后台发消息。
 *
 * 运行：node test/gate-check.mjs
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const require = createRequire('file:///C:/Users/WQ/.workbuddy/binaries/node/workspace/');
const { JSDOM, VirtualConsole } = require('jsdom');

const HERE = path.dirname(fileURLToPath(import.meta.url));
const CONTENT_JS = fs.readFileSync(
  process.env.CONTENT_JS || path.join(HERE, '..', 'content.js'),
  'utf8'
);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* 教务系统登录页：有账号框、密码框、验证码，文字里全是「教务 / 学籍 / 选课」那一挂，
 * 一个「校园网 / 上网认证 / 运营商」都没有。 */
const JWXT_HTML = `<!doctype html><html><body>
  <div class="login-box">
    <h2>教务管理系统</h2>
    <form id="loginForm" action="/login.action" method="post">
      <input type="text" id="username" name="username" placeholder="请输入账号" />
      <input type="password" id="password" name="password" placeholder="请输入密码" />
      <input type="text" id="captcha" name="captcha" placeholder="验证码" />
      <button type="submit">登录</button>
    </form>
    <div class="foot">忘记密码 · 帮助中心 · 选课须知</div>
  </div>
</body></html>`;

/* 门户登录页（对照）：与门户同源 + 有校园网字样，必须照旧动手。 */
const PORTAL_HTML = `<!doctype html><html><body>
  <div class="portal">
    <h2>校园网上网认证</h2>
    <form>
      <input type="text" id="username" name="username" placeholder="请输入账号" />
      <input type="password" id="password" name="password" placeholder="请输入密码" />
      <button type="submit">立即登录</button>
    </form>
  </div>
</body></html>`;

const CONFIG = {
  enabled: true,
  username: 'gate-test-user',
  password: 'gate-test-pwd',
  operator: '中国电信',
  portalOpenMode: 'gateway',
  portalUrl: 'https://portal.example.edu.cn/portal/portal-main',
  portalFallbackUrl: 'https://portal.example.edu.cn/portal/entry/pc/finish',
  autoLoginOnPortalPage: true,
  reloginWhenOnline: true,
  closeTabOnSuccess: true,
  closeTriggerTabOnSuccess: false,
  notify: true,
  waitAfterSubmitSeconds: 8,
  maxAttempts: 2,
  excludeHosts: [
    'xjwxt.example.edu.cn',
    'jwxt.example.edu.cn',
    'ehall.example.edu.cn',
    'ids.example.edu.cn',
    'cas.example.edu.cn',
    'lib.example.edu.cn',
    'mail.example.edu.cn'
  ].join(',')
};

async function run(name, url, html) {
  const dom = new JSDOM(html, {
    runScripts: 'outside-only',
    url,
    virtualConsole: new VirtualConsole()
  });
  const w = dom.window;
  /* jsdom 不做布局，getBoundingClientRect 全是 0 —— content.js 的 isVisible 会把
   * 所有元素判成不可见（于是谁都不会动手，对照就失去意义）。这里给个「都可见」的桩。 */
  w.Element.prototype.getBoundingClientRect = function () {
    return { width: 200, height: 40, top: 0, left: 0, right: 200, bottom: 40, x: 0, y: 0, toJSON() {} };
  };
  const sent = [];
  w.chrome = {
    runtime: {
      sendMessage: (msg) => {
        sent.push(msg);
      },
      onMessage: { addListener: () => {} },
      lastError: null
    },
    storage: {
      local: {
        get: async () => ({ config: CONFIG, state: {} })
      }
    }
  };
  try {
    w.eval(CONTENT_JS);
  } catch (e) {
    return { name, error: String((e && e.message) || e), sent, filled: false };
  }
  await sleep(1200);
  const pw = w.document.querySelector('input[type=password]');
  const user = w.document.querySelector('input[type=text]');
  return {
    name,
    sent,
    passwordValue: pw ? pw.value : null,
    userValue: user ? user.value : null,
    filled: !!(pw && pw.value)
  };
}

const checks = [];
const check = (name, ok) => checks.push([name, !!ok]);
const results = [];

const jwxt = await run('教务系统页', 'http://xjwxt.example.edu.cn/login.action', JWXT_HTML);
const portal = await run('门户登录页（对照）', 'https://portal.example.edu.cn/portal/entry/pc/finish', PORTAL_HTML);

results.push({ case: '教务系统页', sent: jwxt.sent.map((m) => m && m.type), passwordValue: jwxt.passwordValue, error: jwxt.error });
results.push({ case: '门户页', sent: portal.sent.map((m) => m && m.type), passwordValue: portal.passwordValue, userValue: portal.userValue, error: portal.error });

const jwxtTypes = jwxt.sent.map((m) => m && m.type);
check('教务系统：没有往密码框里写字', !jwxt.filled);
check('教务系统：没有上报「发现认证页」', !jwxtTypes.includes('PORTAL_FORM_DETECTED'));
check('教务系统：没有上报填表结果', !jwxtTypes.includes('FILL_RESULT'));
check('教务系统：脚本没抛异常', !jwxt.error);

const portalTypes = portal.sent.map((m) => m && m.type);
check('门户页（对照）：照旧动手（填了账号密码）', !!portal.filled);
check('门户页（对照）：有流程消息上报', portalTypes.length > 0);

const out = [
  JSON.stringify(results, null, 2),
  '',
  '== 断言 ==',
  ...checks.map(([n, ok]) => (ok ? 'PASS  ' : 'FAIL  ') + n),
  '',
  '通过 ' + checks.filter((c) => c[1]).length + ' / ' + checks.length
].join('\n');

fs.writeFileSync(path.join(HERE, 'gate-check-result.txt'), out, 'utf8');
console.log(out);
process.exit(checks.every((c) => c[1]) ? 0 : 1);
