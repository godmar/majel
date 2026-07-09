# Machine API — submitting tasks from other applications

The C2C server exposes a small HTTP API so that other applications (webhooks,
schedulers, chat bots, internal services) can create agent tasks on behalf of a
user and collect the results. It is the same code path the web UI uses
(`createTask()`), so tasks created here behave identically: they appear in the
user's task list, run in a sandboxed Kubernetes job, and keep their transcript,
result text, and output files.

## Base URL

| Where the caller runs | Base URL |
|---|---|
| Anywhere on the internet | `https://vtlibai-cc.endeavour.cs.vt.edu` |
| Inside the `vtlib` namespace on the endeavour cluster | `http://c2c.vtlib.svc.cluster.local` |

## Authentication

Every request must carry the shared machine token:

```
Authorization: Bearer $CC_BEARER_TOKEN
```

The token is the `CC_BEARER_TOKEN` value from the C2C server's environment
(`.env` locally, the `c2c-env` secret in the cluster). Requests without it (or
with a wrong value) get `401 Unauthorized`.

**Treat this token like a root credential.** It authorizes acting as *any*
user and reading *any* task. It must only live in server-side configuration of
trusted applications — never in a browser, mobile app, or public repository.

## Acting on behalf of a user

LLM API keys on this platform are strictly per person, so every task must be
attributed to a real user: the `user` field (the person's VT username / PID) is
**required** when creating a task. Two conditions must hold, or creation fails:

1. The user has an account on the C2C and it is enabled (`404` otherwise).
2. The user has saved an API key for the LLM provider that will run the task
   (under **Settings → API Keys** in the web UI). This is checked before the
   task is created, so a missing key fails immediately with `422` rather than
   producing a failed task.

The created task shows up in that user's task list in the web UI exactly as if
they had submitted it there, with `trigger_source = "api"`.

## Endpoints

### `POST /api/tasks` — create a task

Two request formats are accepted:

**JSON** (no input files):

```json
{
  "agent": "Majel",
  "prompt": "Check the attached ISBN list for holdings overlap.",
  "user": "gback",
  "model": "vt-openwebui/GLM-5.2"
}
```

**multipart/form-data** (when input files should be placed in the agent's
working directory) — same field names, plus one or more `files` parts:

```sh
curl -X POST "$BASE/api/tasks" \
  -H "Authorization: Bearer $CC_BEARER_TOKEN" \
  -F agent=Majel \
  -F prompt="Check the attached ISBN list for holdings overlap." \
  -F user=gback \
  -F files=@isbn-list.csv \
  -F files=@notes.txt
```

| Field | Required | Meaning |
|---|---|---|
| `agent` | yes | Name of a configured, enabled agent definition (exact match, e.g. `Majel`). Configured by admins under **Admin → Agents**. |
| `prompt` | yes | The task text given to the agent. |
| `user` | yes | Username the task runs on behalf of (see above). |
| `model` | no | Override the agent's default model, as `<provider>/<modelID>` (e.g. `vt-openwebui/GLM-5.2`). Must be a provider/model configured on the platform. |
| `files` | no | (multipart only, repeatable) Input files, written into the agent's working directory before it starts. Limits: 25 MB per file, 100 MB total per task. |

Responses:

| Status | Body | Meaning |
|---|---|---|
| `201` | `{"id": "<uuid>", "status": "pending"}` | Task created and being launched. |
| `400` | `{"error": "..."}` | Malformed body / missing required field. |
| `401` | — | Missing or invalid bearer token. |
| `404` | `{"error": "..."}` | Unknown or disabled agent, or unknown/disabled user. |
| `422` | `{"error": "..."}` | Task could not be created — most commonly the user has no API key for the provider, an unknown provider in `model`, or a file exceeds the size limits. |

Each `POST` creates a new task; there is no idempotency key, so retry only
when you got no `201` back.

### `GET /api/tasks/:taskId` — status and result

```sh
curl -H "Authorization: Bearer $CC_BEARER_TOKEN" "$BASE/api/tasks/$TASK_ID"
```

```json
{
  "id": "310a07f4-812e-4f6b-84ca-44f87394cbf7",
  "status": "succeeded",
  "prompt": "Check the attached ISBN list for holdings overlap.",
  "resultText": "I checked all 42 ISBNs...",
  "error": null,
  "createdAt": "2026-07-08T15:04:05.000Z",
  "startedAt": "2026-07-08T15:04:21.000Z",
  "finishedAt": "2026-07-08T15:06:40.000Z",
  "files": [
    { "id": 6, "kind": "input",  "filename": "isbn-list.csv", "mimeType": "text/csv",
      "sizeBytes": 1834, "createdAt": "2026-07-08T15:04:05.000Z" },
    { "id": 7, "kind": "output", "filename": "overlap-report.xlsx",
      "mimeType": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      "sizeBytes": 24576, "createdAt": "2026-07-08T15:06:39.000Z" }
  ]
}
```

- `resultText` is the agent's final answer (markdown), set once the task
  succeeds.
- `error` is set when the task fails or times out.
- `files` lists metadata for input files (what you uploaded) and output files
  (what the agent produced); download content via the endpoint below.
- Returns `404` for an unknown task id.

**Task lifecycle** — `status` moves through:

```
pending → scheduled → running → succeeded | failed | timeout | canceled
```

The last four are terminal. A typical task takes between a minute and the
agent's configured timeout (default 30 minutes), so **poll every 5–15 seconds
until the status is terminal**. There is no callback/webhook mechanism yet.

### `GET /api/tasks/:taskId/files/:fileId` — download a file

Returns the raw bytes of one task file (input or output) with its stored
`Content-Type` and a `Content-Disposition: attachment` filename. `fileId`
comes from the `files` array of the status response. Returns `404` if the file
does not belong to that task.

```sh
curl -H "Authorization: Bearer $CC_BEARER_TOKEN" \
  -o overlap-report.xlsx "$BASE/api/tasks/$TASK_ID/files/7"
```

## End-to-end example

```sh
#!/usr/bin/env bash
set -euo pipefail
BASE=https://vtlibai-cc.endeavour.cs.vt.edu
AUTH="Authorization: Bearer $CC_BEARER_TOKEN"

# 1. Submit
TASK_ID=$(curl -sf -X POST "$BASE/api/tasks" -H "$AUTH" \
  -F agent=Majel -F user=gback \
  -F prompt="Check the attached ISBN list for holdings overlap." \
  -F files=@isbn-list.csv | jq -r .id)
echo "task: $TASK_ID"

# 2. Poll until terminal
while :; do
  TASK=$(curl -sf -H "$AUTH" "$BASE/api/tasks/$TASK_ID")
  STATUS=$(jq -r .status <<<"$TASK")
  case $STATUS in succeeded|failed|timeout|canceled) break;; esac
  sleep 10
done
echo "finished: $STATUS"

# 3. Result text and output files
jq -r '.resultText // .error' <<<"$TASK"
for row in $(jq -r '.files[] | select(.kind=="output") | "\(.id):\(.filename)"' <<<"$TASK"); do
  curl -sf -H "$AUTH" -o "${row#*:}" "$BASE/api/tasks/$TASK_ID/files/${row%%:*}"
  echo "downloaded ${row#*:}"
done
```

The same flow in Node.js:

```js
const BASE = "https://vtlibai-cc.endeavour.cs.vt.edu";
const headers = { Authorization: `Bearer ${process.env.CC_BEARER_TOKEN}` };

const form = new FormData();
form.set("agent", "Majel");
form.set("user", "gback");
form.set("prompt", "Check the attached ISBN list for holdings overlap.");
form.append("files", new Blob([await fs.readFile("isbn-list.csv")]), "isbn-list.csv");

const { id } = await (await fetch(`${BASE}/api/tasks`, { method: "POST", headers, body: form })).json();

let task;
do {
  await new Promise((r) => setTimeout(r, 10_000));
  task = await (await fetch(`${BASE}/api/tasks/${id}`, { headers })).json();
} while (!["succeeded", "failed", "timeout", "canceled"].includes(task.status));

console.log(task.resultText ?? task.error);
```

## Not part of this API

- Listing/discovering agents, models, or users — those are configured by
  admins in the web UI; coordinate the names out of band.
- Canceling a task (available in the web UI only).
- Push notifications when a task finishes — poll for now.
- The `/api/runner/...` routes are internal to the sandbox runner; external
  applications should not use them.
