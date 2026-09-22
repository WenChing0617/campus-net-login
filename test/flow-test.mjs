/* 内容脚本多步流程仿真测试
 *
 * 用 jsdom 复刻示例大学门户的真实结构：
 *   登录页 -> 请选择服务（**radio + label**，未选服务时「确定」是禁用的）-> 确定 -> 可能弹失败提示
 *
 * ⚠ 这里最关键的一点：服务选项用 radio+label 复刻。早期版本只按「文本匹配的 div/span」
 * 去点，radio 不会被真正选中，门户的「确定」就一直是禁用态 —— 表现就是主人看到的
 * 「到选择运营商界面不动了」。radio 结构能把这个回归死死钉住。
 *
 * 真实重试路径：失败提示 -> 点「我知道了」-> 重新选服务 -> 直接再点「确定」
 *              （不点「重新登录」、不重填账号密码）
 *
 * 运行：node test/flow-test.mjs   （输出同时写入 test/result.txt）
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const require = createRequire('file:///C:/Users/WQ/.workbuddy/binaries/node/workspace/');
const { JSDOM, VirtualConsole } = require('jsdom');

const HERE = path.dirname(fileURLToPath(import.meta.url));
// 可用环境变量指向另一份 content.js，便于做「改动前后」对照回归
const CONTENT_JS = fs.readFileSync(process.env.CONTENT_JS || path.join(HERE, '..', 'content.js'), 'utf8');

const PORTAL_URL = 'https://portal.example.edu.cn/portal/entry/pc/finish;flowParams=undefined;from=';
/* 主人给的「服务选择」独立整页地址：点完「立即登录」整页跳到这里，**页面上没有密码框** */
const SERVICE_URL =
  'https://portal.example.edu.cn/portal/entry/pc/serviceSelection;flowParams=undefined;from=authenticate;sid=false';

/* 三种服务选择弹窗：
 *   radio —— radio+label（最常见的后台门户写法）
 *   button —— 老式 button 列表
 *   card —— **卡片式**：radio 和文字全被 opacity:0 藏进卡片里，弹窗上连标题都没有
 *           （用来钉住「只看元素自身可见性 → 判成没有服务弹窗 → 运营商一个都不选」这个回归）
 *   list —— **纯列表**：没有 radio，文字很长（长到不会被当成候选），且只有整行容器本身可点
 *           （用来钉住「点了文本没反应，得逐层往上点容器」这条兜底路径）
 */
function dialogHtml(style) {
  /* ngzorro —— **从门户前端代码里抠出来的真实结构**（v1.9.0 新增）：
   * 示例大学门户是 Angular + ng-zorro SPA，服务选择页的模板长这样：
   *   <div class="node-title">选择服务</div>
   *   <div id="relationInfo">
   *     <div class="service-box" (click)="selectService(c)">
   *       <span class="service">中国电信</span>
   *       <i nz-icon nzType="check-circle" *ngIf="选中"></i>
   *     </div> …
   *   </div>
   *   <div class="footer">
   *     <button class="button-3">重新登录</button>
   *     <button class="button-6" [disabled]="!selectType.value">确定</button>
   *   </div>
   * 要点：**整页没有 radio、没有 label、没有 input**；选中态是给 .service-box 加 `active-bg`；
   * 「确定」没选服务时是 disabled；文案全走 i18n（select.a.service / ok / sign.in.again）。 */
  if (style === 'ngzorro') {
    const box = (op) =>
      '<div class="service-box" data-op="' + op + '"><span class="service">' + op + '</span></div>';
    return `
<div id="serviceDialog" class="center-big" style="display:none">
  <div class="up_distance">
    <div class="bg-center-load noShadow">
      <div class="body">
        <div class="node-title">选择服务</div>
        <div id="relationInfo">${box('中国电信')}${box('中国移动')}${box('中国联通')}</div>
        <div class="footer">
          <button id="reloginBtn" class="button-3 bu-size-small mr-16px">重新登录</button>
          <button id="confirmBtn" class="button-6" disabled>确定</button>
        </div>
      </div>
    </div>
  </div>
</div>`;
  }
  let ops;
  if (style === 'button') {
    ops =
      '<button class="svc" data-op="中国电信">中国电信</button>' +
      '<button class="svc" data-op="中国移动">中国移动</button>' +
      '<button class="svc" data-op="中国联通">中国联通</button>';
  } else if (style === 'card') {
    const card = (op, v) =>
      '<div class="op-card" data-op="' + op + '">' +
      '<input type="radio" name="identity" value="' + v + '" style="opacity:0;width:0;height:0" />' +
      '<i class="op-icon"></i></div>';
    ops = card('中国电信', 'dx') + card('中国移动', 'yd') + card('中国联通', 'lt');
  } else if (style === 'list') {
    // 整行文字刻意写长（超过 40 字）：这样一来「点一下父容器」的顺手捷径也会被排除，
    // 只能靠「逐层往上点祖先容器」这条兜底路径选中 —— 正是这条路径要验证的东西。
    const row = (op) =>
      '<li class="op-row" data-op="' + op + '"><b>' + op + '</b>' +
      '<span>校园宽带高速光纤 100M 独享专线接入服务，支持 IPv6，全程不限速不卡顿</span></li>';
    ops = '<ul id="opList">' + row('中国电信') + row('中国移动') + row('中国联通') + '</ul>';
  } else {
    ops =
      '<div class="op-item"><input type="radio" id="op-dx" name="identity" value="dx" /><label for="op-dx">中国电信</label></div>' +
      '<div class="op-item"><input type="radio" id="op-yd" name="identity" value="yd" /><label for="op-yd">中国移动</label></div>' +
      '<div class="op-item"><input type="radio" id="op-lt" name="identity" value="lt" /><label for="op-lt">中国联通</label></div>';
  }
  // card 风格刻意连「请选择服务」这类标题都不给：没有任何可见文字能提示这是服务选择界面
  const title = style === 'card' ? '' : '<div class="el-dialog__title">请选择服务</div>';
  return `
<div id="serviceDialog" class="el-dialog" style="display:none">
  ${title}
  ${ops}
  <button id="reloginBtn" class="plain">重新登录</button>
  <button id="confirmBtn" class="el-button el-button--primary" disabled>确定</button>
</div>`;
}

/* 门户「已在线」成功页（= 上次认证还没到期时门户给的那一页）。
 * 结构从真实前端代码里还原 —— chunk 3769 的 app-login-success / app-function-links：
 *   #succ-content > #succ-top / #succ-center / #succ-bottom，欢迎语「您已成功连接网络！」
 *   #function-cards 里一排 .function 卡片，每张是 <img> + <span class="fun-name">名字</span>；
 *   入口名字由门户后端配置下发（/sam/api/protected/eportal/querySuccessPageCustomizedPageConfig），
 *   示例大学实测就有「我要下线」（functionType: logOut，英文 Log Out）。
 * 点它 → app-modal 确认框（确定按钮文字 = i18n 'ok'）→ 确定后才真的注销。
 * ⚠ 这一页**没有密码框、没有 radio、地址也不是 serviceSelection** ——
 *   正是「所有启动判据都要求有密码框」的年代里，脚本一声不吭的那一页。 */
function onlineBlock() {
  const card = (name) =>
    '<div class="function"><img src="x.png" /><span class="fun-name">' + name + '</span></div>';
  return `
<div id="onlineView" style="display:block">
  <app-login-success>
    <div id="succ-content">
      <div id="succ-top"><span class="time-words">下午好</span></div>
      <div id="succ-center"><span id="hello">您已成功连接网络！</span></div>
      <div id="succ-bottom">
        <app-function-links>
          <div id="function-cards">
            ${card('本机无感认证')}${card('我要下线')}${card('自助中心')}${card('终端信息')}${card('选择服务')}
          </div>
        </app-function-links>
      </div>
    </div>
  </app-login-success>
</div>
<div id="logoutModal" style="display:none">
  <div class="ant-modal">
    <div class="ant-modal-content">
      <div class="ant-modal-body">确定要下线吗？</div>
      <div class="ant-modal-footer">
        <button id="logoutCancel" class="ant-btn">取消</button>
        <button id="logoutOk" class="ant-btn ant-btn-primary">确定</button>
      </div>
    </div>
  </div>
</div>`;
}

/* 门户「已下线成功页」（注销完的落地页）—— chunk 4457 / 7377 的 app-account-offline-success：
 * 一张图 + 「下线成功！」 + 一个入口。⚠ 入口文字是门户 i18n 的 'Reconnect.network'，
 * 在真实语言包（assets/tmp/i18n/zh-CN.json）里 = **「重新入网」**。
 * v1.11.0 把它意译成「重新连接网络」写进了词表 → 真机上这个按钮一次都没被认出来，
 * 页面就停在「已下线」不动。这里按**真实文案**复刻，把这个回归钉死。
 *
 * 可选开关（都是真机上会遇到的坏情况）：
 *   offlineNoButton   —— 这一页上压根没有「重新入网」入口（门户改版/接口挂了）
 *   offlineDeadButton —— 入口在、点了没反应（注销跳转请求失败）
 * 两种都必须走「直接跳到门户的重新入网地址」兜底，而不是原地不动。 */
function offlineBlock(o) {
  const oo = o || {};
  return `
<div id="offlineView" style="display:${oo.onlinePage ? 'none' : 'block'}">
  <app-account-offline-success>
    <div class="success-off">
      <img src="assets/imgs/pc/scan-success.png" />
      <span class="success-tips">下线成功！</span>
      ${oo.offlineNoButton ? '' : '<a id="reconnectBtn" href="javascript:void(0)">重新入网</a>'}
    </div>
  </app-account-offline-success>
</div>`;
}

/* X3 用：先把「已下线页」的 HTML 放在 <script type="text/template"> 里（**不进 DOM**），
 * 等注销动作完成后才注入 —— 真实门户的 SPA 路由就是这样一页一页换的，
 * 一起渲染两页会让「已下线页」提前出现在 DOM 里，测出来的东西不算数。 */
function offlineTemplate(o) {
  return (
    '<div id="offlineHost" style="display:none"></div>' +
    '<script type="text/template" id="offlineTpl">' +
    offlineBlock(o || {}) +
    '</scr' + 'ipt>'
  );
}

function portalHtml(style, opts) {
  const o = opts || {};
  /* servicePage = 复刻门户把「服务选择」做成独立整页的情况：
   * 没有登录视图、没有密码框，服务选项直接摆在页面上（弹窗从一进页面就是显示的）。
   * onlinePage / offlinePage = 已在线 / 已下线 页：登录视图仍在，但一开始是藏着的
   * （注销后门户会把认证页显示回来，用它来验证「同页切回认证页后脚本能不能接着把认证做完」）。 */
  const hideLogin = o.onlinePage || o.offlinePage;
  const login = o.servicePage
    ? ''
    : `<div id="loginView"${hideLogin ? ' style="display:none"' : ''}>
  <div class="title">示例大学校园网</div>
  <input id="username" type="text" placeholder="请输入账号" />
  <input id="password" type="password" placeholder="请输入密码" />
  <button id="loginBtn" class="el-button el-button--primary" disabled>立即登录</button>
</div>`;
  const dialog = o.servicePage ? dialogHtml(style).replace('style="display:none"', 'style="display:block"') : dialogHtml(style);
  return `<!DOCTYPE html><html><body>
${o.headerLogout ? '<div id="hdr">已连接 校园网 · 注销 / 退出登录</div>' : ''}
${login}
${o.onlinePage ? onlineBlock() : ''}
${o.offlinePage && !o.logoutLandsOffline ? offlineBlock(o) : ''}
${o.offlinePage && o.logoutLandsOffline ? offlineTemplate() : ''}
${dialog}
<div id="failDialog" class="el-dialog" style="display:none">
  <div class="el-dialog__title">提示</div>
  <div class="el-dialog__body">portal认证失败，失败原因：运营商未响应，用户（test-user), 终端IP(10.0.0.123), 终端MAC (aa:bb:cc:dd:ee:ff)</div>
  <button id="ackBtn" class="el-button el-button--primary">我知道了</button>
</div>
<div id="successView" style="display:none">认证成功，已连接校园网</div>
</body></html>`;
}

function isHiddenDeep(w, el) {
  let cur = el;
  while (cur && cur.style) {
    if (cur.style.display === 'none' || cur.style.visibility === 'hidden') return true;
    cur = cur.parentElement;
  }
  return false;
}

async function runScenario(name, opts) {
  const o = opts || {};
  const opStyle = o.opStyle || 'radio';
  /* jsdom 里 localStorage / sessionStorage 需要真实的 origin 才有；
   * virtualConsole 吞掉「location.href = …」产生的 not-implemented 噪音 ——
   * 走「跳转兜底」的场景靠 sessionStorage 里那条记录来断言。 */
  const dom = new JSDOM(portalHtml(opStyle, o), {
    runScripts: 'outside-only',
    url: o.url || PORTAL_URL,
    virtualConsole: new VirtualConsole()
  });
  const w = dom.window;
  const d = w.document;
  /* 门户自己会往 localStorage 写「重新入网该去哪」的地址（samPortalRedirectUrl），
   * 我们的兜底就照抄它。这里预置一份，验证我们用的是门户的地址而不是写死的。 */
  if (o.redirectUrl) {
    try {
      w.localStorage.setItem('samPortalRedirectUrl', o.redirectUrl);
    } catch (e) {
      /* 忽略 */
    }
  }

  // jsdom 没有布局，补上可见性判定所需的最小实现
  w.HTMLElement.prototype.getBoundingClientRect = function () {
    if (isHiddenDeep(w, this)) return { width: 0, height: 0, top: 0, left: 0, right: 0, bottom: 0, x: 0, y: 0 };
    return { width: 120, height: 32, top: 10, left: 10, right: 130, bottom: 42, x: 10, y: 10 };
  };
  Object.defineProperty(w.HTMLElement.prototype, 'innerText', {
    configurable: true,
    get() {
      if (isHiddenDeep(w, this)) return '';
      let out = '';
      for (const n of this.childNodes) {
        if (n.nodeType === 3) out += n.textContent + ' ';
        else if (n.nodeType === 1) out += n.innerText + ' ';
      }
      return out.replace(/\s+/g, ' ').trim();
    }
  });

  // 压缩时间，加快测试（Date.now 仍是真实时间，不会误触超时）
  const realSetTimeout = w.setTimeout.bind(w);
  w.setTimeout = (fn, ms) => realSetTimeout(fn, Math.min(30, Math.round((ms || 0) / 30)));

  const sent = [];
  let handler = null;
  const store = {
    config: Object.assign(
      {
        enabled: true,
        username: 'test-user',
        password: 'demo-pass',
        operator: '中国电信',
        autoLoginOnPortalPage: true,
        portalUrl: 'https://portal.example.edu.cn/portal/portal-main',
        selectors: { username: '', password: '', submit: '' }
      },
      o.config || {}
    ),
    state: Object.assign({}, o.state || {})
  };
  w.chrome = {
    runtime: {
      onMessage: { addListener: (fn) => { handler = fn; } },
      sendMessage: (msg, cb) => { sent.push(msg); if (typeof cb === 'function') cb(); },
      lastError: null
    },
    storage: {
      local: {
        get: async (keys) => {
          const list = typeof keys === 'string' ? [keys] : Array.isArray(keys) ? keys : Object.keys(keys || {});
          const out = {};
          list.forEach((k) => { if (k in store) out[k] = store[k]; });
          return out;
        },
        set: async (obj) => { Object.assign(store, obj); }
      }
    }
  };

  /* ---------- 登录表单（服务选择独立页上没有这一块，要能缺省） ---------- */
  const loginBtn = d.getElementById('loginBtn');
  if (loginBtn) {
    const checkEnable = () => {
      loginBtn.disabled = !(d.getElementById('username').value && d.getElementById('password').value);
    };
    d.getElementById('username').addEventListener('input', checkEnable);
    d.getElementById('password').addEventListener('input', checkEnable);
  }

  let fillAt = 0;
  const t0 = Date.now();
  if (d.getElementById('password')) {
    d.getElementById('password').addEventListener('input', () => {
      if (!fillAt) fillAt = Date.now() - t0;
    });
  }

  const show = (id, on) => {
    const el = d.getElementById(id);
    if (el) el.style.display = on ? 'block' : 'none';
  };

  let confirmCount = 0;
  let reloginCount = 0;
  let confirmAt = 0;
  let pickedAtConfirm = ''; // 点「确定」那一刻的选中项（跳转后页面会被整块换掉，事后取不到）
  let buttonOp = '';
  let boxOp = '';
  const confirmBtn = d.getElementById('confirmBtn');

  /* 真实门户行为：没选服务时，「确定」是禁用的 */
  const syncConfirm = () => {
    const picked =
      opStyle === 'ngzorro'
        ? !!d.querySelector('.service-box.active-bg')
        : opStyle === 'button' || opStyle === 'list'
          ? opStyle === 'button'
            ? !!buttonOp
            : !!d.querySelector('.op-row.selected')
          : !!d.querySelector('input[name=identity]:checked');
    confirmBtn.disabled = o.confirmAlwaysDisabled ? true : !picked;
  };
  const checkedOperator = () => {
    if (opStyle === 'ngzorro') {
      const b = d.querySelector('.service-box.active-bg');
      return b ? b.getAttribute('data-op') : '';
    }
    if (opStyle === 'button') return buttonOp;
    if (opStyle === 'list') {
      const row = d.querySelector('.op-row.selected');
      return row ? row.getAttribute('data-op') : '';
    }
    const r = d.querySelector('input[name=identity]:checked');
    return r ? r.value : '';
  };

  if (opStyle === 'ngzorro') {
    /* 真实行为：点 .service-box（Angular 的 (click) 挂在 box 上，点在里面的 span 上会冒泡上来）
     * → 清掉别的选中态 → 给自己加 active-bg → 「确定」从禁用变为可点。 */
    d.querySelectorAll('.service-box').forEach((b) => {
      b.addEventListener('click', () => {
        d.querySelectorAll('.service-box').forEach((x) => x.classList.remove('active-bg'));
        b.classList.add('active-bg');
        boxOp = b.getAttribute('data-op');
        syncConfirm();
      });
    });
  } else if (opStyle === 'button') {
    d.querySelectorAll('.svc').forEach((el) => {
      el.addEventListener('click', () => { buttonOp = el.getAttribute('data-op'); syncConfirm(); });
    });
  } else if (opStyle === 'card') {
    // 卡片式：点卡片选中里面的 radio（radio 自己被 opacity:0 藏着，不给 label）
    d.querySelectorAll('input[name=identity]').forEach((r) => r.addEventListener('change', syncConfirm));
    d.querySelectorAll('.op-card').forEach((c) => {
      c.addEventListener('click', () => {
        const r = c.querySelector('input[type=radio]');
        if (r && !r.checked) {
          r.checked = true;
          r.dispatchEvent(new w.Event('change', { bubbles: true }));
        }
      });
    });
  } else if (opStyle === 'list') {
    // 纯列表：只有**整行容器自己**被点中才算选中（点在里面的文字上不生效）
    d.querySelectorAll('.op-row').forEach((li) => {
      li.addEventListener('click', (ev) => {
        if (ev.target !== li) return;
        d.querySelectorAll('.op-row').forEach((x) => x.classList.remove('selected'));
        li.classList.add('selected');
        syncConfirm();
      });
    });
  } else {
    d.querySelectorAll('input[name=identity]').forEach((r) => r.addEventListener('change', syncConfirm));
    // 浏览器/框架行为：点 label 会转发到关联的 radio
    d.querySelectorAll('label[for]').forEach((l) => {
      l.addEventListener('click', () => {
        const r = d.getElementById(l.getAttribute('for'));
        if (r && !r.checked) {
          r.checked = true;
          r.dispatchEvent(new w.Event('change', { bubbles: true }));
        }
      });
    });
  }

  // 可选：模拟 SPA 晚渲染 —— 登录表单过一会儿才出现
  if (o.showLoginAfterMs > 0) {
    show('loginView', false);
    w.setTimeout(() => show('loginView', true), o.showLoginAfterMs);
  }

  loginBtn?.addEventListener('click', () => {
    if (loginBtn.disabled) return;
    show('loginView', false);
    show('serviceDialog', true);
    syncConfirm();
  });

  // 「确定」：前 confirmNoopTimes 次点了完全没反应（模拟服务没真正选中）；
  // 之后 failTimes 次弹失败提示；再之后成功
  confirmBtn.addEventListener('click', () => {
    if (confirmBtn.disabled) return; // 没选服务点不动，和真实门户一致
    confirmCount += 1;
    if (!confirmAt) confirmAt = Date.now();
    if (!pickedAtConfirm) pickedAtConfirm = checkedOperator();
    const noop = o.confirmNoopTimes || 0;
    if (confirmCount <= noop) return;
    if (confirmCount - noop <= (o.failTimes || 0)) {
      show('failDialog', true);
      return;
    }
    show('serviceDialog', false);
    show('failDialog', false);

    /* 复刻门户「认证成功后整页跳到工作流的下一节点」：
     * 服务界面整块被换掉、地址也变了 —— 真实门户的 submitForm() 只在
     * serviceLogin 返回 authResult==='success' 时才 nextPath() 跳走；失败只弹提示、地址不动。
     * 落地页文案**刻意不含任何「成功」字样**（T），用来验证「跳转本身」就是完成信号。 */
    if (o.redirectAfterConfirm) {
      const r = o.redirectAfterConfirm;
      const go = () => {
        d.body.innerHTML =
          r.body ||
          '<div id="landing">示例大学 校园网门户 —— 欢迎回来，账号 test-user，本月已用 1.2G</div>';
        try {
          w.history.replaceState({}, '', r.url);
        } catch (e) {
          /* 跨域地址在 jsdom 里换不了，跳过地址变化 */
        }
      };
      if (r.delayMs) w.setTimeout(go, r.delayMs);
      else go();
      return;
    }

    /* 「服务弹窗只是被重渲染抹掉」：既没有成功字样，地址也没变 ——
     * 正是旧版误报成功、提前关页的现场。必须仍然只算「待确认」。 */
    if (o.vanishAfterConfirm) return;

    show('successView', true);
  });

  // 「我知道了」：关掉提示；可选模拟门户重渲染（服务弹窗短暂消失再回来）
  d.getElementById('ackBtn').addEventListener('click', () => {
    show('failDialog', false);
    if (o.hiddenAfterAckMs > 0) {
      show('serviceDialog', false);
      w.setTimeout(() => show('serviceDialog', true), o.hiddenAfterAckMs);
    }
  });
  d.getElementById('reloginBtn').addEventListener('click', () => {
    reloginCount += 1;
    show('serviceDialog', false);
    show('loginView', true);
  });

  /* ---------- 「已在线 / 已下线」页的真实交互（X / Y / Z 场景） ---------- */
  let logoutClicked = 0;
  let logoutConfirmed = 0;
  let logoutCancelClicked = 0;
  let offlineReconnectClicked = 0;
  /* 「重新入网」入口的接线（门户真实行为：window.location.href = localStorage.samPortalRedirectUrl || 协议//2.2.2.2，
   * 见 chunk 7243 / 9903 / 4457）。测试里不真跳，改成把认证视图切回来。
   * offlineDeadButton = 这个跳转请求失败、页面纹丝不动。 */
  const wireOffline = () => {
    const rb = d.getElementById('reconnectBtn');
    if (!rb || rb.dataset.wired) return;
    rb.dataset.wired = '1';
    rb.addEventListener('click', () => {
      offlineReconnectClicked += 1;
      if (o.offlineDeadButton) return;
      show('offlineView', false);
      show('loginView', true);
    });
  };
  if (d.getElementById('onlineView')) {
    d.querySelectorAll('#function-cards .function').forEach((fn) => {
      fn.addEventListener('click', () => {
        const name = String((fn.querySelector('.fun-name') || fn).textContent || '').trim();
        if (name !== '我要下线') return; // 只有「我要下线」这张卡片有反应
        logoutClicked += 1;
        show('logoutModal', true);
      });
    });
    d.getElementById('logoutCancel').addEventListener('click', () => {
      logoutCancelClicked += 1;
      show('logoutModal', false);
    });
    d.getElementById('logoutOk').addEventListener('click', () => {
      logoutConfirmed += 1;
      show('logoutModal', false);
      /* 复刻门户真实节奏：POST /eportal/network/newLogout 成功后**再等 2 秒**才跳
       * （logOutTopage 里的 setTimeout(..., 2000)）。
       * 跳完落到哪一页？真机上两种都会出现：
       *   · 回认证页（门户把认证视图切回来）          —— 默认
       *   · 落到「已下线成功页」（app-account-offline-success）—— o.logoutLandsOffline */
      w.setTimeout(
        () => {
          show('onlineView', false);
          const tpl = d.getElementById('offlineTpl');
          const host = d.getElementById('offlineHost');
          if (o.logoutLandsOffline && tpl && host) {
            /* 门户把落地视图换成「已下线」页（SPA 换视图，脚本不会重新注入） */
            host.innerHTML = tpl.textContent;
            host.style.display = 'block';
            wireOffline();
          } else {
            show('loginView', true);
          }
        },
        o.logoutJumpMs === undefined ? 2000 : o.logoutJumpMs
      );
    });
  }
  wireOffline();

  // 可选：把登录表单整个拿掉，模拟「这个框架里根本没有登录表单」
  // （后台的指令是往整个标签页广播的，空白子框架也会收到一份）
  if (o.noForm) {
    const lv = d.getElementById('loginView');
    if (lv) lv.remove();
  }

  w.eval(CONTENT_JS);

  let started = null;
  if (o.push !== false) {
    started = await new Promise((res) => {
      handler(
        { type: 'FILL_AND_SUBMIT', payload: { username: 'test-user', password: 'demo-pass', operator: '中国电信' } },
        {},
        res
      );
    });
  }

  let final = null;
  /* 「跳转兜底」的观测点：内容脚本会往 sessionStorage 里记一笔 {at,url,reason} */
  const jumpRecord = () => {
    try {
      const raw = w.sessionStorage.getItem('cnlReloginJump');
      return raw ? JSON.parse(raw) : null;
    } catch (e) {
      return null;
    }
  };
  let jumpedTo = null;
  const waitT0 = Date.now();
  const waitBudget = o.waitFinalMs || 30000;
  while (Date.now() - waitT0 < waitBudget) {
    const f = sent.find((m) => m.type === 'FILL_RESULT' && m.result && m.result.final);
    if (f) {
      final = f.result;
      break;
    }
    jumpedTo = jumpRecord();
    /* 走兜底跳转的场景：跳转之后不会再有「结论」（新页面才接手），别干等到超时 */
    if (o.waitJump && jumpedTo) break;
    await new Promise((r) => setTimeout(r, 40));
  }
  if (!jumpedTo) jumpedTo = jumpRecord();

  const flowLog = sent.filter((m) => m.type === 'FILL_RESULT' && m.result).map((m) => m.result.note);
  const sv = d.getElementById('successView');
  const result = {
    scenario: name,
    opStyle,
    pushed: o.push !== false,
    started,
    fillDelayMs: fillAt || null,
    confirmCount,
    reloginCount,
    finalAfterConfirmMs: final && confirmAt ? Date.now() - confirmAt : null,
    checkedOperator: checkedOperator() || pickedAtConfirm,
    successViewShown: !!(sv && sv.style.display === 'block'),
    finalStatus: final ? final.status : '(无结论)',
    submitted: final ? final.submitted : null,
    failures: final ? final.failures : null,
    finalNote: final ? final.note : '',
    diag: final ? final.diag || '' : '',
    diagHtml: final ? final.diagHtml || '' : '',
    resultCount: sent.filter((m) => m.type === 'FILL_RESULT').length,
    log: final ? final.log : [],
    notes: [...new Set(flowLog)].slice(0, 8),
    /* 「已在线 → 先下线再认证」这条支路的观测点 */
    logoutClicked,
    logoutConfirmed,
    logoutCancelClicked,
    offlineReconnectClicked,
    reloginFlagSeen: sent.some((m) => m.type === 'FILL_RESULT' && m.result && m.result.relogin),
    /* 「点不到『重新入网』就自己跳到门户的重新入网地址」这条兜底的观测点 */
    jumpedTo: jumpedTo || null
  };
  w.close();
  return result;
}

const results = [];
results.push(await runScenario('A 一次成功（radio 结构，考验是否真的选中服务）', { failTimes: 0 }));
results.push(await runScenario('B 失败两次后成功（我知道了 -> 重新选服务 -> 确定）', { failTimes: 2 }));
results.push(await runScenario('C 一直失败（应停止并报 failed，且不重填账号密码）', { failTimes: 99 }));
results.push(await runScenario('D 失败后服务弹窗短暂消失再恢复（等待按钮，而不是乱点）', { failTimes: 1, hiddenAfterAckMs: 600 }));
results.push(await runScenario('E 页面自己动手：不经后台下发指令也能填表认证', { push: false }));
results.push(await runScenario('F 晚渲染：密码框延迟出现，仍要立刻抓到并填写', { push: false, showLoginAfterMs: 150 }));
results.push(await runScenario('G 老式 button 结构的门户也要能选', { opStyle: 'button', failTimes: 0 }));
results.push(await runScenario('H 确定按钮一直禁用（卡住时必须给诊断、不空转、不误报）', { confirmAlwaysDisabled: true }));
results.push(await runScenario('I 点了确定毫无反应（应重新选服务后自愈）', { confirmNoopTimes: 1 }));
results.push(
  await runScenario('J 页头挂着「已连接 · 注销」的干扰文案（不许因此误判成功）', {
    failTimes: 0,
    headerLogout: true
  })
);
/* K/L/N 对应主人这轮反馈的两个毛病 + 一个连带的假失败：
 *   「跳转太慢、没有选择运营商，最初的几版还是可以自动选择运营商并确定的」 */
results.push(
  await runScenario('K 卡片式服务选择：radio 与文字都被藏进卡片、弹窗连标题都没有', {
    opStyle: 'card',
    failTimes: 0
  })
);
results.push(
  await runScenario('L 纯列表式服务选择：点文字没反应，只有整行容器本身能被点中', {
    opStyle: 'list',
    failTimes: 0
  })
);
results.push(
  await runScenario('N 这个框架里没有登录表单（不许回报任何失败结论）', {
    noForm: true,
    waitFinalMs: 1500
  })
);
/* P/Q 对应主人这轮反馈：「服务选择页还是没有自动选择」。
 * 门户把服务选择做成了**独立整页**：
 *   /portal/entry/pc/serviceSelection;flowParams=undefined;from=authenticate;sid=false
 * 这一页里**没有密码框**，而旧版所有启动入口（自启动 / PING / FILL_AND_SUBMIT）
 * 都拿「有密码框」当前提 —— 于是到了这一页脚本什么都不做，运营商一个都不选。 */
results.push(
  await runScenario('P 服务选择独立页（无密码框）：后台下发指令也要能选中并确定', {
    servicePage: true,
    url: SERVICE_URL,
    failTimes: 0
  })
);
results.push(
  await runScenario('Q 服务选择独立页 + 卡片式：页面自己动手也要能选中并确定', {
    servicePage: true,
    url: SERVICE_URL,
    opStyle: 'card',
    push: false,
    failTimes: 0
  })
);

/* R/S 对应主人这轮反馈：「依旧选择服务界面不动」。
 * 前面 P/Q 用的还是「自己编的」结构，这一组直接用**从门户前端代码（ServiceSelectionModule）
 * 里抠出来的真实结构**：Angular + ng-zorro，选项是 div.service-box > span.service，
 * 整页没有 radio / label / input，选中态是 box 上的 active-bg，「确定」是 button-6 且未选中时 disabled。
 * 另外 S1/S2 顺手钉住两道「门禁」：设置里没填认证页地址、设置里运营商为空 ——
 * 这两条一旦把页面挡在外面，表现就是脚本**一声不吭地什么都不做**，正是主人看到的现象。 */
results.push(
  await runScenario('R 真实门户结构（ng-zorro，整页无 radio）：页面自己动手也要选中并确定', {
    servicePage: true,
    url: SERVICE_URL,
    opStyle: 'ngzorro',
    push: false,
    failTimes: 0
  })
);
results.push(
  await runScenario('R2 真实门户结构 + 后台下发指令', {
    servicePage: true,
    url: SERVICE_URL,
    opStyle: 'ngzorro',
    failTimes: 0
  })
);
results.push(
  await runScenario('S1 真实结构 · 设置里没填认证页地址（只能靠页面特征认门户）', {
    servicePage: true,
    url: SERVICE_URL,
    opStyle: 'ngzorro',
    push: false,
    failTimes: 0,
    config: { portalUrl: '' }
  })
);
results.push(
  await runScenario('S2 真实结构 · 设置里运营商是空的（不许因此原地不动）', {
    servicePage: true,
    url: SERVICE_URL,
    opStyle: 'ngzorro',
    push: false,
    failTimes: 0,
    config: { operator: '' }
  })
);
results.push(
  await runScenario('S3 真实结构 · 扩展被关掉（不许静默不动，必须说明原因）', {
    servicePage: true,
    url: SERVICE_URL,
    opStyle: 'ngzorro',
    push: false,
    failTimes: 0,
    waitFinalMs: 4000,
    config: { enabled: false }
  })
);

/* ---------- 主人这轮的要求：「认证时，只要跳转到最终界面都算完成，节省时间，
 *            避免关闭认证页和通知延迟」 ----------
 * 原型来自门户前端代码（ServiceSelectionModule.submitForm）：
 *   serviceLogin 成功 → nextPath() **整页跳走**；失败 → 只弹 warning，**地址不动**。
 * 所以「点过确定 + 地址真的变了 + 页面上没有流程 UI」＝ 完成，不必再等成功字样/网络探测。
 * 以前这一跳要么等成功字样（门户不一定写）、要么交给后台探一次网络（多几百毫秒到几秒），
 * 主人看到的就是「页面早就好了，通知和关页面却慢半拍」。 */

/* T. 落地页**一个「成功」字样都没有**（只是普通的门户首页），也要立刻算完成 */
results.push(
  await runScenario('T 点确定后跳到最终界面（没有成功字样也要算完成）', {
    servicePage: true,
    url: SERVICE_URL,
    opStyle: 'ngzorro',
    push: false,
    failTimes: 0,
    redirectAfterConfirm: { url: 'https://portal.example.edu.cn/portal/portal-main?sessionId=abc' }
  })
);

/* U. 落地页文案里带「已选择服务：中国电信」——用文字判定会以为「还停在选服务页」，
 *    这里必须只认硬信号（地址 / 密码框 / 可见的确定按钮 + 服务选项） */
results.push(
  await runScenario('U 落地页文案带「已选择服务 中国电信」也要算完成', {
    servicePage: true,
    url: SERVICE_URL,
    opStyle: 'ngzorro',
    push: false,
    failTimes: 0,
    redirectAfterConfirm: {
      url: 'https://portal.example.edu.cn/portal/portal-main?sessionId=abc',
      body: '<div id="landing">已选择服务：中国电信 · 本次上网流程已走完，欢迎使用校园网</div>'
    }
  })
);

/* V. 只是「服务弹窗被重渲染抹掉」：没有成功字样、地址也没变 —— 这正是旧版误报成功的现场，
 *    必须仍然只算「待确认」，绝不许算完成 */
results.push(
  await runScenario('V 弹窗被抹掉但地址没变（不许误判成完成）', {
    servicePage: true,
    url: SERVICE_URL,
    opStyle: 'ngzorro',
    push: false,
    failTimes: 0,
    vanishAfterConfirm: true
  })
);

/* W. 提交后又被送回登录页（有密码框）：地址变了，但那不是「最终界面」 */
results.push(
  await runScenario('W 提交后被送回登录页（有密码框，不许算完成）', {
    servicePage: true,
    url: SERVICE_URL,
    opStyle: 'ngzorro',
    push: false,
    failTimes: 0,
    redirectAfterConfirm: {
      url: 'https://portal.example.edu.cn/portal/portal-main?sessionId=abc',
      body:
        '<div id="loginView"><div class="title">示例大学校园网</div>' +
        '<input id="username" type="text" placeholder="请输入账号" />' +
        '<input id="password" type="password" placeholder="请输入密码" />' +
        '<button id="loginBtn">立即登录</button></div>'
    }
  })
);

/* X/Y/Y2/Y3/Z 对应主人两轮反馈：
 *   第一轮：「有时到认证时间可是认证还没到期，则是直接进入 finish 页进行下线，然后认证」
 *           → 门户在「上次认证还没到期」时**不给登录表单**，而是直接渲染「已在线」成功页
 *             （app-login-success + #function-cards），上面有一张「我要下线」卡片。
 *   第二轮：「未点击重新入网，保存设置认证也要进入网页」
 *           → 真机上注销完落到「已下线」页，那页的入口 i18n 是 Reconnect.network，
 *             语言包里的真实中文是**「重新入网」**（v1.11.0 误写成了「重新连接网络」，
 *             于是这个入口一次都没被点到、认证根本没进到网页里）。
 *             现在：认「重新入网」并把认证做完；**认不出/点不动也要按门户自己的做法
 *             跳到它的重新入网地址**（samPortalRedirectUrl，兜底 protocol//2.2.2.2），
 *             绝不原地不动。 */
results.push(
  await runScenario('X 已在线成功页（认证未到期）：先点「我要下线」，确认后回认证页把认证做完', {
    onlinePage: true,
    push: false,
    failTimes: 0,
    waitFinalMs: 40000
  })
);
results.push(
  await runScenario('X2 已在线成功页 + 后台下发指令', {
    onlinePage: true,
    failTimes: 0,
    waitFinalMs: 40000
  })
);
/* X3 = 真机的完整链路：已在线 → 下线 → **落到「已下线」页**（不是回认证页）
 *      → 点「重新入网」→ 回认证页 → 认证做完。 */
results.push(
  await runScenario('X3 已在线 → 下线后落到「已下线」页 → 点「重新入网」→ 认证做完', {
    onlinePage: true,
    offlinePage: true,
    logoutLandsOffline: true,
    push: false,
    failTimes: 0,
    waitFinalMs: 45000
  })
);
results.push(
  await runScenario('Y 已下线成功页：点「重新入网」回认证页并完成认证（门户真实文案）', {
    offlinePage: true,
    push: false,
    failTimes: 0,
    waitFinalMs: 40000
  })
);
/* Y2 = 已下线页上**压根没有**「重新入网」入口（门户改版/接口挂了）：
 *      必须自己跳到门户的重新入网地址，而不是原地死等或报失败。 */
results.push(
  await runScenario('Y2 已下线页没有「重新入网」入口 → 直接跳到门户的重新入网地址', {
    offlinePage: true,
    offlineNoButton: true,
    push: false,
    redirectUrl: 'http://2.2.2.2/',
    waitJump: true,
    waitFinalMs: 20000
  })
);
/* Y3 = 入口在、点了没反应（注销跳转请求失败）：同样要有跳转兜底 */
results.push(
  await runScenario('Y3 点了「重新入网」但页面没动 → 仍然跳到重新入网地址', {
    offlinePage: true,
    offlineDeadButton: true,
    push: false,
    waitJump: true,
    waitFinalMs: 25000
  })
);
results.push(
  await runScenario('Z 设置里关掉「已在线时先下线再认证」：不许碰「我要下线」', {
    onlinePage: true,
    push: false,
    config: { reloginWhenOnline: false },
    waitFinalMs: 8000
  })
);

const checks = [];
for (const r of results) {
  const tag = r.scenario[0];
  if (tag === 'X') {
    /* 已在线成功页：必须「点了下线 → 确认 → 回认证页 → 把认证做完」。
     * 关键是不能点「取消」，也不能点了下线就完事（那样认证时长并没续上）。
     * X3 还要多一步：门户把落地页换成「已下线」页时，得点它的「重新入网」才回得来。 */
    const label = r.scenario.slice(0, 2).trim();
    checks.push([label + ' 最终认证成功（下线后又把认证做完了）', r.finalStatus === 'success']);
    checks.push([label + ' 真的点了「我要下线」', r.logoutClicked === 1]);
    checks.push([label + ' 真的确认了下线（弹窗的「确定」）', r.logoutConfirmed === 1]);
    checks.push([label + ' 没点「取消」', r.logoutCancelClicked === 0]);
    checks.push([label + ' 下线后接着完成了认证（选服务 + 确定）', r.confirmCount >= 1]);
    checks.push([label + ' 上报了 relogin 标记（免得后台拿 204 半路收尾）', r.reloginFlagSeen === true]);
    if (label === 'X3') {
      checks.push(['X3 落到已下线页后点了「重新入网」', r.offlineReconnectClicked === 1]);
      checks.push(['X3 没有走跳转兜底（入口点得到就用入口）', r.jumpedTo === null]);
    }
  }
  if (tag === 'Y') {
    const label = r.scenario.slice(0, 2).trim();
    if (label === 'Y') {
      /* 已下线成功页：门户自己已经下线了，只剩下「重新入网」这一步 */
      checks.push(['Y 最终认证成功', r.finalStatus === 'success']);
      checks.push(['Y 认出了真机上的「重新入网」（Reconnect.network）', r.offlineReconnectClicked === 1]);
      checks.push(['Y 认出了已下线页（没把它当成已在线去点「我要下线」）', r.logoutClicked === 0]);
      checks.push(['Y 回认证页后完成了认证', r.confirmCount >= 1]);
      checks.push(['Y 入口点得到时不乱跳（没用跳转兜底）', r.jumpedTo === null]);
    } else {
      /* Y2 / Y3：入口缺失或点了不动 —— 认不出也要「进入网页」 */
      checks.push([label + ' 认不出/点不动入口时，自己跳到了门户的重新入网地址', !!r.jumpedTo && !!r.jumpedTo.url]);
      checks.push([label + ' 跳的是门户给的地址（samPortalRedirectUrl 优先）', !!r.jumpedTo && /^(http:\/\/2\.2\.2\.2|https?:\/\/[^/]*2\.2\.2\.2)/.test(r.jumpedTo.url)]);
      checks.push([label + ' 没有死等出「失败」结论（认证仍在继续）', r.finalStatus !== 'failed']);
      checks.push([label + ' 一次都没点「我要下线」', r.logoutClicked === 0]);
    }
  }
  if (tag === 'Z') {
    /* 开关关掉时回到旧行为：当作「本来就在线」，一个按钮都不许碰 */
    checks.push(['Z 结果是 skipped（本来就在线）', r.finalStatus === 'skipped']);
    checks.push(['Z 一次都没点「我要下线」', r.logoutClicked === 0]);
    checks.push(['Z 没点过任何确认弹窗', r.logoutConfirmed === 0]);
  }
  if (tag === 'A') {
    checks.push(['A 结果成功', r.finalStatus === 'success']);
    checks.push(['A radio 真的被选中为 dx（中国电信）', r.checkedOperator === 'dx']);
    checks.push(['A 成功页出现', r.successViewShown === true]);
    checks.push(['A 账号密码只提交 1 次', r.submitted === 1]);
  }
  if (tag === 'B') {
    checks.push(['B 结果成功', r.finalStatus === 'success']);
    checks.push(['B 处理了 2 次失败提示', r.failures === 2]);
    checks.push(['B 失败后确实重新走了「选服务」', r.log.some((x) => x.indexOf('重新选择服务') === 0)]);
    checks.push(['B 走「我知道了 -> 确定」重试', r.log.includes('点击确定重试')]);
    checks.push(['B 从未点「重新登录」', r.reloginCount === 0]);
    checks.push(['B 账号密码只提交 1 次（失败不重填）', r.submitted === 1]);
    checks.push(['B 成功页出现', r.successViewShown === true]);
  }
  if (tag === 'C') {
    checks.push(['C 结果为 failed', r.finalStatus === 'failed']);
    checks.push(['C 账号密码只提交 1 次', r.submitted === 1]);
    checks.push(['C 「确定」不超过 6 次', r.confirmCount <= 6]);
    checks.push(['C 未点「重新登录」', r.reloginCount === 0]);
    checks.push(['C 未误报成功', r.successViewShown === false]);
  }
  if (tag === 'D') {
    checks.push(['D 结果成功', r.finalStatus === 'success']);
    checks.push(['D 弹窗恢复后仍能点确定', r.log.includes('点击确定重试')]);
    checks.push(['D 未点「重新登录」', r.reloginCount === 0]);
    checks.push(['D 未重复提交账号密码', r.submitted === 1]);
  }
  if (tag === 'E') {
    checks.push(['E 结果成功', r.finalStatus === 'success']);
    checks.push(['E 全程没等后台下发指令（页面自己动手）', r.pushed === false && r.started === null]);
    checks.push(['E 账号密码只提交 1 次', r.submitted === 1]);
    checks.push(['E 成功页出现', r.successViewShown === true]);
  }
  if (tag === 'F') {
    checks.push(['F 结果成功', r.finalStatus === 'success']);
    checks.push(['F 晚出现的密码框也被填上', r.fillDelayMs !== null]);
    checks.push(['F 全程没等后台下发指令', r.pushed === false && r.started === null]);
    checks.push(['F 成功页出现', r.successViewShown === true]);
  }
  if (tag === 'G') {
    checks.push(['G 老式结构结果成功', r.finalStatus === 'success']);
    checks.push(['G 选中了中国电信', r.checkedOperator === '中国电信']);
    checks.push(['G 未点「重新登录」', r.reloginCount === 0]);
  }
  if (tag === 'H') {
    checks.push(['H 结果为 failed（不空转、不误报成功）', r.finalStatus === 'failed' && r.successViewShown === false]);
    checks.push(['H 失败结论里带页面诊断信息', !!r.diag]);
    checks.push(['H 一次都没能点下「确定」', r.confirmCount === 0]);
    checks.push(['H 未点「重新登录」', r.reloginCount === 0]);
  }
  if (tag === 'I') {
    checks.push(['I 最终认证成功（没被卡死）', r.finalStatus === 'success']);
    checks.push(['I 确实点了两次「确定」', r.confirmCount === 2]);
    checks.push(['I 走了「确定未生效 -> 重新选服务」自愈路径', r.log.includes('确定未生效，重新选择运营商后重试')]);
    checks.push(['I 未点「重新登录」', r.reloginCount === 0]);
    checks.push(['I 账号密码只提交 1 次', r.submitted === 1]);
  }
  if (tag === 'J') {
    /* 主人报的「服务依旧没有选就关闭了」在页面侧的原型：
     * 门户页头常挂着「已连接」「注销 / 退出登录」，而点完「立即登录」密码框会被服务弹窗顶掉。
     * 旧版判定是「没有密码框 + 页面上出现已连接/注销」→ 直接报成功并关页面，
     * 于是运营商标记没选、确定没点，主人看到的却是「服务还没选就关了」。
     * 现在必须真的选中运营商、真的点下确定、真的出现成功字样才算成功。 */
    checks.push(['J 结果成功', r.finalStatus === 'success']);
    checks.push(['J 没有因为页头「已连接/注销」而提前收尾（确实选了运营商）', r.checkedOperator === 'dx']);
    checks.push(['J 确实点过「确定」', r.confirmCount === 1]);
    checks.push(['J 等到真正的成功页出现', r.successViewShown === true]);
  }
  if (tag === 'K') {
    /* 主人报的「没有选择运营商」在页面侧的原型：
     * 门户把单选框和文字全都藏进卡片（opacity:0），弹窗上连「请选择服务」这类标题都没有。
     * 上一版只按「元素自身可见」判断弹窗在不在 → 判定成「没有服务选择界面」→
     * 运营商一个都没选就收工，主人看到的正是「到选择运营商界面不动了」。
     * 现在会顺带看祖先容器（卡片可见 = 弹窗还在），并真的把卡片点下去。 */
    checks.push(['K 结果成功', r.finalStatus === 'success']);
    checks.push(['K 真的选中了中国电信', r.checkedOperator === 'dx']);
    checks.push(['K 确实点过「确定」', r.confirmCount >= 1]);
    checks.push(['K 成功页出现', r.successViewShown === true]);
  }
  if (tag === 'L') {
    /* 「点文字没反应、只有整行容器能被点中」的门户：
     * 必须靠「逐层往上点祖先容器」这条兜底路径把服务选中。 */
    checks.push(['L 结果成功', r.finalStatus === 'success']);
    checks.push(['L 选中了中国电信', r.checkedOperator === '中国电信']);
    checks.push(['L 走的是「点祖先容器」兜底路径', r.log.join(' ').indexOf('ancestor') >= 0]);
    checks.push(['L 未点「重新登录」', r.reloginCount === 0]);
  }
  if (tag === 'N') {
    /* 后台的指令是往整个标签页广播的：没有登录表单的框架（空白子框架、跳转中转页）
     * 以前会「抢过」这条指令空跑一遍，然后回报一句「页面没有密码输入框」，
     * 变成一条假的「认证失败」，把真正那个框架的流程盖掉。 */
    checks.push(['N 没有登录表单：直接让开（started=false）', r.started && r.started.started === false]);
    checks.push(['N 没有登录表单：一条结论都不回报', r.resultCount === 0]);
    checks.push(['N 不会凭空给出一条「失败」', r.finalStatus === '(无结论)']);
  }
  if (tag === 'P') {
    /* serviceSelection 是独立整页、没有密码框：必须支持「从选服务这一步直接进场」。
     * 旧版在这一页上：自启动要 hasPasswordField()、PING 报 hasPassword:false、
     * FILL_AND_SUBMIT 被判定「该框架没有登录表单」让开 —— 三条路全堵死，什么都不做。 */
    checks.push(['P 结果成功', r.finalStatus === 'success']);
    checks.push(['P 真的选中了中国电信', r.checkedOperator === 'dx']);
    checks.push(['P 确实点过「确定」', r.confirmCount === 1]);
    checks.push(['P 成功页出现', r.successViewShown === true]);
    checks.push(['P 没有密码框也绝不误填/误交账号密码', !r.submitted]);
  }
  if (tag === 'Q') {
    checks.push(['Q 结果成功', r.finalStatus === 'success']);
    checks.push(['Q 页面自己动手（全程没等后台下发指令）', r.pushed === false && r.started === null]);
    checks.push(['Q 卡片式选项也被真的选中', r.checkedOperator === 'dx']);
    checks.push(['Q 确实点过「确定」', r.confirmCount === 1]);
    checks.push(['Q 未点「重新登录」', r.reloginCount === 0]);
  }
  if (tag === 'R') {
    /* 真实结构：没有 radio、没有 label、没有 input。
     * 旧版靠「radio / for= 的 label」这两条主路径认选项，一旦门户改成卡片式 div，
     * 候选就只剩「短文本元素」这一条路 —— 必须真的把 .service-box 点下去（选中态 active-bg）。 */
    const label = r.scenario.slice(0, 2).trim();
    checks.push([label + ' 结果成功', r.finalStatus === 'success']);
    checks.push([label + ' 真的选中了中国电信（active-bg 生效）', r.checkedOperator === '中国电信']);
    checks.push([label + ' 确实点过「确定」', r.confirmCount === 1]);
    checks.push([label + ' 未点「重新登录」', r.reloginCount === 0]);
    checks.push([label + ' 没误填账号密码（这一页根本没有密码框）', !r.submitted]);
    if (!r.pushed) checks.push([label + ' 页面自己动手，不等后台指令', r.started === null]);
  }
  if (tag === 'S') {
    /* 两道门禁：设置里认证页地址为空、运营商为空。
     * 只要其中一条把服务选择页挡在门外，脚本就会**静默不动** —— 这正是「界面不动」最像的原因。 */
    const label = r.scenario.slice(0, 2).trim();
    if (label === 'S3') {
      /* 门禁真的把流程挡住了（扩展被关掉）：**不能一声不吭**。
       * 主人前面几轮最难查的就是这一点 —— 页面停在「选择服务」上，扩展什么都不说，
       * 只能靠猜。现在必须给一条能看懂的说明（弹窗状态里就能看到），
       * 而且**不许把「我没动手」包装成一条认证失败**去干扰后台判断。 */
      checks.push(['S3 没有静默不动：给出了一条说明', r.notes.some((n) => n && n.indexOf('没有操作') >= 0)]);
      checks.push(['S3 没把「没动手」误报成功', r.successViewShown === false]);
      checks.push(['S3 也没冒充成一条认证失败结论', r.finalStatus === '(无结论)']);
      checks.push(['S3 一次都没点「确定」', r.confirmCount === 0]);
    } else {
      checks.push([label + ' 结果成功（门禁没把这一页挡在外面）', r.finalStatus === 'success']);
      checks.push([label + ' 选中中国电信', r.checkedOperator === '中国电信']);
      checks.push([label + ' 确实点过「确定」', r.confirmCount === 1]);
    }
  }
  if (tag === 'T' || tag === 'U') {
    /* 「跳转到最终界面」＝ 完成。
     * 两个场景的落地页**都没有「认证成功 / 已在线」这类字样**（U 甚至写着「已选择服务 中国电信」，
     * 用文字判定会以为还停在选服务页）—— 只要地址真的跳走了、流程 UI 没了，就必须立刻算完成。 */
    checks.push([tag + ' 结果成功（跳转本身就是完成信号）', r.finalStatus === 'success']);
    checks.push([tag + ' 真的选中了中国电信', r.checkedOperator === '中国电信']);
    checks.push([tag + ' 确实点过「确定」', r.confirmCount === 1]);
    checks.push([tag + ' 结论写明「已跳转到完成界面」', /已跳转到完成界面/.test(r.finalNote || '')]);
    checks.push([
      tag + ' 没等成功字样/网络探测（点确定到收尾 < 1.5s）',
      r.finalAfterConfirmMs != null && r.finalAfterConfirmMs < 1500
    ]);
  }
  if (tag === 'V') {
    /* 反向钉子：旧版就是在这里误报成功的（弹窗被重渲染抹掉 → 以为好了 → 关页面）。
     * 地址没变、也没有成功字样，就只许算「待确认」，交给后台的可信探测定论。 */
    checks.push(['V 地址没变 ⇒ 不许算完成', r.finalStatus !== 'success']);
    checks.push(['V 只算「待确认」交给后台探测', r.finalStatus === 'probable']);
  }
  if (tag === 'W') {
    /* 地址是变了，但那不是最终界面 —— 是又被送回登录页（有密码框）。
     * 「地址变了就算完成」必须排除这一种，否则会把失败当成功、把页面关掉。 */
    checks.push(['W 被送回登录页（有密码框）⇒ 不许算完成', r.finalStatus !== 'success']);
    checks.push(['W 不许点「重新登录」', r.reloginCount === 0]);
  }
}

const out = [
  JSON.stringify(results, null, 2),
  '',
  '== 断言 ==',
  ...checks.map(([name, ok]) => (ok ? 'PASS  ' : 'FAIL  ') + name),
  '',
  '通过 ' + checks.filter((c) => c[1]).length + ' / ' + checks.length
].join('\n');

fs.writeFileSync(path.join(HERE, 'result.txt'), out, 'utf8');
process.exit(checks.every((c) => c[1]) ? 0 : 1);
