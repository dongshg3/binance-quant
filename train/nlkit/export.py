#!/usr/bin/env python3
# ============================================================
# nlkit/export.py · 把非线性模型导出成前端可执行的 JSON
# ------------------------------------------------------------
# 为什么需要这一层：线上站点的架构是「静态 JSON → 浏览器直连公开行情 → 本地求值」，
# 没有服务端推理。如果非线性模型只能跑在 Python 里，它就没法上线，
# 结果就是"训练端很先进、线上还在用 8 维线性权重"——这正是原系统的处境。
#
# 解法：把下面五种结构序列化成纯数据 + 一个几十行的 JS 求值器：
#   linear / trees(gbdt、随机森林) / mlp / gated(状态路由) / blend
# 浏览器不需要任何第三方库就能推理；模型文件依旧只是一份 JSON。
#
# 自证要求：导出后必须用同一批样本对比「Python 原始模型预测」与
# 「按导出 JSON 重新求值的预测」，最大绝对误差超阈值就直接报错拒绝导出。
# 不做这一步，导出就是个不敢信的翻译。
# ============================================================
from __future__ import annotations

import json
import math
import os
from datetime import datetime, timezone

import numpy as np

from . import models

MAX_ABS_ERR = 1e-4


def _jsonable(o):
    """把 numpy 标量/数组安全降级成内置类型，避免 json.dump 半路抛异常。"""
    if isinstance(o, np.ndarray):
        return o.tolist()
    if isinstance(o, (np.floating,)):
        return float(o)
    if isinstance(o, (np.integer,)):
        return int(o)
    if isinstance(o, (np.bool_,)):
        return bool(o)
    return str(o)


# ---------------- sklearn 树 → 节点数组 ----------------
def _sk_tree_to_nodes(tree) -> list[dict]:
    t = tree.tree_
    nodes = []
    for i in range(t.node_count):
        left = int(t.children_left[i])
        right = int(t.children_right[i])
        leaf = left == -1
        nodes.append({
            "f": int(t.feature[i]) if not leaf else -1,
            "t": float(t.threshold[i]) if not leaf else 0.0,
            "l": left, "r": right,
            "v": float(t.value[i].ravel()[0]),
            "leaf": bool(leaf),
        })
    return nodes


def _et_to_ast(m, cols: list[int], prep: dict) -> dict:
    trees = []
    for est in m.estimators_:
        trees.append({"nodes": _sk_tree_to_nodes(est)})
    n = len(trees)
    return {"type": "trees", "cols": cols, "prep": prep, "base": 0.0,
            "scale": 1.0 / max(n, 1), "trees": trees}


def _hgb_to_ast(m, cols: list[int], prep: dict) -> dict:
    trees = []
    for it in getattr(m, "_predictors", []):
        p = it[0] if isinstance(it, (list, tuple)) else it
        nodes_arr = getattr(p, "nodes", None)
        if nodes_arr is None:
            continue
        nodes = []
        for nd in nodes_arr:
            is_leaf = bool(nd["is_leaf"])
            nodes.append({
                "f": int(nd["feature_idx"]) if not is_leaf else -1,
                "t": float(nd["num_threshold"]) if not is_leaf else 0.0,
                "l": int(nd["left"]), "r": int(nd["right"]),
                "v": float(nd["value"]),
                "leaf": is_leaf,
            })
        trees.append({"nodes": nodes})
    base = getattr(m, "_baseline_prediction", 0.0)
    base = float(np.ravel(base)[0]) if base is not None else 0.0
    # 重要（已实测验证）：sklearn 的 HistGradientBoosting 在拟合时已把 learning_rate
    # 烘进叶值，预测时**不能**再乘一次。scale=1.0 时与 sklearn.predict 误差 1.1e-16；
    # 若乘 learning_rate 误差高达 0.71（曾让自证失败）。
    # NaN 已在训练前按列中位数补齐（见 models._fit_prep），导出侧不需要 missing 分支。
    return {"type": "trees", "cols": cols, "prep": prep, "base": base,
            "scale": 1.0, "trees": trees, "missingLeft": False}


def _ridge_to_ast(w, cols: list[int], prep: dict) -> dict:
    return {"type": "linear", "cols": cols, "prep": prep,
            "coef": [float(v) for v in w], "intercept": 0.0}


def _mlp_to_ast(m, cols: list[int], prep: dict) -> dict:
    return {"type": "mlp", "cols": cols, "prep": prep,
            "hidden": [int(h) for h in m.hidden_layer_sizes],
            "coefs": [[[float(v) for v in row] for row in W] for W in m.coefs_],
            "intercepts": [[float(v) for v in b] for b in m.intercepts_],
            "activation": "relu", "outActivation": "identity"}


def _prep_pack_from(prep: dict) -> dict:
    """把 models 里算好的预处理参数原样打包（必须原样，重算会与训练不一致）。"""
    out = {"kind": prep.get("kind", "median"),
           "med": [float(v) for v in np.nan_to_num(prep.get("med"), nan=0.0)]}
    if prep.get("kind") == "zm":
        out["mu"] = [float(v) for v in prep["mu"]]
        out["sd"] = [float(v) for v in prep["sd"]]
    else:
        out["mu"] = None
        out["sd"] = None
    return out


def _model_to_ast(kind: str, model, cols: list[int]) -> dict:
    """把 models._fit_single 返回的 (kind, estimator, prep) 转成可移植 AST。

    直接复用 sklearn 对象里**已经算好的**预处理参数——绝不在这里重算，
    否则训练与部署会差一套缩放系数（自证就是为了挡这个）。
    """
    got_kind, est, prep = model
    if got_kind != kind:
        raise RuntimeError(f"模型类型不一致: 期望 {kind}，实得 {got_kind}")
    packed = _prep_pack_from(prep)
    if kind == "ridge":
        return _ridge_to_ast(est, cols, packed)
    if kind == "mlp":
        return _mlp_to_ast(est, cols, packed)
    if kind == "et":
        return _et_to_ast(est, cols, packed)
    if kind == "hgb":
        return _hgb_to_ast(est, cols, packed)
    raise KeyError(kind)


# ---------------- Python 侧按 AST 求值（用于自证） ----------------
def _ast_apply_prep_row(ast: dict, row: np.ndarray) -> np.ndarray:
    """row 是「已经按 cols 取出的原始特征」；返回预处理后的向量。"""
    prep = ast.get("prep") or {}
    kind = prep.get("kind", "none")
    med = np.asarray(prep.get("med") or [], dtype=float)
    x = np.array(row, dtype=float)
    if kind == "none":
        return np.where(np.isfinite(x), x, 0.0)
    if med.size == x.size:
        x = np.where(np.isfinite(x), x, med)
    if kind == "zm":
        mu = np.asarray(prep.get("mu"), dtype=float)
        sd = np.asarray(prep.get("sd"), dtype=float)
        return (x - mu) / sd
    return x


def _ast_eval_sub(ast: dict, row: np.ndarray) -> float:
    x = _ast_apply_prep_row(ast, row)
    t = ast["type"]
    if t == "linear":
        return float(np.dot(np.asarray(ast["coef"], dtype=float), x) + ast.get("intercept", 0.0))
    if t == "trees":
        total = float(ast.get("base", 0.0))
        scale = float(ast.get("scale", 1.0))
        for tr in ast["trees"]:
            nodes = tr["nodes"]
            i = 0
            while True:
                nd = nodes[i]
                if nd["leaf"]:
                    break
                fi = nd["f"]
                # 必须用**预处理之后**的 x（已补中位数/已标准化）来走树，
                # 用原始 row 会导致 NaN 分支与训练时不一致（实测误差曾达 1.03）。
                v = x[fi] if 0 <= fi < len(x) else float("nan")
                if not np.isfinite(v):
                    if ast.get("missingLeft"):
                        i = nd["l"] if nd.get("ml", 1) else nd["r"]
                    else:
                        i = nd["r"]
                else:
                    i = nd["l"] if v <= nd["t"] else nd["r"]
            total += scale * nodes[i]["v"]
        return float(total)
    if t == "mlp":
        a = x
        coefs = ast["coefs"]
        biases = ast["intercepts"]
        for L in range(len(coefs)):
            z = np.asarray(coefs[L], dtype=float).T @ a + np.asarray(biases[L], dtype=float)
            a = np.maximum(z, 0.0) if L < len(coefs) - 1 else z
        return float(a.ravel()[0])
    raise KeyError(t)


def ast_eval(ast: dict, row_raw: np.ndarray) -> float:
    """按 AST 求值；gated 类型先按 regime 值路由。row_raw 是整行原始特征。"""
    if ast["type"] == "gated":
        ri = int(ast["regimeIdx"])
        rv = float(row_raw[ri]) if ri < len(row_raw) else float("nan")
        edges = ast["edges"]
        b = 0
        if np.isfinite(rv) and edges:
            # 必须与训练时的 np.digitize(rv, edges, right=False) 完全一致：
            # digitize 在 rv == edges[j] 时返回 j+1，对应 searchsorted(side="right")。
            b = int(np.searchsorted(edges, rv, side="right"))
            b = min(max(b, 0), len(ast["models"]) - 1)
        sub = ast["models"][b]
        if sub is None:
            sub = ast["fallback"]
        return _ast_eval_sub_passthrough(sub, row_raw)
    return _ast_eval_sub(ast, row_raw[ast["cols"]])


def _ast_eval_sub_passthrough(sub: dict, row_raw: np.ndarray) -> float:
    return _ast_eval_sub(sub, row_raw[sub["cols"]])


# ---------------- 用 AST 重建 sklearn 模型并自证 ----------------
def refit_and_export(spec: dict, ds, out_path: str, seed: int = 7) -> dict:
    """在全部可用样本上重训一次最佳配置，导出 AST，并自证误差合格。"""
    names = ds["meta"]["featureNames"]
    cols = models.columns_for(names, spec.get("featureBatch", "all"))
    X = np.asarray(ds["Fxs"], dtype=np.float64)
    y = np.asarray(ds["y"], dtype=np.float64)
    ok = np.isfinite(y)
    Xtr, ytr = X[ok], y[ok]
    regime = np.asarray(ds["regime"], dtype=np.float64)
    if regime.ndim == 1:
        regime = regime[:, None]
    rcol = min(int(spec.get("regimeCol", 0)), regime.shape[1] - 1)
    # 状态变量在「完整特征矩阵」里的列号。AST 求值拿到的是整行特征，
    # 所以必须存全局列号，不能存 regime 槽位号（曾因此把 vol_ratio 读成 atr_ratio）。
    rnames = ds["meta"].get("regimeNames") or []
    regime_global_col = names.index(rnames[rcol]) if rcol < len(rnames) and rnames[rcol] in names else -1

    family = spec.get("family", "hgb")
    p = dict(spec.get("params", {}))

    if family == "gated":
        ast = _build_gated_ast(spec, Xtr, ytr, regime[ok, rcol], cols, seed,
                               regime_global_col=regime_global_col)
    else:
        XS = Xtr[:, cols]
        sub = models._fit_single(family, XS, ytr, p, seed)
        ast = _model_to_ast(family, sub, cols)

    # ---- 自证：随机抽样对比 Python 原始预测 vs AST 求值 ----
    n_check = min(400, len(Xtr))
    rng = np.random.default_rng(seed)
    idx = rng.choice(len(Xtr), n_check, replace=False)
    ref = _reference_predict(spec, Xtr, ytr, regime[ok, rcol], Xtr[idx], regime[ok, rcol][idx], cols, seed)
    got = np.array([ast_eval(ast, Xtr[i]) for i in idx])
    err = float(np.max(np.abs(ref - got))) if len(got) else 0.0
    if not np.isfinite(err) or err > MAX_ABS_ERR:
        raise RuntimeError(f"导出自证失败：最大绝对误差 {err:.3e} > {MAX_ABS_ERR:.1e}，拒绝写出")

    payload = {
        "format": "nlmodel-1",
        "trainedAt": datetime.now(timezone.utc).isoformat(timespec="seconds"),
        "featureNames": names,
        "cols": [int(c) for c in cols],
        "featureBatch": spec.get("featureBatch", "all"),
        "family": family,
        "spec": spec,
        "selfCheck": {"nChecked": int(n_check), "maxAbsErr": err, "threshold": MAX_ABS_ERR},
        "ast": ast,
    }
    os.makedirs(os.path.dirname(os.path.abspath(out_path)), exist_ok=True)
    tmp = out_path + ".tmp"
    with open(tmp, "w", encoding="utf-8") as f:
        json.dump(payload, f, ensure_ascii=False, separators=(",", ":"), default=_jsonable)
    os.replace(tmp, out_path)
    return {"path": out_path, "bytes": os.path.getsize(out_path), "maxAbsErr": err,
            "family": family, "nCols": len(cols), "nTrain": int(len(ytr))}


def _reference_predict(spec, Xtr, ytr, rtr, Xte, rte, cols, seed) -> np.ndarray:
    return models.fit_predict(spec, Xtr[:, cols], ytr, Xte[:, cols],
                              regime_tr=rtr, regime_te=rte, seed=seed)


def _build_gated_ast(spec, Xtr, ytr, rtr, cols, seed, regime_global_col: int = 0) -> dict:
    """构造状态门控 AST。

    regime_global_col 是状态变量在**完整特征矩阵**里的列号（不是 0/1/2 的 regime 槽位号）。
    曾经写错成槽位号，导致 vol_ratio 被读成 atr_ratio，自证误差 1.02。
    """
    n_reg = int(spec.get("nRegimes", 2))
    inner = spec.get("inner", "hgb")
    p = dict(spec.get("params", {}))
    rcol = int(regime_global_col)
    XS = Xtr[:, cols]
    fin = np.isfinite(rtr)
    if fin.sum() < 500:
        sub = models._fit_single(inner, XS, ytr, p, seed)
        return {"type": "gated", "regimeIdx": rcol, "edges": [],
                "models": [_model_to_ast(inner, sub, cols)], "fallback": None}
    qs = np.linspace(0, 100, n_reg + 1)[1:-1]
    edges = np.unique(np.percentile(rtr[fin], qs))
    b = np.digitize(rtr, edges, right=False)
    subs = []
    for k in range(len(edges) + 1):
        m = b == k
        if m.sum() < 300:
            subs.append(None)
            continue
        use = m if m.sum() >= 3000 else np.ones(len(ytr), dtype=bool)
        sub = models._fit_single(inner, XS[use], ytr[use], p, seed)
        subs.append(_model_to_ast(inner, sub, cols))
    fall = models._fit_single(inner, XS, ytr, p, seed)
    return {"type": "gated", "regimeIdx": rcol, "edges": [float(e) for e in edges],
            "models": subs, "fallback": _model_to_ast(inner, fall, cols)}


# ---------------- 发布到 data/ ----------------
def publish(spec: dict, ds, data_dir: str, name: str = "model_nl.json") -> dict:
    out = os.path.join(data_dir, name)
    info = refit_and_export(spec, ds, out)
    info["publishedTo"] = out
    return info
