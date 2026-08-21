#!/bin/sh
# Start a Docker daemon, then the runner, and stop the daemon on the way out.
#
# The order matters at both ends. The runner refuses to start without a working
# `docker`, so the daemon has to be up first; and the daemon holds
# /var/lib/docker open, so a process that exits while it is running leaves the
# volume to be unmounted busy, which on Fly is reported as an error and leaves
# the filesystem to be checked on the next boot.
#
# Exiting 0 when the runner stops is the whole arrangement: a machine whose
# process exits stops, and stops costing anything, until something sends the
# wake request that starts it again.
set -e

DOCKERD_LOG=${DOCKERD_LOG:-/tmp/dockerd.log}

dockerd --host=unix:///var/run/docker.sock >"$DOCKERD_LOG" 2>&1 &
DOCKERD_PID=$!

stop_dockerd() {
  # TERM, then a bounded wait: an unmount that comes before the daemon has let
  # go is the failure this exists to avoid, but waiting forever for a daemon
  # that will not stop would be worse than a busy unmount.
  kill "$DOCKERD_PID" 2>/dev/null || return 0
  i=0
  while [ $i -lt 20 ] && kill -0 "$DOCKERD_PID" 2>/dev/null; do
    i=$((i + 1))
    sleep 1
  done
}
trap 'stop_dockerd' EXIT

i=0
while [ $i -lt 60 ]; do
  if docker version >/dev/null 2>&1; then break; fi
  i=$((i + 1))
  sleep 1
done
if ! docker version >/dev/null 2>&1; then
  echo "The Docker daemon did not come up, so this runner cannot execute anything."
  echo "The daemon's own output follows:"
  tail -40 "$DOCKERD_LOG"
  exit 1
fi

# Every setting arrives as an environment variable, because this runs as a
# machine's entrypoint where there is no command line to edit: FEORGE_HOST
# and FEORGE_RUNNER_TOKEN say which vault and which runner,
# FEORGE_WAKE_SECRET what a wake request must present, and the two below
# have defaults that suit a machine billed by the minute.
#
# Started in the background rather than exec'd, so that this shell survives to
# stop the daemon afterwards; the cost is having to pass on the signals it
# would otherwise have received directly.
node /app/dist/index.js runner run \
  --host "$FEORGE_HOST" \
  --idle "${FEORGE_IDLE:-5m}" \
  --wake-port "${FEORGE_WAKE_PORT:-3000}" \
  "$@" &
RUNNER_PID=$!

# The runner treats these as "stop after the job you are on", which is what a
# platform asking a machine to shut down should get: a job abandoned mid-step
# is one the vault has to wait out a lease on.
trap 'kill -TERM "$RUNNER_PID" 2>/dev/null || true' TERM INT

# A signal interrupts wait, so it is called until the child is really gone.
set +e
wait "$RUNNER_PID"
STATUS=$?
while [ "$STATUS" -gt 128 ] && kill -0 "$RUNNER_PID" 2>/dev/null; do
  wait "$RUNNER_PID"
  STATUS=$?
done
exit "$STATUS"
