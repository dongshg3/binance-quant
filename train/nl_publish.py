#!/usr/bin/env python3
# ============================================================
# nl_publish.py · 无人值守发布器（本地迭代 → GitHub → Pages 自动上线）
# ------------------------------------------------------------
# 为什么需要一个**独立克隆**而不是在工程里直接 commit：
#   作者的工作树长期有几十个在途改动（audit/、docs/、server/、js/…）。
#   自动发布若在那棵树上 `git add -A`，会把作者没写完的东西一起提交并推上去。
#   所以这里克隆一份干净副本（默认 <工程上一级>/.nl-publish），
#   每次发布只 fetch 最新 main → 覆盖我们自己的产物文件 → 提交 → 推送。
#   发布过程与作者的工作树完全隔离，永不触碰、永不冲突（我们只写自己那几个文件）。
#
# 发布什么：
#   data/nl_status.json   每次迭代都发（诚实的循环状态；无论有没有冠军都发）
#   data/model_nl.json    仅当有模型通过全部闸门才发（可被浏览器直接求值的 AST）
#
# 失败不致命：拉取/推送失败只记录原因，不中断训练闭环（下次迭代再试）。
# ============================================================
from __future__ import annotations

import json
import os
import shutil
import subprocess
import sys
import time
import urllib.error
import urllib.request
from datetime import datetime, timezone

HERE = os.path.dirname(os.path.abspath(__file__))
PROJECT = os.path.abspath(os.path.join(HERE, ".."))
DEFAULT_CLONE = os.path.abspath(os.path.join(PROJECT, "..", ".nl-publish"))
REMOTE = "https://github.com/dongshg3/binance-quant.git"
REPO = "dongshg3/binance-quant"

# 只允许发布这几个文件——这是安全边界，不是习惯。
# 双管线分离：本地写 _local，云端写 _cloud，谁也不覆盖谁。
ALLOWED = ("data/nl_status_local.json", "data/nl_status_cloud.json",
           "data/model_nl.json", "data/model_nl_local.json", "data/model_nl_cloud.json")


def status_path(source: str) -> str:
    return f"data/nl_status_{source}.json"


# ============================================================
# A 方案：本地 → 云端接力
# ------------------------------------------------------------
# 背景（2026-10-17 实测）：本仓库的 `on: schedule` 通道失效，但 `workflow_dispatch`
# 完全可用（POST 返回 204，run 立刻起来）。因此让本地管线在每次成功推送后，
# 顺带踢一脚云端 —— 云端靠 actions/cache 累积自己的账本，与本地互不干扰。
#
# 三条纪律：
#   1. token 从本机 Git Credential Manager 现取现用，**绝不写进仓库/日志**；
#   2. 冷却窗口 + "云端已在跑就跳过"，避免把云端刷成排队队列；
#   3. 全程 best-effort：任何失败只记录，绝不影响本地训练闭环。
# ============================================================
DISPATCH_WORKFLOW = "nl-iter.yml"
DISPATCH_COOLDOWN_S = float(os.environ.get("NL_DISPATCH_COOLDOWN", "1200"))  # 20 分钟
_LAST_DISPATCH = os.path.join(HERE, ".nl_last_dispatch")


def github_token() -> str:
    """从 Git Credential Manager 取已存储的 GitHub 凭据（不落盘、不打印）。"""
    try:
        p = subprocess.run(["git", "credential", "fill"],
                           input="protocol=https\nhost=github.com\n\n",
                           capture_output=True, text=True, timeout=30)
        kv = dict(l.split("=", 1) for l in p.stdout.strip().splitlines() if "=" in l)
        return kv.get("password", "")
    except Exception:
        return ""


def _gh(tok: str, path: str, method: str = "GET", body=None):
    req = urllib.request.Request(
        "https://api.github.com" + path, method=method,
        headers={"Authorization": "token " + tok,
                 "Accept": "application/vnd.github+json",
                 "User-Agent": "nlkit-publisher"},
        data=json.dumps(body).encode() if body is not None else None)
    try:
        with urllib.request.urlopen(req, timeout=25) as r:
            raw = r.read().decode()
            return r.status, (json.loads(raw) if raw.strip() else None)
    except urllib.error.HTTPError as e:
        return e.code, None
    except Exception:
        return -1, None


def _cooldown_left() -> float:
    try:
        with open(_LAST_DISPATCH, encoding="utf-8") as f:
            last = float(f.read().strip() or 0)
    except Exception:
        return 0.0
    return max(0.0, DISPATCH_COOLDOWN_S - (time.time() - last))


def dispatch_cloud(force: bool = False, verbose: bool = True) -> dict:
    """触发一次云端迭代。冷却中或云端已在跑则跳过。"""
    left = _cooldown_left()
    if left > 0 and not force:
        return {"ok": True, "skipped": f"冷却中，还有 {int(left)}s"}

    tok = github_token()
    if not tok:
        return {"ok": False, "error": "取不到 GitHub 凭据（Git Credential Manager 无记录）"}

    # 云端已在跑就别再踢，避免排队
    st, d = _gh(tok, f"/repos/{REPO}/actions/workflows/{DISPATCH_WORKFLOW}/runs?per_page=1")
    if st == 200 and d and d.get("workflow_runs"):
        r = d["workflow_runs"][0]
        if r.get("status") in ("in_progress", "queued", "waiting"):
            return {"ok": True, "skipped": f"云端已有运行 #{r.get('run_number')} 在进行"}

    st, _ = _gh(tok, f"/repos/{REPO}/actions/workflows/{DISPATCH_WORKFLOW}/dispatches",
                method="POST", body={"ref": "main"})
    if st == 204:
        try:
            with open(_LAST_DISPATCH, "w", encoding="utf-8") as f:
                f.write(str(time.time()))
        except OSError:
            pass
        if verbose:
            print("[loop] ⇗ 已触发云端接力一次", flush=True)
        return {"ok": True, "dispatched": True}
    return {"ok": False, "error": f"dispatch HTTP {st}"}


def _now() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


def _run(args, cwd, timeout=180, env_extra=None):
    env = dict(os.environ)
    env["GIT_TERMINAL_PROMPT"] = "0"      # 绝不弹交互认证框（无人值守的底线）
    env["GCM_INTERACTIVE"] = "never"
    if env_extra:
        env.update(env_extra)
    try:
        p = subprocess.run(args, cwd=cwd, capture_output=True, text=True,
                           encoding="utf-8", errors="replace", timeout=timeout, env=env)
        return {"code": p.returncode, "out": (p.stdout or "")[-1500:],
                "err": (p.stderr or "")[-800:]}
    except subprocess.TimeoutExpired:
        return {"code": -1, "out": "", "err": f"超时 {timeout}s"}
    except Exception as e:
        return {"code": -2, "out": "", "err": f"{type(e).__name__}: {e}"}


def ensure_clone(clone: str = DEFAULT_CLONE) -> dict:
    """确保存在一份可用于发布的干净克隆。"""
    if os.path.isdir(os.path.join(clone, ".git")):
        return {"ok": True, "clone": clone, "created": False}
    os.makedirs(os.path.dirname(clone), exist_ok=True)
    r = _run(["git", "clone", "--depth", "1", REMOTE, clone],
             cwd=os.path.dirname(clone), timeout=300)
    if r["code"] != 0:
        return {"ok": False, "error": f"clone 失败: {r['err']}", "clone": clone}
    _run(["git", "config", "user.name", "nl-autoloop"], cwd=clone)
    _run(["git", "config", "user.email", "nl-autoloop@local"], cwd=clone)
    return {"ok": True, "clone": clone, "created": True}


def _sync_latest(clone: str) -> dict:
    """把克隆同步到远端 main 最新。深度 1 克隆用 fetch + reset --hard。"""
    f = _run(["git", "fetch", "--depth", "1", "origin", "main"], cwd=clone, timeout=180)
    if f["code"] != 0:
        return {"ok": False, "error": f"fetch 失败: {f['err']}"}
    r = _run(["git", "reset", "--hard", "FETCH_HEAD"], cwd=clone, timeout=60)
    if r["code"] != 0:
        return {"ok": False, "error": f"reset 失败: {r['err']}"}
    return {"ok": True}


def publish(files: dict[str, str], clone: str = DEFAULT_CLONE, message: str | None = None,
            dry_run: bool = False) -> dict:
    """把 {工程内相对路径: 内容} 发布到远端。只允许 ALLOWED 里的路径。"""
    bad = [k for k in files if k.replace("\\", "/") not in ALLOWED]
    if bad:
        return {"ok": False, "error": f"拒绝发布未授权路径: {bad}"}

    ens = ensure_clone(clone)
    if not ens.get("ok"):
        return ens
    clone = ens["clone"]
    if not os.path.isdir(os.path.join(clone, ".git")):
        _run(["git", "config", "user.name", "nl-autoloop"], cwd=clone)
        _run(["git", "config", "user.email", "nl-autoloop@local"], cwd=clone)

    sync = _sync_latest(clone)
    if not sync.get("ok"):
        return {"ok": False, "stage": "sync", "error": sync.get("error")}

    changed = []
    for rel, content in files.items():
        rel = rel.replace("\\", "/")
        dst = os.path.join(clone, rel)
        os.makedirs(os.path.dirname(dst), exist_ok=True)
        old = None
        if os.path.exists(dst):
            try:
                with open(dst, encoding="utf-8") as f:
                    old = f.read()
            except OSError:
                old = None
        if old == content:
            continue
        with open(dst, "w", encoding="utf-8") as f:
            f.write(content)
        changed.append(rel)

    if not changed:
        return {"ok": True, "published": [], "note": "内容无变化，未提交"}

    _run(["git", "add"] + changed, cwd=clone)
    msg = message or f"🤖 非线性自动迭代 · {_now()}"
    c = _run(["git", "commit", "-q", "-m", msg], cwd=clone, timeout=60)
    if c["code"] != 0:
        return {"ok": False, "stage": "commit", "error": c["err"] or c["out"]}
    if dry_run:
        return {"ok": True, "published": changed, "dryRun": True}

    # 推送重试：云端 quant-bot 也在推，偶发 non-fast-forward 需先同步再来
    last = None
    for attempt in range(3):
        p = _run(["git", "push", "origin", "HEAD:main"], cwd=clone, timeout=180)
        if p["code"] == 0:
            return {"ok": True, "published": changed, "push": p["out"].strip()[-200:],
                    "attempt": attempt + 1}
        last = p
        time.sleep(3 + 5 * attempt)
        _sync_latest(clone)
        _run(["git", "add"] + changed, cwd=clone)
        _run(["git", "commit", "-q", "-m", msg], cwd=clone, timeout=60)
    return {"ok": False, "stage": "push", "error": last["err"] if last else "unknown",
            "published": changed}


# ---------------- 状态产物 ----------------
GATE_THRESHOLDS_DOC = {
    "minIC": 0.015, "minICt": 2.0, "minNetBp": 0.0, "minSharpe": 1.0,
    "minNetT": 2.0, "minDSR": 0.95, "maxTurnover": 6.0, "minCostMargin": 1.5,
    "maxAbsBeta": 0.25, "minAlphaBp": 0.0, "minDownBp": -20.0,
}


def build_status(loop_dir: str | None = None, source: str = "local") -> dict:
    """从循环账本生成给网站展示的诚实状态。不需要冠军存在。"""
    sys.path.insert(0, HERE)
    from nlkit import loop as _loop  # noqa: PLC0415

    if loop_dir:
        _loop.LOOP_DIR = loop_dir
    st = _loop.load_state()
    best = _loop.load_best()
    led = _loop.read_ledger()
    ds_meta = {}
    try:
        from nlkit import data as _data  # noqa: PLC0415
        with open(os.path.join(_data.OUT_DIR, "meta.json"), encoding="utf-8") as f:
            m = json.load(f)
        ds_meta = {"nRows": m.get("nRows"), "nSymbols": m.get("nSymbols"),
                   "nFeatures": m.get("nFeatures"),
                   "symbols": m.get("symbols"), "fwdPnl": m.get("fwdPnl")}
    except Exception:
        pass

    ranked = sorted(
        [r for r in led if isinstance(r.get("metrics"), dict)
         and r["metrics"].get("netSharpe") is not None],
        key=lambda r: r["metrics"]["netSharpe"], reverse=True)
    top = []
    for r in ranked[:10]:
        m = r["metrics"]
        spec = r.get("spec") or {}
        top.append({
            "generation": r.get("generation"),
            "family": spec.get("family"), "featureBatch": spec.get("featureBatch"),
            "holding": (spec.get("trading") or {}).get("holding"),
            "topFrac": (spec.get("trading") or {}).get("topFrac"),
            "costTier": (spec.get("trading") or {}).get("costTier"),
            "icXS": m.get("icXS"), "icNWt": m.get("icNWt"),
            "netMeanBp": m.get("netMeanBp"), "grossMeanBp": m.get("grossMeanBp"),
            "netSharpe": m.get("netSharpe"), "dsr": m.get("dsr"),
            "mktBeta": m.get("mktBeta"), "passed": bool(r.get("passed")),
            "reasons": (r.get("reasons") or [])[:3],
        })

    return {
        "format": "nl-status-1",
        "source": source,
        "pipeline": {
            "local": {"label": "本地管线", "where": "作者本机常驻进程",
                      "note": "算力更足，可跑更长的搜索；依赖本机开机与网络"},
            "cloud": {"label": "云端管线", "where": "GitHub Actions runner",
                      "note": "无人值守，每小时两个槽位；不依赖任何人的电脑"},
        }.get(source, {"label": source, "where": "unknown"}),
        "updatedAt": _now(),
        "engine": "nlkit-1.0",
        "loop": {
            "generation": st.get("generation"),
            "nTrials": st.get("nTrials"),
            "ledgerEntries": len(led),
            "passedAllGates": int(sum(1 for r in led if r.get("passed"))),
            "startedAt": st.get("startedAt"),
            "history": (st.get("history") or [])[-12:],
        },
        "champion": ({"generation": best.get("generation"), "at": best.get("at"),
                      "pbo": best.get("pbo"), "metrics": best.get("metrics", {}),
                      "spec": best.get("spec", {})} if best else None),
        "gateThresholds": GATE_THRESHOLDS_DOC,
        "leaderboard": top,
        "dataset": ds_meta,
        "honestNote": (
            "本页数字全部来自本机零 token 自动迭代的追加式账本；"
            "没有任何候选同时通过全部闸门时，champion 保持为空——这是诚实的空态，不是故障。"
        ),
    }


def publish_status(clone: str = DEFAULT_CLONE, message: str | None = None,
                   dry_run: bool = False, write_local: bool = True,
                   source: str = "local") -> dict:
    """发布一条管线的状态。source ∈ {local, cloud}，两边写不同文件，互不覆盖。"""
    status = build_status(source=source)
    content = json.dumps(status, ensure_ascii=False, indent=1)
    rel = status_path(source)
    files = {rel: content}
    if write_local and not dry_run:
        local = os.path.join(PROJECT, rel.replace("/", os.sep))
        try:
            os.makedirs(os.path.dirname(local), exist_ok=True)
            with open(local, "w", encoding="utf-8") as f:
                f.write(content)
        except OSError:
            pass
    # 冠军存在就一并发布该管线自己的可执行非线性模型
    best = None
    try:
        from nlkit import loop as _loop  # noqa: PLC0415
        best = _loop.load_best()
    except Exception:
        best = None
    if best:
        model_path = os.path.join(PROJECT, "data", "model_nl.json")
        if os.path.exists(model_path):
            with open(model_path, encoding="utf-8") as f:
                files[f"data/model_nl_{source}.json"] = f.read()
    return publish(files, clone=clone,
                   message=message or
                   f"🤖 [{source}] 非线性自动迭代 · g{status['loop']['generation']} · 试错 {status['loop']['nTrials']}",
                   dry_run=dry_run)


if __name__ == "__main__":
    mode = sys.argv[1] if len(sys.argv) > 1 else "status"
    if mode == "status":
        print(json.dumps(build_status(), ensure_ascii=False, indent=1)[:4000])
    elif mode == "publish":
        print(json.dumps(publish_status(dry_run="--dry" in sys.argv), ensure_ascii=False, indent=1))
    elif mode == "ensure":
        print(json.dumps(ensure_clone(), ensure_ascii=False, indent=1))
