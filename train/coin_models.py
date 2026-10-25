#!/usr/bin/env python3
"""Per-symbol adaptive models with purged walk-forward validation.

Every symbol receives an auditable artifact.  A coin model only becomes active
when its out-of-sample evidence beats its hierarchical parent.  Otherwise it
remains in shadow mode and the frontend keeps using the parent model.
"""
from __future__ import annotations

import os
import numpy as np


def _normalized(raw: np.ndarray, groups: list[str]) -> dict[str, float]:
    den = float(np.abs(raw).sum())
    if not np.isfinite(den) or den <= 1e-12:
        return {g: 0.0 for g in groups}
    return {g: float(raw[i] / den) for i, g in enumerate(groups)}


def _ridge(Xtr: np.ndarray, ytr: np.ndarray, Xte: np.ndarray, lam: float = 5.0):
    mu = Xtr.mean(axis=0)
    sd = Xtr.std(axis=0)
    sd = np.where(sd > 1e-9, sd, 1.0)
    Ztr = (Xtr - mu) / sd
    Zte = (Xte - mu) / sd
    d = Ztr.shape[1]
    A = Ztr.T @ Ztr + lam * np.eye(d)
    try:
        w = np.linalg.solve(A, Ztr.T @ ytr)
    except np.linalg.LinAlgError:
        w = np.linalg.lstsq(A, Ztr.T @ ytr, rcond=None)[0]
    return Zte @ w, w / sd


def _window_ics(pred: np.ndarray, y: np.ndarray, spearman, window: int = 64):
    out = []
    for lo in range(0, len(y), window):
        p = pred[lo:lo + window]
        r = y[lo:lo + window]
        if len(r) >= 32 and np.std(p) > 1e-12 and np.std(r) > 1e-12:
            ic = spearman(p, r)
            if ic is not None and np.isfinite(ic):
                out.append(float(ic))
    return out


def _fit_hgb(Xtr: np.ndarray, ytr: np.ndarray):
    from nlkit.models import _fit_single
    params = {
        "maxIter": int(os.environ.get("TQ_COIN_HGB_TREES", "48")),
        "lr": 0.05,
        "maxLeaf": 7,
        "minLeaf": 80,
        "l2": 5.0,
        "maxBins": 64,
    }
    return _fit_single("hgb", Xtr, ytr, params, 17)


def train_all_coin_models(*, X, y, ss, tt, nn, symbol_meta, parent_weights_of,
                          spearman, newey_west_t, groups, embargo=200,
                          hgb_enabled=True):
    """Train and validate all symbols; return a frontend-compatible dictionary.

    Folds cover only the last 30% of each symbol's history.  The parent model
    was trained on the first 70%, so parent comparisons remain out-of-sample.
    Each fold trains strictly before its test block with a purge gap.
    """
    out = {}
    X = np.asarray(X, dtype=np.float64)
    y = np.asarray(y, dtype=np.float64)
    ss = np.asarray(ss)
    tt = np.asarray(tt, dtype=np.float64)
    nn = np.asarray(nn, dtype=np.float64)
    d = len(groups)

    for sym in np.unique(ss):
        sym = str(sym)
        mask = ss == sym
        Xc, yc = X[mask], y[mask]
        frac = tt[mask] / nn[mask]
        parent = parent_weights_of(sym)
        parent_vec = np.asarray([float(parent.get(g, 0.0)) for g in groups])
        base = {
            "weights": {g: float(parent.get(g, 0.0)) for g in groups},
            "scoreScale": 1.0,
            "status": "warmup",
            "modelType": "hierarchical-parent",
            "ic": None, "t": None, "n": 0,
            "foldICs": [], "parentIC": None, "deltaIC": None,
            "hgbBlend": 0.0,
        }
        if len(yc) < 1700:
            base["reason"] = "历史样本不足 1700 bar，继续积累并沿用父模型"
            out[sym] = base
            continue

        fold_data = []
        for lo, hi in ((0.70, 0.80), (0.80, 0.90), (0.90, 1.001)):
            emb = embargo / max(float(np.nanmedian(nn[mask])), 1.0)
            tr = frac < lo - emb
            te = (frac >= lo) & (frac < hi)
            if tr.sum() < 1200 or te.sum() < 80:
                continue
            Xtr, ytr, Xte, yte = Xc[tr], yc[tr], Xc[te], yc[te]

            # Empirical-Bayes shrinkage: more history permits more coin-specific
            # deviation, while short/noisy histories stay close to the parent.
            shrink = float(np.clip(len(ytr) / (len(ytr) + 4000.0), 0.20, 0.68))
            _, w_raw = _ridge(Xtr, ytr, Xte[:1])
            own = _normalized(w_raw, groups)
            blend_weights = {
                g: shrink * own[g] + (1.0 - shrink) * float(parent.get(g, 0.0))
                for g in groups
            }
            wv = np.asarray([blend_weights[g] for g in groups])
            pred_r = Xte @ wv
            pred_parent = Xte @ parent_vec

            pred_h = None
            if hgb_enabled:
                try:
                    from nlkit.models import _predict_single
                    hm = _fit_hgb(Xtr, ytr)
                    pred_h = _predict_single(hm, Xte, {})
                except Exception:
                    pred_h = None
            fold_data.append({
                "y": yte, "ridge": pred_r, "parent": pred_parent,
                "hgb": pred_h, "shrink": shrink,
                "trainMaxFrac": float(np.max(frac[tr])), "testMinFrac": float(np.min(frac[te])),
                "trainN": int(tr.sum()), "testN": int(te.sum()),
            })

        if len(fold_data) < 2:
            base["reason"] = "可用时间外推折数不足，沿用父模型"
            out[sym] = base
            continue

        yo = np.concatenate([f["y"] for f in fold_data])
        pr = np.concatenate([f["ridge"] for f in fold_data])
        pp = np.concatenate([f["parent"] for f in fold_data])
        have_hgb = all(f["hgb"] is not None for f in fold_data)
        ph = np.concatenate([f["hgb"] for f in fold_data]) if have_hgb else None

        lr_scale = float(np.std(pr)) or 1.0
        h_scale = (float(np.std(ph)) if ph is not None else 0.0) or 1.0
        ridge_z = pr / max(lr_scale, 1e-12)
        hgb_z = ph / max(h_scale, 1e-12) if ph is not None else None
        bounds = np.cumsum([0] + [len(f["y"]) for f in fold_data])

        def fold_ics(pred):
            vals = []
            for i in range(len(fold_data)):
                a, b = bounds[i], bounds[i + 1]
                ic = spearman(pred[a:b], yo[a:b])
                vals.append(float(ic) if ic is not None and np.isfinite(ic) else 0.0)
            return vals

        ridge_folds = fold_ics(ridge_z)
        parent_folds = fold_ics(pp)
        best_blend, best_folds = 0.0, ridge_folds
        if hgb_z is not None:
            for b in (0.25, 0.50, 0.75, 1.0):
                cand = (1.0 - b) * ridge_z + b * hgb_z
                cand_folds = fold_ics(cand)
                # A challenger must improve the mean and not rely on one fold.
                wins = sum(c >= r - 0.002 for c, r in zip(cand_folds, ridge_folds))
                if (np.mean(cand_folds) > np.mean(best_folds) + 0.004 and wins >= 2):
                    best_blend, best_folds = b, cand_folds

        selected = (1.0 - best_blend) * ridge_z + best_blend * hgb_z if best_blend else ridge_z
        ic = spearman(selected, yo)
        parent_ic = spearman(pp, yo)
        ic = float(ic) if ic is not None and np.isfinite(ic) else 0.0
        parent_ic = float(parent_ic) if parent_ic is not None and np.isfinite(parent_ic) else 0.0
        nw = newey_west_t(_window_ics(selected, yo, spearman))
        nw = float(nw) if nw is not None and np.isfinite(nw) else 0.0
        positive_folds = sum(v > 0 for v in best_folds)
        delta = ic - parent_ic
        active = bool(ic >= 0.02 and nw >= 2.0 and positive_folds >= 2 and delta >= 0.002)

        # Final deployment fit uses all currently available history.  Metrics
        # above remain strictly walk-forward and are not recomputed in-sample.
        shrink = float(np.clip(len(yc) / (len(yc) + 4000.0), 0.20, 0.68))
        _, final_raw = _ridge(Xc, yc, Xc[:1])
        own_final = _normalized(final_raw, groups)
        final_weights = {
            g: shrink * own_final[g] + (1.0 - shrink) * float(parent.get(g, 0.0))
            for g in groups
        }
        final_vec = np.asarray([final_weights[g] for g in groups])
        final_linear = Xc @ final_vec
        final_lr_scale = float(np.std(final_linear)) or 1.0

        reasons = []
        if ic < 0.02: reasons.append("OOS IC 未达 0.02")
        if nw < 2.0: reasons.append("NW t 未达 2.0")
        if positive_folds < 2: reasons.append("正 IC 折数不足")
        if delta < 0.002: reasons.append("未显著优于父模型")

        rec = {
            "weights": {g: round(final_weights[g], 6) for g in groups},
            "scoreScale": round(max(final_lr_scale, 1e-8), 8),
            "linearScale": round(max(final_lr_scale, 1e-8), 8),
            "status": "active" if active else "shadow",
            "modelType": "hgb-ridge-ensemble" if best_blend else "adaptive-ridge",
            "ic": round(ic, 4), "t": round(nw, 2), "n": int(len(yo)),
            "foldICs": [round(v, 4) for v in best_folds],
            "folds": [{"trainN": f["trainN"], "testN": f["testN"],
                       "trainMaxFrac": round(f["trainMaxFrac"], 5), "testMinFrac": round(f["testMinFrac"], 5)}
                      for f in fold_data],
            "parentIC": round(parent_ic, 4), "deltaIC": round(delta, 4),
            "shrinkage": round(shrink, 4),
            "hgbBlend": float(best_blend),
            "reason": "通过多折时间外推与父模型增量门槛" if active else "；".join(reasons),
        }

        if active and best_blend > 0 and have_hgb:
            try:
                from nlkit.models import _predict_single
                from nlkit.export import _model_to_ast, ast_eval
                final_hgb = _fit_hgb(Xc, yc)
                final_hp = _predict_single(final_hgb, Xc, {})
                final_h_scale = float(np.std(final_hp)) or 1.0
                ast = _model_to_ast("hgb", final_hgb, list(range(d)))
                idx = np.linspace(0, len(Xc) - 1, min(96, len(Xc)), dtype=int)
                got = np.asarray([ast_eval(ast, Xc[i]) for i in idx])
                err = float(np.max(np.abs(got - final_hp[idx])))
                if not np.isfinite(err) or err > 1e-4:
                    raise RuntimeError(f"AST parity {err:.3g}")
                final_combined = ((1.0 - best_blend) * final_linear / max(final_lr_scale, 1e-12)
                                  + best_blend * final_hp / max(final_h_scale, 1e-12))
                rec.update({
                    "ast": ast,
                    "hgbScale": round(max(final_h_scale, 1e-8), 8),
                    "scoreScale": round(max(float(np.std(final_combined)), 1e-8), 8),
                    "selfCheck": {"n": int(len(idx)), "maxAbsErr": err},
                })
            except Exception as exc:
                # 导出失败时不能让线性回退冒用非线性模型的验证成绩。
                rec["status"] = "shadow"
                rec["modelType"] = "adaptive-ridge"
                rec["hgbBlend"] = 0.0
                rec["reason"] = "非线性模型导出对拍失败，已停用并回退父模型"
                rec["exportFallback"] = f"{type(exc).__name__}: {exc}"

        out[sym] = rec

    active_n = sum(r.get("status") == "active" for r in out.values())
    hgb_n = sum(r.get("status") == "active" and r.get("hgbBlend", 0) > 0 for r in out.values())
    print(f"[train] 逐币覆盖: {len(out)} · 晋级 {active_n} · 影子 {len(out)-active_n} · 非线性 {hgb_n}")
    return out
