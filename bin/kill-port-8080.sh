#!/usr/bin/env bash

PORT=8080

PID=$(sudo ss -ltnp | grep ":${PORT} " | sed -n 's/.*pid=\([0-9]*\).*/\1/p')

if [ -z "$PID" ]; then
  echo "✅ No process found listening on port ${PORT}"
  exit 0
fi

echo "🔥 Killing process on port ${PORT} (PID: $PID)"
sudo kill -9 "$PID"
echo "✅ Done"
