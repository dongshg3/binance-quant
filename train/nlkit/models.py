#!/usr/bin/env python3
# ============================================================
# nlkit/models.py · 非线性模型族（可搜索、可复现、可导出）
# ------------------------------------------------------------
# 原管线只有一条通路：8 个因子组得分 → 岭回归 → L1 权重。本模块把它扩成两类：
#
#   线性基座（对照，不能省）：
#     ridge            —— 与原管线同族的基准，用来回答"非线性到底有没有带来增量"
#
#   非线性族（本次要落地的东西）：
#     hgb   (HistGradientBoosting)  —— 直方图梯度提升，天然处理非线性与交互，
#                                      支持 NaN、快，是表格数据上的默认强手
#     et    (ExtraTrees)            —— 极端随机树，方差低，对噪声特征稳健
#     mlp   (神经网络)              —— 与树互补：树擅长分段常数，MLP 擅长平滑曲面
#     gated —— 状态门控：按 ADX/波动率把样本切桶，每桶独立训练一个 hgb/ridge。
#              这是原档案里"已测量却完全没用"的最大边际（ADX 高位 IC 是低位的 3.5 倍）。
#
# 一个必须说明的取舍：树/MLP 在 8 个高度共线的因子组得分上能榨出的增量有限。
# 所以本模块同时接原始特征矩阵（36 列，含多视野收益/形态/合约面），
# 让非线性有真实的交互素材；搜索空间里也包含"用哪一批特征"。
# ============================================================
from __future__ import annotations

import math

import numpy as np

FAMILIES = ("ridge", "hgb", "et", "mlp", "gated")

# 特征批次（用于搜索"喂哪一批"）：名称前缀
FEATURE_BATCHES = {
    "groups": ("g_",),                       # 原管线 8 组得分
    "price": ("ret", "distma", "rsi14", "posrange", "body", "wick_"),
    "vol": ("vol_ratio", "atr_ratio", "skew24", "kurt24", "volz", "dvol", "er"),
    "fut": ("fr_", "ls_", "doi_"),
    "regime": ("adx_n",),
}


def columns_for(names, batch: str) -> np.ndarray:
    """按批次名挑列索引；'all' 返回全部。"""
    if batch == "all":
        return np.arange(len(names))
    prefixes = FEATURE_BATCHES.get(batch)
    if prefixes is None:
        raise KeyError(f"未知特征批次 {batch!r}，可选 {list(FEATURE_BATCHES)} 或 'all'")
    idx = [i for i, n in enumerate(names) if n.startswith(prefixes)]
    return np.array(idx, dtype=int) if idx else np.arange(len(names))


# ---------------- 预处理 ----------------
# 关键纪律：训练时算出的预处理参数（中位数/均值/标准差）必须**随模型一起保存**，
# 预测时复用同一套。曾犯过的错是预测时用测试集自己的均值方差重新标准化 ——
# 那既是泄漏（用了测试集统计量），又让系数与训练时不在同一量纲上，结果必然错。
# 导出到前端时也用同一套参数，自证才能通过。
def _fit_prep(Xtr, kind: str) -> dict:
    X = np.asarray(Xtr, dtype=float)
    med = np.nanmedian(X, axis=0)
    med = np.where(np.isfinite(med), med, 0.0)
    prep = {"kind": kind, "med": med}
    if kind == "zm":
        A = np.where(np.isfinite(X), X, med)
        prep["mu"] = A.mean(axis=0)
        sd = A.std(axis=0)
        prep["sd"] = np.where(sd > 1e-9, sd, 1.0)
    return prep


def _apply_prep(X, prep: dict) -> np.ndarray:
    X = np.asarray(X, dtype=float)
    med = prep.get("med")
    if med is not None:
        X = np.where(np.isfinite(X), X, med)
    else:
        X = np.nan_to_num(X, nan=0.0)
    if prep.get("kind") == "zm":
        return (X - prep["mu"]) / prep["sd"]
    return X


def _prep_linear(Xtr, Xte):
    """（保留给外部调用的兼容封装）返回用训练折统计量标准化后的 (训练, 测试)。"""
    prep = _fit_prep(Xtr, "zm")
    return _apply_prep(Xtr, prep), _apply_prep(Xte, prep)


def _prep_tree(X):
    """树模型：NaN 在拟合前统一按列中位数补齐，使训练/预测/导出三处完全同口径。"""
    return np.asarray(X, dtype=np.float64)


# ---------------- 单模型拟合 ----------------
def _fit_ridge(Xtr, ytr, p, seed):
    prep = _fit_prep(Xtr, "zm")
    Z = _apply_prep(Xtr, prep)
    lam = float(p.get("lambda", 5.0))
    d = Z.shape[1]
    G = Z.T @ Z + lam * np.eye(d)
    b = Z.T @ ytr
    try:
        w = np.linalg.solve(G, b)
    except np.linalg.LinAlgError:
        w = np.linalg.lstsq(G, b, rcond=None)[0]
    return ("ridge", w, prep)


def _fit_single(family, Xtr, ytr, p, seed):
    if family == "ridge":
        return _fit_ridge(Xtr, ytr, p, seed)

    if family == "hgb":
        from sklearn.ensemble import HistGradientBoostingRegressor
        prep = _fit_prep(Xtr, "median")
        m = HistGradientBoostingRegressor(
            max_iter=int(p.get("maxIter", 300)),
            learning_rate=float(p.get("lr", 0.06)),
            max_depth=int(p["maxDepth"]) if p.get("maxDepth") else None,
            max_leaf_nodes=int(p.get("maxLeaf", 31)),
            min_samples_leaf=int(p.get("minLeaf", 200)),
            l2_regularization=float(p.get("l2", 1.0)),
            max_bins=int(p.get("maxBins", 128)),
            early_stopping=False,
            random_state=seed,
        )
        m.fit(_apply_prep(Xtr, prep), ytr)
        return ("hgb", m, prep)

    if family == "et":
        from sklearn.ensemble import ExtraTreesRegressor
        prep = _fit_prep(Xtr, "median")
        m = ExtraTreesRegressor(
            n_estimators=int(p.get("nTrees", 200)),
            max_depth=int(p["maxDepth"]) if p.get("maxDepth") else None,
            min_samples_leaf=int(p.get("minLeaf", 100)),
            max_features=p.get("maxFeatures", 0.5),
            n_jobs=-1,
            random_state=seed,
        )
        m.fit(_apply_prep(Xtr, prep), ytr)
        return ("et", m, prep)

    if family == "mlp":
        from sklearn.neural_network import MLPRegressor
        prep = _fit_prep(Xtr, "zm")
        hidden = tuple(int(h) for h in p.get("hidden", (64, 32)))
        m = MLPRegressor(
            hidden_layer_sizes=hidden,
            alpha=float(p.get("alpha", 1e-3)),
            learning_rate_init=float(p.get("lr", 1e-3)),
            batch_size=int(p.get("batch", 1024)),
            max_iter=int(p.get("maxIter", 40)),
            early_stopping=True,
            n_iter_no_change=5,
            validation_fraction=0.1,
            random_state=seed,
        )
        m.fit(_apply_prep(Xtr, prep), ytr)
        return ("mlp", m, prep)

    raise KeyError(family)


def _predict_single(model, Xte, p):
    """按模型自带的那套预处理参数预测（绝不重新从 Xte 估计）。"""
    kind, m, prep = model
    Z = _apply_prep(Xte, prep) if prep else np.nan_to_num(np.asarray(Xte, dtype=float), nan=0.0)
    if kind == "ridge":
        return Z @ m
    if kind in ("hgb", "et", "mlp"):
        return m.predict(Z)
    raise KeyError(kind)


# ---------------- 状态门控 ----------------
def _regime_bucket(regime_col, edges) -> np.ndarray:
    return np.digitize(np.asarray(regime_col, dtype=float), edges, right=False)


def fit_predict(spec: dict, Xtr, ytr, Xte, regime_tr=None, regime_te=None, seed: int = 7):
    """按 spec 训练并返回测试集预测。

    spec 字段：
      family      : ridge | hgb | et | mlp | gated
      featureBatch: all / groups / price / vol / fut / regime
      params      : 传给具体模型的超参
      nRegimes    : gated 专用，状态桶数（2~4）
      regimeVar   : gated 专用，用哪个 regime 列切桶（默认 adx）
    """
    family = spec.get("family", "hgb")
    p = dict(spec.get("params", {}))

    if family != "gated":
        if family == "ridge":
            return _predict_single(_fit_single("ridge", Xtr, ytr, p, seed), Xte, p)
        return _predict_single(_fit_single(family, Xtr, ytr, p, seed), Xte, p)

    # ---- gated：按状态分桶，各桶一个子模型 ----
    n_reg = int(spec.get("nRegimes", 2))
    inner = spec.get("inner", "hgb")
    rtr = np.asarray(regime_tr if regime_tr is not None else np.zeros(len(ytr)), dtype=float)
    rte = np.asarray(regime_te if regime_te is not None else np.zeros(len(Xte)), dtype=float)
    fin = np.isfinite(rtr)
    if fin.sum() < 500:
        return fit_predict({**spec, "family": inner}, Xtr, ytr, Xte, seed=seed)

    qs = np.linspace(0, 100, n_reg + 1)[1:-1]
    edges = np.percentile(rtr[fin], qs)
    edges = np.unique(edges)
    if len(edges) == 0:
        return fit_predict({**spec, "family": inner}, Xtr, ytr, Xte, seed=seed)

    btr = _regime_bucket(rtr, edges)
    bte = _regime_bucket(rte, edges)
    out = np.full(len(Xte), np.nan)
    glob_med = float(np.median(ytr))
    for b in range(len(edges) + 1):
        mtr = btr == b
        mte = bte == b
        if mtr.sum() < 300:
            continue
        # 子模型样本量偏小时回退到整个训练集，避免某个桶把噪声当规律
        if mtr.sum() < 3000:
            sub = _fit_single(inner, Xtr, ytr, p, seed)
        else:
            sub = _fit_single(inner, Xtr[mtr], ytr[mtr], p, seed)
        if mte.sum():
            out[mte] = _predict_single(sub, Xte[mte], p)
    # 没被任何桶覆盖的测试行 → 用全局模型兜底，绝不留 NaN
    if not np.all(np.isfinite(out)):
        g = _fit_single(inner, Xtr, ytr, p, seed)
        bad = ~np.isfinite(out)
        out[bad] = _predict_single(g, Xte[bad], p)
    if not np.any(np.isfinite(out)):
        out[:] = glob_med
    return out


# ---------------- 搜索空间 ----------------
def sample_spec(rng: np.random.Generator, names) -> dict:
    """从搜索空间里随机采一个配置。这是"自动迭代"每轮的输入。"""
    family = rng.choice(["hgb", "hgb", "et", "mlp", "gated", "gated", "ridge"],
                        p=[0.24, 0.16, 0.14, 0.10, 0.16, 0.10, 0.10])
    batch = str(rng.choice(["all", "all", "groups", "price", "vol", "fut"],
                           p=[0.34, 0.16, 0.14, 0.12, 0.12, 0.12]))
    spec = {"family": str(family), "featureBatch": batch, "params": {}}

    if spec["family"] == "ridge":
        spec["params"] = {"lambda": float(rng.choice([0.3, 1.0, 5.0, 20.0, 100.0]))}
    elif spec["family"] == "hgb":
        spec["params"] = {
            "maxIter": int(rng.choice([150, 250, 400, 600])),
            "lr": float(rng.choice([0.02, 0.04, 0.06, 0.10])),
            "maxLeaf": int(rng.choice([15, 31, 63, 127])),
            "minLeaf": int(rng.choice([50, 100, 200, 500, 1000])),
            "l2": float(rng.choice([0.1, 1.0, 5.0, 20.0])),
            "maxBins": int(rng.choice([64, 128, 255])),
        }
    elif spec["family"] == "et":
        spec["params"] = {
            "nTrees": int(rng.choice([100, 200, 400])),
            "maxDepth": int(rng.choice([6, 8, 12, 20])),
            "minLeaf": int(rng.choice([25, 50, 100, 300])),
            "maxFeatures": float(rng.choice([0.3, 0.5, 0.8])),
        }
    elif spec["family"] == "mlp":
        # 注意：numpy 2.x 不允许对"元素长度不齐的元组列表"直接 rng.choice（会报 inhomogeneous shape），
        # 必须先用整数索引取。
        grids = [(32,), (64,), (64, 32), (128, 64), (128, 64, 32)]
        hidden = grids[int(rng.integers(len(grids)))]
        spec["params"] = {
            "hidden": tuple(int(h) for h in hidden),
            "alpha": float(rng.choice([1e-4, 1e-3, 1e-2])),
            "lr": float(rng.choice([3e-4, 1e-3, 3e-3])),
            "maxIter": int(rng.choice([30, 50, 80])),
        }
    else:  # gated
        inner = str(rng.choice(["hgb", "hgb", "et", "ridge"], p=[0.4, 0.2, 0.2, 0.2]))
        spec["inner"] = inner
        spec["nRegimes"] = int(rng.choice([2, 3, 4]))
        spec["regimeCol"] = int(rng.choice([0, 1, 2], p=[0.5, 0.3, 0.2]))  # adx / vol_ratio / er
        ip = {}
        if inner == "hgb":
            ip = {"maxIter": int(rng.choice([150, 250, 400])),
                  "lr": float(rng.choice([0.03, 0.06, 0.1])),
                  "maxLeaf": int(rng.choice([15, 31, 63])),
                  "minLeaf": int(rng.choice([50, 200, 500])),
                  "l2": float(rng.choice([1.0, 5.0]))}
        elif inner == "et":
            ip = {"nTrees": int(rng.choice([100, 200])), "maxDepth": int(rng.choice([8, 12])),
                  "minLeaf": int(rng.choice([50, 100]))}
        else:
            ip = {"lambda": float(rng.choice([1.0, 5.0, 20.0]))}
        spec["params"] = ip

    if spec["family"] != "gated" and rng.random() < 0.25:
        # 让一部分配置走状态门控的外壳包住普通模型（"门控"本身是独立的一个假设）
        pass
    spec["trading"] = sample_trading(rng)
    return spec


# 交易层基因组：持有期 / 交易分位 / 标的池 / 单币上限。
# 这一层和模型层同等重要——前面已经实测到"毛收益 +1.9bp vs 成本 8.1bp"，
# 在不改变预测能力的前提下，仅靠拉长持有期与收窄交易分位就能把成本压下来。
TRADING_SPACE = {
    "holding": [4, 8, 12, 24],
    # topFrac 下探到 0.05：实测成本是每期 2.8bp(tf0.1) vs 8bp(tf0.4)，
    # 而信号强度只有 IC≈0.03，收窄交易范围是唯一能同时压低成本、提高每仓期望的旋钮。
    "topFrac": [0.05, 0.1, 0.2, 0.4, 1.0],
    "universe": ["crypto", "liquid", "all"],
    "maxWeight": [0.08, 0.15, 0.25],
    # 成本档：maker 挂单 0.02%/边 + 极小滑点，对做市/限价入场是可达的；
    # taker 吃单 0.05%/边 + 0.02% 滑点。让搜索自己回答"值不值得等挂单"。
    "costTier": ["maker", "taker"],
}


def sample_trading(rng: np.random.Generator) -> dict:
    return {
        "holding": int(rng.choice(TRADING_SPACE["holding"])),
        "topFrac": float(rng.choice(TRADING_SPACE["topFrac"])),
        "universe": str(rng.choice(TRADING_SPACE["universe"])),
        "maxWeight": float(rng.choice(TRADING_SPACE["maxWeight"])),
        "costTier": str(rng.choice(TRADING_SPACE["costTier"])),
        "gross": 1.0,
        "weighting": "demean",
    }


def mutate_trading(t: dict, rng: np.random.Generator) -> dict:
    out = dict(t or sample_trading(rng))
    if rng.random() < 0.45:
        out["holding"] = int(rng.choice(TRADING_SPACE["holding"]))
    if rng.random() < 0.45:
        out["topFrac"] = float(rng.choice(TRADING_SPACE["topFrac"]))
    if rng.random() < 0.35:
        out["universe"] = str(rng.choice(TRADING_SPACE["universe"]))
    if rng.random() < 0.35:
        out["maxWeight"] = float(rng.choice(TRADING_SPACE["maxWeight"]))
    if rng.random() < 0.35:
        out["costTier"] = str(rng.choice(TRADING_SPACE["costTier"]))
    return out


def spec_key(spec: dict) -> str:
    """稳定标识，用于 ledger 去重与复现。"""
    import hashlib
    import json as _json
    payload = _json.dumps(spec, sort_keys=True, default=str, ensure_ascii=False)
    return hashlib.sha256(payload.encode("utf-8")).hexdigest()[:16]


def mutate_spec(spec: dict, rng: np.random.Generator, names) -> dict:
    """进化算子：以一定概率换家族 / 换特征批次 / 扰动超参。"""
    child = {"family": spec.get("family", "hgb"),
             "featureBatch": spec.get("featureBatch", "all"),
             "params": dict(spec.get("params", {}))}
    if "inner" in spec:
        child["inner"] = spec["inner"]
        child["nRegimes"] = spec.get("nRegimes", 2)
        child["regimeCol"] = spec.get("regimeCol", 0)

    r = rng.random()
    if r < 0.15:
        return sample_spec(rng, names)          # 全新个体，保持种群多样性
    if r < 0.30:
        child["featureBatch"] = str(rng.choice(["all", "groups", "price", "vol", "fut"]))
    if r < 0.45:
        child["family"] = str(rng.choice(["hgb", "et", "mlp", "gated", "ridge"]))
        return sample_spec(rng, names)          # 换家族时直接重采该家族的超参
    p = child["params"]
    fam = child["family"]
    if fam == "hgb":
        if "maxLeaf" in p and rng.random() < 0.5:
            p["maxLeaf"] = int(np.clip(p["maxLeaf"] * rng.choice([0.5, 2.0]), 7, 255))
        if "lr" in p and rng.random() < 0.5:
            p["lr"] = float(np.clip(p["lr"] * rng.choice([0.5, 1.6]), 0.005, 0.3))
        if "minLeaf" in p and rng.random() < 0.5:
            p["minLeaf"] = int(np.clip(p["minLeaf"] * rng.choice([0.5, 2.0]), 20, 4000))
        if "l2" in p and rng.random() < 0.4:
            p["l2"] = float(np.clip(p["l2"] * rng.choice([0.3, 3.0]), 0.01, 200.0))
    elif fam == "et":
        if "maxDepth" in p and rng.random() < 0.5:
            p["maxDepth"] = int(np.clip(p["maxDepth"] + rng.integers(-3, 4), 3, 30))
        if "minLeaf" in p and rng.random() < 0.5:
            p["minLeaf"] = int(np.clip(p["minLeaf"] * rng.choice([0.5, 2.0]), 5, 2000))
    elif fam == "mlp":
        if "alpha" in p and rng.random() < 0.5:
            p["alpha"] = float(np.clip(p["alpha"] * rng.choice([0.3, 3.0]), 1e-6, 1.0))
    elif fam == "ridge":
        p["lambda"] = float(np.clip(p.get("lambda", 5.0) * rng.choice([0.3, 3.0]), 0.01, 1000.0))
    elif fam == "gated":
        if rng.random() < 0.5:
            child["nRegimes"] = int(np.clip(child.get("nRegimes", 2) + rng.integers(-1, 2), 2, 5))
        if rng.random() < 0.5:
            child["regimeCol"] = int(rng.integers(0, 3))
    child["trading"] = mutate_trading(spec.get("trading", {}), rng)
    return child
