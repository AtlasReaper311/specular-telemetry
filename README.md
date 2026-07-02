<div align="center">
  <img src="https://raw.githubusercontent.com/AtlasReaper311/AtlasReaper311/main/atlas-icon-dark-256.png" width="88" alt="Atlas Systems"/>
</div>

# specular-telemetry

```
┌─────────────────────────────────────────────┐
│  ATLAS SYSTEMS // specular-telemetry        │
│  live hardware telemetry from the homelab   │
│  served through the edge to the portfolio   │
└─────────────────────────────────────────────┘
```

![Python](https://img.shields.io/badge/python-3.12-f5a623?style=flat-square&labelColor=0a0a0f)
![Edge](https://img.shields.io/badge/edge-cloudflare%20worker-4ade80?style=flat-square&labelColor=0a0a0f)
![GPU](https://img.shields.io/badge/gpu-nvml-aaa9a0?style=flat-square&labelColor=0a0a0f)
![Cost](https://img.shields.io/badge/cost-%C2%A30-aaa9a0?style=flat-square&labelColor=0a0a0f)

SPECULAR-CORE's vitals, live on the portfolio. A local FastAPI service samples GPU, CPU, RAM, and Ollama state every 30 seconds; a Cloudflare Worker fetches it through the machine's tunnel, caches it at the edge, and serves it at `api.atlas-systems.uk/specular` with a schema that stays consistent whether the box is on or off. A drop-in widget renders it on the site.

```
SPECULAR-CORE
  telemetry.py :9000 ── cloudflared ──▶ specular-tunnel.atlas-systems.uk
  (psutil · NVML · Ollama API)               │
                                             ▼
  atlas-systems.uk ◀── widget ◀── specular-edge (Cache API 60s, KV last-known-good)
                                  api.atlas-systems.uk/specular
```

## Prerequisites

- Python 3.12 on SPECULAR-CORE (Windows native, WSL2 Ubuntu, or both)
- The existing `cloudflared` install (Windows service reading `C:\ProgramData\cloudflared\`)
- `wrangler` authenticated against the Cloudflare account
- NVIDIA driver for GPU stats; without one the service reports `gpu: null` and keeps running

## Setup

### Part A, local service (pick one, or run both and let the tunnel point at either)

Windows, elevated PowerShell:

```powershell
cd local
powershell -ExecutionPolicy Bypass -File .\install-windows.ps1
```

Registers the venv under ProgramData and a SYSTEM scheduled task (`Atlas Specular Telemetry`) that starts on boot, restarts on failure, and serves on `0.0.0.0:9000`.

WSL2 Ubuntu:

```bash
cd local
bash install-wsl.sh
```

Creates the venv on the native filesystem (`~/.venvs/specular-telemetry`, never NTFS) and a systemd unit `specular-telemetry.service`. If the tunnel runs on Windows and the service in WSL2, port 9000 needs the portproxy rule; [`atlas-bootstrap`](https://github.com/AtlasReaper311/atlas-bootstrap) owns that rule and its on-boot refresh.

Verify either path:

```bash
curl -sS http://127.0.0.1:9000/telemetry
```

### Part B, tunnel hostname

Add an ingress rule to `C:\ProgramData\cloudflared\config.yml` above the catch-all:

```yaml
  - hostname: specular-tunnel.atlas-systems.uk
    service: http://localhost:9000
```

Route the DNS and restart the service (elevated PowerShell):

```powershell
cloudflared tunnel route dns <TUNNEL-NAME> specular-tunnel.atlas-systems.uk
Restart-Service cloudflared
```

### Part C, the edge Worker

```bash
cd worker
npm ci
npx wrangler kv namespace create TELEMETRY_KV
```

Paste the returned id into `wrangler.toml`, then:

```bash
npx eslint .
npx wrangler deploy
curl -sS https://api.atlas-systems.uk/specular
```

Wire CI the estate way: copy the 12-line reusable caller from [`github-pulse`](https://github.com/AtlasReaper311/github-pulse)'s `.github/workflows/` into this repo and change the name. The inline `ci.yml` here gates syntax; the caller owns deploys.

### Part D, the widget

Paste the whole of [`site-snippet/specular-widget.html`](site-snippet/specular-widget.html) where it should render (the Lab page is the intended home). It inherits the site's CSS variables and fonts, scopes everything under `.sp-w`, and polls once a minute.

## Usage

```bash
curl -sS https://api.atlas-systems.uk/specular
curl -sS https://api.atlas-systems.uk/specular/_meta
```

Online response: `{ online: true, fetched_at, last_seen, telemetry: { host, gpu, cpu, ram, ollama, sampled_at } }`. Offline keeps the identical shape with `online: false` and the last snapshot KV remembers, so the widget and any future consumer never branch on schema, only on one boolean.

## Design notes

**Requests never touch hardware.** A background task samples every 30 seconds into memory; `/telemetry` returns the latest snapshot instantly. A stalled NVML call costs one sample, never a caller, and never the tunnel probe.

**KV is written like it costs something, because it does.** The free tier allows 1,000 writes/day; caching "in KV for 60 seconds" naively is up to 1,440. So the Cache API (free, unlimited) is the hot cache, and KV holds one last-known-good snapshot written only on an online/offline flip or when the stored copy is over ten minutes old. Worst case lands near 150 writes/day, the same conditional-write shape as the [`deploy-watch`](https://github.com/AtlasReaper311/deploy-watch) fix.

**Offline is a state, not an error.** The machine being off is normal and the endpoint says so calmly: `online: false`, when it was last seen, and what it looked like then.

## How it fits into Atlas Systems

The tunnel pattern is [`ramone-edge`](https://github.com/AtlasReaper311/ramone-edge)'s, reused: local service, public hostname, Worker in front. The Worker answers the [`atlas-api-index`](https://github.com/AtlasReaper311/atlas-api-index) `/_meta` convention from day one, so the registry discovers it without configuration, and [`atlas-bootstrap`](https://github.com/AtlasReaper311/atlas-bootstrap) installs the local half and keeps port 9000 reachable across WSL2 reboots.

A claim on a portfolio is an assertion; an endpoint is evidence, and designing the degraded response with the same care as the happy path is what makes evidence trustworthy.

---

Part of [atlas-systems.uk](https://atlas-systems.uk)
