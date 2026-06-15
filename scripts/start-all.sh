#!/bin/bash
set -e

echo "Starting web server..."
exec node src/server.js
