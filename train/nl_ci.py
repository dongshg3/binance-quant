#!/usr/bin/env python3
# ============================================================
# nl_ci.py · 云端迭代入口（GitHub Actions 专用，不推送、只产出文件）
# ------------------------------------------------------------
# 设计原则（与本仓库既有的 train.yml / arena.yml 一致）：
#   · 计算在 ubuntu runner 上；产物由 workflow 自己 commit 回 main
#   · 本脚本**不做任何 git 操作**（NL_NO_PUBLISH=1 时 auto_publish 直接跳过）
#   · runner 每次全新 → 没有缓存就冷启动建库；有 actions/cache 就增量刷新
# ============================================================
from __future__ import annotations

import argparse
import json
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
for _s in (sys.stdout, sys.stderr):
    try:
        _s.reconfigure(encoding="utf-8", errors="replace")
    except Exception:
        pass

os.environ.setdefault("NL_NO_PUBLISH", "1")   # 云端不要走本地发布器（workflow 自己 commit）

HERE = os.path.dirname(os.path.abspath(__file__))
PROJECT = os.path.abspath(os.path.join(HERE, ".."))


def ensure_dataset(allow_bootstrap: bool = True) -> dict:
    from nlkit import data as D
    ds_path = os.path.join(D.OUT_DIR, "dataset.npz")
    if os.path.exists(ds_path):
        m = json.load(open(os.path.join(D.OUT_DIR, "meta.json"), encoding="utf-8"))
        print(f"[ci] 复用已有数据集：{m['nRows']} 样本 / {m['nSymbols']} 币", flush=True)
        return {"ok": True, "reused": True, "meta": m}
    if not allow_bootstrap:
        return {"ok": False, "reason": "数据集不存在且未允许冷启动"}
    from nlkit import bootstrap as B
    r = B.bootstrap()
    print(f"[ci] 冷启动完成：ok={r['nOk']} fail={r['nFail']}", flush=True)
    return {"ok": r["ok"], "reused": False, "bootstrap": r}


def write_status() -> dict:
    """生成 data/nl_status.json（本地写文件，不推送）。"""
    sys.path.insert(0, HERE)
    import nl_publish as P
    st = P.build_status()
    out = os.path.join(PROJECT, "data", "nl_status.json")
    os.makedirs(os.path.dirname(out), exist_ok=True)
    with open(out, "w", encoding="utf-8") as f:
        f.write(json.dumps(st, ensure_ascii=False, indent=1))
    return {"path": out, "generation": st["loop"]["generation"],
            "nTrials": st["loop"]["nTrials"],
            "passed": st["loop"]["passedAllGates"]}


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--generations", type=int, default=3)
    ap.add_argument("--n-eval", type=int, default=6)
    ap.add_argument("--n-folds", type=int, default=4)
    ap.add_argument("--no-bootstrap", action="store_true")
    a = ap.parse_args()

    ens = ensure_dataset(allow_bootstrap=not a.no_bootstrap)
    if not ens.get("ok"):
        print(f"[ci] 无可用数据集：{ens.get('reason')}")
        return 1

    from nlkit import loop as L
    res = L.run_loop(n_generations=a.generations, n_eval=a.n_eval, n_folds=a.n_folds,
                     verbose=True, publish=False)
    st = write_status()
    print(json.dumps({"generations": len(res["generations"]),
                      "elapsedMin": res["elapsedMin"],
                      "status": st}, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
