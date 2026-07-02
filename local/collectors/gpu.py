"""NVIDIA GPU stats via NVML.

The service must survive machines without an NVIDIA driver (or with
NVML in a bad state after a driver update), so initialisation failure
is remembered and every subsequent collect returns None instead of
retry-thrashing a broken library. A restart re-attempts cleanly.
"""

import logging

logger = logging.getLogger(__name__)

_state: dict = {"handle": None, "failed": False}

try:
    import pynvml  # provided by the nvidia-ml-py package
except ImportError:  # pragma: no cover - environment without the wheel
    pynvml = None
    _state["failed"] = True


def _ensure_handle():
    """Initialise NVML once; latch failure so we never crash the loop."""
    if _state["failed"] or _state["handle"] is not None:
        return _state["handle"]
    try:
        pynvml.nvmlInit()
        _state["handle"] = pynvml.nvmlDeviceGetHandleByIndex(0)
        name = pynvml.nvmlDeviceGetName(_state["handle"])
        if isinstance(name, bytes):
            name = name.decode("utf-8", errors="replace")
        logger.info("NVML initialised: %s", name)
    except Exception as exc:  # noqa: BLE001 - any NVML failure means "no GPU stats"
        logger.warning("NVML unavailable, GPU stats disabled: %s", exc)
        _state["failed"] = True
    return _state["handle"]


def collect() -> dict | None:
    """One GPU sample, or None when NVIDIA stats are unavailable."""
    handle = _ensure_handle()
    if handle is None:
        return None
    try:
        name = pynvml.nvmlDeviceGetName(handle)
        if isinstance(name, bytes):
            name = name.decode("utf-8", errors="replace")
        memory = pynvml.nvmlDeviceGetMemoryInfo(handle)
        utilisation = pynvml.nvmlDeviceGetUtilizationRates(handle)
        temperature = pynvml.nvmlDeviceGetTemperature(
            handle, pynvml.NVML_TEMPERATURE_GPU
        )
        return {
            "name": name,
            "vram_used_mb": int(memory.used / 1024**2),
            "vram_total_mb": int(memory.total / 1024**2),
            "utilisation_pct": int(utilisation.gpu),
            "temperature_c": int(temperature),
        }
    except Exception as exc:  # noqa: BLE001 - transient NVML errors skip one sample
        logger.warning("GPU sample failed: %s", exc)
        return None
