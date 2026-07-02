"""specular-telemetry: live hardware stats from SPECULAR-CORE.

A background sampler reads GPU, CPU, RAM, and Ollama state every
SAMPLE_INTERVAL_SECONDS into an in-memory snapshot; GET /telemetry
returns the latest snapshot instantly. Requests never block on
hardware reads, so a slow NVML call or an Ollama timeout costs one
sample, never a caller.

Configuration is plain environment variables through stdlib helpers
rather than a settings framework: this service is installed bare on
the host (Windows scheduled task or WSL2 systemd unit), and every
dependency it does not have is one less thing a rebuild can break.
"""

import asyncio
import logging
import os
import platform
import time
from contextlib import asynccontextmanager, suppress
from datetime import datetime, timezone

import httpx
import psutil
from fastapi import FastAPI
from fastapi.responses import JSONResponse

from collectors import cpu, gpu, ollama, ram

SERVICE_NAME = "specular-telemetry"
SERVICE_VERSION = "1.0.0"

logger = logging.getLogger(__name__)


def _env_str(name: str, default: str) -> str:
    """Read a string env var with a default."""
    return os.environ.get(name, default)


def _env_float(name: str, default: float) -> float:
    """Read a float env var, falling back loudly on a bad value."""
    raw = os.environ.get(name)
    if raw is None:
        return default
    try:
        return float(raw)
    except ValueError:
        logger.warning("%s=%r is not a number; using %s", name, raw, default)
        return default


OLLAMA_HOST = _env_str("OLLAMA_HOST", "http://127.0.0.1:11434")
SAMPLE_INTERVAL_SECONDS = _env_float("SAMPLE_INTERVAL_SECONDS", 30.0)
OLLAMA_TIMEOUT_SECONDS = _env_float("OLLAMA_TIMEOUT_SECONDS", 3.0)
LOG_LEVEL = _env_str("LOG_LEVEL", "INFO")


async def _build_snapshot(client: httpx.AsyncClient) -> dict:
    """Assemble one full telemetry snapshot."""
    return {
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
        "ollama": await ollama.collect(client, OLLAMA_HOST, OLLAMA_TIMEOUT_SECONDS),
        "sampled_at": datetime.now(timezone.utc).isoformat().replace("+00:00", "Z"),
    }


async def _sampler(app: FastAPI) -> None:
    """Refresh the snapshot on the configured interval, forever."""
    while True:
        try:
            await asyncio.sleep(SAMPLE_INTERVAL_SECONDS)
            app.state.latest = await _build_snapshot(app.state.client)
        except asyncio.CancelledError:
            return
        except Exception:  # noqa: BLE001 - one bad sample must not kill the loop
            logger.exception("sample failed; keeping previous snapshot")


@asynccontextmanager
async def lifespan(app: FastAPI):
    """Prime counters, take the first sample, then start the loop."""
    logging.basicConfig(
        level=LOG_LEVEL.upper(),
        format="%(asctime)s %(levelname)s %(name)s %(message)s",
    )
    cpu.prime()
    app.state.client = httpx.AsyncClient()
    # First sample happens before serving so /telemetry never has to
    # answer "not yet".
    app.state.latest = await _build_snapshot(app.state.client)
    sampler_task = asyncio.create_task(_sampler(app))
    logger.info(
        "%s %s sampling every %ss, Ollama at %s",
        SERVICE_NAME,
        SERVICE_VERSION,
        SAMPLE_INTERVAL_SECONDS,
        OLLAMA_HOST,
    )
    yield
    sampler_task.cancel()
    with suppress(asyncio.CancelledError):
        await sampler_task
    await app.state.client.aclose()


app = FastAPI(title=SERVICE_NAME, version=SERVICE_VERSION, lifespan=lifespan)


@app.get("/")
def index() -> JSONResponse:
    """Tiny self-description for anyone poking the port directly."""
    return JSONResponse(
        {"service": SERVICE_NAME, "endpoints": ["/telemetry", "/health"]}
    )


@app.get("/telemetry")
def telemetry() -> JSONResponse:
    """The latest snapshot; always instant, never blocks on hardware."""
    return JSONResponse(app.state.latest)


@app.get("/health")
def health() -> JSONResponse:
    """Liveness for the Cloudflare Tunnel probe, with sample freshness."""
    sampled_at = app.state.latest.get("sampled_at", "")
    age = None
    with suppress(ValueError):
        parsed = datetime.fromisoformat(sampled_at.replace("Z", "+00:00"))
        age = int((datetime.now(timezone.utc) - parsed).total_seconds())
    return JSONResponse(
        {
            "ok": True,
            "service": SERVICE_NAME,
            "version": SERVICE_VERSION,
            "last_sample_age_s": age,
        }
    )
