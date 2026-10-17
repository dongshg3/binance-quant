#!/usr/bin/env python3
# ============================================================
# nl_site.py · 幂等的站点集成（把自动迭代面板装到线上页面）
# ------------------------------------------------------------
# 为什么不能直接推送本地的 evolution.html / js/evolution.js：
#   作者的工作树里有在途未提交的文案修正（实测：克隆里 evolution.html 写的是
#   「实盘战绩对照」，本地已改成「模拟盘战绩对照（模拟竞赛口径 · 非真实资金）」）。
#   整文件推送＝把作者没审完的改动一起发到线上。绝对不行。
#
# 所以本脚本只对**干净克隆**做两件受控的事：
#   1. 新增文件 js/lib/nlstatus.js（纯新增，无覆盖风险）
#   2. 在 evolution.html 里插入一个 panel 块、在 js/evolution.js 里插入一行 import 与一行调用
#      —— 全部用锚点定位、幂等（已存在则跳过），不触碰这两个文件的任何其他内容。
#
# 用法：
#   python train/nl_site.py diff      # 只显示将要做的改动（不写、不推）
#   python train/nl_site.py apply     # 应用并推送
# ============================================================
from __future__ import annotations

import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
for _s in (sys.stdout, sys.stderr):
    try:
        _s.reconfigure(encoding="utf-8", errors="replace")
    except Exception:
        pass

import nl_publish as P  # noqa: E402

PROJECT = P.PROJECT
OVERLAY = os.path.join(os.path.dirname(os.path.abspath(__file__)), "site_overlay")

PANEL_ANCHOR = "  <!-- 逐币独立模型 -->"
PANEL_MARK = 'id="nlStatusContent"'
PANEL_BLOCK = """  <!-- 零 Token 自动迭代（非线性模型）· 数据来自 data/nl_status.json，由本机常驻进程自动更新 -->
  <div class="panel" style="margin-bottom:14px;">
    <h3><span data-icon="cpu"></span>零 Token 自动迭代（非线性模型） <span class="sub">本机常驻进程逐代搜索 · 每代只消耗本地 CPU，不调用任何外部模型接口 · 产物自动推送后由本页读取</span></h3>
    <div id="nlStatusContent"><div class="placeholder">正在读取自动迭代产物…</div></div>
  </div>

"""

JS_IMPORT_ANCHOR = "import { renderNav, setNet, fmtPct, fmtNum, disclaimerHTML, icon, swapHTML } from './lib/ui.js';"
JS_IMPORT_LINE = "\nimport { renderNlStatus } from './lib/nlstatus.js';"
JS_CALL_ANCHOR = "init();"
JS_CALL_LINE = "\n// 零 Token 自动迭代状态面板（data/nl_status.json）。独立渲染，取不到产物时只影响本区块。\nrenderNlStatus();"
JS_MARK = "renderNlStatus"


def _read(path):
    with open(path, encoding="utf-8") as f:
        return f.read()


def _write(path, text):
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path, "w", encoding="utf-8", newline="") as f:
        f.write(text)


def _overlay_files():
    """要新增的站点文件：{仓库相对路径: 内容}"""
    out = {}
    for root, _dirs, files in os.walk(OVERLAY):
        for fn in files:
            full = os.path.join(root, fn)
            rel = os.path.relpath(full, OVERLAY).replace("\\", "/")
            out[rel] = _read(full)
    return out


def plan(clone: str) -> dict:
    """计算需要做的改动（幂等：已存在的不重复加）。"""
    ops = []

    # 1) 新增文件
    new_files = {}
    for rel, content in _overlay_files().items():
        dst = os.path.join(clone, rel)
        old = _read(dst) if os.path.exists(dst) else None
        if old != content:
            new_files[rel] = content
            ops.append({"op": "write" if old is None else "update", "file": rel})

    # 2) evolution.html 插入 panel
    html_path = os.path.join(clone, "evolution.html")
    html = _read(html_path)
    if PANEL_MARK in html:
        ops.append({"op": "skip", "file": "evolution.html", "why": "面板已存在"})
    elif PANEL_ANCHOR not in html:
        ops.append({"op": "error", "file": "evolution.html", "why": f"找不到锚点 {PANEL_ANCHOR!r}"})
    else:
        new_html = html.replace(PANEL_ANCHOR, PANEL_BLOCK + PANEL_ANCHOR, 1)
        ops.append({"op": "patch", "file": "evolution.html", "why": "插入零 Token 自动迭代面板"})
        new_files["evolution.html"] = new_html

    # 3) js/evolution.js 插入 import + 调用
    js_path = os.path.join(clone, "js", "evolution.js")
    js = _read(js_path)
    if JS_MARK in js:
        ops.append({"op": "skip", "file": "js/evolution.js", "why": "已接入"})
    else:
        n_js = js
        if JS_IMPORT_ANCHOR not in n_js:
            ops.append({"op": "error", "file": "js/evolution.js", "why": "找不到 import 锚点"})
        elif JS_CALL_ANCHOR not in n_js:
            ops.append({"op": "error", "file": "js/evolution.js", "why": "找不到 init() 锚点"})
        else:
            n_js = n_js.replace(JS_IMPORT_ANCHOR, JS_IMPORT_ANCHOR + JS_IMPORT_LINE, 1)
            n_js = n_js.replace(JS_CALL_ANCHOR, JS_CALL_ANCHOR + JS_CALL_LINE, 1)
            ops.append({"op": "patch", "file": "js/evolution.js",
                        "why": "加一行 import 与一行 renderNlStatus() 调用"})
            new_files["js/evolution.js"] = n_js

    return {"ops": ops, "files": new_files}


def main(mode: str = "diff", clone: str = P.DEFAULT_CLONE) -> int:
    ens = P.ensure_clone(clone)
    if not ens.get("ok"):
        print(f"[nl_site] 克隆不可用: {ens.get('error')}")
        return 1
    clone = ens["clone"]
    sync = P._sync_latest(clone)
    if not sync.get("ok"):
        print(f"[nl_site] 同步远端失败: {sync.get('error')}")
        return 1

    pl = plan(clone)
    for o in pl["ops"]:
        print(f"[nl_site] {o['op']:6s} {o['file']:20s} {o.get('why','')}")
    if any(o["op"] == "error" for o in pl["ops"]):
        print("[nl_site] 有锚点缺失，已中止（不写任何文件）")
        return 2
    if not pl["files"]:
        print("[nl_site] 无需改动，站点已是最新")
        return 0

    if mode != "apply":
        print("[nl_site] 这是 diff 模式，未写入。加 apply 参数才会推送。")
        return 0

    for rel, content in pl["files"].items():
        _write(os.path.join(clone, rel), content)

    P._run(["git", "add"] + list(pl["files"].keys()), cwd=clone)
    msg = "📈 接入零 Token 自动迭代状态面板（非线性模型 · 数据由本机常驻进程自动更新）"
    c = P._run(["git", "commit", "-q", "-m", msg], cwd=clone)
    if c["code"] != 0:
        print(f"[nl_site] 提交失败: {c['err'] or c['out']}")
        return 3
    last = None
    for attempt in range(3):
        p = P._run(["git", "push", "origin", "HEAD:main"], cwd=clone, timeout=180)
        if p["code"] == 0:
            print(f"[nl_site] 已推送（第 {attempt+1} 次）: {p['out'].strip()[-160:]}")
            return 0
        last = p
        P._sync_latest(clone)
    print(f"[nl_site] 推送失败: {last['err'] if last else 'unknown'}")
    return 4


if __name__ == "__main__":
    raise SystemExit(main(sys.argv[1] if len(sys.argv) > 1 else "diff"))
