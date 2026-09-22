# 某高校门户 —— 真实结构备忘（适配参考）

> 这是 v1.9.0 ~ v1.11.0 期间从某一所学校的门户前端代码里抠出来的结构，
> 用来说明「扩展到底在跟什么样的页面打交道」。域名已脱敏为 portal.example.edu.cn。
> 换一所学校时页面细节会不一样，但**套路一致**：SPA 门户 + i18n 键名 + serviceSelection 独立整页。

> 这份文件解决的是「扩展到底该点哪儿」这个反复出现的问题。
> 以前每次都是靠猜 + 让主人贴诊断；现在有了**直接看门户前端代码**的办法，一次就能看准。

## 门户是什么

- 地址：`https://portal.example.edu.cn/portal/…`，**Angular + ng-zorro（ant-design）SPA**。
- 服务端返回的 HTML 只有一个空壳：

  ```html
  <body>
    <app-root></app-root>
    <script src="polyfills…js" defer></script>
    <script src="scripts…js" defer></script>
    <script src="main…js" defer></script>
  </body>
  ```

  所以**页面渲染全靠 JS**，而且 `<base href="/portal/">`。任何「进页面就有 DOM」的假设都不成立 ——
  必须靠 MutationObserver 或 `waitUntil(...)` 轮询等渲染。

- 业务代码全在**懒加载的 webpack chunk** 里（`main.js` 只有 10KB 的 runtime + 233 个 chunk 的哈希表）。

## 关键路由

| 路由 | 加载的 chunk | 说明 |
| --- | --- | --- |
| `entry/pc/authenticate` | — | 登录表单 |
| `entry/pc/finish` | — | 登录后落地页（工作流节点决定实际显示） |
| `entry/pc/serviceSelection` | `2972` → `ServiceSelectionModule` | **服务选择页** |
| `pc/serviceSelection` | `2972` | 同一个模块 |

## 服务选择页的真实 DOM（`ServiceSelectionModule` 的 Angular 模板还原）

```html
<app-service-selection>
  <section class="section-Load">
    <div class="center-big">            <!-- pcStyle / phoneStyle -->
      <div class="up_distance">
        <div class="bg-center-load noShadow">
          <div class="body">
            <div class="node-title">选择服务</div>      <!-- i18n: select.a.service -->
            <div id="relationInfo">
              <div class="service-box" (click)="selectService(c)">
                <span class="service">中国电信</span>   <!-- i18n: c.key -->
                <i class="icon" nzType="check-circle" *ngIf="选中"></i>
              </div>
              <!-- 中国移动 / 中国联通 同上 -->
            </div>
            <div class="footer">
              <button class="button-3 bu-size-small mr-16px">重新登录</button>  <!-- i18n: sign.in.again -->
              <button class="button-6" nzType="primary" [disabled]="!selectType.value">确定</button>  <!-- i18n: ok -->
            </div>
          </div>
        </div>
      </div>
    </div>
  </section>
  <div class="footers"><app-footer></app-footer></div>
</app-service-selection>
```

**要点（每一条都踩过一次坑）：**

1. **整页没有 `radio`、没有 `label`、没有 `input`。** 选项就是一个可点的 `<div class="service-box">`，文字在里面的 `<span class="service">`。
2. 选中态 = 给 `.service-box` 加 **`active-bg`** class（不是 `checked`，也不是 radio 的 `:checked`）。
3. 「确定」未选中服务时是 **`disabled`**（`[disabled]="!selectType.value"`）。
4. `<div class="footer">` 的文字是「重新登录确定」—— **按文字找按钮会被这个容器骗到**：
   它含「确定」二字，而 div 没有 `disabled` 属性，会被误判成「可用」。必须给容器降权。
5. `<div id="relationInfo">` 的文字是「中国电信 中国移动 中国联通」—— **含三家**，
   用「包含即命中」的匹配会把它当成「中国电信」的候选，点上去什么都不会发生。
   候选只认**只出现一家**的元素。
6. 文案全走 i18n：`select.a.service` / `sign.in.again` / `ok` / `I know` / `Return.cn.Tips`。
   翻译没加载时页面上会**直接显示键名**，所以键名也要认。
7. 服务列表是 **异步** 拉的：`getServiceList({sessionId})`，
   `sessionId` 来自 `localStorage.portalStorgeConfig.sessionId`。**拉不到就是空列表** ——
   页面上没有选项，谁都点不出来。这时应该明确报「页面上找不到选项 + 诊断」，而不是干等。

## 「已在线」页 / 「已下线」页的真实结构（v1.11.0 从门户前端代码里抠出来的）

到点时如果**上一次认证还没到期**，门户**不给登录表单**，而是直接渲染一张「已在线」成功页。
主人报的就是这条路：`https://portal.example.edu.cn/portal/entry/pc/finish;flowParams=undefined;from=`
（`flowParams=undefined` 就是「没有待办工作流节点」的意思 —— 这一跳不是登录流程，而是直接落到成功页）。
组件在懒加载 chunk `3769` / `2984` / `4457` 里，模板还原大致是这样：

```html
<app-login-success>
  <div id="succ-content">
    <div id="succ-top">您已成功连接网络</div>       <!-- 这句话 1.10.0 起只用来「识别页面」，不再当成「刚认证成功」 -->
    <div id="succ-center">…</div>
    <div id="succ-bottom">
      <div id="function-cards">
        <div class="function" (click)="clickFun(f)">
          <span class="fun-name">我要下线</span>      <!-- functionType: logOut  ← 续期要点的就是它 -->
        </div>
        <div class="function"><span class="fun-name">选择服务</span></div>   <!-- ⚠ 见要点 2 -->
        <div class="function"><span class="fun-name">本机无感认证</span></div>
        <div class="function"><span class="fun-name">自助中心</span></div>
        <div class="function"><span class="fun-name">终端信息</span></div>
      </div>
    </div>
  </div>
</app-login-success>
```

**要点（每一条都是这一版差点踩翻车的地方）：**

1. **卡片清单是后端下发的，不是写死的。**
   `GET /sam/api/protected/eportal/querySuccessPageCustomizedPageConfig` 返回 `functions[]`，
   每项带 `functionType`（`logOut` / `selectService` / …）和显示名。这一版实测返回里**有「我要下线」**。
   所以「这一页有没有下线入口」是配置决定的，判断时认文字 / 认 `.fun-name` 比认写死的选择器稳。
2. ⚠ **这一页的功能卡片里就有一项叫「选择服务」。** 任何靠「页面上写着『选择服务』」来判服务选择页的代码，
   都会在这一页上误判成「到了服务选择页」，然后跑去等一个不存在的运营商选项，**空等到超时**。
   判据顺序必须写死：**先认「已在线 / 已下线」，再认「服务选择」**。
3. 点「我要下线」→ `clickFun('logOut')` → 弹出 `app-modal type=checkOut`（ng-zorro 确认框）。
   确认按钮文案走 i18n 的 `ok`（中文「确定」）。**必须在 `.ant-modal` 容器里找**，并且**排除「取消 / 关闭」**——
   整页粗搜很容易先捞到「取消」。
4. 确认后走 `POST /eportal/network/newLogout {sessionId}`，成功后门户**先等 2 秒**才 `logOutTopage()` 跳走。
   所以点完确认要**给足时间**（扩展里给了 9 秒），不能立刻下结论、更不能这时候被后台探测打断。
5. 注销落地的「已下线」页有两个组件名（都要认）：`app-account-offline-success`（chunk `4457` / `7377`）和
   `app-sid-success`（chunk `9903`）。主按钮的 i18n 键是 **`Reconnect.network`**。
   ⚠ **它在语言包里的真实中文是「重新入网」**，不是「重新连接网络」——
   1.11.0 按英文键名意译写进词表，真机上那个按钮**一次都没被点到**。
   语言包位置：`GET /portal/assets/tmp/i18n/zh-CN.json`（1271 条，扁平键）。
   相关词条：`Reconnect.network=重新入网`、`Recertification=重新认证`、`sign.in.again=重新登录`、
   `Processed.network=已处理，重新入网`、`Successfully.offline=下线成功`、`you.are.now.offline=您已下线`、
   `INeedOffline=我要下线`、`Confirm.Offline=确认下线吗`、`Offline.progress=下线中`、`offline=下线`。
   **以后凡是「按钮文案」的判据，都要先来这里查真实中文，不要按英文键名猜。**
6. 「重新入网」点下去到底做了什么（chunk `7243` / `9903` / `4457` / `2089` / `2972` … 都一样）：
   ```js
   localStorage.removeItem('firstFlowParam');
   sessionStorage.removeItem('previousUrl');
   window.location.href = localStorage.getItem('samPortalRedirectUrl') || window.location.protocol + '//2.2.2.2';
   ```
   即**回到网关探测地址**，由网关带着 `sessionId` / `wlanuserip` 等参数把浏览器送回认证页。
   扩展的兜底就照抄这一行（`portalReloginTarget()` + `jumpToRelogin()`）：
   认不出、点不动那个按钮时直接跳同一个地址，认证照样能进到网页里。
7. ⚠ **服务选择页上有一个「重新登录」按钮**（`sign.in.again`），跟「重新入网 / 重新连接网络」长得很像。
   反过来判「已下线页」时就会被服务选择页骗到 —— 所以判「已下线页」必须**先排除服务选择页**
   （地址含 `serviceSelection`，或页面上还有可见的「确定」按钮 + 服务选项），
   再要求「除了那个入口以外没有别的可点主按钮」。
8. 续期这件事的本质：门户的**在线时长是从「最近一次成功认证」开始算的**，
   停在已在线页什么都不做，时长就永远停在上次那个时间点。所以必须**真的注销再真的认证一次**。

## 相关接口（都在 chunk `7243` 里）

```
GET_SERVICE_LIST : /eportal/network/serviceSelection
SET_SERVICE      : /eportal/network/setService
SERVICELOGIN     : /eportal/network/serviceLogin      ← 「确定」调的就是它
OPERATORLOGIN    : /eportal/network/operatorLogin
GET_NEXT_NODE    : /eportal/workFlow/getCurrentNode   ← 由它决定当前该显示哪个节点页
PUSH_NEXT_NODE   : /eportal/workFlow/updateUserSession
```

`submitForm()` 的流程：`serviceLogin({sessionId, service})` → `code===200 && data.authResult==='success'`
→ `localStorage.setItem('service', value)` → `getActionNextPageForPortal()` → `nextPath()`。
失败时弹 `modalService.warning`（`nzClassName: 'service-selection-modal'`，按钮文案 `I know`）。

## 怎么重新拿一遍（门户改版时用）

```bash
python tools/probe-portal.py
```

它会：① 拉门户首页和几个 entry 页的原始 HTML；② 从 `main.js` 里解析出全部 chunk 文件名并下载；
③ 在 chunk 里搜 `serviceSelection` / `请选择服务` / `中国电信` / `app-account-offline-success` / `Reconnect.network` 等关键词并输出上下文；
④ 顺手把门户中文语言包 `assets/tmp/i18n/zh-CN.json` 拉下来，并打印「按钮文案」相关的关键键。

输出在 `tools/probe-out/`（`probe-result.txt` / `search-report.txt` / `chunks/` / `i18n-zh-CN.json`）。

⚠ **凡是要按按钮文字做判据的，先查语言包，不要按英文键名意译。**
（1.11.0 把 `Reconnect.network` 猜成「重新连接网络」，真实中文是「重新入网」，
真机上那个按钮一次都没被点到 —— 整个「已下线 → 回认证页」的支路等于没写。）

**注意**：脚本只是 GET，不改任何状态；但它用的是**本机当前的网络出口**，
所以要在校园网里跑才能拿到门户内容（否则只会拿到网关的跳转页）。
用无头浏览器渲染这条路走不通 —— 独立 profile 的 headless 实例会被网关拦到探测地址上
（实测 dump 出来的是 `ERR_CONNECTION_TIMED_OUT` 错误页），直接抓 HTML + 抓 chunk 才是正路。
