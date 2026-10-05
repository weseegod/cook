#!/usr/bin/env bash
# Log paths are keyed on the server pid so two dev servers cannot clobber each other.
PID=$1 URL=http://localhost:3000 DIR=~/.grok/long-running-background-tasks
LOG=$DIR/dev_server_$PID.log
up() { curl -fsS -o /dev/null --max-time 5 "$URL" 2>>"$DIR/watch_dev_server_$PID.log"; }
why() { tail -20 "$LOG" | tr -d '\r' | tr '\n' ' '; }

until up; do
  kill -0 "$PID" 2>/dev/null || { echo "FAILED: pid $PID exited before $URL came up: $(why)"; exit 1; }
  sleep 5
done
echo "ACTION_REQUIRED: $URL is up"

while :; do
  sleep 5
  up || { echo "ACTION_REQUIRED: $URL is down: $(why)"; until up; do sleep 5; done; }
done
