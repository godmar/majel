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
