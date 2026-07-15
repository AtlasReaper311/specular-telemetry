import math
import tempfile
import unittest
from pathlib import Path
import sys

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from anomaly import AnomalyEngine, constrained_dtw


class AnomalyTests(unittest.TestCase):
    def snapshot(self, value, index):
        return {
            "cpu": {"overall_pct": value},
            "ram": {"pct": 42.0},
            "gpu": {
                "utilisation_pct": 20.0,
                "temperature_c": 47.0,
                "vram_used_mb": 2200.0,
            },
            "sampled_at": f"2026-07-15T12:{index // 60:02d}:{index % 60:02d}Z",
        }

    def test_constrained_dtw_prefers_similar_shapes(self):
        reference = [0, 1, 2, 3, 4, 5]
        similar = [0, 0.8, 2.1, 3.2, 4.1, 5.0]
        different = [5, 4, 3, 2, 1, 0]
        self.assertLess(
            constrained_dtw(reference, similar, radius=2),
            constrained_dtw(reference, different, radius=2),
        )

    def test_stable_signal_remains_normal_after_warmup(self):
        with tempfile.TemporaryDirectory() as tmp:
            engine = AnomalyEngine(
                Path(tmp) / "state.json",
                window=8,
                history_limit=128,
                persist_every=999,
            )
            states = []
            for index in range(80):
                value = 35.0 + math.sin(index / 5) * 0.4
                states.append(engine.observe(self.snapshot(value, index))["state"])
            self.assertNotIn("critical", states)
            self.assertEqual("normal", states[-1])

    def test_gradual_drift_warns_before_static_threshold(self):
        with tempfile.TemporaryDirectory() as tmp:
            engine = AnomalyEngine(
                Path(tmp) / "state.json",
                window=8,
                history_limit=160,
                persist_every=999,
            )
            for index in range(48):
                engine.observe(self.snapshot(35.0 + math.sin(index) * 0.2, index))
            warning_value = None
            for offset in range(48):
                value = 35.0 + offset * 0.65
                result = engine.observe(self.snapshot(value, 48 + offset))
                if result["state"] in {"warning", "critical"}:
                    warning_value = value
                    break
            self.assertIsNotNone(warning_value)
            self.assertLess(warning_value, 85.0)

    def test_single_spike_does_not_latch_critical(self):
        with tempfile.TemporaryDirectory() as tmp:
            engine = AnomalyEngine(
                Path(tmp) / "state.json",
                window=8,
                history_limit=160,
                persist_every=999,
            )
            for index in range(56):
                engine.observe(self.snapshot(30.0 + math.sin(index) * 0.2, index))
            spike = engine.observe(self.snapshot(95.0, 56))
            recovered = engine.observe(self.snapshot(30.1, 57))
            self.assertNotEqual("critical", spike["state"])
            self.assertNotEqual("critical", recovered["state"])

    def test_state_round_trip(self):
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / "state.json"
            first = AnomalyEngine(path, window=8, history_limit=128, persist_every=999)
            for index in range(30):
                first.observe(self.snapshot(25.0 + index * 0.02, index))
            first.persist()
            second = AnomalyEngine(path, window=8, history_limit=128, persist_every=999)
            self.assertEqual(
                len(first.detectors["cpu.overall_pct"].values),
                len(second.detectors["cpu.overall_pct"].values),
            )


if __name__ == "__main__":
    unittest.main()
