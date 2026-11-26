#!/usr/bin/env bash
# Forwards and the allow-list proxy. Exits if any of them stops, so Docker restarts the gate.
set -euo pipefail
: "${SILO_HOST:=sheldon}"          # the silo container on the internal network
: "${SILO_SUBNET:?SILO_SUBNET is not set}"
: "${HOST_RELAY:?HOST_RELAY is not set}"   # host:port of the MCP relay on the host (host/sheldon-mcp-relay.py)
# allowlist: only names in /etc/silo/allowlist, HTTPS only. open: the whole internet except private and
# local addresses (/etc/silo/denylist); host/sheldon-egress-guard.sh blocks those at the firewall too.
: "${SILO_EGRESS:=allowlist}"

conf=/tmp/tinyproxy.conf
cat > "$conf" <<CONF
Port 8888
Listen 0.0.0.0
Timeout 600
MaxClients 64
LogLevel Notice
DisableViaHeader Yes
Allow $SILO_SUBNET
FilterType ere
FilterURLs Off
CONF
if [ "$SILO_EGRESS" = open ]; then
  printf '%s\n' 'FilterDefaultDeny No' 'Filter "/etc/silo/denylist"' 'ConnectPort 443' 'ConnectPort 80' >> "$conf"
else
  # Only names in the allow-list, and only HTTPS for CONNECT.
  printf '%s\n' 'FilterDefaultDeny Yes' 'Filter "/etc/silo/allowlist"' 'ConnectPort 443' >> "$conf"
fi
echo "gate: egress $SILO_EGRESS" >&2

tinyproxy -d -c "$conf" &
P1=$!
# Agent API and live view: the host reaches these through ports compose publishes on 127.0.0.1.
socat TCP-LISTEN:8642,fork,reuseaddr TCP:"$SILO_HOST":8642 &
P2=$!
socat TCP-LISTEN:5900,fork,reuseaddr TCP:"$SILO_HOST":5900 &
P3=$!
# The app's MCP endpoint, through the host relay that passes only this bot's /mcp path.
socat TCP-LISTEN:8787,fork,reuseaddr TCP:"$HOST_RELAY" &
P4=$!
wait -n "$P1" "$P2" "$P3" "$P4"
echo "gate: a forwarder exited" >&2
exit 1
