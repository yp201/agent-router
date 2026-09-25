#!/bin/bash
# agent-router control script — the thing the future menubar app will wrap.
#   install    certs + plist, trust CA, hosts entry, NODE_EXTRA_CA_CERTS, launchd, health check  (sudo prompts)
#   uninstall  reverse all of it
#   status     one line per component
#   start|stop|restart|logs|ui
set -uo pipefail
PROJ=$(cd "$(dirname "$0")" && pwd); CA=~/.agent-router/ca/ca.pem
PLIST=~/Library/LaunchAgents/com.agent-router.plist; LABEL=gui/$(id -u)/com.agent-router
KC=/Library/Keychains/System.keychain; CN="agent-router local CA"
say() { printf '  %-28s %s\n' "$1" "$2"; }
trusted()  { security find-certificate -c "$CN" "$KC" >/dev/null 2>&1; }
hosted()   { grep -q '^127\.0\.0\.1[[:space:]]*api\.anthropic\.com' /etc/hosts 2>/dev/null; }
loaded()   { launchctl print "$LABEL" >/dev/null 2>&1; }
health()   { curl -s -m 2 localhost:4001/router/health; }
transp()   { curl -s -m 5 --cacert "$CA" --resolve api.anthropic.com:443:127.0.0.1 https://api.anthropic.com/api/hello -o /dev/null -w '%{http_code}'; }
wait_up()  { for _ in $(seq 1 20); do health >/dev/null 2>&1 && return 0; sleep 0.5; done; return 1; }

preflight() {
  command -v openssl >/dev/null || { echo "openssl not found (it ships with macOS; on Linux: apt/dnf install openssl)"; exit 1; }
  if ! command -v node >/dev/null || [ "$(node -p 'process.versions.node.split(".")[0]')" -lt 24 ]; then
    echo "Node.js 24+ is required. Install it, then re-run:"; echo "  brew install node        # macOS"; echo "  https://nodejs.org        # Linux / anything else"; exit 1; fi
}
cmd_install() {
  preflight
  NO_HINTS=1 "$PROJ/setup.sh"
  if trusted; then say "CA trust" "already trusted"; else
    echo "-> trusting $CN in System keychain (sudo)"; sudo security add-trusted-cert -d -r trustRoot -k "$KC" "$CA" && say "CA trust" "ok"; fi
  if hosted; then say "/etc/hosts" "already set"; else
    echo "-> adding api.anthropic.com -> loopback to /etc/hosts (sudo)"
    printf '127.0.0.1 api.anthropic.com\n::1 api.anthropic.com\n' | sudo tee -a /etc/hosts >/dev/null && say "/etc/hosts" "ok"; fi
  launchctl setenv NODE_EXTRA_CA_CERTS "$CA" && say "NODE_EXTRA_CA_CERTS" "set (lost on reboot: re-run install)"
  pkill -f 'node router.ts' 2>/dev/null && sleep 0.5
  if loaded; then launchctl kickstart -k "$LABEL"; else launchctl bootstrap "$LABEL" "$PLIST" 2>/dev/null || launchctl bootstrap "gui/$(id -u)" "$PLIST"; fi
  wait_up && say "router (launchd)" "up" || { say "router (launchd)" "NOT UP — see router.log"; exit 1; }
  say "transparent path" "HTTP $(transp) from api.anthropic.com via :443"
  cat <<MSG

Done. Last step is yours: quit and reopen the Claude desktop app (its sessions resume).
Then open a Code tab, say hi, and check http://localhost:4001/router/ — the request should appear there.
MSG
}
cmd_uninstall() {
  loaded && launchctl bootout "$LABEL" && say "router (launchd)" "stopped"
  pkill -f 'node router.ts' 2>/dev/null
  launchctl unsetenv NODE_EXTRA_CA_CERTS; say "NODE_EXTRA_CA_CERTS" "unset"
  if hosted; then echo "-> removing hosts entries (sudo)"; sudo sed -i '' '/api\.anthropic\.com/d' /etc/hosts && say "/etc/hosts" "restored"; fi
  if trusted; then echo "-> removing CA from System keychain (sudo)"; sudo security delete-certificate -c "$CN" "$KC" && say "CA trust" "removed"; fi
  echo "Certs kept in ~/.agent-router/ca (delete the dir to regenerate). Quit and reopen Claude."
}
cmd_status() {
  say "CA trust"           "$(trusted && echo yes || echo no)"
  say "/etc/hosts"         "$(hosted && echo 'api.anthropic.com -> loopback' || echo 'not set')"
  v=$(launchctl getenv NODE_EXTRA_CA_CERTS); say "NODE_EXTRA_CA_CERTS" "${v:-unset}"
  say "launchd"            "$(loaded && echo loaded || echo 'not loaded')"
  h=$(health); say "router :4001" "${h:-DOWN}"
  say "transparent :443"   "$([ -f "$CA" ] && echo "HTTP $(transp)" || echo 'no certs')"
}
case ${1:-} in
  install)   cmd_install ;;
  uninstall) cmd_uninstall ;;
  status)    cmd_status ;;
  start)     loaded && launchctl kickstart "$LABEL" || launchctl bootstrap "gui/$(id -u)" "$PLIST"; wait_up && echo up ;;
  stop)      loaded && launchctl bootout "$LABEL"; pkill -f 'node router.ts' 2>/dev/null; echo stopped ;;
  restart)   launchctl kickstart -k "$LABEL" && wait_up && echo up ;;
  logs)      tail -f "$PROJ/router.log" ;;
  ui)        open http://localhost:4001/router/ ;;
  *)         echo "usage: $0 install|uninstall|status|start|stop|restart|logs|ui"; exit 2 ;;
esac
