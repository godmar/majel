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
docker build -t $SANDBOX_CONTAINER_IMAGE sandbox/ && docker push $SANDBOX_CONTAINER_IMAGE
```

## Machine API (external triggers)

Tasks can be created programmatically — the hook for future event-driven
agents. Authenticate with `CC_BEARER_TOKEN`. LLM API keys are per user, so
every task runs on behalf of a `user` (their key is used):

```sh
curl -X POST https://vtlibai-cc.endeavour.cs.vt.edu/api/tasks \
  -H "Authorization: Bearer $CC_BEARER_TOKEN" -H "Content-Type: application/json" \
  -d '{"agent": "Majel", "prompt": "…", "user": "gback", "model": "vt-openwebui/GLM-5.2"}'

curl https://vtlibai-cc.endeavour.cs.vt.edu/api/tasks/<id> \
  -H "Authorization: Bearer $CC_BEARER_TOKEN"
```

## Deployment

See `deploy/README.md`.
