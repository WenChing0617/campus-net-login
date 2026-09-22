# -*- coding: utf-8 -*-
"""校园网自动登录扩展 —— 一键校验 + 打包

做四件事：
  1. 校验 manifest.json（JSON 合法性、图标、被引用的文件是否齐全）
  2. 用 node --check 检查所有 JS 语法
  3. 跑两份 jsdom 仿真测试（页面流程 / 后台逻辑）
  4. 打包 zip（解压后可直接在 edge://extensions 加载）

用法：python tools/build.py
"""

import json
import os
import re
import subprocess
import sys
import zipfile

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
NODE_CANDIDATES = [
    r"C:\Users\WQ\.workbuddy\binaries\node\versions\22.22.2-3\node.exe",
    "node",
]
# jsdom 装在这里，跑测试需要 NODE_PATH
NODE_MODULES = r"C:\Users\WQ\.workbuddy\binaries\node\workspace\node_modules"

INCLUDE = [
    "manifest.json",
    "background.js",
    "content.js",
    "popup.html",
    "popup.css",
    "popup.js",
    "options.html",
    "options.css",
    "options.js",
    "README.md",
    "test/flow-test.mjs",
    "test/background-test.mjs",
    "test/gate-check.mjs",
    # 注意：test/regress-* 是本地历史回归留档（含个人信息），已在 .gitignore 中排除，
    # 因此也不列入打包白名单 —— 否则 clone 下来构建会因为缺文件而失败。
    "tools/login-edge.cmd",
    "tools/setup-scheduled-tasks.ps1",
    "tools/portal-structure.md",
    "tools/probe-portal.py",
    # 注：早先那套「脱离浏览器的独立脚本」（headless Edge + CDP，tools/standalone/）主人已决定不用，
    # 整目录删除、不再打包。浏览器没打开时的方案走下面的计划任务（拉起 Edge）。
]
ICONS = ["icon16.png", "icon32.png", "icon48.png", "icon128.png"]
JS_FILES = ["background.js", "content.js", "popup.js", "options.js"]
TESTS = [
    ("test/flow-test.mjs", "result.txt", "页面流程测试"),
    ("test/background-test.mjs", "background-result.txt", "后台逻辑测试"),
    # 1.13.0 新增：教务系统这类校内站点绝不能被当成校园网门户（门禁专项）
    ("test/gate-check.mjs", "gate-check-result.txt", "门户门禁测试"),
]

report = []


def read_json(path):
    with open(path, "r", encoding="utf-8") as f:
        return json.load(f)


def read_text(rel):
    path = os.path.join(ROOT, rel)
    if not os.path.exists(path):
        return None
    with open(path, "r", encoding="utf-8") as f:
        return f.read()


def slice_braces(text, start_marker, open_ch="{", close_ch="}"):
    """取出 start_marker 之后第一对括号里的内容（做括号配对，忽略嵌套）。"""
    if not text:
        return None
    i = text.find(start_marker)
    if i < 0:
        return None
    j = text.find(open_ch, i)
    if j < 0:
        return None
    depth = 0
    for k in range(j, len(text)):
        if text[k] == open_ch:
            depth += 1
        elif text[k] == close_ch:
            depth -= 1
            if depth == 0:
                return text[j + 1:k]
    return None


# 复选框 id → 它实际写在 DEFAULTS 里的位置（这两个是嵌套对象里的 .enabled）
NESTED_CHECK_IDS = {"scheduleEnabled": "schedule", "advEnabled": "advanced"}


def top_level_keys(body):
    """对象字面量的一级键（按缩进 2 空格判定，嵌套键是 4 空格）。"""
    if body is None:
        return None
    return re.findall(r"^\s{2}([A-Za-z_$][\w$]*)\s*:", body, re.M)


def check_options_consistency():
    """设置项在 options.html / options.js / background.js 三处必须一一对应。

    加一个开关要同时改三个文件（HTML 的复选框、options.js 的 DEFAULTS + CHECK_IDS、
    background.js 的 DEFAULT_CONFIG），漏掉任何一处都会表现成「开关存了但没人读」或
    「后台读到了但设置页存不下去」——这种错很难靠肉眼发现，所以让它自动查。
    """
    html = read_text("options.html")
    ojs = read_text("options.js")
    bg = read_text("background.js")
    if html is None or ojs is None or bg is None:
        report.append("设置项一致性检查：文件缺失，跳过")
        return

    html_ids = re.findall(r'<input\s+id="([^"]+)"\s+type="checkbox"', html)
    check_ids = re.findall(r"'([^']+)'", slice_braces(ojs, "const CHECK_IDS", "[", "]") or "")
    opt_keys = top_level_keys(slice_braces(ojs, "const DEFAULTS"))
    bg_keys = top_level_keys(slice_braces(bg, "const DEFAULT_CONFIG"))
    if opt_keys is None or bg_keys is None:
        report.append("设置项一致性检查：解析失败，跳过")
        return

    problems = []
    # 1) HTML 里的每个复选框都要在 CHECK_IDS 里（否则界面上勾了也不保存）
    for cid in html_ids:
        if cid not in check_ids:
            problems.append("options.html 的「%s」不在 options.js 的 CHECK_IDS 里" % cid)
    # 2) 每个 CHECK_ID 都要在 HTML 里真有这个复选框，且是 options.js 的默认项
    for cid in check_ids:
        if cid not in html_ids:
            problems.append("CHECK_IDS 里的「%s」在 options.html 里找不到对应复选框" % cid)
        # ⚠ 有两个复选框对应的是**嵌套**配置里的 .enabled（scheduleEnabled / advEnabled），
        #   它们在一级键里本来就找不到，别当成漏写。
        tgt = NESTED_CHECK_IDS.get(cid, cid)
        if tgt not in opt_keys:
            problems.append("CHECK_IDS 里的「%s」在 options.js 的 DEFAULTS 里没有对应项（应有 %s）" % (cid, tgt))
    # 3) 两份默认配置必须完全一致
    missing_in_opt = [k for k in bg_keys if k not in opt_keys]
    missing_in_bg = [k for k in opt_keys if k not in bg_keys]
    if missing_in_opt:
        problems.append("background.js 有、options.js 没有：%s" % ", ".join(missing_in_opt))
    if missing_in_bg:
        problems.append("options.js 有、background.js 没有：%s" % ", ".join(missing_in_bg))

    if problems:
        report.append("设置项一致性检查：失败 -> " + " | ".join(problems))
    else:
        report.append(
            "设置项一致性检查：通过（复选框 %d 个 / CHECK_IDS %d 个 / 默认配置 %d 项，三处一一对应）"
            % (len(html_ids), len(check_ids), len(opt_keys))
        )


def find_node():
    for cand in NODE_CANDIDATES:
        try:
            r = subprocess.run([cand, "--version"], capture_output=True, text=True)
            if r.returncode == 0:
                return cand
        except Exception:
            continue
    return None


def check_manifest():
    path = os.path.join(ROOT, "manifest.json")
    try:
        data = read_json(path)
        report.append("manifest.json 解析通过（name=%s  version=%s）" % (data.get("name"), data.get("version")))
    except Exception as e:
        report.append("manifest.json 解析失败：%s" % e)
        return None

    missing = []
    # 图标
    for name in ICONS:
        if not os.path.exists(os.path.join(ROOT, "icons", name)):
            missing.append("icons/" + name)
    for v in (data.get("icons") or {}).values():
        if not os.path.exists(os.path.join(ROOT, v)):
            missing.append(v)
    for v in ((data.get("action") or {}).get("default_icon") or {}).values():
        if not os.path.exists(os.path.join(ROOT, v)):
            missing.append(v)
    # 脚本 / 页面
    for key in ("background",):
        sw = (data.get(key) or {}).get("service_worker")
        if sw and not os.path.exists(os.path.join(ROOT, sw)):
            missing.append(sw)
    for cs in data.get("content_scripts") or []:
        for js in cs.get("js") or []:
            if not os.path.exists(os.path.join(ROOT, js)):
                missing.append(js)
    for key in ("options_page",):
        p = data.get(key)
        if p and not os.path.exists(os.path.join(ROOT, p)):
            missing.append(p)
    popup = (data.get("action") or {}).get("default_popup")
    if popup and not os.path.exists(os.path.join(ROOT, popup)):
        missing.append(popup)

    report.append("引用文件检查：%s" % ("缺失 " + ", ".join(sorted(set(missing))) if missing else "全部存在"))
    return data


def check_js(node):
    if not node:
        report.append("未找到 node，跳过 JS 语法检查")
        return
    bad = []
    for f in JS_FILES:
        r = subprocess.run([node, "--check", os.path.join(ROOT, f)], capture_output=True, text=True)
        if r.returncode != 0:
            bad.append("%s: %s" % (f, (r.stderr or "").strip()[:200]))
    report.append("JS 语法检查：%s" % ("全部通过（%d 个）" % len(JS_FILES) if not bad else "失败 -> " + " | ".join(bad)))


def run_tests(node):
    if not node:
        return
    if not os.path.isdir(NODE_MODULES):
        report.append("未安装 jsdom，跳过仿真测试（npm install jsdom 后可跑）")
        return
    env = dict(os.environ, NODE_PATH=NODE_MODULES)
    for script, result_name, label in TESTS:
        path = os.path.join(ROOT, script)
        if not os.path.exists(path):
            report.append("%s 未找到，跳过" % script)
            continue
        try:
            r = subprocess.run([node, path], capture_output=True, text=True, encoding="utf-8",
                               errors="replace", env=env, timeout=600)
        except Exception as e:
            report.append("%s 无法运行：%s" % (label, str(e)[:200]))
            continue
        summary = ""
        rf = os.path.join(ROOT, "test", result_name)
        if os.path.exists(rf):
            with open(rf, "r", encoding="utf-8") as f:
                lines = [ln for ln in f.read().strip().splitlines() if ln.strip()]
            if lines:
                summary = "（%s）" % lines[-1]
        ok = r.returncode == 0
        report.append("%s：%s%s" % (label, "通过" if ok else "失败：" + (r.stderr or "")[:300], summary))


def build_zip(version):
    out = os.path.join(os.path.dirname(ROOT), "campus-net-login-%s.zip" % version)
    if os.path.exists(out):
        os.remove(out)
    files = list(INCLUDE) + ["icons/" + n for n in ICONS]
    with zipfile.ZipFile(out, "w", zipfile.ZIP_DEFLATED) as z:
        for rel in files:
            src = os.path.join(ROOT, rel.replace("/", os.sep))
            if not os.path.exists(src):
                report.append("打包时缺少 %s（已跳过）" % rel)
                continue
            z.write(src, "campus-net-login/" + rel)
    report.append("打包完成：%s（%d 个文件，%.1f KB）" % (os.path.basename(out), len(files), os.path.getsize(out) / 1024.0))
    return out


def main():
    node = find_node()
    data = check_manifest()
    check_options_consistency()
    check_js(node)
    run_tests(node)
    version = (data or {}).get("version") or "0.0.0"
    build_zip(version)

    text = "\n".join(report) + "\n"
    with open(os.path.join(ROOT, "tools", "build-report.txt"), "w", encoding="utf-8") as f:
        f.write(text)
    try:
        sys.stdout.write(text)
    except Exception:
        pass
    bad = any(("失败" in ln or "缺失 " in ln) for ln in report)
    return 1 if bad else 0


if __name__ == "__main__":
    sys.exit(main())
