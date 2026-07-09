#!/usr/bin/env bash
# Rebuild and publish the sandbox image after changing the agent's initial
# working directory (opencode-master-config/home/).
#
#   sandbox/redeploy.sh
#
# Agent jobs pull the image fresh on every launch (imagePullPolicy: Always),
# so tasks created after the push see the updated files — no cluster restart
# or manifest change needed. Already-running tasks keep the files they
# started with.
#
# Requires push access to the registry (docker login container.cs.vt.edu).
set -euo pipefail

DIR=$(cd "$(dirname "$0")" && pwd)
ROOT=$(dirname "$DIR")

# shellcheck disable=SC1091
set -a; . "$ROOT/.env"; set +a

# Stage the workspace seed into the build context (opencode-master-config/ is
# outside it). sandbox/home/ is gitignored; never edit it directly.
rsync -a --delete "$ROOT/opencode-master-config/home/" "$DIR/home/"

echo "=== building $SANDBOX_CONTAINER_IMAGE"
docker build -t "$SANDBOX_CONTAINER_IMAGE" "$DIR"

echo "=== pushing"
docker push "$SANDBOX_CONTAINER_IMAGE"

echo "done — tasks created from now on start with the updated files"
