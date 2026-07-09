#!/usr/bin/env bash
# Rebuild and publish the sandbox image after changing the agent's initial
# working directory (opencode-master-config/home/).
#
#   sandbox/redeploy.sh
#
# The cluster launches whatever image tag the c2c-env secret names (usually a
# pinned opencode version set by update-opencode.sh --deploy), so this script
# rebuilds and pushes THAT tag — plus :latest — otherwise the push would never
# reach running agents. Jobs pull the image fresh on every launch
# (imagePullPolicy: Always), so tasks created after the push see the updated
# files; no cluster restart needed. Already-running tasks keep the files they
# started with.
#
# Requires push access to the registry (docker login container.cs.vt.edu) and
# KUBECONFIG read access to the vtlib namespace (falls back to :latest-only if
# the cluster is unreachable).
set -euo pipefail

DIR=$(cd "$(dirname "$0")" && pwd)
ROOT=$(dirname "$DIR")

# shellcheck disable=SC1091
set -a; . "$ROOT/.env"; set +a
REPO=${SANDBOX_CONTAINER_IMAGE%:*}

# .env sets a c2c-relative KUBECONFIG; fall back to the repo copy.
if [ ! -f "${KUBECONFIG:-}" ]; then
  KUBECONFIG="$ROOT/endeavour.yaml"
fi
export KUBECONFIG=$(realpath "$KUBECONFIG")

DEPLOYED=$(kubectl -n "${K8S_NAMESPACE:-vtlib}" get secret c2c-env \
  -o jsonpath='{.data.SANDBOX_CONTAINER_IMAGE}' 2>/dev/null | base64 -d || true)
IMAGE=${DEPLOYED:-$SANDBOX_CONTAINER_IMAGE}
TAG=${IMAGE##*:}

# A version-shaped tag doubles as the opencode version to install (the tag is
# pinned by update-opencode.sh, which names images after the opencode release).
BUILD_ARGS=()
if [[ $TAG =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]]; then
  BUILD_ARGS+=(--build-arg "OPENCODE_VERSION=$TAG")
fi

# Stage the workspace seed into the build context (opencode-master-config/ is
# outside it). sandbox/home/ is gitignored; never edit it directly.
rsync -a --delete "$ROOT/opencode-master-config/home/" "$DIR/home/"

echo "=== building $IMAGE (cluster launches this tag)"
docker build "${BUILD_ARGS[@]}" -t "$IMAGE" -t "$REPO:latest" "$DIR"

echo "=== pushing"
docker push "$IMAGE"
[ "$IMAGE" != "$REPO:latest" ] && docker push "$REPO:latest"

echo "done — tasks created from now on start with the updated files"
