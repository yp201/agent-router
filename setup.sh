#!/bin/bash
# agent-router transparent mode: local CA + api.anthropic.com leaf + LaunchAgent plist.
# Never runs sudo; prints the commands that need it. Idempotent: existing files are kept.
# `setup.sh --into DIR [--host NAME]` only makes the certs (the test uses this).
set -euo pipefail
DIR=~/.agent-router/ca HOST=api.anthropic.com CERTS_ONLY=
while [ $# -gt 0 ]; do case $1 in
  --into) DIR=$2 CERTS_ONLY=1; shift 2 ;;
  --host) HOST=$2; shift 2 ;;
  *) echo "usage: $0 [--into DIR] [--host NAME]" >&2; exit 2 ;;
esac; done
PROJ=$(cd "$(dirname "$0")" && pwd)
mkdir -p "$DIR" && chmod 700 "$DIR" && cd "$DIR"

if [ ! -f ca.pem ] || [ ! -f ca-key.pem ]; then
  openssl req -x509 -new -newkey rsa:2048 -nodes -sha256 -days 3650 -keyout ca-key.pem -out ca.pem \
    -subj "/CN=agent-router local CA" -config <(printf '[req]\ndistinguished_name=dn\nx509_extensions=v3\n[dn]\n[v3]\n%s\n' \
      'basicConstraints=critical,CA:TRUE' 'keyUsage=critical,keyCertSign,cRLSign' 'subjectKeyIdentifier=hash')
  rm -f "$HOST.pem" "$HOST-key.pem" # new CA: any old leaf no longer chains
  echo "created $DIR/ca.pem"
fi
if [ ! -f "$HOST.pem" ] || [ ! -f "$HOST-key.pem" ]; then
  openssl req -new -newkey rsa:2048 -nodes -keyout "$HOST-key.pem" -subj "/CN=$HOST" \
      -config <(printf '[req]\ndistinguished_name=dn\n[dn]\n') |
    openssl x509 -req -sha256 -days 397 -CA ca.pem -CAkey ca-key.pem -set_serial "0x$(openssl rand -hex 16)" -out "$HOST.pem" \
      -extfile <(printf '%s\n' "subjectAltName=DNS:$HOST" 'extendedKeyUsage=serverAuth' 'basicConstraints=critical,CA:FALSE' \
        'keyUsage=critical,digitalSignature,keyEncipherment' 'authorityKeyIdentifier=keyid')
  echo "created $DIR/$HOST.pem"
fi
chmod 600 ca-key.pem "$HOST-key.pem"
[ -n "$CERTS_ONLY" ] && exit 0

PLIST=~/Library/LaunchAgents/com.agent-router.plist
if [ -f "$PLIST" ]; then echo "kept existing $PLIST (delete it to regenerate)"; else
  NODE=$(node -p process.execPath) # real path: `which node` under fnm is a per-shell symlink that disappears
  mkdir -p ~/Library/LaunchAgents
  cat > "$PLIST" <<PL
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>com.agent-router</string>
  <key>ProgramArguments</key><array><string>$NODE</string><string>router.ts</string></array>
  <key>WorkingDirectory</key><string>$PROJ</string>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>StandardOutPath</key><string>$PROJ/router.log</string>
  <key>StandardErrorPath</key><string>$PROJ/router.log</string>
  <key>EnvironmentVariables</key><dict><key>PATH</key><string>$(dirname "$NODE"):/usr/bin:/bin</string></dict>
</dict></plist>
PL
  plutil -lint "$PLIST" >/dev/null
  echo "created $PLIST"
fi

[ -n "${NO_HINTS:-}" ] && exit 0
cat <<'MSG'

Now run these yourself, in order:
  1. trust the CA (System keychain):
     sudo security add-trusted-cert -d -r trustRoot -k /Library/Keychains/System.keychain ~/.agent-router/ca/ca.pem
  2. point api.anthropic.com at this machine:
     printf '127.0.0.1 api.anthropic.com\n::1 api.anthropic.com\n' | sudo tee -a /etc/hosts
  3. make the CA visible to the Bun-based claude CLI (the desktop passes inherited env to its child):
     launchctl setenv NODE_EXTRA_CA_CERTS ~/.agent-router/ca/ca.pem
  4. run the router under launchd (stops the manually started one first):
     pkill -f 'node router.ts'; launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/com.agent-router.plist
  5. Quit and reopen the Claude desktop app
Undo: ./uninstall.sh
MSG
