#!/usr/bin/env bash
# Firewall backstop for the gate's open mode: the gate (172.30.53.2) may reach the public internet and
# the host MCP relay, but no private, tailnet or link-local address, whatever a name resolves to.
# Idempotent; run as root after Docker starts (sheldon-egress-guard.service). "remove" takes it out.
set -euo pipefail
GATE=${GATE_IP:-172.30.53.2}
CHAIN=SHELDON-EGRESS
ipt() { iptables -w "$@"; }
ipt -N "$CHAIN" 2>/dev/null || true
ipt -F "$CHAIN"
while ipt -C DOCKER-USER -s "$GATE" -j "$CHAIN" 2>/dev/null; do ipt -D DOCKER-USER -s "$GATE" -j "$CHAIN"; done
if [ "${1:-}" = remove ]; then ipt -X "$CHAIN"; echo "removed"; exit 0; fi
ipt -A "$CHAIN" -m conntrack --ctstate ESTABLISHED,RELATED -j RETURN
for net in 10.0.0.0/8 172.16.0.0/12 192.168.0.0/16 100.64.0.0/10 169.254.0.0/16 127.0.0.0/8 224.0.0.0/4 240.0.0.0/4; do
  ipt -A "$CHAIN" -d "$net" -j DROP
done
ipt -A "$CHAIN" -j RETURN
ipt -I DOCKER-USER 1 -s "$GATE" -j "$CHAIN"
echo "SHELDON-EGRESS applied for $GATE"
