"""Ollama model state via its HTTP API.

Two calls: /api/tags for what is pulled, /api/ps for what is loaded
into VRAM right now. Ollama being down is a normal state for this
collector (the box may be mid-reboot), so unreachability degrades to
reachable: false rather than failing the whole telemetry sample.
"""

import logging

import httpx

logger = logging.getLogger(__name__)


async def collect(client: httpx.AsyncClient, host: str, timeout: float) -> dict:
    """One Ollama sample: reachability, loaded models, available models."""
    try:
        tags_response = await client.get(f"{host}/api/tags", timeout=timeout)
        tags_response.raise_for_status()
        ps_response = await client.get(f"{host}/api/ps", timeout=timeout)
        ps_response.raise_for_status()
    except Exception as exc:  # noqa: BLE001 - down is data, not an error
        logger.debug("Ollama unreachable at %s: %s", host, exc)
        return {"reachable": False, "loaded": [], "available": []}

    available = sorted(
        model.get("name", "?") for model in tags_response.json().get("models", [])
    )
    loaded = [
        {
            "name": model.get("name", "?"),
            "vram_mb": int(model.get("size_vram", 0) / 1024**2),
        }
        for model in ps_response.json().get("models", [])
    ]
    return {"reachable": True, "loaded": loaded, "available": available}
