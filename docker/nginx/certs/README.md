# certificates live here (gitignored)
#
#   fullchain.pem   the cert chain the browser/phones validate
#   privkey.pem     the matching private key — chmod 600, never committed
#
# Real deployments have two honest options:
#
# 1. Let's Encrypt (a public hostname): point a DNS A record at this box,
#    then renew forever with
#    `certbot certonly --webroot -w /var/www/certbot -d septic.example.com`
#    and symlink the live files into this directory. Port 80 must be
#    reachable — the nginx.conf already answers the ACME challenge.
#
# 2. A private CA (no public hostname, e.g. a VPN address): issue the cert
#    from your own CA and export the CA bundle to every driver handset —
#    a PWA only installs when the phone already trusts the certificate,
#    which is the whole of DRV-12's "🟡 until the handsets trust a
#    certificate". No app code can substitute for that trust.
#
# `make-self-signed.sh` in this directory generates a throwaway pair so the
# TLS plumbing can be tested locally. Handsets will (correctly) refuse it.
