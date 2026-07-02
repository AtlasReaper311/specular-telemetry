#!/usr/bin/env bash
# install-wsl.sh
#
# Installs specular-telemetry as a WSL2 systemd service. Idempotent:
# safe to re-run after every repo pull; it refreshes deps and restarts
# the unit.
#
# The venv deliberately lives on the native Linux filesystem
# (~/.venvs/...), never on an NTFS mount: venvs on /mnt/* corrupt their
# symlinks. The repo itself can live anywhere.
#
# Run from this directory:
#   bash install-wsl.sh

set -euo pipefail

SERVICE_NAME="specular-telemetry"
SERVICE_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
VENV_DIR="$HOME/.venvs/${SERVICE_NAME}"
UNIT_PATH="/etc/systemd/system/${SERVICE_NAME}.service"
PORT=9000

echo "specular-telemetry // WSL2 install"

# --- 1. Preconditions ----------------------------------------------------
if ! pidof systemd >/dev/null 2>&1; then
  echo "systemd is not running in this WSL2 distro."
  echo "Add the following to /etc/wsl.conf, then run 'wsl --shutdown' from Windows:"
  echo "  [boot]"
  echo "  systemd=true"
  exit 1
fi

if ! command -v python3 >/dev/null 2>&1; then
  echo "python3 not found. Install it first:"
  echo "  sudo apt update"
  echo "  sudo apt install -y python3 python3-venv"
  exit 1
fi

# --- 2. Venv on the native filesystem ------------------------------------
if [ ! -x "${VENV_DIR}/bin/python" ]; then
  echo "  creating venv at ${VENV_DIR}"
  mkdir -p "$(dirname "${VENV_DIR}")"
  if ! python3 -m venv "${VENV_DIR}"; then
    echo "venv creation failed. Install the venv module and re-run:"
    echo "  sudo apt install -y python3-venv"
    exit 1
  fi
else
  echo "  venv exists at ${VENV_DIR}"
fi

echo "  installing requirements"
"${VENV_DIR}/bin/python" -m pip install --quiet --upgrade pip
"${VENV_DIR}/bin/python" -m pip install --quiet -r "${SERVICE_DIR}/requirements.txt"

# --- 3. systemd unit -------------------------------------------------------
# EnvironmentFile is optional: drop overrides (OLLAMA_HOST, intervals)
# into /etc/default/specular-telemetry without touching this unit.
echo "  writing ${UNIT_PATH}"
sudo tee "${UNIT_PATH}" >/dev/null <<UNIT
[Unit]
Description=Atlas Systems specular-telemetry
After=network.target

[Service]
Type=simple
User=${USER}
WorkingDirectory=${SERVICE_DIR}
EnvironmentFile=-/etc/default/${SERVICE_NAME}
ExecStart=${VENV_DIR}/bin/python -m uvicorn telemetry:app --host 0.0.0.0 --port ${PORT}
Restart=always
RestartSec=3

[Install]
WantedBy=multi-user.target
UNIT

sudo systemctl daemon-reload
sudo systemctl enable "${SERVICE_NAME}" >/dev/null
sudo systemctl restart "${SERVICE_NAME}"

# --- 4. Verify --------------------------------------------------------------
echo "  waiting for /health"
ok=false
for _ in $(seq 1 10); do
  sleep 2
  if curl -fsS "http://127.0.0.1:${PORT}/health" >/dev/null 2>&1; then
    ok=true
    break
  fi
done

if [ "${ok}" = true ]; then
  echo "specular-telemetry is live at http://127.0.0.1:${PORT}/telemetry"
else
  echo "Unit installed but /health did not answer within 20s."
  echo "Inspect with: journalctl -u ${SERVICE_NAME} -n 50 --no-pager"
  exit 1
fi
