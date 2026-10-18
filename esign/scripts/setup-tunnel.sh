#!/bin/zsh
# One-time: publish the e-sign server as https://sign.lrghomes.com through a
# named Cloudflare Tunnel. Needs ~/.cloudflared/cert.pem first
# (`cloudflared tunnel login` → Ryan picks lrghomes.com → Authorize).
# Safe to re-run: every step checks before it acts.
set -euo pipefail
HOST="${ESIGN_HOST:-sign.lrghomes.com}"
NAME="${ESIGN_TUNNEL_NAME:-esign}"
PORT="${ESIGN_PORT:-5877}"
CF=/opt/homebrew/bin/cloudflared
DIR="$HOME/.cloudflared"
PLIST="$HOME/Library/LaunchAgents/com.lrghomes.esign-tunnel.plist"
HERE="$(cd "$(dirname "$0")/.." && pwd)"

[[ -f "$DIR/cert.pem" ]] || { echo "no $DIR/cert.pem — run: cloudflared tunnel login"; exit 1 }

if ! "$CF" tunnel list --output json | grep -q "\"name\":\"$NAME\""; then
  "$CF" tunnel create "$NAME"
fi
ID="$("$CF" tunnel list --output json | python3 -c 'import json,sys; t=[x for x in json.load(sys.stdin) if x["name"]==sys.argv[1]]; print(t[0]["id"])' "$NAME")"
CRED="$DIR/$ID.json"
[[ -f "$CRED" ]] || { echo "credentials file $CRED missing — delete the tunnel in the dashboard and re-run"; exit 1 }

cat > "$DIR/$NAME.yml" <<YML
tunnel: $ID
credentials-file: $CRED
ingress:
  - hostname: $HOST
    service: http://127.0.0.1:$PORT
    originRequest:
      httpHostHeader: $HOST
  - service: http_status:404
YML

# DNS: CNAME $HOST → <id>.cfargotunnel.com (idempotent; overwrites an old record)
"$CF" tunnel route dns --overwrite-dns "$NAME" "$HOST"

cp "$HERE/launchd/com.lrghomes.esign-tunnel.plist" "$PLIST"
launchctl unload "$PLIST" 2>/dev/null || true
launchctl load "$PLIST"
sleep 6
echo "--- tunnel log"; tail -5 "$HOME/Projects/logs/esign-tunnel.log"
echo "--- public check"; curl -s -o /dev/null -w "https://$HOST/healthz → %{http_code}\n" "https://$HOST/healthz" || true
