#!/usr/bin/env bash
# Smoke-test a sandbox image against the runner<->opencode<->C2C contract,
# fully self-contained (fake LLM + mock C2C, no cluster, no real model).
#
# Usage: sandbox/test/smoke.sh <image>
set -euo pipefail

IMAGE=${1:?usage: smoke.sh <image>}
DIR=$(cd "$(dirname "$0")" && pwd)
SIGNING_KEY="smoke-test-signing-key"
TASK_ID="00000000-smoke-test"
# The pod's credential is a signed grant naming one task, minted by the C2C
# (c2c/app/lib/runner-credential.server.ts). Mint one the same way so the
# runner is exercised against the real contract rather than a shared string.
TOKEN=$(SIGNING_KEY="$SIGNING_KEY" TASK_ID="$TASK_ID" node -e '
  const { createHmac } = require("node:crypto");
  const grant = { taskId: process.env.TASK_ID, expires: Math.floor(Date.now() / 1000) + 3600 };
  const payload = Buffer.from(JSON.stringify(grant)).toString("base64url");
  const mac = createHmac("sha256", process.env.SIGNING_KEY).update(payload).digest("base64url");
  process.stdout.write(`${payload}.${mac}`);
')
WORK=$(mktemp -d)
# kill fails (and, under set -e, fails the script) when no jobs are left.
trap 'kill $(jobs -p) 2>/dev/null || true; rm -rf "$WORK"' EXIT

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

# One run of the image against fresh fake-llm/mock-c2c processes, so no state
# leaks between scenarios. Sets STATE (mock-c2c's record of the run) and
# VERDICT_CODE; the runner is allowed to exit non-zero, since one scenario
# expects exactly that.
run_scenario() { # <fake-llm mode>
  FAKE_LLM_MODE=$1 node "$DIR/fake-llm.mjs" > "$WORK/fake-llm.log" 2>&1 &
  local llm_pid=$!
  RUNNER_SIGNING_KEY=$SIGNING_KEY TASK_ID=$TASK_ID node "$DIR/mock-c2c.mjs" > "$WORK/mock-c2c.log" 2>&1 &
  local cc_pid=$!
  sleep 1

  docker run --rm --network host \
    -e TASK_ID=$TASK_ID \
    -e CC_API_URL=http://127.0.0.1:8092 \
    -e CC_RUNNER_TOKEN=$TOKEN \
    -e OPENCODE_CONFIG=/etc/opencode/config.json \
    -e TASK_TIMEOUT_SECONDS=180 \
    -v "$WORK/config.json":/etc/opencode/config.json:ro \
    "$IMAGE" || true

  STATE=$(curl -s http://127.0.0.1:8092/state)
  VERDICT_CODE=$(curl -s -o "$WORK/verdict.json" -w '%{http_code}' http://127.0.0.1:8092/verdict)
  kill $llm_pid $cc_pid 2>/dev/null || true
  wait $llm_pid $cc_pid 2>/dev/null || true
}

echo "--- running sandbox image $IMAGE"
run_scenario normal

echo "--- verdict"
jq . "$WORK/verdict.json" || true
if [ "$VERDICT_CODE" = "200" ]; then
  echo "runner contract OK"
else
  echo "SMOKE TEST FAILED"
  exit 1
fi

# --------------------------------------------------------------- empty turns
#
# A provider that accepts a request and streams nothing back leaves opencode
# with a completed turn holding no parts at all. That used to end the run
# silently: the runner reported success, and the task showed whatever the
# agent had last said mid-thought as its result. It has to recover when it
# can and fail when it cannot — see runToCompletion() in runner.mjs.
#
# opencode >= 1.18.21 retries a turn that finishes "unknown" by itself, with
# no limit; a turn that finishes "stop" with nothing in it still ends its
# loop, and then it is the runner that has to nudge the agent on.
stalled_and_recovered() {
  echo "$STATE" | jq -e '
      (.events | index("turn_stalled")) and
      (.result.ok == true) and
      ((.result.resultText // "") | length > 0)' > /dev/null
}

echo "--- checking a single empty turn is retried"
run_scenario stall-once
echo "$STATE" | jq .
if ! stalled_and_recovered; then
  echo "SMOKE TEST FAILED: an empty turn should be retried and the run should still finish"
  exit 1
fi
echo "empty turn recovered OK"

echo "--- checking the runner nudges an agent that stops on an empty turn"
run_scenario stall-stop-once
echo "$STATE" | jq .
if ! stalled_and_recovered; then
  echo "SMOKE TEST FAILED: an agent that stops on an empty turn should be nudged to finish"
  exit 1
fi
echo "empty final turn nudged OK"

echo "--- checking an unrecoverable empty turn fails loudly"
run_scenario stall-always
echo "$STATE" | jq .
# No turn_stalled event is required here: empty turns this fast blow the
# budget before the runner's first poll, so the failure is the only record.
if ! echo "$STATE" | jq -e '
      (.result.ok == false) and
      ((.result.error // "") | test("empty response"))' > /dev/null; then
  echo "SMOKE TEST FAILED: a run that never recovers must be reported as failed"
  exit 1
fi
# Left alone, opencode re-requests an empty turn ~20 times a second until the
# deadline; the runner has to cut that off within a poll or two.
STALLS=$(grep -c "returning an empty stream" "$WORK/fake-llm.log" || true)
echo "provider saw $STALLS empty requests"
if [ "$STALLS" -gt 200 ]; then
  echo "SMOKE TEST FAILED: the runner let opencode retry an empty turn $STALLS times"
  exit 1
fi
echo "unrecoverable empty turn reported as failure OK"

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
trap 'docker rm -f $POLICY >/dev/null 2>&1; kill $(jobs -p) 2>/dev/null || true; rm -rf "$WORK"' EXIT

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

# --------------------------------------------------------------- skills
#
# The C2C mounts an agent's granted skills, with their supporting files, at
# ~/.config/opencode/skills and pins the skill permission to deny everything
# else, which must also hide the skills opencode ships built in. The
# workspace confinement (external_directory) has to let the agent read and run
# those files, or a skill's scripts are useless. Both rules are mirrored from
# renderPermissions() in c2c/app/lib/opencode-config.server.ts.
#
# Checked end to end: the skill list in the system prompt of a real request,
# then a scripted model that loads the skill, reads and runs its files, and
# tries to load a skill it was not granted.
echo "--- checking skills: only granted ones offered, their files usable"

for s in granted-skill ungranted-skill; do
  mkdir -p "$WORK/skills/$s/scripts" "$WORK/skills/$s/reference"
  printf -- '---\nname: %s\ndescription: "Smoke test skill %s."\n---\n\nRun scripts/hello.py.\n' \
    "$s" "$s" > "$WORK/skills/$s/SKILL.md"
done
printf 'print("hello from the skill script")\n' > "$WORK/skills/granted-skill/scripts/hello.py"
printf 'reference notes for the skill\n' > "$WORK/skills/granted-skill/reference/notes.md"
jq '.permission = {
      skill: { "*": "deny", "granted-skill": "allow" },
      external_directory: {
        "*": "deny",
        "/home/agent/.local/share/opencode/tool-output/*": "allow",
        "/tmp/opencode/*": "allow",
        "/home/agent/.config/opencode/skills/*": "allow"
      }
    }
    | .agent.SmokeTest.permission += .permission' \
  "$WORK/config.json" > "$WORK/skills.json"

FAKE_LLM_MODE=skill-files FAKE_LLM_DUMP="$WORK/request.json" \
  node "$DIR/fake-llm.mjs" > "$WORK/fake-llm.log" 2>&1 &
SKILLS=$(docker run --rm -d --network host \
  -e OPENCODE_CONFIG=/etc/opencode/config.json \
  -v "$WORK/skills.json":/etc/opencode/config.json:ro \
  -v "$WORK/skills":/home/agent/.config/opencode/skills:ro \
  --entrypoint opencode "$IMAGE" serve --hostname 127.0.0.1 --port 4098)
trap 'docker rm -f $POLICY $SKILLS >/dev/null 2>&1; kill $(jobs -p) 2>/dev/null || true; rm -rf "$WORK"' EXIT

for i in $(seq 1 30); do
  curl -sf http://127.0.0.1:4098/global/health >/dev/null 2>&1 && break; sleep 1
done
SID=$(curl -sf -X POST http://127.0.0.1:4098/session -H 'content-type: application/json' -d '{}' | jq -r .id)
curl -sf -X POST "http://127.0.0.1:4098/session/$SID/prompt_async" \
  -H 'content-type: application/json' -d '{"parts":[{"type":"text","text":"hi"}]}' >/dev/null
for i in $(seq 1 60); do
  curl -sf "http://127.0.0.1:4098/session/$SID/message" > "$WORK/skills-run.json" 2>/dev/null \
    && jq -e '.[-1].info.finish == "stop"' "$WORK/skills-run.json" >/dev/null 2>&1 && break
  sleep 1
done

jq -r '[.messages[] | select(.role == "system") | .content
        | if type == "string" then . else (map(.text // "") | join("\n")) end] | join("\n")' \
  "$WORK/request.json" > "$WORK/system.txt" 2>/dev/null || true
if grep -q "<name>granted-skill</name>" "$WORK/system.txt" \
   && ! grep -q "<name>ungranted-skill</name>" "$WORK/system.txt" \
   && ! grep -q "<name>customize-opencode</name>" "$WORK/system.txt"; then
  echo "only granted skills offered OK"
else
  echo "FAILED: the model was not offered exactly the granted skill:"
  grep -o "<name>[^<]*</name>" "$WORK/system.txt" || echo "(no skills listed)"
  echo "SMOKE TEST FAILED"; exit 1
fi

# The scripted calls, in order: tool, expected status, text the output must contain.
jq -c '[.[] | .parts[]? | select(.type == "tool")
        | { tool, status: .state.status, out: (.state.output // .state.error // "") }]' \
  "$WORK/skills-run.json" > "$WORK/skill-calls.json"
SKILL_FAIL=0
check_call() { # <index> <what> <status> <substring>
  if jq -e --argjson i "$1" --arg st "$3" --arg sub "$4" \
       '.[$i] | .status == $st and (.out | contains($sub))' "$WORK/skill-calls.json" >/dev/null; then
    echo "  $2 OK"
  else
    echo "  FAILED: $2"; jq --argjson i "$1" '.[$i] | .out |= .[0:400]' "$WORK/skill-calls.json"
    SKILL_FAIL=1
  fi
}
check_call 0 "granted skill loads and lists its files" completed "scripts/hello.py"
check_call 1 "read tool can read a skill file" completed "hello from the skill script"
check_call 2 "bash can run a skill script" completed "hello from the skill script"
check_call 3 "bash can read a skill reference file" completed "reference notes for the skill"
check_call 4 "ungranted skill is refused" error ""
if [ "$SKILL_FAIL" = 1 ]; then echo "SMOKE TEST FAILED"; exit 1; fi
echo "skill files usable OK"

echo "SMOKE TEST PASSED"
