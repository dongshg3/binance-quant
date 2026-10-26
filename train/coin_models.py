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


def _window_ics(pred: np.ndarray, y: np.ndarray, spearman, window: int = 32):
    """Local IC series with enough windows for the production HAC test.

    A 64-bar window produced only 18 observations on the current 1175-bar OOS
    path, while newey_west_t requires 30 and therefore returned None for every
    coin.  Thirty-two bars retain a meaningful local rank sample and yield 36
    windows on that path; the t >= 2 promotion threshold remains unchanged.
    """
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


def _fit_offset_ridge(Xtr, ytr, Xte, parent_vec, shrink, groups):
    """Fit coin-specific residuals around a fixed hierarchical parent.

    The parent is an offset rather than a prediction target: the coin only
    learns deviations that its own history supports.  Shrinkage limits those
    deviations without refitting or weakening the parent with future data.
    """
    parent_vec = np.asarray(parent_vec, dtype=np.float64)
    residual_y = ytr - Xtr @ parent_vec
    _, residual_raw = _ridge(Xtr, residual_y, Xte[:1])
    residual = _normalized(residual_raw, groups)
    residual_vec = np.asarray([residual[g] for g in groups])
    weights = parent_vec + float(shrink) * residual_vec
    return Xte @ weights, weights


def _safe_ic(pred, y, spearman):
    value = spearman(pred, y)
    return float(value) if value is not None and np.isfinite(value) else 0.0


def _choose_blend(history, spearman):
    """Choose HGB weight using only completed, strictly earlier OOS folds."""
    if not history or any(f.get("hgbZ") is None for f in history):
        return 0.0
    ridge_folds = [_safe_ic(f["ridgeZ"], f["y"], spearman) for f in history]
    ridge_mean = float(np.mean(ridge_folds))
    candidates = []
    for blend in (0.25, 0.50, 0.75, 1.0):
        ics = [
            _safe_ic((1.0 - blend) * f["ridgeZ"] + blend * f["hgbZ"], f["y"], spearman)
            for f in history
        ]
        candidates.append((float(np.mean(ics)), blend, ics))
    best_mean, best_blend, best_folds = max(candidates, key=lambda row: row[0])
    wins = sum(c >= r - 0.002 for c, r in zip(best_folds, ridge_folds))
    required_wins = max(1, int(np.ceil(len(history) * 2.0 / 3.0)))
    if best_mean <= ridge_mean + 0.004 or wins < required_wins:
        return 0.0
    return float(best_blend)


def train_all_coin_models(*, X, y, ss, tt, nn, symbol_meta, parent_weights_of,
                          spearman, newey_west_t, groups, embargo=200,
                          hgb_enabled=True):
    """Train every coin with purged, prequential model selection.

    Folds cover only the last 30% of each symbol's history.  The parent model
    was trained on the first 70%, so parent comparisons remain out-of-sample.
    Fold one always uses Ridge; each later fold selects its HGB blend only
    from earlier folds.  Promotion metrics therefore never score the same OOS
    predictions that were used to choose that fold's challenger weight.
    """
    out = {}
    X = np.asarray(X, dtype=np.float64)
    y = np.asarray(y, dtype=np.float64)
    ss = np.asarray(ss)
    tt = np.asarray(tt, dtype=np.float64)
    nn = np.asarray(nn, dtype=np.float64)
    d = len(groups)
    validation_mode = "purged-prequential-nested-blend-v1"

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
            "hgbBlend": 0.0, "blendPath": [], "factorIC": {},
            "validationMode": validation_mode,
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

            # Empirical-Bayes shrinkage on the residual around the parent.
            shrink = float(np.clip(len(ytr) / (len(ytr) + 4000.0), 0.20, 0.68))
            pred_r, wv = _fit_offset_ridge(Xtr, ytr, Xte, parent_vec, shrink, groups)
            pred_parent = Xte @ parent_vec
            # Scaling is estimated on training predictions only; test-fold
            # dispersion is never allowed to influence the validation score.
            lr_scale = max(float(np.std(Xtr @ wv)), 1e-12)
            ridge_z = pred_r / lr_scale

            hgb_z = None
            if hgb_enabled:
                try:
                    from nlkit.models import _predict_single
                    hm = _fit_hgb(Xtr, ytr)
                    pred_h = _predict_single(hm, Xte, {})
                    train_h = _predict_single(hm, Xtr, {})
                    h_scale = max(float(np.std(train_h)), 1e-12)
                    hgb_z = pred_h / h_scale
                except Exception:
                    hgb_z = None
            fold_data.append({
                "y": yte, "ridgeZ": ridge_z, "parent": pred_parent,
                "hgbZ": hgb_z, "shrink": shrink,
                "factor": [Xte[:, j] for j in range(d)],
                "trainMaxFrac": float(np.max(frac[tr])), "testMinFrac": float(np.min(frac[te])),
                "trainN": int(tr.sum()), "testN": int(te.sum()),
            })

        if len(fold_data) < 2:
            base["reason"] = "可用时间外推折数不足，沿用父模型"
            out[sym] = base
            continue

        # Prequential/nested selection: a fold cannot see itself or the future.
        blend_path = []
        for i, fold in enumerate(fold_data):
            blend = _choose_blend(fold_data[:i], spearman) if i else 0.0
            fold["selectedZ"] = ((1.0 - blend) * fold["ridgeZ"] + blend * fold["hgbZ"]
                                 if blend else fold["ridgeZ"])
            blend_path.append({"fold": i + 1, "blend": float(blend), "basedOnFolds": i})
        best_blend = _choose_blend(fold_data, spearman) if hgb_enabled else 0.0
        have_hgb = all(f["hgbZ"] is not None for f in fold_data)
        if not have_hgb:
            best_blend = 0.0

        yo = np.concatenate([f["y"] for f in fold_data])
        pr = np.concatenate([f["ridgeZ"] for f in fold_data])
        pp = np.concatenate([f["parent"] for f in fold_data])
        selected = np.concatenate([f["selectedZ"] for f in fold_data])
        best_folds = [_safe_ic(f["selectedZ"], f["y"], spearman) for f in fold_data]
        parent_folds = [_safe_ic(f["parent"], f["y"], spearman) for f in fold_data]
        factor_ic = {
            g: round(_safe_ic(np.concatenate([f["factor"][j] for f in fold_data]), yo, spearman), 4)
            for j, g in enumerate(groups)
        }

        ic = _safe_ic(selected, yo, spearman)
        parent_ic = _safe_ic(pp, yo, spearman)
        ridge_ic = _safe_ic(pr, yo, spearman)
        nw = newey_west_t(_window_ics(selected, yo, spearman))
        nw = float(nw) if nw is not None and np.isfinite(nw) else 0.0
        positive_folds = sum(v > 0 for v in best_folds)
        delta = ic - parent_ic
        active = bool(ic >= 0.02 and nw >= 2.0 and positive_folds >= 2 and delta >= 0.002)

        # Final deployment fit uses all currently available history.  Metrics
        # above remain prequential OOS and are never recomputed in-sample.
        shrink = float(np.clip(len(yc) / (len(yc) + 4000.0), 0.20, 0.68))
        _, final_vec = _fit_offset_ridge(Xc, yc, Xc[:1], parent_vec, shrink, groups)
        final_weights = {g: float(final_vec[j]) for j, g in enumerate(groups)}
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
            "modelType": "hgb-ridge-ensemble" if best_blend else "offset-ridge",
            "ic": round(ic, 4), "t": round(nw, 2), "n": int(len(yo)),
            "foldICs": [round(v, 4) for v in best_folds],
            "folds": [{"trainN": f["trainN"], "testN": f["testN"],
                       "trainMaxFrac": round(f["trainMaxFrac"], 5), "testMinFrac": round(f["testMinFrac"], 5)}
                      for f in fold_data],
            "parentIC": round(parent_ic, 4), "parentFoldICs": [round(v, 4) for v in parent_folds],
            "ridgeIC": round(ridge_ic, 4), "deltaIC": round(delta, 4),
            "shrinkage": round(shrink, 4),
            "hgbBlend": float(best_blend), "blendPath": blend_path,
            "factorIC": factor_ic, "validationMode": validation_mode,
            "reason": "通过无前视多折验证与父模型增量门槛" if active else "；".join(reasons),
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
                rec["modelType"] = "offset-ridge"
                rec["hgbBlend"] = 0.0
                rec["reason"] = "非线性模型导出对拍失败，已停用并回退父模型"
                rec["exportFallback"] = f"{type(exc).__name__}: {exc}"

        out[sym] = rec

    active_n = sum(r.get("status") == "active" for r in out.values())
    hgb_n = sum(r.get("status") == "active" and r.get("hgbBlend", 0) > 0 for r in out.values())
    print(f"[train] 逐币覆盖: {len(out)} · 晋级 {active_n} · 影子 {len(out)-active_n} · 非线性 {hgb_n}")
    return out
