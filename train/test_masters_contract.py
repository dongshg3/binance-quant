import math
import sys
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "train"))
import train as train_engine  # noqa: E402
import arena_tick as arena  # noqa: E402

GROUPS = train_engine.GROUPS


class MastersContractTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.masters = arena.load_masters()

    def test_exactly_fifty_unique_profiles(self):
        self.assertEqual(len(self.masters), 50)
        self.assertEqual(len({m["id"] for m in self.masters}), 50)
        self.assertEqual(len({m["name"] for m in self.masters}), 50)

    def test_every_profile_has_analysis_failures_and_sources(self):
        required = {"summary", "translation", "whyItWorks", "failureModes", "dataNeeds"}
        for m in self.masters:
            self.assertTrue(required <= set(m), m["id"])
            self.assertGreaterEqual(len(m["publicRules"]), 3, m["id"])
            self.assertGreaterEqual(len(m["failureModes"]), 2, m["id"])
            self.assertTrue(m["sources"], m["id"])
            for source in m["sources"]:
                self.assertRegex(source["url"], r"^https://", m["id"])

    def test_only_data_compatible_profiles_have_normalized_weights(self):
        eligible = [m for m in self.masters if m["eligibleForArena"]]
        self.assertEqual(len(eligible), 42)
        for m in self.masters:
            if not m["eligibleForArena"]:
                self.assertIsNone(m["weights"], m["id"])
                continue
            self.assertEqual(set(m["weights"]), set(GROUPS), m["id"])
            self.assertTrue(all(math.isfinite(v) for v in m["weights"].values()))
            self.assertAlmostEqual(sum(abs(v) for v in m["weights"].values()), 1.0)

    def test_pool_extension_preserves_existing_players(self):
        old = {"id": "legacy", "interval": "15m", "family": "trend", "status": "active"}
        state = {"players": [old]}
        arena.ensure_pools(state, None, self.masters)
        self.assertIs(state["players"][0], old)
        active_masters = [p for p in state["players"] if p["family"] == "master" and p["status"] == "active"]
        self.assertEqual(len(active_masters), 42 * 4)
        self.assertEqual(len({(p["interval"], p["masterId"]) for p in active_masters}), 42 * 4)
        self.assertTrue(all(p["translationVersion"] == 1 for p in active_masters))

    def test_archive_only_profiles_never_enter_pool(self):
        state = {"players": []}
        arena.ensure_pools(state, None, self.masters)
        ids = {p.get("masterId") for p in state["players"]}
        for m in self.masters:
            self.assertEqual(m["id"] in ids, m["eligibleForArena"], m["id"])

    def test_master_offspring_retains_identity(self):
        master = next(m for m in self.masters if m["eligibleForArena"])
        parent = arena.new_player("1h", "master", None, master=master)
        inherited = {"id": parent["masterId"], "name": parent["masterName"], "weights": parent["weights"]}
        child = arena.new_player("1h", "master", None, generation=1, parent=parent["id"], master=inherited)
        self.assertEqual(child["masterId"], master["id"])
        self.assertEqual(child["parentId"], parent["id"])
        child["weights"] = arena.mutate_weights(parent["weights"])
        self.assertAlmostEqual(sum(abs(v) for v in child["weights"].values()), 1.0)

    def test_minimum_sample_gate(self):
        self.assertLess(arena.rank_key({"n": 29, "tStat": 99}), 0)
        self.assertEqual(arena.rank_key({"n": 30, "tStat": 1.25}), 1.25)

    def test_no_live_trading_configuration(self):
        text = (ROOT / "train" / "arena_tick.py").read_text(encoding="utf-8")
        self.assertNotIn("create_order", text.lower())
        self.assertNotIn("api_secret", text.lower())
        workflow = (ROOT / ".github" / "workflows" / "arena.yml").read_text(encoding="utf-8")
        self.assertIn("python train/arena_tick.py", workflow)
        self.assertIn("5,20,35,50 * * * *", workflow)


if __name__ == "__main__":
    unittest.main()
