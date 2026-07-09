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

RUN pip3 install --no-cache-dir --break-system-packages \
    pandas numpy requests matplotlib openpyxl

# The runner depends on opencode's server API; update via
# sandbox/update-opencode.sh, which smoke-tests the new version before push.
ARG OPENCODE_VERSION=1.17.15
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

COPY runner/ /opt/runner/

# Seed of the agent's initial working directory: every agent finds these files
# (including private reference data — the registry is private) in its cwd at
# startup. sandbox/home/ is a gitignored staging copy of
# opencode-master-config/home/, refreshed by sandbox/redeploy.sh — edit the
# master copy, not the staging copy.
COPY --chown=agent:agent home/ /workspace/

WORKDIR /workspace

ENTRYPOINT ["node", "/opt/runner/runner.mjs"]
