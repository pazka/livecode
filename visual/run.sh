#!/usr/bin/env bash
# Visual regression of a built image (hosh-management AGENTS.md §3, use cases in TESTING.md).
#   visual/run.sh [IMAGE] [--update]      (default livecode:local)
# Starts the image hardened as on the box (uid 10001 from the image, read-only rootfs, no caps,
# no-new-privileges) on an empty volume, then visual/shoot.mjs shoots every use case at
# 1400 / 1024 / 390 and compares with visual/baseline/. Every case uses its own room, created by
# the server from the fixed starter, so the data is the same on every run.
# Needs: docker, node >= 22, a Chrome ($CHROME, default google-chrome). No package is installed.
set -euo pipefail
cd "$(dirname "$0")/.."
IMAGE="${1:-livecode:local}"
shift || true
PORT="${VISUAL_PORT:-18340}"
NAME="livecode-visual-$$"
VOL="livecode-visual-$$"
trap 'docker rm -f "$NAME" >/dev/null 2>&1 || true; docker volume rm "$VOL" >/dev/null 2>&1 || true' EXIT

docker run -d --name "$NAME" --read-only --tmpfs /tmp --cap-drop ALL \
  --security-opt no-new-privileges:true --pids-limit 128 --memory 512m \
  -e APP_BASE_URL="http://127.0.0.1:$PORT" -v "$VOL:/data" \
  -p "127.0.0.1:$PORT:8000" "$IMAGE" >/dev/null
for _ in $(seq 1 40); do
  curl -fsS "http://127.0.0.1:$PORT/healthz" >/dev/null 2>&1 && break; sleep 0.5
done
curl -fsS "http://127.0.0.1:$PORT/healthz" >/dev/null || { docker logs "$NAME"; exit 1; }
test "$(docker inspect --format '{{.Config.User}}' "$NAME")" = "10001:10001"

status=0
node visual/shoot.mjs "http://127.0.0.1:$PORT" "$@" || status=$?
if [ "$status" != 0 ]; then docker logs "$NAME" 2>&1 | tail -n 20; fi
exit "$status"
