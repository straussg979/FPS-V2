#!/bin/sh
# COLD SECTOR launcher for macOS and Linux: checks the setup, installs what is missing, starts the game and
# opens it in the browser. Ctrl+C stops the server.
cd "$(dirname "$0")" || exit 1

if ! command -v node >/dev/null 2>&1; then
  echo "Node.js is not installed. COLD SECTOR needs Node.js 22 or newer: https://nodejs.org/"
  exit 1
fi

node scripts/preflight.mjs --deps
code=$?
if [ "$code" -eq 10 ]; then
  echo "Installing dependencies (first start only, needs an internet connection)..."
  npm install || { echo "npm install failed - see the messages above."; exit 1; }
  node scripts/preflight.mjs --deps || exit 1
elif [ "$code" -ne 0 ]; then
  exit 1
fi

PORT=$(node scripts/preflight.mjs --port) || exit 1
export PORT
echo
echo "Starting COLD SECTOR on http://127.0.0.1:$PORT/  (the first start builds the game, about a minute)"
node scripts/preflight.mjs --open "$PORT" &
exec npm start
