import math
import unittest

from futures_data import align_to_bars, funding_dynamics


class FundingDynamicsTest(unittest.TestCase):
    def test_minimum_event_count_and_causal_deltas(self):
        funding = [(i * 1000, i * 0.0001) for i in range(12)]
        dyn = funding_dynamics(funding)
        self.assertEqual(dyn[0], (None, None, None))
        self.assertIsNone(dyn[8][0])
        self.assertIsNotNone(dyn[9][0])
        self.assertAlmostEqual(dyn[1][1], 0.0001)
        self.assertAlmostEqual(dyn[2][2], 0.0)
        # 每个点只由自身前缀计算：截断历史不会改变过去结果。
        self.assertEqual(dyn[:7], funding_dynamics(funding[:7]))

    def test_window_is_90_funding_events_not_90_bars(self):
        funding = [(i * 8 * 3600 * 1000, (i - 50) * 0.00001) for i in range(120)]
        dyn = funding_dynamics(funding)
        hist = [r for _, r in funding[-90:]]
        mean = sum(hist) / 90
        sd = (sum((x - mean) ** 2 for x in hist) / 90) ** 0.5
        self.assertAlmostEqual(dyn[-1][0], (funding[-1][1] - mean) / sd)
        whole_mean = sum(r for _, r in funding) / 120
        whole_sd = (sum((r - whole_mean) ** 2 for _, r in funding) / 120) ** 0.5
        self.assertFalse(math.isclose(dyn[-1][0], (funding[-1][1] - whole_mean) / whole_sd))

    def test_bar_alignment_never_uses_future_event(self):
        funding = [(10_000, 0.001), (20_000, -0.001)]
        bars = [9_999, 10_000, 15_000, 20_000]
        aligned = align_to_bars(bars, funding, [])
        fr, ls, oi, fz, fd, fa = aligned
        self.assertEqual(fr, [None, 0.001, 0.001, -0.001])
        self.assertEqual(fd, [None, None, None, -0.002])
        self.assertEqual(fz, [None] * 4)  # 少于 10 次事件时保持中性
        self.assertEqual(ls, [None] * 4)
        self.assertEqual(oi, [None] * 4)
        self.assertEqual(fa, [None] * 4)

    def test_zero_variance_z_is_missing(self):
        funding = [(i, 0.0001) for i in range(10)]
        self.assertIsNone(funding_dynamics(funding)[-1][0])


if __name__ == '__main__':
    unittest.main()
