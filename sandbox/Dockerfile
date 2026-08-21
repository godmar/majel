# Sandbox image for opencode agents. One image serves every agent; all
# per-task behavior (model, prompt, MCP servers, permissions) is injected via
# a mounted opencode config and environment variables.
#
# Kept lean deliberately: image size dominates cold-start time (first pull on
# a node), which is the bulk of task latency. Layers are ordered stable-first
# so version bumps only re-pull the small top layers.
FROM node:24-slim

RUN apt-get update && apt-get install -y --no-install-recommends \
    python3 python3-pip python3-venv \
    git curl jq ripgrep unzip ca-certificates \
    && rm -rf /var/lib/apt/lists/*

# Tasks routinely ask for a spreadsheet back or hand the agent a PDF invoice,
# so the libraries for both ship in the image: pip works at runtime, but a
# per-task download is latency on every single task that needs them.
#
# pdfplumber is the one that matters for invoices — it exposes text with
# coordinates and extracts tables — with pypdf alongside for the manipulation
# it does not do (split, merge, metadata). Both are permissively licensed;
# PyMuPDF extracts text better still but is AGPL, which is not a licence to
# take on for a service like this one.
RUN pip3 install --no-cache-dir --break-system-packages \
    pandas numpy requests matplotlib openpyxl \
    pypdf pdfplumber

# The runner depends on opencode's server API; update via
# sandbox/update-opencode.sh, which smoke-tests the new version before push.
ARG OPENCODE_VERSION=1.18.18
RUN npm install -g opencode-ai@${OPENCODE_VERSION} && npm cache clean --force

RUN useradd -m -u 1001 agent && mkdir -p /workspace && chown agent:agent /workspace

# Warm opencode's first-run initialization (cache dir, tool binaries) so pods
# skip it. Runs as the same user and HOME the pod will use.
USER agent
ENV HOME=/home/agent
RUN opencode serve --hostname 127.0.0.1 --port 4600 & \
    for i in $(seq 1 30); do \
      curl -sf http://127.0.0.1:4600/global/health >/dev/null && break; sleep 1; \
    done; kill %1 2>/dev/null; true

# Bake opencode's plugin dependency tree into the image.
#
# `opencode serve` above does not install it — that happens the first time a
# session runs, which without this step meant every agent pod pulling ~30
# packages from registry.npmjs.org at startup. Pods have no egress to npm
# (see deploy/egress.yaml), so the install has to happen here or not at all.
#
# The install runs before the first model call, so pointing the provider at an
# unresolvable host is enough to trigger it: the run then fails at the LLM
# call, which is the intended outcome. `--pure` does not skip the install.
RUN printf '%s' '{ \
  "$schema": "https://opencode.ai/config.json", \
  "model": "warmup/warmup", \
  "provider": { "warmup": { "name": "warmup", "npm": "@ai-sdk/openai-compatible", \
    "options": { "apiKey": "x", "baseURL": "https://warmup.invalid/v1" }, \
    "models": { "warmup": { "name": "warmup" } } } } }' > /tmp/warmup.json \
    && OPENCODE_CONFIG=/tmp/warmup.json opencode run --model warmup/warmup hi >/dev/null 2>&1 || true; \
    rm -f /tmp/warmup.json; \
    test -d "$HOME/.config/opencode/node_modules" || { echo "plugin warm-up failed"; exit 1; }

COPY runner/ /opt/runner/

# Seed of the agent's initial working directory: every agent finds these files
# (including private reference data — the registry is private) in its cwd at
# startup. sandbox/home/ is a gitignored staging copy of
# opencode-master-config/home/, refreshed by sandbox/redeploy.sh — edit the
# master copy, not the staging copy.
COPY --chown=agent:agent home/ /workspace/

WORKDIR /workspace

ENTRYPOINT ["node", "/opt/runner/runner.mjs"]
