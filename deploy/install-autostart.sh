#!/usr/bin/env bash
# Installs the systemd unit that updates and starts NMOS Federation at boot.
#
#   sudo deploy/install-autostart.sh            # update + start at every boot
#   sudo deploy/install-autostart.sh --nightly  # additionally every night at 04:00
#   sudo deploy/install-autostart.sh --remove   # uninstall
set -euo pipefail

UNIT=nmos-federation-update
DEST=/etc/systemd/system

if [[ $EUID -ne 0 ]]; then
  echo "run with sudo" >&2
  exit 1
fi

if [[ "${1:-}" == "--remove" ]]; then
  systemctl disable --now "$UNIT.timer" 2>/dev/null || true
  systemctl disable "$UNIT.service" 2>/dev/null || true
  rm -f "$DEST/$UNIT.service" "$DEST/$UNIT.timer"
  systemctl daemon-reload
  echo "removed — the container keeps running and still restarts with Docker (restart: unless-stopped)"
  exit 0
fi

# The repository this script lives in, and the user who owns it — the pull must run as
# that user, or the checkout ends up owned by root.
REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
RUN_AS="${SUDO_USER:-$(stat -c %U "$REPO")}"
DOCKER="$(command -v docker || true)"

[[ -n "$DOCKER" ]] || { echo "docker not found in PATH" >&2; exit 1; }
[[ -d "$REPO/.git" ]] || { echo "$REPO is not a git checkout" >&2; exit 1; }
"$DOCKER" compose version >/dev/null 2>&1 || { echo "'docker compose' (v2 plugin) not available" >&2; exit 1; }

if [[ "$RUN_AS" != "root" ]] && ! id -nG "$RUN_AS" | tr ' ' '\n' | grep -qx docker; then
  echo "user '$RUN_AS' is not in the docker group — add it first:" >&2
  echo "  sudo usermod -aG docker $RUN_AS   (then log out and in again)" >&2
  exit 1
fi

sed -e "s|@REPO@|$REPO|g" -e "s|@USER@|$RUN_AS|g" -e "s|@DOCKER@|$DOCKER|g" \
  "$REPO/deploy/$UNIT.service" > "$DEST/$UNIT.service"

systemctl enable docker >/dev/null
systemctl daemon-reload
systemctl enable "$UNIT.service" >/dev/null
echo "installed: updates and starts at every boot (repo $REPO, user $RUN_AS)"

if [[ "${1:-}" == "--nightly" ]]; then
  cp "$REPO/deploy/$UNIT.timer" "$DEST/$UNIT.timer"
  systemctl daemon-reload
  systemctl enable --now "$UNIT.timer" >/dev/null
  echo "and every night at 04:00 — next run: $(systemctl list-timers "$UNIT.timer" --no-pager | sed -n 2p | awk '{print $1, $2, $3}')"
fi

echo "run it once now with:  sudo systemctl start $UNIT   (log: journalctl -u $UNIT)"
