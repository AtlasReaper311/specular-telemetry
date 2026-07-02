"""CPU stats via psutil.

cpu_percent with interval=None is non-blocking: it measures since the
previous call. The sampler primes it once at startup so the first real
sample is meaningful rather than 0.0.
"""

import psutil


def prime() -> None:
    """Seed psutil's internal counters; the first reading needs a baseline."""
    psutil.cpu_percent(interval=None)
    psutil.cpu_percent(interval=None, percpu=True)


def collect() -> dict:
    """One CPU sample: overall load, per-core load, frequency, core counts."""
    freq = psutil.cpu_freq()
    return {
        "overall_pct": psutil.cpu_percent(interval=None),
        "per_core_pct": psutil.cpu_percent(interval=None, percpu=True),
        "freq_mhz": {
            "current": int(freq.current) if freq else None,
            "max": int(freq.max) if freq and freq.max else None,
        },
        "cores": {
            "physical": psutil.cpu_count(logical=False),
            "logical": psutil.cpu_count(logical=True),
        },
    }
