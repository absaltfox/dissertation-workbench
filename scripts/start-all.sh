#!/bin/bash
set -e

echo "Starting background worker..."
node src/worker.js &
WORKER_PID=$!

echo "Starting web server..."
node src/server.js &
SERVER_PID=$!

cleanup() {
  echo "Propagating shutdown signals to child processes..."
  kill -TERM "$WORKER_PID" "$SERVER_PID" 2>/dev/null || true
  wait "$WORKER_PID" "$SERVER_PID"
  echo "Processes stopped successfully."
}

trap cleanup SIGINT SIGTERM

# Wait for either process to exit
wait -n

# Exit with the code of the process that terminated first
exit $?
