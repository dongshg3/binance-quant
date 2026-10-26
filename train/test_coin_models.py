import os
import sys
import unittest
from unittest.mock import patch

import numpy as np

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import coin_models


def spearman(a, b):
    a = np.asarray(a); b = np.asarray(b)
    ra = np.argsort(np.argsort(a)).astype(float)
    rb = np.argsort(np.argsort(b)).astype(float)
    if np.std(ra) == 0 or np.std(rb) == 0:
        return 0.0
    return float(np.corrcoef(ra, rb)[0, 1])


def nw_t(values):
    x = np.asarray(values, dtype=float)
    if len(x) < 2 or np.std(x) == 0:
        return 0.0
    return float(np.mean(x) / (np.std(x, ddof=1) / np.sqrt(len(x))))


def dataset(n=2400, weak=False, nonlinear=False):
    rng = np.random.default_rng(42)
    x = rng.normal(size=(n, 2))
    signal = np.sin(x[:, 0] * 2) if nonlinear else x[:, 0]
    y = rng.normal(size=n) if weak else signal + rng.normal(scale=0.12, size=n)
    return {
        "X": x, "y": y, "ss": np.asarray(["TESTUSDT"] * n),
        "tt": np.arange(n, dtype=float), "nn": np.full(n, n, dtype=float),
        "symbol_meta": {"TESTUSDT": {"cat": "major", "size": "large"}},
        "parent_weights_of": lambda _s: {"trend": 0.0, "momentum": 0.0},
        "spearman": spearman, "newey_west_t": nw_t, "groups": ["trend", "momentum"],
    }


class CoinModelTests(unittest.TestCase):
    def test_strong_weak_warmup_and_purged_folds(self):
        strong = coin_models.train_all_coin_models(**dataset(), hgb_enabled=False)["TESTUSDT"]
        self.assertEqual(strong["status"], "active")
        self.assertEqual(len(strong["folds"]), 3)
        for fold in strong["folds"]:
            self.assertLess(fold["trainMaxFrac"], fold["testMinFrac"])
            self.assertGreaterEqual(fold["testMinFrac"] - fold["trainMaxFrac"], 200 / 2400 - 1e-4)

        weak = coin_models.train_all_coin_models(**dataset(weak=True), hgb_enabled=False)["TESTUSDT"]
        self.assertEqual(weak["status"], "shadow")

        short = dataset(n=1000)
        warm = coin_models.train_all_coin_models(**short, hgb_enabled=False)["TESTUSDT"]
        self.assertEqual(warm["status"], "warmup")
        self.assertEqual(warm["n"], 0)

    def test_window_ics_support_production_newey_west(self):
        from nlkit.stats import newey_west_t as production_nw_t
        rng = np.random.default_rng(123)
        pred = rng.normal(size=1175)
        y = 0.5 * pred + rng.normal(size=1175)
        windows = coin_models._window_ics(pred, y, spearman)
        self.assertGreaterEqual(len(windows), 30)
        t_value = production_nw_t(windows)
        self.assertIsNotNone(t_value)
        self.assertTrue(np.isfinite(t_value))
        self.assertGreater(t_value, 0.0)

    def test_offset_ridge_matches_parent_plus_shrunk_residual(self):
        data = dataset()
        X, y = data["X"], data["y"]
        parent = np.asarray([0.25, -0.10])
        shrink = 0.4
        pred, weights = coin_models._fit_offset_ridge(
            X, y, X, parent, shrink, data["groups"])
        _, raw = coin_models._ridge(X, y - X @ parent, X[:1])
        residual = coin_models._normalized(raw, data["groups"])
        expected = parent + shrink * np.asarray([residual[g] for g in data["groups"]])
        np.testing.assert_allclose(weights, expected)
        np.testing.assert_allclose(pred, X @ expected)

    def test_blend_selection_is_prequential_and_evidence_is_exported(self):
        y = np.arange(8, dtype=float)
        ridge = np.random.default_rng(7).normal(size=8)
        bad = {"y": y, "ridgeZ": ridge, "hgbZ": -y}
        good = {"y": y, "ridgeZ": ridge, "hgbZ": y}
        self.assertEqual(coin_models._choose_blend([bad], spearman), 0.0)
        self.assertGreater(coin_models._choose_blend([bad, good, good], spearman), 0.0)

        rec = coin_models.train_all_coin_models(**dataset(), hgb_enabled=False)["TESTUSDT"]
        self.assertEqual(rec["validationMode"], "purged-prequential-nested-blend-v1")
        self.assertEqual([p["basedOnFolds"] for p in rec["blendPath"]], [0, 1, 2])
        self.assertEqual(rec["blendPath"][0]["blend"], 0.0)
        self.assertEqual(set(rec["factorIC"]), {"trend", "momentum"})
        self.assertIn("ridgeIC", rec)

    def test_failed_ast_export_cannot_reuse_hgb_metrics(self):
        with patch.object(coin_models, "_fit_hgb", return_value=object()), \
             patch("nlkit.models._predict_single", side_effect=lambda _m, x, _p: np.sin(x[:, 0] * 2)), \
             patch("nlkit.export._model_to_ast", side_effect=RuntimeError("forced parity failure")):
            rec = coin_models.train_all_coin_models(**dataset(nonlinear=True), hgb_enabled=True)["TESTUSDT"]
        self.assertEqual(rec["status"], "shadow")
        self.assertEqual(rec["hgbBlend"], 0.0)
        self.assertIn("exportFallback", rec)
        self.assertIn("对拍失败", rec["reason"])


if __name__ == "__main__":
    unittest.main()
