#!/usr/bin/env bash
# Exercise the egress proxy's allow/deny paths against a live instance.
#
#   egress-proxy/test.sh
#
# Needs outbound HTTPS to example.com (the one host the tests tunnel to).
set -euo pipefail

DIR=$(cd "$(dirname "$0")" && pwd)
KEY="test-signing-key-$$"
PORT=${PORT:-18888}
PROXY=http://127.0.0.1:$PORT

EGRESS_SIGNING_KEY=$KEY PORT=$PORT node "$DIR/proxy.mjs" > /tmp/egress-test.$$.log 2>&1 &
PROXY_PID=$!
trap 'kill $PROXY_PID 2>/dev/null; rm -f /tmp/egress-test.$$.log' EXIT
sleep 1

mint() { # <hosts-json> <expires-offset-seconds>
  node -e '
    const {createHmac} = require("node:crypto");
    const p = Buffer.from(JSON.stringify({
      hosts: JSON.parse(process.argv[1]),
      expires: Math.floor(Date.now()/1000) + Number(process.argv[2]),
    })).toString("base64url");
    process.stdout.write(p + "." + createHmac("sha256", process.env.KEY).update(p).digest("base64url"));
  ' "$1" "$2"
}
export KEY

FAILED=0
check() { # <description> <expected: allow|deny> <credential> [host]
  local desc=$1 expect=$2 cred=$3 host=${4:-example.com}
  local proxy_arg code got=deny
  if [ -n "$cred" ]; then
    proxy_arg="http://agent:$cred@127.0.0.1:$PORT"
  else
    proxy_arg="$PROXY"
  fi
  code=$(curl -s -o /dev/null -w '%{http_code}' --max-time 20 \
    -x "$proxy_arg" "https://$host/" 2>/dev/null || true)
  [ "$code" = "200" ] && got=allow
  if [ "$got" = "$expect" ]; then
    echo "  ok    $desc"
  else
    echo "  FAIL  $desc (expected $expect, got $got; http=$code)"
    FAILED=1
  fi
}

echo "--- egress proxy"
check "allowlisted host is tunneled"        allow "$(mint '["example.com"]' 3600)"
check "subdomain rule matches"              allow "$(mint '[".example.com"]' 3600)" www.example.com
check "host not on the allowlist"           deny  "$(mint '["elsewhere.test"]' 3600)"
check "expired credential"                  deny  "$(mint '["example.com"]' -10)"
check "credential with a broken signature"  deny  "$(mint '["example.com"]' 3600)X"
check "no credential at all"                deny  ""

# The reason a request was refused has to reach the agent, which mostly means
# python: http.client puts the proxy's reason phrase into the exception it
# raises, so a blocked host reads as a policy decision and not a network fault.
explains() { # <description> <expected substring>
  local desc=$1 want=$2 out
  out=$(https_proxy="http://agent:$(mint '["example.com"]' 3600)@127.0.0.1:$PORT" \
    python3 -c 'import requests,sys
try:
    requests.get("https://elsewhere.test/", timeout=20)
except Exception as e:
    sys.stdout.write(str(e))' 2>/dev/null || true)
  if [[ "$out" == *"$want"* ]]; then
    echo "  ok    $desc"
  else
    echo "  FAIL  $desc (wanted \"$want\" in: $out)"
    FAILED=1
  fi
}

explains "python sees why it was refused"    "not on this agent's egress allowlist"
explains "python is told what is allowed"    "allowed: example.com"

if [ $FAILED -ne 0 ]; then
  echo "PROXY TEST FAILED"; cat /tmp/egress-test.$$.log; exit 1
fi
echo "PROXY TEST PASSED"
