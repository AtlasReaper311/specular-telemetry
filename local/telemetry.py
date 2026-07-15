"""specular-telemetry: live hardware stats plus shape-aware anomaly evidence."""

from __future__ import annotations

import asyncio
import logging
import os
import platform
import time
from contextlib import asynccontextmanager, suppress
from datetime import datetime, timezone

import httpx
import psutil
from fastapi import FastAPI, Query
from fastapi.responses import JSONResponse

from anomaly import AnomalyEngine
from collectors import cpu, gpu, ollama, ram

SERVICE_NAME = "specular-telemetry"
SERVICE_VERSION = "1.1.0"

logger = logging.getLogger(__name__)


def _env_str(name: str, default: str) -> str:
    return os.environ.get(name, default)


def _env_float(name: str, default: float) -> float:
    raw = os.environ.get(name)
    if raw is None:
        return default
    try:
        return float(raw)
    except ValueError:
        logger.warning("%s=%r is not a number; using %s", name, raw, default)
        return default


def _env_int(name: str, default: int) -> int:
    raw = os.environ.get(name)
    if raw is None:
        return default
    try:
        return int(raw)
    except ValueError:
        logger.warning("%s=%r is not an integer; using %s", name, raw, default)
        return default


OLLAMA_HOST = _env_str("OLLAMA_HOST", "http://127.0.0.1:11434")
SAMPLE_INTERVAL_SECONDS = _env_float("SAMPLE_INTERVAL_SECONDS", 30.0)
OLLAMA_TIMEOUT_SECONDS = _env_float("OLLAMA_TIMEOUT_SECONDS", 3.0)
LOG_LEVEL = _env_str("LOG_LEVEL", "INFO")
ANOMALY_WINDOW_SAMPLES = _env_int("ANOMALY_WINDOW_SAMPLES", 24)
ANOMALY_HISTORY_SAMPLES = _env_int("ANOMALY_HISTORY_SAMPLES", 512)


async def _build_snapshot(app: FastAPI) -> dict:
    """Assemble one hardware snapshot and feed it through the detector."""
    snapshot = {
        "service": SERVICE_NAME,
        "version": SERVICE_VERSION,
        "host": {
            "hostname": platform.node(),
            "uptime_s": int(time.time() - psutil.boot_time()),
            "platform": f"{platform.system()} {platform.release()}",
        },
        "gpu": gpu.collect(),
        "cpu": cpu.collect(),
        "ram": ram.collect(),
        "ollama": await ollama.collect(
            app.state.client,
            OLLAMA_HOST,
            OLLAMA_TIMEOUT_SECONDS,
        ),
        "sampled_at": datetime.now(timezone.utc).isoformat().replace("+00:00", "Z"),
    }
    snapshot["anomaly"] = app.state.anomaly.observe(snapshot)
    return snapshot


async def _sampler(app: FastAPI) -> None:
    while True:
        try:
            await asyncio.sleep(SAMPLE_INTERVAL_SECONDS)
            app.state.latest = await _build_snapshot(app)
        except asyncio.CancelledError:
            return
        except Exception:  # noqa: BLE001
            logger.exception("sample failed; keeping previous snapshot")


@asynccontextmanager
async def lifespan(app: FastAPI):
    logging.basicConfig(
        level=LOG_LEVEL.upper(),
        format="%(asctime)s %(levelname)s %(name)s %(message)s",
    )
    cpu.prime()
    app.state.client = httpx.AsyncClient()
    app.state.anomaly = AnomalyEngine(
        window=max(8, ANOMALY_WINDOW_SAMPLES),
        history_limit=max(ANOMALY_WINDOW_SAMPLES * 4, ANOMALY_HISTORY_SAMPLES),
    )
    app.state.latest = await _build_snapshot(app)
    sampler_task = asyncio.create_task(_sampler(app))
    logger.info(
        "%s %s sampling every %ss; anomaly window=%s samples",
        SERVICE_NAME,
        SERVICE_VERSION,
        SAMPLE_INTERVAL_SECONDS,
        ANOMALY_WINDOW_SAMPLES,
    )
    yield
    sampler_task.cancel()
    with suppress(asyncio.CancelledError):
        await sampler_task
    app.state.anomaly.persist()
    await app.state.client.aclose()


app = FastAPI(title=SERVICE_NAME, version=SERVICE_VERSION, lifespan=lifespan)


@app.get("/")
def index() -> JSONResponse:
    return JSONResponse(
        {
            "service": SERVICE_NAME,
            "version": SERVICE_VERSION,
            "endpoints": ["/telemetry", "/anomaly", "/anomaly/history", "/health"],
        }
    )


@app.get("/telemetry")
def telemetry() -> JSONResponse:
    return JSONResponse(app.state.latest)


@app.get("/anomaly")
def anomaly() -> JSONResponse:
    return JSONResponse(app.state.anomaly.latest)


@app.get("/anomaly/history")
def anomaly_history(
    metric: str | None = Query(default=None),
    limit: int = Query(default=96, ge=1, le=192),
) -> JSONResponse:
    items = app.state.anomaly.history(metric=metric, limit=limit)
    return JSONResponse(
        {
            "schema": "specular-anomaly-history/v1",
            "metric": metric,
            "count": len(items),
            "items": items,
            "generated_at": datetime.now(timezone.utc).isoformat().replace("+00:00", "Z"),
        }
    )


@app.get("/health")
def health() -> JSONResponse:
    sampled_at = app.state.latest.get("sampled_at", "")
    age = None
    with suppress(ValueError):
        parsed = datetime.fromisoformat(sampled_at.replace("Z", "+00:00"))
        age = int((datetime.now(timezone.utc) - parsed).total_seconds())
    anomaly_state = (
        app.state.latest.get("anomaly", {}).get("state")
        if isinstance(app.state.latest, dict)
        else None
    )
    return JSONResponse(
        {
            "ok": True,
            "service": SERVICE_NAME,
            "version": SERVICE_VERSION,
            "last_sample_age_s": age,
            "anomaly_state": anomaly_state,
        }
    )
