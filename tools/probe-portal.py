# -*- coding: utf-8 -*-
"""重新采集门户的真实结构（门户改版、扩展认不出页面时用）。

做三件事（全部是只读 GET，不改任何状态）：
  1. 拉门户几个 entry 页的原始 HTML
  2. 从 main.js 解析出全部 webpack chunk 文件名并下载
  3. 在 chunk 里搜关键词（serviceSelection / 请选择服务 / 中国电信 …）并输出上下文

顺手还会拉一份**语言包** `assets/tmp/i18n/zh-CN.json`（I18N_FILE）——
⚠ 凡是要按**按钮文字**做判据的地方，必须来这里查真实中文，**不要按英文 i18n 键名意译**。
（1.11.0 就是照键名 `Reconnect.network` 猜成「重新连接网络」，而真实中文是「重新入网」，
 真机上那个按钮一次都没被点到。）

输出目录：tools/probe-out/
  probe-result.txt   各页 HTML 摘要
  chunks/            下载下来的前端代码
  search-report.txt  关键词命中 + 上下文
  i18n-zh-CN.json    门户中文语言包（扁平键，1271 条）

⚠ 要在校园网里跑（用本机网络出口）；否则只会拿到网关的跳转页。
⚠ 无头浏览器渲染这条路走不通：独立 profile 的 headless 实例会被网关拦到探测地址上。

用法：python tools/probe-portal.py
"""

import json
import os
import re
import ssl
import urllib.request
from concurrent.futures import ThreadPoolExecutor

BASE = "https://portal.example.edu.cn/portal/"
ROOT = os.path.dirname(os.path.abspath(__file__))
OUT = os.path.join(ROOT, "probe-out")
CHUNKS = os.path.join(OUT, "chunks")

UA = (
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
    "(KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36 Edg/126.0.0.0"
)

PAGES = [
    "https://portal.example.edu.cn/",
    "https://portal.example.edu.cn/portal/entry/pc/serviceSelection;flowParams=undefined;from=authenticate;sid=false",
    "https://portal.example.edu.cn/portal/entry/pc/finish;flowParams=undefined;from=authenticate;sid=false",
]

KEYS = [
    "serviceSelection",
    "\u8bf7\u9009\u62e9\u670d\u52a1",  # 请选择服务
    "\u9009\u62e9\u670d\u52a1",        # 选择服务
    "\u4e2d\u56fd\u7535\u4fe1",        # 中国电信
    "\u8fd0\u8425\u5546",              # 运营商
    "service-box",
    "relationInfo",
    # 「已在线 / 已下线」两支路用到的真实节点名与文案
    "app-account-offline-success",
    "app-sid-success",
    "Reconnect.network",
    "samPortalRedirectUrl",
]

# 门户语言包（Angular 的 loader 前缀写死在 chunk 7243 里：assets/tmp/i18n/ + .json）
I18N_FILE = "assets/tmp/i18n/zh-CN.json"

ctx = ssl.create_default_context()
ctx.check_hostname = False
ctx.verify_mode = ssl.CERT_NONE


def get(url, timeout=60):
    req = urllib.request.Request(url, headers={"User-Agent": UA})
    with urllib.request.urlopen(req, timeout=timeout, context=ctx) as r:
        return r.read()


def main():
    os.makedirs(CHUNKS, exist_ok=True)
    lines = []

    # ① 页面 HTML
    for url in PAGES:
        lines.append("=" * 100)
        lines.append("REQ: " + url)
        try:
            raw = get(url, 30)
        except Exception as e:
            lines.append("  ERR: %s %s" % (type(e).__name__, e))
            continue
        body = raw.decode("utf-8", "ignore")
        lines.append("  bytes=%d" % len(raw))
        lines.append(body[:3000])

    # ② main.js → chunk 清单 → 下载
    try:
        main_js = get(BASE + _main_name(), 60).decode("utf-8", "ignore")
    except Exception as e:
        lines.append("main.js 拉取失败：%s %s（先看 index 页里 <script src=main…> 的实际名字）" % (type(e).__name__, e))
        _write(lines)
        return

    names_part = re.search(r"f\.u=function\(e\)\{return\((\{.*?\})\[e\]\|\|e\)", main_js, re.S)
    hashes_part = re.search(r'\+"\."\+(\{[^}]*\})\[e\]\+"\.js"', main_js, re.S)
    names = dict(re.findall(r'(\d+):"([^"]+)"', names_part.group(1))) if names_part else {}
    hashes = dict(re.findall(r'(\d+):"([0-9a-f]+)"', hashes_part.group(1))) if hashes_part else {}
    lines.append("")
    lines.append("chunks=%d named=%d" % (len(hashes), len(names)))

    files = [names.get(cid, cid) + "." + h + ".js" for cid, h in hashes.items()]

    def grab(fn):
        dest = os.path.join(CHUNKS, fn)
        if os.path.exists(dest) and os.path.getsize(dest) > 500:
            return
        try:
            with open(dest, "wb") as f:
                f.write(get(BASE + fn, 90))
        except Exception:
            pass

    with ThreadPoolExecutor(max_workers=6) as ex:
        list(ex.map(grab, files))

    # ③ 搜索
    lines.append("")
    hits = {}
    for fn in sorted(os.listdir(CHUNKS)):
        s = open(os.path.join(CHUNKS, fn), encoding="utf-8", errors="ignore").read()
        for k in KEYS:
            n = len(re.findall(re.escape(k), s))
            if n:
                hits.setdefault(fn, {})[k] = n
    for fn, d in hits.items():
        lines.append("%s -> %s" % (fn, ", ".join("%sx%d" % (k, v) for k, v in d.items())))

    # ④ 语言包（按按钮文字做判据时的唯一可信来源）
    _i18n(lines)

    # 命中 serviceSelection 的文件里，把「服务选择页模板」的上下文摘出来
    for fn in hits:
        s = open(os.path.join(CHUNKS, fn), encoding="utf-8", errors="ignore").read()
        for key in ("service-box", "relationInfo", "serviceSelection"):
            if key not in hits[fn]:
                continue
            for m in list(re.finditer(re.escape(key), s))[:3]:
                a, b = max(0, m.start() - 400), min(len(s), m.start() + 900)
                lines.append("-" * 100)
                lines.append("FILE %s  KEY %s" % (fn, key))
                lines.append(s[a:b].replace("},{", "},\n{"))

    _write(lines)


def _i18n(lines):
    """把门户中文语言包存下来，并把「按钮文案」相关的关键键打印出来。

    ⚠ 这些键的中文**不能按英文猜**：Reconnect.network 的真实中文是「重新入网」。"""
    lines.append("")
    lines.append("=" * 100)
    lines.append("I18N " + I18N_FILE)
    try:
        raw = get(BASE + I18N_FILE, 60)
    except Exception as e:
        lines.append("  拉取失败：%s %s（门户换语言包路径时，去看 chunk 7243 里的 loader 前缀）" % (type(e).__name__, e))
        return
    with open(os.path.join(OUT, "i18n-zh-CN.json"), "wb") as f:
        f.write(raw)
    try:
        data = json.loads(raw.decode("utf-8", "ignore"))
    except Exception as e:
        lines.append("  解析失败：%s" % e)
        return
    lines.append("  共 %d 条，已存 i18n-zh-CN.json" % len(data))
    for k in (
        "Reconnect.network",
        "Recertification",
        "sign.in.again",
        "Processed.network",
        "Successfully.offline",
        "you.are.now.offline",
        "INeedOffline",
        "Confirm.Offline",
        "Offline.progress",
        "offline",
        "connect.success",
    ):
        if k in data:
            lines.append("  %-24s = %s" % (k, data[k]))


def _main_name():
    """index 页里的 main.<hash>.js 名字每次构建都会变，动态取。"""
    html = get(BASE + "entry/pc/finish;flowParams=undefined;from=authenticate;sid=false", 30).decode("utf-8", "ignore")
    m = re.search(r'(main\.[0-9a-f]+\.js)', html)
    return m.group(1) if m else "main.js"


def _write(lines):
    with open(os.path.join(OUT, "search-report.txt"), "w", encoding="utf-8") as f:
        f.write("\n".join(lines))
    print("完成 ->", os.path.join(OUT, "search-report.txt"))


if __name__ == "__main__":
    main()
