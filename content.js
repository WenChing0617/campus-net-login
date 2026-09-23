/* 校园网自动登录 —— 内容脚本
 *
 * 目标：**进页面立刻自己动手**，不等后台催。
 *   1. 页面一加载就盯住密码框（在就立刻填；SPA 晚渲染的用 MutationObserver 兜）
 *   2. 两步式门户：账号密码 → 点「立即登录」→ 服务选择 → 选运营商 → 点「确定」
 *      ⚠ 「服务选择」有两种形态，都要管：
 *        · **弹窗**（同一页里弹出来）
 *        · **独立整页**：门户跳到 /portal/entry/pc/serviceSelection;flowParams=…
 *          这一页里**没有密码框**，所以脚本必须支持「从选服务这一步直接进场」
 *   3. 失败提示：点「我知道了」→ 直接再点「确定」重试（最多 3 轮）
 *      注意：不点「重新登录」，也不重填账号密码 —— 门户的失败弹窗关掉后仍停在服务选择上。
 *   4. **跳转到最终界面就算完成**（主人这轮的要求）：点过「确定」之后，只要地址不再是提交那一页、
 *      并且页面上再也看不到登录表单 / 服务选项 / 确定按钮，就认定门户已经把工作流推到下一节点
 *      （落地页或 redirectUrl）—— **立刻收尾**，不再等成功字样、也不再等网络探测。
 *      依据：门户的 ServiceSelectionModule.submitForm() 只在 serviceLogin 成功时才跳走，
 *      失败时只弹一个提示弹窗、**地址不动**（见 tools/portal-structure.md）。
 *   5. 认证成功后门户若整页跳走，脚本会被销毁，由后台的 tabs.onUpdated 按同一条判据收尾
 *   6. 结论分四档，后台据此决定要不要通知/关页面：
 *        success  —— 页面出现**明确**的成功字样（认证成功/已在线…），可以收尾
 *        skipped  —— 页面本来就在线
 *        probable —— 没报错也没报成功（比如弹窗只是被重渲染抹掉），**不算成功**，
 *                    交给后台用「可信探测」确认，只有 204 才算数
 *        failed   —— 明确失败（认证失败提示 / 找不到确定按钮 / 卡住）
 *      「明确」= 没有密码框 + 没有服务选择弹窗 + 没有确定按钮 + 出现成功字样。
 *      只看到「已连接」「注销」这类到处都是的词不算——那正是旧版误报成功、提前关页的根因。
 *
 * 性能约定：每一步都用「轮询等状态」代替固定 sleep —— 状态一出现就往下走，
 * 门户响应快就整体快，不再有「明明好了还要干等 1.5 秒」的浪费。
 */

(() => {
  if (window.__campusAutoLoginInjected) return;
  window.__campusAutoLoginInjected = true;

  const FLOW_TIMEOUT_MS = 45000; // 整轮页面流程上限（快速失败，不干等）
  const MAX_SUBMIT = 3; // 账号密码最多提交 3 次
  const MAX_CONFIRM = 6; // 「确定」最多点击 6 次（首次 + 失败重试）
  const MAX_RETRY = 3; // 出现「认证失败」提示后最多重试 3 轮

  /* 各步骤最长等待（毫秒）。都是「轮询等状态」，不是固定 sleep */
  const W_PASSWORD = 6000; // 等密码框出现
  const W_BUTTON = 2500; // 等按钮从禁用变为可用
  const W_SERVICE = 5000; // 点「立即登录」后等服务选择界面
  const W_SERVICE_PAGE = 8000; // 「服务选择」是独立整页时，等那一页把选项渲染出来
  const W_OUTCOME = 6000; // 点「确定」后等结果
  const W_QUIET = 1500; // 「没报错」的二次确认
  const W_ACK_GONE = 2000; // 等失败提示消失
  const STEP = 120; // 轮询间隔（尽量小，状态一变就往下走）
  const T_PICK = 200; // 选中运营商之后
  const T_PRE = 80; // 流程启动后给页面一点缓冲
  /* 「已在线 → 先下线再认证」这条支路（主人这轮的要求） */
  const W_LOGOUT_ENTRY = 4000; // 等成功页把「我要下线」入口渲染出来
  const W_LOGOUT_CONFIRM = 2500; // 等确认弹窗
  const W_LOGOUT_JUMP = 9000; // 等门户注销完并跳走（门户内部是「成功后 2 秒再跳」）
  const W_RELOGIN = 6000; // 在下线成功页上等「重新入网」按钮

  const OPERATORS = ['中国电信', '中国移动', '中国联通'];
  const LOGIN_WORDS = ['立即登录', '登录', '登 录', '登入', 'login', 'sign in'];
  const CONFIRM_WORDS = ['确定', '确 定', '确认'];
  /* 门户的按钮文案全都走 i18n（translate.instant），中文环境渲染出来就是「我知道了」；
   * 顺手把英文键值也认上，免得哪天语言配置变了就认不出这个按钮。 */
  const ACK_WORDS = ['我知道了', '知道了', '我知道', '好的', 'i know', 'I know'];
  /* 「已在线成功页」上的下线入口。名字是门户后端配置下发的
   * （/sam/api/protected/eportal/querySuccessPageCustomizedPageConfig → functions[].nameZh），
   * 实测（某高校门户）叫「我要下线」（英文 Log Out）。把常见叫法都认上，后端改文案也不至于瞎。
   * ⚠ 必须和「重新登录 / 重新连接」分开 —— 那是往下走的入口，不是下线。 */
  const LOGOUT_WORDS = ['我要下线', '下线', '注销', '退出登录', '登出', '退出', 'log out', 'logout', 'sign out'];
  /* 「已下线成功页」上的按钮。⚠ 文案是门户 i18n 的 'Reconnect.network'，
   * 实测（某高校门户）渲染出来是**「重新入网」**——不是「重新连接网络」！
   * v1.11.0 就是照英文键名意译成「重新连接网络」写进词表的，于是真机上那个按钮
   * **一次都没被认出来**（页面停在「已下线」不动、认证也就没进到网页里）。
   * 现在按门户语言包（assets/tmp/i18n/zh-CN.json，1271 条）把真实文案抄齐：
   *   Reconnect.network = 重新入网 / Recertification = 重新认证 / sign.in.again = 重新登录
   *   Processed.network = 已处理，重新入网
   * 别的学校可能挂在「重新连接网络 / 再次连接」上，一并留着。 */
  const RELOGIN_WORDS = [
    '重新入网',
    '重新连接网络',
    '重新连接',
    '重新认证',
    '重新登录',
    '再次入网',
    '再次连接',
    '已处理，重新入网',
    'reconnect',
    'connect again',
    'log in again'
  ];
  const USER_HINTS = /(user|name|account|login|学号|工号|账号|帐号|用户名|手机)/i;
  const EXCLUDE_HINTS = /(code|captcha|verify|validate|checkcode|sms|验证码|短信|图形|random)/i;
  /* ⚠ 这里曾经很松：SUCCESS_RE 里带了「已连接 / 网络已连接」，还有一条
   * 「页面上有『注销』就算已连接」的兜底。可门户页头一般就挂着「注销 / 退出登录」，
   * 而点完「立即登录」时密码框会被服务选择弹窗顶掉 —— 于是「没有密码框 + 页面上有注销」
   * 两条一凑，服务还没选就被判成「已连接」，直接报成功、关页面。
   * 主人看到的「服务依旧没有选就关闭了」就是这么来的。
   * 现在只认**明确的成功字样**，且必须同时满足「没有密码框 + 没有服务选择弹窗 + 没有确定按钮」。 */
  const SUCCESS_RE = /认证成功|连接成功|上网成功|登录成功|已成功连接|连接已建立|认证通过|您已在线|已在线|已经在线|重复登录|已认证/;
  const FAIL_RE = /认证失败|认证未通过|失败原因|运营商未响应|连接失败|认证错误|登录失败|认证异常/;
  const ALREADY_ONLINE_RE = /已在线|已经在线|重复登录|已登录|已认证/;
  /* 门户页特征：只有同时命中「像校园网门户」才允许在 .edu.cn / 内网 上自动操作。
   * 注意带上「选择服务 / 运营商」这类词 —— 服务选择是**独立的一整页**（serviceSelection），
   * 那一页上没有密码框，只有服务选项，少了这几个词就会被判成「不是门户页」。
   * 再加一层：真实门户的文案是 i18n 的，翻译没加载时页面上会直接显示**键名**
   * （select.a.service / sign.in.again），认出来也算数。 */
  const PORTAL_HINT_RE = /校园网|上网认证|认证|wlanuserip|wlanacname|ac_id|srun|eportal|portal|网络连接|账号|帐号|密码|选择服务|服务选择|运营商|serviceSelection|login|select\.a\.service|sign\.in/i;
  const PRIVATE_HOST_RE = /^(10\.|192\.168\.|127\.|172\.(1[6-9]|2\d|3[01])\.)/;
  const EDU_HOST_RE = /(^|\.)edu\.cn$|(^|\.)edu$/i;

  /* ===== 1.13.0：校内业务系统（教务 / 图书馆 / 邮箱 …）绝不能被当成校园网门户 =====
   *
   * 起因（实测）：打开教务系统 http://jwxt.example.edu.cn/login.action 这类校内业务登录页时，
   *   扩展会突然弹一条通知、然后把这个网页自己关掉。
   *   原因链：那一页**有密码框** + 域名是 **.edu.cn** + 页面上有「用户名 / 密码 / 登录」，
   *   旧版 hostAllowed 只要求「.edu.cn + 弱特征（账号|密码|login）」就放行 →
   *   脚本把它当门户填表提交 → 后台按「认证成功」收尾 → closeTabOnSuccess 把**主人自己开的标签页**关掉。
   *
   * 修法分三层：
   *   1) 强特征：非同源的 .edu.cn 页面，必须出现「校园网 / 上网认证 / portal / srun / ac_id /
   *      运营商 / 选择服务 / 我要下线 …」这类**只有校园网认证页才有**的词，光有「账号密码登录」不算；
   *   2) 排除词：页面出现「教务 / 选课 / 成绩 / 图书 / 一卡通 / 统一身份 …」直接否决；
   *   3) 排除域名：设置里可自己填（见 options 的「排除域名」）。通用版不预置任何学校专属域名——
   *      各校教务 / 图书馆 / 邮箱的地址都不一样，写死一串只会误导；真正跨校通用的是上面第 2 条。 */
  const PORTAL_STRONG_RE = /校园网|上网认证|网络认证|认证系统|认证平台|自助服务|上网登录|网络连接中|wlanuserip|wlanacname|wlanacip|wlan_user|ac_id|srun|eportal|portal|serviceSelection|service-selection|选择服务|服务选择|运营商|我要下线|重新入网|重新连接网络|已在线|认证成功/i;
  const BUSINESS_EXCLUDE_RE = /教务|教学管理|成绩|选课|课表|考试|考务|四六级|普通话|图书|借阅|一卡通|缴费|迎新|学工|宿舍|报修|实习|毕业设计|毕业论文|评教|教材|财务|办公自动化|统一身份|信息门户|办事大厅|智慧校园|研究生|学籍|课程序号|教师发展|就业指导|招聘/i;
  /* 通用版不预置任何学校专属域名（各校教务 / 图书馆 / 邮箱地址都不一样），
   * 跨校通用的那层防护是上面的 BUSINESS_EXCLUDE_RE —— 它按页面内容判定，不认域名。 */
  const DEFAULT_EXCLUDE_HOSTS = '';

  /* 排除名单：设置里填的优先。
   * 逗号 / 空格 / 换行都能分隔；写 `jwxt.xxx.edu.cn` 只排除这一个，
   * 写 `xxx.edu.cn` 会把它的所有子域名一起排除（门户也在里面的话就连门户一起排掉，慎用）。 */
  function hostExcluded(host, cfg) {
    const raw = String((cfg && cfg.excludeHosts) || DEFAULT_EXCLUDE_HOSTS);
    const h = String(host || '').toLowerCase();
    return raw
      .split(/[\s,，;；]+/)
      .map((s) => s.trim().toLowerCase())
      .filter(Boolean)
      .some((d) => h === d || h.endsWith('.' + d));
  }

  let flowRunning = false;
  let selfStarted = false; // 登录页那条流程有没有自己跑过
  let selfStartedService = false; // 「服务选择」那条有没有自己跑过（独立整页时是另一条）

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const norm = (s) => String(s || '').replace(/\s+/g, '').trim();

  /* 轮询等一个状态：fn 返回真值就立刻返回它，超时才返回 null。
   * 这是整份脚本「快」的关键——不再用固定 sleep 猜门户要多久。 */
  async function waitUntil(fn, timeoutMs, stepMs) {
    const end = Date.now() + Math.max(0, timeoutMs || 0);
    for (;;) {
      let v = null;
      try {
        v = fn();
      } catch (e) {
        v = null;
      }
      if (v) return v;
      if (Date.now() >= end) return null;
      await sleep(stepMs || STEP);
    }
  }

  function isVisible(el) {
    if (!el || !el.getBoundingClientRect) return false;
    const r = el.getBoundingClientRect();
    if (r.width < 4 || r.height < 4) return false;
    const s = getComputedStyle(el);
    return s.visibility !== 'hidden' && s.display !== 'none' && Number(s.opacity || 1) > 0.05;
  }

  function textOf(el) {
    return String((el.innerText || el.textContent || el.value || '')).replace(/\s+/g, ' ').trim().slice(0, 60);
  }

  /* 取元素自身文案，长度放宽（用于识别弹窗内容） */
  function ownText(el, max) {
    try {
      return String(el.innerText || el.textContent || '').replace(/\s+/g, ' ').trim().slice(0, max || 400);
    } catch (e) {
      return '';
    }
  }

  function pageText() {
    try {
      return (document.body && document.body.innerText) || '';
    } catch (e) {
      return '';
    }
  }

  function allInputs() {
    return Array.from(document.querySelectorAll('input, textarea')).filter(isVisible);
  }

  function hasPasswordField() {
    return allInputs().some((el) => (el.type || '').toLowerCase() === 'password');
  }

  /* 便宜的预检：没有密码输入框就立刻退出，避免在普通页面上做布局计算 */
  function hasAnyPassword() {
    try {
      return !!document.querySelector('input[type=password]');
    } catch (e) {
      return false;
    }
  }

  function attrMatch(el, re) {
    const s = [el.name, el.id, el.placeholder, el.getAttribute('aria-label'), el.className].join(' ');
    return re.test(s);
  }

  function findUsername(sel) {
    if (sel) {
      const el = document.querySelector(sel);
      if (el && isVisible(el)) return el;
    }
    const cands = allInputs().filter((el) => {
      const t = (el.type || 'text').toLowerCase();
      const okType = t === 'text' || t === 'tel' || t === 'email' || t === 'number' || el.tagName === 'TEXTAREA';
      return okType && !attrMatch(el, EXCLUDE_HINTS) && !attrMatch(el, /pass|pwd|密码/i);
    });
    return cands.find((el) => attrMatch(el, USER_HINTS)) || cands[0] || null;
  }

  function findPassword(sel) {
    if (sel) {
      const el = document.querySelector(sel);
      if (el && isVisible(el)) return el;
    }
    return allInputs().find((el) => (el.type || '').toLowerCase() === 'password') || null;
  }

  function setValue(el, value) {
    try {
      el.focus({ preventScroll: true });
    } catch (e) {
      /* 忽略 */
    }
    const proto = el.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
    const desc = Object.getOwnPropertyDescriptor(proto, 'value');
    if (desc && desc.set) desc.set.call(el, value);
    else el.value = value;
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
    try {
      el.dispatchEvent(new Event('blur', { bubbles: true }));
    } catch (e) {
      /* 忽略 */
    }
  }

  function clickLike(el) {
    try {
      el.scrollIntoView({ block: 'center' });
    } catch (e) {
      /* 忽略 */
    }
    ['pointerdown', 'mousedown', 'pointerup', 'mouseup'].forEach((t) => {
      try {
        el.dispatchEvent(new MouseEvent(t, { bubbles: true, cancelable: true, view: window }));
      } catch (e) {
        /* 忽略 */
      }
    });
    if (typeof el.click === 'function') {
      try {
        el.click();
        return;
      } catch (e) {
        /* 忽略 */
      }
    }
    try {
      el.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, view: window }));
    } catch (e) {
      /* 忽略 */
    }
  }

  function isDisabled(el) {
    if (!el) return true;
    if (el.disabled) return true;
    const cls = String(el.className || '');
    if (/is-disabled|disabled/.test(cls)) return true;
    const attr = el.getAttribute && el.getAttribute('aria-disabled');
    return attr === 'true';
  }

  /* 按文本找可点击元素：精确匹配优先，其次按钮标签 / 按钮样式。
   *
   * ⚠ v1.9.0 修的是一个**最隐蔽的坑**：真实门户（Angular + ng-zorro）的「确定」按钮长这样——
   *     <div class="footer">
   *       <button class="button-3">重新登录</button>
   *       <button class="button-6">确定</button>
   *     </div>
   *   旧版按「文字里含『确定』」打分，包着两个按钮的 <div class="footer">（文字 =「重新登录确定」）
   *   拿到 45 分刚好过线，而 div 压根没有 disabled 属性 → isDisabled() 判它「可用」→ 于是：
   *     · confirmReady() 误报「确定按钮已可点」，selectOperator 提前收工，运营商其实没选中；
   *     · findConfirmButton() 返回的是这个 div，clickLike() 点在容器上，
   *       门户把 click 监听的挂在 <button> 上，收不到 → 表现就是「点了也没反应、界面不动」。
   *   现在给「容器」明确降权：自身不是原生按钮、里面还包着别的按钮的，一律排到真按钮后面。 */
  function findClickable(words, opts) {
    const o = opts || {};
    const sel = 'button, a, [role=button], input[type=button], input[type=submit], .el-button, .btn, li, span, div';
    const nodes = Array.from(document.querySelectorAll(sel)).filter((el) => {
      if (!isVisible(el)) return false;
      const t = textOf(el);
      return t && t.length <= 16;
    });
    let best = null;
    let bestScore = 0;
    for (const el of nodes) {
      if (o.enabledOnly && isDisabled(el)) continue;
      const t = norm(textOf(el));
      const native = /^(BUTTON|INPUT|A)$/.test(el.tagName);
      for (const w of words) {
        const nw = norm(w);
        if (!nw) continue;
        let score = 0;
        if (t === nw) score = 100;
        else if (t.startsWith(nw)) score = 65;
        else if (t.includes(nw)) score = 45;
        else continue;
        if (native) score += 30;
        if (/btn|button/i.test(String(el.className || ''))) score += 12;
        if (!native) {
          // 里面还装着别的按钮/链接 → 它是「一行按钮的容器」，不是按钮本身，重罚
          try {
            if (el.querySelector('button, a, [role=button], input[type=button], input[type=submit]')) score -= 60;
            if (!el.querySelector('*')) score += 6; // 纯叶子容器（文字就是自己的）稍微加分
          } catch (e) {
            /* 忽略 */
          }
        }
        if (score > bestScore) {
          bestScore = score;
          best = el;
        }
      }
    }
    return bestScore >= 45 ? best : null;
  }

  /* ---------------- 服务商（身份）选择 ----------------
   * 真实门户里选项形态五花八门：radio+label、可点卡片、li 列表、图标块……
   * 早期版本只按「文本匹配的 div/span」去点，遇到 radio+label 结构时 radio 不会被真正选中，
   * 门户的「确定」按钮就一直禁用 —— 表现正是「卡在选择运营商界面不动」。
   * 所以这里分三层：① 找 radio 用原生方式选中 ② 找 label ③ 才点任意文本元素，
   * 每一步都回头验证「页面是否真的标记为已选」，不通过就换下一种方式。 */

  const OP_GROUPS = [
    { name: '中国电信', keys: ['中国电信', '电信', 'telecom'] },
    { name: '中国移动', keys: ['中国移动', '移动', 'cmcc'] },
    { name: '中国联通', keys: ['中国联通', '联通', 'unicom'] }
  ];
  const DIALOG_HINT_RE = /请选择服务|选择服务|选择网络|选择运营商|选择身份|运营商|身份|认证方式|select\.a\.service/;
  const PICKED_CLASS_RE = /(^|[\s-])(active|selected|checked|current|chosen|is-checked|is-selected|on)([\s-]|$)/i;

  const escSel = (s) => {
    try {
      return typeof CSS !== 'undefined' && CSS.escape ? CSS.escape(s) : String(s).replace(/["\\]/g, '\\$&');
    } catch (e) {
      return String(s);
    }
  };

  function groupForText(text, opts) {
    const t = norm(text).toLowerCase();
    if (!t) return null;
    for (const g of OP_GROUPS) {
      for (const k of g.keys) {
        const nk = norm(k).toLowerCase();
        if (!nk) continue;
        if (t === nk || t.includes(nk)) return g.name;
      }
    }
    // 短代号（dx/yd/lt）只在「按属性判断」时用，且**按词比对**。
    // ⚠ 这里不能拿上面那个去过空格的 t：radio 常写成 value="dx" name="identity"，
    //   去空格后连成 "dxidentity"，词边界就没了，短代号永远匹配不上 ——
    //   于是这种没有 label 的单选框会被判成「不是运营商选项」，一个都不选。
    if (opts && opts.attrs) {
      const raw = ' ' + String(text || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim() + ' ';
      for (const g of OP_GROUPS) {
        const short = g.name === '中国电信' ? 'dx' : g.name === '中国移动' ? 'yd' : 'lt';
        if (raw.includes(' ' + short + ' ')) return g.name;
      }
    }
    return null;
  }

  /* 文本里只出现**一家**运营商时才认。同时出现两家以上（比如包住整个选项列表的容器）
   * 一律返回 null —— 否则会把「中国电信」错贴到移动/联通的 radio 上，选错运营商认证必然失败。 */
  function oneGroupForText(text, opts) {
    const t = norm(text).toLowerCase();
    if (!t) return null;
    const hit = new Set();
    for (const g of OP_GROUPS) {
      for (const k of g.keys) {
        const nk = norm(k).toLowerCase();
        if (nk && (t === nk || t.includes(nk))) hit.add(g.name);
      }
    }
    if (hit.size === 1) return Array.from(hit)[0];
    if (hit.size === 0 && opts && opts.attrs) return groupForText(text, { attrs: true });
    return null;
  }

  function labelFor(el) {
    try {
      if (el.id) {
        const l = document.querySelector('label[for="' + escSel(el.id) + '"]');
        if (l) return l;
      }
      return (el.closest && el.closest('label')) || null;
    } catch (e) {
      return null;
    }
  }

  /* 判断一个 radio 属于哪一家：先看 value/id/name 属性（dx/yd/lt 这类短代号也认），
   * 再看 for= 的 label 文案，最后才看父容器——父容器只接受「只出现一家」的情况，
   * 且向上找三层（有的门户中间夹了一层 <span class="radio-input"> 之类的壳）。 */
  function radioGroupName(r) {
    try {
      const attrs = [r.value, r.id, r.name, r.getAttribute('aria-label'), r.title].filter(Boolean).join(' ');
      const byAttr = groupForText(attrs, { attrs: true });
      if (byAttr) return byAttr;
      const lbl = labelFor(r);
      if (lbl) {
        const n = oneGroupForText(ownText(lbl, 40));
        if (n) return n;
      }
      let p = r.parentElement;
      for (let i = 0; i < 3 && p; i += 1, p = p.parentElement) {
        if (p === document.body || p.tagName === 'HTML') break;
        const n = oneGroupForText(ownText(p, 80));
        if (n) return n;
      }
    } catch (e) {
      /* 忽略 */
    }
    return null;
  }

  /* 收集页面上所有「像运营商选项」的元素，带归属（哪一家） */
  function allOperatorCandidates() {
    const out = [];
    // 便宜预检：整页既没有 radio 也搜不到运营商名 → 普通网站，直接短路（省掉整树遍历）
    let hasRadio = false;
    try {
      hasRadio = !!document.querySelector('input[type=radio]');
    } catch (e) {
      /* 忽略 */
    }
    if (!hasRadio && !groupForText(pageText())) return out;

    const seen = new Set();
    const push = (el, kind, name, text) => {
      if (!el || seen.has(el)) return;
      seen.add(el);
      out.push({ el, kind, name, text: String(text || '').slice(0, 30) });
    };

    // ① radio：自定义样式常把它藏起来（opacity:0 / 覆盖式），所以不要求可见
    try {
      Array.from(document.querySelectorAll('input[type=radio]')).forEach((r) => {
        const name = radioGroupName(r);
        if (name) push(r, 'radio', name, [r.value, r.id].filter(Boolean).join('/'));
      });
    } catch (e) {
      /* 忽略 */
    }

    // ② label（for=radio 的常见写法）
    try {
      Array.from(document.querySelectorAll('label')).forEach((l) => {
        if (!isVisible(l)) return;
        const name = oneGroupForText(ownText(l, 40));
        if (name) push(l, 'label', name);
      });
    } catch (e) {
      /* 忽略 */
    }

    // ③ 任意短文本元素（取较深的节点，避免点到包住整页的容器）。
    //    标签列表要够宽：门户常把选项名放在 <b>/<strong>/<em> 里，漏一个就少一条命。
    //    ⚠ 这里必须用 oneGroupForText（**只认只出现一家**的）而不是 groupForText：
    //    真实门户的服务列表外面包着一层 <div id="relationInfo">，它的文字是
    //    「中国电信 中国移动 中国联通」—— 含三家。用 groupForText 会把它判成「中国电信」的候选，
    //    于是第一次点击点在**这个容器**上，什么都不会发生，运营商一个都没选中。
    const TEXT_TAGS = 'div,span,li,a,p,td,th,section,article,button,b,strong,em,i,label,dt,dd,h1,h2,h3,h4,h5,h6';
    try {
      Array.from(document.querySelectorAll(TEXT_TAGS)).forEach((el) => {
        if (!isVisible(el)) return;
        const t = textOf(el);
        if (!t || t.length > 20 || ownText(el, 40).length > 24) return;
        const name = oneGroupForText(t);
        if (name) push(el, 'element', name, t);
      });
    } catch (e) {
      /* 忽略 */
    }
    return out;
  }

  /* 候选是不是**露出来了**：元素自身可见，或它向上 3 层内有个可见的容器。
   * 为什么要往上看祖先：真实门户里自定义样式的 radio 常被 opacity:0 藏进一张卡片里，
   * 只露出卡片本身——上一版只看元素自身 + label，于是「明明看得见选项」却被判成
   * 「服务弹窗不存在」，流程直接在「请选择服务」界面上放弃，运营商一个都没选。
   * 为什么往上看祖先不会误判：整块弹窗被 display:none 时，真实浏览器里连它所有子孙的
   * 尺寸都是 0，祖先同样不可见，所以不会把「已经关掉的弹窗」当成还在。 */
  function candidateVisible(c) {
    try {
      let el = c.el;
      for (let i = 0; i < 4 && el; i += 1, el = el.parentElement) {
        if (!el || el === document.body || el === document.documentElement) break;
        if (isVisible(el)) return true;
      }
      if (c.kind === 'radio') {
        const l = labelFor(c.el);
        if (l && isVisible(l)) return true;
      }
    } catch (e) {
      /* 忽略 */
    }
    return false;
  }

  /* 服务选择界面**正显示着**吗？判定顺序是「先松后紧」，只要能确定是这一步就往下走：
   *   ① 露出两家以上运营商        → 就是它
   *   ② 页面写着「请选择服务」等   → 就是它（有的门户只放一家候选）
   *   ③ 露着一家 + 登录表单没了 + 「确定」按钮在 → 也是它
   * 认证成功后弹窗被隐藏 → 三条都不成立 → 返回 null，「已在线」的判定才成立。 */
  function serviceDialog() {
    const all = allOperatorCandidates();
    if (!all.length) return null;
    const namesOfAll = Array.from(new Set(all.map((c) => c.name)));
    const vis = all.filter(candidateVisible);
    if (vis.length) {
      const names = Array.from(new Set(vis.map((c) => c.name)));
      if (names.size >= 2) return { all: vis, names };
      if (DIALOG_HINT_RE.test(pageText())) return { all: vis, names };
      if (!hasPasswordField() && visibleConfirmExists()) return { all: vis, names };
    }
    if (DIALOG_HINT_RE.test(pageText())) return { all, names: namesOfAll };
    if (!hasPasswordField() && visibleConfirmExists()) return { all, names: namesOfAll };
    return null;
  }

  /* ============ 「服务选择」是独立整页的情况 ============
   * 主人的门户点完「立即登录」后会**整页跳转**到
   *   https://portal.example.edu.cn/portal/entry/pc/serviceSelection;flowParams=undefined;from=authenticate;sid=false
   * 这一页里**没有密码框**。
   * 而旧版所有入口（页面自启动 / PING / FILL_AND_SUBMIT）都拿「有密码框」当前提，
   * 于是到了这一页脚本完全不动作 —— 表现就是「服务选择页还是没有自动选择」。
   * 认这一页的三种方式（命中任一即可），从便宜到贵：
   *   ① 地址里带 serviceSelection / selectService
   *   ② 页面上写着「请选择服务 / 选择运营商 / 认证方式」这类文案
   *   ③ 页面上真的露出了运营商选项
   */
  const SERVICE_URL_RE = /serviceSelection|selectService|service[-_]?select|chooseService|select[-_]?identity/i;

  function servicePageUrl(u) {
    try {
      const s = u || location.pathname + location.search + location.hash;
      return SERVICE_URL_RE.test(String(s));
    } catch (e) {
      return false;
    }
  }

  function isServiceSelectionPage() {
    try {
      if (hasPasswordField()) return false;
      /* ⚠ 先排掉「已在线 / 已下线」页。
       * 这两页上**也可能出现「选择服务」这个词** —— 门户的功能卡片里就有这么一项
       * （真实配置接口返回的 functions[].nameZh 里明明白白写着「选择服务」，
       *  functionType = selectService）。不先排掉，这一页就会被当成服务选择页：
       * 脚本转头去等服务选项，而页面上根本没有选项 —— 表现又是「停在页面上不动」。 */
      if (onlineSuccessNode() || offlineSuccessNode()) return false;
      if (servicePageUrl()) return true;
      if (DIALOG_HINT_RE.test(pageText())) return true;
      const all = allOperatorCandidates();
      return all.length > 0 && all.some(candidateVisible);
    } catch (e) {
      return false;
    }
  }

  /* 最后一招：整页粗搜运营商名字。
   * 结构化扫描（radio / label / 短文本）认不出来时，退回到「最早那版」的朴素做法 ——
   * 页面上哪里写着「中国电信」，就把那一块、以及它外面几层小容器点一遍。
   * 只取「最内层」的那个元素（它自己不再包含写着同样名字的后代），避免点到包住整页的大容器；
   * 往上点容器时也限定容器文字长度，绝不点到大块区域上去。 */
  function bruteOperatorTargets(name) {
    const out = [];
    try {
      const keys = (OP_GROUPS.find((g) => g.name === name) || OP_GROUPS[0]).keys;
      const nodes = document.querySelectorAll('body *');
      for (const el of nodes) {
        if (out.length >= 6) break;
        if (!el || !el.tagName || el === document.body) continue;
        if (!isVisible(el)) continue;
        const t = ownText(el, 200);
        if (!t || !keys.some((k) => t.includes(k))) continue;
        let deeper = false;
        for (const c of Array.from(el.children)) {
          if (keys.some((k) => ownText(c, 200).includes(k))) {
            deeper = true;
            break;
          }
        }
        if (deeper) continue; // 内层还有同样名字 → 它不是最内层那个
        out.push(el);
      }
    } catch (e) {
      /* 忽略 */
    }
    return out;
  }

  /* 点一下某个候选。
   * radio 走「真人路径」：先点它关联的 label（很多框架只监听了 label/容器的点击），
   * 再看 radio 有没有真的被选中，没选中就用原生方式补一刀；最后才退到点父容器。 */
  function activateOperator(c) {
    const el = c.el;
    if (c.kind === 'radio') {
      // ① 先让浏览器按「点标签」的老规矩来
      const lbl = labelFor(el);
      if (lbl) clickLike(lbl);
      // ② 还没选中就点 radio 本身
      if (!el.checked) {
        try {
          el.click();
        } catch (e) {
          /* 忽略 */
        }
      }
      // ③ 还没有就原生置位 + 派发 input/change（Angular 认这两件事）
      if (!el.checked) {
        try {
          el.checked = true;
          el.dispatchEvent(new Event('input', { bubbles: true }));
          el.dispatchEvent(new Event('change', { bubbles: true }));
        } catch (e) {
          /* 忽略 */
        }
      }
      // ④ 最后点它外面那层壳（有些框架的点击监听挂在壳上）
      if (!el.checked && el.parentElement) clickLike(el.parentElement);
      return;
    }
    clickLike(el);
    try {
      const p = el.parentElement;
      if (p && p !== document.body && ownText(p, 60).length <= 40) clickLike(p);
    } catch (e) {
      /* 忽略 */
    }
  }

  function isOperatorPicked(name) {
    try {
      // 1) radio 被选中（最可靠）
      const radios = Array.from(document.querySelectorAll('input[type=radio]'));
      for (const r of radios) {
        if (!r.checked) continue;
        if (radioGroupName(r) === name) return true;
      }
      // 2) 候选元素自身或其近祖先带选中态（active/selected/checked…），范围小、开销低
      const cands = allOperatorCandidates().filter((c) => c.name === name);
      for (const c of cands) {
        let el = c.el;
        for (let i = 0; i < 4 && el; i += 1, el = el.parentElement) {
          const cls = String(el.className || '');
          const aria = (el.getAttribute && (el.getAttribute('aria-checked') || el.getAttribute('aria-selected'))) || '';
          if (PICKED_CLASS_RE.test(cls) || aria === 'true') return true;
        }
      }
    } catch (e) {
      /* 忽略 */
    }
    return false;
  }

  /* 「确定」按钮是否已经可以按了。门户在没选服务时会把「确定」置灰，
   * 它一变亮就说明服务真的选上了 —— 这个信号比任何 class 猜测都靠谱，直接当验证用。 */
  function confirmReady() {
    try {
      const b = findClickable(CONFIRM_WORDS, { enabledOnly: true });
      return !!(b && isVisible(b));
    } catch (e) {
      return false;
    }
  }

  /* 选中目标运营商。
   *
   * 这一版的取舍：**以「真的点下去」为先，验证只当参考**。
   * 前几版给验证加了太多门槛（必须看到 radio 被 checked、必须看到选中 class…），
   * 一旦门户的标记方式和我们的猜测不一致，就判定「选不上」而原地放弃 —— 可主人反馈
   * 最早那版朴素地「找到写着运营商名字的元素点一下」反倒是能选上的。
   * 所以现在：所有找到的候选全都点一遍（radio / label / 文本元素，再逐层点祖先容器），
   * 任一时刻「页面标记为已选」或「确定按钮变亮」就收工。 */
  async function selectOperator(operator) {
    const target = groupForText(norm(operator)) || OP_GROUPS[0].name;
    // 只有「页面确实已经把目标运营商标记为已选」才跳过点击；
    // 「确定」能按不算数（有的门户压根不禁用它），该点还是要点一下。
    if (isOperatorPicked(target)) return { ok: true, name: target, kind: 'already' };

    const all = allOperatorCandidates().filter((c) => c.name === target);
    if (!all.length) {
      /* 结构化扫描一个都没认出来 → 上「整页粗搜」这一招。
       * 门户结构千奇百怪（radio 藏在图标里、名字写在 <b> 里、整行只有容器可点…），
       * 只要页面上还写着「中国电信」，就把它那一块和外面几层小容器点一遍。 */
      const brute = bruteOperatorTargets(target);
      if (brute.length) {
        let bc = 0;
        for (const el of brute) {
          let node = el;
          for (let k = 0; k < 4 && node; k += 1, node = node.parentElement) {
            if (!node || node === document.body || node.tagName === 'HTML') break;
            if (!isVisible(node)) continue;
            if (ownText(node, 200).length > 120) break; // 别点到大块区域上
            clickLike(node);
            bc += 1;
            await sleep(80);
            if (isOperatorPicked(target) || confirmReady()) {
              return { ok: true, name: target, kind: 'brute+' + k };
            }
          }
        }
        return {
          ok: false,
          name: target,
          reason: '粗搜到「' + target + '」但点了 ' + bc + ' 次仍未生效',
          diag: diagSummary()
        };
      }
      const found = Array.from(new Set(allOperatorCandidates().map((c) => c.name)));
      return {
        ok: false,
        name: target,
        reason: '页面上找不到「' + target + '」选项' + (found.length ? '（只看到 ' + found.join('/') + '）' : ''),
        diag: diagSummary()
      };
    }
    const order = { radio: 0, label: 1, element: 2 };
    all.sort((a, b) => order[a.kind] - order[b.kind]);

    let clicks = 0;
    // 第一轮：候选本身（radio 优先，然后 label，然后文本元素）
    for (const c of all.slice(0, 8)) {
      activateOperator(c);
      clicks += 1;
      await sleep(90);
      if (isOperatorPicked(target) || confirmReady()) return { ok: true, name: target, kind: c.kind };
    }
    // 第二轮：逐层往上点容器（框架常把点击绑在卡片外层，且只认那一个元素）
    for (const c of all.slice(0, 4)) {
      let el = c.el;
      for (let d = 1; d <= 5 && el && el.parentElement; d += 1) {
        el = el.parentElement;
        if (!el || el === document.body || el.tagName === 'HTML') break;
        if (!isVisible(el)) continue; // 隐藏容器点了没意义
        clickLike(el);
        clicks += 1;
        await sleep(70);
        if (isOperatorPicked(target) || confirmReady()) return { ok: true, name: target, kind: c.kind + '+ancestor' };
      }
    }
    return {
      ok: false,
      name: target,
      reason: '点了「' + target + '」但页面没有标记为选中（已尝试 ' + clicks + ' 次点击）',
      diag: diagSummary()
    };
  }

  /* 找「确定」：先按文本，再退到弹窗容器内的按钮（排除取消/关闭之类） */
  function findConfirmButton(cands) {
    const b = findClickable(CONFIRM_WORDS, { enabledOnly: true }) || findClickable(CONFIRM_WORDS);
    if (b) return b;
    const scopeSel = 'button, [role=button], input[type=submit], input[type=button], .el-button, .btn, a';
    const scopes = [];
    (cands || []).slice(0, 6).forEach((c) => {
      let p = c.el;
      for (let i = 0; i < 6 && p && p.parentElement; i += 1) {
        p = p.parentElement;
        if (!p || p.tagName === 'BODY' || p.tagName === 'HTML') break;
        scopes.push(p);
      }
    });
    for (const s of scopes) {
      const list = Array.from(s.querySelectorAll(scopeSel)).filter((x) => {
        if (!isVisible(x)) return false;
        // 兜底挑按钮时一定要避开「重新登录 / 取消 / 关闭」这些反向操作
        // （真实门户的「重新登录」是 i18n 的 sign.in.again，英文环境下就是 Sign in again，
        //  所以中英文两种写法都要排掉，别把「重新登录」当成「确定」点下去）
        return !/取消|关闭|返回|重新登录|重登|注销|退出|cancel|close|back|relogin|logout|sign\s*in|log\s*out/i.test(
          norm(textOf(x))
        );
      });
      const hit = list.find((x) => /determine|confirm|submit|primary|success|sure|ok/i.test(String(x.className || '') + ' ' + (x.type || '')));
      if (hit) return hit;
      if (list.length) return list[list.length - 1]; // 弹窗里通常「确定」在最后
    }
    return null;
  }

  /* 页面骨架：把可见的「叶子级」元素连标签 / 类名 / 文字摘出来。
   * 门户结构认不出来时，这一行比整段 HTML 好读得多，也能直接看出该往哪儿点。 */
  function pageSkeleton(limit) {
    const parts = [];
    try {
      const nodes = document.querySelectorAll('body *');
      for (const el of nodes) {
        if (parts.length >= (limit || 30)) break;
        if (!el.tagName || !isVisible(el)) continue;
        const tag = el.tagName.toLowerCase();
        const leaf = !el.querySelector('*');
        if (!leaf && !/^(button|a|input|label|li|img|i|b|strong|em|span|h\d)$/.test(tag)) continue;
        const t = norm(el.innerText || el.textContent || '');
        const cls = String(el.className || '')
          .split(/\s+/)
          .filter(Boolean)
          .slice(0, 2)
          .join('.');
        const val = el.tagName === 'INPUT' ? '(' + (el.type || '') + (el.value ? '=' + el.value : '') + ')' : '';
        const aria = (el.getAttribute && el.getAttribute('aria-checked')) ? ' aria-checked=' + el.getAttribute('aria-checked') : '';
        parts.push(tag + (cls ? '.' + cls : '') + val + aria + (t ? ':"' + t.slice(0, 14) + '"' : ''));
      }
    } catch (e) {
      /* 忽略 */
    }
    return parts.join(' ');
  }

  /* 卡住时把页面关键信息带回去，便于定位（radio 数量、选中状态、按钮文案、页面骨架）。
   * 带上每个 radio 的 value/id/name/标签/父容器文案——万一门户结构又和预期不同，
   * 凭这一行就能看出该往哪儿点，不用再靠猜。 */
  function diagSummary() {
    try {
      const radios = Array.from(document.querySelectorAll('input[type=radio]'));
      const btns = Array.from(document.querySelectorAll('button, [role=button], input[type=submit], input[type=button], .el-button, .btn, a'))
        .filter(isVisible)
        .map((b) => norm(textOf(b)) || norm(b.value) || '')
        .filter(Boolean)
        .slice(0, 10);
      const all = allOperatorCandidates();
      const ops = Array.from(new Set(all.map((c) => c.name + ':' + c.kind + (candidateVisible(c) ? '*' : '-'))));
      const outline = radios
        .slice(0, 6)
        .map((r, i) => {
          const lbl = labelFor(r);
          return (
            'r' + (i + 1) + '[v=' + (r.value || '') + ',id=' + (r.id || '') + ',n=' + (r.name || '') +
            ',lbl=' + norm(ownText(lbl, 16)) + ',par=' + norm(ownText(r.parentElement, 16)) +
            (r.checked ? ',ON' : '') + ']'
          );
        })
        .join('');
      return (
        'url=' + location.pathname + ' ' +
        'radio=' + radios.length + '(选中' + radios.filter((r) => r.checked).length + ')' + outline + ' ' +
        '候选=[' + (ops.join(',') || '无') + '] 按钮=[' + btns.join('|') + '] ' +
        '骨架=[' + pageSkeleton() + ']'
      ).slice(0, 700);
    } catch (e) {
      return '诊断信息读取失败';
    }
  }

  /* 卡住时再抓一段「服务选择那一块」的原始 HTML。
   * 门户结构千奇百怪，一行摘要有时还是猜不出该点哪儿，这段 HTML 能直接看出来。 */
  function compactHtml(el, max) {
    try {
      return String(el.outerHTML || '')
        .replace(/\s+/g, ' ')
        .replace(/>\s+</g, '><')
        .slice(0, max || 900);
    } catch (e) {
      return '';
    }
  }

  function dialogHtml() {
    try {
      const nodes = allOperatorCandidates()
        .map((c) => c.el)
        .filter(Boolean);
      if (!nodes.length) {
        const b = findClickable(CONFIRM_WORDS);
        if (b && b.parentElement) return compactHtml(b.parentElement, 700);
        // 连「确定」都找不到：退到 body 的主内容区，去掉脚本/样式后给一段真实结构
        const main = document.querySelector('main, #app, #root, .el-main, .content') || document.body;
        return compactHtml(main, 4000)
          .replace(/<script[\s\S]*?<\/script>/gi, '')
          .replace(/<style[\s\S]*?<\/style>/gi, '')
          .replace(/<svg[\s\S]*?<\/svg>/gi, '<svg/>')
          .slice(0, 900);
      }
      let base = nodes[0];
      let best = null;
      for (let i = 0; i < 6 && base && base.parentElement; i += 1) {
        base = base.parentElement;
        if (!base || base === document.body || base.tagName === 'HTML') break;
        best = base;
        // 走到能装下所有候选的那一层（通常就是服务选择弹窗本身）
        if (nodes.every((n) => base.contains(n))) break;
      }
      return compactHtml(best || nodes[0], 900);
    } catch (e) {
      return '';
    }
  }

  function failureDialog() {
    const t = pageText();
    if (!FAIL_RE.test(t)) return null;
    const ack = findClickable(ACK_WORDS);
    if (!ack) return null;
    // 尽量只取弹窗自身容器内的文案，避免把整页文字当成提示内容（日志更干净，也不易误判「已在线」）
    let box = ack;
    for (let i = 0; i < 4 && box && box.parentElement; i += 1) {
      box = box.parentElement;
      const bt = ownText(box, 400);
      if (bt && FAIL_RE.test(bt)) return { ack, text: bt };
    }
    return { ack, text: norm(t).slice(0, 300) };
  }

  /* 「确定 / 确认」按钮是否还露在外面（便宜版：只扫按钮类元素，不做整树遍历）。
   * 它还在，就说明服务选择这一步没走完，绝不能算成功。 */
  function visibleConfirmExists() {
    try {
      const nodes = document.querySelectorAll(
        'button, [role=button], input[type=submit], input[type=button], .el-button, .btn'
      );
      for (const el of nodes) {
        if (!isVisible(el)) continue;
        const t = norm(textOf(el));
        if (CONFIRM_WORDS.some((w) => t === norm(w))) return true;
      }
    } catch (e) {
      /* 忽略 */
    }
    return false;
  }

  /* ============ 「已在线成功页」→ 先下线，再认证 ============
   *
   * 主人报的场景：定时认证到点时，如果上一次认证**还没到期**，门户**不给登录表单**，
   * 而是直接把工作流推到 finish 节点，渲染出「已在线」成功页：
   *
   *   app-login-success（#succ-content / #succ-top / #succ-center / #succ-bottom）
   *   欢迎语「您已成功连接网络！」
   *   底部功能卡片 app-function-links：本机无感认证 / **我要下线** / 自助中心 / 终端信息 …
   *
   * 这一页上**既没有密码框、也不是服务选择页**，所以旧版所有入口都当它「不是我要管的页面」，
   * 脚本一声不吭 —— 表现就是「停在页面上不动，认证也没做，时长也没续上」。
   * 主人要的是：**先下线，再认证**。
   *
   * 门户的真实链路（从 chunk 3769 / 2984 / 4457 / 7243 / 9903 的前端代码 + 语言包 assets/tmp/i18n/zh-CN.json 读出来的）：
   *   ① 点「我要下线」（app-function-links 的 clickFun，functionType === 'logOut'）
   *   ② 弹出确认框（app-modal type=checkOut，标题 i18n 'confirm.log.out'，确定按钮文字 = i18n 'ok'）
   *   ③ 点确定 → loginSuccess 组件收到 'logOut' 信号 → POST /eportal/network/newLogout {sessionId}
   *   ④ 成功后**等 2 秒**再跳（logOutTopage）→ 落到下线成功页 app-account-offline-success / app-sid-success
   *   ⑤ 那一页上的按钮（i18n 'Reconnect.network' = **「重新入网」**）→
   *      window.location.href = localStorage.samPortalRedirectUrl || location.protocol + '//2.2.2.2'
   *      → 网关带着参数把浏览器送回认证页 → 扩展按老流程把认证做完
   *   ⑥ 认不出 / 点不动那个按钮时，**照门户自己的做法跳同一个地址**（jumpToRelogin），
   *      绝不停在页面上什么都不做 —— 主人要的就是「即使没点『重新入网』，认证也要进入网页」。
   *
   * 三处判据都用「门户自己的节点名」为主，文字为辅 —— 文字全是 i18n，不可靠。 */

  /* 便宜版：只做 querySelector，不碰文字。
   * MutationObserver 每 80ms 会调它一次，不能在里面遍历 DOM。 */
  function onlineSuccessNode() {
    try {
      return document.querySelector(
        'app-login-success, app-login-success-phone, app-function-links, #succ-content, #function-cards'
      );
    } catch (e) {
      return null;
    }
  }

  /* 「已下线成功页」。门户里有**两个**版本，节点名不一样，两个都要认：
   *   · app-account-offline-success（chunk 4457 / 7377，注销落地的「下线成功！+重新入网」）
   *   · app-sid-success           （chunk 9903，同一类落地页的另一套皮肤）
   * 只认前者的话，后者在脚本眼里就是一张陌生页面 —— 又是不动。 */
  function offlineSuccessNode() {
    try {
      return document.querySelector('app-account-offline-success, app-sid-success');
    } catch (e) {
      return null;
    }
  }

  /* 找「我要下线」入口。
   * 门户渲染成：<div class="function" (click)="clickFun(link)"><img><span class="fun-name">我要下线</span></div>
   * ⚠ 一定要排除「重新登录 / 重新连接」—— 服务选择页上就有「重新登录」，那是往下走不是下线。 */
  function findLogoutEntry() {
    const blocked = /重新|再次|继续上网|connect\s*again|reconnect|log\s*in\s*again/i;
    const hit = (t) => t && t.length <= 12 && !blocked.test(t) && LOGOUT_WORDS.some((w) => t === norm(w));
    try {
      /* ① 门户自己的功能卡片，最准（.fun-name 就是入口名字） */
      const cards = document.querySelectorAll('#function-cards .function, .function');
      for (const el of cards) {
        if (!isVisible(el)) continue;
        const t = norm(ownText(el, 40));
        if (hit(t)) return el;
      }
      /* ② 退到「短文本可点元素」：后端把文案改了也能认个大概。
       *    只认「最内层」写着这两个字的那个元素，别点到包住整片卡片区的大容器。 */
      const nodes = document.querySelectorAll('a, button, [role=button], li, span, div, .fun-name');
      for (const el of nodes) {
        if (!isVisible(el)) continue;
        const t = norm(ownText(el, 40));
        if (!hit(t)) continue;
        let deeper = false;
        for (const c of Array.from(el.children)) {
          if (hit(norm(ownText(c, 40)))) {
            deeper = true;
            break;
          }
        }
        if (deeper) continue;
        return el;
      }
    } catch (e) {
      /* 忽略 */
    }
    return null;
  }

  /* 「已在线成功页」：门户把我们当成在线用户，但又没在跑认证流程。
   * 三种硬信号任一即可：① 门户的成功页节点 ② 页面上真的有「我要下线」入口 ③ 明确的已在线欢迎语。 */
  function isOnlineSuccessPage() {
    try {
      if (hasPasswordField()) return false;
      if (servicePageUrl()) return false;
      if (onlineSuccessNode()) return true;
      if (findLogoutEntry()) return true;
      return /您已成功连接网络|已成功连接网络|您已在线|已经在线|连接成功，?欢迎/.test(pageText());
    } catch (e) {
      return false;
    }
  }

  /* 「已下线成功页」上的「重新入网」按钮（门户 i18n 'Reconnect.network'）。 */
  function findReloginEntry() {
    const blocked = /我要下线|下线|注销|退出|log\s*out|sign\s*out/i;
    /* 长度上限放到 16：门户里还有「已处理，重新入网」这种更长的按钮文案。 */
    const hit = (t) => t && t.length <= 16 && !blocked.test(t) && RELOGIN_WORDS.some((w) => t === norm(w) || t.includes(norm(w)));
    try {
      const nodes = document.querySelectorAll('a, button, [role=button], .btns, span, div');
      for (const el of nodes) {
        if (!isVisible(el)) continue;
        const t = norm(ownText(el, 40));
        if (!t || !hit(t)) continue;
        let deeper = false;
        for (const c of Array.from(el.children)) {
          if (hit(norm(ownText(c, 40)))) {
            deeper = true;
            break;
          }
        }
        if (deeper) continue;
        return el;
      }
    } catch (e) {
      /* 忽略 */
    }
    return null;
  }

  /* 门户自己的「重新入网」跳到哪里？答案在前端代码里（chunk 7243 / 9903 / 4457 …）：
   *   localStorage.removeItem('firstFlowParam'); sessionStorage.removeItem('previousUrl');
   *   window.location.href = localStorage.getItem('samPortalRedirectUrl') || location.protocol + '//2.2.2.2'
   * 也就是**回到网关探测地址**，由网关带着 sessionId / wlanuserip 等参数把浏览器送到认证页。
   * 我们照抄 —— 这是「即使没点成『重新入网』，认证也要进入网页」的兜底。 */
  function portalReloginTarget() {
    try {
      const v = localStorage.getItem('samPortalRedirectUrl');
      if (v && /^https?:\/\//i.test(v)) return v;
    } catch (e) {
      /* 忽略 */
    }
    return (location.protocol === 'http:' ? 'http:' : 'https:') + '//2.2.2.2';
  }

  function isOfflineSuccessPage() {
    try {
      if (hasPasswordField()) return false;
      if (offlineSuccessNode()) return true;
      /* ⚠ 绝不能只看「页面上有带『重新登录』字样的按钮」——
       * **服务选择页上也挂着「重新登录」**（门户 i18n 键 sign.in.again），
       * 只看文字就会把「选服务」那一页误判成「已下线页」，然后跑去点「重新登录」，
       * 把流程整个带偏（R/S/T/U/V/W 一组场景就是这么被带偏的）。
       * 所以：先排掉流程页（地址像服务选择 / 有服务选项 / 有可见的「确定」按钮），再认文字。 */
      if (servicePageUrl() || onlineSuccessNode() || isServiceSelectionPage()) return false;
      if (/已下线|已注销|注销成功|下线成功/.test(pageText())) return true;
      const btn = findReloginEntry();
      return !!btn && !visibleConfirmExists() && !allOperatorCandidates().some(candidateVisible);
    } catch (e) {
      return false;
    }
  }

  /* 确认弹窗里的「确定」。门户用的是 nz-modal（ant-design），确定按钮文字 = i18n 'ok'。
   * 只在弹窗容器里找，且必须排除「取消 / 关闭」，免得把刚点开的确认框又关掉。 */
  function findModalConfirm() {
    const okRe = /^(确定|确\s*定|确认|是|好的|继续|ok|yes|confirm)$/i;
    const badRe = /取消|关闭|返回|重新|cancel|close|back/i;
    try {
      const boxes = document.querySelectorAll(
        '.ant-modal, .ant-modal-content, .nz-modal, [class*="modal"], [class*="dialog"], app-modal'
      );
      for (const box of boxes) {
        if (!isVisible(box)) continue;
        /** @type {Element[]} */
        let btns = [];
        try {
          btns = Array.from(box.querySelectorAll('button, a, [role=button], .ant-btn, .el-button'));
        } catch (e) {
          btns = [];
        }
        for (const el of btns) {
          if (!isVisible(el) || isDisabled(el)) continue;
          const t = norm(textOf(el));
          if (!t || badRe.test(t)) continue;
          if (okRe.test(t)) return el;
        }
      }
    } catch (e) {
      /* 忽略 */
    }
    // 退到全页找（弹窗容器认不出来时）—— 仍然要避开反向按钮
    return findClickable(['确定', '确认', '是', 'ok'], { enabledOnly: true });
  }

  /* 页面是否「明确」已在线的状态。门槛故意设得很高：
   *   · 还有密码框                       → 没登录（认证页本来就该有密码框）
   *   · 服务选择弹窗还在 / 「确定」还在   → 流程没走完，绝不能算成功
   *   · 页面还挂着「认证失败」            → 失败
   *   · 必须真的出现「认证成功 / 已在线」这类明确字样
   * 「已连接」「注销」这种到处都有的词一概不作数。 */
  function looksConnected() {
    if (hasPasswordField()) return false;
    if (serviceDialog()) return false;
    if (visibleConfirmExists()) return false;
    const t = pageText();
    if (FAIL_RE.test(t)) return false;
    return SUCCESS_RE.test(t);
  }

  /* 连着两次都判定「明确已在线」才算数，躲开门户换视图时那一瞬间的空档。
   * 例外：第二次检查时页面已经跳离原域名——门户只在认证通过后才往外跳，这本身就是成功信号。 */
  async function confirmConnected() {
    if (!looksConnected()) return false;
    const host0 = location.host;
    await sleep(260);
    if (looksConnected()) return true;
    return !!location.host && location.host !== host0;
  }

  function captchaInfo() {
    try {
      const t = (pageText() || '').slice(0, 20000);
      const byText = /(验证码|请输入验证码|captcha|图形码)/i.test(t);
      const byImg = Array.from(document.images).some((i) => /(captcha|verify|checkcode)/i.test(i.src || ''));
      return byText || byImg;
    } catch (e) {
      return false;
    }
  }

  function report(payload) {
    try {
      chrome.runtime.sendMessage(Object.assign({ type: 'FILL_RESULT', url: location.href }, payload), () => void chrome.runtime.lastError);
    } catch (e) {
      /* 忽略 */
    }
  }

  /* ---------------- 主流程 ---------------- */

  async function runFlow(payload) {
    const p = payload || {};
    const operator = OPERATORS.includes(norm(p.operator)) ? norm(p.operator) : OPERATORS[0];
    const deadline = Date.now() + FLOW_TIMEOUT_MS;
    const startHost = location.host;
    const log = [];
    let attempts = 0; // 本轮真正点过几次「登录」，上限 MAX_SUBMIT
    let confirmed = 0; // 点过几次「确定」（首次 + 失败重试）
    let acked = 0; // 点掉几次「我知道了」
    let finished = false;
    let lastDiag = ''; // 卡住时的页面快照，随失败结论一起回报
    let lastDiagHtml = ''; // 卡住时那一块的原始 HTML（供定位门户结构）
    let submitUrl = ''; // 点「确定」那一刻的地址，用来判断「是不是已经跳走了」

    const budget = (ms) => Math.max(0, Math.min(ms, deadline - Date.now()));

    /* 卡住时记一笔现场：摘要 + 原始 HTML 一起带走 */
    const markStuck = () => {
      lastDiag = diagSummary();
      lastDiagHtml = dialogHtml();
      return lastDiag;
    };

    const finish = (status, note) => {
      const full = status === 'failed' && lastDiag && !String(note).includes('页面：') ? note + '｜页面：' + lastDiag : note;
      if (!finished) {
        finished = true;
        report({
          result: {
            ok: status === 'success',
            status,
            note: full,
            diag: lastDiag || '',
            diagHtml: status === 'failed' ? lastDiagHtml : '',
            captcha: captchaInfo(),
            final: true,
            submitted: attempts,
            confirmed,
            failures: acked,
            log: log.slice(-8)
          }
        });
      }
      return { ok: status === 'success', status, note: full, log };
    };

    /* 判定成功时顺手点掉可能还挂着的成功提示弹窗，别让页面留个框 */
    const successExit = (note) => {
      try {
        const ack = findClickable(ACK_WORDS);
        if (ack) clickLike(ack);
      } catch (e) {
        /* 忽略 */
      }
      return finish('success', note);
    };

    /* relogin=true 是给后台看的标记：这一段在跑「已在线 → 先下线再认证」，网络本来就是通的，
     * 后台这段时间不能拿 204 探测去收尾（否则会在半路把下线/重新认证打断）。 */
    const progress = (note, expectResultIn, relogin) => {
      if (finished) return;
      const r = { ok: true, status: 'running', note };
      if (expectResultIn) r.expectResultIn = expectResultIn;
      if (relogin) r.relogin = true;
      report({ result: r });
    };

    /* ---------------- 「跳转到最终界面」判据 ----------------
     *
     * 主人这轮的要求：认证时**只要跳转到最终界面就算完成**（省时间，别让关页面和通知拖到最后）。
     *
     * 为什么这条判据靠得住 —— 门户的业务代码（ServiceSelectionModule.submitForm）是：
     *     serviceLogin({sessionId, service}) → code===200 && data.authResult==='success'
     *       → localStorage.setItem('service', …) → getActionNextPageForPortal() → nextPath()   ← 跳走
     *   失败时它只调 modalService.warning 弹一个提示，**地址一动不动**。
     * 所以「点过确定 + 地址真的变了 + 页面上再没有流程 UI」＝ 门户已经把我们推到下一节点。
     *
     * ⚠ 特意**不用** isServiceSelectionPage() 做判据：那个函数里有「页面文字包含『选择服务』」
     *   这种松判定，落地页上写一句「已选择服务：中国电信」就会把它误判成「还停在选服务页」。
     *   这里只要硬信号：地址、密码框、可见的确定按钮 + 可见的服务选项。
     *
     * ⚠ 结论文案里**不带落地网址**：弹窗就那么宽，`host+pathname` 一长串会把那行挤到溢出
     *   （主人反馈过）。「已跳转到完成界面」这一句本身就够了。 */

    const leftSubmitPage = () => {
      if (!submitUrl) return false; // 还没点过「确定」，谈不上跳走
      let now = '';
      try {
        now = location.href;
      } catch (e) {
        return false;
      }
      if (now === submitUrl) return false; // 还停在提交那一页
      if (hasPasswordField()) return false; // 又被送回登录页 → 没成
      if (servicePageUrl()) return false; // 地址还是「选服务」这一页
      if (visibleConfirmExists() && allOperatorCandidates().some(candidateVisible)) return false; // 服务选项还在
      if (FAIL_RE.test(pageText())) return false; // 新页面上写着「认证失败」→ 没成
      return true;
    };

    /* 下线之后门户常常在**同一页**里切回认证视图（SPA 路由切换，脚本不会重新注入），
     * 这时必须让页面自己再启一轮把认证做完 —— 否则又是一次「界面不动」。 */
    const restartFlowSoon = () => {
      setTimeout(() => {
        try {
          flowRunning = false;
          selfStarted = false;
          selfStartedService = false;
        } catch (e) {
          /* 忽略 */
        }
        try {
          trySelfStart();
        } catch (e) {
          /* 忽略 */
        }
      }, 300);
    };

    /* 「没点到『重新入网』也要进入网页」的兜底：
     * 照门户自己的做法跳到 samPortalRedirectUrl（没有就 protocol//2.2.2.2）——
     * 网关会带着 sessionId 等参数把浏览器送到认证页，认证流程接着往下走。
     * 用 sessionStorage 做**打转守卫**：20 秒内只跳一次，免得「跳过去又被弹回已下线页」
     * 变成无限循环（那比不动更糟）。 */
    const JUMP_GUARD_KEY = 'cnlReloginJump';
    function jumpToRelogin(reason) {
      let last = 0;
      try {
        last = Number((JSON.parse(sessionStorage.getItem(JUMP_GUARD_KEY) || '{}') || {}).at) || 0;
      } catch (e) {
        last = 0;
      }
      if (Date.now() - last < 20000) return false; // 刚跳过一次，不重复跳
      const url = portalReloginTarget();
      try {
        sessionStorage.setItem(
          JUMP_GUARD_KEY,
          JSON.stringify({ at: Date.now(), url: url, reason: reason })
        );
      } catch (e) {
        /* 忽略 */
      }
      log.push('没有可点的「重新入网」，直接跳门户的重新入网地址：' + url + '（' + reason + '）');
      try {
        location.href = url;
      } catch (e) {
        return false;
      }
      return true;
    }

    /* 已经在下线成功页上（门户自己下线完、或我们下线完落在这里）：
     * 点它的「重新入网」把认证入口叫回来；点不到就直接跳到门户的重新入网地址。 */
    async function reconnectFromOfflinePage() {
      const url0 = location.href;
      const btn = await waitUntil(() => findReloginEntry(), budget(W_RELOGIN), STEP);
      if (!btn) {
        if (jumpToRelogin('页面上找不到「重新入网」按钮')) {
          return {
            ok: true,
            status: 'running',
            note: '已下线但没找到「重新入网」按钮，已按门户的方式直接跳转回认证入口，等待认证页…',
            log
          };
        }
        markStuck();
        return finish('failed', '停在下线成功页：找不到「重新入网」按钮，跳转兜底也没成功（可能刚跳过一次，避免打转）');
      }
      clickLike(btn);
      log.push('点击「重新入网」');
      progress('已下线，正在返回认证页…', 0, true);
      const back = await waitUntil(
        () =>
          hasPasswordField()
            ? { pw: true }
            : isServiceSelectionPage()
              ? { svc: true }
              : location.href !== url0
                ? { gone: true }
                : null,
        budget(W_LOGOUT_JUMP),
        STEP
      );
      if (back && (back.pw || back.svc)) {
        restartFlowSoon();
        return { ok: true, status: 'running', note: '已下线，正在重新认证…', log };
      }
      if (back && back.gone) {
        return { ok: true, status: 'running', note: '已下线，门户已跳转，等待新页面继续认证…', log };
      }
      /* 点了没反应（门户的注销/跳转请求失败、或按钮被禁用）：照样给一次跳转兜底 */
      if (jumpToRelogin('点了「重新入网」但页面没有回认证页')) {
        return {
          ok: true,
          status: 'running',
          note: '点了「重新入网」但页面没动，已直接跳转回认证入口，等待认证页…',
          log
        };
      }
      markStuck();
      return finish('failed', '点了「重新入网」但页面没有回到认证页');
    }

    /* 「已在线」页面的处置：点「我要下线」→ 确认 → 等门户注销并跳走 → 回来接着认证。
     * 这是主人这轮明确要的：认证没到期时也要**先下线再认证**，别停在页面上什么都不做。 */
    async function logoutThenRelogin(allowRelogin) {
      /* 页面已经是「已下线成功页」的话就不用再下线一次了（门户自己先下线了，或上一轮已点过） */
      if (!findLogoutEntry() && isOfflineSuccessPage()) return await reconnectFromOfflinePage();
      if (allowRelogin === false) {
        return finish('skipped', '页面显示已连接，无需登录（本次不下线重认证）');
      }
      /* 先给后台打一个「正在下线重认证」的标记：这一段网络本来就是通的（认证还没到期），
       * 后台不能拿 204 探测去判「已完成」，否则会在半路收尾、把下线流程打断。 */
      progress('检测到已在线（认证未到期），正在先下线再重新认证…', 0, true);
      const url0 = location.href;
      const entry = await waitUntil(() => findLogoutEntry(), budget(W_LOGOUT_ENTRY), STEP);
      if (!entry) {
        markStuck();
        return finish(
          'failed',
          '页面显示「已在线」，但找不到「我要下线」入口 —— 点一下弹窗里的诊断发过来，或在设置里关掉「已在线时先下线再认证」'
        );
      }
      clickLike(entry);
      log.push('点击「我要下线」');
      progress('检测到已在线（认证未到期），已点击「我要下线」，等待确认…', 0, true);

      // 确认弹窗（app-modal / nz-modal，确定按钮文字是 i18n 的 'ok'）
      const ok = await waitUntil(() => findModalConfirm(), budget(W_LOGOUT_CONFIRM), STEP);
      if (ok) {
        clickLike(ok);
        log.push('确认下线');
        progress('已确认下线，等待门户注销并回到认证页…', 0, true);
      } else {
        log.push('没等到确认弹窗（门户可能不需要二次确认）');
      }

      /* 门户的真实节奏：POST /eportal/network/newLogout 成功后**再等 2 秒**才跳，
       * 所以这里给足 9 秒。三种落地都要接住：
       *   · 回到认证页（有密码框）        → 页面自己重启一轮，把认证做完
       *   · 回到服务选择页                → 同上（脚本会走「选服务」那条支路）
       *   · 落到「已下线成功页」          → 点它的「重新入网」把认证入口叫回来
       *   · 整页跳到别处                  → 本页脚本马上被销毁，新页面脚本接手 */
      const back = await waitUntil(
        () => {
          if (hasPasswordField()) return { pw: true };
          if (isServiceSelectionPage()) return { svc: true };
          if (findReloginEntry()) return { relogin: true };
          if (isOfflineSuccessPage()) return { offline: true };
          if (location.href !== url0) return { gone: true };
          return null;
        },
        budget(W_LOGOUT_JUMP),
        STEP
      );

      if (back && (back.relogin || back.offline)) {
        const btn = findReloginEntry();
        if (btn) {
          clickLike(btn);
          log.push('点击「重新入网」');
          progress('已下线，正在返回认证页…', 0, true);
          await waitUntil(
            () => hasPasswordField() || isServiceSelectionPage() || location.href !== url0,
            budget(W_RELOGIN),
            STEP
          );
        } else if (jumpToRelogin('已下线页上没有可点的「重新入网」')) {
          return {
            ok: true,
            status: 'running',
            note: '已下线但没找到「重新入网」按钮，已按门户的方式直接跳转回认证入口，等待认证页…',
            log
          };
        }
      }

      if (hasPasswordField() || isServiceSelectionPage()) {
        restartFlowSoon();
        return { ok: true, status: 'running', note: '已下线，正在重新认证…', log };
      }
      if (location.href !== url0) {
        return { ok: true, status: 'running', note: '已下线，门户已跳转，等待新页面继续认证…', log };
      }
      /* 还停在原地（注销后门户没跳、或跳回来了）：不认输，直接照门户的方式跳一次 */
      if (jumpToRelogin('注销后页面没有回到认证页')) {
        return {
          ok: true,
          status: 'running',
          note: '已下线但页面没回认证页，已直接跳转回认证入口，等待认证页…',
          log
        };
      }
      markStuck();
      return finish('failed', '点了「我要下线」但页面没有回到认证页（注销请求可能失败，或门户结构变了）');
    }

    // 0) 判断从哪一步进场：
    //    · 有密码框                    → 走完整流程（填账号密码 → 立即登录 → 选服务 → 确定）
    //    · 没有密码框，但这是服务选择页 → **直接从「选服务」开始**
    //      门户把服务选择做成了独立路由（entry/pc/serviceSelection），点完「立即登录」
    //      整页跳过去，新页面里根本没有密码框。旧版所有入口都以「有密码框」为前提，
    //      到了这一页脚本什么都不做 —— 主人看到的正是「服务选择页还是没有自动选择」。
    //    · 没有密码框，却是「已在线成功页」→ **先下线，再认证**（见上面 logoutThenRelogin）
    /* ⚠ 顺序：先认「已在线 / 已下线」，再认「服务选择」——
     * 已在线页的功能卡片里就有一项叫「选择服务」，反过来判会走错路。 */
    let enterAtOnline = !hasPasswordField() && isOnlineSuccessPage();
    let enterAtService = !enterAtOnline && !!p.serviceOnly;
    if (!enterAtService && !enterAtOnline && !hasPasswordField()) {
      const got = await waitUntil(
        () =>
          hasPasswordField()
            ? { pw: true }
            : isOnlineSuccessPage()
              ? { online: true }
              : isOfflineSuccessPage()
                ? { offline: true }
                : isServiceSelectionPage()
                  ? { svc: true }
                  : null,
        budget(W_PASSWORD),
        STEP
      );
      if (got && got.svc) enterAtService = true;
      if (got && (got.online || got.offline)) enterAtOnline = true;
    }
    /* 「已在线」这一条要排在 confirmConnected 前面 —— 否则「您已成功连接网络」会被
     * SUCCESS_RE 认成「刚认证成功」，直接 skipped 收尾，下线续期就永远不会发生。 */
    if (enterAtOnline) {
      /* ⭐ 允许「先下线再认证」的三种情况，其余一律安静收手：
       *   1) 指令里明确带了 allowRelogin（调用方说了算）；
       *   2) 后台自己发起的续期流程（renew:true）且设置里那个开关开着；
       *   3) 页面自称「已在线」，但**探测确认网关正在拦**（netOffline）——
       *      这时页面是缓存/在说谎，设备本来就没网，下线重认证是**恢复**网络，
       *      不会下掉主人正在用的连接。
       *
       * ⚠ 主人手动打开认证页走的自启动，默认落到 else：**不下线**。
       * 门户常常先渲染登录表单、提交之后才显示「已在线」，旧版在这一步按配置默认 true，
       * 就把主人正在用的网络当场下线了 —— 这就是「主动打开还是会下线」的根因。 */
      let allow = p.allowRelogin;
      if (allow === undefined) {
        allow = p.renew === true ? await reloginSwitchOn() : p.netOffline === true;
      }
      return await logoutThenRelogin(allow);
    }
    if (await confirmConnected()) return finish('skipped', '页面显示已连接，无需登录');
    if (!hasPasswordField() && !enterAtService) {
      // 既没有登录表单，也不是服务选择页：**不回报任何结论**。后台是往整个标签页广播指令的，
      // 页面里每个框架都会收到一份；没有表单的框架（空白子框架、跳转中转页）如果回报一句
      // 「没有密码输入框」，就会变成一条「认证失败」，把真正那个框架正在跑的流程盖掉。
      // 定论交给后台的兜底核查（按真实网络状态判断）。
      return { ok: false, status: 'noform', note: '当前框架没有登录表单', log };
    }

    let dlg = null;
    if (enterAtService) {
      // 服务选择独立页：等选项渲染出来（SPA 常常跳到这一页后才去拉服务列表）
      progress('已进入服务选择页，自动选中「' + operator + '」…', 3);
      const s = await waitUntil(
        () => {
          const sd = serviceDialog();
          if (sd) return { svc: sd };
          const raw = allOperatorCandidates();
          if (raw.length) return { svc: { all: raw, names: [] } };
          if (looksConnected()) return { ok: true };
          return null;
        },
        budget(W_SERVICE_PAGE),
        STEP
      );
      if (s && s.ok) {
        if (await confirmConnected()) return successExit('页面出现连接成功标识');
        dlg = { svc: { all: [], names: [] } };
      } else if (s && s.svc) {
        dlg = { svc: s.svc };
      } else {
        // 认不出来也要往下走一次：选服务那一步会做「整页粗搜」，并把页面骨架带回去
        markStuck();
        dlg = { svc: { all: [], names: [] } };
      }
    } else {
      // 1) 填账号密码
      const passEl = findPassword(p.selectors && p.selectors.password);
      const userEl = findUsername(p.selectors && p.selectors.username);
      if (!passEl || !userEl) return finish('failed', '找不到账号/密码输入框');

      await sleep(T_PRE);
      setValue(userEl, p.username || '');
      setValue(passEl, p.password || '');
      log.push('已填写账号密码');

      // 登录按钮常因框架校验而初始禁用：轮询等它变为可用（一般几十毫秒）
      const loginBtn = await waitUntil(
        () => findClickable(LOGIN_WORDS, { enabledOnly: true }) || findClickable(['登录'], { enabledOnly: true }),
        budget(W_BUTTON),
        STEP
      );
      attempts = 1;
      if (loginBtn) {
        clickLike(loginBtn);
        log.push('提交账号密码');
        progress('已填写账号密码并点击登录，等待服务选择…', 3);
      } else {
        log.push('未找到登录按钮');
        try {
          if (passEl.form && typeof passEl.form.requestSubmit === 'function') passEl.form.requestSubmit();
        } catch (e) {
          /* 忽略 */
        }
        progress('已填写账号密码并提交表单，等待服务选择…', 3);
      }

      // 2) 等「服务选择」——可能是同一页弹出的弹窗，也可能是整页跳转过去的新页面
      //    （后者会把本页脚本销毁，接手的是新页面里的脚本自己）
      dlg = await waitUntil(
        () => {
          const d = failureDialog();
          if (d) return { fail: d };
          const svc = serviceDialog();
          if (svc) return { svc };
          if (looksConnected()) return { ok: true };
          return null;
        },
        budget(W_SERVICE),
        STEP
      );

      if (dlg && dlg.ok) {
        if (await confirmConnected()) return successExit('页面出现连接成功标识');
        dlg = null; // 只是闪了一下，当作没出现，继续往下等
      }
      if (!dlg) {
        if (await confirmConnected()) return successExit('页面出现连接成功标识');
        markStuck();
        return finish('failed', '点击登录后没有出现服务选择，可能账号密码有误，或页面结构变了');
      }
    }

    // 3) 选服务商 → 确定 → 看结果；失败就「我知道了 → 重新选服务 → 再点确定」
    for (let round = 1; round <= MAX_RETRY + 1 && Date.now() < deadline; round += 1) {
      // 3a) 上一轮是失败提示：点「我知道了」，然后直接再点「确定」
      if (dlg && dlg.fail) {
        const d = dlg.fail;
        if (ALREADY_ONLINE_RE.test(d.text)) return finish('success', '账号已在线（门户提示重复登录）');
        if (acked >= MAX_RETRY) {
          return finish(
            'failed',
            '已重试 ' + acked + ' 轮仍未成功（门户共 ' + (acked + 1) + ' 次报认证失败），停止：' + norm(d.text).slice(0, 120)
          );
        }
        clickLike(d.ack);
        acked += 1;
        log.push('关闭失败提示');
        progress('出现认证失败提示，已点击「我知道了」，马上重新点「确定」重试（第 ' + acked + '/' + MAX_RETRY + ' 轮）…');
        // 等提示消失，通常几十毫秒
        await waitUntil(() => !failureDialog(), budget(W_ACK_GONE), STEP);
      }

      if (await confirmConnected()) return successExit('页面出现连接成功标识');

      // 3b) 选运营商：能点的都点一遍（radio / label / 文本元素 / 逐层祖先容器），
      //     任一时刻「页面标记为已选」或「确定按钮变亮」就算成事
      const pick = await selectOperator(operator);
      if (pick.ok) {
        log.push((round === 1 ? '选择服务 ' : '重新选择服务 ') + pick.name + '(' + pick.kind + ')');
      } else {
        markStuck();
        log.push('选服务失败：' + pick.reason);
        // 连运营商都没选中，再点「确定」只是白提交一次 —— 停在这里并把页面现场带回去
        break;
      }
      await sleep(T_PICK);

      // 3c) 点「确定」——按钮可能处于加载禁用态，轮询等它可用；按文本找不到时退到弹窗容器里找
      if (confirmed >= MAX_CONFIRM) break;
      const cands = allOperatorCandidates().filter((c) => c.name === pick.name);
      const btn = await waitUntil(
        () => {
          const b = findConfirmButton(cands);
          return b && !isDisabled(b) ? b : null;
        },
        budget(W_BUTTON),
        STEP
      );
      if (!btn) {
        if (await confirmConnected()) return successExit('页面出现连接成功标识');
        markStuck();
        log.push('找不到可用的「确定」按钮');
        break;
      }
      submitUrl = location.href; // 记下提交时的地址：之后只要地址变干净地跳走，就是「到了最终界面」
      clickLike(btn);
      confirmed += 1;
      log.push(round === 1 ? '点击确定提交' : '点击确定重试');
      progress('已选择「' + operator + '」并提交（第 ' + confirmed + ' 次），等待认证结果…', 3);

      // 3d) 等结果：失败提示 / 成功标识 / 跳转到最终界面
      dlg = await waitUntil(
        () => {
          const d = failureDialog();
          if (d) return { fail: d };
          if (looksConnected()) return { ok: true };
          if (leftSubmitPage()) return { gone: true };
          if (location.host && location.host !== startHost) return { ok: true };
          return null;
        },
        budget(W_OUTCOME),
        STEP
      );

      /* 已经跳转到最终界面 ⇒ 立刻算完成。
       * 这一条比「出现成功字样」宽松（不是每个门户都会写「认证成功」四个字），
       * 但比旧版那个「弹窗消失就算成功」严得多 —— 它要求地址**真的变了**。 */
      if (dlg && dlg.gone) return successExit('已跳转到完成界面');

      if (dlg && dlg.ok) {
        if (await confirmConnected()) return successExit('页面出现连接成功标识');
        dlg = null;
      }

      if (!dlg) {
        /* 没报错、也没报成功：只能算「看着像成功」。
         * ⚠ 这里**不能**直接收尾 —— 旧版就在这一步判成功，于是运营商没真正选中、
         * 弹窗只是被重渲染抹掉的那一瞬间，就被误判成成功、关页面。
         * 现在返回 probable，交给后台用「可信网络探测」定论：只有探测确认 204 才算成功。 */
        // 恰好在超时那一瞬间跳走的：再确认一次，别把「已完成」拖成「待确认」
        if (leftSubmitPage()) return successExit('已跳转到完成界面');
        const quiet = await waitUntil(
          () => (!failureDialog() && !serviceDialog() && !visibleConfirmExists() && !hasPasswordField() ? true : null),
          budget(W_QUIET),
          200
        );
        if (quiet) {
          return finish('probable', '提交后页面不再报错（但没出现成功字样），等待网络探测确认');
        }

        const failNow = failureDialog();
        if (failNow) {
          dlg = { fail: failNow };
          continue;
        }
        // 「确定」点了但弹窗纹丝不动：多半是运营商没被真正选中，重来一轮
        const stillDlg = serviceDialog();
        if (stillDlg && confirmed < MAX_CONFIRM && round <= MAX_RETRY) {
          log.push('确定未生效，重新选择运营商后重试');
          dlg = { svc: stillDlg };
          continue;
        }
        break;
      }
    }

    if (leftSubmitPage()) return successExit('已跳转到完成界面');
    if (await confirmConnected()) return successExit('页面出现连接成功标识');
    return finish(
      'failed',
      '已提交 ' + attempts + ' 次账号密码、点「确定」' + confirmed + ' 次仍未成功，最近步骤：' + (log.slice(-3).join(' → ') || '无')
    );
  }

  /* 设置里「已在线时先下线再认证」开着吗？
   * 读不到设置就当作**关** —— 宁可不下线：网络的连续性比续期更重要。 */
  async function reloginSwitchOn() {
    try {
      const box = await chrome.storage.local.get('config');
      return (box.config || {}).reloginWhenOnline !== false;
    } catch (e) {
      return false;
    }
  }

  /* ---------------- 页面自己动手（不再等后台催） ---------------- */

  async function loadCtx() {
    try {
      const box = await chrome.storage.local.get(['config', 'state']);
      return { cfg: box.config || {}, st: box.state || {} };
    } catch (e) {
      return { cfg: {}, st: {} };
    }
  }

  /* 问后台「现在到底有没有网」—— 这是判断「认证还在不在有效期」最省的一条路：
   * 一个 HTTP 往返（约 0.1~0.3 秒），不开页、不注入、不轮询。
   *
   * ⚠ 为什么不在页面里自己 fetch 探测点：内容脚本跑在页面的 origin 下，跨域请求受 CORS 约束，
   * 状态码和正文都读不到 —— 探测点回的是 204 还是网关塞的拦截页，根本分不出来。
   * 后台有 host_permissions，fetch 不受 CORS 限制，所以探测一律交给它做。
   *
   * ttlMs 内重复问会直接复用上一次结果：SPA 门户一次导航会触发好几轮 DOM 变化，
   * 不缓存的话同一页要白探好几次。 */
  let netProbeCache = { at: 0, r: null };
  function probeNetwork(ttlMs) {
    const ttl = ttlMs === undefined ? 3000 : ttlMs;
    const now = Date.now();
    if (netProbeCache.r && now - netProbeCache.at < ttl) return Promise.resolve(netProbeCache.r);
    return new Promise((resolve) => {
      let done = false;
      let timer = null;
      const finish = (r) => {
        if (done) return;
        done = true;
        if (timer) clearTimeout(timer);
        if (r && !r.unknown) netProbeCache = { at: Date.now(), r };
        resolve(r || null);
      };
      try {
        chrome.runtime.sendMessage({ type: 'PROBE_NOW' }, (r) => {
          void chrome.runtime.lastError;
          finish(r);
        });
      } catch (e) {
        finish(null);
      }
      // 后台没应答（被系统回收等）不能让页面干等 —— 超时就当「问不出来」，
      // 上层会按「探不通」处理，照旧走完整流程，不会因为探测失败就不认证。
      timer = setTimeout(() => finish(null), 5000);
      if (done) clearTimeout(timer); // 同步回调已经答过了，别留悬挂计时器
    });
  }

  /* 密码只允许填在「确认是校园网门户」的页面上：
   *   1) 与设置里填的认证页 / 自动发现到的门户同源，或
   *   2) 内网 IP / .edu.cn 域名，且页面内容确实像认证门户（有账号、密码、认证等字样）
   * 普通网站（邮箱、银行）既不同源也不是 .edu.cn，绝不会被填。 */
  function hostAllowed(cfg, st) {
    try {
      /* ⚠ 主人填的排除域名优先级最高：排在服务选择页 / 已在线页那些「直接放行」之前，
       * 这样即使某个校内业务站点的页面结构碰巧长得像门户，也绝不会被碰。 */
      if (hostExcluded(location.hostname, cfg)) return false;
      /* ⚠ 服务选择页只可能出现在校园网门户里，直接放行。
       * 为什么必须单独开这一条：这一页上常常**只有**「选择服务 / 中国电信 / 中国移动 / 中国联通 /
       * 重新登录 / 确定」这几个字，一个「校园网 / 账号 / 密码 / 认证」都没有 ——
       * 下面的文本特征判定认不出来，就把这一页挡在门外；被挡在门外的表现正是
       * 「停在选择服务页、扩展一声不吭、界面不动」。
       * 而这一页既然已经出现在 http(s) 里，就不可能是一般的邮箱/银行页面（它们不会有服务选择视图）。 */
      if (document.querySelector('app-service-selection, app-serviceSelection, [class*="service-selection"], #relationInfo')) {
        return true;
      }
      if (isServiceSelectionPage()) return true;
      /* 门户的「已在线 / 已下线」页同样只可能出现在校园网门户里，直接放行 ——
       * 它们的文字里可能一个「校园网 / 认证」都没有（只有「我要下线 / 重新入网」）。 */
      if (onlineSuccessNode() || offlineSuccessNode() || isOnlineSuccessPage() || isOfflineSuccessPage()) {
        return true;
      }

      const origin = new URL(location.href).origin;
      const refs = [cfg.portalUrl, cfg.portalCandidate, st.portalCandidate].concat(st.portalHosts || []);
      for (const u of refs) {
        if (!u) continue;
        try {
          if (new URL(u).origin === origin) return true;
        } catch (e) {
          /* 继续 */
        }
      }
      const host = location.hostname;
      const text = pageText();
      /* 校内业务系统：出现这些词就**一定不是**校园网认证页（教务系统就是这么被认出来的） */
      if (BUSINESS_EXCLUDE_RE.test(text)) return false;
      /* 网关页（内网 IP）通常很朴素，弱特征即可 */
      if (PRIVATE_HOST_RE.test(host)) return PORTAL_HINT_RE.test(text);
      if (!EDU_HOST_RE.test(host)) return false;
      /* 其余 .edu.cn（不是设置里那个门户、也不是自动发现到的门户）：
       * 必须命中**门户专属**的强特征 —— 教务系统这类只有「用户名 / 密码 / 登录」，到此为止。 */
      return PORTAL_STRONG_RE.test(text);
    } catch (e) {
      return false;
    }
  }

  /* 门禁（开关关了 / 暂停 / 没填密码 / 站点不在允许范围）把页面挡在门外时的**静默**，
   * 是这几轮最难查的地方：页面明明停在「选择服务」上，扩展却一声不吭 —— 看起来就是「界面不动」。
   * 现在只要是服务选择页，就算因为门禁不动作，也把原因报一条上去（每个页面只报一次）。
   * ⚠ 故意**不带 final**：这条只是解释，不是结论 —— 免得把正在跑的流程状态盖掉、
   *   也免得后台把它当成一次「认证失败」去收尾。 */
  let skipExplained = false;
  function explainServiceSkip(reason, where) {
    if (skipExplained) return;
    skipExplained = true;
    report({
      result: {
        ok: true,
        status: 'running',
        note: '停在「' + (where || '选择服务') + '」页面但扩展没有操作：' + reason,
        by: 'page'
      }
    });
  }

  /* 页面内的最快路径：读到配置后立刻开跑，省掉「上报 → 后台 → 注入 → 下发」整圈往返。
   *
   * 两种进场情况都要能启动：
   *   · 登录页（有密码框）        → 完整流程
   *   · 服务选择独立页（无密码框）→ 只做「选服务 + 确定」
   * 旧版只认前一种，于是跳到 serviceSelection 那一页后脚本什么都不做。 */
  async function trySelfStart() {
    if (flowRunning) return false;
    const hasPw = hasPasswordField();
    /* 无密码框时有三种页面要管，它们共用同一个「这一页已经动过手」标志 ——
     * 一次导航只会落在其中一种上：
     *   · 服务选择独立页（serviceSelection）
     *   · 已在线成功页（认证还没到期，门户直接给成功页）→ 先下线再认证
     *   · 已下线成功页（注销完的落地页）              → 点「重新入网」回认证页；点不到就跳到门户的重新入网地址 */
    let role = '';
    if (hasPw) {
      if (selfStarted) return false;
      role = 'login';
    } else {
      if (selfStartedService) return false;
      /* 顺序有讲究：先认「已在线 / 已下线」再认「服务选择」。
       * 已在线页上的功能卡片里有一项就叫「选择服务」，反过来判会被它骗到服务选择那条路上。 */
      if (isOnlineSuccessPage()) role = 'online';
      else if (isOfflineSuccessPage()) role = 'offline';
      else if (isServiceSelectionPage()) role = 'service';
      else return false;
    }
    const onService = role === 'service';
    const where = role === 'service' ? '选择服务' : role === 'online' ? '已在线' : '已下线';

    const { cfg, st } = await loadCtx();
    if (cfg.enabled === false || st.paused) {
      if (!hasPw) explainServiceSkip('扩展被关掉了「自动登录」或当前处于暂停状态', where);
      return false;
    }
    if (cfg.autoLoginOnPortalPage === false) {
      if (!hasPw) explainServiceSkip('设置里关掉了「进认证页自动填写」', where);
      return false;
    }
    if (!hostAllowed(cfg, st)) {
      if (!hasPw) explainServiceSkip('当前站点不在允许自动操作的范围内（可在设置里填一下认证页地址）', where);
      return false;
    }
    /* ⭐ 「已在线」页先用网络探测确认一次，再决定动不动手 —— 主人这轮明确要的：
     *
     *   手动打开认证页时，如果认证其实**还没到期**，扩展就不该动手。旧版在这一页固定走
     *   「先下线再认证」，于是主人一打开网页就被下线、还常常认证不回来。
     *   现在改成：探到真的有网（高置信度）就**什么都不做**，立刻收手；
     *   探不通 / 说不清 / 只是「疑似」→ 照旧往下走，让流程去处理，绝不因为探测失败就不认证。
     *
     * 只有这一页需要探：有密码框那一页不用探 —— 网关把你拦到登录页本身就说明没网了，
     * 再花一次往返纯属浪费（这也是最省的做法）；服务选择 / 已下线页各有自己的判断，不掺和。 */
    let netOffline = false;
    if (role === 'online') {
      const net = await probeNetwork();
      if (net && net.online && net.confidence === 'high') {
        /* 标记「这一页我管过了」：MutationObserver 会因为 DOM 变化反复来问，不标记就要反复探。 */
        selfStartedService = true;
        return false;
      }
      /* 探测**明确**说「被网关拦着」＝ 这张「已在线」页面是缓存/说谎，设备其实没网。
       * 那就允许走「下线重认证」把网络恢复回来（见 runFlow 的 enterAtOnline 分支）。
       * ⚠ 只有 captive（网关确实在拦你）才算数：unsure（检测点被学校屏蔽）绝不能当下线的理由。 */
      netOffline = !!(net && net.online === false && net.captive === true);
    }
    if (!hasPw) {
      // 无密码框的这三种页：密码在上一页已经提交过了（或根本不需要），这里不要求填过密码；
      // 也**不套用下面那条「8 秒让位」规则** —— 后台只在登录页下发过一次指令，
      // 不会跟着跳到这一页再下发，所以必须页面自己动手，否则就没人管了。
      // ⚠ 运营商**没配**也照样动手（退到默认「中国电信」）：
      //   上一版在这里直接 return false，于是「停在选择服务页、一声不吭、界面不动」。
      selfStartedService = true;
    } else {
      if (!cfg.username || !cfg.password) return false;
      // 后台刚刚（8 秒内）才开的流程有它自己的一份，页面先让一下，避免同一页跑两遍；
      // 超过 8 秒还没动静说明它卡住了，页面直接接管。
      const f = st.flow;
      if (f && f.status === 'running' && Date.now() - (f.startedAt || 0) < 8000) return false;
      selfStarted = true;
    }

    const note =
      role === 'service'
        ? '检测到服务选择页，页面内立即自动选择…'
        : role === 'online'
          ? '检测到已在线页面，正在核对是否需要续期…'
          : role === 'offline'
            ? '检测到已下线页面，正在返回认证页…'
            : '检测到认证页，页面内立即自动填写…';

    flowRunning = true;
    report({ result: { ok: true, status: 'running', note, by: 'page' } });
    runFlow({
      username: cfg.username,
      password: cfg.password,
      operator: cfg.operator || OPERATORS[0],
      selectors: cfg.selectors,
      serviceOnly: onService,
      /* ⚠ 页面自启动**永远不下线重认证**（renew: false）—— 续期只由后台那份指令发起。
       * 以前这里传的是 `allowRelogin: 设置开关`，于是主人一打开认证页、页面自己跑到「已在线」
       * 就把正在用的网络下线了 —— 主人反馈的「主动打开还是会下线」就是这么来的。
       * netOffline 是上面那次探测的结论：网关确实在拦时，页面这张「已在线」是假的，
       * 允许重认证把网络恢复回来。 */
      renew: false,
      netOffline
    })
      .catch((e) => {
        report({ result: { ok: false, status: 'failed', note: '流程异常：' + ((e && e.message) || e), final: true } });
      })
      .finally(() => {
        flowRunning = false;
      });
    return true;
  }

  /* ---------------- 自动发现认证页 ---------------- */

  function watchForPortal() {
    let reported = false;
    let busy = false;
    let pending = false;
    let stopped = false;
    let probes = 0;
    let observer = null;

    const stop = () => {
      stopped = true;
      if (observer) {
        try {
          observer.disconnect();
        } catch (e) {
          /* 忽略 */
        }
        observer = null;
      }
    };

    const probe = async () => {
      probes += 1;
      if (busy || stopped || flowRunning) return;
      // 最便宜的一层挡板：既没有 password 输入框、地址也不像服务选择页、
      // 也不是门户的「已在线 / 已下线」页、页面里连 radio 都没有 → 普通网站，直接退出。
      // ⚠ 「已在线成功页」上**没有密码框、没有 radio、地址里也没有 serviceSelection**，
      //   少了这两个 node 判定就会被挡在门外 —— 那正是主人看到的「停在页面上不动」。
      if (!hasAnyPassword() && !servicePageUrl() && !onlineSuccessNode() && !offlineSuccessNode()) {
        let hasRadio = false;
        try {
          hasRadio = !!document.querySelector('input[type=radio]');
        } catch (e) {
          hasRadio = false;
        }
        if (!hasRadio) {
          if (probes > 300) stop();
          return;
        }
      }
      // 第二层：要么有登录表单，要么是服务选择页 / 已在线页 / 已下线页
      // （后三种都**没有密码框**，旧版在这里就被挡掉了，于是那几页永远等不到脚本动手）
      if (
        !hasPasswordField() &&
        !isServiceSelectionPage() &&
        !isOnlineSuccessPage() &&
        !isOfflineSuccessPage()
      ) {
        return;
      }
      busy = true;
      try {
        // 页面自己动手最快；自己不动手（关掉了开关 / 没填密码）才请后台调度
        if (await trySelfStart()) return;
        // 已经动过手（哪怕流程已结束）就别再上报，避免后台重复发起一轮认证
        if (selfStarted || selfStartedService || reported) return;
        if (!hasPasswordField()) return; // 服务选择页没有密码框，不走「发现认证页」那条路
        /* 1.13.0：门禁没放行的页面（教务系统这类）连「发现认证页」都不上报。
         * 以前照样会发 PORTAL_FORM_DETECTED，后台只按 URL 判定（.edu.cn 一律放行），
         * 于是再开一轮流程，页面脚本没动手、后台自己来，误伤一模一样。
         * 这里只跳过上报、不 stop 观察：万一页面后面渲染出真正的门户内容还能接住。 */
        const gate = await loadCtx();
        if (!hostAllowed(gate.cfg, gate.st)) return;
        reported = true;
        stop();
        try {
          chrome.runtime.sendMessage(
            { type: 'PORTAL_FORM_DETECTED', url: location.href, hasPassword: true, captcha: captchaInfo() },
            () => void chrome.runtime.lastError
          );
        } catch (e) {
          /* 忽略 */
        }
      } finally {
        busy = false;
      }
    };

    // 立刻试一次（DOM 已经就绪的情况），不等任何延时
    probe();

    // SPA 晚渲染 / 弹窗式门户：监听 DOM 变化（含 style/class 造成的显示切换），80ms 防抖后立刻再试。
    // 观察窗给到 3 分钟：登录页 → 服务选择页可能是**同文档内**的路由切换，
    // 那种情况下不会重新注入脚本，只能靠这个 observer 认出新的一页。
    const trigger = () => {
      if (stopped || pending || flowRunning) return;
      pending = true;
      setTimeout(() => {
        pending = false;
        probe();
      }, 80);
    };
    try {
      observer = new MutationObserver(trigger);
      observer.observe(document.documentElement, {
        childList: true,
        subtree: true,
        attributes: true,
        attributeFilter: ['style', 'class', 'hidden']
      });
    } catch (e) {
      /* 忽略 */
    }
    setTimeout(stop, 180000);
  }

  chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    if (!msg || !msg.type) return;
    if (msg.type === 'PING') {
      const hasPw = hasPasswordField();
      const needService = isServiceSelectionPage();
      // 什么都不像的空白子框架就别抢答：tabs.sendMessage 是往整个标签页广播的，
      // 谁先 sendResponse 谁说了算 —— 一个空框架抢答会把真正那一页的状态盖掉。
      if (!hasPw && !needService && window.top !== window.self) {
        sendResponse({ ok: true, hasPassword: false, needService: false, silent: true });
        return;
      }
      sendResponse({ ok: true, hasPassword: hasPw, needService, connected: looksConnected() });
      return;
    }
    if (msg.type === 'FILL_AND_SUBMIT' || msg.type === 'SELECT_SERVICE') {
      // 这条指令是往整个标签页广播的，页面里所有框架都会收到。
      // 既没有登录表单、也不是服务选择页的框架必须直接让开，别把流程「抢」过去空跑一遍
      // （抢跑的后果是回报一条假的「认证失败」，盖掉真正框架的结果）。
      const svcPage = !hasPasswordField() && isServiceSelectionPage();
      /* 「已在线 / 已下线」页也归进「这一页有活要干」——
       * 后台是往整个标签页广播指令的，这两种页面同样没有密码框，
       * 少了这一条就会被判成「不是我要管的框架」直接让开，主人看到的又是「界面不动」。 */
      const otherPage = !hasPasswordField() && (isOnlineSuccessPage() || isOfflineSuccessPage());
      const wantSvc =
        msg.type === 'SELECT_SERVICE' || !!(msg.payload && msg.payload.serviceOnly) || svcPage || otherPage;
      if (!hasPasswordField() && !wantSvc) {
        sendResponse({ started: false, note: '该框架既没有登录表单，也不是服务选择页' });
        return;
      }
      if (flowRunning) {
        sendResponse({ started: false, note: '页面内已有流程在执行' });
        return;
      }
      flowRunning = true;
      /* serviceOnly 只在**真的是服务选择页**时才置位：它的意思是「直接从选服务那一步进场」。
       * ⚠ 别写成「没有密码框就 serviceOnly」（旧版就是这么写的）—— 「已在线 / 已下线」页
       *   同样没有密码框，被这么一标就会当成「跳到选服务页」去等运营商选项，然后空等一场。 */
      const payload = Object.assign({}, msg.payload || {}, { serviceOnly: svcPage });
      sendResponse({ started: true });
      runFlow(payload)
        .catch((e) => {
          report({ result: { ok: false, status: 'failed', note: '流程异常：' + ((e && e.message) || e), final: true } });
        })
        .finally(() => {
          flowRunning = false;
        });
      return;
    }
  });

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', watchForPortal);
  else watchForPortal();
})();
