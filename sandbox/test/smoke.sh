#!/usr/bin/env bash
# Smoke-test a sandbox image against the runner<->opencode<->C2C contract,
# fully self-contained (fake LLM + mock C2C, no cluster, no real model).
#
# Usage: sandbox/test/smoke.sh <image>
set -euo pipefail

IMAGE=${1:?usage: smoke.sh <image>}
DIR=$(cd "$(dirname "$0")" && pwd)
TOKEN="smoke-test-token"
TASK_ID="00000000-smoke-test"
WORK=$(mktemp -d)
trap 'kill $(jobs -p) 2>/dev/null; rm -rf "$WORK"' EXIT

cat > "$WORK/config.json" <<'EOF'
{
  "$schema": "https://opencode.ai/config.json",
  "default_agent": "SmokeTest",
  "model": "fake/fake-model",
  "provider": {
    "fake": {
      "name": "Fake LLM",
      "npm": "@ai-sdk/openai-compatible",
      "options": { "apiKey": "test-key", "baseURL": "http://127.0.0.1:8091/v1" },
      "models": { "fake-model": { "name": "Fake Model" } }
    }
  },
  "agent": {
    "SmokeTest": {
      "mode": "primary",
      "prompt": "You are a test agent.",
      "permission": { "edit": "allow", "bash": "allow" }
    }
  }
}
EOF

node "$DIR/fake-llm.mjs" &
CC_BEARER_TOKEN=$TOKEN TASK_ID=$TASK_ID node "$DIR/mock-c2c.mjs" &
sleep 1

echo "--- running sandbox image $IMAGE"
docker run --rm --network host \
  -e TASK_ID=$TASK_ID \
  -e CC_API_URL=http://127.0.0.1:8092 \
  -e CC_BEARER_TOKEN=$TOKEN \
  -e OPENCODE_CONFIG=/etc/opencode/config.json \
  -e TASK_TIMEOUT_SECONDS=180 \
  -v "$WORK/config.json":/etc/opencode/config.json:ro \
  "$IMAGE"

echo "--- verdict"
if curl -sf http://127.0.0.1:8092/verdict | jq .; then
  echo "runner contract OK"
else
  curl -s http://127.0.0.1:8092/verdict | jq . || true
  echo "SMOKE TEST FAILED"
  exit 1
fi

# ------------------------------------------------------------- python toolkit
#
# Agents are expected to write python — reading a PDF invoice, handing back a
# spreadsheet — and pip at runtime costs a download on every task that needs
# it. These ship in the image, so assert they are importable rather than let a
# future rebuild quietly drop one and turn every such task into a pip install.
echo "--- checking the preinstalled python toolkit"
if ! docker run --rm --entrypoint python3 "$IMAGE" -c '
import openpyxl, pdfplumber, pypdf, pandas, numpy, requests, matplotlib
print("python toolkit OK")
'; then
  echo "SMOKE TEST FAILED: preinstalled python packages are missing"
  exit 1
fi

# --------------------------------------------------------------- policy check
#
# The C2C pins webfetch/websearch/question/doom_loop to "deny" at the config
# root precisely because opencode applies root permissions to every agent,
# including its built-in subagents ("general", "explore") — which ship with
# bash, webfetch and websearch allowed. If that precedence ever changes, an
# agent could reach the network by delegating to a subagent, so assert it here
# rather than discover it in production. See c2c/app/lib/opencode-config.server.ts.
echo "--- checking permission policy propagates to subagents"

cat > "$WORK/policy.json" <<'EOF'
{
  "$schema": "https://opencode.ai/config.json",
  "default_agent": "SmokeTest",
  "model": "fake/fake-model",
  "provider": {
    "fake": {
      "name": "Fake LLM",
      "npm": "@ai-sdk/openai-compatible",
      "options": { "apiKey": "test-key", "baseURL": "http://127.0.0.1:8091/v1" },
      "models": { "fake-model": { "name": "Fake Model" } }
    }
  },
  "tools": { "webfetch": false, "websearch": false, "question": false },
  "permission": {
    "webfetch": "deny", "websearch": "deny", "question": "deny", "doom_loop": "deny"
  },
  "agent": { "SmokeTest": { "mode": "primary", "prompt": "test", "permission": { "bash": "allow" } } }
}
EOF

POLICY=$(docker run --rm -d --network host \
  -e OPENCODE_CONFIG=/etc/opencode/config.json \
  -v "$WORK/policy.json":/etc/opencode/config.json:ro \
  --entrypoint opencode "$IMAGE" serve --hostname 127.0.0.1 --port 4097)
trap 'docker rm -f $POLICY >/dev/null 2>&1; kill $(jobs -p) 2>/dev/null; rm -rf "$WORK"' EXIT

for i in $(seq 1 30); do
  curl -sf http://127.0.0.1:4097/global/health >/dev/null 2>&1 && break; sleep 1
done

curl -sf http://127.0.0.1:4097/agent > "$WORK/agents.json" || {
  echo "could not read resolved agent policy"; echo "SMOKE TEST FAILED"; exit 1; }

jq -e '
  # Last matching rule wins, so fold each agent'"'"'s ruleset down to the
  # effective verdict for the catch-all pattern.
  [ .[] | select(.name | IN("SmokeTest", "general", "explore")) |
    { name: .name,
      eff: (reduce (.permission[]? | select(.pattern == "*")) as $r ({}; .[$r.permission] = $r.action)) }
  ]
  | length >= 3
  and all(.[]; .eff.webfetch == "deny" and .eff.websearch == "deny"
               and .eff.question == "deny" and .eff.doom_loop == "deny")
' "$WORK/agents.json" >/dev/null && echo "policy propagates to subagents OK" || {
  echo "FAILED: denied tools are not denied for every agent:"
  jq '[ .[] | { name, rules: [ .permission[]? | select(.pattern == "*") ] } ]' "$WORK/agents.json"
  echo "SMOKE TEST FAILED"; exit 1; }

echo "SMOKE TEST PASSED"
