# VT Library AI Agent Platform

**Live at: https://vtlibai-cc.endeavour.cs.vt.edu** (VT CAS login; accounts must
be enabled by an admin)

A container-based agent platform for Virginia Tech Libraries. It has two parts:

1. **C2C server** (`c2c/`) — a command-and-control web application (React Router v7 +
   TypeScript + Material UI) with CAS authentication. Admins configure LLM providers,
   MCP servers, and agent definitions; users submit tasks (a prompt plus optional
   files) to a configured agent and monitor status, live activity, and results.
   Data lives in Postgres. Deployed as the `agent-supervisor` container image.
2. **Sandboxed agents** (`sandbox/`) — short-lived Kubernetes Jobs running the
   [opencode](https://opencode.ai) coding agent from a single `opencode-sandbox`
   image. A runner script inside the pod drives opencode's server API, streams the
   transcript back to the C2C, and uploads result text and output files when done.

Deployment manifests are in `deploy/` (namespace `vtlib` on the endeavour cluster).

## Repository layout

| Path | Purpose |
|---|---|
| `c2c/` | React Router v7 app (UI + machine API), Drizzle ORM, K8s job launcher |
| `sandbox/` | Sandbox container image + runner script |
| `egress-proxy/` | Allowlist proxy: the only route off the cluster for agent pods |
| `deploy/` | Kubernetes manifests and deployment runbook |
| `docs/` | Machine API reference for external applications |
| `opencode-master-config/` | Reference opencode configuration (the real `opencode.jsonc` is gitignored — it contains credentials) |
| `PLAN.md` | Original requirements |

## Development setup

Prerequisites: Node 22+, Docker, kubectl.

```sh
cp .env.sample .env        # fill in secrets
cd c2c
npm install
docker compose up -d       # dev Postgres on port 5433
npm run dev                # http://localhost:3000, migrations run on startup
```

For local development CAS cannot round-trip, so set `DEV_FAKE_USER=<username>` in
`.env` (honored only when `NODE_ENV !== 'production'`).

## Secrets

`.env`, `endeavour.yaml` (kubeconfig), and `opencode-master-config/opencode.jsonc`
contain credentials and are gitignored. `.env.sample` documents every variable.

## Building images

```sh
docker login container.cs.vt.edu   # use REGISTRY_USERNAME / REGISTRY_PASSWORD
docker build -t $CC_CONTAINER_IMAGE c2c/ && docker push $CC_CONTAINER_IMAGE
sandbox/redeploy.sh                # builds and pushes $SANDBOX_CONTAINER_IMAGE
```

To upgrade the opencode version inside the sandbox image, use
`sandbox/update-opencode.sh` instead — it smoke-tests the new version before
pushing.

## Agent working directory (`opencode-master-config/home/`)

Every agent starts in `/workspace`, pre-seeded with the contents of
`opencode-master-config/home/` — reference files (and private data; the
registry is private) that every task should find in its working directory,
alongside whatever input files the submitter attaches. The directory is
gitignored; it is baked into the sandbox image at build time.

After changing anything under `opencode-master-config/home/`, run:

```sh
sandbox/redeploy.sh
```

That rebuilds and pushes the sandbox image under the tag the cluster actually
launches (read from the `c2c-env` secret — usually an opencode version pinned
by `update-opencode.sh --deploy`) as well as `:latest`. Agent jobs pull the
image fresh on every launch, so tasks created after the push see the new files
immediately — no cluster restart needed. Tasks already running keep the files they started
with. (The build stages the directory into gitignored `sandbox/home/`; never
edit that copy.)

## Agent sandboxing

Agents run untrusted output from a model against real data, so the pod is
treated as the boundary rather than the model's good behavior.

**Permissions.** Each agent definition carries `read` / `edit` / `bash`, each
`allow` or `deny`. There is deliberately no `ask`: nothing can answer a prompt
in a one-shot pod, so an `ask` is only a `deny` that first burns the agent's
whole timeout. `renderOpencodeConfig()` turns those three settings into a
policy covering *every* permission key opencode knows, because leaving a key
unset does not mean "allow" — opencode ships built-in `ask` rules for
`doom_loop`, `external_directory`, and reads of `*.env` files, each of which
would hang a headless pod.

`webfetch`, `websearch`, and `question` are always denied and also removed
from the model's tool list, so the model never attempts them. The policy is
emitted at the config root as well as per agent: opencode's built-in
subagents (`general`, `explore`) ship with bash and network tools allowed, and
without the root block a primary agent could reach the network by delegating
to one. `sandbox/test/smoke.sh` asserts this against a live opencode; run it
after any opencode upgrade.

Anything opencode still stops to ask about is **refused** by the runner and
recorded as a task event. That is a liveness guard, not the policy — it turns
an unanticipated request from a 30-minute timeout into an immediate tool
error, and the event tells you which gap to close.

The runner also guards the other end of a turn. A provider that accepts a
request and streams nothing back leaves opencode with a completed turn holding
no parts, which is indistinguishable from finishing unless you look — the run
would be reported as a success whose result was whatever the agent last said
mid-thought. The runner retries such a turn once (a `turn_stalled` event
records it; the session history is intact, so the agent resumes rather than
restarts) and fails the task outright if the retry is empty too.

This has a measured profile. Three runs died the same way: **181-182s having
received not one byte**, on requests of 60k-71k tokens. None of that is
inherent to the size — measured against the same endpoint while it was idle,
prefill at 60-70k tokens takes about 8s, generation runs at 106-123 tok/s,
reasoning is streamed like any other content, and the longest gap between
bytes is under a second. What distinguishes the runs that died is that the
same endpoint was delivering **10.2 tok/s** during them, twelve times slower,
which is contention and not context length. Under load a request can be
served nothing at all, and at ~181s it gets cut.

It is not the egress proxy: an idle tunnel through it was measured open at
261s and still going. Whether the cut comes from VT's gateway or opencode's
own HTTP client is the remaining question, and the proxy's `tunnel-closed`
line — byte counts plus which side sent FIN first — answers it the next time
it happens.

**Python.** Agents are expected to write and run Python, so the image ships
the libraries the work keeps needing: pandas, numpy, matplotlib, requests,
`openpyxl` for producing spreadsheets, and `pdfplumber`/`pypdf` for reading
PDFs. `pip install` also works, but a per-task download is latency on every
task, and the smoke test asserts these stay importable.

**Network.** Agent pods have no route off the cluster except an HTTP CONNECT
proxy that tunnels only to hostnames on that agent's allowlist — its model
provider, the Python package index, the MCP servers it was granted, plus any
extra hosts an admin adds under **Additional network hosts**. Denying
`webfetch` alone would not be worth much, since the `bash` tool can run
`curl`; the NetworkPolicy is what makes it stick.

A refusal names the host it blocked and lists what the agent may reach, in
both the reason phrase and the body, so a blocked call reads as a policy
decision rather than a network fault — python surfaces the reason phrase in
the exception it raises, which is where agents usually meet this.

The allowlist travels with the pod inside its signed proxy password, so the
proxy stays stateless and egress keeps working while the C2C is redeploying.
The NetworkPolicy names no IPs — agent pods may reach three *pod selectors*
(kube-dns, the C2C, the proxy), and hostname matching happens in the proxy at
connection time, so allowlisted services can renumber freely.

**What the pod may say back.** The runner has to reach the C2C to fetch its
prompt and report results, and it cannot keep that credential from the agent
it supervises: both run in one container as one uid, so anything in the
runner's environment is one `env` away from the agent's `bash` — and one
`cat /proc/1/environ` away even if the child's environment is scrubbed, since
/proc reports the exec-time block that unsetting a variable does not rewrite.
So the pod carries a credential built to be worthless when it leaks: a signed
grant naming one task, expiring with the pod, good only for that task's
`/api/runner` routes, all of which the agent already drives. The shared
`CC_BEARER_TOKEN` — which acts as any user and reads any task — stays
server-side and never enters a pod.

Two limits worth knowing. Hosts sharing an ingress are not distinguishable:
an agent allowed to reach one vhost can send another `Host` header over the
same tunnel, which separating them would require intercepting TLS to prevent.
And kube-dns remains reachable, so DNS stays available as a low-bandwidth
side channel.

## Concurrency limits (per LLM API key)

Every task consumes one LLM API key — the submitting user's key for the
provider the task's model runs on. Each key can carry a **concurrent task
limit**, set by the key's owner next to the key under **Settings → API Keys**
(0 = unlimited, the default).

When a key is at its limit, additional tasks wait in a FIFO queue (status
`pending`, with a "Waiting for a free slot" entry in the task's event log) and
start automatically as soon as one of that key's tasks reaches a terminal
state — succeeded, failed, timeout, or canceled. Queued tasks can be canceled
like any other, and time spent waiting does not count against the agent's
execution timeout.

Implementation notes: `createTask()` no longer launches directly — the
dispatcher in `c2c/app/lib/queue.server.ts` launches pending tasks
oldest-first, re-triggered by every slot-freeing event and by the 30-second
reconciler as a backstop (which also recovers queued tasks after a server
restart). The dispatcher's bookkeeping is in-process and assumes the c2c
Deployment runs a **single replica**; scaling it out requires adding a
cross-replica lock (e.g. a Postgres advisory lock) around the dispatch pass.

## Task feedback (rating + comments)

The task detail page carries a **Feedback** card where humans evaluate the
agent's work: a 1–5 star rating (Likert scale) and a comment thread. A task
holds a single rating — anyone with access to the task (its creator or an
admin) can change it, and the system records who changed it last and when.
Comments are append-only and unlimited; each shows its author and timestamp.
Both live in Postgres (`tasks.rating` / `rating_updated_by` /
`rating_updated_at` and the `task_comments` table), so they are available for
later analysis of agent quality.

## Machine API (external triggers)

Other applications can create tasks programmatically on behalf of a user
(bearer-token auth, optional input files, status polling, output file
download). See **[docs/API.md](docs/API.md)** for the full reference; the
short version:

```sh
curl -X POST https://vtlibai-cc.endeavour.cs.vt.edu/api/tasks \
  -H "Authorization: Bearer $CC_BEARER_TOKEN" -H "Content-Type: application/json" \
  -d '{"agent": "Majel", "prompt": "…", "user": "gback", "model": "vt-openwebui/GLM-5.2"}'

curl https://vtlibai-cc.endeavour.cs.vt.edu/api/tasks/<id> \
  -H "Authorization: Bearer $CC_BEARER_TOKEN"
```

## Deployment

See `deploy/README.md`.
