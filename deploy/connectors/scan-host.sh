#!/bin/bash
# cleft connector scan: run on one host over SSH (bash -s). Prints one line per MCP-related thing it
# finds, fields separated by "|". Reads names and states only; never prints keys or file contents
# other than the two non-secret lines of a Claude OAuth front's env file (its public URL and upstream).
#   unit|<host>|<unit>|<enabled state>|<active state>|<description>
#   userunit|<host>|<user>:<unit>|<enabled state>|<active state>|<description>
#   docker|<host>|<container>|<image>|<status>
#   front|<host>|<name>|<public url>|<upstream url>
#   hermes|<host>|<config file>|<server name>|<url or command>|<enabled>
H=$(hostname)
PAT='mcp|tunnel|gbrain|honcho|browser|qmd|robotos|kiln|gaggimate'
sudo -n systemctl list-unit-files --type=service --no-pager --plain 2>/dev/null | awk '{print $1, $2}' | grep -i -E "$PAT" | while read -r u st; do
  case "$u" in *@.service) continue;; esac
  a=$(systemctl is-active "$u" 2>/dev/null); d=$(systemctl show -p Description --value "$u" 2>/dev/null | tr '|' '/')
  echo "unit|$H|$u|$st|$a|$d"
done
for uh in /home/*; do
  usr=$(basename "$uh"); uid=$(id -u "$usr" 2>/dev/null) || continue
  [ -d "/run/user/$uid" ] || continue
  sudo -n -u "$usr" XDG_RUNTIME_DIR="/run/user/$uid" systemctl --user list-unit-files --type=service --no-pager --plain 2>/dev/null | awk '{print $1, $2}' | grep -i -E "$PAT|hermes|link" | while read -r u st; do
    a=$(sudo -n -u "$usr" XDG_RUNTIME_DIR="/run/user/$uid" systemctl --user is-active "$u" 2>/dev/null)
    echo "userunit|$H|$usr:$u|$st|$a|"
  done
done
timeout 20 sudo -n docker ps -a --format '{{.Names}}|{{.Image}}|{{.Status}}' 2>/dev/null | grep -i -E "$PAT|actual|plaid|messages" | sed "s/^/docker|$H|/"
# Claude OAuth fronts keep one env file each in /etc/<name>-claude-mcp/ (or /etc/ybots-mcp/).
for f in /etc/*-claude-mcp/*.env /etc/ybots-mcp/*.env; do
  [ -f "$f" ] || continue
  pub=$(sudo -n grep -h -E '^FRONT_BASE_URL=' "$f" | cut -d= -f2-); up=$(sudo -n grep -h -E '^MCP_UPSTREAM_URL=' "$f" | cut -d= -f2-)
  echo "front|$H|$(basename "$f" .env)|$pub|$up"
done
for c in /home/*/.hermes/config.yaml /home/*/.hermes/profiles/*/config.yaml; do
  [ -f "$c" ] || continue
  sudo -n python3 -c "import yaml,sys
c=yaml.safe_load(open(sys.argv[1])) or {}
for k,v in (c.get('mcp_servers') or {}).items():
    print('hermes|'+sys.argv[2]+'|'+sys.argv[1]+'|'+k+'|'+str(v.get('url') or v.get('command'))+'|'+str(v.get('enabled',True)))" "$c" "$H" 2>/dev/null
done
echo "done|$H"
