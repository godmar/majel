# Deployment runbook (endeavour cluster, namespace `vtlib`)

All commands assume `KUBECONFIG=endeavour.yaml` (repo root) or `--kubeconfig endeavour.yaml`.

## One-time setup

1. **Registry pull secret** — already present in the namespace as `registry-secret`
   (dockerconfigjson for container.cs.vt.edu).

2. **Secrets** (see `secrets.sample.yaml` for the full variable list):

   ```sh
   PGPASS=$(openssl rand -hex 16)
   kubectl -n vtlib create secret generic c2c-postgres-secret --from-literal=password=$PGPASS

   kubectl -n vtlib create secret generic c2c-env \
     --from-literal=DATABASE_URL="postgres://c2c:$PGPASS@c2c-postgres.vtlib.svc.cluster.local:5432/c2c" \
     --from-literal=SESSION_SECRET="$(openssl rand -base64 32)" \
     --from-literal=CAS_SERVICE_URL="https://vtlibai-cc.endeavour.cs.vt.edu/api/user/casvalidate" \
     --from-literal=CAS_LOGIN_URL="https://login.vt.edu/profile/cas/login" \
     --from-literal=CAS_SERVICE_VALIDATE_URL="https://login.vt.edu/profile/cas/serviceValidate" \
     --from-literal=ADMIN_ACCOUNTS="gback,afbailey" \
     --from-literal=CC_BEARER_TOKEN="<from .env>" \
     --from-literal=CC_BEARER_URL="https://vtlibai-cc.endeavour.cs.vt.edu" \
     --from-literal=CC_INTERNAL_URL="http://c2c.vtlib.svc.cluster.local:3000" \
     --from-literal=K8S_NAMESPACE="vtlib" \
     --from-literal=SANDBOX_CONTAINER_IMAGE="container.cs.vt.edu/gback/registry/opencode-sandbox:latest" \
     --from-literal=LLM_API_BASE_URL="https://llm-api.arc.vt.edu/api/v1" \
     --from-literal=LLM_API_KEY="<from .env>"

   kubectl -n vtlib create secret generic c2c-kubeconfig --from-file=config=endeavour.yaml
   ```

## Build & push images

Requires a GitLab token with `write_registry` on the `gback/registry` project
(the deploy token in `.env` is pull-only).

```sh
docker login container.cs.vt.edu
docker build -t container.cs.vt.edu/gback/registry/agent-supervisor:latest c2c/
docker push container.cs.vt.edu/gback/registry/agent-supervisor:latest
docker build -t container.cs.vt.edu/gback/registry/opencode-sandbox:latest sandbox/
docker push container.cs.vt.edu/gback/registry/opencode-sandbox:latest
```

## Deploy

```sh
kubectl apply -f deploy/postgres.yaml
kubectl apply -f deploy/c2c.yaml
kubectl apply -f deploy/ingress.yaml
```

Database migrations run automatically when the C2C pod starts. Seed the
initial provider/MCP/agent config either through the admin UI or by running
`npm run db:seed` locally with `DATABASE_URL` pointed at the cluster DB
(e.g. via `kubectl port-forward svc/c2c-postgres 5433:5432`).

## Updating opencode

The sandbox pins its opencode version; the runner depends on opencode's
server API, so new versions must pass the contract smoke test before rollout:

```sh
sandbox/update-opencode.sh                # build + smoke-test latest release
sandbox/update-opencode.sh 1.18.2         # ...or a specific version
sandbox/update-opencode.sh 1.18.2 --deploy  # ...and point the cluster at it
```

The script builds the image with `--build-arg OPENCODE_VERSION`, runs
`sandbox/test/smoke.sh` (self-contained: fake LLM + mock C2C verify events,
live transcript sync with tool calls, file harvesting, and the final result),
pushes `<version>` and `latest` tags, and with `--deploy` patches
`SANDBOX_CONTAINER_IMAGE` in the `c2c-env` secret and restarts the C2C.
Roll back by `--deploy`ing the previous version tag.

## Update / redeploy

```sh
docker build -t container.cs.vt.edu/gback/registry/agent-supervisor:latest c2c/ \
  && docker push container.cs.vt.edu/gback/registry/agent-supervisor:latest
kubectl -n vtlib rollout restart deploy/c2c
```

## Notes

- `deploy/c2c.yaml` runs a single replica: the in-process task reconciler
  and the concurrency-limit dispatcher (`queue.server.ts`) assume one
  instance.
- TLS terminates outside the cluster (same as the other vtlib ingresses);
  the Ingress only declares the host route.
- Agent Jobs are created by the C2C at runtime with labels
  `app=opencode-agent,task-id=<uuid>`; inspect with
  `kubectl -n vtlib get jobs -l app=opencode-agent`.
