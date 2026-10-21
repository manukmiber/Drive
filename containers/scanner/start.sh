#!/bin/sh
# Start freshclam + clamd (the image's own init), wait for clamd, then the scanner API.
/init &
for i in $(seq 1 120); do
  if nc -z 127.0.0.1 3310 2>/dev/null; then break; fi
  sleep 1
done
exec /usr/local/bin/scanner
