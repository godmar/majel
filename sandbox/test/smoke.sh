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
  echo "SMOKE TEST PASSED"
else
  curl -s http://127.0.0.1:8092/verdict | jq . || true
  echo "SMOKE TEST FAILED"
  exit 1
fi
