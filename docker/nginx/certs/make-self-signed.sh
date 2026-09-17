#!/usr/bin/env bash
# Dev-only self-signed pair so the https overlay can be exercised without
# DNS. Handsets will reject this — see README.md for the real options.
set -euo pipefail
cd "$(dirname "$0")"
openssl req -x509 -newkey rsa:2048 -nodes -days 30 \
  -keyout privkey.pem -out fullchain.pem \
  -subj "/CN=septic-localhost-dev" \
  -addext "subjectAltName=DNS:localhost,IP:127.0.0.1"
chmod 600 privkey.pem
echo "wrote privkey.pem + fullchain.pem (30 days, self-signed, DEV ONLY)"
