#!/usr/bin/env python3
# ============================================================
# auto_loop.py · 零 token 自动迭代入口（这是一个可以 7×24 挂着的进程）
# ------------------------------------------------------------
# 它不调用任何 LLM，每一轮迭代的成本只是本地 CPU 时间。
#
# 用法：
#   python train/auto_loop.py once                      # 跑 1 代（交互式看结果）
#   python train/auto_loop.py forever --interval 300    # 常驻：每代之间歇 5 分钟
#   python train/auto_loop.py budget --minutes 30       # 跑满 30 分钟就停（冒烟/夜间批）
#   python train/auto_loop.py refresh                   # 只刷新数据并重建特征
#   python train/auto_loop.py status                    # 看账本/冠军/历史
#
# 关键开关：
#   --n-eval N      每代评估多少配置（越大搜索越快，单代越久）
#   --n-folds K     Purged Walk-Forward 折数
#   --refresh       每代开始前先拉最新行情（联网，只读公开接口）
# ============================================================
from __future__ import annotations

import argparse
import json
import os
import sys
import time
from datetime import datetime, timezone

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

for _s in (sys.stdout, sys.stderr):
    try:
        _s.reconfigure(encoding="utf-8", errors="replace")
    except Exception:
        pass

from nlkit import loop  # noqa: E402


def cmd_once(args):
    r = loop.run_loop(n_generations=1, n_eval=args.n_eval, n_folds=args.n_folds,
                      oos_frac=args.oos_frac, seed=args.seed,
                      refresh_data=args.refresh, verbose=True, publish=not args.no_publish)
    g = r["generations"][0] if r["generations"] else {}
    print(json.dumps({"generation": g.get("generation"), "promoted": g.get("promoted"),
                      "pbo": (g.get("pbo") or {}).get("pbo"),
                      "nTrials": g.get("nTrials"),
                      "publish": g.get("publish"),
                      "elapsedMin": r["elapsedMin"]}, ensure_ascii=False))
    return 0


def cmd_forever(args):
    """常驻闭环：自动刷新行情 + 自动迭代 + 自动发布到 GitHub Pages。

    这一支是「用户零操作」的主路径：进程一起，剩下的全自动。
    """
    from nlkit import data as _data
    print(f"[auto_loop] 常驻启动 {datetime.now(timezone.utc).isoformat(timespec='seconds')} "
          f"interval={args.interval}s n_eval={args.n_eval} "
          f"refresh_hours={args.refresh_hours} publish={not args.no_publish}", flush=True)
    st = loop.load_state()
    ds = None
    cache_dir = os.path.join(loop.TRAIN_DIR, "cache_drift")
    while True:
        try:
            if args.refresh:
                age = loop._cache_age_hours(cache_dir)
                if age > args.refresh_hours:
                    print(f"[auto_loop] 行情缓存 {age:.1f}h > {args.refresh_hours}h，先刷新", flush=True)
                    loop.refresh(verbose=True)
                    ds = None
                else:
                    print(f"[auto_loop] 行情缓存 {age:.1f}h，仍在有效期内，跳过刷新", flush=True)
            if ds is None:
                ds = _data.load_dataset()
            gen = loop.run_generation(ds, st, n_eval=args.n_eval, seed=args.seed,
                                      verbose=True, publish=not args.no_publish)
            print(f"[auto_loop] 第 {gen['generation']} 代完成，累计试错 {gen['nTrials']}，"
                  f"加冕={gen['promoted']}", flush=True)
        except KeyboardInterrupt:
            print("[auto_loop] 收到中断，退出", flush=True)
            return 0
        except Exception as e:
            print(f"[auto_loop] 本轮异常（继续下一轮）: {type(e).__name__}: {e}", flush=True)
            time.sleep(30)
            continue
        time.sleep(max(5, args.interval))


def cmd_budget(args):
    r = loop.run_loop(n_generations=args.max_generations, n_eval=args.n_eval,
                      budget_minutes=args.minutes, n_folds=args.n_folds,
                      oos_frac=args.oos_frac, seed=args.seed,
                      refresh_data=args.refresh, verbose=True, publish=not args.no_publish)
    print(json.dumps({"generations": len(r["generations"]),
                      "elapsedMin": r["elapsedMin"],
                      "state": {k: v for k, v in r["state"].items() if k != "history"}},
                     ensure_ascii=False, indent=1))
    return 0


def cmd_refresh(args):
    print(json.dumps(loop.refresh(verbose=True), ensure_ascii=False, indent=1))
    return 0


def cmd_status(args):
    st = loop.load_state()
    best = loop.load_best()
    led = loop.read_ledger()
    hof = loop.read_hall_of_fame(limit=5)
    print("=" * 62)
    print(f"代数 {st.get('generation')} · 累计试错 {st.get('nTrials')} · 启动 {st.get('startedAt')}")
    print(f"账本条目 {len(led)} · 名人堂 {len(hof)}")
    passed = [r for r in led if r.get("passed")]
    print(f"通过全部闸门的候选: {len(passed)}")
    if best:
        m = best.get("metrics", {})
        print("-" * 62)
        print("现任冠军（第 {} 代，{}）".format(best.get("generation"), best.get("at")))
        print(f"  配置   : {json.dumps(best['spec'], ensure_ascii=False)}")
        print(f"  XS IC  : {m.get('icXS')} (NW t {m.get('icNWt')})")
        print(f"  净每期 : {m.get('netMeanBp')} bp  净 Sharpe {m.get('netSharpe')}")
        print(f"  DSR    : {m.get('dsr')}   换手 {m.get('avgTurnover')}  PBO {best.get('pbo')}")
    else:
        print("-" * 62)
        print("尚无冠军：没有任何候选同时通过全部闸门（这是诚实的空态，不是故障）")
    print("-" * 62)
    print("最近 5 代：")
    for h in (st.get("history") or [])[-5:]:
        print(f"  g{h['generation']} 评估{h['nEval']} 过闸{h['nPassed']} "
              f"最佳Sharpe={h['topSharpe']} IC={h['topIC']} DSR={h['topDSR']} "
              f"PBO={h['pbo']} 加冕={h['promoted']} 家族={h['families']}")
    if led:
        print("-" * 62)
        print("历史最佳 8 条（按净 Sharpe）：")
        top = sorted([r for r in led if r.get("metrics", {}).get("netSharpe") is not None],
                     key=lambda r: r["metrics"]["netSharpe"], reverse=True)[:8]
        for r in top:
            m = r["metrics"]
            print(f"  g{r.get('generation')} {r['spec'].get('family'):5s}/{r['spec'].get('featureBatch'):6s} "
                  f"H{(r['spec'].get('trading') or {}).get('holding')} "
                  f"IC={m.get('icXS')} netBp={m.get('netMeanBp')} Sharpe={m.get('netSharpe')} "
                  f"DSR={m.get('dsr')} {'PASS' if r.get('passed') else ''}")
    print("=" * 62)
    return 0


def main():
    ap = argparse.ArgumentParser(description="零 token 自动迭代闭环")
    sub = ap.add_subparsers(dest="cmd", required=True)

    def common(p):
        p.add_argument("--n-eval", type=int, default=6, help="每代评估的配置数")
        p.add_argument("--n-folds", type=int, default=4, help="Purged WF 折数")
        p.add_argument("--oos-frac", type=float, default=0.45, help="样本外时间占比")
        p.add_argument("--seed", type=int, default=7)
        p.add_argument("--refresh", action="store_true",
                       help="自动拉最新行情（缓存超过 --refresh-hours 才真正重抓）")
        p.add_argument("--refresh-hours", type=float, default=6.0,
                       help="行情缓存有效期（小时），超期则清空重抓")
        p.add_argument("--no-publish", action="store_true",
                       help="关闭自动发布（默认开启：每代把状态推到 GitHub Pages）")

    p1 = sub.add_parser("once"); common(p1); p1.set_defaults(fn=cmd_once)
    p2 = sub.add_parser("forever"); common(p2)
    p2.add_argument("--interval", type=int, default=300, help="两代之间的等待秒数")
    p2.set_defaults(fn=cmd_forever)
    p3 = sub.add_parser("budget"); common(p3)
    p3.add_argument("--minutes", type=float, default=30.0)
    p3.add_argument("--max-generations", type=int, default=200)
    p3.set_defaults(fn=cmd_budget)
    p4 = sub.add_parser("refresh"); p4.set_defaults(fn=cmd_refresh)
    p5 = sub.add_parser("status"); p5.set_defaults(fn=cmd_status)

    args = ap.parse_args()
    return args.fn(args)


if __name__ == "__main__":
    raise SystemExit(main())
