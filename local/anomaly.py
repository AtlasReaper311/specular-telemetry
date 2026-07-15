"""Shape-aware telemetry anomaly detection for specular-telemetry.

The detector borrows three ideas from pitch tracking and sequence alignment:

* robust candidate evidence from several noisy features;
* continuity-aware state decoding so one bad sample does not become an alert;
* constrained DTW against historical normal motifs so shape changes matter before
  a static threshold is crossed.

The implementation is standard-library only. It is deterministic, persists a
bounded history, and exposes enough evidence for replay and explanation.
"""

from __future__ import annotations

import json
import math
import os
import statistics
from collections import deque
from dataclasses import dataclass, field
from datetime import datetime, timezone
from pathlib import Path
from typing import Iterable

STATES = ("normal", "watch", "warning", "critical")
STATE_RANK = {name: index for index, name in enumerate(STATES)}

TRANSITIONS = {
    "normal": {"normal": 0.94, "watch": 0.055, "warning": 0.004, "critical": 0.001},
    "watch": {"normal": 0.12, "watch": 0.74, "warning": 0.13, "critical": 0.01},
    "warning": {"normal": 0.02, "watch": 0.15, "warning": 0.76, "critical": 0.07},
    "critical": {"normal": 0.005, "watch": 0.025, "warning": 0.17, "critical": 0.80},
}


def utc_now() -> str:
    return datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")


def clamp(value: float, low: float, high: float) -> float:
    return max(low, min(high, value))


def sigmoid(value: float) -> float:
    if value >= 0:
        z = math.exp(-value)
        return 1.0 / (1.0 + z)
    z = math.exp(value)
    return z / (1.0 + z)


def median(values: Iterable[float], default: float = 0.0) -> float:
    data = list(values)
    return statistics.median(data) if data else default


def mad(values: Iterable[float], centre: float | None = None) -> float:
    data = list(values)
    if not data:
        return 0.0
    c = median(data) if centre is None else centre
    return median(abs(item - c) for item in data)


def robust_scale(values: list[float]) -> list[float]:
    if not values:
        return []
    centre = median(values)
    scale = max(1e-6, 1.4826 * mad(values, centre))
    return [(value - centre) / scale for value in values]


def derivative(values: list[float]) -> list[float]:
    if len(values) < 2:
        return [0.0] * len(values)
    return [0.0] + [values[index] - values[index - 1] for index in range(1, len(values))]


def linear_slope(values: list[float]) -> float:
    count = len(values)
    if count < 2:
        return 0.0
    x_mean = (count - 1) / 2.0
    y_mean = sum(values) / count
    numerator = sum((index - x_mean) * (value - y_mean) for index, value in enumerate(values))
    denominator = sum((index - x_mean) ** 2 for index in range(count))
    return numerator / denominator if denominator else 0.0


def constrained_dtw(left: list[float], right: list[float], radius: int = 4) -> float:
    """Return length-normalised DTW distance inside a Sakoe-Chiba band."""
    if not left or not right:
        return math.inf
    radius = max(radius, abs(len(left) - len(right)))
    previous = [math.inf] * (len(right) + 1)
    previous[0] = 0.0
    for i, lvalue in enumerate(left, start=1):
        current = [math.inf] * (len(right) + 1)
        start = max(1, i - radius)
        stop = min(len(right), i + radius)
        for j in range(start, stop + 1):
            cost = abs(lvalue - right[j - 1])
            current[j] = cost + min(current[j - 1], previous[j], previous[j - 1])
        previous = current
    return previous[-1] / max(len(left), len(right))


def autocorrelation(values: list[float], lag: int) -> float:
    if lag <= 0 or len(values) <= lag:
        return 0.0
    centre = sum(values) / len(values)
    left = [value - centre for value in values[:-lag]]
    right = [value - centre for value in values[lag:]]
    numerator = sum(a * b for a, b in zip(left, right))
    denominator = math.sqrt(sum(a * a for a in left) * sum(b * b for b in right))
    return numerator / denominator if denominator else 0.0


def emission_probabilities(score: float) -> dict[str, float]:
    """Map a continuous anomaly score to broad, overlapping state emissions."""
    centres = {"normal": 0.10, "watch": 0.38, "warning": 0.66, "critical": 0.90}
    widths = {"normal": 0.20, "watch": 0.20, "warning": 0.18, "critical": 0.14}
    raw = {
        state: math.exp(-0.5 * ((score - centres[state]) / widths[state]) ** 2)
        for state in STATES
    }
    total = sum(raw.values()) or 1.0
    return {state: raw[state] / total for state in STATES}


@dataclass
class MetricResult:
    metric: str
    state: str
    score: float
    confidence: float
    value: float
    baseline_median: float | None
    baseline_mad: float | None
    robust_z: float | None
    slope_z: float | None
    volatility_ratio: float | None
    dtw_distance: float | None
    periodicity: float | None
    warmup_remaining: int
    first_divergence_at: str | None
    observed_at: str

    def as_dict(self) -> dict:
        return {
            "metric": self.metric,
            "state": self.state,
            "score": round(self.score, 4),
            "confidence": round(self.confidence, 4),
            "value": round(self.value, 4),
            "baseline_median": None if self.baseline_median is None else round(self.baseline_median, 4),
            "baseline_mad": None if self.baseline_mad is None else round(self.baseline_mad, 4),
            "robust_z": None if self.robust_z is None else round(self.robust_z, 4),
            "slope_z": None if self.slope_z is None else round(self.slope_z, 4),
            "volatility_ratio": None if self.volatility_ratio is None else round(self.volatility_ratio, 4),
            "dtw_distance": None if self.dtw_distance is None else round(self.dtw_distance, 4),
            "periodicity": None if self.periodicity is None else round(self.periodicity, 4),
            "warmup_remaining": self.warmup_remaining,
            "first_divergence_at": self.first_divergence_at,
            "observed_at": self.observed_at,
        }


@dataclass
class MetricDetector:
    name: str
    window: int = 24
    history_limit: int = 512
    values: deque[float] = field(default_factory=lambda: deque(maxlen=512))
    times: deque[str] = field(default_factory=lambda: deque(maxlen=512))
    probabilities: dict[str, float] = field(
        default_factory=lambda: {"normal": 1.0, "watch": 0.0, "warning": 0.0, "critical": 0.0}
    )
    first_divergence_at: str | None = None

    def __post_init__(self) -> None:
        if self.values.maxlen != self.history_limit:
            self.values = deque(self.values, maxlen=self.history_limit)
        if self.times.maxlen != self.history_limit:
            self.times = deque(self.times, maxlen=self.history_limit)

    @property
    def warmup_samples(self) -> int:
        return self.window * 3

    def _reference_windows(self, history: list[float]) -> list[list[float]]:
        stop = len(history) - self.window * 2
        if stop < self.window:
            return []
        windows: list[list[float]] = []
        stride = max(1, self.window // 2)
        for end in range(self.window, stop + 1, stride):
            candidate = history[end - self.window : end]
            if len(candidate) == self.window:
                windows.append(candidate)
        if len(windows) <= 12:
            return windows
        step = (len(windows) - 1) / 11
        return [windows[round(index * step)] for index in range(12)]

    def _decode(self, score: float) -> tuple[str, float]:
        emissions = emission_probabilities(score)
        posterior: dict[str, float] = {}
        for target in STATES:
            prior = sum(
                self.probabilities[source] * TRANSITIONS[source][target]
                for source in STATES
            )
            posterior[target] = prior * emissions[target]
        total = sum(posterior.values()) or 1.0
        self.probabilities = {state: posterior[state] / total for state in STATES}
        state = max(STATES, key=self.probabilities.get)
        return state, self.probabilities[state]

    def observe(self, value: float, observed_at: str) -> MetricResult:
        self.values.append(float(value))
        self.times.append(observed_at)
        history = list(self.values)
        remaining = max(0, self.warmup_samples - len(history))
        if remaining:
            self.probabilities = {"normal": 1.0, "watch": 0.0, "warning": 0.0, "critical": 0.0}
            return MetricResult(
                metric=self.name,
                state="normal",
                score=0.0,
                confidence=1.0,
                value=value,
                baseline_median=None,
                baseline_mad=None,
                robust_z=None,
                slope_z=None,
                volatility_ratio=None,
                dtw_distance=None,
                periodicity=None,
                warmup_remaining=remaining,
                first_divergence_at=None,
                observed_at=observed_at,
            )

        active = history[-self.window :]
        baseline = history[: -self.window]
        baseline_median = median(baseline)
        baseline_mad = max(1e-6, 1.4826 * mad(baseline, baseline_median))
        robust_z = abs((value - baseline_median) / baseline_mad)

        active_slope = linear_slope(active)
        baseline_slopes = [
            linear_slope(baseline[index : index + self.window])
            for index in range(0, max(1, len(baseline) - self.window + 1), max(1, self.window // 2))
            if len(baseline[index : index + self.window]) == self.window
        ]
        slope_centre = median(baseline_slopes)
        slope_scale = max(1e-6, 1.4826 * mad(baseline_slopes, slope_centre))
        slope_z = abs((active_slope - slope_centre) / slope_scale)

        baseline_diff = derivative(baseline)
        active_diff = derivative(active)
        base_volatility = max(1e-6, median(abs(item) for item in baseline_diff))
        active_volatility = median(abs(item) for item in active_diff)
        volatility_ratio = active_volatility / base_volatility

        references = self._reference_windows(history)
        active_shape = robust_scale(active)
        active_derivative = derivative(active_shape)
        distances = []
        for reference in references:
            reference_shape = robust_scale(reference)
            level_distance = constrained_dtw(active_shape, reference_shape, radius=max(3, self.window // 6))
            slope_distance = constrained_dtw(
                active_derivative,
                derivative(reference_shape),
                radius=max(3, self.window // 6),
            )
            distances.append(0.35 * level_distance + 0.65 * slope_distance)
        dtw_distance = min(distances) if distances else 0.0
        periodicity = max(
            (abs(autocorrelation(active_shape, lag)) for lag in range(2, min(8, len(active_shape) - 1))),
            default=0.0,
        )

        z_component = sigmoid((robust_z - 2.5) / 1.2)
        slope_component = sigmoid((slope_z - 2.0) / 1.0)
        volatility_component = sigmoid((volatility_ratio - 1.8) / 0.8)
        dtw_component = sigmoid((dtw_distance - 0.75) / 0.30)
        active_diffs = derivative(active)
        matching = sum(
            1
            for item in active_diffs
            if item == 0 or active_slope == 0 or math.copysign(1, item) == math.copysign(1, active_slope)
        )
        persistence_component = clamp(matching / max(1, len(active_diffs)), 0.0, 1.0)

        score = clamp(
            0.24 * z_component
            + 0.27 * slope_component
            + 0.16 * volatility_component
            + 0.27 * dtw_component
            + 0.06 * persistence_component,
            0.0,
            1.0,
        )
        state, confidence = self._decode(score)

        if STATE_RANK[state] >= STATE_RANK["watch"]:
            if self.first_divergence_at is None:
                self.first_divergence_at = observed_at
        elif state == "normal" and confidence >= 0.70:
            self.first_divergence_at = None

        return MetricResult(
            metric=self.name,
            state=state,
            score=score,
            confidence=confidence,
            value=value,
            baseline_median=baseline_median,
            baseline_mad=baseline_mad,
            robust_z=robust_z,
            slope_z=slope_z,
            volatility_ratio=volatility_ratio,
            dtw_distance=dtw_distance,
            periodicity=periodicity,
            warmup_remaining=0,
            first_divergence_at=self.first_divergence_at,
            observed_at=observed_at,
        )

    def serialize(self) -> dict:
        return {
            "values": list(self.values),
            "times": list(self.times),
            "probabilities": self.probabilities,
            "first_divergence_at": self.first_divergence_at,
        }

    def restore(self, payload: dict) -> None:
        self.values = deque(
            (float(item) for item in payload.get("values", [])),
            maxlen=self.history_limit,
        )
        self.times = deque(
            (str(item) for item in payload.get("times", [])),
            maxlen=self.history_limit,
        )
        probabilities = payload.get("probabilities")
        if isinstance(probabilities, dict) and set(probabilities) == set(STATES):
            total = sum(float(probabilities[state]) for state in STATES)
            if total > 0:
                self.probabilities = {
                    state: float(probabilities[state]) / total for state in STATES
                }
        divergence = payload.get("first_divergence_at")
        self.first_divergence_at = str(divergence) if divergence else None


class AnomalyEngine:
    """Multi-metric detector with bounded persistence and replay evidence."""

    METRIC_PATHS = {
        "cpu.overall_pct": ("cpu", "overall_pct"),
        "ram.pct": ("ram", "pct"),
        "gpu.utilisation_pct": ("gpu", "utilisation_pct"),
        "gpu.temperature_c": ("gpu", "temperature_c"),
        "gpu.vram_used_mb": ("gpu", "vram_used_mb"),
    }

    def __init__(
        self,
        state_path: str | Path | None = None,
        *,
        window: int = 24,
        history_limit: int = 512,
        persist_every: int = 10,
    ) -> None:
        self.state_path = Path(state_path) if state_path else default_state_path()
        self.window = window
        self.history_limit = history_limit
        self.persist_every = max(1, persist_every)
        self.detectors = {
            name: MetricDetector(name, window=window, history_limit=history_limit)
            for name in self.METRIC_PATHS
        }
        self.recent: deque[dict] = deque(maxlen=192)
        self.observation_count = 0
        self.latest = {
            "schema": "specular-anomaly/v1",
            "state": "normal",
            "score": 0.0,
            "warmup": True,
            "metrics": {},
            "generated_at": utc_now(),
        }
        self._load()

    @staticmethod
    def _read_path(snapshot: dict, path: tuple[str, str]) -> float | None:
        current = snapshot
        for key in path:
            if not isinstance(current, dict) or key not in current:
                return None
            current = current[key]
        if isinstance(current, bool) or not isinstance(current, (int, float)):
            return None
        value = float(current)
        return value if math.isfinite(value) else None

    def observe(self, snapshot: dict) -> dict:
        observed_at = str(snapshot.get("sampled_at") or utc_now())
        metric_results: dict[str, dict] = {}
        for name, path in self.METRIC_PATHS.items():
            value = self._read_path(snapshot, path)
            if value is None:
                continue
            metric_results[name] = self.detectors[name].observe(value, observed_at).as_dict()

        if metric_results:
            ordered = sorted(
                metric_results.values(),
                key=lambda item: (STATE_RANK[item["state"]], item["score"]),
                reverse=True,
            )
            leading = ordered[0]
            state = leading["state"]
            score = max(item["score"] for item in ordered)
            warmup = all(item["warmup_remaining"] > 0 for item in ordered)
        else:
            state = "normal"
            score = 0.0
            warmup = True

        self.latest = {
            "schema": "specular-anomaly/v1",
            "state": state,
            "score": round(score, 4),
            "warmup": warmup,
            "metrics": metric_results,
            "generated_at": observed_at,
            "detector": {
                "window_samples": self.window,
                "history_limit": self.history_limit,
                "sample_interval_hint_seconds": 30,
                "method": "robust features + constrained derivative DTW + continuity decoder",
            },
        }
        self.recent.appendleft(self.latest)
        self.observation_count += 1
        if self.observation_count % self.persist_every == 0:
            self.persist()
        return self.latest

    def history(self, metric: str | None = None, limit: int = 96) -> list[dict]:
        limit = max(1, min(192, int(limit)))
        items = list(self.recent)[:limit]
        if not metric:
            return items
        filtered = []
        for item in items:
            result = item.get("metrics", {}).get(metric)
            if result:
                filtered.append(
                    {
                        "schema": item.get("schema"),
                        "state": result["state"],
                        "score": result["score"],
                        "generated_at": item.get("generated_at"),
                        "metric": result,
                    }
                )
        return filtered

    def persist(self) -> None:
        payload = {
            "schema": "specular-anomaly-state/v1",
            "saved_at": utc_now(),
            "detectors": {name: detector.serialize() for name, detector in self.detectors.items()},
            "recent": list(self.recent),
            "latest": self.latest,
        }
        try:
            self.state_path.parent.mkdir(parents=True, exist_ok=True)
            temporary = self.state_path.with_suffix(self.state_path.suffix + ".tmp")
            temporary.write_text(json.dumps(payload, separators=(",", ":")), encoding="utf-8")
            os.replace(temporary, self.state_path)
        except OSError:
            return

    def _load(self) -> None:
        try:
            payload = json.loads(self.state_path.read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError):
            return
        if payload.get("schema") != "specular-anomaly-state/v1":
            return
        for name, detector_payload in payload.get("detectors", {}).items():
            if name in self.detectors and isinstance(detector_payload, dict):
                self.detectors[name].restore(detector_payload)
        recent = payload.get("recent")
        if isinstance(recent, list):
            self.recent = deque(
                (item for item in recent if isinstance(item, dict)),
                maxlen=192,
            )
        latest = payload.get("latest")
        if isinstance(latest, dict):
            self.latest = latest


def default_state_path() -> Path:
    explicit = os.environ.get("ANOMALY_STATE_PATH")
    if explicit:
        return Path(explicit).expanduser()
    program_data = os.environ.get("PROGRAMDATA")
    if program_data:
        return Path(program_data) / "Atlas Systems" / "specular-telemetry" / "anomaly-state.json"
    state_home = os.environ.get("XDG_STATE_HOME")
    base = Path(state_home).expanduser() if state_home else Path.home() / ".local" / "state"
    return base / "specular-telemetry" / "anomaly-state.json"
