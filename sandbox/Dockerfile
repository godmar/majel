# Sandbox image for opencode agents. One image serves every agent; all
# per-task behavior (model, prompt, MCP servers, permissions) is injected via
# a mounted opencode config and environment variables.
FROM node:22-bookworm

RUN apt-get update && apt-get install -y --no-install-recommends \
    python3 python3-pip python3-venv \
    git curl jq ripgrep unzip ca-certificates \
    && rm -rf /var/lib/apt/lists/*

RUN pip3 install --no-cache-dir --break-system-packages \
    pandas numpy requests matplotlib openpyxl

# Pin the opencode version: the runner depends on its server API.
RUN npm install -g opencode-ai@1.17.15

RUN useradd -m -u 1001 agent && mkdir -p /workspace && chown agent:agent /workspace

COPY runner/ /opt/runner/

USER agent
WORKDIR /workspace
ENV HOME=/home/agent

ENTRYPOINT ["node", "/opt/runner/runner.mjs"]
